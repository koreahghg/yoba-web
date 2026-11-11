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
