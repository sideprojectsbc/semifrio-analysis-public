// queries.js: every number on the page comes from one of these SQL strings (shown under each chart).
// `f` is the current filter: { episode: number | null, noMod: boolean }.
import { PEOPLE, sqlString } from './db.js';

const MOD = PEOPLE.find(p => p.moderator).name;
// "WHERE ..." pieces. noMod removes every overlap in which the moderator takes part (on either side).
const epWhere = (f, col = 'episode') => (f.episode === null ? 'TRUE' : `${col} = ${Number(f.episode)}`);
const modWhere = (f, p = '') => (f.noMod ? `AND ${p}starter <> ${sqlString(MOD)} AND ${p}overlapped <> ${sqlString(MOD)}` : '');

// 1. One row per episode, always in two parts: overlaps between panelists, and overlaps in which the moderator takes
//    part (on either side). `per_10min_*` = per 10 minutes of the episode (its clock length, not talking time).
export const episodesSql = () => `
SELECT e.episode, e.length_min,
       COUNT(o.seconds) FILTER (WHERE o.starter <> ${sqlString(MOD)} AND o.overlapped <> ${sqlString(MOD)})::INTEGER AS n_panel,
       COUNT(o.seconds) FILTER (WHERE o.starter = ${sqlString(MOD)} OR o.overlapped = ${sqlString(MOD)})::INTEGER   AS n_mod,
       ROUND(COUNT(o.seconds) FILTER (WHERE o.starter <> ${sqlString(MOD)} AND o.overlapped <> ${sqlString(MOD)}) / e.length_min * 10, 1) AS per_10min_panel,
       ROUND(COUNT(o.seconds) FILTER (WHERE o.starter = ${sqlString(MOD)} OR o.overlapped = ${sqlString(MOD)}) / e.length_min * 10, 1)   AS per_10min_mod,
       ROUND(COUNT(o.seconds) / e.length_min * 10, 1)                                                                              AS per_10min_all,
       ROUND(COALESCE(SUM(o.overlap_s) FILTER (WHERE o.starter <> ${sqlString(MOD)} AND o.overlapped <> ${sqlString(MOD)}), 0))::INTEGER AS seconds_panel
FROM episodes e
LEFT JOIN overlap_events o ON o.episode = e.episode
GROUP BY e.episode, e.length_min
ORDER BY e.episode;`;

// 2. One row per person: minutes spoken, overlaps they started / suffered, and both per 10 min of their speaking.
export const peopleSql = f => `
WITH started AS (SELECT starter AS name, COUNT(*) AS n FROM overlap_events
                 WHERE ${epWhere(f)} ${modWhere(f)} GROUP BY 1),
     suffered AS (SELECT overlapped AS name, COUNT(*) AS n FROM overlap_events
                 WHERE ${epWhere(f)} ${modWhere(f)} GROUP BY 1),
     spoken AS (SELECT speaker AS name, SUM(minutes) AS minutes, SUM(turns) AS turns FROM talk_time
                 WHERE ${epWhere(f)} GROUP BY 1)
SELECT p.key, p.name, p.short, p.moderator,
       ROUND(COALESCE(sp.minutes, 0), 1)                          AS minutes,
       COALESCE(sp.turns, 0)::INTEGER                             AS turns,
       COALESCE(s.n, 0)::INTEGER                                  AS started,
       COALESCE(b.n, 0)::INTEGER                                  AS suffered,
       ROUND(COALESCE(s.n, 0) / NULLIF(sp.minutes, 0) * 10, 1)    AS started_per_10min,
       ROUND(COALESCE(b.n, 0) / NULLIF(sp.minutes, 0) * 10, 1)    AS suffered_per_10min
FROM people p
LEFT JOIN started s ON s.name = p.name
LEFT JOIN suffered b ON b.name = p.name
LEFT JOIN spoken sp ON sp.name = p.name
ORDER BY p.ord;`;

// 3. Who talks over whom: starter (row) x overlapped (column).
export const matrixSql = f => `
SELECT starter, overlapped, COUNT(*)::INTEGER AS n FROM overlap_events
WHERE ${epWhere(f)} ${modWhere(f)}
GROUP BY 1, 2;`;

// 4. Each person, episode by episode (the evolution): overlaps started / suffered, as a count and per 10 min of speaking.
export const personEvolutionSql = f => `
WITH s AS (SELECT episode, starter AS name, COUNT(*) AS n FROM overlap_events WHERE TRUE ${modWhere(f)} GROUP BY 1, 2),
     b AS (SELECT episode, overlapped AS name, COUNT(*) AS n FROM overlap_events WHERE TRUE ${modWhere(f)} GROUP BY 1, 2)
SELECT t.episode, p.key, p.name,
       COALESCE(s.n, 0)::INTEGER AS started, COALESCE(b.n, 0)::INTEGER AS suffered,
       ROUND(COALESCE(s.n, 0) / NULLIF(t.minutes, 0) * 10, 1) AS started_per_10min,
       ROUND(COALESCE(b.n, 0) / NULLIF(t.minutes, 0) * 10, 1) AS suffered_per_10min
FROM talk_time t
JOIN people p ON p.name = t.speaker
LEFT JOIN s ON s.episode = t.episode AND s.name = t.speaker
LEFT JOIN b ON b.episode = t.episode AND b.name = t.speaker
ORDER BY t.episode, p.ord;`;

// 5. Timeline: every overlap of one episode (drawn as a tick), and the topics if a topics.csv exists.
export const timelineSql = (ep, f) => `
SELECT seconds, time, starter, overlapped, overlap_s FROM overlap_events
WHERE episode = ${Number(ep)} ${modWhere(f)}
ORDER BY seconds;`;
export const topicsOfEpisodeSql = ep => `
SELECT start_s, end_s, topic FROM topics WHERE episode = ${Number(ep)} ORDER BY start_s;`;

// 6. Topics: minutes each topic lasts in its episode, overlaps inside it, and overlaps per 10 minutes of that topic.
//    One row per topic AND episode (the same person can be a topic in two episodes), labelled "Name (Ep N)".
export const topicsSql = f => `
WITH t AS (SELECT episode, topic, SUM(end_s - start_s) / 60 AS minutes FROM topics WHERE ${epWhere(f)} GROUP BY 1, 2),
     o AS (SELECT t.episode, t.topic, COUNT(*) AS n
           FROM topics t JOIN overlap_events o ON o.episode = t.episode AND o.seconds >= t.start_s AND o.seconds < t.end_s
           WHERE ${epWhere(f, 't.episode')} ${modWhere(f, 'o.')}
           GROUP BY 1, 2)
SELECT t.topic AS name, t.episode, ROUND(t.minutes, 1) AS minutes,
       COALESCE(o.n, 0)::INTEGER AS n, ROUND(COALESCE(o.n, 0) / t.minutes * 10, 1) AS per_10min
FROM t LEFT JOIN o USING (episode, topic)
ORDER BY per_10min DESC;`;

// 7. The event table, with the file to listen to.
export function eventsSql(f) {
  // f.eventEpisode (the table's own episode filter) wins over the page's episode selector
  const w = [f.eventEpisode ? `o.episode = ${Number(f.eventEpisode)}` : epWhere(f, 'o.episode')];
  if (f.noMod) w.push(`o.starter <> ${sqlString(MOD)}`, `o.overlapped <> ${sqlString(MOD)}`);
  if (f.starter) w.push(`o.starter = ${sqlString(f.starter)}`);
  if (f.overlapped) w.push(`o.overlapped = ${sqlString(f.overlapped)}`);
  if (f.minOverlap) w.push(`o.overlap_s >= ${Number(f.minOverlap)}`);
  if (f.maxConf) w.push(`o.confidence < ${Number(f.maxConf)}`);   // review: only the less certain attributions
  return `
SELECT o.episode, o.seconds, o.time, o.starter, o.overlapped, o.overlap_s, o.confidence, e.audio_file
FROM overlap_events o JOIN episodes e USING (episode)
WHERE ${w.join('\n  AND ')}
ORDER BY o.episode, o.seconds
LIMIT 500;`;
}

// The example moment: a checked overlap (ep 5, ~24:47, Castello Branco over Brinca); any panelist overlap if absent.
export const exampleSql = () => `
SELECT o.episode, o.seconds, o.time, o.starter, o.overlapped, o.overlap_s, e.audio_file
FROM overlap_events o JOIN episodes e USING (episode)
WHERE o.starter <> ${sqlString(MOD)} AND o.overlapped <> ${sqlString(MOD)}
ORDER BY (o.episode = 5 AND o.starter = 'Maria Castello Branco' AND o.overlapped = 'Pedro Brinca' AND abs(o.seconds - 1487) < 3) DESC,
         o.overlap_s DESC
LIMIT 1;`;

// The worked example of the methodology: a back-and-forth in episode 2 (about 37:19 to 37:29), shown whatever the switches say.
export const methodExampleSql = () => `
SELECT o.episode, o.seconds, o.time, o.starter, o.overlapped, o.overlap_s, e.audio_file
FROM overlap_events o JOIN episodes e USING (episode)
WHERE o.episode = 2 AND o.seconds BETWEEN 2235 AND 2255
ORDER BY o.seconds;`;

// 8. The floor layer: who had the word. Per panelist, over the slots the moderator gave (floor_slots) and the overlaps placed
//    in them (floor_events). received = someone talked over him while it was his turn (took = and he lost the word);
//    made = he talked over someone else's turn; recovered = he took his own word back. Rates: received per 10 min of his own
//    floor speech, made per 10 min of the OTHER panelists' floor speech (the time he could have talked over them).
export const floorSql = f => `
WITH slots AS (SELECT owner AS name, SUM(owner_speech_s) / 60 AS minutes FROM floor_slots WHERE ${epWhere(f)} GROUP BY 1),
     total AS (SELECT COALESCE(SUM(minutes), 0) AS m FROM slots),
     ev AS (SELECT owner, starter, class FROM floor_events WHERE ${epWhere(f)})
SELECT p.key, p.name, p.short,
       ROUND(COALESCE(s.minutes, 0), 1)                                                         AS floor_min,
       ROUND((SELECT m FROM total) - COALESCE(s.minutes, 0), 1)                                 AS others_min,
       (SELECT COUNT(*) FROM ev WHERE owner = p.name AND class LIKE 'intrusion%')::INTEGER      AS received,
       (SELECT COUNT(*) FROM ev WHERE owner = p.name AND class = 'intrusion_takeover')::INTEGER AS took,
       (SELECT COUNT(*) FROM ev WHERE starter = p.name AND class LIKE 'intrusion%')::INTEGER    AS made,
       (SELECT COUNT(*) FROM ev WHERE owner = p.name AND class = 'recovery')::INTEGER           AS recovered,
       ROUND((SELECT COUNT(*) FROM ev WHERE owner = p.name AND class LIKE 'intrusion%') / NULLIF(s.minutes, 0) * 10, 1)                       AS received_per_10min,
       ROUND((SELECT COUNT(*) FROM ev WHERE starter = p.name AND class LIKE 'intrusion%') / NULLIF((SELECT m FROM total) - s.minutes, 0) * 10, 1) AS made_per_10min
FROM people p LEFT JOIN slots s ON s.name = p.name
WHERE NOT p.moderator
ORDER BY p.ord;`;

// 8b. What happens to the 3 in 4 overlaps that are not between panelists: the share of each kind, for the explanation.
export const floorKindsSql = f => `
SELECT CASE WHEN class LIKE 'intrusion%' THEN 'intrusion' ELSE class END AS kind, COUNT(*)::INTEGER AS n
FROM floor_events WHERE ${epWhere(f)} GROUP BY 1 ORDER BY n DESC;`;
