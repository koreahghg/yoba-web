// YOBA가 Redis에 쓴 값이 docs/REDIS_CONTRACT.md와 맞는지 검사한다 (읽기만 함).
//
//   npm run check-redis               # 3초 동안 관찰
//   npm run check-redis -- --seconds 5
//
// YOBA를 `--live --publish`로 켠 상태에서 실행한다. 실패(✖)가 없으면 웹에 그대로 붙는다.

import Redis from 'ioredis';
import { checkFrame, checkLive, checkUpdates } from '../server/contract.js';

const i = process.argv.indexOf('--seconds');
const seconds = i >= 0 ? Number(process.argv[i + 1]) : 3;
const url = process.env.REDIS_URL || 'redis://localhost:6379/0';
const p = process.env.REDIS_KEY_PREFIX || 'yoba';
const ICON = { ok: '✔', warn: '!', fail: '✖' };
let fails = 0;
const print = (results) => {
  for (const r of results) {
    if (r.level === 'fail') fails += 1;
    console.log(`  ${ICON[r.level]} ${r.msg}`);
  }
};

const r = new Redis(url, { maxRetriesPerRequest: 1, connectTimeout: 3000, retryStrategy: () => null });
r.on('error', () => {});

try {
  await r.ping();
} catch (e) {
  console.log(`✖ Redis 연결 실패 (${url}): ${e.message}`);
  process.exit(1);
}
console.log(`Redis ${url.replace(/\/\/[^@]*@/, '//***@')} · 접두사 ${p}\n`);

const ids = (await r.smembers(`${p}:cameras`)).sort();
if (ids.length === 0) {
  const zones = await r.smembers(`${p}:zones`);
  if (zones.length) {
    console.log(`! 실시간 키는 없고 10초 모드 구역 ${zones.length}개가 있습니다 (${zones.join(', ')}).`);
    for (const z of zones) {
      const v = JSON.parse((await r.get(`${p}:zone:${z}`)) || 'null');
      const img = await r.getBuffer(`${p}:img:${z}`);
      console.log(`  [${z}] level ${v?.level ?? '-'} · status ${v?.status ?? '-'} · ${v?.updated_at ?? '-'} · 이미지 ${img ? `${(img.length / 1024).toFixed(0)}KB` : '없음'}`);
    }
    console.log('웹은 10초 모드로 표시합니다 (사람 수 없이 YOBA 판정 단계 그대로). 실시간 검사는 YOBA를 --live --publish로 켠 뒤 다시 실행하세요.');
    await r.quit();
    process.exit(0);
  }
  console.log(`✖ ${p}:cameras 가 비어 있음 → YOBA가 --live --publish(또는 10초 모드)로 돌고 있는지 확인`);
  process.exit(1);
}

for (const id of ids) {
  console.log(`[${id}]`);
  const raw = await r.get(`${p}:live:${id}`);
  if (!raw) {
    print([{ level: 'fail', msg: `${p}:live:${id} 키가 없음` }]);
    continue;
  }
  let live;
  try {
    live = JSON.parse(raw);
  } catch {
    print([{ level: 'fail', msg: 'live: JSON 파싱 실패' }]);
    continue;
  }
  print(checkLive(live, id));
  print(checkFrame(await r.getBuffer(`${p}:frame:${id}`), await r.pttl(`${p}:frame:${id}`)));

  const samples = [];
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const v = await r.get(`${p}:live:${id}`);
    if (v) {
      const { updated_at, frames_total } = JSON.parse(v);
      samples.push({ updated_at, frames_total });
    }
    await new Promise((res) => setTimeout(res, 100));
  }
  print(checkUpdates(samples, seconds));
  console.log('');
}

console.log(fails === 0 ? '결과: 약속과 맞습니다.' : `결과: 실패 ${fails}개 — 위 ✖ 항목을 고쳐 주세요.`);
await r.quit();
process.exit(fails === 0 ? 0 : 1);
