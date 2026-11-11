import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkFrame, checkLive, checkUpdates } from '../server/contract.js';
import { LiveState } from '../server/state.js';

const fails = (r) => r.filter((x) => x.level === 'fail').map((x) => x.msg);
const good = {
  camera_id: 'cam01',
  updated_at: '2026-11-20T14:30:00+09:00',
  frame_size: [1280, 720],
  fps: 7.8, latency_ms: 180, blur_ok: true, blur_fail_total: 0, frames_total: 10,
  zones: [{ zone_id: 'hall', count: 3, roi: [[0, 0], [1280, 0], [1280, 720]] }],
};

test('약속대로 온 값은 실패 없음 (name 없음은 경고만)', () => {
  const r = checkLive(good, 'cam01');
  assert.deepEqual(fails(r), []);
  assert.ok(r.some((x) => x.level === 'warn' && x.msg.startsWith('name')));
});

test('frame_size가 줄인 JPEG 크기로 오면 roi가 밖으로 나가 실패', () => {
  assert.equal(fails(checkLive({ ...good, frame_size: [960, 540] }, 'cam01')).length, 1);
});

test('count가 스무딩된 소수면 실패', () => {
  assert.equal(fails(checkLive({ ...good, zones: [{ ...good.zones[0], count: 2.4 }] }, 'cam01')).length, 1);
});

test('JPEG·TTL 검사', () => {
  const jpg = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
  assert.deepEqual(fails(checkFrame(jpg, 4200)), []);
  assert.equal(fails(checkFrame(jpg, -1)).length, 1);
  assert.equal(fails(checkFrame(Buffer.from('png?'), 4000)).length, 1);
  assert.equal(fails(checkFrame(null, -2)).length, 1);
});

test('갱신 검사: 멈춤은 실패', () => {
  const same = Array(10).fill({ updated_at: 'a', frames_total: 1 });
  assert.equal(fails(checkUpdates(same, 1)).length, 1);
});

test('updated_at이 초 단위여도 frames_total이 바뀌면 웹이 매 프레임 반영', () => {
  const s = new LiveState({ staleMs: 3000, smoothingSeconds: 0.001 });
  const at = '2026-11-20T14:30:00+09:00';
  s.ingest([{ ...good, updated_at: at, frames_total: 1, zones: [{ ...good.zones[0], count: 1 }] }], 0);
  s.ingest([{ ...good, updated_at: at, frames_total: 2, zones: [{ ...good.zones[0], count: 9 }] }], 125);
  assert.equal(s.publicSnapshot({ total: { free_max: 2, busy_min: 5 } }, 130).total.count, 9);
});
