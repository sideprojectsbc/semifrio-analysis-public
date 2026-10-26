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
import { drawTempScale, drawEpisodeBars, drawPeopleBars, drawMatrix, drawPersonGrid, drawBalanceBars, drawCumulative, signed, drawTimeline, drawTopicBars,
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
  loaded: [],                    // episodes that have an overlaps.csv
};
const filter = () => ({ episode: state.episode, noMod: state.noMod });
// The people shown in charts: without the moderator when her overlaps are left out.
const shown = () => PEOPLE.filter(p => !(state.noMod && p.moderator));
const byName = Object.fromEntries(PEOPLE.map(p => [p.name, p]));
const fmt = v => (v === null || v === undefined ? '–' : (typeof v === 'number' ? num(v) : String(v)));
const scopeText = () => (state.episode === null ? t('scopeAll') : t('scopeEp', { n: state.episode }));
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
    ['evolution', renderEvolution], ['balance', renderBalance], ['timeline', renderTimeline], ['topics', renderTopics], ['events', renderTable],
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
    cols.forEach(([k], i) => el('td', { class: isNum[i] ? 'num' : '' }, tr, fmt(r[k])));
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
    dataTable([['name', t('colPerson')], ['minutes', t('colMinutes'), t('colMinutesTip')],
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
  drawCumulative($('cumulative'), series, { label: t('balCumLabel'),
    tooltip: (q, p) => [{ text: t('ttCum', { name: p.name, ep: t('ep', { n: q.episode }), c: signed(q.cum) }), cls: 'tt-value' },
      { text: t('ttBal', { name: p.name, ep: t('ep', { n: q.episode }), s: signed(q.balance) }) }] });
  // the formula, with a real example: the first person's second episode (or the first one if there is only one)
  const sx = series.find(s => s.points.length > 1) || series[0], pt = sx.points[Math.min(1, sx.points.length - 1)];
  const prev = sx.points.length > 1 ? sx.points[0].cum : 0;
  $('balance-formula').textContent = t('balFormula', { name: sx.person.name, ep: t('ep', { n: pt.episode }), a: pt.started, b: pt.suffered,
    s: signed(pt.balance), first: t('ep', { n: eps[0] }), prev: signed(prev), op: pt.balance < 0 ? '−' : '+', abs: Math.abs(pt.balance), cum: signed(pt.cum) });
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
    k.appendChild(document.createTextNode(t('tlStarts', { name: p.short })));
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
    minOverlap: $('f-min').value };
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
  if (loadedSrc !== src) {
    player.src = src; loadedSrc = src;
    await new Promise(res => {
      const done = () => { player.removeEventListener('loadedmetadata', done); res(); };
      player.addEventListener('loadedmetadata', done); player.addEventListener('error', done, { once: true });
    });
  }
  try { player.currentTime = clip ? 0 : Math.max(0, r.seconds - 3); await player.play(); } catch (err) { console.error(err); stopPlaying(); }
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
  const li1 = el('li', {}, list); el('b', { style: `color:${a.color}` }, li1, a.short); li1.append(t('exScores'));
  el('i', {}, li1, t('exStarted')); li1.append('.');
  const li2 = el('li', {}, list); el('b', { style: `color:${b.color}` }, li2, b.short); li2.append(t('exScores'));
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
      who.appendChild(document.createTextNode(name));
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
  $('events-count').textContent = t('eventsCount', { n: rows.length, more: rows.length === 500 });
  const table = $('events');
  table.replaceChildren();
  const head = el('tr', {}, el('thead', {}, table));
  [['thEp', 1], ['thTime', 1], ['thTalksOver'], ['thGets'], ['thOverlap', 1], ['thHear']].forEach(([k, isNum]) =>
    el('th', { class: isNum ? 'num' : '' }, head, t(k)));
  const body = el('tbody', {}, table);
  if (!rows.length) el('td', { colspan: '6', class: 'empty' }, el('tr', {}, body), t('noMatch'));
  for (const r of rows) {
    const tr = el('tr', { id: `ev-${r.episode}-${r.seconds}` }, body);
    el('td', { class: 'num' }, tr, String(r.episode));
    el('td', { class: 'num', title: `${r.seconds} s` }, tr, r.time);
    for (const name of [r.starter, r.overlapped]) {
      const td = el('td', {}, tr), who = el('span', { class: 'who' }, td);
      el('span', { class: 'dot', style: `background:${byName[name]?.color || '#999'}` }, who);
      who.appendChild(document.createTextNode(name));
    }
    el('td', { class: 'num' }, tr, r.overlap_s === null ? '–' : num(r.overlap_s, 2));
    const cell = el('td', { class: 'cmd' }, tr);
    playButton(cell, 'play', 'listen', r, t('listenTip', { time: r.time, ep: r.episode }));
  }
}

function fillFilterOptions() {
  const ep = $('f-episode'), keepEp = ep.value;
  ep.replaceChildren();
  el('option', { value: '' }, ep, t('fAsAbove'));
  for (const n of EPISODE_IDS) el('option', { value: String(n) }, ep, t('episodeN', { n }));
  ep.value = keepEp;
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
  for (const id of ['f-episode', 'f-starter', 'f-overlapped', 'f-min']) $(id).addEventListener('change', () => renderTable(() => true));
  $('f-clear').addEventListener('click', () => {
    for (const id of ['f-episode', 'f-starter', 'f-overlapped', 'f-min']) $(id).value = '';
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
