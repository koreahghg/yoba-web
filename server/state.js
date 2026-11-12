// 실시간 상태: Redis 원본 → 스무딩 → 3단계 판정 → 장애 판정.
//
// 장애 판정은 YOBA가 쓴 updated_at을 웹 서버 시계와 비교하지 않는다. 노트북과 서버 시계가
// 어긋나도 오판하지 않도록 "값이 마지막으로 바뀐 걸 웹 서버가 본 시각"(lastChangeAt)을 기준으로 한다.
// (예외: 처음 본 값이 10분 넘게 오래된 것이면 YOBA가 이미 꺼진 뒤 남은 값으로 보고 바로 확인 불가)
//
// 두 가지 입력을 받는다.
// - 실시간 모드 (yoba:live:*): 사람 수 → 어드민 기준으로 3단계 판정
// - 10초 모드 (yoba:zone:*, legacy): 사람 수가 없어 YOBA가 판정한 level(0~2)을 그대로 씀
// 실시간 카메라가 하나라도 살아 있으면 실시간만, 아니면 살아 있는 10초 모드 구역을 보여 준다.

export const LEVEL_LABEL = { free: '여유', normal: '보통', busy: '혼잡', unknown: '확인 불가' };
export const LEGACY_PREFIX = 'zone:';
export const isLegacyId = (id) => String(id).startsWith(LEGACY_PREFIX);

const LEGACY_LEVELS = ['free', 'normal', 'busy'];
const LEVEL_RANK = { unknown: -1, free: 0, normal: 1, busy: 2 };
const OLD_ON_FIRST_SIGHT_MS = 10 * 60 * 1000;

/** 사람 수 → 3단계. free_max 이하 여유, busy_min 이상 혼잡, 그 사이 보통. */
export function levelOf(count, t) {
  if (count === null || count === undefined || !Number.isFinite(count)) return 'unknown';
  const c = Math.round(count);
  if (c <= t.free_max) return 'free';
  if (c >= t.busy_min) return 'busy';
  return 'normal';
}

export function validateThresholds(t) {
  const ok = (v) => Number.isInteger(v) && v >= 0 && v <= 100000;
  if (!t || !ok(t.free_max) || !ok(t.busy_min)) return '기준값은 0 이상의 정수여야 합니다.';
  if (t.free_max >= t.busy_min) return '"여유" 기준은 "혼잡" 기준보다 작아야 합니다.';
  return null;
}

/** YOBA가 name을 안 보내면 ID(cam01, webcam…) 대신 "현장 CCTV 1"처럼 순서대로 */
const displayName = (raw, index) => raw?.name || `현장 CCTV ${index + 1}`;

const sumCounts = (zones) => zones.reduce((s, z) => s + (Number.isFinite(z.count) ? z.count : 0), 0);
const byId = (a, b) => a.id.localeCompare(b.id);

export class LiveState {
  constructor({ staleMs, legacyStaleMs = 35000, smoothingSeconds }) {
    this.staleMs = staleMs;
    this.legacyStaleMs = legacyStaleMs;
    this.tau = Math.max(0.01, smoothingSeconds) * 1000;
    /** @type {Map<string, any>} */
    this.cams = new Map();
  }

  _ema(prev, value, dtMs) {
    if (prev === null || prev === undefined) return value;
    const a = 1 - Math.exp(-dtMs / this.tau);
    return prev + a * (value - prev);
  }

  /**
   * Redis에서 읽은 카메라·구역 목록을 반영한다.
   * raws가 null이면(Redis 연결 안 됨) 목록은 그대로 두고 갱신만 멈춘다 → 잠시 뒤 "확인 불가".
   * 목록에서 빠진 카메라(yoba:cameras / yoba:zones에서 지움, 키 삭제)는 화면에서도 없앤다.
   */
  ingest(raws, now = Date.now()) {
    if (raws === null) return;
    const present = new Set(raws.map((r) => String(r.camera_id)));
    for (const id of this.cams.keys()) if (!present.has(id)) this.cams.delete(id);
    for (const raw of raws) {
      const id = String(raw.camera_id);
      let c = this.cams.get(id);
      const first = !c;
      if (!c) {
        c = { id, legacy: Boolean(raw.legacy), lastUpdatedAt: null, lastChangeAt: 0, lastSmoothAt: 0, smooth: null, zoneSmooth: new Map(), raw: null };
        this.cams.set(id, c);
      }
      // 새 값인지: 실시간은 updated_at이 초 단위라 frames_total로 같은 초의 프레임을 구분.
      // 10초 모드는 신뢰도 low일 때 updated_at을 그대로 두고 다시 쓰므로(YOBA spec) 그건 새 값으로 안 침
      const stamp = c.legacy ? `${raw.updated_at}|${raw.status}` : `${raw.updated_at}|${raw.frames_total ?? ''}`;
      if (stamp === c.lastUpdatedAt) {
        c.raw = raw; // confidence 같은 부가 정보는 최신으로
        continue;
      }
      const limit = c.legacy ? this.legacyStaleMs : this.staleMs;
      const wasStale = now - c.lastChangeAt > limit;
      c.lastUpdatedAt = stamp;
      c.raw = raw;
      const iso = typeof raw.updated_at === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(raw.updated_at);
      const age = iso ? now - Date.parse(raw.updated_at) : 0;
      c.lastChangeAt = first && age > OLD_ON_FIRST_SIGHT_MS ? 0 : now;
      if (c.legacy) continue; // 10초 모드는 사람 수가 없어 스무딩할 것이 없음

      const zones = Array.isArray(raw.zones) ? raw.zones : [];
      const total = sumCounts(zones);
      const dt = now - c.lastSmoothAt;
      // 끊겼다가 돌아오면 예전 값에서 천천히 올라오지 않게 바로 새 값으로 시작
      c.smooth = wasStale ? total : this._ema(c.smooth, total, dt);
      for (const z of zones) {
        const prev = wasStale ? null : c.zoneSmooth.get(z.zone_id);
        c.zoneSmooth.set(z.zone_id, this._ema(prev, Number(z.count) || 0, dt));
      }
      c.lastSmoothAt = now;
    }
  }

  isOnline(c, now = Date.now()) {
    if (c.raw === null) return false;
    if (c.legacy && c.raw.status === 'error') return false; // YOBA가 직접 장애를 기록
    return now - c.lastChangeAt <= (c.legacy ? this.legacyStaleMs : this.staleMs);
  }

  /** 지금 보여 줄 쪽: 실시간이 살아 있으면 실시간, 아니면 살아 있는 10초 모드 */
  _visible(now) {
    const all = [...this.cams.values()].sort(byId);
    const live = all.filter((c) => !c.legacy);
    const legacy = all.filter((c) => c.legacy);
    const alive = (list) => list.some((c) => this.isOnline(c, now));
    const useLegacy = legacy.length > 0 && !alive(live) && (alive(legacy) || live.length === 0);
    return { mode: useLegacy ? 'legacy' : 'live', cams: useLegacy ? legacy : live };
  }

  /** 영상을 읽어 올 카메라 (지금 화면에 보이는 쪽만) */
  visibleIds(now = Date.now()) {
    return this._visible(now).cams.map((c) => c.id);
  }

  /** 방문객 화면용 상태. 어드민 진단 정보는 넣지 않는다. */
  publicSnapshot(settings, now = Date.now(), extra = {}) {
    const { mode, cams } = this._visible(now);
    let total = 0;
    let online = 0;
    let worst = 'unknown';
    const cameras = cams.map((c, index) => {
      const isOn = this.isOnline(c, now);
      const raw = c.raw || {};
      if (isOn) online += 1;

      if (c.legacy) {
        const level = isOn ? LEGACY_LEVELS[raw.level] ?? 'unknown' : 'unknown';
        if (LEVEL_RANK[level] > LEVEL_RANK[worst]) worst = level;
        return {
          id: c.id,
          name: displayName(raw, index),
          online: isOn,
          status: isOn ? 'ok' : 'offline',
          count: null, // 10초 모드에는 사람 수가 없음
          level,
          frame_size: [16, 9],
          zones: [],
          legacy: true,
        };
      }

      const count = isOn ? Math.round(c.smooth) : null;
      if (isOn) total += c.smooth;
      const zones = (raw.zones || []).map((z) => {
        const zc = isOn ? Math.round(c.zoneSmooth.get(z.zone_id) ?? 0) : null;
        const zt = settings.zones?.[z.zone_id];
        return {
          id: z.zone_id,
          name: z.name || z.zone_id,
          roi: z.roi || [],
          count: zc,
          level: !isOn ? 'unknown' : zt ? levelOf(zc, zt) : levelOf(count, settings.total),
        };
      });
      return {
        id: c.id,
        name: displayName(raw, index),
        online: isOn,
        status: !isOn ? 'offline' : raw.blur_ok === false ? 'blur_fail' : 'ok',
        count,
        level: isOn ? levelOf(count, settings.total) : 'unknown',
        frame_size: raw.frame_size || [16, 9],
        zones,
      };
    });

    const totalCount = mode === 'live' && online > 0 ? Math.round(total) : null;
    return {
      type: 'state',
      now,
      mode,
      thresholds: settings.total,
      total: {
        count: totalCount,
        level: online === 0 ? 'unknown' : mode === 'legacy' ? worst : levelOf(totalCount, settings.total),
        online_cameras: online,
        cameras: cams.length,
      },
      cameras,
      ...extra,
    };
  }

  /** 어드민 처리 상태 화면용 (숨겨진 쪽까지 전부). */
  diagnostics(now = Date.now()) {
    const all = [...this.cams.values()].sort(byId);
    const index = { live: 0, legacy: 0 };
    return all.map((c) => {
      const raw = c.raw || {};
      const name = displayName(raw, c.legacy ? index.legacy++ : index.live++);
      const base = {
        id: c.id,
        name,
        mode: c.legacy ? 'legacy' : 'live',
        online: this.isOnline(c, now),
        yoba_updated_at: raw.updated_at ?? null,
        last_received_at: c.lastChangeAt || null,
        age_ms: c.lastChangeAt ? now - c.lastChangeAt : null,
      };
      if (c.legacy) {
        return {
          ...base,
          level: LEGACY_LEVELS[raw.level] ?? null,
          score: raw.score ?? null,
          confidence: raw.confidence ?? null,
          yoba_status: raw.status ?? null,
          fps: null, latency_ms: null, blur_ok: null, blur_fail_total: null, frames_total: null,
          raw_count: null, smooth_count: null,
        };
      }
      return {
        ...base,
        fps: raw.fps ?? null,
        latency_ms: raw.latency_ms ?? null,
        blur_ok: raw.blur_ok ?? null,
        blur_fail_total: raw.blur_fail_total ?? null,
        frames_total: raw.frames_total ?? null,
        raw_count: raw.zones ? sumCounts(raw.zones) : null,
        smooth_count: c.smooth === null ? null : +c.smooth.toFixed(1),
      };
    });
  }
}
