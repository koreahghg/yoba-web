import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';

import { createFrameHub } from '../server/frames.js';

const cfg = { framePollMs: 20, staleMs: 300, streamMaxFps: 50, streamMaxClients: 1 };

function serve(hub) {
  const server = http.createServer((req, res) => {
    const [, kind, file] = req.url.split('/');
    req.params = { cam: file.replace(/\.(jpg|mjpg)$/, '') };
    res.status = (c) => ((res.statusCode = c), res);
    res.set = (h) => (typeof h === 'object' ? Object.entries(h).forEach(([k, v]) => res.setHeader(k, v)) : null, res);
    res.json = (o) => res.end(JSON.stringify(o));
    if (kind === 'snapshot') hub.snapshot(req, res);
    else hub.stream(req, res);
  });
  return new Promise((r) => server.listen(0, () => r(server)));
}

const get = (port, path) =>
  new Promise((resolve) => {
    const req = http.get({ port, path }, (res) => {
      const chunks = [];
      res.on('data', (c) => {
        chunks.push(c);
        if (path.includes('mjpg') && Buffer.concat(chunks).includes('FRAME2')) req.destroy();
      });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) }));
      res.on('close', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) }));
    });
  });

test('스냅샷·MJPEG 중계, 끊기면 503, 시청자 상한', async () => {
  let frame = Buffer.from('FRAME1');
  const hub = createFrameHub(cfg, { readFrame: async () => frame });
  hub.setCameras(['cam01']);
  const server = await serve(hub);
  const { port } = server.address();
  await new Promise((r) => setTimeout(r, 60));

  const snap = await get(port, '/snapshot/cam01.jpg');
  assert.equal(snap.status, 200);
  assert.equal(snap.body.toString(), 'FRAME1');

  setTimeout(() => (frame = Buffer.from('FRAME2')), 80);
  const streamP = get(port, '/stream/cam01.mjpg');
  await new Promise((r) => setTimeout(r, 30));
  const busy = await get(port, '/stream/cam01.mjpg'); // 상한 1명
  assert.equal(busy.status, 503);
  const stream = await streamP;
  assert.match(stream.type, /multipart\/x-mixed-replace/);
  const text = stream.body.toString();
  assert.ok(text.includes('FRAME1') && text.includes('FRAME2'));

  frame = null; // YOBA 멈춤 → 새 프레임 없음
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await get(port, '/snapshot/cam01.jpg')).status, 503);

  hub.close();
  server.close();
});
