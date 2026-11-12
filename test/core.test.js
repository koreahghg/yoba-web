import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LiveState, levelOf, validateThresholds } from '../server/state.js';
import { TOTAL_ID, createRecorder, dayRangeKst, openStore } from '../server/store.js';

const T = { free_max: 10, busy_min: 30 };
const cam = (updated_at, counts, extra = {}) => ({
  camera_id: 'cam01',
  updated_at,
  frame_size: [960, 540],
  zones: counts.map((c, i) => ({ zone_id: `z${i}`, count: c, roi: [[0, 0], [1, 0], [1, 1]] })),
  ...extra,
});

test('levelOf: 경계값', () => {
  assert.equal(levelOf(10, T), 'free');
  assert.equal(levelOf(11, T), 'normal');
  assert.equal(levelOf(29, T), 'normal');
  assert.equal(levelOf(30, T), 'busy');
  assert.equal(levelOf(null, T), 'unknown');
});

test('validateThresholds', () => {
  assert.equal(validateThresholds(T), null);
  assert.ok(validateThresholds({ free_max: 30, busy_min: 30 }));
  assert.ok(validateThresholds({ free_max: -1, busy_min: 3 }));
  assert.ok(validateThresholds({ free_max: 1.5, busy_min: 3 }));
});

test('끊긴 카메라는 "여유"가 아니라 확인 불가', () => {
  const s = new LiveState({ staleMs: 3000, smoothingSeconds: 2 });
  s.ingest([cam('a', [0])], 1000);
  assert.equal(s.publicSnapshot({ total: T }, 1500).total.level, 'free');
  // 같은 updated_at이 계속 오면(YOBA 멈춤) 3초 뒤 확인 불가
  s.ingest([cam('a', [0])], 4000);
  const snap = s.publicSnapshot({ total: T }, 4100);
  assert.equal(snap.total.level, 'unknown');
  assert.equal(snap.total.count, null);
  assert.equal(snap.cameras[0].zones[0].level, 'unknown');
  assert.equal(snap.total.online_cameras, 0);
});

test('스무딩: 튀는 값을 줄이고, 끊겼다 돌아오면 새 값으로 바로 시작', () => {
  const s = new LiveState({ staleMs: 3000, smoothingSeconds: 2 });
  s.ingest([cam('1', [10])], 0);
  s.ingest([cam('2', [40])], 500);
  const c = s.publicSnapshot({ total: T }, 600).total.count;
  assert.ok(c > 10 && c < 25, `스무딩 값 ${c}`);
  s.ingest([cam('3', [5])], 10_000); // 9.5초 공백 뒤
  assert.equal(s.publicSnapshot({ total: T }, 10_100).total.count, 5);
});

test('구역 기준: 따로 정하면 구역 색이 그 기준을 따름', () => {
  const s = new LiveState({ staleMs: 3000, smoothingSeconds: 0.001 });
  s.ingest([cam('1', [8, 2])], 0);
  const snap = s.publicSnapshot({ total: T, zones: { z0: { free_max: 3, busy_min: 6 } } }, 10);
  assert.equal(snap.cameras[0].zones[0].level, 'busy');
  assert.equal(snap.cameras[0].zones[1].level, 'free'); // 전체 10명 → 여유
});

test('통계: 시간별 평균은 끊긴 시간을 빼고, 블러 실패는 증가분만', () => {
  const store = openStore(':memory:');
  const s = new LiveState({ staleMs: 3000, smoothingSeconds: 0.001 });
  const record = createRecorder(store);
  const [start] = dayRangeKst('2026-11-11'); // KST 00:00
  const t0 = start + 10 * 3600e3; // 10시
  s.ingest([cam('1', [10], { blur_fail_total: 5 })], t0);
  record(s, t0 + 10);
  s.ingest([cam('2', [20], { blur_fail_total: 7 })], t0 + 1000);
  record(s, t0 + 1010);
  record(s, t0 + 9000); // 끊김 → 평균에서 제외
  const h = store.hourly('2026-11-11')[10];
  assert.equal(h.samples, 3);
  assert.equal(h.online_samples, 2);
  assert.equal(h.avg, 15);
  assert.equal(h.max, 20);
  assert.equal(h.peak_at, t0 + 1010);
  assert.equal(h.blur_fail, 2);
  assert.equal(store.blurFailCount('2026-11-11', TOTAL_ID), 2);
  assert.equal(store.hourly('2026-11-11')[9].avg, null);
});

test('설정 저장/불러오기', () => {
  const store = openStore(':memory:');
  assert.deepEqual(store.getSettings().total, { free_max: 20, busy_min: 50 });
  store.saveSettings({ total: T, zones: {} });
  assert.deepEqual(store.getSettings().total, T);
});

test('이름이 없으면 "현장 CCTV N", Redis 목록에서 빠지면 화면에서도 사라짐', () => {
  const s = new LiveState({ staleMs: 3000, smoothingSeconds: 1 });
  const named = { ...cam('1', [1]), camera_id: 'cam01', name: '행사장 CCTV (가짜)' };
  const webcam = { ...cam('1', [2]), camera_id: 'webcam' };
  s.ingest([named, webcam], 0);
  let snap = s.publicSnapshot({ total: T }, 10);
  assert.deepEqual(snap.cameras.map((c) => c.name), ['행사장 CCTV (가짜)', '현장 CCTV 2']);
  s.ingest(null, 100); // Redis 끊김: 목록 유지 (3초 뒤 확인 불가)
  assert.equal(s.publicSnapshot({ total: T }, 110).cameras.length, 2);
  s.ingest([{ ...webcam, updated_at: '2' }], 200); // cam01 정리됨
  snap = s.publicSnapshot({ total: T }, 210);
  assert.deepEqual(snap.cameras.map((c) => [c.id, c.name]), [['webcam', '현장 CCTV 1']]);
  assert.equal(snap.total.cameras, 1);
});

const zone = (zone_id, updated_at, level, extra = {}) => ({
  camera_id: `zone:${zone_id}`, legacy: true, zone_id, level, score: 0.5, confidence: 'high', updated_at, status: 'ok', ...extra,
});

test('10초 모드: 사람 수 없이 YOBA 단계 그대로, 실시간이 살아 있으면 실시간 우선', () => {
  const s = new LiveState({ staleMs: 3000, legacyStaleMs: 35000, smoothingSeconds: 0.001 });
  s.ingest([zone('hall', 'a', 1), zone('gate', 'a', 2)], 0);
  let snap = s.publicSnapshot({ total: T }, 10);
  assert.equal(snap.mode, 'legacy');
  assert.deepEqual(snap.cameras.map((c) => [c.name, c.level, c.count]), [['현장 CCTV 1', 'busy', null], ['현장 CCTV 2', 'normal', null]]);
  assert.equal(snap.total.level, 'busy'); // 가장 혼잡한 구역
  assert.equal(snap.total.count, null);
  // 10초 주기라 3초 지나도 살아 있음, 35초 넘게 그대로면 확인 불가
  assert.equal(s.publicSnapshot({ total: T }, 20_000).total.level, 'busy');
  s.ingest([zone('hall', 'a', 1), zone('gate', 'a', 2, { confidence: 'low' })], 30_000); // low: updated_at 그대로
  assert.equal(s.publicSnapshot({ total: T }, 36_000).total.level, 'unknown');

  // 실시간 카메라가 들어오면 실시간만 보임
  s.ingest([zone('hall', 'b', 1), cam('1', [40])], 40_000);
  snap = s.publicSnapshot({ total: T }, 40_010);
  assert.equal(snap.mode, 'live');
  assert.deepEqual(snap.cameras.map((c) => c.id), ['cam01']);
  assert.equal(snap.total.level, 'busy');
  assert.deepEqual(s.visibleIds(40_010), ['cam01']);
  // 실시간이 멈추면 다시 10초 모드로
  s.ingest([zone('hall', 'c', 0), cam('1', [40])], 45_000);
  snap = s.publicSnapshot({ total: T }, 45_010);
  assert.equal(snap.mode, 'legacy');
  assert.equal(snap.total.level, 'free');
});

test('10초 모드: status error는 확인 불가, 오래된 값은 처음부터 확인 불가', () => {
  const s = new LiveState({ staleMs: 3000, legacyStaleMs: 35000, smoothingSeconds: 1 });
  s.ingest([zone('hall', 'a', 0, { status: 'error' })], 0);
  assert.equal(s.publicSnapshot({ total: T }, 10).total.level, 'unknown');
  const now = Date.parse('2026-11-12T12:00:00+09:00');
  const s2 = new LiveState({ staleMs: 3000, legacyStaleMs: 35000, smoothingSeconds: 1 });
  s2.ingest([zone('hall', '2026-11-12T10:00:00+09:00', 0)], now); // 2시간 전 값 (YOBA 꺼진 뒤 남은 것)
  assert.equal(s2.publicSnapshot({ total: T }, now + 10).total.level, 'unknown');
});

test('통계: 10초 모드는 0명으로 기록하지 않음', () => {
  const store = openStore(':memory:');
  const s = new LiveState({ staleMs: 3000, legacyStaleMs: 35000, smoothingSeconds: 1 });
  const [start] = dayRangeKst('2026-11-11');
  s.ingest([zone('hall', 'a', 2)], start);
  createRecorder(store)(s, start + 10);
  const h = store.hourly('2026-11-11')[0];
  assert.equal(h.online_samples, 1);
  assert.equal(h.avg, null);
});
