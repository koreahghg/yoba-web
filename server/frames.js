// 블러 프레임 중계: Redis의 최신 JPEG를 읽어
// - /snapshot/{cam}.jpg  : 최신 1장 (방문객 축소 화면, 1초마다 다시 불러옴 → 접속자가 많아도 가벼움)
// - /stream/{cam}.mjpg   : MJPEG (확대 화면 전용, 동시 시청자 상한 있음)
//
// 원본 프레임은 여기까지 오지 않는다. YOBA가 블러 검증에 실패하면 검은 화면을 보내고,
// 프레임이 STALE_MS 이상 갱신되지 않으면 스냅샷은 503, 스트림은 새 프레임을 보내지 않는다.

const BOUNDARY = 'yobaframe';

export function createFrameHub(cfg, source, log = console) {
  /** @type {Map<string, {buf: Buffer, at: number, version: number}>} */
  const latest = new Map();
  /** @type {Map<string, Set<{res: any, lastSentAt: number, lastVersion: number}>>} */
  const viewers = new Map();
  let cameraIds = [];
  let polling = false;
  const minGap = 1000 / Math.max(1, cfg.streamMaxFps);

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
      if (v.lastVersion === frame.version || now - v.lastSentAt < minGap) continue;
      if (v.res.writableLength > 2 * 1024 * 1024) continue; // 느린 클라이언트는 프레임을 건너뜀
      v.res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.buf.length}\r\n\r\n`);
      v.res.write(frame.buf);
      v.res.write('\r\n');
      v.lastSentAt = now;
      v.lastVersion = frame.version;
    }
  }

  async function pollOnce() {
    if (polling) return;
    polling = true;
    try {
      for (const id of cameraIds) {
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
    return f && Date.now() - f.at <= cfg.staleMs ? f : null;
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
      const v = { res, lastSentAt: 0, lastVersion: 0 };
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
