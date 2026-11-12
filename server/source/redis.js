// YOBA → Redis → 웹 서버. 키 형식은 docs/REDIS_CONTRACT.md 참고.
//
// - {prefix}:cameras          SET   카메라 ID 목록
// - {prefix}:live:{camera_id} STRING 실시간 수치 JSON (YOBA가 매 프레임 또는 ≤ 0.5초마다 덮어씀)
// - {prefix}:frame:{camera_id} STRING 블러된 JPEG 바이트 (TTL 짧게)
//
// 기존 10초 모드 (YOBA spec 9.1~9.2) 도 같이 읽는다. 실시간 값이 없을 때 이걸로 보여 준다.
// - {prefix}:zones            SET   구역 ID 목록
// - {prefix}:zone:{zone_id}   STRING 구역 JSON {level 0~2, score, confidence, updated_at, status ok/stale/error}
// - {prefix}:img:{zone_id}    STRING 블러 JPEG (TTL 120초)
// 10초 모드 구역은 camera_id를 'zone:{zone_id}'로 바꿔 실시간 카메라와 같은 모양으로 넘긴다 (legacy: true).
//
// Redis가 죽어도 웹 서버는 죽지 않는다. 읽기 실패는 "확인 불가"로 이어진다.

import Redis from 'ioredis';
import { LEGACY_PREFIX, isLegacyId } from '../state.js';

export function createRedisSource(cfg, log = console) {
  const p = cfg.keyPrefix;
  const r = new Redis(cfg.redisUrl, {
    lazyConnect: false,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 3000,
    retryStrategy: (times) => Math.min(times * 500, 5000),
  });
  let lastError = null;
  r.on('error', (e) => {
    if (lastError !== e.message) log.warn(`[redis] ${e.message}`);
    lastError = e.message;
  });
  r.on('ready', () => {
    if (lastError) log.info('[redis] 다시 연결됨');
    lastError = null;
  });

  return {
    kind: 'redis',
    health: () => ({ ok: r.status === 'ready', status: r.status, error: lastError }),

    /**
     * @returns {Promise<object[]|null>} 카메라별 원본 JSON (파싱 실패는 건너뜀).
     * Redis에 못 붙었으면 null → 웹은 목록을 그대로 두고 "확인 불가"로 표시 (빈 목록과 구분)
     */
    async readCameras() {
      if (r.status !== 'ready') return null;
      const [ids, zoneIds] = await Promise.all([r.smembers(`${p}:cameras`), r.smembers(`${p}:zones`)]);
      const out = [];
      const parse = (raw, key) => {
        try {
          return JSON.parse(raw);
        } catch {
          log.warn(`[redis] ${key} JSON 파싱 실패`);
          return null;
        }
      };
      if (ids.length) {
        ids.sort();
        const raws = await r.mget(ids.map((id) => `${p}:live:${id}`));
        raws.forEach((raw, i) => {
          const v = raw && parse(raw, `${p}:live:${ids[i]}`);
          if (v) out.push({ ...v, camera_id: ids[i] });
        });
      }
      if (zoneIds.length) {
        zoneIds.sort();
        const raws = await r.mget(zoneIds.map((id) => `${p}:zone:${id}`));
        raws.forEach((raw, i) => {
          const v = raw && parse(raw, `${p}:zone:${zoneIds[i]}`);
          if (v) out.push({ ...v, legacy: true, zone_id: zoneIds[i], camera_id: `${LEGACY_PREFIX}${zoneIds[i]}` });
        });
      }
      return out;
    },

    /** @returns {Promise<Buffer|null>} 실시간은 frame 키, 10초 모드는 img 키 */
    async readFrame(cameraId) {
      if (r.status !== 'ready') return null;
      if (isLegacyId(cameraId)) return r.getBuffer(`${p}:img:${cameraId.slice(LEGACY_PREFIX.length)}`);
      return r.getBuffer(`${p}:frame:${cameraId}`);
    },

    close: () => r.quit().catch(() => r.disconnect()),
  };
}
