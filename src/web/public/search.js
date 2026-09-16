/* Fuzzy game-name search, shared by the control panel and the Discord bot.
 *
 * It lives under web/public because the browser has to be able to fetch it by
 * URL; Node can import from anywhere, so the bot reaches in here rather than
 * the two surfaces each growing their own scorer. That matters more than the
 * odd location: a /games command that ranked results differently from the Games
 * tab would be a bug nobody could see, only feel.
 *
 * No DOM, no imports, no Node built-ins -- it has to load in both worlds.
 */

// Below this a match came from the subsequence rule rather than from the name
// actually containing the query.
const SOLID_MATCH = 60;

// An expansion is not a row of its own, so a hit on one has to surface the base
// game. It ranks below a direct hit on the base game's own name.
const EXPANSION_PENALTY = 0.8;

export function foldText(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function scoreName(haystack, needle) {
  if (!haystack || !needle) return 0;
  if (haystack === needle) return 100;
  if (haystack.startsWith(needle)) return 90;
  // A word-boundary hit is what people mean by typing three letters: "rac"
  // should find "1846: The Race for the Midwest".
  if (haystack.split(' ').some(word => word.startsWith(needle))) return 75;
  if (haystack.includes(needle)) return 60;

  // Subsequence, penalised by how spread out the letters are. Two characters
  // match nearly everything this way, so short queries never reach here.
  if (needle.length < 3) return 0;
  let i = 0;
  let first = -1;
  let last = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j += 1) {
    if (haystack[j] === needle[i]) {
      if (first < 0) first = j;
      last = j;
      i += 1;
    }
  }
  if (i < needle.length) return 0;
  const spread = (last - first + 1) / needle.length;
  return Math.max(30, 50 - Math.round(spread * 4));
}

// Currently owned: someone in the collection has own=1, or a CSV counted
// owners without naming them. Wishlist / previously-owned / never-owned are
// still in the synced dump; they are not "what we can put on the table".
export function isOwned(game) {
  if (!game) return false;
  if ((game.status?.own || []).length > 0) return true;
  return Number(game.owner_count) > 0;
}

function keepOwned(game) {
  if (isOwned(game)) return true;
  // An unowned base game still belongs in the owned-only list when someone
  // owns one of its expansions -- otherwise hiding expansions would make
  // that copy unsearchable.
  return (game.expansions || []).some(isOwned);
}

/**
 * Best score for one game, and which expansion earned it if an expansion did.
 * @returns {{score: number, matchedExpansion: string|null}}
 */
export function scoreGame(game, needle) {
  let score = Math.max(
    scoreName(foldText(game.name), needle),
    scoreName(foldText(game.original_name), needle)
  );
  let matchedExpansion = null;

  // Only solid hits count here: a scattered subsequence across a dozen
  // expansion titles matches almost anything, and it would be doing it on the
  // strength of a name that is not even shown in the row.
  for (const expansion of game.expansions || []) {
    const hit = scoreName(foldText(expansion.name), needle);
    if (hit < SOLID_MATCH) continue;
    const weighted = hit * EXPANSION_PENALTY;
    if (weighted > score) {
      score = weighted;
      matchedExpansion = expansion.name;
    }
  }
  return { score, matchedExpansion };
}

/**
 * Rank a library against a query.
 *
 * @param {object[]} games
 * @param {string}   query              blank returns everything, unranked
 * @param {boolean}  [includeExpansions] when false, games that are themselves
 *                   expansions are dropped. A base game found *through* one of
 *                   its expansions still counts -- the answer is the base game.
 * @param {boolean}  [ownedOnly] when true, drop titles nobody currently owns.
 *                   A base game kept because an expansion is owned still
 *                   counts -- hiding expansions must not hide that copy.
 * @returns {{game: object, score: number, matchedExpansion: string|null}[]}
 */
export function searchGames(games, query, { includeExpansions = true, ownedOnly = false } = {}) {
  let pool = includeExpansions
    ? (games || [])
    : (games || []).filter(game => !game.is_expansion);
  if (ownedOnly) pool = pool.filter(keepOwned);

  const needle = foldText(query);
  if (!needle) {
    return pool
      .map(game => ({ game, score: 0, matchedExpansion: null }))
      .sort((a, b) => a.game.name.localeCompare(b.game.name));
  }

  return pool
    .map(game => ({ game, ...scoreGame(game, needle) }))
    .filter(hit => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.game.name.localeCompare(b.game.name));
}
