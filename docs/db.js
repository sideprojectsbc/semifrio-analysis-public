// db.js: puts the pipeline's output files into DuckDB tables.
//
// This file does not care *which* DuckDB it talks to. It receives a small object `db` with two functions:
//   db.query(sql)              -> Promise of a list of rows (plain JS objects)
//   db.registerText(name, txt) -> Promise; makes a text file called `name` visible to DuckDB
// In the browser that object wraps DuckDB-WASM (see app.js); in tests it can wrap the same engine in Node,
// so the SQL in queries.js is exactly the SQL the page runs.
//
// Tables (all with an `episode` column, so episodes can be combined):
//   people     the panel: key, full name, short name, moderator?
//   episodes   one row per episode: RTP id, length in minutes (from the audio), audio file   <- episode.json
//   overlap_events  one row per overlap (>= 0.3 s of two people talking at once)                  <- overlaps.csv
//   talk_time  minutes and turns per person                                                  <- talk_time.csv
//   topics     optional: which topic runs from start_s to end_s                              <- topics.csv
//   floor_events  every overlap again, with whose turn it was (the owner) and what kind          <- floor_events.csv
//   floor_slots   one row per turn the moderator gave a panelist: floor time and speech            <- floor_slots.csv

// The panel, in the order used everywhere (moderator first). `name` is spelled exactly as in the CSV files.
// photo: file in ui/assets/people/ (null = not supplied yet, the page draws initials instead).
export const PEOPLE = [
  { key: 'nobre',           name: 'Maria Nobre',               short: 'Nobre',           role: 'Moderator', color: '#dfe6ff', photo: null,                  moderator: true },
  { key: 'castello_branco', name: 'Maria Castello Branco',     short: 'Castello Branco', role: 'Panelist',  color: '#ff6b81', photo: 'castello_branco.png', moderator: false },
  { key: 'brinca',          name: 'Pedro Brinca',              short: 'Brinca',          role: 'Panelist',  color: '#2db7ff', photo: 'brinca.jpg',          moderator: false },
  { key: 'aguiar_conraria', name: 'Luís Aguiar-Conraria',      short: 'Aguiar-Conraria', role: 'Panelist',  color: '#ffb347', photo: 'aguiar_conraria.png', moderator: false },
  { key: 'carrapatoso',     name: 'Miguel Santos Carrapatoso', short: 'Carrapatoso',     role: 'Panelist',  color: '#a98bff', photo: 'carrapatoso.jpg',     moderator: false },
];

export const EPISODE_IDS = [1, 2, 3, 4, 5, 6, 7];
export const FILES = ['episode.json', 'overlaps.csv', 'talk_time.csv', 'topics.csv', 'floor_events.csv', 'floor_slots.csv'];

// Write a text value as an SQL string literal: O'Neil -> 'O''Neil'.
export const sqlString = s => `'${String(s).replace(/'/g, "''")}'`;

export async function createSchema(db) {
  const peopleRows = PEOPLE.map((p, i) =>
    `(${sqlString(p.key)}, ${sqlString(p.name)}, ${sqlString(p.short)}, ${i + 1}, ${p.moderator})`).join(',\n  ');
  await db.query(`
CREATE OR REPLACE TABLE people (key VARCHAR, name VARCHAR, short VARCHAR, ord INTEGER, moderator BOOLEAN);
INSERT INTO people VALUES
  ${peopleRows};

CREATE OR REPLACE TABLE episodes (episode INTEGER, rtp_id VARCHAR, length_min DOUBLE, audio_file VARCHAR);

CREATE OR REPLACE TABLE overlap_events (
  episode INTEGER, seconds DOUBLE, time VARCHAR, starter VARCHAR, overlapped VARCHAR,
  overlap_s DOUBLE, context VARCHAR, confidence INTEGER);

CREATE OR REPLACE TABLE talk_time (episode INTEGER, speaker VARCHAR, minutes DOUBLE, turns INTEGER);

CREATE OR REPLACE TABLE topics (episode INTEGER, start_s DOUBLE, end_s DOUBLE, topic VARCHAR);

CREATE OR REPLACE TABLE floor_events (
  episode INTEGER, seconds DOUBLE, time VARCHAR, topic VARCHAR, owner VARCHAR, starter VARCHAR, overlapped VARCHAR,
  overlap_s DOUBLE, class VARCHAR, detail VARCHAR);

CREATE OR REPLACE TABLE floor_slots (
  episode INTEGER, topic VARCHAR, owner VARCHAR, floor_s DOUBLE, owner_speech_s DOUBLE, kind VARCHAR);
`);
}

// Loads the files of one episode. `files` maps a file name to its text; missing files are left out.
// Rows already loaded for this episode are replaced, so loading twice is safe. Returns the loaded file names.
export async function loadEpisode(db, episode, files) {
  const ep = Number(episode);
  const loaded = [];
  // Each file is also registered as "ep<N>_<file name>" so the SQL box can read the raw file:
  //   FROM 'ep5_overlaps.csv'
  const register = async (file, text) => {
    const name = `ep${ep}_${file}`;
    // The pipeline writes CSVs "with BOM" (an invisible first character, for Excel): remove it.
    await db.registerText(name, text.replace(/^﻿/, ''));
    loaded.push(file);
    return sqlString(name);
  };
  // all_varchar: read every column as text, then convert with TRY_CAST, so DuckDB never guesses a type wrongly.
  const csv = name => `read_csv(${name}, header = true, all_varchar = true)`;

  if (files['episode.json'] !== undefined) {
    await register('episode.json', files['episode.json']);
    const j = JSON.parse(files['episode.json']);
    await db.query(`
DELETE FROM episodes WHERE episode = ${ep};
INSERT INTO episodes VALUES (${ep}, ${sqlString(j.rtp_id)}, ${Number(j.length_min)}, ${sqlString(j.audio_file)});`);
  }
  if (files['overlaps.csv'] !== undefined) {
    const f = await register('overlaps.csv', files['overlaps.csv']);
    await db.query(`
DELETE FROM overlap_events WHERE episode = ${ep};
INSERT INTO overlap_events
SELECT ${ep}, TRY_CAST(seconds AS DOUBLE), time, starter, overlapped, TRY_CAST(overlap_s AS DOUBLE), context,
       TRY_CAST(confidence AS INTEGER)
FROM ${csv(f)};`);
  }
  if (files['talk_time.csv'] !== undefined) {
    const f = await register('talk_time.csv', files['talk_time.csv']);
    await db.query(`
DELETE FROM talk_time WHERE episode = ${ep};
INSERT INTO talk_time SELECT ${ep}, speaker, TRY_CAST(minutes AS DOUBLE), TRY_CAST(turns AS INTEGER)
FROM ${csv(f)};`);
  }
  if (files['topics.csv'] !== undefined) {
    // columns: start_s, end_s, topic  (seconds from the start of the episode)
    const f = await register('topics.csv', files['topics.csv']);
    await db.query(`
DELETE FROM topics WHERE episode = ${ep};
INSERT INTO topics SELECT ${ep}, TRY_CAST(start_s AS DOUBLE), TRY_CAST(end_s AS DOUBLE), topic FROM ${csv(f)};`);
  }
  if (files['floor_events.csv'] !== undefined) {
    const f = await register('floor_events.csv', files['floor_events.csv']);
    await db.query(`
DELETE FROM floor_events WHERE episode = ${ep};
INSERT INTO floor_events
SELECT ${ep}, TRY_CAST(seconds AS DOUBLE), time, topic, owner, starter, overlapped, TRY_CAST(overlap_s AS DOUBLE), class, detail
FROM ${csv(f)};`);
  }
  if (files['floor_slots.csv'] !== undefined) {
    const f = await register('floor_slots.csv', files['floor_slots.csv']);
    await db.query(`
DELETE FROM floor_slots WHERE episode = ${ep};
INSERT INTO floor_slots
SELECT ${ep}, topic, owner, TRY_CAST(floor_s AS DOUBLE), TRY_CAST(owner_speech_s AS DOUBLE), kind FROM ${csv(f)};`);
  }
  return loaded;
}

// Names in the data that are not on the panel list (a typo, or a guest). The page shows them as a warning.
export async function unknownNames(db) {
  return db.query(`
SELECT DISTINCT name FROM (SELECT starter AS name FROM overlap_events UNION ALL SELECT overlapped FROM overlap_events
                           UNION ALL SELECT speaker FROM talk_time)
WHERE name NOT IN (SELECT name FROM people) ORDER BY name;`);
}
