import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseItems, parseResponse, speedStatus } from '../server/its.js';
import { TRAFFIC } from '../server/map-config.js';
import { createMapState, validateMapUpdate } from '../server/map-state.js';
import { openStore } from '../server/store.js';

const fakeIts = (speeds, lastOkAt = Date.now()) => ({ state: { enabled: true, speeds: new Map(speeds), lastOkAt, lastError: null, count: speeds.length } });

test('ITS 응답 파싱: body.items 배열과 item 객체 둘 다', () => {
  assert.deepEqual(parseItems({ body: { items: [{ linkId: 123, speed: '42.5', roadName: '호남고속도로' }] } })[0],
    { linkId: '123', speed: 42.5, roadName: '호남고속도로', createdDate: '' });
  assert.equal(parseItems({ body: { items: { item: [{ linkId: 'a', speed: 1 }, { linkId: 'b', speed: 'x' }] } } }).length, 1);
  assert.deepEqual(parseItems({}), []);
});

test('ITS XML 응답 (테스트 키 실제 형식) 파싱, 오류 코드는 예외', () => {
  const xml = `<?xml version='1.0' encoding='UTF-8'?><response><header><resultCode>0</resultCode><resultMsg>SUCCESS</resultMsg></header>
    <body><totalCount>2</totalCount><items>
    <item><roadName>남문로</roadName><roadDrcType/><linkNo/><linkId>1750000100</linkId><speed>73</speed><travelTime>12.01</travelTime><createdDate>20201130144001</createdDate></item>
    <item><roadName>남문로</roadName><linkId>1750000200</linkId><speed>68</speed></item>
    </items></body></response>`;
  const items = parseResponse(xml);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { linkId: '1750000100', speed: 73, roadName: '남문로', createdDate: '20201130144001' });
  assert.throws(() => parseResponse('<response><header><resultCode>99</resultCode><resultMsg>인증키 오류</resultMsg></header></response>'), /인증키 오류/);
  assert.equal(parseResponse('{"body":{"items":[{"linkId":"1","speed":"10"}]}}')[0].speed, 10);
});

test('속도 → 원활/서행/정체', () => {
  const seg = { free_kmh: 30, jam_kmh: 15 };
  assert.equal(speedStatus(30, seg), 'free');
  assert.equal(speedStatus(20, seg), 'busy');
  assert.equal(speedStatus(14.9, seg), 'jam');
  assert.equal(speedStatus(NaN, seg), 'unknown');
});

test('도로 수동 값은 저장되어 재시작해도 유지, ITS 꺼져 있으면 자동은 확인중', () => {
  const store = openStore(':memory:');
  const off = { state: { enabled: false, speeds: new Map() } };
  const m = createMapState(store, off);
  assert.equal(m.snapshot().traffic['traffic-yb-01'], 'unknown');
  m.update({ traffic: { 'yb-01': 'jam' } });
  assert.equal(createMapState(store, off).snapshot().traffic['traffic-yb-01'], 'jam');
  assert.equal(m.snapshot().parking, undefined); // 학교·장소 점에는 상태 없음
});

test('도로: 자동은 ITS 속도, 수동이 우선, ITS가 오래되면 확인중', () => {
  const seg = TRAFFIC[0];
  const original = seg.its_links;
  seg.its_links = ['L1', 'L2'];
  try {
    const store = openStore(':memory:');
    const its = fakeIts([['L1', 5], ['L2', 15]]); // 평균 10 → dg-01 기준(30/15)이면 정체
    const m = createMapState(store, its, { intervalSec: 60 });
    assert.equal(m.snapshot().traffic[seg.svg], 'jam');
    m.update({ traffic: { [seg.id]: 'free' } });
    assert.equal(m.snapshot().traffic[seg.svg], 'free');
    m.update({ traffic: { [seg.id]: 'auto' } });
    its.state.lastOkAt = Date.now() - 181_000; // 3주기 넘게 수신 없음
    assert.equal(m.snapshot().traffic[seg.svg], 'unknown');
    assert.equal(m.snapshot().traffic[TRAFFIC[1].svg], 'unknown'); // 링크 없는 구간
  } finally {
    seg.its_links = original;
  }
});

test('지도 변경 검증', () => {
  assert.equal(validateMapUpdate({ traffic: { 'dg-01': 'auto', 'yb-03': 'jam' } }), null);
  assert.ok(validateMapUpdate({ traffic: { nowhere: 'jam' } }));
  assert.ok(validateMapUpdate({ traffic: { 'dg-01': 'full' } }));
});
