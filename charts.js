// charts.js: draws the charts, in plain SVG and HTML (no chart library).
//
// Each function receives a container element and the rows a query returned, empties the container and
// draws into it. Colours come from the show's own palette (style.css): cold blue -> purple -> hot red,
// like the "gélido / semifrio / quente" scale on the programme, and one colour per person.
//
// Any text that comes from the data (names, context words) is inserted with textContent, never as HTML,
// so odd characters in a transcript can't break the page.

import { t, num } from './i18n.js';

// ---- Palette: the programme's temperature scale ---------------------------------------------------
const STOPS = [[0x1d, 0x8f, 0xff], [0x8a, 0x4b, 0xb5], [0xff, 0x5a, 0x4f]]; // gélido, semifrio, quente
// t in 0..1 -> "rgb(r,g,b)" along the scale.
export function tempColor(t) {
  const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(x)), k = x - i;
  const c = STOPS[i].map((v, j) => Math.round(v + (STOPS[i + 1][j] - v) * k));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// "47:47" from 2867 seconds (and "1:02:05" past the hour).
export function clock(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return `${h ? h + ':' + String(m).padStart(2, '0') : m}:${String(r).padStart(2, '0')}`;
}

// ---- Small DOM helpers -----------------------------------------------------------------------------
const SVG_NS = 'http://www.w3.org/2000/svg';
export function el(tag, attrs = {}, parent = null, text = null) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (k === 'class') node.className = v; else node.setAttribute(k, v); }
  if (text !== null) node.textContent = text;
  if (parent) parent.appendChild(node);
  return node;
}
export function svgEl(tag, attrs = {}, parent = null, text = null) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== null) node.textContent = text;
  if (parent) parent.appendChild(node);
  return node;
}
const width = (box, fallback = 720) => Math.max(280, Math.floor(box.clientWidth || fallback));
const initials = name => name.split(/\s+/).filter(w => w.length > 2).map(w => w[0]).slice(0, 2).join('');

// ---- Tooltip (one element, moved around) -----------------------------------------------------------
const tip = () => document.getElementById('tooltip');
export function showTooltip(evt, lines) {
  const t = tip();
  t.replaceChildren(...lines.map(l => el('div', { class: l.cls || '' }, null, l.text)));
  t.style.display = 'block';
  const r = t.getBoundingClientRect();
  const x = Math.min(evt.clientX + 14, window.innerWidth - r.width - 8);
  const y = evt.clientY + 18 + r.height > window.innerHeight ? evt.clientY - r.height - 12 : evt.clientY + 18;
  t.style.left = `${Math.max(4, x)}px`;
  t.style.top = `${Math.max(4, y)}px`;
}
export function hideTooltip() { tip().style.display = 'none'; }
function hover(node, linesFor) {
  node.addEventListener('mousemove', e => showTooltip(e, linesFor()));
  node.addEventListener('mouseleave', hideTooltip);
  node.addEventListener('click', hideTooltip);   // a click often scrolls away: the mouse never "leaves"
}
// Scrolling moves things under a still mouse without a mouseleave, so the tooltip would stay: hide it.
window.addEventListener('scroll', () => hideTooltip(), { passive: true });

// ---- A person's portrait (round, with a ring in their colour), or initials when there is no photo ----
export function avatarSvg(parent, person, cx, cy, r, uid) {
  const g = svgEl('g', {}, parent);
  svgEl('circle', { cx, cy, r: r + 2, fill: 'none', stroke: person.color, 'stroke-width': 2 }, g);
  if (person.photo) {
    const id = `clip-${uid}-${person.key}`;
    const clip = svgEl('clipPath', { id }, g);
    svgEl('circle', { cx, cy, r }, clip);
    svgEl('image', { href: `assets/people/${person.photo}`, x: cx - r, y: cy - r, width: 2 * r, height: 2 * r,
      'clip-path': `url(#${id})`, preserveAspectRatio: 'xMidYMin slice' }, g);
  } else {
    svgEl('circle', { cx, cy, r, fill: '#17236b' }, g);
    svgEl('text', { x: cx, y: cy + r * 0.28, 'text-anchor': 'middle', 'font-size': r * 0.8, 'font-weight': 700,
      fill: person.color }, g, initials(person.name));
  }
  return g;
}
// The same portrait as an HTML element (table headers, legends).
export function avatarHtml(parent, person, size = 30) {
  const box = el('span', { class: 'avatar', style: `width:${size}px;height:${size}px;border-color:${person.color}` }, parent);
  if (person.photo) {
    const img = el('img', { src: `assets/people/${person.photo}`, alt: '', loading: 'lazy' }, box);
    img.style.objectPosition = '50% 0%';
  } else {
    box.textContent = initials(person.name);
    box.style.color = person.color;
    box.style.fontSize = `${size * 0.4}px`;
  }
  return box;
}

// ---- 1. The temperature scale: each episode placed on gélido -> quente ----------------------------------
export function drawTempScale(box, rows, opts) {
  box.replaceChildren();
  const max = Math.max(5, Math.ceil(Math.max(...rows.map(r => r[opts.key])) / 5) * 5);
  const wrap = el('div', { class: 'scale' }, box);
  const bar = el('div', { class: 'scale-bar' }, wrap);
  const sorted = [...rows].sort((a, b) => a[opts.key] - b[opts.key]);
  sorted.forEach((r, i) => {
    const pos = (r[opts.key] / max) * 100;
    const m = el('div', { class: `scale-mark lvl${i % 2}`, style: `left:${pos}%` }, bar);
    el('span', { class: 'dot', style: `background:${tempColor(r[opts.key] / max)}` }, m);
    el('span', { class: 'lab' }, m, t('ep', { n: r.episode }));
    hover(m, () => opts.tooltip(r));
  });
  const ends = el('div', { class: 'scale-ends' }, wrap);
  el('span', {}, ends, 'GÉLIDO');
  el('span', {}, ends, 'SEMIFRIO');
  el('span', {}, ends, 'QUENTE');
  el('div', { class: 'small scale-note' }, wrap, `0 → ${max} ${opts.caption}`);
}

// ---- 2. Episode bars: the evolution across episodes (stacked: between panelists + with the moderator) ----
// opts.keyPanel / opts.keyMod: the two values stacked; the colour of the lower part follows the temperature scale.
export function drawEpisodeBars(box, rows, opts) {
  box.replaceChildren();
  const W = width(box), H = 270, m = { t: 26, r: 10, b: 34, l: 38 };
  const modOf = r => (opts.keyMod ? r[opts.keyMod] : 0);
  const total = r => r[opts.keyPanel] + modOf(r);
  const top = Math.ceil(Math.max(1, ...rows.map(total)) / 5) * 5 || 5;
  const panelTop = Math.max(5, Math.ceil(Math.max(...rows.map(r => r[opts.keyPanel])) / 5) * 5);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': opts.label }, box);
  const y = v => H - m.b - (v / top) * (H - m.t - m.b);
  for (let v = 0; v <= top; v += top / 5) {
    svgEl('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: 'grid' }, svg);
    svgEl('text', { x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'axis' }, svg, num(v));
  }
  const band = (W - m.l - m.r) / rows.length, bw = Math.min(70, band * 0.62);
  rows.forEach((r, i) => {
    const x = m.l + band * i + (band - bw) / 2, p = r[opts.keyPanel], mo = modOf(r);
    const lower = svgEl('rect', { x, y: y(p), width: bw, height: H - m.b - y(p), rx: 4, fill: tempColor(p / panelTop), class: 'bar' }, svg);
    const upper = mo > 0 ? svgEl('rect', { x, y: y(p + mo), width: bw, height: Math.max(0, y(p) - y(p + mo)), rx: 4, fill: '#dfe6ff', opacity: 0.5, class: 'bar' }, svg) : null;
    if (mo > 0 && H - m.b - y(p) > 20) svgEl('text', { x: x + bw / 2, y: y(p) + 17, 'text-anchor': 'middle', class: 'value inbar' }, svg, num(p));
    svgEl('text', { x: x + bw / 2, y: y(p + mo) - 7, 'text-anchor': 'middle', class: 'value' }, svg, num(p + mo));
    svgEl('text', { x: x + bw / 2, y: H - 12, 'text-anchor': 'middle', class: 'axis x' }, svg, t('ep', { n: r.episode }));
    hover(lower, () => opts.tooltip(r));
    if (upper) hover(upper, () => opts.tooltip(r));
  });
}

// ---- 3. People: portraits + bars (started vs suffered) -----------------------------------------------
export function drawPeopleBars(box, rows, people, opts) {
  box.replaceChildren();
  // HTML legend above the chart
  const lg = el('div', { class: 'legend' }, box);
  for (const [color, text] of [['var(--text)', `${opts.startedLabel} ${opts.colourNote}`], ['rgba(255,255,255,.28)', opts.sufferedLabel]]) {
    const k = el('span', { class: 'key' }, lg);
    el('span', { class: 'dot', style: `background:${color};width:14px;height:9px;border-radius:2px` }, k);
    k.appendChild(document.createTextNode(text));
  }
  const W = width(box), rowH = 74, H = rows.length * rowH + 8, left = 84, right = 150;
  // The scale follows the panelists. The moderator speaks so little that her rates are far larger (her bar is
  // cut at the edge and marked "off scale", with the true value written next to it).
  const panel = rows.filter(r => !people.find(q => q.key === r.key)?.moderator);
  const max = Math.max(1, ...(panel.length ? panel : rows).flatMap(r => [r[opts.started] || 0, r[opts.suffered] || 0]));
  const x = v => left + (Math.min(v, max) / max) * (W - left - right);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': opts.label }, box);
  rows.forEach((r, i) => {
    const p = people.find(q => q.key === r.key), cy = rowH * i + rowH / 2;
    avatarSvg(svg, p, 30, cy, 22, opts.uid);
    [[opts.started, p.color, 'started', -12], [opts.suffered, 'rgba(255,255,255,.28)', 'suffered', 6]].forEach(([k, fill, what, dy]) => {
      const v = r[k] || 0, off = v > max;
      const bar = svgEl('rect', { x: left, y: cy + dy - 1, width: Math.max(2, x(v) - left), height: 13, rx: 4, fill, class: 'bar' }, svg);
      svgEl('text', { x: x(v) + 6, y: cy + dy + 10, class: 'value' }, svg, off ? `${num(v)} ${opts.offScaleText}` : num(v));
      hover(bar, () => opts.tooltip(r, what));
    });
  });
}

// ---- 4. Matrix: who talks over whom -----------------------------------------------------------------
export function drawMatrix(box, rows, people, opts) {
  box.replaceChildren();
  const cell = (a, b) => rows.find(r => r.starter === a && r.overlapped === b)?.n || 0;
  const max = Math.max(1, ...rows.map(r => r.n));
  const table = el('table', { class: 'matrix' }, box);
  const head = el('tr', {}, el('thead', {}, table));
  const corner = el('th', { class: 'corner' }, head);
  el('span', {}, corner, t('mxRows'));
  el('span', {}, corner, t('mxCols'));
  for (const p of people) {
    const th = el('th', {}, head);
    avatarHtml(th, p, 36);
    el('div', { class: 'nm' }, th, p.short);
  }
  el('th', { class: 'tot' }, head, t('mxTotal'));
  const body = el('tbody', {}, table);
  for (const a of people) {
    const tr = el('tr', {}, body);
    const th = el('th', { class: 'rowh' }, tr);
    avatarHtml(th, a, 30);
    el('span', { class: 'nm' }, th, a.short);
    let started = 0;
    for (const b of people) {
      const n = cell(a.name, b.name);
      started += n;
      const td = el('td', a === b ? { class: 'diag' } : { class: n ? 'on' : 'zero' }, tr);
      if (a !== b) {
        td.textContent = String(n);
        if (n) td.style.background = tempColor(0.12 + 0.88 * (n / max));
        td.addEventListener('click', () => opts.onPick(a.name, b.name));
        hover(td, () => [{ text: t('ttTimes', { n }), cls: 'tt-value' }, { text: t('ttMatrix', { a: a.name, b: b.name }) }, { text: t('ttClickList') }]);
      }
    }
    el('td', { class: 'tot' }, tr, String(started));
  }
  const foot = el('tr', { class: 'foot' }, el('tfoot', {}, table));
  el('th', { class: 'rowh' }, foot, t('mxFoot'));
  for (const b of people) el('td', { class: 'tot' }, foot, String(people.reduce((s, a) => s + (a === b ? 0 : cell(a.name, b.name)), 0)));
  el('td', {}, foot, '');
}

// ---- 5. Each person, episode by episode: a grid of counts (rows = people, columns = episodes) ------------
// rows: [{ episode, key, <opts.key>: number }]. Colour = how many, on one scale for the whole grid.
export function drawPersonGrid(box, rows, people, opts) {
  box.replaceChildren();
  const eps = [...new Set(rows.map(r => r.episode))].sort((a, b) => a - b);
  const get = (p, e) => rows.find(r => r.key === p.key && r.episode === e)?.[opts.key] ?? 0;
  const panel = people.filter(p => !p.moderator);
  const max = Math.max(1, ...panel.flatMap(p => eps.map(e => get(p, e))));
  const table = el('table', { class: 'matrix grid', 'aria-label': opts.label }, box);
  const head = el('tr', {}, el('thead', {}, table));
  el('th', { class: 'corner' }, head, '');
  for (const e of eps) el('th', {}, head, t('ep', { n: e }));
  el('th', { class: 'tot' }, head, t('gridTotal'));
  const body = el('tbody', {}, table);
  for (const p of people) {
    const tr = el('tr', {}, body);
    const th = el('th', { class: 'rowh' }, tr);
    avatarHtml(th, p, 30);
    el('span', { class: 'nm' }, th, p.short);
    let total = 0;
    for (const e of eps) {
      const n = get(p, e);
      total += n;
      const td = el('td', { class: n ? 'on' : 'zero' }, tr, String(n));
      if (n) {
        td.style.background = tempColor(0.12 + 0.88 * Math.min(1, n / max));
        td.addEventListener('click', () => opts.onPick(p, e));
      }
      hover(td, () => [...opts.tooltip(n, p, e), ...(n ? [{ text: t('ttClickListen') }] : [])]);
    }
    const tt = el('td', { class: 'tot link' }, tr, String(total));
    if (total) tt.addEventListener('click', () => opts.onPick(p, null));
    hover(tt, () => [{ text: t('ttGridTotal', { n: total }), cls: 'tt-value' }, ...(total ? [{ text: t('ttClickListen') }] : [])]);
  }
}

// ---- 5b. Balance: bars per episode, and the running total ------------------------------------------------
const signed = v => (v > 0 ? '+' : v < 0 ? '−' : '') + num(Math.abs(v), 0);
export { signed };

// One row per person, one bar per episode: up = talked over others more than got talked over, down = the opposite.
// rows: [{ key, episode, balance, started, suffered }]; same scale in every row.
export function drawBalanceBars(box, rows, people, opts) {
  box.replaceChildren();
  const eps = [...new Set(rows.map(r => r.episode))].sort((a, b) => a - b);
  const W = width(box), rowH = 96, left = 76, right = 8, top = 6, H = people.length * rowH + top + 28;
  const maxAbs = Math.max(1, ...rows.map(r => Math.abs(r.balance)));
  const k = (rowH / 2 - 16) / maxAbs;
  const band = (W - left - right) / eps.length, bw = Math.min(46, band * 0.6);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': opts.label }, box);
  people.forEach((p, i) => {
    const y0 = top + rowH * i + rowH / 2;
    avatarSvg(svg, p, 30, y0, 22, 'bal');
    svgEl('line', { x1: left, x2: W - right, y1: y0, y2: y0, class: 'zero' }, svg);
    eps.forEach((e, j) => {
      const r = rows.find(q => q.key === p.key && q.episode === e);
      if (!r) return;
      const x = left + band * j + (band - bw) / 2, h = Math.abs(r.balance) * k, up = r.balance >= 0;
      const bar = svgEl('rect', { x, y: up ? y0 - h : y0, width: bw, height: Math.max(h, 1.5), rx: 3, fill: p.color,
        opacity: up ? 1 : 0.5, class: 'bar' }, svg);
      svgEl('text', { x: x + bw / 2, y: up ? y0 - h - 5 : y0 + h + 13, 'text-anchor': 'middle', class: 'value' }, svg, signed(r.balance));
      hover(bar, () => opts.tooltip(r, p));
    });
  });
  eps.forEach((e, j) => svgEl('text', { x: left + band * j + band / 2, y: H - 8, 'text-anchor': 'middle', class: 'axis x' }, svg, t('ep', { n: e })));
}

// Running total of the balance: one line per person, with the portrait at the end of the line.
// series: [{ person, points: [{ episode, cum, balance }] }]
export function drawCumulative(box, series, opts) {
  box.replaceChildren();
  const eps = [...new Set(series.flatMap(s => s.points.map(q => q.episode)))].sort((a, b) => a - b);
  const W = width(box), H = 360, m = { t: 24, r: 90, b: 34, l: 44 };
  const all = series.flatMap(s => s.points.map(q => q.cum)).concat(0);
  const lo = Math.floor(Math.min(...all) / 5) * 5 - 0, hi = Math.ceil(Math.max(...all) / 5) * 5;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': opts.label }, box);
  const x = e => m.l + (eps.length === 1 ? 0.5 : eps.indexOf(e) / (eps.length - 1)) * (W - m.l - m.r);
  const y = v => H - m.b - ((v - lo) / (hi - lo || 1)) * (H - m.t - m.b);
  for (let v = lo; v <= hi; v += 5) {
    svgEl('line', { x1: m.l, x2: W - m.r + 10, y1: y(v), y2: y(v), class: v === 0 ? 'zero' : 'grid' }, svg);
    svgEl('text', { x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'axis' }, svg, signed(v));
  }
  for (const e of eps) svgEl('text', { x: x(e), y: H - 10, 'text-anchor': 'middle', class: 'axis x' }, svg, t('ep', { n: e }));
  for (const s of series) {
    const p = s.person;
    svgEl('polyline', { points: s.points.map(q => `${x(q.episode)},${y(q.cum)}`).join(' '), fill: 'none', stroke: p.color, 'stroke-width': 3, 'stroke-linejoin': 'round' }, svg);
    for (const q of s.points) {
      const dot = svgEl('circle', { cx: x(q.episode), cy: y(q.cum), r: 5, fill: p.color, stroke: '#081443', 'stroke-width': 2, class: 'pt' }, svg);
      hover(dot, () => opts.tooltip(q, p));
    }
    const end = s.points[s.points.length - 1];
    avatarSvg(svg, p, x(end.episode) + 30, y(end.cum), 14, 'cum');
    svgEl('text', { x: x(end.episode) + 50, y: y(end.cum) + 5, class: 'value' }, svg, signed(end.cum));
  }
}

// Topic bands use their own two dark teal shades (alternating), a colour none of the people has, so a band can never be
// mistaken for a panelist's colour.
const TOPIC_FILLS = ['#14675d', '#1a7d70'];

// ---- 6. Timeline: every overlap of an episode as a tick ----------------------------------------------
// data = { events: [{seconds, starter, overlapped, overlap_s, time}], topics: [{start_s, end_s, topic}], lengthSec }
export function drawTimeline(box, data, people, opts) {
  const W = width(box), H = data.topics.length ? 128 : 96, m = { l: 12, r: 12 };
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': opts.label }, box);
  const x = s => m.l + (s / opts.domainSec) * (W - m.l - m.r);
  svgEl('rect', { x: m.l, y: 8, width: x(data.lengthSec) - m.l, height: 64, rx: 6, class: 'lane' }, svg);
  for (let min = 0; min * 60 <= opts.domainSec; min += 10) {
    svgEl('line', { x1: x(min * 60), x2: x(min * 60), y1: 72, y2: 78, class: 'grid' }, svg);
    svgEl('text', { x: x(min * 60), y: 92, 'text-anchor': 'middle', class: 'axis' }, svg, `${min}'`);
  }
  for (const e of data.events) {
    const p = people.find(q => q.name === e.starter);
    const h = Math.min(60, 14 + e.overlap_s * 14);
    const tick = svgEl('rect', { x: x(e.seconds) - 1.5, y: 72 - h, width: 3, height: h, rx: 1.5, fill: p ? p.color : '#999', class: 'tick' }, svg);
    hover(tick, () => opts.tooltip(e));
    tick.addEventListener('click', () => opts.onPick(e));
  }
  data.topics.forEach((tp, i) => {
    const x1 = x(tp.start_s), x2 = x(tp.end_s);
    const r = svgEl('rect', { x: x1, y: 100, width: Math.max(1, x2 - x1 - 1), height: 20, rx: 4, fill: TOPIC_FILLS[i % TOPIC_FILLS.length], stroke: 'rgba(255,255,255,.25)', 'stroke-width': 1 }, svg);
    if (x2 - x1 > 60) svgEl('text', { x: x1 + 6, y: 114, class: 'topic' }, svg, tp.topic);
    hover(r, () => [{ text: tp.topic, cls: 'tt-value' }, { text: `${clock(tp.start_s)}–${clock(tp.end_s)}` }]);
  });
}

// ---- 7. Topics: overlaps per 10 minutes of each topic -----------------------------------------------
export function drawTopicBars(box, rows, opts) {
  box.replaceChildren();
  const W = width(box), rowH = 34, left = 270, H = rows.length * rowH + 8;
  const max = Math.max(1, ...rows.map(r => r.per_10min));
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': opts.label }, box);
  rows.forEach((r, i) => {
    const cy = 4 + i * rowH;
    svgEl('text', { x: left - 10, y: cy + 19, 'text-anchor': 'end', class: 'axis lbl' }, svg, r.topic);
    const w = Math.max(2, (r.per_10min / max) * (W - left - 60));
    const bar = svgEl('rect', { x: left, y: cy + 4, width: w, height: 20, rx: 4, fill: tempColor(r.per_10min / max), class: 'bar' }, svg);
    svgEl('text', { x: left + w + 6, y: cy + 19, class: 'value' }, svg, num(r.per_10min));
    hover(bar, () => opts.tooltip(r));
  });
}
