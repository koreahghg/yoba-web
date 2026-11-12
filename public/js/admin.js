// 어드민: 로그인 → 기준값(미리보기·저장) / 처리 상태 / 시간별 통계·CSV / 변경 기록.
import { $, LEVEL, drawHourlyChart, el, levelBadge, subscribeState, timeText } from './common.js';

// 서버 state.js의 levelOf와 같은 규칙
const levelOf = (count, t) => {
  if (count === null || count === undefined) return 'unknown';
  if (count <= t.free_max) return 'free';
  if (count >= t.busy_min) return 'busy';
  return 'normal';
};

const todayKst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

async function api(path, opts = {}) {
  const res = await fetch(`api/admin/${path}`, {
    ...opts,
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== 'login') showLogin();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

let live = null; // 실시간 상태 (WebSocket)
let saved = null; // 서버에 저장된 설정
let zones = [];
let started = false;

// ---------- 로그인 ----------
function showLogin() {
  $('#adminView').hidden = true;
  $('#logoutBtn').hidden = true;
  $('#loginView').hidden = false;
  $('#password').focus();
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#loginError').textContent = '';
  try {
    await api('login', { method: 'POST', body: { password: $('#password').value } });
    $('#password').value = '';
    start();
  } catch (err) {
    $('#loginError').textContent = err.message;
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  await api('logout', { method: 'POST', body: {} }).catch(() => {});
  location.reload();
});

// ---------- 기준값 ----------
const readForm = () => ({ free_max: Number($('#freeMax').value), busy_min: Number($('#busyMin').value) });

function formError(t) {
  if (!Number.isInteger(t.free_max) || !Number.isInteger(t.busy_min) || t.free_max < 0 || t.busy_min < 0) return '0 이상의 정수를 입력해 주세요.';
  if (t.free_max >= t.busy_min) return '"여유" 기준은 "혼잡" 기준보다 작아야 합니다.';
  return '';
}

function renderScale() {
  const t = readForm();
  const err = formError(t);
  $('#thError').textContent = err;
  $('#saveBtn').disabled = Boolean(err);
  const count = live?.total.level !== 'unknown' ? live?.total.count : null;
  const max = Math.max(t.busy_min * 1.4, (count ?? 0) * 1.1, 10);
  const pos = (v) => `${Math.min(100, (v / max) * 100)}%`;
  const [a, b, c] = $('#scaleBar').children;
  if (!err) {
    a.style.flexGrow = t.free_max + 0.5;
    b.style.flexGrow = Math.max(0, t.busy_min - t.free_max - 1);
    c.style.flexGrow = max - t.busy_min + 0.5;
  }
  $('#scaleLabels').replaceChildren(
    el('span', { style: `left:0;transform:none`, text: '0명' }),
    err ? '' : el('span', { style: `left:${pos(t.free_max + 0.5)}`, text: `${t.free_max}` }),
    err ? '' : el('span', { style: `left:${pos(t.busy_min)}`, text: `${t.busy_min}` }),
  );
  $('#scaleNow').replaceChildren(count === null || count === undefined ? '' : el('span', { style: `left:${pos(count)}`, text: `지금 ${count}명` }));

  // 미리보기: 지금 인원 기준으로 바꾸기 전/후 단계
  const box = $('#preview');
  if (live?.mode === 'legacy') {
    box.replaceChildren('지금은 YOBA 10초 모드라 사람 수가 오지 않아요. 방문객 화면은 YOBA가 판정한 단계를 그대로 씁니다. 이 기준은 실시간 모드로 돌아오면 적용됩니다.');
    return;
  }
  if (count === null || count === undefined) {
    box.replaceChildren('현재 CCTV 값을 받지 못해 미리보기를 할 수 없습니다.');
    return;
  }
  const before = levelOf(count, saved.total);
  const after = err ? null : levelOf(count, t);
  const changed = JSON.stringify(t) !== JSON.stringify(saved.total);
  box.replaceChildren(
    `현재 ${count}명 기준이면 `,
    levelBadge(before, true),
    ...(changed && after ? [el('span', { class: 'arrow', text: '→' }), levelBadge(after, true), before === after ? ' (단계 변화 없음)' : ' 으로 바뀝니다'] : [' (지금 저장된 기준)']),
  );
}

function fillForm() {
  $('#freeMax').value = saved.total.free_max;
  $('#busyMin').value = saved.total.busy_min;
  $('#zoneThBox').hidden = zones.length === 0;
  $('#zoneThList').replaceChildren(
    ...zones.map((z) => {
      const t = saved.zones[z.id] || {};
      return el('div', { class: 'zone-th-row' },
        el('span', { text: `${z.name} (${z.id})` }),
        el('input', { class: 'input', type: 'number', min: 0, step: 1, 'data-zone': z.id, 'data-k': 'free_max', value: t.free_max ?? '', placeholder: '여유≤', 'aria-label': `${z.name} 여유 기준` }),
        el('input', { class: 'input', type: 'number', min: 0, step: 1, 'data-zone': z.id, 'data-k': 'busy_min', value: t.busy_min ?? '', placeholder: '혼잡≥', 'aria-label': `${z.name} 혼잡 기준` }),
        el('span', { class: 'hint', text: '명' }),
      );
    }),
  );
  renderScale();
}

function readZoneForm() {
  const out = {};
  for (const z of zones) {
    const f = $(`input[data-zone="${z.id}"][data-k="free_max"]`).value;
    const b = $(`input[data-zone="${z.id}"][data-k="busy_min"]`).value;
    if (f === '' && b === '') continue;
    out[z.id] = { free_max: Number(f), busy_min: Number(b) };
  }
  return out;
}

async function loadSettings() {
  const data = await api('settings');
  saved = data.settings;
  zones = data.zones;
  fillForm();
}

$('#thForm').addEventListener('input', () => {
  $('#thOk').textContent = '';
  renderScale();
});
$('#resetBtn').addEventListener('click', fillForm);
$('#thForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const total = readForm();
  if (formError(total)) return;
  const prevLevel = live ? levelOf(live.total.count, saved.total) : null;
  const nextLevel = live ? levelOf(live.total.count, total) : null;
  if (prevLevel && nextLevel && prevLevel !== nextLevel && live.total.level !== 'unknown') {
    if (!confirm(`저장하면 방문객 화면이 지금 바로 "${LEVEL[prevLevel].label}" → "${LEVEL[nextLevel].label}"(으)로 바뀝니다. 저장할까요?`)) return;
  }
  $('#saveBtn').disabled = true;
  try {
    const res = await api('settings', { method: 'PUT', body: { total, zones: readZoneForm() } });
    saved = res.settings;
    $('#thOk').textContent = `저장됨 · ${timeText(Date.now())}`;
    renderScale();
    loadLog();
    loadStats();
  } catch (err) {
    $('#thError').textContent = err.message;
  } finally {
    $('#saveBtn').disabled = false;
  }
});

// ---------- 실시간 KPI ----------
function renderKpi() {
  if (!live) return;
  const { total } = live;
  const known = total.level !== 'unknown';
  const legacy = live.mode === 'legacy';
  $('#kCount').replaceChildren(known && !legacy ? String(total.count) : '-', el('small', { text: '명' }));
  $('#kCountSub').textContent = legacy ? '10초 모드 · 사람 수 없음' : '스무딩 값';
  $('#kLevel').replaceChildren(levelBadge(total.level));
  $('#kLevelSub').textContent = legacy
    ? 'YOBA 10초 모드 판정 단계 그대로'
    : `기준 ${live.thresholds.free_max}명 이하 여유 · ${live.thresholds.busy_min}명 이상 혼잡`;
  $('#kCctv').textContent = `${total.online_cameras} / ${total.cameras}`;
  $('#kCctvSub').textContent = total.cameras === 0 ? 'YOBA에서 카메라 정보를 아직 받지 못함' : total.online_cameras === total.cameras ? '모두 정상 수신' : '끊긴 카메라 있음 · 방문객 화면 "확인 불가"';
}

// ---------- 처리 상태 ----------
const row = (k, v, cls) => el('div', { class: 'status-item' }, el('span', { class: 'k', text: k }), el('span', {}, cls ? el('i', { class: `dot ${cls}` }) : '', v));
const ageText = (ms) => (ms === null ? '-' : ms < 1000 ? '방금' : ms < 60_000 ? `${(ms / 1000).toFixed(1)}초 전` : `${Math.floor(ms / 60000)}분 전`);

async function loadStatus() {
  try {
    const s = await api('status');
    $('#kBlur').replaceChildren(String(s.blur_fail_today), el('small', { text: '회' }));
    const items = [
      row('데이터 소스', s.source === 'demo' ? '데모 (가짜 데이터)' : `Redis · ${s.redis.status}`, s.redis.ok ? 'ok' : 'bad'),
    ];
    if (s.redis.error) items.push(row('Redis 오류', s.redis.error, 'bad'));
    if (s.cameras.length === 0) items.push(row('카메라', 'YOBA가 아직 값을 보내지 않음', 'warn'));
    for (const c of s.cameras) {
      const legacy = c.mode === 'legacy';
      items.push(el('div', { class: 'status-item', style: 'border-bottom:0;padding-bottom:0' },
        el('b', { text: `${legacy ? '10초 모드' : '실시간'} · ${c.name} (${c.id})` }), el('span')));
      const staleSec = (legacy ? s.legacy_stale_ms : s.stale_ms) / 1000;
      items.push(row('연결', c.online ? '정상' : legacy && c.yoba_status === 'error' ? 'YOBA가 장애 기록 (카메라·캡처 문제)' : `끊김 (${staleSec}초 이상 갱신 없음)`, c.online ? 'ok' : 'bad'));
      if (legacy) {
        items.push(row('YOBA 판정 단계', c.level ? `${{ free: '여유', normal: '보통', busy: '혼잡' }[c.level]} (점수 ${c.score ?? '-'})` : '-'));
        items.push(row('신뢰도', c.confidence ?? '-', c.confidence === 'low' ? 'warn' : c.confidence ? 'ok' : null));
        items.push(row('마지막 갱신', c.last_received_at ? `${timeText(c.last_received_at)} (${ageText(c.age_ms)})` : '-'));
        items.push(row('이미지', c.has_frame ? '수신 중' : '없음', c.has_frame ? 'ok' : 'warn'));
        continue;
      }
      items.push(row('처리 fps', c.fps === null ? '-' : `${c.fps} fps`, c.fps === null ? null : c.fps >= 3 ? 'ok' : 'warn'));
      items.push(row('지연 시간 (캡처→전송)', c.latency_ms === null ? '-' : `${c.latency_ms} ms`, c.latency_ms === null ? null : c.latency_ms < 1000 ? 'ok' : 'warn'));
      items.push(row('마지막 프레임 수신', c.last_received_at ? `${timeText(c.last_received_at)} (${ageText(c.age_ms)})` : '-'));
      items.push(row('영상 프레임', c.has_frame ? '수신 중' : '없음', c.has_frame ? 'ok' : s.source === 'demo' ? null : 'warn'));
      items.push(row('블러 검증', c.blur_ok === false ? '실패 중 → 검은 화면 송출' : c.blur_ok ? '통과' : '-', c.blur_ok === false ? 'bad' : c.blur_ok ? 'ok' : null));
      items.push(row('블러 실패 (오늘 / YOBA 누적)', `${c.blur_fail_today} / ${c.blur_fail_total ?? '-'}`));
      items.push(row('인원 (원본 → 스무딩)', c.raw_count === null ? '-' : `${c.raw_count} → ${c.smooth_count}`));
    }
    items.push(row('방문객 실시간 접속', `${s.ws_clients}명`));
    items.push(row('실시간 영상 연결 (메인+확대)', `${s.stream_clients} / ${s.stream_max_clients}`));
    $('#statusList').replaceChildren(...items);
    $('#demoNote').hidden = s.source !== 'demo';
  } catch { /* 401이면 api()가 로그인 화면으로 */ }
}

// ---------- 통계 ----------
async function loadStats() {
  const date = $('#statDate').value || todayKst();
  try {
    const s = await api(`stats?date=${date}`);
    drawHourlyChart($('#statChart'), s.hours, { showMax: true, thresholds: saved?.total, height: 190 });
    const peak = s.hours.reduce((best, h) => (h.max !== null && (best === null || h.max > best.max) ? h : best), null);
    $('#statBody').replaceChildren(
      ...s.hours.map((h) => {
        const has = h.samples > 0;
        const tr = el('tr', { class: peak && h.hour === peak.hour ? 'peak' : '' },
          el('td', { text: `${String(h.hour).padStart(2, '0')}:00 ~ ${String(h.hour + 1).padStart(2, '0')}:00` }),
          el('td', { text: h.avg === null ? '-' : `${h.avg}명` }),
          el('td', { text: h.max === null ? '-' : `${h.max}명` }),
          el('td', { text: h.peak_at ? timeText(h.peak_at) : '-' }),
          el('td', { text: has ? `${((h.online_samples / h.samples) * 100).toFixed(0)}%` : '-' }),
          el('td', { text: has ? String(h.blur_fail) : '-' }),
        );
        if (!has) tr.querySelectorAll('td').forEach((td) => td.classList.add('dim'));
        return tr;
      }),
    );
  } catch (e) {
    $('#statChart').textContent = e.message;
  }
}
$('#statDate').addEventListener('change', loadStats);
const csv = (unit) => (location.href = `api/admin/export.csv?date=${$('#statDate').value || todayKst()}&unit=${unit}`);
$('#csvHour').addEventListener('click', () => csv('hour'));
$('#csvMinute').addEventListener('click', () => csv('minute'));

// ---------- 지도 (도로) ----------
const TRAFFIC_OPTS = [['auto', '자동'], ['free', '원활'], ['busy', '서행'], ['jam', '정체'], ['unknown', '확인중']];
const TRAFFIC_LABEL = Object.fromEntries(TRAFFIC_OPTS);
let mapDetail = null;
const nameOf = (id) => mapDetail?.traffic.find((t) => t.id === id)?.name ?? id;

function seg(opts, current, onPick, label) {
  return el('div', { class: 'seg', role: 'group', 'aria-label': label },
    ...opts.map(([v, text]) => el('button', {
      type: 'button', class: v, 'aria-pressed': String(v === current), text,
      onclick: () => v !== current && onPick(v),
    })));
}

async function putMap(body) {
  $('#mapError').textContent = '';
  try {
    mapDetail = await api('map', { method: 'PUT', body });
    renderMap();
    loadLog();
  } catch (e) {
    $('#mapError').textContent = e.message;
  }
}

function renderMap() {
  if (!mapDetail) return;
  const its = mapDetail.its;
  $('#itsStatus').textContent = !its.enabled
    ? '자동 수집 꺼짐 (ITS_API_KEY 없음) · 직접 눌러서 정해 주세요. "자동"은 확인중으로 보입니다.'
    : its.fresh
      ? `ITS 자동 수집 중 · ${timeText(its.last_ok_at, false)} 갱신 · 링크 ${its.links}개`
      : `ITS 수신 안 됨${its.error ? ` (${its.error})` : ''} · "자동" 구간은 확인중으로 보입니다.`;
  $('#trafficRows').replaceChildren(...mapDetail.traffic.map((t) => {
    const autoText = !t.linked ? 'ITS 링크 미연결'
      : t.speed === null ? '자동값 없음' : `자동: ${t.speed}km/h → ${TRAFFIC_LABEL[t.auto_status]}`;
    return el('div', { class: 'map-row' },
      el('span', {}, t.name, el('small', { text: `${autoText} · 지금 ${TRAFFIC_LABEL[t.status]}` })),
      seg(TRAFFIC_OPTS, t.mode, (v) => putMap({ traffic: { [t.id]: v } }), `${t.name} 도로 상태`),
    );
  }));
}

async function loadMap() {
  try {
    mapDetail = await api('map');
    renderMap();
  } catch { /* 401이면 api()가 처리 */ }
}

// ---------- 변경 기록 ----------
async function loadLog() {
  try {
    const { log } = await api('log');
    $('#logList').replaceChildren(
      ...(log.length ? log : [null]).map((r) => {
        if (!r) return el('div', { text: '아직 변경 기록이 없습니다.' });
        if (r.action === 'map') {
          const parts = Object.entries(r.detail?.traffic ?? {}).map(([id, s]) => `${nameOf(id)} ${TRAFFIC_LABEL[s] ?? s}`);
          return el('div', {}, el('b', { text: new Date(r.ts).toLocaleString('ko-KR') }), ' · 도로 ', el('b', { text: parts.join(', ') || '-' }));
        }
        const a = r.detail?.after?.total;
        const b = r.detail?.before?.total;
        return el('div', {},
          el('b', { text: new Date(r.ts).toLocaleString('ko-KR') }), ' · 혼잡도 기준 ',
          b ? `${b.free_max}/${b.busy_min}` : '-', ' → ', el('b', { text: a ? `${a.free_max}/${a.busy_min}` : '-' }), ' (여유 이하/혼잡 이상)');
      }),
    );
  } catch { /* 무시 */ }
}

$('#outageBtn').addEventListener('click', () => api('demo/outage', { method: 'POST', body: { seconds: 8 } }));

// ---------- 시작 ----------
async function start() {
  $('#loginView').hidden = true;
  $('#adminView').hidden = false;
  $('#logoutBtn').hidden = false;
  $('#statDate').value = todayKst();
  await loadSettings();
  loadStatus();
  loadStats();
  await loadMap();
  loadLog();
  if (started) return;
  started = true;
  setInterval(loadStatus, 1000);
  setInterval(loadMap, 30_000); // 다른 관리자가 바꾼 값·ITS 자동값 반영
  setInterval(loadStats, 60_000);
  subscribeState({
    onState(s) {
      live = s;
      renderKpi();
      if (saved) renderScale(); // 입력값은 건드리지 않고 미리보기만 다시 그림
    },
    onStale() {
      if (live) live = { ...live, total: { ...live.total, level: 'unknown', count: null, online_cameras: 0 } };
      renderKpi();
      if (saved) renderScale();
    },
  });
}

(async () => {
  const me = await api('me').catch(() => ({ authed: false }));
  if (me.authed) start();
  else showLogin();
})();

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => started && loadStats(), 250);
});
