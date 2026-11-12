// 국가교통정보센터(ITS) 실시간 소통정보 → 링크별 속도.
// ITS_API_KEY가 없으면 꺼져 있고, 도로는 어드민 수동 값만 쓴다.
//
// 필드(linkId, speed, roadName)는 테스트 키(apiKey=test)로 확인했다. 테스트 키는 예시 데이터(2020년,
// 다른 지역)만 주므로 실제 이 지역 값은 발급받은 키로 `npm run its-links`를 돌려 확인한다.

export const ITS_URL = 'https://openapi.its.go.kr:9443/trafficInfo';

export function buildItsUrl(apiKey, bbox) {
  const q = new URLSearchParams({
    apiKey,
    type: 'all',
    minX: String(bbox.minX),
    maxX: String(bbox.maxX),
    minY: String(bbox.minY),
    maxY: String(bbox.maxY),
    getType: 'json',
  });
  return `${ITS_URL}?${q}`;
}

const tag = (xml, name) => xml.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1];

/**
 * 응답 본문(JSON 또는 XML) → [{linkId, speed, roadName, createdDate}]
 * 테스트 키(apiKey=test)는 getType=json이어도 XML로 응답했다 (2026-11 확인). 둘 다 받는다.
 */
export function parseResponse(text) {
  const body = text.trim();
  if (!body.startsWith('<')) return parseItems(JSON.parse(body));
  const code = tag(body, 'resultCode');
  if (code !== undefined && code !== '0') throw new Error(`ITS 오류 ${code}: ${tag(body, 'resultMsg') ?? ''}`);
  const items = [...body.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => ({
    linkId: tag(m[1], 'linkId'),
    speed: tag(m[1], 'speed'),
    roadName: tag(m[1], 'roadName'),
    createdDate: tag(m[1], 'createdDate'),
  }));
  return parseItems({ body: { items } });
}

/** 응답 JSON → [{linkId, speed, roadName, createdDate}] */
export function parseItems(json) {
  const code = json?.header?.resultCode;
  if (code !== undefined && String(code) !== '0') throw new Error(`ITS 오류 ${code}: ${json.header.resultMsg ?? ''}`);
  let items = json?.body?.items ?? json?.items ?? json?.response?.body?.items ?? [];
  if (items && !Array.isArray(items)) items = items.item ?? [items];
  if (!Array.isArray(items)) items = [items];
  return items
    .map((it) => ({
      linkId: String(it.linkId ?? it.linkID ?? it.link_id ?? ''),
      speed: Number(it.speed),
      roadName: it.roadName ?? '',
      createdDate: it.createdDate ?? '',
    }))
    .filter((it) => it.linkId && Number.isFinite(it.speed));
}

/** 구간 속도 → 원활/서행/정체 */
export function speedStatus(speed, seg) {
  if (!Number.isFinite(speed)) return 'unknown';
  if (speed >= seg.free_kmh) return 'free';
  if (speed < seg.jam_kmh) return 'jam';
  return 'busy';
}

export function createIts({ apiKey, bbox, intervalSec = 120 }, log = console) {
  const state = { enabled: Boolean(apiKey), speeds: new Map(), lastOkAt: 0, lastError: null, count: 0 };
  if (!apiKey) return { state, stop() {} };

  async function poll() {
    try {
      const res = await fetch(buildItsUrl(apiKey, bbox), { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const items = parseResponse(await res.text());
      if (items.length === 0) throw new Error('응답에 링크가 없음 (조회 범위나 키 확인)');
      state.speeds = new Map(items.map((it) => [it.linkId, it.speed]));
      state.count = items.length;
      state.lastOkAt = Date.now();
      if (state.lastError) log.info('[its] 다시 수신됨');
      state.lastError = null;
    } catch (e) {
      if (state.lastError !== e.message) log.warn(`[its] ${e.message}`);
      state.lastError = e.message;
    }
  }
  poll();
  const timer = setInterval(poll, intervalSec * 1000);
  timer.unref();
  return { state, stop: () => clearInterval(timer) };
}
