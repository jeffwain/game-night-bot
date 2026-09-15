/* BoardGameGeek XML API2.
 *
 * Geekgroup is an unofficial scrape whose session cookies expire. This path
 * talks to boardgamegeek.com with a registered application token instead:
 *
 *   Authorization: Bearer <BGG_APP_TOKEN>
 *
 * Host must be boardgamegeek.com, not www — BGG's own docs say the www
 * subdomain silently drops the header. The token is read from the environment
 * and must never appear in thrown errors, logs, or API responses.
 */

const BGG_ORIGIN = 'https://boardgamegeek.com';
const DEFAULT_DELAY_MS = 5000;
const DEFAULT_ATTEMPTS = 6;

const STATUS_KEYS = [
  'own', 'prev_owned', 'for_trade', 'want', 'want_to_play',
  'want_to_buy', 'wishlist', 'preordered', 'has_parts', 'want_parts'
];

export function getAppToken(env = process.env) {
  return String(env.BGG_APP_TOKEN || '').trim();
}

export function authHeaders(token = getAppToken()) {
  if (!token) {
    throw new Error('BGG_APP_TOKEN is not set. Add it to data/.env — see data/.env.template.');
  }
  return {
    Accept: 'application/xml, text/xml',
    Authorization: `Bearer ${token}`
  };
}

export function redact(value, token = getAppToken()) {
  const text = String(value ?? '');
  if (!token) return text;
  return text.split(token).join('[redacted]');
}

export function collectionUrl(username, { stats = true } = {}) {
  const url = new URL(`${BGG_ORIGIN}/xmlapi2/collection`);
  url.searchParams.set('username', String(username || '').trim());
  url.searchParams.set('stats', stats ? '1' : '0');
  return url.toString();
}

export function thingUrl(ids) {
  const url = new URL(`${BGG_ORIGIN}/xmlapi2/thing`);
  url.searchParams.set('id', [...ids].join(','));
  return url.toString();
}

export function userUrl(username) {
  const url = new URL(`${BGG_ORIGIN}/xmlapi2/user`);
  url.searchParams.set('name', String(username || '').trim());
  return url.toString();
}

function decode(text) {
  return String(text ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .trim();
}

function attrs(source) {
  const out = {};
  const re = /([:\w-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(source))) out[m[1].toLowerCase()] = m[2];
  return out;
}

function firstTag(xml, name) {
  const m = String(xml).match(new RegExp(`<${name}\\b([^>]*)(?:/>|>([\\s\\S]*?)</${name}>)`, 'i'));
  if (!m) return { attrs: {}, text: '' };
  return { attrs: attrs(m[1] || ''), text: decode(m[2] || '') };
}

function numberOrNull(value) {
  const text = String(value ?? '').trim();
  if (!text || /^n\/a$/i.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function emptyStatus() {
  return Object.fromEntries(STATUS_KEYS.map(k => [k, []]));
}

function mean(values) {
  if (!values.length) return null;
  const sum = values.reduce((a, b) => a + b, 0);
  return Math.round((sum / values.length) * 100) / 100;
}

/**
 * Parse a /xmlapi2/collection body into the fields we actually store.
 * Ownership is a flag here; toLibrary attaches it to a BGG user id.
 */
export function parseCollectionXml(xml) {
  const items = [];
  const re = /<item\b([^>]*)>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(String(xml)))) {
    const head = attrs(m[1]);
    const body = m[2];
    const id = numberOrNull(head.objectid || head.id);
    if (id === null) continue;

    const name = firstTag(body, 'name');
    const year = firstTag(body, 'yearpublished');
    const stats = firstTag(body, 'stats');
    const rating = firstTag(body, 'rating');
    const average = firstTag(body, 'average');
    const status = firstTag(body, 'status');
    const plays = firstTag(body, 'numplays');
    const subtype = String(head.subtype || head.type || '');

    items.push({
      id,
      name: name.attrs.value || name.text || `Game ${id}`,
      published: numberOrNull(year.attrs.value || year.text),
      is_expansion: /expansion/i.test(subtype),
      own: status.attrs.own === '1',
      rating: numberOrNull(rating.attrs.value),
      bgg_average: numberOrNull(average.attrs.value || average.text),
      numplays: numberOrNull(plays.attrs.value || plays.text) || 0,
      details: {
        players_min: numberOrNull(stats.attrs.minplayers),
        players_max: numberOrNull(stats.attrs.maxplayers),
        players_best: [],
        players_recommended: [],
        time_min: numberOrNull(stats.attrs.minplaytime),
        time_max: numberOrNull(stats.attrs.maxplaytime),
        weight: null,
        rank: numberOrNull(firstTag(body, 'rank').attrs.value),
        value: null
      }
    });
  }
  return items;
}

export function parseUserXml(xml) {
  const m = String(xml).match(/<user\b([^>]*)>/i);
  if (!m) return null;
  const a = attrs(m[1]);
  const id = numberOrNull(a.id);
  const username = decode(a.name || '');
  if (!id || !username) return null;
  return { id, username };
}

export async function lookupUser(username, opts = {}) {
  const name = String(username || '').trim();
  if (!name) throw new Error('A BGG username is required.');
  const xml = await fetchXml(userUrl(name), opts);
  const user = parseUserXml(xml);
  if (!user) throw new Error(`BGG has no user named "${name}".`);
  return user;
}

/**
 * From /xmlapi2/thing XML: expansion id -> parent id.
 * inbound="true" on a boardgameexpansion link means "this game is expanded by
 * that id", which is the reverse of what we want.
 */
export function parseThingParents(xml) {
  const parents = new Map();
  const re = /<item\b([^>]*)>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(String(xml)))) {
    const id = numberOrNull(attrs(m[1]).id);
    if (id === null) continue;
    const linkRe = /<link\b([^>]*)\/?>/gi;
    let link;
    while ((link = linkRe.exec(m[2]))) {
      const a = attrs(link[1]);
      if (a.type !== 'boardgameexpansion') continue;
      if (String(a.inbound).toLowerCase() === 'true') continue;
      const parentId = numberOrNull(a.id);
      if (parentId === null || parentId === id) continue;
      parents.set(id, parentId);
      break;
    }
  }
  return parents;
}

function playerFor(players, userId) {
  return (players || []).find(p => Number(p.bgg_user_id) === Number(userId)) || null;
}

/**
 * Merge per-user collection parses into the same library shape normalize()
 * writes, so /games and the Games tab do not care which source filled them.
 */
export function toLibrary(collections, players = [], { parents = new Map(), syncedAt = new Date(), source = 'bgg' } = {}) {
  const games = new Map();

  for (const { userId, items } of collections || []) {
    for (const item of items || []) {
      let game = games.get(item.id);
      if (!game) {
        game = {
          id: item.id,
          name: item.name,
          original_name: item.name,
          published: item.published,
          is_expansion: item.is_expansion,
          status: emptyStatus(),
          owner_count: 0,
          rating: {
            average: null,
            bgg_average: item.bgg_average,
            group_average: null,
            rating_count: 0,
            group_votes: 0,
            users: {}
          },
          plays: { last_play: null, total_plays: 0, users: {} },
          details: { ...item.details },
          expansions: []
        };
        games.set(item.id, game);
      }
      if (item.own && !game.status.own.includes(userId)) game.status.own.push(userId);
      if (item.rating != null) game.rating.users[userId] = item.rating;
      game.plays.users[userId] = (game.plays.users[userId] || 0) + item.numplays;
      game.plays.total_plays += item.numplays;
      if (game.rating.bgg_average == null && item.bgg_average != null) {
        game.rating.bgg_average = item.bgg_average;
      }
    }
  }

  for (const game of games.values()) {
    game.status.own.sort((a, b) => a - b);
    game.owner_count = game.status.own.length;
    const rated = Object.values(game.rating.users);
    game.rating.average = mean(rated);
    game.rating.rating_count = rated.length;
  }

  const out = [];
  for (const game of games.values()) {
    const parentId = parents.get(game.id);
    const parent = parentId != null ? games.get(parentId) : null;
    if (parent) {
      parent.expansions.push({
        id: game.id,
        name: game.name,
        published: game.published,
        status: game.status
      });
      continue;
    }
    out.push(game);
  }

  for (const game of out) {
    game.expansions.sort((a, b) => a.name.localeCompare(b.name));
  }
  out.sort((a, b) => a.name.localeCompare(b.name));

  const seen = new Set();
  const users = [];
  for (const { userId, username } of collections || []) {
    if (seen.has(userId)) continue;
    seen.add(userId);
    const player = playerFor(players, userId);
    const name = username || player?.bgg_username || '';
    users.push({
      id: Number(userId),
      username: name,
      full_name: player?.name || name,
      sort_name: String(name).toLowerCase(),
      discord: player?.discord_id ? String(player.discord_id) : null,
      avatar: null
    });
  }
  users.sort((a, b) => a.sort_name.localeCompare(b.sort_name));

  return {
    synced_at: (syncedAt instanceof Date ? syncedAt : new Date(syncedAt)).toISOString(),
    source,
    users,
    games: out
  };
}

export async function fetchXml(url, {
  token = getAppToken(),
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
  attempts = DEFAULT_ATTEMPTS,
  delayMs = DEFAULT_DELAY_MS
} = {}) {
  const headers = authHeaders(token);
  let lastStatus = 0;

  for (let i = 0; i < attempts; i += 1) {
    let res;
    try {
      res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(30000) });
    } catch (err) {
      throw new Error(redact(err.message || 'BGG request failed', token), { cause: err });
    }

    lastStatus = res.status;
    const text = await res.text();

    if (res.status === 202) {
      if (i === attempts - 1) break;
      await sleep(delayMs);
      continue;
    }

    if (!res.ok) {
      throw new Error(redact(
        `BGG request failed (${res.status} ${res.statusText || ''}). ${text}`.trim(),
        token
      ));
    }

    const body = String(text || '');
    if (/^\s*<(!DOCTYPE|html)\b/i.test(body)) {
      throw new Error('BGG returned a web page, not XML. Check BGG_APP_TOKEN and that the URL is boardgamegeek.com (no www).');
    }
    return body;
  }

  throw new Error(`BGG is still queueing that request after ${attempts} tries (last status ${lastStatus}). Try again in a moment.`);
}

const THING_BATCH = 20;

function filePart(value) {
  return String(value || 'user').replace(/[^\w.-]+/g, '_').slice(0, 40) || 'user';
}

function linkedPlayers(players) {
  return (players || []).filter(p => String(p?.bgg_username || '').trim() && Number(p.bgg_user_id) > 0);
}

/**
 * Pull every linked player's collection, then /thing for expansions so they
 * can hang off their base game the same way a Geekgroup sync does.
 *
 * @returns {Promise<{library: object, xmlFiles: {name: string, text: string}[]}>}
 */
export async function fetchCollections(players, opts = {}) {
  const linked = linkedPlayers(players);
  if (!linked.length) {
    throw new Error('Link at least one player to a BGG username before syncing from BoardGameGeek.');
  }
  authHeaders(opts.token);

  const sleep = opts.sleep || ((ms) => new Promise(resolve => setTimeout(resolve, ms)));
  const delayMs = opts.delayMs ?? DEFAULT_DELAY_MS;
  const onProgress = opts.onProgress || (() => {});
  const xmlFiles = [];
  const collections = [];
  let request = 0;

  const pause = async () => {
    if (request === 0) return;
    if (delayMs > 0) await sleep(delayMs);
  };

  for (const player of linked) {
    await pause();
    request += 1;
    onProgress({ page: request, pages: linked.length });
    const username = String(player.bgg_username).trim();
    const xml = await fetchXml(collectionUrl(username), opts);
    xmlFiles.push({
      name: `collection-${Number(player.bgg_user_id)}-${filePart(username)}.xml`,
      text: xml
    });
    collections.push({
      userId: Number(player.bgg_user_id),
      username,
      items: parseCollectionXml(xml)
    });
  }

  const expansionIds = [...new Set(
    collections.flatMap(c => c.items.filter(item => item.is_expansion).map(item => item.id))
  )];
  const parents = new Map();
  for (let i = 0; i < expansionIds.length; i += THING_BATCH) {
    await pause();
    request += 1;
    const batch = expansionIds.slice(i, i + THING_BATCH);
    const xml = await fetchXml(thingUrl(batch), opts);
    xmlFiles.push({
      name: `things-${String(Math.floor(i / THING_BATCH) + 1).padStart(2, '0')}.xml`,
      text: xml
    });
    for (const [child, parent] of parseThingParents(xml)) parents.set(child, parent);
  }

  return {
    library: toLibrary(collections, players, { parents, syncedAt: opts.syncedAt }),
    xmlFiles,
    collections,
    parents
  };
}
