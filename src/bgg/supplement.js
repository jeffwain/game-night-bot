/* Fill a BGG library's gaps from a Geekgroup dump.
 *
 * The two sources answer different questions and neither is complete:
 *
 *   BGG XML API2   artwork, and per-person ownership/wishlist/prev-owned for
 *                  every linked account. Its /collection endpoint has no
 *                  weight, no community best/recommended counts and no
 *                  estimated value — those live on /thing, one request per
 *                  twenty games, which for this library is eighty-odd requests
 *                  at a five-second pause apiece.
 *   Geekgroup      exactly those four fields for the whole group in one crawl,
 *                  plus the group's own rating. No artwork at all.
 *
 * So BGG is the primary source and this is the optional second pass, never the
 * other way round: a supplement may fill a hole and refresh the group rating,
 * and may not touch anything the primary source is the authority on. Ownership
 * in particular — the Geekgroup dump covers everyone in the group, including
 * people who are not in this Discord, and letting it write status would put
 * strangers' names in the Owned by column.
 *
 * Pure: no I/O, no clock. The caller decides where the pages came from.
 */

import { normalize } from './normalize.js';

// Filled only when the primary source left the field empty.
const GAP_FILL_DETAILS = ['weight', 'value', 'rank', 'players_best', 'players_recommended'];

// Geekgroup writes "no answer" as 0 for these, so 0 has to read as absent or
// every unrated game arrives claiming a weight of zero.
function positiveOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isBlank(value) {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function numberList(value) {
  return Array.isArray(value) ? value.map(Number).filter(Number.isFinite) : [];
}

function supplementDetails(base = {}, from = {}) {
  const details = { ...base };
  for (const key of GAP_FILL_DETAILS) {
    if (!isBlank(details[key])) continue;
    const incoming = key === 'players_best' || key === 'players_recommended'
      ? numberList(from[key])
      : positiveOrNull(from[key]);
    if (isBlank(incoming)) continue;
    details[key] = incoming;
  }
  return details;
}

function supplementGame(game, from) {
  const rating = { ...game.rating };
  // Not a gap-fill. BGG has no concept of this group, so whatever is here came
  // from an earlier supplement and may be stale — a rating that moved since
  // should move here too. But only a real answer replaces it: one page of a
  // thirteen-page crawl has no rating for most games, and applying it after a
  // full CSV must not quietly blank everything that page did not mention.
  const groupAverage = positiveOrNull(from.rating?.group_average);
  if (groupAverage !== null) {
    rating.group_average = groupAverage;
    rating.group_votes = Number(from.rating?.group_votes) || 0;
  }
  return {
    ...game,
    details: supplementDetails(game.details, from.details),
    rating
  };
}

/**
 * @param {object} library    a BGG (or CSV/import) library payload — the primary
 * @param {object} supplementLibrary a normalized Geekgroup payload, or null
 * @returns {object} a new payload; `library` is never modified in place
 */
export function supplement(library, supplementLibrary) {
  const base = library || { games: [] };
  const incoming = (supplementLibrary?.games || []);
  if (!incoming.length) return base;

  const byId = new Map();
  for (const game of incoming) {
    const id = Number(game?.id);
    if (Number.isFinite(id)) byId.set(id, game);
  }

  let matched = 0;
  const games = (base.games || []).map(game => {
    const from = byId.get(Number(game.id));
    if (!from) return game;
    matched += 1;
    return supplementGame(game, from);
  });

  return {
    ...base,
    games,
    supplement_source: supplementLibrary.source || 'geekgroup',
    supplemented_at: supplementLibrary.synced_at || null,
    supplemented_count: matched
  };
}

/**
 * Same thing, from raw Geekgroup page bodies. Saves every caller from having to
 * know that normalize() is the step in between.
 *
 * @param {object}   library
 * @param {object[]} pages  raw collection.json page bodies
 */
export function supplementFromPages(library, pages, { players = [] } = {}) {
  const list = Array.isArray(pages) ? pages.filter(Boolean) : [];
  if (!list.length) return library;
  return supplement(library, normalize(list, players, { source: 'geekgroup' }));
}
