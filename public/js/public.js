// 방문객 화면: 지도 혼잡도 링 + CCTV 요약/타일 + 확대 모달 + 오늘 추이.
import { $, LEVEL, drawHourlyChart, el, renderOverlay, subscribeState, timeText } from './common.js';

const SNAPSHOT_MS = 1000; // 축소 화면은 1초마다 최신 1장 (MJPEG는 확대 화면에서만)
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
    // 주차·교통 데이터는 아직 연결 전 → 임의의 색 대신 회색(확인 중)으로 둔다
    svg.querySelectorAll('.parking-status').forEach((c) => {
      c.classList.remove('status-free', 'status-busy', 'status-full');
      c.classList.add('status-unknown');
    });
    svg.querySelectorAll('.traffic-segment').forEach((p) => p.classList.add('traffic-unknown'));
    if (latest) setMapLevel(latest.total.level);
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
  if (badge) badge.setAttribute('fill', meta.hex);
  if (text) text.textContent = level === 'unknown' ? '확인불가' : meta.label;
}

// ---------- CCTV 타일 ----------
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
  const t = { tile, img, overlay, name, count, time, down, loading: false };
  tiles.set(cam.id, t);
  return t;
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
  if (state.cameras.length === 0 && tiles.size === 0) {
    grid.replaceChildren(el('div', { class: 'camera-tile unknown', style: 'cursor:default' },
      el('div', { class: 'camera-down' }, el('div', {}, '확인 불가', el('small', { text: 'CCTV가 아직 연결되지 않았습니다' })))));
    return;
  }
  if (tiles.size === 0) grid.replaceChildren();
  for (const cam of state.cameras) {
    const t = tiles.get(cam.id) || createTile(cam);
    t.tile.className = `camera-tile ${cam.level}`;
    t.tile.setAttribute('aria-label', `${cam.name} CCTV, ${cam.online ? `현재 ${cam.count}명, ${LEVEL[cam.level].label}` : '확인 불가'}. 눌러서 크게 보기`);
    t.tile.style.aspectRatio = `${cam.frame_size[0]} / ${cam.frame_size[1]}`;
    t.name.textContent = cam.name;
    t.count.textContent = cam.online ? `사람 ${cam.count}명 · ${LEVEL[cam.level].label}` : '확인 불가';
    t.time.textContent = cam.online ? (cam.status === 'blur_fail' ? '보호 처리 중 · 화면 가림' : '실시간') : '신호 없음';
    t.down.hidden = cam.online;
    const demo = state.source === 'demo' && !cam.has_frame;
    t.img.hidden = !cam.has_frame;
    renderOverlay(t.overlay, cam, { demo });
  }
}

setInterval(() => {
  if (!latest) return;
  for (const cam of latest.cameras) {
    const t = tiles.get(cam.id);
    if (t && cam.has_frame) refreshSnapshot(t, cam.id);
  }
}, SNAPSHOT_MS);

// ---------- 요약 ----------
function renderSummary(state) {
  const { total } = state;
  const known = total.level !== 'unknown';
  $('#totalHuman').textContent = known ? total.count : '-';
  $('#totalHumanBox').classList.toggle('is-unknown', !known);
  $('#totalLevel').replaceChildren(el('span', { class: `level-badge ${total.level}`, text: LEVEL[total.level].label }));
  $('#activeCount').textContent = total.online_cameras;
  $('#cameraTotal').textContent = `/${total.cameras || 0}`;
  $('#refreshTime').textContent = `${timeText(state.now)} 갱신`;
  const th = state.thresholds;
  $('#criteria').textContent = `기준: ${th.free_max}명 이하 여유 · ${th.busy_min}명 이상 혼잡`;
  setMapLevel(total.level);
}

// 3초 넘게 새 값이 없으면 (서버·네트워크 장애) 화면 전체를 확인 불가로
function markAllUnknown() {
  if (!latest) return;
  const dead = {
    ...latest,
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
let modalMode = null; // 'stream' | 'snapshot' | 'demo' | null
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
    img.src = `stream/${encodeURIComponent(cam.id)}.mjpg?t=${Date.now()}`;
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
  else if (cam.has_frame) setModalMode(modalMode === 'snapshot' ? 'snapshot' : 'stream', cam);
  else setModalMode('demo', cam);
  renderOverlay($('#modalOverlay'), cam, { demo: modalMode === 'demo', scale: 0.8 });
  $('#modalDown').hidden = cam.online;
  $('#modalInfo').replaceChildren(
    `${cam.name} · `,
    cam.online ? `사람 ${cam.count}명 · ${LEVEL[cam.level].label}` : '확인 불가',
    el('br'),
    el('small', { text: modalMode === 'snapshot' ? '시청자가 많아 1초 간격 화면으로 보여 드리고 있어요 · 사람은 모두 흐림 처리됩니다' : '사람은 모두 흐림 처리됩니다 · ESC로 닫기' }),
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
