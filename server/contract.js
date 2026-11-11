// docs/REDIS_CONTRACT.md 형식 검사. tools/check-redis.js와 테스트가 쓴다.
// 결과: [{level: 'ok'|'warn'|'fail', msg}]

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function checkLive(raw, cameraId) {
  const out = [];
  const ok = (msg) => out.push({ level: 'ok', msg });
  const warn = (msg) => out.push({ level: 'warn', msg });
  const fail = (msg) => out.push({ level: 'fail', msg });

  if (raw.camera_id !== undefined && raw.camera_id !== cameraId) warn(`camera_id(${raw.camera_id})가 키의 ID(${cameraId})와 다름`);

  if (typeof raw.updated_at !== 'string' || Number.isNaN(Date.parse(raw.updated_at))) fail('updated_at: ISO 8601 문자열이어야 함');
  else ok(`updated_at: ${raw.updated_at}`);

  const fs = raw.frame_size;
  const sizeOk = Array.isArray(fs) && fs.length === 2 && fs.every((v) => isNum(v) && v > 0);
  if (!sizeOk) fail('frame_size: [가로, 세로] 양수 배열이어야 함 (없으면 구역 테두리를 그릴 수 없음)');
  else ok(`frame_size: ${fs[0]}×${fs[1]}`);

  if (!Array.isArray(raw.zones) || raw.zones.length === 0) {
    fail('zones: 구역이 1개 이상 있어야 함');
    return out;
  }
  for (const z of raw.zones) {
    const id = z.zone_id ?? '(zone_id 없음)';
    if (typeof z.zone_id !== 'string') fail(`${id}: zone_id 문자열 필요`);
    if (!Number.isInteger(z.count) || z.count < 0) fail(`${id}: count는 0 이상의 정수여야 함 (지금 ${JSON.stringify(z.count)})`);
    if (!Array.isArray(z.roi) || z.roi.length < 3) {
      fail(`${id}: roi는 점 3개 이상 다각형이어야 함`);
      continue;
    }
    if (sizeOk) {
      const xs = z.roi.map((p) => p[0]);
      const ys = z.roi.map((p) => p[1]);
      const out1 = xs.some((x) => x < 0 || x > fs[0] * 1.01) || ys.some((y) => y < 0 || y > fs[1] * 1.01);
      if (out1) fail(`${id}: roi 좌표가 frame_size 밖에 있음 → frame_size를 roi와 같은 기준(원본 해상도)으로 보내야 함`);
    }
    ok(`${id}: ${z.count}명${z.name ? ` (${z.name})` : ''}`);
  }

  for (const k of ['fps', 'latency_ms', 'blur_fail_total', 'frames_total']) {
    if (raw[k] === undefined) warn(`${k}: 없음 (어드민 처리 상태가 '-'로 보임)`);
    else if (!isNum(raw[k])) fail(`${k}: 숫자여야 함`);
  }
  if (raw.blur_ok === undefined) warn('blur_ok: 없음');
  else if (typeof raw.blur_ok !== 'boolean') fail('blur_ok: true/false여야 함');
  if (!raw.name) warn('name: 없음 → 화면에 카메라 ID가 그대로 보임');
  return out;
}

/** JPEG 바이트와 남은 TTL(ms) 검사 */
export function checkFrame(buf, pttl) {
  const out = [];
  if (!buf) return [{ level: 'fail', msg: 'frame: 키가 없음 (TTL 5초가 지나 사라졌거나 아직 안 씀)' }];
  const jpeg = buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf.at(-2) === 0xff && buf.at(-1) === 0xd9;
  out.push(jpeg ? { level: 'ok', msg: `frame: JPEG ${(buf.length / 1024).toFixed(0)}KB` } : { level: 'fail', msg: 'frame: JPEG가 아님 (FFD8…FFD9)' });
  if (buf.length > 300 * 1024) out.push({ level: 'warn', msg: 'frame: 300KB 넘음 → 방문객이 많으면 대역폭 부담. 전송 해상도/품질 낮추기 권장' });
  if (pttl === -1) out.push({ level: 'fail', msg: 'frame: TTL 없음 → YOBA가 죽어도 마지막 이미지가 계속 남음' });
  else if (pttl > 0) out.push({ level: 'ok', msg: `frame: TTL ${pttl}ms 남음` });
  return out;
}

/**
 * 여러 번 읽은 live 값으로 "새 프레임 인식" 검사.
 * samples: [{updated_at, frames_total}] (약 0.1초 간격)
 */
export function checkUpdates(samples, seconds) {
  const stamps = new Set(samples.map((s) => `${s.updated_at}|${s.frames_total ?? ''}`));
  const times = new Set(samples.map((s) => s.updated_at));
  const out = [];
  const rate = (stamps.size - 1) / seconds;
  if (stamps.size <= 1) out.push({ level: 'fail', msg: `${seconds}초 동안 값이 한 번도 안 바뀜 → 웹은 "확인 불가"로 표시함` });
  else out.push({ level: 'ok', msg: `초당 약 ${rate.toFixed(1)}번 갱신` });
  if (times.size < stamps.size && samples.every((s) => s.frames_total === undefined)) {
    out.push({ level: 'warn', msg: 'updated_at이 같은 값으로 여러 번 옴. 밀리초까지 넣거나 frames_total을 보내 주세요' });
  } else if (times.size < stamps.size) {
    out.push({ level: 'ok', msg: 'updated_at이 초 단위지만 frames_total로 새 프레임을 구분함 (밀리초를 넣으면 더 좋음)' });
  }
  return out;
}
