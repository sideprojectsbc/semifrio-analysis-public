// app.js: starts DuckDB in the browser, loads the episode files, and draws the views.
//
// The order of events when the page opens:
//   1. start DuckDB-WASM (downloaded from jsDelivr the first time, then cached by the browser)
//   2. create the empty tables (db.js -> createSchema)
//   3. for each episode, fetch its files from ../episodes/epN/ ; missing files are skipped
//   4. put them into the tables (db.js -> loadEpisode)
//   5. draw every view; any change of episode / moderator / language / filter re-runs the SQL and redraws.
//
// Every visible sentence comes from i18n.js (Portuguese by default, English with the PT/EN switch).

import * as duckdb from 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/+esm';
import { arrowToObjects } from './arrow_rows.js';
import { createSchema, loadEpisode, unknownNames, EPISODE_IDS, FILES, PEOPLE } from './db.js';
import * as Q from './queries.js';
import { t, num, initLang, setLang, getLang, applyStatic } from './i18n.js';
import { drawTempScale, drawEpisodeBars, drawPeopleBars, drawMatrix, drawPersonGrid, drawBalanceBars, drawCumulative, drawQuadrant, drawTypeBars, drawZones, TYPE_COLOR, clock, signed, drawTimeline, drawTopicBars,
  avatarHtml, el, hideTooltip } from './charts.js';

const $ = id => document.getElementById(id);
// Where data and audio live: the project folder when run locally, ./data and ./clips on the public site
// (site-config.js, written by make_site.py).
const SITE = { dataRoot: '../episodes', audio: 'full', audioRoot: '../episodes/audio', clipsRoot: './clips', logo: true, ...(window.SEMIFRIO_SITE || {}) };

// Everything the page currently shows depends on this one object.
const state = {
  episode: null,                 // null = all episodes combined, or 1..5
  noMod: true,                   // true (the default) = leave out every overlap the moderator takes part in
  evoMetric: 'started',          // 'started' | 'suffered'
  quadMode: 'episodes',          // quadrant: 'episodes' (each one alone) | 'rolling' (last 3) | 'cumulative'
  quadWho: 'all',                // quadrant: 'all' or one person's key (the others are faded)
  loaded: [],                    // episodes that have an overlaps.csv
};
const filter = () => ({ episode: state.episode, noMod: state.noMod });
// The people shown in charts: without the moderator when her overlaps are left out.
const shown = () => PEOPLE.filter(p => !(state.noMod && p.moderator));
const byName = Object.fromEntries(PEOPLE.map(p => [p.name, p]));
const fmt = v => (v === null || v === undefined ? '–' : (typeof v === 'number' ? num(v) : String(v)));
const scopeText = () => (state.episode === null ? t('scopeAll') : t('scopeEp', { n: state.episode }));
// On a phone the tables use the short names ("Castello Branco"), so the rows do not wrap over three lines.
const shortOnPhone = name => name;   // full names everywhere, also on phones (long names wrap)
const isPhone = () => window.matchMedia('(max-width: 720px)').matches;
const empty = parent => parent.replaceChildren(el('div', { class: 'empty' }, null, t('noData')));

// ---- 1. Start DuckDB-WASM ----------------------------------------------------------------------
let db, conn;
async function startDuckDB() {
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  // A worker script must come from our own address, so we make a one-line script that loads the real one.
  const workerUrl = URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' }));
  const worker = new Worker(workerUrl);
  const adb = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await adb.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);
  conn = await adb.connect();
  db = {
    query: async sql => arrowToObjects(await conn.query(sql)),
    registerText: async (name, text) => { await adb.registerFileText(name, text); },
  };
}

// ---- 2-4. Load the files -----------------------------------------------------------------------
async function fetchText(url) {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    return res.ok ? await res.text() : undefined;
  } catch {
    return undefined;
  }
}

async function loadAll() {
  await createSchema(db);
  state.loaded = [];
  for (const ep of EPISODE_IDS) {
    const files = {};
    await Promise.all(FILES.map(async f => {
      const text = await fetchText(`${SITE.dataRoot}/ep${ep}/${f}`);
      if (text !== undefined) files[f] = text;
    }));
    const done = await loadEpisode(db, ep, files);
    if (done.includes('overlaps.csv') && done.includes('episode.json')) state.loaded.push(ep);
  }
}

async function refreshStatus() {
  $('status').textContent = state.loaded.length ? t('statusLoaded', { n: state.loaded.length }) : t('statusNone');
  const sel = $('episode');
  sel.replaceChildren();
  el('option', { value: '' }, sel, t('allEpisodes', { list: state.loaded.join(', ') || '–' }));
  for (const ep of EPISODE_IDS) {
    const ok = state.loaded.includes(ep);
    const o = el('option', { value: String(ep) }, sel, t('episodeN', { n: ep }) + (ok ? '' : t('notProcessed')));
    if (!ok) o.disabled = true;
  }
  if (state.episode !== null && !state.loaded.includes(state.episode)) state.episode = null;
  sel.value = state.episode === null ? '' : String(state.episode);

  const warn = $('data-warnings');
  warn.replaceChildren();
  if (!state.loaded.length) el('div', { class: 'warn' }, warn, t('warnNoEpisodes'));
  const odd = await unknownNames(db);
  if (odd.length) el('div', { class: 'warn' }, warn, t('warnNames', { names: odd.map(r => r.name).join(', ') }));
}

// ---- Drawing all views -----------------------------------------------------------------------
// Each redraw gets a number; if a newer redraw started while this one waited for DuckDB, the older one stops.
let renderId = 0;
async function renderAll() {
  const id = ++renderId, alive = () => id === renderId;
  for (const [name, fn] of [['heat', renderHeat], ['people', renderPeople], ['matrix', renderMatrix],
    ['evolution', renderEvolution], ['balance', renderBalance], ['floor', renderFloor], ['types', renderTypes], ['zones', renderZones], ['quadrant', renderQuadrant], ['moderator', renderModerator], ['timeline', renderTimeline], ['topics', renderTopics], ['events', renderTable],
    ['method', renderMethod]]) {
    try { await fn(alive); } catch (err) { console.error(`${name} view:`, err); }
  }
}

// View 1: KPIs, temperature scale and bars per episode (always all episodes: this is the evolution).
// Moderator "included": bars = everything, the coloured part is between panelists and the pale part involves the
// moderator. "left out": only overlaps between panelists. Scale and numbers follow the same choice.
async function renderHeat(alive) {
  const rows = (await db.query(Q.episodesSql())).filter(r => state.loaded.includes(r.episode));
  if (!alive()) return;
  const withMod = !state.noMod;
  const main = withMod ? 'per_10min_all' : 'per_10min_panel';          // the value the scale and the colours follow
  const nPanel = rows.reduce((a, r) => a + r.n_panel, 0), nMod = rows.reduce((a, r) => a + r.n_mod, 0);
  const minutes = rows.reduce((a, r) => a + r.length_min, 0);
  const rate = n => (minutes ? num(n / minutes * 10) : '–');
  const hot = rows.reduce((p, r) => (r[main] > (p?.[main] ?? -1) ? r : p), null);
  const cold = rows.reduce((p, r) => (r[main] < (p?.[main] ?? 1e9) ? r : p), null);
  const kpis = $('kpis');
  kpis.replaceChildren();
  for (const [value, label] of [
    [rows.length, t('kEpisodes', { n: rows.length, min: Math.round(minutes) })],
    withMod ? [nPanel + nMod, t('kOverlapsIn', { panel: nPanel, mod: nMod })] : [nPanel, t('kOverlapsOut')],
    [rate(withMod ? nPanel + nMod : nPanel), t('kRate', { panelRate: withMod ? rate(nPanel) : '' })],
    [hot ? t('ep', { n: hot.episode }) : '–', hot ? t('kHot', { hot: num(hot[main]), coldEp: cold.episode, cold: num(cold[main]) }) : ''],
  ]) {
    const k = el('div', { class: 'kpi' }, kpis);
    el('b', {}, k, String(value));
    el('span', {}, k, label);
  }
  const tooltip = r => (withMod ? [
    { text: t('ttPer10', { v: num(r.per_10min_all) }), cls: 'tt-value' },
    { text: t('ttEpisodeAll', { ep: r.episode, n: r.n_panel + r.n_mod, min: r.length_min.toFixed(0) }) },
    { text: t('ttPanel', { n: r.n_panel, r: num(r.per_10min_panel) }) },
    { text: t('ttMod', { n: r.n_mod, r: num(r.per_10min_mod) }) },
  ] : [
    { text: t('ttPer10', { v: num(r.per_10min_panel) }), cls: 'tt-value' },
    { text: t('ttEpisodePanel', { ep: r.episode, n: r.n_panel, min: r.length_min.toFixed(0), every: r.n_panel ? num(r.length_min / r.n_panel) : '' }) },
    { text: t('ttSeconds', { s: r.seconds_panel }) },
  ]);
  $('heat-legend').hidden = !withMod;
  const ex = hot || rows[0];
  $('heat-formula').textContent = ex ? t('fHeat', { ep: t('ep', { n: ex.episode }), n: withMod ? ex.n_panel + ex.n_mod : ex.n_panel,
    min: num(ex.length_min), v: num(ex[main]) }) : '';
  $('heat-note').textContent = t(withMod ? 'heatNoteIn' : 'heatNoteOut');
  if (!rows.length) { for (const id of ['scale', 'episode-bars']) empty($(id)); return; }
  drawTempScale($('scale'), rows, { key: main, tooltip, caption: t(withMod ? 'scaleCaptionIn' : 'scaleCaptionOut') });
  drawEpisodeBars($('episode-bars'), rows, { keyPanel: 'per_10min_panel', keyMod: withMod ? 'per_10min_mod' : null, tooltip,
    label: t(withMod ? 'barsLabelIn' : 'barsLabelOut') });
}

// A simple HTML table: cols = [[key, header, tooltip], ...]; numbers are right-aligned.
function dataTable(cols, rows, groups = null) {
  const wrap = el('div', { class: 'table-wrap', style: 'max-height:none' });
  const table = el('table', { class: 'data' }, wrap);
  const thead = el('thead', {}, table);
  // groups = [[title, number of columns], ...]: a first header row that says what kind of number each block is
  if (groups) {
    const g = el('tr', { class: 'groups' }, thead);
    for (const [title, span] of groups) el('th', { colspan: String(span), class: title ? 'grp' : '' }, g, title);
  }
  const head = el('tr', {}, thead);
  const isNum = cols.map(([k]) => rows.some(r => typeof r[k] === 'number'));
  cols.forEach(([, h, tip], i) => el('th', { class: isNum[i] ? 'num' : '', title: tip || '' }, head, h));
  const body = el('tbody', {}, table);
  for (const r of rows) {
    const tr = el('tr', {}, body);
    cols.forEach(([k, , , render], i) => { const td = el('td', { class: isNum[i] ? 'num' : '' }, tr, render ? '' : fmt(r[k])); if (render) render(td, r); });
  }
  return wrap;
}

// View 2: people.
async function renderPeople(alive) {
  const rows = (await db.query(Q.peopleSql(filter()))).filter(r => shown().some(p => p.key === r.key));
  if (!alive()) return;
  $('people-title').textContent = t(state.noMod ? 'peopleTitle4' : 'peopleTitle5');   // four voices without the moderator, five with her
  if (!state.loaded.length) { empty($('people-bars')); return; }
  const scope = scopeText();
  drawPeopleBars($('people-bars'), rows, PEOPLE, {
    uid: 'people', started: 'started_per_10min', suffered: 'suffered_per_10min',
    startedLabel: t('barStarted'), sufferedLabel: t('barSuffered'), colourNote: t('barColour'), offScaleText: t('offScale'),
    label: t('peopleBarsLabel', { scope }),
    tooltip: (r, what) => [{ text: t('ttPer10', { v: fmt(what === 'started' ? r.started_per_10min : r.suffered_per_10min) }), cls: 'tt-value' },
      { text: t(what === 'started' ? 'ttPeopleStarted' : 'ttPeopleSuffered', { name: r.name, n: what === 'started' ? r.started : r.suffered }) },
      { text: t('ttPeopleMinutes', { min: num(r.minutes), scope }) }],
  });
  const ex = rows.find(r => !r.moderator && r.started);
  $('people-formula').textContent = ex ? t('fPeople', { name: ex.name, n: ex.started, min: num(ex.minutes), v: num(ex.started_per_10min) }) : '';
  $('people-table').replaceChildren(el('h3', {}, null, t('allNumbers', { scope })),
    dataTable([['name', t('colPerson'), '', (td, r) => {   // portrait + full name (+ a note for the moderator)
        const who = el('span', { class: 'who' }, td);
        const p = byName[r.name];
        if (p) avatarHtml(who, p, 26);
        who.appendChild(document.createTextNode(r.name));
        if (r.moderator) el('span', { class: 'small', style: 'margin-left:6px' }, who, t('moderatorNote'));
      }], ['minutes', t('colMinutes'), t('colMinutesTip')],
      ['started', t('colStarted'), t('colStartedTip')],
      ['suffered', t('colSuffered'), t('colSufferedTip')],
      ['started_per_10min', t('colStarted10'), t('col10Tip')],
      ['suffered_per_10min', t('colSuffered10'), t('col10Tip')]], rows,
      [['', 1], [t('grpTime'), 1], [t('grpCount'), 2], [t('grpRate'), 2]]),
    el('p', { class: 'small' }, null, t('tableNote') + (state.noMod ? t('tableNoteMod') : '')));
  await renderExample(alive);
}

// View 3: matrix.
async function renderMatrix(alive) {
  const rows = await db.query(Q.matrixSql(filter()));
  if (!alive()) return;
  if (!state.loaded.length) { empty($('matrix')); return; }
  drawMatrix($('matrix'), rows, shown(), {
    onPick: (a, b) => {
      $('f-starter').value = a; $('f-overlapped').value = b;
      renderTable(() => true).then(() => $('events-card').scrollIntoView({ behavior: 'smooth' }));
    },
  });
}

// View 4: each person across episodes, as a grid of counts.
async function renderEvolution(alive) {
  const rows = (await db.query(Q.personEvolutionSql(filter()))).filter(r => shown().some(p => p.key === r.key) && state.loaded.includes(r.episode));
  if (!alive()) return;
  if (!rows.length) { empty($('evolution')); return; }
  const started = state.evoMetric === 'started';
  drawPersonGrid($('evolution'), rows, shown(), {
    key: state.evoMetric, label: t('gridLabel', { started }),
    // a click lists that person's overlaps (in that episode, or in all for the total) in the table below, with Listen buttons
    onPick: (p, ep) => {
      $('f-episode').value = ep === null ? '' : String(ep);
      $('f-starter').value = started ? p.name : '';
      $('f-overlapped').value = started ? '' : p.name;
      $('f-min').value = '';
      renderTable(() => true).then(() => $('events-card').scrollIntoView({ behavior: 'smooth' }));
    },
    tooltip: (n, p, e) => [{ text: t('ttTimes', { n }), cls: 'tt-value' }, { text: t('ttGrid', { name: p.name, e, started }) }],
  });
}

// View 4b: balance (talked over others minus got talked over) per episode, and cumulative. Panelists only.
async function renderBalance(alive) {
  const people = PEOPLE.filter(p => !p.moderator);
  const rows = (await db.query(Q.personEvolutionSql({ episode: null, noMod: true })))
    .filter(r => people.some(p => p.key === r.key) && state.loaded.includes(r.episode))
    .map(r => ({ ...r, balance: r.started - r.suffered }));
  if (!alive()) return;
  if (!rows.length) { empty($('balance')); empty($('cumulative')); return; }
  const eps = [...new Set(rows.map(r => r.episode))].sort((x, y) => x - y);
  const series = people.map(person => {
    let cum = 0;
    return { person, points: eps.map(e => {
      const r = rows.find(q => q.key === person.key && q.episode === e);
      cum += r ? r.balance : 0;
      return { episode: e, balance: r ? r.balance : 0, cum, started: r?.started ?? 0, suffered: r?.suffered ?? 0 };
    }) };
  });
  drawBalanceBars($('balance'), rows, people, { label: t('balLabel'),
    tooltip: (r, p) => [{ text: t('ttBal', { name: p.name, ep: t('ep', { n: r.episode }), s: signed(r.balance) }), cls: 'tt-value' },
      { text: t('ttBalDetail', { a: r.started, b: r.suffered }) }] });
  const cl = $('cumulative-legend');
  cl.replaceChildren();
  for (const p of people) {
    const k = el('span', { class: 'key' }, cl);
    avatarHtml(k, p, 22);
    k.appendChild(document.createTextNode(p.name));
  }
  drawCumulative($('cumulative'), series, { label: t('balCumLabel'),
    tooltip: (q, p) => [{ text: t('ttCum', { name: p.name, ep: t('ep', { n: q.episode }), c: signed(q.cum) }), cls: 'tt-value' },
      { text: t('ttBal', { name: p.name, ep: t('ep', { n: q.episode }), s: signed(q.balance) }) }] });
  // the formula, with a real example: the first person's second episode (or the first one if there is only one)
  const sx = series.find(s => s.points.length > 1) || series[0], pt = sx.points[Math.min(1, sx.points.length - 1)];
  const prev = sx.points.length > 1 ? sx.points[0].cum : 0;
  $('balance-formula').textContent = t('balFormula', { name: sx.person.name, ep: t('ep', { n: pt.episode }), a: pt.started, b: pt.suffered,
    s: signed(pt.balance), first: t('ep', { n: eps[0] }), prev: signed(prev), op: pt.balance < 0 ? '−' : '+', abs: Math.abs(pt.balance), cum: signed(pt.cum) });
}

// View 4c: who had the floor. The same overlaps as everywhere else, seen from the turn the moderator gave each panelist.
// Moderator overlaps are not part of it (they are the hand-overs), so the "moderator left out" switch does not apply.
async function renderFloor(alive) {
  const f = { episode: state.episode, noMod: true };
  const [rows, raw, kinds] = await Promise.all([db.query(Q.floorSql(f)), db.query(Q.peopleSql(f)), db.query(Q.floorKindsSql(f))]);
  if (!alive()) return;
  if (!rows.some(r => r.floor_min > 0)) {
    empty($('floor-bars'));
    $('floor-formula').textContent = '';
    $('floor-kinds').textContent = '';
    $('floor-table').replaceChildren();
    return;
  }
  const scope = scopeText();
  const data = rows.map(r => ({ ...r, raw_started: raw.find(q => q.key === r.key)?.started_per_10min,
    raw_suffered: raw.find(q => q.key === r.key)?.suffered_per_10min }));
  drawPeopleBars($('floor-bars'), data, PEOPLE, {
    uid: 'floor', started: 'made_per_10min', suffered: 'received_per_10min',
    startedLabel: t('floorMade'), sufferedLabel: t('floorReceived'), colourNote: '', offScaleText: t('offScale'),
    label: t('floorBarsLabel', { scope }),
    tooltip: (r, what) => [{ text: t('ttPer10', { v: fmt(what === 'started' ? r.made_per_10min : r.received_per_10min) }), cls: 'tt-value' },
      { text: what === 'started' ? t('ttFloorMade', { name: r.name, n: r.made }) : t('ttFloorReceived', { name: r.name, n: r.received, lost: r.took }) },
      { text: t('ttFloorMin', { own: num(r.floor_min), others: num(r.others_min) }) }],
  });
  const ex = data.filter(r => r.received).sort((a, b) => b.received - a.received)[0];
  $('floor-formula').textContent = ex ? t('fFloor', { name: ex.name, n: ex.received, min: num(ex.floor_min), v: num(ex.received_per_10min) }) : '';
  const n = k => kinds.find(q => q.kind === k)?.n ?? 0, total = kinds.reduce((a, q) => a + q.n, 0);
  $('floor-kinds').textContent = t('floorKinds', { total, mod: n('moderator'), intrusion: n('intrusion'), recovery: n('recovery'),
    other: n('owner_over_other') + n('side_talk'), open: n('open_debate') });
  $('floor-table').replaceChildren(el('h3', {}, null, t('floorTableTitle', { scope })),
    dataTable([['name', t('colPerson'), '', (td, r) => {
        const who = el('span', { class: 'who' }, td);
        const p = byName[r.name];
        if (p) avatarHtml(who, p, 26);
        who.appendChild(document.createTextNode(r.name));
      }],
      ['floor_min', t('floorColMin'), t('floorColMinTip')],
      ['received', t('floorColReceived'), t('floorColReceivedTip')],
      ['took', t('floorColLost'), t('floorColLostTip')],
      ['received_per_10min', t('floorColReceived10'), t('floorColReceived10Tip')],
      ['made', t('floorColMade'), t('floorColMadeTip')],
      ['made_per_10min', t('floorColMade10'), t('floorColMade10Tip')],
      ['recovered', t('floorColRec'), t('floorColRecTip')],
      ['raw_started', t('floorColRawS'), t('col10Tip')],
      ['raw_suffered', t('floorColRawB'), t('col10Tip')]], data,
      [['', 1], [t('floorGrpTurn'), 1], [t('floorGrpIn'), 3], [t('floorGrpOut'), 2], [t('floorGrpRec'), 1], [t('floorGrpRaw'), 2]]));
}

// The colour key of the overlap types (one chip per type)
function typeLegend(box, kinds) {
  box.replaceChildren();
  for (const k of kinds) {
    const key = el('span', { class: 'key' }, box);
    el('span', { class: 'dot', style: `background:${TYPE_COLOR[k]};width:14px;height:9px;border-radius:2px` }, key);
    key.appendChild(document.createTextNode(t(`type_${k}`)));
  }
}

// View 4c2: types of cut. How the cuts in a person's turn ended, how the cuts they made ended, and what they did in their own turn.
async function renderTypes(alive) {
  const rows = await db.query(Q.floorTypesSql({ episode: state.episode, noMod: true }));
  if (!alive()) return;
  const people = PEOPLE.filter(p => !p.moderator);
  if (!rows.some(r => r.rec_takeover + r.rec_resisted + r.rec_contested + r.rec_cut + r.made_takeover + r.made_resisted + r.made_contested + r.made_cut + r.recovery + r.over_other)) {
    empty($('types')); $('types-legend').replaceChildren(); return;
  }
  const scope = scopeText();
  const outcomes = pre => ['takeover', 'resisted', 'contested', 'cut'].map(o => ({ col: `${pre}_${o}`, kind: `intrusion_${o}` }));
  const kinds = ['intrusion_takeover', 'intrusion_resisted', 'intrusion_contested', 'intrusion_cut', 'recovery', 'owner_over_other'];
  typeLegend($('types-legend'), kinds);
  drawTypeBars($('types'), rows, people, {
    label: t('typesLabel', { scope }), color: k => TYPE_COLOR[k],
    rows: [{ label: t('typesRowRec'), parts: outcomes('rec') }, { label: t('typesRowMade'), parts: outcomes('made') },
      { label: t('typesRowOwn'), parts: [{ col: 'recovery', kind: 'recovery' }, { col: 'over_other', kind: 'owner_over_other' }] }],
    tooltip: (r, g, part, v) => [{ text: t('ttTypes', { name: r.name, row: g.label, type: t(`type_${part.kind}`), n: v }), cls: 'tt-value' }],
  });
}

// View 4c3: zones. Each episode as a line: whose turn it is (bands) and every overlap in its place (ticks coloured by type).
async function renderZones(alive) {
  const [slots, events, topics] = await Promise.all([db.query(Q.zonesSlotsSql()), db.query(Q.zonesEventsSql()),
    db.query('SELECT episode, start_s, end_s, topic FROM topics ORDER BY episode, start_s')]);
  const meta = await db.query('SELECT episode, length_min FROM episodes ORDER BY episode');
  if (!alive()) return;
  const eps = (state.episode === null ? state.loaded : [state.episode]).filter(e => slots.some(s => s.episode === e));
  if (!eps.length) { empty($('zones')); $('zones-legend').replaceChildren(); $('zones-people').replaceChildren(); return; }
  const people = PEOPLE.filter(p => !p.moderator);
  const keyOf = Object.fromEntries(PEOPLE.map(p => [p.name, p.key]));
  const blocks = eps.map(e => ({
    episode: e, lengthSec: (meta.find(m => m.episode === e)?.length_min ?? 55) * 60,
    topics: topics.filter(r => r.episode === e),
    slots: slots.filter(r => r.episode === e).map(r => ({ ...r, key: keyOf[r.owner] })),
    events: events.filter(r => r.episode === e).map(r => ({ ...r, cls: r.class })),
  }));
  const pl = $('zones-people');
  pl.replaceChildren();
  for (const p of people) {
    const k = el('span', { class: 'key' }, pl);
    avatarHtml(k, p, 20);
    k.appendChild(document.createTextNode(` ${p.name}`));
  }
  el('span', { class: 'small', style: 'margin-left:8px' }, pl, t('zonesBands'));
  typeLegend($('zones-legend'), ['intrusion_takeover', 'intrusion_resisted', 'intrusion_contested', 'intrusion_cut', 'recovery', 'owner_over_other', 'side_talk', 'open_debate', 'moderator']);
  const hideMod = state.noMod;
  drawZones($('zones'), blocks, PEOPLE, {
    label: t('zonesLabel'), color: k => TYPE_COLOR[k], hide: e => hideMod && e.cls === 'moderator',
    slotTooltip: (b, s) => [{ text: t('ttZoneTurn', { name: s.owner, ep: t('ep', { n: b.episode }), a: clock(s.start_s), b: clock(s.end_s) }), cls: 'tt-value' },
      { text: t('ttZoneAnswer', { a: clock(s.start_s), b: clock(s.floor_end_s) }) }],
    tooltip: (b, e) => [{ text: t('ttZoneEvent', { ep: t('ep', { n: b.episode }), time: e.time, starter: e.starter, over: e.overlapped }), cls: 'tt-value' },
      { text: t(`type_${e.cls}`) }, ...(e.detail ? [{ text: e.detail }] : []), { text: t('ttZoneIn', { owner: e.owner || '–' }) }],
  });
}

// View 4d: the quadrant. Cutting others (x) against being cut in own turn (y); the trail is the cumulative position over the episodes.
async function renderQuadrant(alive) {
  const rows = (await db.query(Q.floorEvolutionSql())).filter(r => state.loaded.includes(r.episode));
  if (!alive()) return;
  const people = PEOPLE.filter(p => !p.moderator);
  const sum = list => list.reduce((s, r) => ({ own: s.own + r.own_min, others: s.others + r.others_min, rec: s.rec + r.received, made: s.made + r.made }),
    { own: 0, others: 0, rec: 0, made: 0 });
  const at = (s, extra) => ({ x: s.others ? s.made / s.others * 10 : 0, y: s.own ? s.rec / s.own * 10 : 0, made: s.made, rec: s.rec, ...extra });
  const series = people.map(person => {
    const mine = rows.filter(r => r.key === person.key);
    const points = mine.map((r, i) => {
      if (state.quadMode === 'rolling') {
        const win = mine.slice(Math.max(0, i - 2), i + 1);
        return at(sum(win), { n: r.episode, what: win.length > 1 ? `${t('ep', { n: win[0].episode })}–${win[win.length - 1].episode}` : t('ep', { n: r.episode }) });
      }
      if (state.quadMode === 'cumulative') return at(sum(mine.slice(0, i + 1)), { n: r.episode, what: t('quadUpTo', { ep: t('ep', { n: r.episode }) }) });
      return at(sum([r]), { n: r.episode, what: t('ep', { n: r.episode }) });
    });
    return { person, points, avg: at(sum(mine), {}) };
  }).filter(s => s.points.length);
  if (!series.length) { empty($('quadrant')); $('quad-who').replaceChildren(); return; }
  const who = $('quad-who');   // chips: everyone, or one person at a time (the others fade)
  who.replaceChildren();
  for (const [key, person] of [['all', null], ...people.map(p => [p.key, p])]) {
    const b = el('button', { type: 'button', 'aria-pressed': String(state.quadWho === key) }, who);
    if (person) avatarHtml(b, person, 20);
    b.appendChild(document.createTextNode(person ? ` ${person.short}` : t('quadAll')));
    b.addEventListener('click', () => { state.quadWho = key; renderQuadrant(() => true); });
  }
  drawQuadrant($('quadrant'), series, {
    focus: state.quadWho === 'all' ? null : state.quadWho,
    label: t('quadLabel'), xLabel: t('quadX'), yLabel: t('quadY'),
    quad: { tl: t('quadTL'), tr: t('quadTR'), bl: t('quadBL'), br: t('quadBR') },
    tooltip: (q, p) => [{ text: t('ttQuadPoint', { name: p.name, what: q.what, made: q.made, rec: q.rec }), cls: 'tt-value' },
      { text: t('ttQuadRates', { x: num(q.x), y: num(q.y) }) }],
    tooltipAvg: (q, p) => [{ text: t('ttQuadAvg', { name: p.name, made: q.made, rec: q.rec }), cls: 'tt-value' },
      { text: t('ttQuadRates', { x: num(q.x), y: num(q.y) }) }],
  });
}

// View 4e: the moderator: overlaps in which she takes part, per panelist, by what happened.
async function renderModerator(alive) {
  const rows = await db.query(Q.moderatorSql({ episode: state.episode, noMod: false }));
  if (!alive()) return;
  if (!rows.some(r => r.floor_min > 0)) { empty($('moderator-bars')); $('moderator-formula').textContent = ''; $('moderator-table').replaceChildren(); return; }
  const scope = scopeText();
  drawPeopleBars($('moderator-bars'), rows, PEOPLE, {
    uid: 'mod', started: 'cut_in_per_10min', suffered: 'over_per_10min',
    startedLabel: t('modCut'), sufferedLabel: t('modOver'), colourNote: '', offScaleText: t('offScale'),
    label: t('modBarsLabel', { scope }),
    tooltip: (r, what) => [{ text: t('ttPer10', { v: fmt(what === 'started' ? r.cut_in_per_10min : r.over_per_10min) }), cls: 'tt-value' },
      { text: what === 'started' ? t('ttModCut', { name: r.name, n: r.cut_in, ends: r.ends, paused: r.paused, cont: r.continued })
        : t('ttModOver', { name: r.name, n: r.over }) },
      { text: t('ttFloorMin', { own: num(r.floor_min), others: '–' }).split(';')[0] }],
  });
  const ex = rows.filter(r => r.cut_in).sort((x, y) => y.cut_in_per_10min - x.cut_in_per_10min)[0];
  $('moderator-formula').textContent = ex ? t('fMod', { name: ex.name, n: ex.cut_in, min: num(ex.floor_min), v: num(ex.cut_in_per_10min) }) : '';
  $('moderator-table').replaceChildren(el('h3', {}, null, t('modTableTitle', { scope })),
    dataTable([['name', t('colPerson'), '', (td, r) => {
        const who = el('span', { class: 'who' }, td);
        const p = byName[r.name];
        if (p) avatarHtml(who, p, 26);
        who.appendChild(document.createTextNode(r.name));
      }],
      ['floor_min', t('floorColMin'), t('floorColMinTip')],
      ['cut_in', t('modColCut'), t('modColCutTip')],
      ['ends', t('modColEnds'), t('modColEndsTip')],
      ['paused', t('modColPaused'), t('modColPausedTip')],
      ['continued', t('modColCont'), t('modColContTip')],
      ['cut_in_per_10min', t('modColCut10'), t('modColCut10Tip')],
      ['handoff', t('modColHand'), t('modColHandTip')],
      ['over', t('modColOver'), t('modColOverTip')],
      ['over_per_10min', t('modColOver10'), t('modColOver10Tip')]], rows,
      [['', 1], [t('floorGrpTurn'), 1], [t('modGrpCut'), 5], [t('modGrpOther'), 3]]));
}

// View 5: timeline, one strip per episode.
async function renderTimeline(alive) {
  const eps = state.episode === null ? state.loaded : [state.episode];
  const f = filter();
  const blocks = [];
  for (const ep of eps) {
    const events = await db.query(Q.timelineSql(ep, f));
    const topics = await db.query(Q.topicsOfEpisodeSql(ep));
    const meta = (await db.query(`SELECT length_min FROM episodes WHERE episode = ${ep}`))[0];
    blocks.push({ ep, events, topics, lengthSec: meta.length_min * 60 });
  }
  if (!alive()) return;
  const lg = $('timeline-legend');
  lg.replaceChildren();
  el('span', { class: 'lead' }, lg, t('tlLead'));
  for (const p of shown()) {
    const k = el('span', { class: 'key' }, lg);
    el('span', { class: 'dot', style: `background:${p.color}` }, k);
    k.appendChild(document.createTextNode(t('tlStarts', { name: p.name })));
  }
  const box = $('timeline');
  box.replaceChildren();
  if (!blocks.length) empty(box);
  const domainSec = Math.max(0, ...blocks.map(b => b.lengthSec));
  for (const b of blocks) {
    const block = el('div', {}, box);
    const h = el('h3', {}, block, t('tlEpisode', { n: b.ep }));
    el('span', { class: 'small', style: 'text-transform:none;letter-spacing:0' }, h, t('tlCount', { n: b.events.length }));
    const target = el('div', {}, block);
    drawTimeline(target, b, PEOPLE, {
      domainSec, label: t('tlLabel', { n: b.ep }),
      tooltip: e => [{ text: `${e.time} · ${num(e.overlap_s, 2)} s`, cls: 'tt-value' }, { text: t('ttTimeline', { a: e.starter, b: e.overlapped }) }],
      // A click filters the table below to this episode (the page's own episode selector is left alone) and
      // jumps to that overlap, with its Listen button.
      onPick: e => {
        $('f-episode').value = String(b.ep);
        $('f-starter').value = ''; $('f-overlapped').value = ''; $('f-min').value = '';
        renderTable(() => true).then(() => {
          const row = document.getElementById(`ev-${b.ep}-${e.seconds}`);
          (row || $('events-card')).scrollIntoView({ behavior: 'smooth', block: row ? 'center' : 'start' });
          if (row) { row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 2500); }
        });
      },
    });
  }
}

// View 6: topics (only when a topics.csv exists). One bar per topic and episode: "Name (Ep. N)".
async function renderTopics(alive) {
  const rows = (await db.query(Q.topicsSql(filter()))).map(r => ({ ...r, topic: `${r.name} (${t('ep', { n: r.episode })})` }));
  if (!alive()) return;
  const box = $('topics');
  box.replaceChildren();
  $('topics-formula').textContent = rows.length ? t('fTopics', { topic: rows[0].topic, n: rows[0].n, min: num(rows[0].minutes), v: num(rows[0].per_10min) }) : '';
  if (!rows.length) { el('div', { class: 'empty' }, box, t('topicsEmpty')); return; }
  drawTopicBars(box, rows, { label: t('topicsLabel'),
    tooltip: r => [{ text: t('ttPer10', { v: num(r.per_10min) }), cls: 'tt-value' }, { text: r.topic }, { text: t('ttTopic', { n: r.n, min: num(r.minutes) }) }] });
}

// ---- View 7: event table ------------------------------------------------------------------------
function currentFilters() {
  return { ...filter(), eventEpisode: $('f-episode').value, starter: $('f-starter').value, overlapped: $('f-overlapped').value,
    minOverlap: $('f-min').value, maxConf: $('f-conf').value };
}

// ---- Playing a moment ------------------------------------------------------------------------------
// One shared <audio>. It plays from 3 s before the overlap to 7 s after, then stops. This needs the page to be
// served with serve.py (which understands "Range" requests), otherwise the browser cannot jump into the file.
const player = new Audio();
window.__player = player; // handy for tests in the browser console
player.preload = 'metadata';
let playing = null;   // { button, stopAt }
function stopPlaying() {
  player.pause();
  if (playing) { playing.button.textContent = playing.button.dataset.label; playing.button.classList.remove('on'); }
  playing = null;
}
player.addEventListener('timeupdate', () => { if (playing && player.currentTime >= playing.stopAt) stopPlaying(); });
player.addEventListener('ended', stopPlaying);
player.addEventListener('error', () => {
  if (!playing) return;
  playing.button.textContent = t('noAudio');
  playing.button.title = t('noAudioTip');
  playing = null;
});
// A play button: its text is a label key, so it follows the language.
function playButton(parent, cls, labelKey, r, title) {
  const b = el('button', { type: 'button', class: cls, title: title || '' }, parent, t(labelKey));
  b.dataset.label = t(labelKey);
  b.addEventListener('click', () => playMoment(r, b));
  return b;
}
let loadedSrc = null;
async function playMoment(r, button) {
  const wasThis = playing && playing.button === button;
  stopPlaying();
  if (wasThis) return;                      // second click = stop
  // Public site: a 10-second clip per overlap (plays from its start). Local: the whole episode file, jumping to the moment.
  const clip = SITE.audio === 'clips';
  const src = clip ? `${SITE.clipsRoot}/ep${r.episode}/${Math.round(r.seconds * 100)}.mp3` : `${SITE.audioRoot}/${r.audio_file}`;
  playing = { button, stopAt: clip ? Infinity : r.seconds + 7 };
  button.textContent = t('stop');
  button.classList.add('on');
  // Phones (Safari especially) only start sound inside the tap itself: for a clip we call play() at once, without waiting.
  if (loadedSrc !== src) {
    player.src = src; loadedSrc = src;
    if (!clip) await new Promise(res => {
      const done = () => { player.removeEventListener('loadedmetadata', done); res(); };
      player.addEventListener('loadedmetadata', done); player.addEventListener('error', done, { once: true });
    });
  } else if (clip) player.currentTime = 0;
  try { if (!clip) player.currentTime = Math.max(0, r.seconds - 3); await player.play(); } catch (err) { console.error(err); stopPlaying(); }
}

// The example under "The five voices": a real moment you can listen to (episode 5, 24:47, which was checked by ear:
// Castello Branco starts talking while Brinca is talking). Falls back to the longest overlap between panelists.
async function renderExample(alive) {
  const box = $('people-example');
  const r = (await db.query(Q.exampleSql()))[0];
  if (!alive()) return;
  box.replaceChildren();
  if (!r) return;
  const a = byName[r.starter], b = byName[r.overlapped];
  el('h3', {}, box, t('example'));
  const card = el('div', { class: 'example' }, box);
  const text = el('div', {}, card);
  const p = el('p', {}, text);
  p.append(t('exPre', { ep: r.episode, time: r.time }));
  el('b', { style: `color:${a.color}` }, p, a.name);
  p.append(t('exMid'));
  el('b', { style: `color:${b.color}` }, p, b.name);
  p.append(t('exPost', { s: num(r.overlap_s) }));
  const list = el('ul', {}, text);
  const li1 = el('li', {}, list); el('b', { style: `color:${a.color}` }, li1, a.name); li1.append(t('exScores'));
  el('i', {}, li1, t('exStarted')); li1.append('.');
  const li2 = el('li', {}, list); el('b', { style: `color:${b.color}` }, li2, b.name); li2.append(t('exScores'));
  el('i', {}, li2, t('exSuffered')); li2.append('.');
  playButton(card, 'play big', 'listenIt', r);
}

// The methodology example: a real back-and-forth (episode 2, about 37:19 to 37:29), with a Listen button on every row.
async function renderMethod(alive) {
  const rows = await db.query(Q.methodExampleSql());
  if (!alive()) return;
  const box = $('method-example');
  box.replaceChildren();
  if (rows.length < 2) return;
  const a = rows[0].overlapped, b = rows[0].starter;            // the one who was speaking, and the one who came in
  const count = (who, key) => rows.filter(r => r[key] === who).length;
  const first = rows[0], last = rows[rows.length - 1];
  const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const p = el('p', {}, box, t('methodExampleText', { ep: first.episode, from: first.time, to: mmss(last.seconds + last.overlap_s), first: a, second: b,
    n: rows.length, secs: Math.round(last.seconds + last.overlap_s - first.seconds) }));
  const table = el('table', { class: 'data' }, el('div', { class: 'table-wrap', style: 'max-height:none' }, box));
  const head = el('tr', {}, el('thead', {}, table));
  [['thTime', 1], ['thTalksOver'], ['thGets'], ['thOverlap', 1], ['thHear']].forEach(([k, isNum]) => el('th', { class: isNum ? 'num' : '' }, head, t(k)));
  const body = el('tbody', {}, table);
  for (const r of rows) {
    const tr = el('tr', {}, body);
    el('td', { class: 'num' }, tr, r.time);
    for (const name of [r.starter, r.overlapped]) {
      const td = el('td', {}, tr), who = el('span', { class: 'who' }, td);
      el('span', { class: 'dot', style: `background:${byName[name]?.color || '#999'}` }, who);
      who.appendChild(document.createTextNode(shortOnPhone(name)));
    }
    el('td', { class: 'num' }, tr, num(r.overlap_s, 2));
    playButton(el('td', { class: 'cmd' }, tr), 'play', 'listen', r, t('listenTip', { time: r.time, ep: r.episode }));
  }
  el('p', { class: 'note', style: 'margin-top:10px' }, box, t('methodExampleResult', {
    a, aStarted: count(a, 'starter'), aSuffered: count(a, 'overlapped'), b, bStarted: count(b, 'starter'), bSuffered: count(b, 'overlapped') }));
  el('p', { class: 'note' }, box, t('methodExampleNote'));
}

async function renderTable(alive) {
  const rows = await db.query(Q.eventsSql(currentFilters()));
  if (!alive()) return;
  const sure = rows.length ? Math.round(100 * rows.filter(r => (r.confidence ?? 100) >= 80).length / rows.length) : 0;
  $('events-count').textContent = t('eventsCount', { n: rows.length, more: rows.length === 500 }) + (rows.length ? t('eventsConfShare', { pct: sure }) : '');
  const table = $('events');
  table.replaceChildren();
  const head = el('tr', {}, el('thead', {}, table));
  // On a phone the table is narrower: episode and time share one cell, the overlap column is just "s", the button is a ▶.
  const phone = isPhone();
  (phone ? [['thTime', 1], ['thTalksOver'], ['thGets'], ['thSecondsShort', 1], ['thConfShort', 1], ['thHearShort']]
         : [['thEp', 1], ['thTime', 1], ['thTalksOver'], ['thGets'], ['thOverlap', 1], ['thConf', 1], ['thHear']]).forEach(([k, isNum]) =>
    el('th', { class: isNum ? 'num' : '' }, head, t(k)));
  const body = el('tbody', {}, table);
  if (!rows.length) el('td', { colspan: phone ? '6' : '7', class: 'empty' }, el('tr', {}, body), t('noMatch'));
  for (const r of rows) {
    const tr = el('tr', { id: `ev-${r.episode}-${r.seconds}` }, body);
    if (phone) el('td', { class: 'num', title: `${r.seconds} s` }, tr, `${r.episode} · ${r.time}`);
    else {
      el('td', { class: 'num' }, tr, String(r.episode));
      el('td', { class: 'num', title: `${r.seconds} s` }, tr, r.time);
    }
    for (const name of [r.starter, r.overlapped]) {
      const td = el('td', {}, tr), who = el('span', { class: 'who' }, td);
      el('span', { class: 'dot', style: `background:${byName[name]?.color || '#999'}` }, who);
      who.appendChild(document.createTextNode(shortOnPhone(name)));
    }
    el('td', { class: 'num' }, tr, r.overlap_s === null ? '–' : num(r.overlap_s, phone ? 1 : 2));
    const c = r.confidence;
    el('td', { class: `num conf ${c === null || c === undefined ? '' : c >= 80 ? 'hi' : c >= 50 ? 'mid' : 'low'}`, title: t('confTip', { s: c ?? '?', o: c ?? '?' }) }, tr,
      c === null || c === undefined ? '–' : `${c} %`);
    const cell = el('td', { class: 'cmd' }, tr);
    playButton(cell, 'play', phone ? 'listenIcon' : 'listen', r, t('listenTip', { time: r.time, ep: r.episode }));
  }
}

function fillFilterOptions() {
  const ep = $('f-episode'), keepEp = ep.value;
  ep.replaceChildren();
  el('option', { value: '' }, ep, t('fAsAbove'));
  for (const n of EPISODE_IDS) el('option', { value: String(n) }, ep, t('episodeN', { n }));
  ep.value = keepEp;
  const cf = $('f-conf'), keepConf = cf.value;
  cf.replaceChildren();
  for (const [v, k] of [['', 'fConfAll'], ['80', 'fConfLt80'], ['50', 'fConfLt50']]) el('option', { value: v }, cf, t(k));
  cf.value = keepConf;
  for (const id of ['f-starter', 'f-overlapped']) {
    const sel = $(id), keep = sel.value;
    sel.replaceChildren();
    el('option', { value: '' }, sel, t('fAnyone'));
    for (const p of PEOPLE) el('option', { value: p.name }, sel, p.name);
    sel.value = keep;
  }
}

// ---- Controls ------------------------------------------------------------------------------------
function setPressed(groupId, attr, value) {
  for (const b of $(groupId).querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset[attr] === value));
}

// Changes the language: fixed texts, drop-downs and every chart are redrawn.
async function switchLang(l) {
  stopPlaying();
  setLang(l);
  setPressed('lang', 'lang', getLang());
  applyStatic();
  fillFilterOptions();
  await refreshStatus();
  await renderAll();
}

function setupControls() {
  $('episode').addEventListener('change', () => {
    state.episode = $('episode').value === '' ? null : Number($('episode').value);
    renderAll();
  });
  for (const b of $('mod').querySelectorAll('button')) {
    b.addEventListener('click', () => { state.noMod = b.dataset.mod === 'without'; setPressed('mod', 'mod', b.dataset.mod); renderAll(); });
  }
  for (const b of $('lang').querySelectorAll('button')) b.addEventListener('click', () => switchLang(b.dataset.lang));
  for (const b of $('evo-metric').querySelectorAll('button')) {
    b.addEventListener('click', () => { state.evoMetric = b.dataset.metric; setPressed('evo-metric', 'metric', b.dataset.metric); renderEvolution(() => true); });
  }
  for (const id of ['f-episode', 'f-starter', 'f-overlapped', 'f-min', 'f-conf']) $(id).addEventListener('change', () => renderTable(() => true));
  for (const b of $('quad-mode').querySelectorAll('button')) {
    b.addEventListener('click', () => { state.quadMode = b.dataset.quad; setPressed('quad-mode', 'quad', b.dataset.quad); renderQuadrant(() => true); });
  }
  $('f-clear').addEventListener('click', () => {
    for (const id of ['f-episode', 'f-starter', 'f-overlapped', 'f-min', 'f-conf']) $(id).value = '';
    renderTable(() => true);
  });
  // Redraw the SVG charts when the window width changes (they are drawn to fit).
  let lastWidth = window.innerWidth, resizing;
  window.addEventListener('resize', () => {
    if (window.innerWidth === lastWidth) return;
    lastWidth = window.innerWidth;
    clearTimeout(resizing);
    resizing = setTimeout(() => { hideTooltip(); renderAll(); }, 200);
  });
}

// ---- Start ---------------------------------------------------------------------------------------
async function main() {
  initLang();
  applyStatic();
  if (SITE.logo === false) document.querySelector('.logo')?.remove();   // the public site shows a text title, not RTP's logo
  setPressed('lang', 'lang', getLang());
  setPressed('mod', 'mod', state.noMod ? 'without' : 'with');
  if (location.protocol === 'file:') return; // the message in index.html explains what to do
  try {
    await startDuckDB();
    $('boot-msg').textContent = t('loadingFiles');
    await loadAll();
  } catch (err) {
    console.error(err);
    $('boot-msg').textContent = t('bootFailed');
    const help = $('boot-help');
    help.hidden = false;
    help.textContent = t('bootFailedHelp', { msg: err.message || err });
    return;
  }
  $('boot').hidden = true;
  setupControls();
  fillFilterOptions();
  document.body.classList.add('ready');
  await refreshStatus();
  await renderAll();
  document.body.dataset.loaded = 'true'; // used by automatic tests, harmless otherwise
}
main();
