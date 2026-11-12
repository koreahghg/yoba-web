// 공개 화면과 어드민이 같이 쓰는 코드.

export const LEVEL = {
  free: { label: '여유', color: 'var(--free)', hex: '#35b86b' },
  normal: { label: '보통', color: 'var(--normal)', hex: '#f5a623' },
  busy: { label: '혼잡', color: 'var(--busy)', hex: '#e54b4b' },
  unknown: { label: '확인 불가', color: 'var(--unknown)', hex: '#77828c' },
};

export const STALE_MS = 3000;
const SVG_NS = 'http://www.w3.org/2000/svg';

export const $ = (sel, root = document) => root.querySelector(sel);
export const el = (tag, attrs = {}, ...children) => {
  const node = tag.startsWith('svg:') ? document.createElementNS(SVG_NS, tag.slice(4)) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.setAttribute('class', v);
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) node.append(c);
  return node;
};

export const timeText = (ms, withSec = true) =>
  ms ? new Date(ms).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', ...(withSec ? { second: '2-digit' } : {}) }) : '-';

export function levelBadge(level, small = false) {
  const meta = LEVEL[level] || LEVEL.unknown;
  return el('span', { class: `level-badge ${level}${small ? ' sm' : ''}`, text: meta.label });
}

/**
 * 실시간 상태 구독. WebSocket이 끊기면 다시 연결하고, 그동안 3초 넘게 새 값이 없으면
 * onStale을 불러 화면을 "확인 불가"로 바꾼다 (카메라가 꺼졌는데 "여유"로 보이지 않도록).
 */
export function subscribeState({ onState, onStale }) {
  let ws = null;
  let lastAt = 0;
  let stale = true;
  let retry = 0;

  const connect = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => (retry = 0);
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type !== 'state') return;
        lastAt = Date.now();
        stale = false;
        onState(msg);
      } catch { /* 무시 */ }
    };
    ws.onclose = () => {
      retry += 1;
      setTimeout(connect, Math.min(1000 * retry, 5000));
    };
    ws.onerror = () => ws.close();
  };
  connect();

  setInterval(() => {
    if (!stale && Date.now() - lastAt > STALE_MS) {
      stale = true;
      onStale?.();
    }
  }, 500);
}

// ---------- CCTV 오버레이 ----------

function seeded(seed) {
  let s = 0;
  for (const ch of seed) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function inside([x, y], poly) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function centroid(poly) {
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}

/**
 * CCTV 칸 위 SVG.
 * - mode 'video'      : 실제 영상이 있음 → 아무것도 겹치지 않음 (CCTV 화면만)
 * - mode 'placeholder': 숫자만 오고 영상이 없음 → 바닥 + 구역 테두리 + 사람 수만큼 점 + note 문구
 * - mode 'offline'    : 끊김 → 회색 점선 구역만 (위에 "확인 불가" 문구는 HTML이 띄움)
 */
export function renderOverlay(svg, cam, { mode = 'video', note = '', scale = 1 } = {}) {
  const [w, h] = cam.frame_size;
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.replaceChildren();
  if (mode === 'video') return;
  const placeholder = mode === 'placeholder';
  if (placeholder) {
    svg.append(el('svg:rect', { class: 'demo-floor', x: 0, y: 0, width: w, height: h }));
    if (note) svg.append(el('svg:text', { x: w - 14, y: h - 30, 'text-anchor': 'end', fill: '#6c7782', 'font-size': Math.round(w / 44), 'font-weight': 800, text: note }));
  }
  for (const z of cam.zones) {
    if (!z.roi?.length) continue;
    if (placeholder && z.count) {
      const rnd = seeded(z.id);
      const xs = z.roi.map((p) => p[0]);
      const ys = z.roi.map((p) => p[1]);
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      let placed = 0;
      for (let tries = 0; placed < z.count && tries < z.count * 30; tries++) {
        const p = [x0 + rnd() * (x1 - x0), y0 + rnd() * (y1 - y0)];
        if (!inside(p, z.roi)) continue;
        svg.append(el('svg:circle', { class: 'demo-person', cx: p[0], cy: p[1], r: 6 + (p[1] / h) * 6 }));
        placed++;
      }
    }
    svg.append(el('svg:polygon', { class: `zone-poly ${z.level}`, points: z.roi.map((p) => p.join(',')).join(' ') }));
    const [cx, cy] = centroid(z.roi);
    // 화면에서 최소 11px로 보이게 (모바일 축소 화면에서도 읽히도록)
    const shown = svg.clientWidth || w;
    const fs = Math.round(Math.max((w / 56) * scale, (11 * w) / shown));
    const text = `${z.name} ${z.count === null ? '-' : z.count}명`;
    const bw = text.length * fs * 0.78 + fs;
    svg.append(
      el('svg:g', { class: 'zone-label' },
        el('svg:rect', { x: cx - bw / 2, y: cy - fs * 0.9, width: bw, height: fs * 1.6, rx: fs * 0.3 }),
        el('svg:circle', { cx: cx - bw / 2 + fs * 0.55, cy: cy - fs * 0.1, r: fs * 0.25, fill: LEVEL[z.level]?.hex }),
        el('svg:text', { x: cx + fs * 0.25, y: cy + fs * 0.25, 'text-anchor': 'middle', 'font-size': fs, text }),
      ),
    );
  }
}

// ---------- 시간대별 막대 그래프 (단일 계열: 평균 동시 인원) ----------

/**
 * hours: [{hour, avg, max}] 24개. opts.showMax면 최대 인원을 짧은 가로선으로 표시.
 * thresholds가 있으면 여유/혼잡 구간을 아주 옅게 깐다.
 */
export function drawHourlyChart(container, hours, { showMax = false, thresholds = null, nowHour = null, height = 150 } = {}) {
  // 그리는 폭 = 실제 표시 폭 → 모바일에서도 글자가 11px 그대로
  const W = Math.max(300, Math.round(container.clientWidth || 720));
  const H = height;
  const labelEvery = W < 520 ? 6 : 3;
  const pad = { l: 30, r: 6, t: 10, b: 20 };
  const vals = hours.flatMap((h) => [h.avg ?? 0, showMax ? h.max ?? 0 : 0]);
  const top = Math.max(4, ...vals, thresholds ? thresholds.busy_min * 1.1 : 0);
  // 눈금 4칸이 1·2·5 × 10^k 단위로 떨어지게
  const rawStep = top / 4;
  const mag = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rawStep);
  const niceTop = step * 4;
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / niceTop);
  const colW = (W - pad.l - pad.r) / 24;
  const svg = el('svg:svg', { class: 'chart-svg', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': '시간대별 평균 동시 인원 막대 그래프' });

  if (thresholds) {
    const bands = [
      ['free', 0, Math.min(thresholds.free_max, niceTop)],
      ['busy', Math.min(thresholds.busy_min, niceTop), niceTop],
    ];
    for (const [lv, a, b] of bands) {
      if (b <= a) continue;
      svg.append(el('svg:rect', { class: 'band', x: pad.l, width: W - pad.l - pad.r, y: y(b), height: y(a) - y(b), fill: LEVEL[lv].hex }));
    }
  }
  for (let i = 0; i <= 4; i++) {
    const v = (niceTop / 4) * i;
    svg.append(el('svg:line', { class: 'grid', x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v) }));
    svg.append(el('svg:text', { class: 'axis-label', x: pad.l - 5, y: y(v) + 3, 'text-anchor': 'end', text: Math.round(v) }));
  }

  const tip = el('div', { class: 'chart-tooltip', hidden: true });
  for (const h of hours) {
    const x = pad.l + h.hour * colW;
    const bw = Math.max(3, colW - Math.min(6, colW * 0.25));
    const g = el('svg:g', { class: 'col' });
    if (h.avg !== null && h.avg !== undefined) {
      const yy = y(h.avg);
      const hh = Math.max(0, y(0) - yy);
      // 위쪽만 4px 둥글게, 아래는 기준선에 붙임
      const r = Math.min(4, hh, bw / 2);
      const x0 = x + (colW - bw) / 2;
      const d = `M${x0},${y(0)} V${yy + r} Q${x0},${yy} ${x0 + r},${yy} H${x0 + bw - r} Q${x0 + bw},${yy} ${x0 + bw},${yy + r} V${y(0)} Z`;
      g.append(el('svg:path', { class: `bar${h.hour === nowHour ? ' now' : ''}`, d }));
      if (showMax && h.max !== null) {
        g.append(el('svg:line', { class: 'max-tick', x1: x0 - 1, x2: x0 + bw + 1, y1: y(h.max), y2: y(h.max) }));
      }
    }
    const hit = el('svg:rect', { class: 'hit', x, y: pad.t, width: colW, height: H - pad.t - pad.b });
    hit.addEventListener('mouseenter', () => {
      const sx = svg.getBoundingClientRect().width / W;
      tip.hidden = false;
      tip.innerHTML = '';
      tip.append(
        el('div', { text: `${String(h.hour).padStart(2, '0')}:00 ~ ${String(h.hour + 1).padStart(2, '0')}:00` }),
        h.avg === null || h.avg === undefined
          ? el('div', { text: '기록 없음' })
          : el('div', {}, '평균 ', el('b', { text: `${h.avg}명` }), showMax && h.max !== null ? ` · 최대 ${h.max}명` : ''),
      );
      tip.style.left = `${(x + colW / 2) * sx}px`;
      tip.style.top = `${y(Math.max(h.avg ?? 0, showMax ? h.max ?? 0 : 0)) * sx}px`;
    });
    hit.addEventListener('mouseleave', () => (tip.hidden = true));
    g.append(hit);
    svg.append(g);
    if (h.hour % labelEvery === 0) {
      svg.append(el('svg:text', { class: 'axis-label', x: x + colW / 2, y: H - 5, 'text-anchor': 'middle', text: `${h.hour}시` }));
    }
  }
  svg.append(el('svg:line', { class: 'grid', x1: pad.l, x2: W - pad.r, y1: y(0), y2: y(0), stroke: '#b9c4cd' }));
  container.replaceChildren(el('div', { class: 'chart-wrap' }, svg, tip));
}
