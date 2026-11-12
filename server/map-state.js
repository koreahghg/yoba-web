// 지도 상태: 도로 구간별 원활/서행/정체 (ITS 자동 또는 어드민 수동).
// ITS 값이 오래되면(조회 주기 3번) "확인중"으로 내린다. 끊긴 데이터를 "원활"로 보이지 않게.

import { speedStatus } from './its.js';
import { TRAFFIC, TRAFFIC_MODES } from './map-config.js';

export function validateMapUpdate(body) {
  for (const [id, v] of Object.entries(body?.traffic ?? {})) {
    if (!TRAFFIC.some((t) => t.id === id)) return `알 수 없는 도로 구간: ${id}`;
    if (!TRAFFIC_MODES.includes(v)) return `${id}: 모드는 ${TRAFFIC_MODES.join('/')} 중 하나`;
  }
  return null;
}

export function createMapState(store, its, { intervalSec = 120 } = {}) {
  const manual = { traffic: store.getJson('map', {}).traffic ?? {} };

  function itsFresh(now) {
    return its.state.enabled && its.state.lastOkAt && now - its.state.lastOkAt < intervalSec * 3 * 1000;
  }

  function autoTraffic(seg, now) {
    if (!itsFresh(now) || seg.its_links.length === 0) return { status: 'unknown', speed: null };
    const speeds = seg.its_links.map((l) => its.state.speeds.get(String(l))).filter(Number.isFinite);
    if (speeds.length === 0) return { status: 'unknown', speed: null };
    const speed = speeds.reduce((a, b) => a + b, 0) / speeds.length;
    return { status: speedStatus(speed, seg), speed: Math.round(speed) };
  }

  return {
    /** 방문객 화면용: {traffic: {svgId: free|busy|jam|unknown}} */
    snapshot(now = Date.now()) {
      const traffic = {};
      for (const t of TRAFFIC) {
        const mode = manual.traffic[t.id]?.mode ?? 'auto';
        traffic[t.svg] = mode === 'auto' ? autoTraffic(t, now).status : mode;
      }
      return { traffic };
    },

    /** 어드민용 (이름, 수동/자동 구분, 속도) */
    detail(now = Date.now()) {
      return {
        traffic: TRAFFIC.map((t) => {
          const mode = manual.traffic[t.id]?.mode ?? 'auto';
          const auto = autoTraffic(t, now);
          return {
            id: t.id,
            name: t.name,
            mode,
            status: mode === 'auto' ? auto.status : mode,
            auto_status: auto.status,
            speed: auto.speed,
            linked: t.its_links.length > 0,
            free_kmh: t.free_kmh,
            jam_kmh: t.jam_kmh,
          };
        }),
        its: {
          enabled: its.state.enabled,
          last_ok_at: its.state.lastOkAt || null,
          error: its.state.lastError,
          links: its.state.count,
          fresh: Boolean(itsFresh(now)),
        },
      };
    },

    /** body: {traffic: {id: mode}} — 바뀐 것만 보내도 됨 */
    update(body, now = Date.now()) {
      for (const [id, mode] of Object.entries(body.traffic ?? {})) manual.traffic[id] = { mode, at: now };
      store.putJson('map', manual);
    },
  };
}
