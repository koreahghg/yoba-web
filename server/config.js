// 환경변수 → 설정. 값 설명은 .env.example 참고.

const num = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`${name}: 숫자가 아님 (${raw})`);
  return v;
};

export function loadConfig(argv = process.argv) {
  const demo = argv.includes('--demo') || process.env.DEMO === '1';
  let adminPassword = process.env.ADMIN_PASSWORD || '';
  if (!adminPassword) {
    if (!demo) throw new Error('ADMIN_PASSWORD가 비어 있습니다. .env에 어드민 비밀번호를 넣어 주세요.');
    adminPassword = 'admin';
  }
  return {
    demo,
    port: num('PORT', 8080),
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6379/0',
    keyPrefix: process.env.REDIS_KEY_PREFIX || 'yoba',
    adminPassword,
    dbPath: process.env.DB_PATH || 'data/yoba-web.db',
    staleMs: num('STALE_MS', 3000),
    smoothingSeconds: num('SMOOTHING_SECONDS', 2),
    pushIntervalMs: num('PUSH_INTERVAL_MS', 500),
    framePollMs: num('FRAME_POLL_MS', 100),
    streamMaxFps: num('STREAM_MAX_FPS', 8),
    streamMaxClients: num('STREAM_MAX_CLIENTS', 30),
    trustProxy: process.env.TRUST_PROXY === '1',
  };
}
