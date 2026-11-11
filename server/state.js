// 실시간 상태: Redis 원본 → 스무딩 → 3단계 판정 → 장애 판정.
//
// 장애 판정은 YOBA가 쓴 updated_at을 웹 서버 시계와 비교하지 않는다. 노트북과 서버 시계가
// 어긋나도 오판하지 않도록 "값이 마지막으로 바뀐 걸 웹 서버가 본 시각"(lastChangeAt)을 기준으로 한다.

export const LEVEL_LABEL = { free: '여유', normal: '보통', busy: '혼잡', unknown: '확인 불가' };

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

const sumCounts = (zones) => zones.reduce((s, z) => s + (Number.isFinite(z.count) ? z.count : 0), 0);

export class LiveState {
  constructor({ staleMs, smoothingSeconds }) {
    this.staleMs = staleMs;
    this.tau = Math.max(0.01, smoothingSeconds) * 1000;
    /** @type {Map<string, any>} */
    this.cams = new Map();
  }

  _ema(prev, value, dtMs) {
    if (prev === null || prev === undefined) return value;
    const a = 1 - Math.exp(-dtMs / this.tau);
    return prev + a * (value - prev);
  }

  /** Redis에서 읽은 카메라 목록을 반영한다. */
  ingest(raws, now = Date.now()) {
    for (const raw of raws) {
      const id = String(raw.camera_id);
      let c = this.cams.get(id);
      if (!c) {
        c = { id, lastUpdatedAt: null, lastChangeAt: 0, lastSmoothAt: 0, smooth: null, zoneSmooth: new Map(), raw: null };
        this.cams.set(id, c);
      }
      // 새 프레임인지: updated_at이 초 단위라 같은 초에 여러 프레임이 와도 frames_total로 구분한다
      const stamp = `${raw.updated_at}|${raw.frames_total ?? ''}`;
      if (stamp === c.lastUpdatedAt) continue; // 새 값 아님
      const wasStale = now - c.lastChangeAt > this.staleMs;
      c.lastUpdatedAt = stamp;
      c.lastChangeAt = now;
      c.raw = raw;
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
    return c.raw !== null && now - c.lastChangeAt <= this.staleMs;
  }

  /** 방문객 화면용 상태. 어드민 진단 정보는 넣지 않는다. */
  publicSnapshot(settings, now = Date.now(), extra = {}) {
    const cams = [...this.cams.values()].sort((a, b) => a.id.localeCompare(b.id));
    let total = 0;
    let online = 0;
    const cameras = cams.map((c) => {
      const isOn = this.isOnline(c, now);
      const raw = c.raw || {};
      const count = isOn ? Math.round(c.smooth) : null;
      if (isOn) {
        online += 1;
        total += c.smooth;
      }
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
        name: raw.name || c.id,
        online: isOn,
        status: !isOn ? 'offline' : raw.blur_ok === false ? 'blur_fail' : 'ok',
        count,
        level: isOn ? levelOf(count, settings.total) : 'unknown',
        frame_size: raw.frame_size || [16, 9],
        zones,
      };
    });
    const totalCount = online > 0 ? Math.round(total) : null;
    return {
      type: 'state',
      now,
      thresholds: settings.total,
      total: {
        count: totalCount,
        level: online > 0 ? levelOf(totalCount, settings.total) : 'unknown',
        online_cameras: online,
        cameras: cams.length,
      },
      cameras,
      ...extra,
    };
  }

  /** 어드민 처리 상태 화면용. */
  diagnostics(now = Date.now()) {
    return [...this.cams.values()].map((c) => {
      const raw = c.raw || {};
      return {
        id: c.id,
        name: raw.name || c.id,
        online: this.isOnline(c, now),
        fps: raw.fps ?? null,
        latency_ms: raw.latency_ms ?? null,
        blur_ok: raw.blur_ok ?? null,
        blur_fail_total: raw.blur_fail_total ?? null,
        frames_total: raw.frames_total ?? null,
        yoba_updated_at: raw.updated_at ?? null,
        last_received_at: c.lastChangeAt || null,
        age_ms: c.lastChangeAt ? now - c.lastChangeAt : null,
        raw_count: raw.zones ? sumCounts(raw.zones) : null,
        smooth_count: c.smooth === null ? null : +c.smooth.toFixed(1),
      };
    });
  }
}
