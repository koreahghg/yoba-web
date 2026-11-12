// 방문객 화면: 지도 혼잡도 링 + CCTV 요약/타일 + 확대 모달 + 오늘 추이.
import { $, LEVEL, drawHourlyChart, el, renderOverlay, subscribeState, timeText } from './common.js';

// 영상: 메인 칸도 MJPEG(초당 TILE_FPS장). 서버 동시 연결 상한에 걸리거나(503) 프록시가 MJPEG를
// 막아 4초 안에 첫 장이 안 오면 1초 간격 사진으로 바꾸고, 30초 뒤 다시 MJPEG를 시도한다.
// 10초 모드는 그림이 10초마다 바뀌므로 처음부터 1초 간격 사진.
const SNAPSHOT_MS = 1000;
const STREAM_FIRST_FRAME_MS = 4000;
const STREAM_RETRY_MS = 30_000;
const HOURLY_MS = 60_000;

let latest = null;
const tiles = new Map();

// ---------- 지도 ----------
async function loadMap() {
  const mount = $('#mapMount');
  try {
    const res = await fetch('map/map_traffic.svg', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    mount.className = '';
    mount.innerHTML = await res.text();
    const svg = mount.querySelector('svg');
    svg.id = 'map-svg';
    svg.classList.add('map-svg');
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    // 서버 값을 받기 전에는 SVG에 그려 둔 임의 색 대신 회색(확인 중)으로 시작
    applyMapStatus({ traffic: {} }, svg);
    if (latest) {
      setMapLevel(latest.total.level);
      applyMapStatus(latest.map);
    }
  } catch (e) {
    mount.textContent = `지도 불러오기 실패 · ${e.message}`;
  }
}

function setMapLevel(level) {
  const meta = LEVEL[level] || LEVEL.unknown;
  const ring = document.getElementById('ai-congestion-ring');
  const badge = document.getElementById('ai-congestion-badge');
  const text = document.getElementById('ai-congestion-badge-text');
  if (ring) {
    ring.setAttribute('stroke', meta.hex);
    ring.classList.toggle('ring-busy', level === 'busy');
  }
  if (badge) {
    // 원본 배지(가로 48, 가운데 x=287)는 두 글자용 → "확인불가" 네 글자일 땐 넓힌다
    const w = level === 'unknown' ? 62 : 48;
    badge.setAttribute('fill', meta.hex);
    badge.setAttribute('width', w);
    badge.setAttribute('x', 287 - w / 2);
  }
  if (text) {
    text.textContent = level === 'unknown' ? '확인불가' : meta.label;
    text.style.fontSize = level === 'unknown' ? '12px' : ''; // 네 글자는 배지 높이(16)에 맞게 줄임
  }
}

const TRAFFIC_CLASSES = ['traffic-free', 'traffic-busy', 'traffic-jam', 'traffic-unknown'];

/** map: {traffic: {svgId: free|busy|jam|unknown}} — 도로 구간 색만 칠한다 */
function applyMapStatus(map, root = document.getElementById('map-svg')) {
  if (!root || !map) return;
  root.querySelectorAll('.traffic-segment').forEach((p) => {
    const s = map.traffic?.[p.id] ?? 'unknown';
    p.classList.remove(...TRAFFIC_CLASSES);
    p.classList.add(`traffic-${s}`);
  });
}

// ---------- CCTV 타일 ----------
/** 영상이 오면 CCTV 화면만, 숫자만 오면 대체 화면, 끊기면 확인 불가 */
const overlayMode = (cam) => (!cam.online ? 'offline' : cam.has_frame ? 'video' : 'placeholder');
const placeholderNote = (state) => (state?.source === 'demo' ? '데모 화면 · 실제 영상 아님' : '영상 준비 중 · 인원 수만 표시');

function createTile(cam) {
  const img = el('img', { class: 'camera-image', alt: '', hidden: true });
  const overlay = el('svg:svg', { class: 'camera-overlay', 'aria-hidden': 'true' });
  const name = el('div', { class: 'camera-name' });
  const count = el('div', { class: 'camera-count' });
  const time = el('div', { class: 'camera-time' });
  const down = el('div', { class: 'camera-down', hidden: true }, el('div', {}, '확인 불가', el('small', { text: 'CCTV 신호를 받지 못하고 있습니다' })));
  const tile = el('button', { class: 'camera-tile unknown', type: 'button', onclick: () => openModal(cam.id) },
    img, overlay, el('div', { class: 'top-gradient' }), name, count, el('div', { class: 'camera-zoom', text: '눌러서 크게 보기' }), time, down);
  $('#cameraGrid').append(tile);
  const t = { tile, img, overlay, name, count, time, down, loading: false, video: 'off', retryAt: 0, watchdog: null };
  tiles.set(cam.id, t);
  return t;
}

/** 칸 영상 연결 상태: 'off' | 'stream'(MJPEG) | 'snapshot'(1초 사진) */
function stopTileVideo(t) {
  clearTimeout(t.watchdog);
  t.img.onload = t.img.onerror = null;
  if (t.video === 'stream') t.img.removeAttribute('src'); // MJPEG 연결 끊기
  t.video = 'off';
}

function tileToSnapshot(t, id, retry = true) {
  stopTileVideo(t);
  t.video = 'snapshot';
  t.retryAt = retry ? Date.now() + STREAM_RETRY_MS : Infinity;
  refreshSnapshot(t, id);
}

function tileToStream(t, cam) {
  stopTileVideo(t);
  t.video = 'stream';
  const fps = latest?.stream?.tile_fps ?? 10;
  t.img.onload = () => clearTimeout(t.watchdog); // 첫 장이 왔다
  t.img.onerror = () => tileToSnapshot(t, cam.id); // 상한(503) 등
  t.watchdog = setTimeout(() => tileToSnapshot(t, cam.id), STREAM_FIRST_FRAME_MS);
  t.img.src = `stream/${encodeURIComponent(cam.id)}.mjpg?fps=${fps}&t=${Date.now()}`;
}

/** 지금 상태에 맞게 칸 영상 연결을 켜고 끈다. 확대 화면을 보는 동안에는 칸 영상을 쉰다 (연결 절약). */
function syncTileVideo(t, cam, hasVideo) {
  if (!hasVideo || modalCam) return stopTileVideo(t);
  if (cam.legacy) {
    if (t.video !== 'snapshot') tileToSnapshot(t, cam.id, false);
    return;
  }
  if (t.video === 'off') tileToStream(t, cam);
  else if (t.video === 'snapshot' && Date.now() >= t.retryAt) tileToStream(t, cam);
}

function refreshSnapshot(t, id) {
  if (t.loading) return;
  t.loading = true;
  const next = new Image();
  const url = `snapshot/${encodeURIComponent(id)}.jpg?t=${Date.now()}`;
  next.onload = () => {
    t.img.src = url;
    t.img.hidden = false;
    t.loading = false;
  };
  next.onerror = () => (t.loading = false);
  next.src = url;
}

function renderCameras(state) {
  const grid = $('#cameraGrid');
  grid.style.setProperty('--cols', String(Math.min(Math.max(state.cameras.length, 1), 3)));
  if (tiles.size === 0) grid.replaceChildren(); // "연결되지 않았습니다" 안내 지우기
  for (const cam of state.cameras) {
    const t = tiles.get(cam.id) || createTile(cam);
    t.tile.className = `camera-tile ${cam.level}`;
    t.tile.setAttribute('aria-label', `${cam.name}, ${cam.online ? statusText(cam) : '확인 불가'}. 눌러서 크게 보기`);
    t.tile.style.aspectRatio = `${cam.frame_size[0]} / ${cam.frame_size[1]}`;
    t.name.textContent = cam.name;
    t.count.textContent = cam.online ? statusText(cam) : '확인 불가';
    const mode = overlayMode(cam);
    t.time.textContent = !cam.online ? '신호 없음'
      : cam.status === 'blur_fail' ? '보호 처리 중 · 화면 가림'
        : mode === 'placeholder' ? '영상 준비 중'
          : cam.legacy ? '10초마다 갱신' : '실시간';
    t.down.hidden = cam.online;
    t.img.hidden = mode !== 'video';
    syncTileVideo(t, cam, mode === 'video');
    renderOverlay(t.overlay, cam, { mode, note: placeholderNote(state) });
  }
  // 목록에서 사라진 카메라 칸은 연결을 끊고 지운다
  for (const [id, t] of tiles) {
    if (state.cameras.some((c) => c.id === id)) continue;
    stopTileVideo(t);
    t.tile.remove();
    tiles.delete(id);
  }
  if (tiles.size === 0) {
    grid.replaceChildren(el('div', { class: 'camera-tile unknown', style: 'cursor:default' },
      el('div', { class: 'camera-down' }, el('div', {}, '확인 불가', el('small', { text: 'CCTV가 아직 연결되지 않았습니다' })))));
  }
}

/** 실시간: "사람 12명 · 보통" / 10초 모드: 사람 수가 없어 단계만 */
const statusText = (cam) => (cam.legacy ? LEVEL[cam.level].label : `사람 ${cam.count}명 · ${LEVEL[cam.level].label}`);

// 사진 방식인 칸만 1초마다 새로 받음 (MJPEG 칸은 서버가 밀어 줌)
setInterval(() => {
  if (!latest) return;
  for (const cam of latest.cameras) {
    const t = tiles.get(cam.id);
    if (t?.video === 'snapshot' && cam.has_frame) refreshSnapshot(t, cam.id);
  }
}, SNAPSHOT_MS);

// ---------- 요약 ----------
function renderSummary(state) {
  const { total } = state;
  const known = total.level !== 'unknown';
  const legacy = state.mode === 'legacy'; // 10초 모드: 사람 수 없이 YOBA 판정 단계만 옴
  $('#totalHuman').textContent = known && !legacy ? total.count : '-';
  $('#totalHumanBox .cctv-summary-unit').textContent = legacy ? '10초 모드' : '명';
  $('#totalHumanBox').classList.toggle('is-unknown', !known || legacy);
  $('#totalLevel').replaceChildren(el('span', { class: `level-badge ${total.level}`, text: LEVEL[total.level].label }));
  $('#activeCount').textContent = total.online_cameras;
  $('#cameraTotal').textContent = `/${total.cameras || 0}`;
  $('#refreshTime').textContent = `${timeText(state.now)} 갱신`;
  const th = state.thresholds;
  $('#criteria').textContent = legacy
    ? '기준: 현장 AI 판정 단계 (10초마다 갱신)'
    : `기준: ${th.free_max}명 이하 여유 · ${th.busy_min}명 이상 혼잡`;
  setMapLevel(total.level);
  applyMapStatus(state.map);
}

// 3초 넘게 새 값이 없으면 (서버·네트워크 장애) 화면 전체를 확인 불가로
function markAllUnknown() {
  if (!latest) return;
  const dead = {
    ...latest,
    map: { traffic: {} }, // 서버와 끊기면 도로도 회색
    total: { ...latest.total, count: null, level: 'unknown', online_cameras: 0 },
    cameras: latest.cameras.map((c) => ({
      ...c, online: false, count: null, level: 'unknown', has_frame: false,
      zones: c.zones.map((z) => ({ ...z, count: null, level: 'unknown' })),
    })),
  };
  latest = dead;
  renderSummary(dead);
  renderCameras(dead);
  $('#refreshTime').textContent = '서버 연결 끊김 · 다시 연결 중';
  updateModal();
}

// ---------- 확대 모달 ----------
let modalCam = null;
let modalMode = null; // 'stream' | 'snapshot' | 'placeholder' | null
let modalTimer = null;

function openModal(id) {
  modalCam = id;
  modalMode = null;
  $('#modal').classList.add('show');
  $('#modalClose').focus();
  updateModal();
}

function closeModal() {
  $('#modal').classList.remove('show');
  $('#modalImage').removeAttribute('src'); // MJPEG 연결 끊기
  clearInterval(modalTimer);
  modalCam = null;
  modalMode = null;
}

function setModalMode(mode, cam) {
  if (modalMode === mode) return;
  modalMode = mode;
  clearInterval(modalTimer);
  const img = $('#modalImage');
  img.onerror = null;
  if (mode === 'stream') {
    img.hidden = false;
    // 시청자 상한에 걸리면(503) 1초 스냅샷으로 대신 보여 준다
    img.onerror = () => setModalMode('snapshot', cam);
    const fps = latest?.stream?.modal_fps ?? 20;
    img.src = `stream/${encodeURIComponent(cam.id)}.mjpg?fps=${fps}&t=${Date.now()}`;
  } else if (mode === 'snapshot') {
    img.hidden = false;
    const load = () => (img.src = `snapshot/${encodeURIComponent(cam.id)}.jpg?t=${Date.now()}`);
    load();
    modalTimer = setInterval(load, SNAPSHOT_MS);
  } else {
    img.removeAttribute('src');
    img.hidden = true;
  }
}

function updateModal() {
  if (!modalCam || !latest) return;
  const cam = latest.cameras.find((c) => c.id === modalCam);
  if (!cam) return;
  const stage = $('#modalStage');
  const [w, h] = cam.frame_size;
  stage.style.aspectRatio = `${w} / ${h}`;
  stage.style.width = `min(100%, calc(80vh * ${w / h}))`;
  if (!cam.online) setModalMode(null, cam);
  else if (cam.has_frame) setModalMode(cam.legacy || modalMode === 'snapshot' ? 'snapshot' : 'stream', cam);
  else setModalMode('placeholder', cam);
  renderOverlay($('#modalOverlay'), cam, { mode: overlayMode(cam), note: placeholderNote(latest), scale: 0.8 });
  $('#modalDown').hidden = cam.online;
  const note = cam.legacy ? '10초마다 갱신되는 화면이에요'
    : modalMode === 'snapshot' ? '시청자가 많아 1초 간격 화면으로 보여 드리고 있어요' : 'ESC로 닫기';
  $('#modalInfo').replaceChildren(
    `${cam.name} · `,
    cam.online ? statusText(cam) : '확인 불가',
    el('br'),
    el('small', { text: `사람은 모두 흐림 처리됩니다 · ${note}` }),
  );
}

$('#modalClose').addEventListener('click', closeModal);
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
$('#openFirstCam').addEventListener('click', () => {
  const first = latest?.cameras[0];
  if (first) openModal(first.id);
});

// ---------- 오늘 추이 ----------
async function loadHourly() {
  try {
    const res = await fetch('api/hourly', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const box = $('#hourlyChart');
    box.className = '';
    box.style.minHeight = '';
    const nowHour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Asia/Seoul' }).format(new Date()));
    drawHourlyChart(box, data.hours, { thresholds: latest?.thresholds, nowHour });
  } catch (e) {
    $('#hourlyChart').textContent = `추이 불러오기 실패 · ${e.message}`;
  }
}

// ---------- 시작 ----------
subscribeState({
  onState(state) {
    const first = !latest;
    latest = state;
    renderSummary(state);
    renderCameras(state);
    updateModal();
    if (first) loadHourly();
  },
  onStale: markAllUnknown,
});
loadMap();
setInterval(loadHourly, HOURLY_MS);

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    loadHourly();
    if (latest) renderCameras(latest);
  }, 250);
});
