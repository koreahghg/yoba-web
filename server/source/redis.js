// YOBA → Redis → 웹 서버. 키 형식은 docs/REDIS_CONTRACT.md 참고.
//
// - {prefix}:cameras          SET   카메라 ID 목록
// - {prefix}:live:{camera_id} STRING 실시간 수치 JSON (YOBA가 매 프레임 또는 ≤ 0.5초마다 덮어씀)
// - {prefix}:frame:{camera_id} STRING 블러된 JPEG 바이트 (TTL 짧게)
//
// Redis가 죽어도 웹 서버는 죽지 않는다. 읽기 실패는 "확인 불가"로 이어진다.

import Redis from 'ioredis';

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
      const ids = (await r.smembers(`${p}:cameras`)).sort();
      if (ids.length === 0) return [];
      const raws = await r.mget(ids.map((id) => `${p}:live:${id}`));
      const out = [];
      raws.forEach((raw, i) => {
        if (!raw) return;
        try {
          out.push({ ...JSON.parse(raw), camera_id: ids[i] });
        } catch {
          log.warn(`[redis] ${p}:live:${ids[i]} JSON 파싱 실패`);
        }
      });
      return out;
    },

    /** @returns {Promise<Buffer|null>} */
    async readFrame(cameraId) {
      if (r.status !== 'ready') return null;
      return r.getBuffer(`${p}:frame:${cameraId}`);
    },

    close: () => r.quit().catch(() => r.disconnect()),
  };
}
