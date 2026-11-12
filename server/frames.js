// 블러 프레임 중계: Redis의 최신 JPEG를 읽어
// - /snapshot/{cam}.jpg  : 최신 1장 (방문객 축소 화면, 1초마다 다시 불러옴 → 접속자가 많아도 가벼움)
// - /stream/{cam}.mjpg   : MJPEG (확대 화면 전용, 동시 시청자 상한 있음)
//
// 원본 프레임은 여기까지 오지 않는다. YOBA가 블러 검증에 실패하면 검은 화면을 보내고,
// 프레임이 STALE_MS 이상 갱신되지 않으면 스냅샷은 503, 스트림은 새 프레임을 보내지 않는다.

import { isLegacyId } from './state.js';

const BOUNDARY = 'yobaframe';

export function createFrameHub(cfg, source, log = console) {
  /** @type {Map<string, {buf: Buffer, at: number, version: number}>} */
  const latest = new Map();
  /** @type {Map<string, Set<{res: any, nextAt: number, minGap: number, lastVersion: number}>>} */
  const viewers = new Map();
  let cameraIds = [];
  const lastRead = new Map();
  let polling = false;
  const gapFor = (fps) => 1000 / Math.max(1, Math.min(cfg.streamMaxFps, fps || cfg.streamMaxFps));
  // 10초 모드 이미지는 10초마다 바뀌므로 오래 기다려 준다
  const staleFor = (id) => (isLegacyId(id) ? cfg.legacyStaleMs ?? 35000 : cfg.staleMs);

  function streamCount() {
    let n = 0;
    for (const set of viewers.values()) n += set.size;
    return n;
  }

  function push(id, frame) {
    const set = viewers.get(id);
    if (!set) return;
    const now = Date.now();
    for (const v of set) {
      // 박자(nextAt) 기준으로 보낸다. "직전 전송 후 N ms"로 막으면 원본이 상한보다 조금만 빨라도
      // (예: 원본 12fps, 상한 10fps) 한 장씩 건너뛰어 절반(6fps)만 나간다.
      if (v.lastVersion === frame.version || now < v.nextAt) continue;
      if (v.res.writableLength > 2 * 1024 * 1024) continue; // 느린 클라이언트는 프레임을 건너뜀
      v.res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.buf.length}\r\n\r\n`);
      v.res.write(frame.buf);
      v.res.write('\r\n');
      v.nextAt = Math.max(v.nextAt, now - v.minGap) + v.minGap; // 쉬었다 와도 몰아서 보내지 않음
      v.lastVersion = frame.version;
    }
  }

  async function pollOnce() {
    if (polling) return;
    polling = true;
    try {
      const now = Date.now();
      for (const id of cameraIds) {
        // 10초 모드 이미지는 1초에 한 번만 확인하면 충분 (Redis 부하 줄이기)
        if (isLegacyId(id) && now - (lastRead.get(id) ?? 0) < 1000) continue;
        lastRead.set(id, now);
        const buf = await source.readFrame(id).catch(() => null);
        if (!buf || buf.length === 0) continue;
        const prev = latest.get(id);
        if (prev && prev.buf.equals(buf)) continue;
        const frame = { buf, at: Date.now(), version: (prev?.version ?? 0) + 1 };
        latest.set(id, frame);
        push(id, frame);
      }
    } finally {
      polling = false;
    }
  }

  const timer = setInterval(pollOnce, cfg.framePollMs);
  timer.unref();

  const fresh = (id) => {
    const f = latest.get(id);
    return f && Date.now() - f.at <= staleFor(id) ? f : null;
  };

  return {
    setCameras(ids) {
      cameraIds = ids;
    },
    streamCount,
    hasFreshFrame: (id) => Boolean(fresh(id)),

    snapshot(req, res) {
      const f = fresh(req.params.cam);
      if (!f) return res.status(503).set('Cache-Control', 'no-store').end();
      res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=1' });
      res.end(f.buf);
    },

    stream(req, res) {
      const id = req.params.cam;
      if (streamCount() >= cfg.streamMaxClients) {
        return res.status(503).json({ error: 'busy', message: '확대 화면 시청자가 많아 잠시 후 다시 시도해 주세요.' });
      }
      res.writeHead(200, {
        'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Connection: 'close',
        'X-Accel-Buffering': 'no', // nginx 버퍼링 끄기
      });
      // ?fps= 로 낮출 수 있음 (메인 칸은 TILE_FPS, 확대 화면은 STREAM_MAX_FPS까지)
      const v = { res, nextAt: 0, lastVersion: 0, minGap: gapFor(Number(req.query?.fps)) };
      if (!viewers.has(id)) viewers.set(id, new Set());
      viewers.get(id).add(v);
      const f = fresh(id);
      if (f) push(id, f);
      req.on('close', () => {
        viewers.get(id)?.delete(v);
      });
    },

    close() {
      clearInterval(timer);
      for (const set of viewers.values()) for (const v of set) v.res.end();
    },
  };
}
