// YOBA 웹 서버: Redis(YOBA) → 브라우저.
//   node server/index.js          Redis 연결 (운영)
//   node server/index.js --demo   가짜 데이터 (화면 확인용)

import http from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';

import { createAuth } from './auth.js';
import { loadConfig } from './config.js';
import { createFrameHub } from './frames.js';
import { createIts } from './its.js';
import { ITS_BBOX } from './map-config.js';
import { createMapState, validateMapUpdate } from './map-state.js';
import { createDemoSource } from './source/demo.js';
import { createRedisSource } from './source/redis.js';
import { LiveState, validateThresholds } from './state.js';
import { TOTAL_ID, createRecorder, openStore, todayKst } from './store.js';

const cfg = loadConfig();
const log = console;
const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

const source = cfg.demo ? createDemoSource() : createRedisSource(cfg, log);
const store = openStore(cfg.dbPath);
const state = new LiveState(cfg);
const frames = createFrameHub(cfg, source, log);
const auth = createAuth(cfg.adminPassword);
const record = createRecorder(store);
let settings = store.getSettings();
const its = createIts({ apiKey: cfg.itsApiKey, bbox: ITS_BBOX, intervalSec: cfg.itsIntervalSec }, log);
const mapState = createMapState(store, its, { intervalSec: cfg.itsIntervalSec });

// ---------- 수집 루프 ----------
let reading = false;
async function readLoop() {
  if (reading) return;
  reading = true;
  try {
    const raws = await source.readCameras();
    state.ingest(raws);
    frames.setCameras(state.visibleIds());
  } catch (e) {
    log.warn(`[read] ${e.message}`);
  } finally {
    reading = false;
  }
}
setInterval(readLoop, 200);

setInterval(() => {
  try {
    record(state);
  } catch (e) {
    log.error(`[record] ${e.message}`);
  }
}, 1000);

function publicState() {
  const snap = state.publicSnapshot(settings, Date.now(), {
    source: source.kind,
    map: mapState.snapshot(),
    stream: { tile_fps: cfg.tileFps, modal_fps: cfg.streamMaxFps },
  });
  for (const c of snap.cameras) c.has_frame = c.online && frames.hasFreshFrame(c.id);
  return snap;
}

// 공개 시간대별 그래프는 30초 캐시 (방문객이 많아도 DB를 자주 치지 않게)
let hourlyCache = { at: 0, date: '', data: null };
function publicHourly() {
  const date = todayKst();
  if (hourlyCache.date !== date || Date.now() - hourlyCache.at > 30_000) {
    const rows = store.hourly(date).map(({ hour, avg, max }) => ({ hour, avg, max }));
    hourlyCache = { at: Date.now(), date, data: { date, hours: rows } };
  }
  return hourlyCache.data;
}

// ---------- HTTP ----------
const app = express();
app.disable('x-powered-by');
if (cfg.trustProxy) app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  next();
});

// 공개 API
app.get('/api/state', (req, res) => res.set('Cache-Control', 'no-store').json(publicState()));
app.get('/api/hourly', (req, res) => res.set('Cache-Control', 'public, max-age=30').json(publicHourly()));
app.get('/snapshot/:file', (req, res) => {
  req.params.cam = req.params.file.replace(/\.jpg$/, '');
  frames.snapshot(req, res);
});
app.get('/stream/:file', (req, res) => {
  req.params.cam = req.params.file.replace(/\.mjpg$/, '');
  frames.stream(req, res);
});

// 어드민 API
const admin = express.Router();
admin.use((req, res, next) => {
  // 쿠키 + JSON 본문만 받는다 (SameSite=Strict와 함께 CSRF 방어)
  if (['POST', 'PUT', 'DELETE'].includes(req.method) && !req.is('application/json')) {
    return res.status(415).json({ error: 'application/json만 허용' });
  }
  res.set('Cache-Control', 'no-store');
  next();
});
admin.post('/login', auth.login);
admin.post('/logout', auth.logout);
admin.get('/me', (req, res) => res.json({ authed: auth.isAuthed(req), demo: cfg.demo }));
admin.use(auth.require);

admin.get('/settings', (req, res) => {
  const known = [...state.cams.values()].flatMap((c) =>
    (c.raw?.zones || []).map((z) => ({ id: z.zone_id, name: z.name || z.zone_id, camera_id: c.id })),
  );
  res.json({ settings, zones: known });
});

admin.put('/settings', (req, res) => {
  const body = req.body || {};
  const next = { total: body.total, zones: {} };
  const err = validateThresholds(next.total);
  if (err) return res.status(400).json({ error: err });
  for (const [zoneId, t] of Object.entries(body.zones || {})) {
    if (t === null) continue; // null이면 전체 기준을 따름
    const zerr = validateThresholds(t);
    if (zerr) return res.status(400).json({ error: `${zoneId}: ${zerr}` });
    next.zones[zoneId] = { free_max: t.free_max, busy_min: t.busy_min };
  }
  const before = settings;
  settings = next;
  store.saveSettings(next);
  store.log('thresholds', { before, after: next });
  broadcast(); // 저장 즉시 반영
  res.json({ ok: true, settings });
});

admin.get('/status', (req, res) => {
  const today = todayKst();
  res.json({
    now: Date.now(),
    source: source.kind,
    redis: source.health(),
    ws_clients: wss.clients.size,
    stream_clients: frames.streamCount(),
    stream_max_clients: cfg.streamMaxClients,
    stale_ms: cfg.staleMs,
    legacy_stale_ms: cfg.legacyStaleMs,
    blur_fail_today: store.blurFailCount(today),
    cameras: state.diagnostics().map((d) => ({
      ...d,
      has_frame: frames.hasFreshFrame(d.id),
      blur_fail_today: store.blurFailCount(today, d.id),
    })),
  });
});

admin.get('/stats', (req, res) => {
  const date = String(req.query.date || todayKst());
  const camera = String(req.query.camera || TOTAL_ID);
  try {
    res.json({ date, camera, hours: store.hourly(date, camera) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

admin.get('/export.csv', (req, res) => {
  const date = String(req.query.date || todayKst());
  const unit = req.query.unit === 'minute' ? 'minute' : 'hour';
  const camera = String(req.query.camera || TOTAL_ID);
  const fmt = (ms) => (ms ? new Date(ms + 9 * 3600e3).toISOString().slice(0, 19).replace('T', ' ') : '');
  const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) : '');
  let lines;
  try {
    if (unit === 'hour') {
      lines = [['날짜', '시간대', '평균 동시 인원(명)', '최대 동시 인원(명)', '피크 시각', '정상 수신률(%)', '블러 검증 실패(회)']];
      for (const h of store.hourly(date, camera)) {
        lines.push([date, `${String(h.hour).padStart(2, '0')}:00-${String(h.hour + 1).padStart(2, '0')}:00`,
          h.avg ?? '', h.max ?? '', fmt(h.peak_at), pct(h.online_samples, h.samples), h.blur_fail]);
      }
    } else {
      lines = [['시각(분)', '평균 동시 인원(명)', '최대 동시 인원(명)', '정상 수신률(%)', '블러 검증 실패(회)']];
      for (const m of store.minutely(date, camera)) {
        lines.push([fmt(m.minute_ts).slice(0, 16), m.avg_count === null ? '' : m.avg_count.toFixed(1),
          m.max_count === null ? '' : Math.round(m.max_count), pct(m.online_samples, m.samples), m.blur_fail]);
      }
    }
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const body = '﻿' + lines.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n'; // BOM: 엑셀 한글 깨짐 방지
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="yoba_${date}_${unit}.csv"`,
  });
  res.send(body);
});

admin.get('/map', (req, res) => res.json(mapState.detail()));

admin.put('/map', (req, res) => {
  const err = validateMapUpdate(req.body);
  if (err) return res.status(400).json({ error: err });
  mapState.update(req.body);
  store.log('map', req.body);
  broadcast(); // 저장 즉시 반영
  res.json(mapState.detail());
});

admin.get('/log',(req, res) => res.json({ log: store.recentLog(30) }));

admin.post('/demo/outage', (req, res) => {
  if (!cfg.demo) return res.status(404).json({ error: '데모 모드에서만 가능' });
  source.simulateOutage(Number(req.body?.seconds) || 8);
  res.json({ ok: true });
});

app.use('/api/admin', admin);
app.get('/admin', (req, res) => res.sendFile('admin.html', { root: PUBLIC_DIR }));
// 캐시는 매번 ETag로 확인 (행사 중 화면을 고쳐 배포해도 바로 반영되도록)
app.use(express.static(PUBLIC_DIR, { maxAge: 0, extensions: ['html'] }));

// ---------- WebSocket ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 });

function broadcast() {
  if (wss.clients.size === 0) return;
  const msg = JSON.stringify(publicState());
  for (const ws of wss.clients) if (ws.readyState === ws.OPEN && ws.bufferedAmount < 256 * 1024) ws.send(msg);
}
setInterval(broadcast, cfg.pushIntervalMs);

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', () => {}); // 클라이언트 → 서버 메시지는 쓰지 않음
  ws.send(JSON.stringify(publicState()));
});
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) ws.terminate();
    else {
      ws.isAlive = false;
      ws.ping();
    }
  }
}, 15_000);

server.listen(cfg.port, () => {
  log.info(`YOBA 웹 서버: http://localhost:${cfg.port}  (어드민: /admin)`);
  log.info(cfg.demo ? '[데모 모드] 가짜 데이터 사용. 어드민 비밀번호: ' + (process.env.ADMIN_PASSWORD ? '.env 값' : 'admin')
    : `Redis: ${cfg.redisUrl.replace(/\/\/[^@]*@/, '//***@')}  키 접두사: ${cfg.keyPrefix}`);
});

function shutdown() {
  log.info('종료 중...');
  frames.close();
  wss.close();
  server.close();
  Promise.resolve(source.close()).finally(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
