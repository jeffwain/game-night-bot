/* Geekgroup CSV export -> the same clean library the JSON path produces.
 *
 * Why bother with a second parser: the CSV is the only export that covers the
 * whole collection in one file, with no token and no crawl. What it costs is
 * the per-person detail. The JSON gives arrays of BGG user ids for ownership
 * and a map of who rated what; the CSV gives an owner *count* and a single
 * group rating, so:
 *
 *   status.own        empty -- owner_count carries the number instead
 *   rating.average    null  -- no per-member ratings to average
 *   rating.users      empty
 *   plays.last_play   null  -- only a play count survives the export
 *   published         null  -- not a column
 *   expansions        flat  -- no parent link, so expansions stay their own rows
 *
 * In exchange it carries weight, player counts and playing time for every game,
 * which the JSON has too but only for the pages you actually fetched.
 */

// Columns as the export writes them, mapped to the keys used below.
const COLUMNS = {
  'Game ID': 'id',
  'Name': 'name',
  'Expansion': 'expansion',
  'Owners': 'owners',
  'Min Players': 'players_min',
  'Max Players': 'players_max',
  'Recommended Players': 'players_recommended',
  'Best Players': 'players_best',
  'Min Duration': 'time_min',
  'Max Duration': 'time_max',
  'Weight': 'weight',
  'Plays': 'plays',
  'Group Rating': 'group_rating',
  'Group Votes': 'group_votes',
  'BGG Rating': 'bgg_rating',
  'Rank': 'rank',
  'Estimated Value': 'value'
};

const STATUS_KEYS = [
  'own', 'prev_owned', 'for_trade', 'want', 'want_to_play',
  'want_to_buy', 'wishlist', 'preordered', 'has_parts', 'want_parts'
];

// RFC4180-ish, which is all this export needs: quoted fields, doubled quotes
// inside them, commas inside quotes ("3,4,5" for recommended player counts).
// Small enough to keep, and a CSV dependency for one file would be silly.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];

    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else field += c;
      continue;
    }

    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') {
      row.push(field);
      field = '';
      if (row.some(v => v !== '')) rows.push(row);
      row = [];
      continue;
    }
    field += c;
  }

  row.push(field);
  if (row.some(v => v !== '')) rows.push(row);
  return rows;
}

// The export writes "-" for "no value", which is not zero and not empty.
function num(value) {
  const text = String(value ?? '').trim();
  if (!text || text === '-') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function numList(value) {
  return String(value ?? '')
    .split(',')
    .map(v => Number(v.trim()))
    .filter(Number.isFinite);
}

function emptyStatus() {
  return Object.fromEntries(STATUS_KEYS.map(k => [k, []]));
}

/**
 * @param {string}   text     raw CSV file contents
 * @param {object[]} _players db.json player records. Ignored: the CSV has no
 *                            per-person data to join to. Accepted anyway so
 *                            both sources share one call signature.
 * @returns {{synced_at: string, source: string, users: object[], games: object[]}}
 */
export function normalizeCsv(text, _players = [], { source = 'csv', syncedAt = new Date() } = {}) {
  const rows = parseCsv(String(text ?? ''));
  if (!rows.length) throw new Error('The CSV is empty.');

  const header = rows[0].map(h => COLUMNS[h.trim()] || h.trim());
  if (!header.includes('id') || !header.includes('name')) {
    throw new Error('That CSV has no "Game ID" and "Name" columns, so it is not a Geekgroup export.');
  }

  const games = [];
  const seen = new Set();

  for (const row of rows.slice(1)) {
    const record = {};
    header.forEach((key, i) => { record[key] = row[i]; });

    const id = num(record.id);
    if (id === null || seen.has(id)) continue;
    seen.add(id);

    const name = String(record.name ?? '').trim();
    games.push({
      id,
      name,
      // The export carries one name per game, so there is nothing to hold apart.
      original_name: name,
      published: null,
      is_expansion: String(record.expansion ?? '').trim().toUpperCase() === 'Y',
      status: emptyStatus(),
      // The one thing the CSV knows about ownership. The panel shows this when
      // status.own is empty rather than claiming nobody owns the game.
      owner_count: num(record.owners) ?? 0,
      rating: {
        average: null,
        bgg_average: num(record.bgg_rating),
        group_average: num(record.group_rating),
        rating_count: 0,
        group_votes: num(record.group_votes) ?? 0,
        users: {}
      },
      plays: {
        last_play: null,
        total_plays: num(record.plays) ?? 0,
        users: {}
      },
      details: {
        players_min: num(record.players_min),
        players_max: num(record.players_max),
        players_best: numList(record.players_best),
        players_recommended: numList(record.players_recommended),
        time_min: num(record.time_min),
        time_max: num(record.time_max),
        weight: num(record.weight),
        rank: num(record.rank) || null,
        value: num(record.value)
      },
      // No parent/child link survives the export, so expansions stand alone.
      expansions: []
    });
  }

  games.sort((a, b) => a.name.localeCompare(b.name));

  return {
    synced_at: (syncedAt instanceof Date ? syncedAt : new Date(syncedAt)).toISOString(),
    source,
    // Nobody to list: the CSV never names the members it counted.
    users: [],
    games
  };
}
