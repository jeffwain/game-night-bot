// What got played, and who sat at the table.
//
// The host check-in DM collects game names; this module turns that answer into
// a BGG geekplay payload. Discord wiring and the HTTP post live elsewhere so
// the seating rules can be tested without either.

import { foldText, scoreName } from './web/public/search.js';

const SELECT_LIMIT = 25;
const LABEL_MAX = 100;

function asPlayer(player) {
  return {
    name: player.name,
    username: String(player.bgg_username || '').trim() || null
  };
}

// Host first, then everyone who clicked I'm in. Maybes and outs stay off the
// play. A Discord id that is not on the roster is ignored -- we have no name
// to send BGG, and the RSVP post is public so random channel clicks happen.
export function attendeesForPlay(game, players = []) {
  const roster = players || [];
  const byDiscord = new Map(
    roster.filter(p => p.discord_id).map(p => [String(p.discord_id), p])
  );
  const seen = new Set();
  const out = [];

  const add = (player) => {
    if (!player || seen.has(player.id)) return;
    seen.add(player.id);
    out.push(asPlayer(player));
  };

  add(roster.find(p => p.id === game.player_id));
  for (const [discordId, status] of Object.entries(game.rsvps || {})) {
    if (status !== 'going') continue;
    add(byDiscord.get(String(discordId)));
  }
  return out;
}

export function flattenPlayables(games) {
  const items = [];
  for (const game of games || []) {
    items.push({
      id: game.id,
      name: game.name,
      original_name: game.original_name || game.name,
      is_expansion: Boolean(game.is_expansion),
      parentName: null
    });
    for (const expansion of game.expansions || []) {
      items.push({
        id: expansion.id,
        name: expansion.name,
        original_name: expansion.name,
        is_expansion: true,
        parentName: game.name
      });
    }
  }
  return items;
}

export function findPlayable(games, id) {
  const n = Number(id);
  return flattenPlayables(games).find(item => item.id === n) || null;
}

// Expansions are first-class picks here. /games hides them because "do we own
// X" usually means the base game; "what did we play" does not.
export function searchPlayables(games, query, { limit = SELECT_LIMIT } = {}) {
  const needle = foldText(query);
  if (!needle) return [];

  const ranked = flattenPlayables(games)
    .map(item => ({
      ...item,
      score: Math.max(
        scoreName(foldText(item.name), needle),
        scoreName(foldText(item.original_name), needle)
      )
    }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  const seen = new Set();
  const out = [];
  for (const item of ranked) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const label = item.parentName
      ? `${item.name} (${item.parentName})`
      : item.name;
    out.push({ id: item.id, name: item.name, label: label.slice(0, LABEL_MAX) });
    if (out.length >= limit) break;
  }
  return out;
}

export function playPayload({ objectId, playdate, location, players }) {
  return {
    ajax: 1,
    action: 'save',
    objecttype: 'thing',
    objectid: Number(objectId),
    playdate,
    date: `${playdate} 12:00:00`,
    location: location || '',
    quantity: 1,
    players: (players || []).map(p => ({
      name: p.name,
      username: p.username || '',
      win: false
    }))
  };
}
