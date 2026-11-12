// ITS 키 확인 + 지도 구간에 넣을 링크 ID 찾기.
//
//   ITS_API_KEY=... npm run its-links            # 범위 안 도로 링크 목록 (도로명별)
//   ITS_API_KEY=... npm run its-links -- --raw   # 원본 응답 앞부분 (형식이 다를 때 확인용)
//
// 결과에서 동광주IC~AI교육원 경로의 링크 ID를 골라 server/map-config.js의 its_links에 넣는다.

import { ITS_BBOX } from '../server/map-config.js';
import { buildItsUrl, parseResponse } from '../server/its.js';

const key = process.env.ITS_API_KEY;
if (!key) {
  console.log('ITS_API_KEY가 없습니다. .env에 넣거나 ITS_API_KEY=... npm run its-links 로 실행하세요.');
  console.log('(키 없이 형식만 보려면 ITS_API_KEY=test — 이 지역이 아닌 예시 데이터가 나옵니다)');
  process.exit(1);
}

const res = await fetch(buildItsUrl(key, ITS_BBOX), { signal: AbortSignal.timeout(15_000) }).catch((e) => {
  console.log(`요청 실패: ${e.message}`);
  process.exit(1);
});
const text = await res.text();
console.log(`HTTP ${res.status} · 범위 ${JSON.stringify(ITS_BBOX)}\n`);
if (process.argv.includes('--raw') || !res.ok) {
  console.log(text.slice(0, 3000));
  process.exit(res.ok ? 0 : 1);
}

let items;
try {
  items = parseResponse(text);
} catch (e) {
  console.log(`응답을 읽지 못했습니다 (${e.message}). 원본 앞부분:\n`, text.slice(0, 500));
  process.exit(1);
}
if (items.length === 0) {
  console.log('링크가 0개입니다. 키 승인 상태, 범위, 응답 형식(--raw)을 확인하세요.');
  process.exit(1);
}

const byRoad = new Map();
for (const it of items) {
  const k = it.roadName || '(이름 없음)';
  if (!byRoad.has(k)) byRoad.set(k, []);
  byRoad.get(k).push(it);
}
for (const [road, list] of [...byRoad].sort()) {
  console.log(`■ ${road} (${list.length}개)`);
  for (const it of list) console.log(`   ${it.linkId}  ${it.speed}km/h`);
}
console.log(`\n총 ${items.length}개 링크`);
