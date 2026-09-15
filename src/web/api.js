import * as db from '../database.js';
import * as library from '../games.js';
import * as sync from '../bgg/sync.js';
import { parseCurl, describeRequest } from '../bgg/curl.js';
import { lookupUser, redact as redactBgg } from '../bgg/xmlapi.js';
import { today, resolveReminderConfig } from '../config.js';
import { isValidTimezone, parseReminderTime } from '../time.js';
import { buildRotation, upcomingIntervalDays, suggestNextStart } from '../rotation.js';

// The JSON layer between the browser and database.js.
//
// Deliberately thin: every mutation calls an existing database.js function
// rather than reaching into db.json itself. That is what keeps the web UI and
// the Discord commands from drifting apart -- the collision-rippling in
// setEntryDate, the shift-forward in postponeGameAndShift, the backup written
// on every save, all of it applies identically whichever surface you used.

const RSVP_STATES = ['going', 'tentative', 'out'];
// Shown in the panel header, the browser tab and the public page. Every install
// is somebody else's group, so the name is theirs to set rather than ours to
// hardcode. Kept short because it sits in a header next to a status line.
const DEFAULT_DISPLAY_NAME = 'Game Night';
const MAX_DISPLAY_NAME = 60;
const GAME_STATES = ['pending', 'completed', 'skipped'];

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const badRequest = msg => new ApiError(400, msg);
const notFound = msg => new ApiError(404, msg);

// -------------------------------------------------------------
// VALIDATION
// -------------------------------------------------------------

// Rejects both "not a date shape" and "date shape that is not a real day"
// (2026-02-30). The DB stores raw strings, so nothing downstream would catch it.
function requireIsoDate(value, label = 'date') {
  const text = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw badRequest(`Expected ${label} as YYYY-MM-DD, got "${text}".`);
  }
  const [y, m, d] = text.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    throw badRequest(`"${text}" is not a real calendar date.`);
  }
  return text;
}

function requireId(value, label = 'id') {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`Expected a numeric ${label}.`);
  return n;
}

// Discord snowflakes are numeric strings. Storing anything else guarantees a
// mention that renders as literal text in the channel.
function requireSnowflake(value, label = 'Discord ID') {
  const text = String(value ?? '').trim();
  if (!/^\d{15,25}$/.test(text)) throw badRequest(`${label} must be a Discord ID (15-25 digits).`);
  return text;
}

function playerByIdOrThrow(id) {
  const player = db.getAllPlayers().find(p => p.id === requireId(id, 'player id'));
  if (!player) throw notFound(`Player ${id} not found.`);
  return player;
}

// -------------------------------------------------------------
// READ MODEL
// -------------------------------------------------------------

// RSVPs are stored keyed by raw Discord ID, because that is all a button click
// gives you. For a web page that is unreadable, so resolve to a name three
// ways: a linked player, then the gateway's user cache, then the bare ID.
function nameResolver(client) {
  const byDiscordId = new Map();
  for (const p of db.getAllPlayers()) {
    if (p.discord_id) byDiscordId.set(String(p.discord_id), p.name);
  }
  return discordId => {
    const key = String(discordId);
    const linked = byDiscordId.get(key);
    if (linked) return { id: key, name: linked, source: 'player' };
    const cached = client?.users?.cache?.get(key);
    if (cached) return { id: key, name: cached.globalName || cached.username, source: 'discord' };
    return { id: key, name: `Unknown (${key.slice(0, 6)}…)`, source: 'unknown' };
  };
}

function decorate(entry, resolve) {
  const rsvps = Object.entries(entry.rsvps || {}).map(([discordId, status]) => ({
    ...resolve(discordId),
    status
  }));
  rsvps.sort((a, b) => a.name.localeCompare(b.name));

  return {
    id: entry.id,
    game_date: entry.game_date,
    player_id: entry.player_id,
    host: entry.playerName,
    host_discord_id: entry.playerDiscordId,
    status: entry.status,
    notes: entry.notes || '',
    notified: Boolean(entry.notified),
    reminder_sent: Boolean(entry.reminder_sent),
    summary_sent: Boolean(entry.summary_sent),
    awaiting_claim: Boolean(entry.awaiting_claim),
    rsvps,
    counts: {
      going: rsvps.filter(r => r.status === 'going').length,
      tentative: rsvps.filter(r => r.status === 'tentative').length,
      out: rsvps.filter(r => r.status === 'out').length
    }
  };
}

function readState(client) {
  const resolve = nameResolver(client);
  const schedule = db.getSchedule().map(e => decorate(e, resolve));
  const todayIso = today(0);

  // "Upcoming" is by date, not by status: a night still marked pending three
  // weeks after it happened belongs in history, waiting to be resolved, not
  // hidden at the top of a list of future nights.
  const upcoming = schedule
    .filter(e => e.status === 'pending' && e.game_date >= todayIso)
    .sort((a, b) => a.game_date.localeCompare(b.game_date));
  const past = schedule
    .filter(e => !(e.status === 'pending' && e.game_date >= todayIso))
    .sort((a, b) => b.game_date.localeCompare(a.game_date));

  const settings = db.getSettings();
  const reminder = resolveReminderConfig();

  return {
    today: todayIso,
    // Resolved for display: the panel should never have to know the default.
    displayName: settings.displayName || DEFAULT_DISPLAY_NAME,
    timezone: reminder.timezone,
    intervalDays: upcomingIntervalDays(),
    players: db.getAllPlayers().map(p => ({ ...p })),
    upcoming,
    past,
    unresolved: past.filter(e => e.status === 'pending').length,
    settings: {
      displayName: settings.displayName || '',
      announcementsChannel: settings.announcementsChannel || '',
      notificationsChannel: settings.notificationsChannel || '',
      timezone: settings.timezone || '',
      reminderTime: settings.reminderTime || '',
      bggCollectionUrl: settings.bggCollectionUrl || '',
      // The token itself never leaves the server; the panel only needs to
      // know whether to render "set" or an empty field.
      bggTokenSet: Boolean(settings.bggToken),
      // Env-only XML API token. Same write-only pattern: the panel learns
      // whether Sync from BGG will work, never the bearer value.
      bggAppTokenSet: Boolean(String(process.env.BGG_APP_TOKEN || '').trim()),
      // What was captured, minus the secrets: enough for the panel to prove it
      // stored a real request without handing the cookies back to a browser.
      bggRequest: describeRequest(settings.bggRequest)
    },
    library: library.getGamesMeta(),
    reminder: { timeLabel: reminder.timeLabel, timezone: reminder.timezone, expression: reminder.expression },
    stats: db.getDbStats(),
    botConnected: Boolean(client?.isReady?.())
  };
}

// The public, first-names-only view. Same shape the old file-based export
// wrote, so an existing page pointed at it keeps rendering unchanged.
export function buildPublicSnapshot() {
  const schedule = db.getSchedule()
    .map(e => ({
      date: e.game_date,
      host: String(e.playerName || 'Unknown').split(' ')[0],
      status: e.status
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return {
    updatedAt: new Date().toISOString(),
    displayName: db.getSettings().displayName || DEFAULT_DISPLAY_NAME,
    schedule
  };
}

// -------------------------------------------------------------
// ROUTES
// -------------------------------------------------------------

async function dispatch({ method, segments, body, deps }) {
  const [head, ...rest] = segments;
  const client = deps.client;

  // --- GET /api/state -------------------------------------------------
  if (head === 'state' && method === 'GET') {
    return readState(client);
  }

  // --- players --------------------------------------------------------
  if (head === 'players') {
    if (method === 'POST' && rest.length === 0) {
      const name = String(body.name ?? '').trim();
      if (!name) throw badRequest('A player name is required.');
      const discordId = body.discord_id ? requireSnowflake(body.discord_id) : null;
      db.addPlayer(name, discordId);
      return readState(client);
    }

    if (rest.length === 1) {
      const player = playerByIdOrThrow(rest[0]);

      if (method === 'PATCH') {
        // Rename first: every other database.js player function addresses the
        // player by name, so doing it in the other order looks up a stale one.
        let currentName = player.name;
        if (typeof body.name === 'string' && body.name.trim() && body.name.trim() !== currentName) {
          currentName = db.renamePlayer(currentName, body.name).name;
        }
        if ('discord_id' in body || 'is_active' in body) {
          const isActive = 'is_active' in body ? Boolean(body.is_active) : null;
          const discordId = 'discord_id' in body
            ? (body.discord_id ? requireSnowflake(body.discord_id) : null)
            : undefined;
          db.updatePlayer(currentName, isActive, discordId);
        }
        if ('bgg_user_id' in body) {
          // The panel offers a picker built from the synced group members, so
          // the username rides along with the id it belongs to.
          const bggId = body.bgg_user_id ? requireId(body.bgg_user_id, 'BGG user id') : null;
          db.setPlayerBgg(player.id, bggId, bggId ? body.bgg_username : null);
        }
        return readState(client);
      }

      if (method === 'DELETE') {
        // removePlayer also drops their scheduled nights, which is a bigger
        // hammer than most deletes. Say so rather than surprising anyone.
        db.removePlayer(player.name);
        return readState(client);
      }
    }
  }

  // --- schedule -------------------------------------------------------
  if (head === 'schedule') {
    // POST /api/schedule/randomize -> proposal only, nothing is written
    if (method === 'POST' && rest[0] === 'randomize') {
      const startDate = requireIsoDate(body.start_date, 'start_date');
      const interval = Math.max(1, Number(body.interval_days) || upcomingIntervalDays());
      const proposal = buildRotation(startDate, interval, {
        playerIds: Array.isArray(body.player_ids) ? body.player_ids : null,
        shuffle: body.shuffle !== false
      });
      const taken = new Set(
        db.getSchedule().filter(s => s.status === 'pending').map(s => s.game_date)
      );
      return {
        proposal: proposal.map(p => ({ ...p, collides: taken.has(p.game_date) })),
        interval_days: interval
      };
    }

    // POST /api/schedule/commit -> writes a proposal, appending or replacing
    if (method === 'POST' && rest[0] === 'commit') {
      const entries = Array.isArray(body.entries) ? body.entries : [];
      if (entries.length === 0) throw badRequest('Nothing to commit.');
      const cleaned = entries.map(e => ({
        player_id: playerByIdOrThrow(e.player_id).id,
        game_date: requireIsoDate(e.game_date)
      }));
      const dates = cleaned.map(e => e.game_date);
      if (new Set(dates).size !== dates.length) {
        throw badRequest('Two nights in this rotation land on the same date.');
      }
      // "replace" drops pending nights only. History is never rewritten by a
      // reroll -- losing a season of results to a mis-click is not recoverable
      // from anything but a backup file.
      if (body.mode === 'replace') db.createSchedule(cleaned);
      else db.appendSchedule(cleaned);
      return readState(client);
    }

    // POST /api/schedule/swap
    if (method === 'POST' && rest[0] === 'swap') {
      db.swapTwoSpecificGames(requireId(body.a, 'game id'), requireId(body.b, 'game id'));
      return readState(client);
    }

    if (rest.length >= 1 && /^\d+$/.test(rest[0])) {
      const gameId = requireId(rest[0], 'game id');
      const exists = db.getSchedule().some(s => s.id === gameId);
      if (!exists) throw notFound(`Schedule entry ${gameId} not found.`);
      const action = rest[1];

      if (method === 'PATCH' && !action) {
        // Order matters. Host and status changes are unconditional, but
        // setEntryDate refuses anything that is not pending -- so move the
        // date while the entry still is one, then settle the status.
        if ('game_date' in body) db.setEntryDate(gameId, requireIsoDate(body.game_date));
        if ('player_id' in body) db.setEntryHost(gameId, playerByIdOrThrow(body.player_id).id);
        if ('notes' in body) db.setEntryNotes(gameId, body.notes);
        if ('status' in body) {
          if (!GAME_STATES.includes(body.status)) {
            throw badRequest(`Status must be one of ${GAME_STATES.join(', ')}.`);
          }
          db.markAsPlayed(gameId, body.status);
        }
        if (body.flags && typeof body.flags === 'object') db.setEntryFlags(gameId, body.flags);
        return readState(client);
      }

      if (method === 'DELETE' && !action) {
        // Only the surgical delete is exposed here. database.js also has
        // removeGameAndShiftSchedule, but despite the name that is the "I am
        // leaving the group" flow -- it also DEACTIVATES the host as a side
        // effect. Wiring it to a button labelled Delete would quietly drop
        // someone out of the rotation. Skip cancels a night and moves the rest
        // of the season; the Players tab takes someone out.
        db.deleteEntry(gameId);
        return readState(client);
      }

      if (method === 'POST' && action === 'postpone') {
        db.postponeGameAndShift(gameId);
        return readState(client);
      }

      if (action === 'rsvp') {
        if (method === 'POST') {
          const discordId = requireSnowflake(body.discord_id);
          if (!RSVP_STATES.includes(body.status)) {
            throw badRequest(`RSVP status must be one of ${RSVP_STATES.join(', ')}.`);
          }
          db.setRsvp(gameId, discordId, body.status);
          return readState(client);
        }
        if (method === 'DELETE') {
          db.removeRsvp(gameId, requireSnowflake(rest[2] ?? body.discord_id));
          return readState(client);
        }
      }
    }
  }

  // --- settings -------------------------------------------------------
  if (head === 'settings' && method === 'PATCH') {
    if ('timezone' in body) {
      const tz = String(body.timezone || '').trim();
      if (tz && !isValidTimezone(tz)) throw badRequest(`"${tz}" is not a valid IANA timezone.`);
      db.updateSettings('timezone', tz || undefined);
    }
    if ('reminderTime' in body) {
      const t = String(body.reminderTime || '').trim();
      if (t && !parseReminderTime(t)) throw badRequest(`"${t}" is not a valid HH:MM time.`);
      db.updateSettings('reminderTime', t || undefined);
    }
    if ('displayName' in body) {
      const name = String(body.displayName ?? '').trim().slice(0, MAX_DISPLAY_NAME);
      // Empty clears it, falling back to the default rather than showing blank.
      db.updateSettings('displayName', name || undefined);
    }
    for (const key of ['announcementsChannel', 'notificationsChannel']) {
      if (!(key in body)) continue;
      const value = String(body[key] ?? '').trim();
      if (value) requireSnowflake(value, key);
      db.updateSettings(key, value || undefined);
    }
    if ('bggCollectionUrl' in body) {
      const url = String(body.bggCollectionUrl ?? '').trim();
      if (url && !/^https?:\/\//i.test(url)) {
        throw badRequest('The collection URL must start with http:// or https://.');
      }
      db.updateSettings('bggCollectionUrl', url || undefined);
    }
    if ('bggRequest' in body) {
      // Pasted straight out of the browser's network tab. Empty clears it and
      // falls back to the plain URL path.
      const text = String(body.bggRequest ?? '').trim();
      if (!text) {
        db.updateSettings('bggRequest', undefined);
      } else {
        let request;
        try {
          request = parseCurl(text);
        } catch (err) {
          throw badRequest(err.message);
        }
        db.updateSettings('bggRequest', request);
        // Keep the plain URL in step so the rest of the panel can show where
        // the library comes from without unpacking the capture.
        db.updateSettings('bggCollectionUrl', request.url);
      }
    }
    if ('bggToken' in body) {
      // Write-only from the browser: readState reports whether one is set, and
      // never what it is.
      const token = String(body.bggToken ?? '').trim();
      db.updateSettings('bggToken', token || undefined);
    }
    // A reminder time that does not take effect until the next container
    // restart is a bug report waiting to happen. Rebuild the cron now.
    deps.onSettingsChanged?.();
    return readState(client);
  }

  // --- games ----------------------------------------------------------
  // The library answers with its own shape rather than the whole state: it is
  // large, it changes only on sync, and every other tab is unaffected by it.
  if (head === 'games') {
    if (method === 'GET' && rest.length === 0) {
      return {
        meta: library.getGamesMeta(),
        sync: sync.getSyncStatus(),
        imports: sync.listImportFiles(),
        users: library.getGamesUsers(),
        games: library.getGames()
      };
    }

    // Progress polling for a run started below. Cheap and called often.
    if (method === 'GET' && rest[0] === 'sync' && rest.length === 1) {
      return sync.getSyncStatus();
    }

    if (method === 'POST' && rest[0] === 'sync' && rest.length === 1) {
      if (String(body.source || '') === 'bgg') return sync.startBggSync();
      return sync.startSync();
    }

    // Answers the one question the API itself will not: did the token work?
    if (method === 'POST' && rest[0] === 'test' && rest.length === 1) {
      return sync.testConnection();
    }

    if (method === 'POST' && rest[0] === 'user' && rest.length === 1) {
      const username = String(body.username ?? '').trim();
      if (!username) throw badRequest('A BGG username is required.');
      try {
        return await lookupUser(username);
      } catch (err) {
        throw badRequest(redactBgg(err.message));
      }
    }

    if (method === 'POST' && rest[0] === 'import' && rest.length === 1) {
      const file = String(body.file ?? '').trim();
      if (!file) throw badRequest('An import filename is required.');
      if (sync.isSyncing()) throw badRequest('A sync is already running.');
      sync.importFromFile(file);
      return { meta: library.getGamesMeta(), sync: sync.getSyncStatus() };
    }

    // Re-normalize the newest archived pages -- what you want after linking a
    // player to a BGG account, since that changes whose ratings count.
    if (method === 'POST' && rest[0] === 'rebuild' && rest.length === 1) {
      if (sync.isSyncing()) throw badRequest('A sync is already running.');
      sync.rebuildFromArchive();
      return { meta: library.getGamesMeta(), sync: sync.getSyncStatus() };
    }
  }

  // --- convenience ----------------------------------------------------
  if (head === 'suggest-next-date' && method === 'GET') {
    return suggestNextStart();
  }

  throw notFound(`No route for ${method} /api/${segments.join('/')}`);
}

export async function handleApi(request) {
  try {
    return { status: 200, payload: await dispatch(request) };
  } catch (err) {
    if (err instanceof ApiError) return { status: err.status, payload: { error: err.message } };
    // database.js throws plain Errors with messages written for humans
    // ("Player \"Bob\" not found."), so they are safe to pass straight through.
    console.error('Web API error:', err.message);
    return { status: 400, payload: { error: err.message || 'Request failed.' } };
  }
}
