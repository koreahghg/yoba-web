// 가짜 YOBA: docs/REDIS_CONTRACT.md 형식대로 Redis에 값을 써서
// 카메라·모델 없이 "Redis 모드" 웹 서버를 끝까지 확인한다.
//
//   npm run fake-yoba                      # 인원 JSON만 (영상 없음)
//   npm run fake-yoba -- --image test.jpg  # 이 JPEG를 블러 프레임인 척 보냄 (사람 없는 사진 사용)
//   npm run fake-yoba -- --stop-after 30   # 30초 뒤 멈춤(값은 남김) → 웹이 3초 안에 "확인 불가"로 바뀌는지 확인
//   npm run fake-yoba -- --cleanup         # 가짜 카메라 값만 지우고 끝 (웹 화면에서도 사라짐)
//   npm run fake-yoba -- --legacy          # 기존 10초 모드 키(yoba:zone:*, yoba:img:*)로 씀 (단계만, 사람 수 없음)
//
// Ctrl+C로 끄면 가짜 카메라 값을 지운다. 지우지 않으면 웹에 "확인 불가" 카메라로 계속 남는다.

import { readFileSync } from 'node:fs';
import Redis from 'ioredis';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const url = process.env.REDIS_URL || 'redis://localhost:6379/0';
const p = process.env.REDIS_KEY_PREFIX || 'yoba';
const cam = arg('camera', 'cam01');
const fps = Number(arg('fps', 8));
const image = arg('image') ? readFileSync(arg('image')) : null;
const stopAfter = Number(arg('stop-after', 0));
const legacy = process.argv.includes('--legacy');
const legacyZone = 'fake_zone';

const r = new Redis(url);

async function cleanup() {
  await r.multi()
    .srem(`${p}:cameras`, cam).del(`${p}:live:${cam}`, `${p}:frame:${cam}`)
    .srem(`${p}:zones`, legacyZone).del(`${p}:zone:${legacyZone}`, `${p}:img:${legacyZone}`)
    .exec();
  console.log('[fake-yoba] 가짜 카메라·구역 값을 지웠습니다.');
}

if (process.argv.includes('--cleanup')) {
  await cleanup();
  await r.quit();
  process.exit(0);
}

process.on('SIGINT', async () => {
  await cleanup().catch(() => {});
  await r.quit().catch(() => {});
  process.exit(0);
});

const started = Date.now();
let frames = 0;
let blurFails = 0;

const zones = [
  { zone_id: 'zone_front', name: '입구 앞', roi: [[60, 300], [520, 300], [560, 530], [20, 530]] },
  { zone_id: 'zone_hall', name: '메인홀', roi: [[300, 120], [900, 120], [940, 300], [250, 300]] },
];

async function tick() {
  if (stopAfter && Date.now() - started > stopAfter * 1000) {
    console.log('멈춤 (--stop-after). 웹 화면이 3초 안에 "확인 불가"로 바뀌어야 합니다.');
    await r.quit();
    process.exit(0);
  }
  frames += 1;
  const t = (Date.now() - started) / 1000;
  const wave = 0.5 + 0.5 * Math.sin(t / 30);
  const blurOk = Math.random() > 0.002;
  if (!blurOk) blurFails += 1;
  const payload = {
    camera_id: cam,
    name: '행사장 CCTV (가짜)',
    updated_at: new Date().toISOString(),
    frame_size: [960, 540],
    fps,
    latency_ms: Math.round(120 + Math.random() * 60),
    blur_ok: blurOk,
    blur_fail_total: blurFails,
    frames_total: frames,
    zones: zones.map((z, i) => ({ ...z, count: Math.max(0, Math.round((10 + i * 8) * (0.3 + 2 * wave) + (Math.random() - 0.5) * 5)) })),
  };
  const m = r.multi();
  if (image) m.set(`${p}:frame:${cam}`, image, 'PX', 5000); // 실제 YOBA는 블러 실패 시 검은 JPEG를 씀
  m.set(`${p}:live:${cam}`, JSON.stringify(payload));
  m.sadd(`${p}:cameras`, cam);
  m.set(`${p}:heartbeat`, payload.updated_at);
  await m.exec();
  if (frames % (fps * 5) === 0) console.log(`[fake-yoba] ${frames}프레임 · 인원 ${payload.zones.map((z) => z.count).join('+')}`);
}

// 기존 10초 모드 (YOBA spec 9.1~9.2): 10초마다 구역 JSON(level 0~2, score)과 이미지(TTL 120초)
async function legacyTick() {
  if (stopAfter && Date.now() - started > stopAfter * 1000) {
    console.log('멈춤 (--stop-after). 웹 화면이 약 35초 안에 "확인 불가"로 바뀌어야 합니다.');
    await r.quit();
    process.exit(0);
  }
  const t = (Date.now() - started) / 1000;
  const score = +(0.5 + 0.5 * Math.sin(t / 60)).toFixed(3);
  const level = score < 0.4 ? 0 : score < 0.7 ? 1 : 2;
  const ts = Math.floor(Date.now() / 1000);
  const payload = {
    zone_id: legacyZone,
    level,
    score,
    confidence: 'high',
    image_url: image ? `/snapshots/${legacyZone}.jpg?v=${ts}` : null,
    updated_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    status: 'ok',
  };
  const m = r.multi();
  if (image) m.set(`${p}:img:${legacyZone}`, image, 'EX', 120);
  m.set(`${p}:zone:${legacyZone}`, JSON.stringify(payload));
  m.sadd(`${p}:zones`, legacyZone);
  m.set(`${p}:heartbeat`, payload.updated_at);
  await m.exec();
  console.log(`[fake-yoba] 10초 모드 · level ${level} (score ${score})`);
}

r.on('ready', () => {
  if (legacy) {
    console.log(`[fake-yoba] ${url} 에 10초 모드로 쓰는 중 (구역 ${legacyZone}${image ? ', 이미지 포함' : ''})`);
    legacyTick();
    setInterval(() => legacyTick().catch((e) => console.error(e.message)), 10_000);
    return;
  }
  console.log(`[fake-yoba] ${url} 에 ${fps}fps로 쓰는 중 (카메라 ${cam}${image ? ', 이미지 포함' : ''})`);
  setInterval(() => tick().catch((e) => console.error(e.message)), 1000 / fps);
});
r.on('error', (e) => console.error(`[fake-yoba] Redis 오류: ${e.message}`));
