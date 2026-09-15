/* Geekgroup collection payload -> our clean game library.
 *
 * Pure: no I/O, no network, no clock beyond the timestamp handed in. That is
 * deliberate. Raw pages are archived verbatim under data/bgg-raw/ before this
 * runs, so surfacing a field we skipped today (weight, player counts, playing
 * time, the community best/recommended vote tallies) is a re-parse of files we
 * already have rather than another 13-page crawl of somebody elses server.
 *
 * The source is Geekgroup (api.geekgroup.app), which aggregates the BGG
 * collections of everyone in the group. Its ids are BGG ids throughout -- game
 * ids and user ids alike -- so nothing here invents an id space of its own.
 */

// The payload writes these run together; the library spells them out.
const STATUS_KEYS = {
  own: 'own',
  prevowned: 'prev_owned',
  fortrade: 'for_trade',
  want: 'want',
  wanttoplay: 'want_to_play',
  wanttobuy: 'want_to_buy',
  wishlist: 'wishlist',
  preordered: 'preordered',
  hasparts: 'has_parts',
  wantparts: 'want_parts'
};

// PHP-ish JSON: an empty map serializes as [] rather than {}. Every keyed
// lookup in here has to survive that, or it starts reading array indices as
// user ids.
function asMap(value) {
  if (!value || Array.isArray(value)) return {};
  return value;
}

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

// play_last arrives as unix epoch seconds, and as a *string* at that. Format in
// UTC: the source has no timezone to offer, so inventing a local one would just
// move half the dates a day backwards.
function epochToIsoDate(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function mean(values) {
  if (!values.length) return null;
  const sum = values.reduce((a, b) => a + b, 0);
  return Math.round((sum / values.length) * 100) / 100;
}

// -------------------------------------------------------------
// INDEXES
// -------------------------------------------------------------

// Every object carrying a .game, wherever it appeared. `collection` entries are
// the only ones eligible to become rows; data.nested and data.contains are
// support cast -- expansions and box-set contents pulled in so their names
// resolve, never listed in their own right.
function collectEntries(pages) {
  const entries = new Map();

  const add = (entry, fromCollection) => {
    if (!entry || !entry.game || !Number.isFinite(Number(entry.game.id))) return;
    const id = Number(entry.game.id);
    const existing = entries.get(id);
    // A collection entry is richer than the side-table copy of the same game,
    // so it wins; otherwise first sighting wins.
    if (existing && !(fromCollection && !existing.fromCollection)) return;
    entries.set(id, { entry, fromCollection });
  };

  for (const page of pages) {
    for (const entry of asList(page?.collection)) add(entry, true);
    for (const entry of asList(page?.data?.nested)) add(entry, false);
    for (const entry of asList(page?.data?.contains)) add(entry, false);
  }
  return entries;
}

function collectNames(pages, entries) {
  const names = new Map();
  for (const page of pages) {
    for (const g of asList(page?.data?.games)) {
      if (g && g.id != null && g.name) names.set(Number(g.id), String(g.name));
    }
  }
  // data.games is only an index of what the page happened to reference; the
  // entries themselves are the authority on their own name.
  for (const [id, { entry }] of entries) {
    const name = entry.game.rename || entry.game.name;
    if (name) names.set(id, String(name));
  }
  return names;
}

function collectUsers(pages) {
  const users = new Map();
  for (const page of pages) {
    for (const u of asList(page?.data?.users)) {
      if (u && u.id != null) users.set(Number(u.id), u);
    }
  }
  return users;
}

// Two different ways the payload says "this belongs under that":
//   entry.nested[]        -- expansions rolled up under their base game
//   entry.game.contains[] -- what a big box physically contains
// Both mean the child should not be its own row. First claim wins, so a game
// claimed by its base game is not re-parented by a box set that also lists it.
//
// Only expansions are ever absorbed. A big box lists the base game among its
// contents too, and letting that stand would delete Carcassonne from the
// library the moment somebody owns Carcassonne Big Box.
function collectParents(entries) {
  const parentOf = new Map();
  const claim = (childId, parentId) => {
    const id = Number(childId);
    if (!Number.isFinite(id) || id === parentId || parentOf.has(id)) return;
    if (Number(entries.get(id)?.entry?.game?.type) !== 2) return;
    parentOf.set(id, parentId);
  };
  for (const [id, { entry }] of entries) {
    for (const childId of asList(entry.nested)) claim(childId, id);
    for (const childId of asList(entry.game.contains)) claim(childId, id);
  }
  return parentOf;
}

// -------------------------------------------------------------
// PER-GAME NORMALIZATION
// -------------------------------------------------------------

function normalizeStatus(rawStatus) {
  const status = {};
  const source = asMap(rawStatus);
  for (const [from, to] of Object.entries(STATUS_KEYS)) {
    // The group view gives arrays of BGG user ids. The requesting users own
    // `user.status` gives 0/1 counts instead -- we never read that one, but
    // guard anyway so a shape change degrades to empty rather than to [0].
    status[to] = asList(source[from]).map(Number).filter(Number.isFinite);
  }
  return status;
}

function normalizeRating(entry, memberIds) {
  const perUser = {};
  for (const [userId, value] of Object.entries(asMap(entry.users?.rated))) {
    const rating = Number(value);
    if (Number.isFinite(rating)) perUser[Number(userId)] = rating;
  }

  // "Average" means *our* average. Restricted to members we have linked to a
  // player, so a Geekgroup that outgrows this Discord does not quietly start
  // averaging in strangers. Before anyone is linked there is nothing to
  // restrict to, so fall back to every rater rather than show a blank column.
  const ours = memberIds.size
    ? Object.entries(perUser).filter(([id]) => memberIds.has(Number(id))).map(([, r]) => r)
    : Object.values(perUser);

  return {
    average: mean(ours),
    bgg_average: numberOrNull(entry.game?.rating_avg),
    group_average: numberOrNull(entry.group?.rating_avg),
    rating_count: Number(entry.game?.rating_count) || 0,
    users: perUser
  };
}

function normalizePlays(entry) {
  const perUser = {};
  for (const [userId, value] of Object.entries(asMap(entry.users?.played))) {
    const plays = Number(value);
    if (Number.isFinite(plays)) perUser[Number(userId)] = plays;
  }
  return {
    last_play: epochToIsoDate(entry.users?.play_last),
    total_plays: Number(entry.users?.totalPlays) || 0,
    users: perUser
  };
}

// Not shown in the table today, but carried so the library can answer "what
// fits five people in under an hour" later without another crawl. The CSV
// export has the same fields, so both sources fill this in identically.
function normalizeDetails(game) {
  const community = game.players_community || {};
  return {
    players_min: Number(game.players_min) || null,
    players_max: Number(game.players_max) || null,
    players_best: asList(community.best).map(Number).filter(Number.isFinite),
    players_recommended: asList(community.recommended).map(Number).filter(Number.isFinite),
    time_min: Number(game.time_min) || null,
    time_max: Number(game.time_max) || null,
    weight: numberOrNull(game.weight_avg),
    rank: Number(game.rank) || null,
    value: numberOrNull(game.worth?.value)
  };
}

function normalizeGame(entry, memberIds) {
  const game = entry.game;
  const status = normalizeStatus(entry.users?.status);
  return {
    id: Number(game.id),
    // A group can rename a game locally; that is the name they would search for.
    name: String(game.rename || game.name || '').trim(),
    original_name: String(game.originalName || game.name || '').trim(),
    published: Number(game.published) || null,
    is_expansion: Number(game.type) === 2,
    status,
    // Redundant here, where status.own names everyone -- but the CSV export can
    // only give a count, and the panel reads one field either way.
    owner_count: status.own.length,
    rating: normalizeRating(entry, memberIds),
    plays: normalizePlays(entry),
    details: normalizeDetails(game),
    expansions: []
  };
}

// -------------------------------------------------------------
// ENTRY POINT
// -------------------------------------------------------------

/**
 * @param {object[]} pages   raw Geekgroup collection.json page bodies, in order
 * @param {object[]} players db.json player records, for the BGG <-> Discord join
 * @returns {{synced_at: string, source: string, users: object[], games: object[]}}
 */
export function normalize(pages, players = [], { source = 'geekgroup', syncedAt = new Date() } = {}) {
  const list = asList(pages).filter(Boolean);
  const entries = collectEntries(list);
  const names = collectNames(list, entries);
  const rawUsers = collectUsers(list);
  const parentOf = collectParents(entries);

  const discordByBggId = new Map();
  for (const p of asList(players)) {
    if (p?.bgg_user_id != null && p.discord_id) {
      discordByBggId.set(Number(p.bgg_user_id), String(p.discord_id));
    }
  }
  // Number(null) is 0 and 0 is finite, so an unlinked roster would otherwise
  // produce a set of zeroes -- non-empty, matching nobody, and every average
  // silently blank.
  const memberIds = new Set(
    asList(players)
      .filter(p => p?.bgg_user_id != null && p.bgg_user_id !== '')
      .map(p => Number(p.bgg_user_id))
      .filter(id => Number.isInteger(id) && id > 0)
  );

  const users = [...rawUsers.values()]
    .map(u => ({
      id: Number(u.id),
      username: String(u.name || ''),
      full_name: String(u.fullname || ''),
      sort_name: String(u.sortname || ''),
      discord: discordByBggId.get(Number(u.id)) || null,
      avatar: u.avatar ? String(u.avatar) : null
    }))
    .sort((a, b) => a.sort_name.localeCompare(b.sort_name));

  const normalized = new Map();
  for (const [id, { entry }] of entries) {
    normalized.set(id, normalizeGame(entry, memberIds));
  }

  // Anything claimed by a parent hangs off that parent instead of standing as
  // its own row -- but only when the parent actually made it into the library.
  // An expansion whose base game nobody owns stays a row rather than vanishing.
  const games = [];
  for (const [id, { fromCollection }] of entries) {
    const game = normalized.get(id);
    const parentId = parentOf.get(id);
    const parent = parentId != null ? normalized.get(parentId) : null;
    if (parent) {
      parent.expansions.push({
        id: game.id,
        name: game.name || names.get(id) || `Game ${id}`,
        published: game.published,
        status: game.status
      });
      continue;
    }
    // Side-table entries exist to give nested items a name. If one is
    // unclaimed it was never part of the collection to begin with.
    if (fromCollection) games.push(game);
  }

  for (const game of games) {
    game.expansions.sort((a, b) => a.name.localeCompare(b.name));
  }
  games.sort((a, b) => a.name.localeCompare(b.name));

  return {
    synced_at: (syncedAt instanceof Date ? syncedAt : new Date(syncedAt)).toISOString(),
    source,
    users,
    games
  };
}
