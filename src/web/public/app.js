/* Game Night control panel. Vanilla ES2022, no build step, no dependencies.
 *
 * Shape of the thing: every mutation POSTs/PATCHes and the server answers with
 * the complete new state, which is then re-rendered wholesale. For a list of a
 * dozen rows that is faster than any diffing scheme and, more to the point, it
 * means the page can never disagree with db.json about what happened.
 *
 * Editing model: a row shows what you scan for -- when, who, who's coming --
 * and the two fields you change most often (date, host) are editable in place.
 * Everything rarer, and everything destructive, lives behind Edit. That keeps
 * five or fifteen rows readable instead of turning the page into a form grid.
 */

import { searchGames } from './search.js';

// A module, not a classic script, so it can import the shared scorer. Modules
// are strict and deferred by default, which is what the DOMContentLoaded
// wiring at the bottom already assumed.

let state = null;
let proposal = null;
// The game library is fetched separately from the schedule state: it is large,
// it only changes on a sync, and none of the other tabs depend on it.
let library = null;
let gameFilter = '';
let syncPoll = null;

// ---------------------------------------------------------------- helpers

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const DAY = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const DAY_YEAR = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

// Parse as local noon, never `new Date(iso)`. The bare string is parsed as UTC
// and renders as the previous day for anyone west of Greenwich -- which is
// every user of this bot, and exactly the class of bug the server side already
// went out of its way to avoid.
function asDate(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}

const isIso = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v));

function prettyDate(iso, withYear = false) {
  if (!isIso(iso)) return String(iso ?? '');
  return (withYear ? DAY_YEAR : DAY).format(asDate(iso));
}

function dayGap(iso, todayIso) {
  return Math.round((asDate(iso) - asDate(todayIso)) / 86400000);
}

function relativeDays(iso, todayIso) {
  const days = dayGap(iso, todayIso);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  if (days > 1) return `in ${days} days`;
  return `${Math.abs(days)} days ago`;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.remove('show'), isError ? 5200 : 2600);
}

// ---------------------------------------------------------------- transport

async function api(path, options = {}) {
  document.body.classList.add('busy');
  try {
    const res = await fetch(`/api/${path}`, {
      method: options.method || 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  } finally {
    document.body.classList.remove('busy');
  }
}

// Most endpoints answer with the whole state, so a mutation is "call, adopt
// the answer, redraw" with one error path for the lot.
async function mutate(path, options, successMessage) {
  try {
    const next = await api(path, options);
    if (next && next.players) {
      state = next;
      render();
    }
    if (successMessage) toast(successMessage);
    return next;
  } catch (err) {
    toast(err.message, true);
    throw err;
  }
}

async function refresh() {
  try {
    state = await api('state');
    render();
  } catch (err) {
    $('#notices').innerHTML =
      `<div class="notice">Could not reach the bot: ${esc(err.message)}</div>`;
  }
}

// ---------------------------------------------------------------- fragments

function hostOptions(selectedId, { placeholder = null } = {}) {
  const opts = state.players
    .map(p => `<option value="${p.id}"${p.id === selectedId ? ' selected' : ''}>${esc(p.name)}${p.is_active ? '' : ' — not in rotation'}</option>`)
    .join('');
  return placeholder ? `<option value="">${esc(placeholder)}</option>${opts}` : opts;
}

// The accounts to choose from are whoever the last collection sync found in
// the group, which beats asking anyone to look up a numeric BGG user id. An
// account already claimed by someone else is left out -- the server rejects a
// double link anyway, and offering it just invites the error.
function bggOptions(player) {
  const users = library?.users || [];
  const taken = new Set(
    state.players.filter(p => p.id !== player.id && p.bgg_user_id).map(p => Number(p.bgg_user_id))
  );
  const linked = player.bgg_user_id ? Number(player.bgg_user_id) : null;

  const options = users
    .filter(u => !taken.has(u.id))
    .map(u => `<option value="${u.id}"${u.id === linked ? ' selected' : ''}>${esc(u.full_name || u.username)} (${esc(u.username)})</option>`);

  // A link that survives a resync the account no longer appears in should stay
  // visible rather than silently resetting to "not linked".
  if (linked && !users.some(u => u.id === linked)) {
    options.unshift(`<option value="${linked}" selected>${esc(player.bgg_username || `BGG ${linked}`)}</option>`);
  }
  if (!options.length) {
    return '<option value="">Sync a collection first</option>';
  }
  return `<option value="">Not linked</option>${options.join('')}`;
}

// Geekgroup fills a dropdown of group members. The BGG XML API path has no
// such list until after the first sync, so a username box is how you link
// someone without a captured Geekgroup request.
function bggField(player) {
  const users = library?.users || [];
  if (users.length) {
    return `<select data-act="bgg" aria-label="BGG account for ${esc(player.name)}">${bggOptions(player)}</select>`;
  }
  return `<input data-act="bgg-name" value="${esc(player.bgg_username || '')}"
                 placeholder="BGG username" aria-label="BGG username for ${esc(player.name)}"
                 autocomplete="off" spellcheck="false">`;
}

function rsvpChips(rsvps, { removable = null } = {}) {
  if (!rsvps.length) return '<span class="muted" style="font-size:.82rem">No replies yet</span>';
  return rsvps.map(r => {
    const drop = removable
      ? ` <button class="linkish drop" data-drop="${esc(r.id)}" aria-label="Clear ${esc(r.name)}'s reply">×</button>`
      : '';
    const unknown = r.source === 'unknown' ? ' title="Not linked to any player"' : '';
    return `<span class="who ${esc(r.status)}"${unknown}>${esc(r.name)}${drop}</span>`;
  }).join('');
}

function rsvpSummary(entry) {
  const { going, tentative, out } = entry.counts;
  if (!entry.rsvps.length) return '<span class="muted" style="font-size:.85rem">No replies yet</span>';
  const bits = [];
  if (going) bits.push(`<span class="who going">${going} in</span>`);
  if (tentative) bits.push(`<span class="who tentative">${tentative} maybe</span>`);
  if (out) bits.push(`<span class="who out">${out} out</span>`);
  return bits.join(' ');
}

// "Already sent" bookkeeping, in words rather than field names.
function sentTags(entry) {
  const tags = [];
  if (entry.reminder_sent) tags.push('Reminder posted');
  if (entry.notified) tags.push('Host asked');
  if (entry.summary_sent) tags.push('Summary posted');
  if (!tags.length) return '';
  return `<div class="tags">${tags.map(t => `<span class="pill">${esc(t)}</span>`).join('')}</div>`;
}

// ---------------------------------------------------------------- rendering

function renderUpcoming() {
  const list = $('#upcoming-rows');
  $('#count-upcoming').textContent = state.upcoming.length;

  const noPlayers = state.players.length === 0;
  const noActive = state.players.filter(p => p.is_active).length === 0;

  if (state.upcoming.length === 0) {
    $('#upcoming-sub').textContent = '';
    list.innerHTML = emptyUpcoming(noPlayers, noActive);
    return;
  }

  const next = state.upcoming[0];
  $('#upcoming-sub').textContent = `Next up ${relativeDays(next.game_date, state.today)} — ${next.host}`;

  const head = `<div class="row row-head" aria-hidden="true">
      <div>Date</div><div>Host</div><div>Replies</div><div></div>
    </div>`;

  list.innerHTML = head + state.upcoming.map(e => {
    const gap = dayGap(e.game_date, state.today);
    const soon = gap <= 2 ? ' soon' : '';
    return `
    <div class="row" data-id="${e.id}">
      <div class="cell cell-date">
        <span class="cell-label">Date</span>
        <div class="cell-body">
          <input type="date" value="${esc(e.game_date)}" data-act="date" aria-label="Date for ${esc(e.host)}'s night">
          <span class="caption${soon}">${esc(prettyDate(e.game_date))} · ${esc(relativeDays(e.game_date, state.today))}</span>
        </div>
      </div>
      <div class="cell">
        <span class="cell-label">Host</span>
        <div class="cell-body">
          <select data-act="host" aria-label="Host for ${esc(prettyDate(e.game_date))}">${hostOptions(e.player_id)}</select>
        </div>
      </div>
      <div class="cell">
        <span class="cell-label">Replies</span>
        <div class="cell-body">
          <div class="rsvps">${rsvpSummary(e)}</div>
          ${sentTags(e)}
        </div>
      </div>
      <div class="cell-actions">
        <button class="btn sm" data-act="edit">Edit</button>
      </div>
    </div>`;
  }).join('');
}

function emptyUpcoming(noPlayers, noActive) {
  if (noPlayers) {
    return `<div class="empty">
      <h3>Let's get your group set up</h3>
      <p>Three steps and the bot takes it from there.</p>
      <ul class="steps">
        <li><span class="n">1</span><span><strong>Add your players</strong> on the Players tab.</span></li>
        <li><span class="n">2</span><span><strong>Randomize a rotation</strong> below to fill the calendar.</span></li>
        <li><span class="n">3</span><span><strong>Pick your channels</strong> under Settings so the bot can post.</span></li>
      </ul>
      <button class="btn primary" data-goto="players">Add players</button>
    </div>`;
  }
  if (noActive) {
    return `<div class="empty">
      <h3>Nobody is in the rotation</h3>
      <p>Every player is currently benched, so there is nobody to schedule. Turn at least one back on.</p>
      <button class="btn primary" data-goto="players">Go to players</button>
    </div>`;
  }
  return `<div class="empty">
    <h3>No nights scheduled</h3>
    <p>Randomize a rotation below and every player gets one night, in random order.</p>
  </div>`;
}

function renderHistory() {
  const list = $('#history-rows');
  $('#count-history').textContent = state.past.length;

  if (state.past.length === 0) {
    $('#history-sub').textContent = '';
    list.innerHTML = `<div class="empty">
      <h3>Nothing has happened yet</h3>
      <p>Once a scheduled night passes it lands here, and you can record whether it was played.</p>
    </div>`;
    return;
  }

  const played = state.past.filter(e => e.status === 'completed').length;
  const called = state.past.filter(e => e.status === 'skipped').length;
  $('#history-sub').textContent =
    `${plural(played, 'played', 'played')} · ${called} called off` +
    (state.unresolved ? ` · ${state.unresolved} unanswered` : '');

  const head = `<div class="row row-head" aria-hidden="true">
      <div>Date</div><div>Host</div><div>Outcome</div><div>Who came</div><div></div>
    </div>`;

  list.innerHTML = head + state.past.map(e => {
    const unresolved = e.status === 'pending';
    const attended = e.rsvps.filter(r => r.status === 'going' || r.status === 'tentative');
    return `
    <div class="row" data-id="${e.id}">
      <div class="cell cell-date">
        <span class="cell-label">Date</span>
        <div class="cell-body">
          <span class="when">${esc(prettyDate(e.game_date, true))}
            <span class="caption">${esc(relativeDays(e.game_date, state.today))}</span>
          </span>
        </div>
      </div>
      <div class="cell">
        <span class="cell-label">Host</span>
        <div class="cell-body">${esc(e.host)}</div>
      </div>
      <div class="cell">
        <span class="cell-label">Outcome</span>
        <div class="cell-body">
          <select data-act="status" aria-label="Outcome for ${esc(prettyDate(e.game_date, true))}">
            <option value="pending"${unresolved ? ' selected' : ''}>Not answered</option>
            <option value="completed"${e.status === 'completed' ? ' selected' : ''}>Played</option>
            <option value="skipped"${e.status === 'skipped' ? ' selected' : ''}>Called off</option>
          </select>
          ${unresolved ? '<div class="tags"><span class="pill attention">Needs an answer</span></div>' : ''}
        </div>
      </div>
      <div class="cell">
        <span class="cell-label">Who came</span>
        <div class="cell-body">
          <div class="rsvps">${attended.length ? rsvpChips(attended) : '<span class="muted" style="font-size:.82rem">No replies</span>'}</div>
          ${e.notes ? `<div class="hint" style="margin-top:.3rem">${esc(e.notes)}</div>` : ''}
        </div>
      </div>
      <div class="cell-actions">
        <button class="btn sm" data-act="edit">Edit</button>
      </div>
    </div>`;
  }).join('');
}

function renderPlayers() {
  const list = $('#player-rows');
  const active = state.players.filter(p => p.is_active).length;
  $('#count-players').textContent = state.players.length;
  $('#players-sub').textContent = state.players.length
    ? `${active} in the rotation${state.players.length > active ? `, ${state.players.length - active} benched` : ''}`
    : '';

  const counts = new Map();
  for (const e of [...state.upcoming, ...state.past]) {
    counts.set(e.player_id, (counts.get(e.player_id) || 0) + 1);
  }

  if (state.players.length === 0) {
    list.innerHTML = `<div class="empty">
      <h3>No players yet</h3>
      <p>Add everyone who takes a turn hosting. You can link Discord accounts now or later.</p>
    </div>`;
  } else {
    const head = `<div class="row row-head" aria-hidden="true">
        <div>Name</div><div>Discord ID</div><div>BGG account</div><div>In rotation</div><div>Nights</div><div></div>
      </div>`;
    list.innerHTML = head + state.players.map(p => `
      <div class="row" data-id="${p.id}">
        <div class="cell">
          <span class="cell-label">Name</span>
          <div class="cell-body">
            <input value="${esc(p.name)}" data-act="name" aria-label="Name" autocomplete="off">
          </div>
        </div>
        <div class="cell">
          <span class="cell-label">Discord ID</span>
          <div class="cell-body">
            <input value="${esc(p.discord_id || '')}" data-act="discord" inputmode="numeric"
                   placeholder="Not linked" aria-label="Discord ID for ${esc(p.name)}" autocomplete="off">
          </div>
        </div>
        <div class="cell">
          <span class="cell-label">BGG account</span>
          <div class="cell-body">${bggField(p)}</div>
        </div>
        <div class="cell">
          <span class="cell-label">In rotation</span>
          <div class="cell-body">
            <input type="checkbox" data-act="active"${p.is_active ? ' checked' : ''}
                   aria-label="${esc(p.name)} is in the rotation">
          </div>
        </div>
        <div class="cell muted">
          <span class="cell-label">Nights</span>
          <div class="cell-body">${counts.get(p.id) || 0}</div>
        </div>
        <div class="cell-actions">
          <button class="btn sm danger" data-act="remove">Remove</button>
        </div>
      </div>`).join('');
  }

  // Anything that needs a host is meaningless without one.
  const noActive = active === 0;
  $('#add-host').innerHTML = state.players.length
    ? hostOptions(state.players.find(p => p.is_active)?.id)
    : '<option value="">No players yet</option>';
  $('#add-host').disabled = state.players.length === 0;
  $('#add-night').disabled = state.players.length === 0;
  $('#rot-roll').disabled = noActive;
  $('#rot-hint').textContent = noActive
    ? 'Add at least one player to the rotation first.'
    : `Every player in the rotation gets one night, in random order. ${active} would be scheduled.`;
}

// ---------------------------------------------------------------- games

// The scorer lives in search.js because /games in Discord runs the same one.
// Two implementations would drift, and the difference would show up as "the
// bot found it but the panel didn't", which is nobody's idea of a good time.
function filteredGames() {
  return searchGames(library?.games || [], gameFilter).map(hit => hit.game);
}

const rating = value => (value === null || value === undefined ? '—' : Number(value).toFixed(1));

function ownerChips(game) {
  const owners = game.status?.own || [];
  if (!owners.length) {
    // The CSV export counts owners without naming them. Saying "nobody" there
    // would be a plain lie, so report the count and leave it at that.
    const count = game.owner_count || 0;
    return count
      ? `<span class="muted" title="This import counts owners without naming them">${plural(count, 'owner', 'owners')}</span>`
      : '<span class="muted">Nobody</span>';
  }
  return owners.map(id => {
    const user = library.users.find(u => u.id === id);
    // Prefer what we call them here. A roster name is shorter and more
    // familiar than "theburghard".
    const player = user && state.players.find(p => Number(p.bgg_user_id) === id);
    const label = player?.name || user?.full_name || user?.username || `BGG ${id}`;
    const avatar = user?.avatar
      ? `<img class="avatar" src="${esc(user.avatar)}" alt="" loading="lazy">`
      : '';
    return `<span class="owner" title="${esc(user?.username || label)}">${avatar}${esc(label)}</span>`;
  }).join('');
}

function renderGames() {
  const list = $('#game-rows');
  // The library loads on its own schedule, so it can arrive before the first
  // state does. Owner names come from the roster, so wait for both.
  if (!list || !state) return;

  const meta = library?.meta;
  const games = library?.games || [];
  $('#count-games').textContent = games.length;

  const syncing = library?.sync?.status === 'running';
  const bggReady = Boolean(state?.settings?.bggAppTokenSet);
  $('#games-sync').disabled = syncing;
  $('#games-sync').textContent = syncing && library?.sync?.source !== 'bgg' ? 'Syncing…' : 'Sync now';
  $('#games-sync-bgg').disabled = syncing || !bggReady;
  $('#games-sync-bgg').textContent = syncing && library?.sync?.source === 'bgg' ? 'Syncing…' : 'Sync from BGG';
  $('#games-sync-bgg').title = bggReady
    ? 'Pull each linked player\'s collection from boardgamegeek.com'
    : 'Set BGG_APP_TOKEN in data/.env to enable this';

  const shown = filteredGames();
  $('#games-sub').textContent = syncing
    ? `Syncing… page ${library.sync.page || 1} of ${library.sync.pages || '?'}`
    : describeLibrary(meta, games.length, shown.length);

  if (!games.length) {
    list.innerHTML = `<div class="empty">
      <h3>No games yet</h3>
      <p>Sync from BoardGameGeek (needs BGG_APP_TOKEN and linked accounts), sync a Geekgroup capture, or import a dump.</p>
      <button class="btn primary" data-goto="settings">Set up the collection</button>
    </div>`;
    return;
  }

  if (!shown.length) {
    list.innerHTML = `<div class="empty">
      <h3>Nothing matches “${esc(gameFilter)}”</h3>
      <p>Expansion names are searched too, and a hit on one shows its base game.</p>
    </div>`;
    return;
  }

  const head = `<div class="row row-head" aria-hidden="true">
      <div>Name</div><div>Avg</div><div>Group avg</div><div>BGG</div><div>Owned by</div><div>Last played</div>
    </div>`;

  list.innerHTML = head + shown.map(g => `
    <div class="row" data-id="${g.id}">
      <div class="cell">
        <span class="cell-label">Name</span>
        <div class="cell-body">
          <a href="https://boardgamegeek.com/boardgame/${g.id}" target="_blank" rel="noreferrer noopener">${esc(g.name)}</a>
          ${g.published ? `<span class="muted"> ${g.published}</span>` : ''}
          ${g.is_expansion ? '<span class="pill">Expansion</span>' : ''}
          ${g.expansions.length ? `<span class="pill" title="${esc(g.expansions.map(e => e.name).join(', '))}">+${g.expansions.length}</span>` : ''}
        </div>
      </div>
      <div class="cell">
        <span class="cell-label">Avg</span>
        <div class="cell-body">${rating(g.rating.average)}</div>
      </div>
      <div class="cell">
        <span class="cell-label">Group avg</span>
        <div class="cell-body">${rating(g.rating.group_average)}</div>
      </div>
      <div class="cell muted">
        <span class="cell-label">BGG</span>
        <div class="cell-body" title="${g.rating.rating_count} ratings on BGG">${rating(g.rating.bgg_average)}</div>
      </div>
      <div class="cell">
        <span class="cell-label">Owned by</span>
        <div class="cell-body owners">${ownerChips(g)}</div>
      </div>
      <div class="cell muted">
        <span class="cell-label">Last played</span>
        <div class="cell-body" title="${g.plays.total_plays ? plural(g.plays.total_plays, 'play', 'plays') : 'Never logged'}">
          ${g.plays.last_play ? esc(prettyDate(g.plays.last_play, true)) : '—'}
        </div>
      </div>
    </div>`).join('');
}

const SOURCE_LABEL = { csv: 'imported from CSV', import: 'imported', geekgroup: 'synced', bgg: 'synced from BGG' };

function describeLibrary(meta, total, shown) {
  if (!meta?.synced_at) return '';
  const when = prettyDate(meta.synced_at.slice(0, 10), true);
  const counted = shown === total
    ? plural(total, 'game', 'games')
    : `${shown} of ${total} games`;
  const bits = [counted];
  if (meta.expansion_count) bits.push(`${meta.expansion_count} expansions`);
  bits.push(`${SOURCE_LABEL[meta.source] || 'loaded'} ${when}`);
  // A CSV has no per-person columns to fill, and the two blank columns are
  // otherwise unexplained.
  if (meta.source === 'csv') bits.push('CSV has no per-person ratings or owners');
  return bits.join(' · ');
}

async function loadLibrary() {
  try {
    library = await api('games');
    renderGames();
    renderImportOptions();
    // The BGG picker on each player row is built from this list, and the
    // players tab has usually already drawn itself by now.
    if (state) renderPlayers();
    // Pick a sync back up across a page reload: it lives on the server, not here.
    if (library.sync?.status === 'running') watchSync();
  } catch (err) {
    $('#games-sub').textContent = `Could not load the library: ${err.message}`;
  }
}

function renderImportOptions() {
  const select = $('#games-import-file');
  const files = library?.imports || [];
  select.innerHTML = files.length
    ? files.map(f => `<option value="${esc(f)}">${esc(f)}</option>`).join('')
    : '<option value="">No files in data/bgg-import/</option>';
  select.disabled = !files.length;
  $('#games-import').disabled = !files.length;
  $('#games-import-hint').textContent = files.length
    ? 'Rebuild re-reads the last synced pages without refetching — run it after linking someone to a BGG account.'
    : 'Drop a saved collection.json into data/bgg-import/ and it will appear here.';
}

// Sync progress has to be its own timer. The 30s state poll deliberately skips
// a refresh while a field is focused, and the search box is focused exactly
// when someone is most likely watching a sync run.
function watchSync() {
  clearInterval(syncPoll);
  syncPoll = setInterval(async () => {
    try {
      const status = await api('games/sync');
      library.sync = status;
      if (status.status === 'running') return renderGames();

      clearInterval(syncPoll);
      syncPoll = null;
      if (status.status === 'error') toast(status.error, true);
      else toast('Collection synced');
      await loadLibrary();
      refresh();
    } catch {
      clearInterval(syncPoll);
      syncPoll = null;
    }
  }, 1500);
}

function renderSettings() {
  $('#set-name').value = state.settings.displayName || '';
  $('#set-name').placeholder = 'Game Night';
  $('#set-reminder').value = state.settings.reminderTime || state.reminder.timeLabel;
  $('#set-tz').value = state.settings.timezone || state.timezone;
  $('#set-announce').value = state.settings.announcementsChannel;
  $('#set-notify').value = state.settings.notificationsChannel;
  $('#settings-hint').textContent =
    `Reminders go out at ${state.reminder.timeLabel} ${state.reminder.timezone}. Saving reschedules the job straight away — no restart.`;

  // The capture carries session cookies, so it is never sent back to the
  // browser -- which leaves an empty box looking identical whether it saved or
  // not. Describe what is stored in words instead.
  const captured = state.settings.bggRequest;
  $('#set-bgg-request').placeholder = captured
    ? 'Saved — paste a fresh capture to replace it'
    : "curl 'https://api.geekgroup.app/api/groups/collection.json' -X POST -H 'Authorization: …' --data-raw '{…}'";

  $('#bgg-request-summary').textContent = captured
    ? `✓ Saved: ${captured.method} ${captured.host}, ${plural(captured.headers.length, 'header', 'headers')}` +
      `${captured.secrets.length ? ` (including ${captured.secrets.join(' and ')})` : ''}` +
      `, ${captured.bodyBytes ? `${captured.bodyBytes}-byte body` : 'no body'}.`
    : 'No request saved yet.';

  $('#bgg-hint').textContent = state.library?.synced_at
    ? `${plural(state.library.game_count, 'game', 'games')} in the library, last ${SOURCE_LABEL[state.library.source] || 'loaded'} ${prettyDate(state.library.synced_at.slice(0, 10), true)}.`
    : 'Nothing synced yet.';

  $('#set-bgg-username').value = state.settings.bggUsername || '';
  const bits = [];
  if (state.settings.bggUsername) bits.push(`Plays will be logged as ${state.settings.bggUsername}`);
  else bits.push('Set a BGG username here');
  bits.push(state.settings.bggPasswordSet
    ? 'password is set in data/.env'
    : 'set BGG_PASSWORD in data/.env');
  $('#bgg-login-hint').textContent = `${bits.join('; ')}.`;

  const s = state.stats;
  $('#storage-hint').textContent =
    `${s.dbPath} · ${plural(s.totalPlayers, 'player', 'players')} · ${plural(s.totalGames, 'night', 'nights')} · ${plural(s.backupCount, 'backup', 'backups')}`;

  if (!$('#tz-list').children.length && typeof Intl.supportedValuesOf === 'function') {
    $('#tz-list').innerHTML = Intl.supportedValuesOf('timeZone')
      .map(tz => `<option value="${esc(tz)}">`).join('');
  }
}

// Only things you can act on. The bot's connection state lives in the header,
// where it is always visible and costs no vertical space.
function renderNotices() {
  const notes = [];
  if (state.unresolved) {
    notes.push(`<div class="notice">
      <span>${plural(state.unresolved, 'past night is', 'past nights are')} still waiting on an answer, which throws off how the rotation reads.</span>
      <button class="btn sm" data-goto="history">Resolve</button>
    </div>`);
  }
  if (state.players.length > 0 && !state.settings.announcementsChannel) {
    notes.push(`<div class="notice">
      <span>No announcements channel is set, so nothing will be posted to Discord.</span>
      <button class="btn sm" data-goto="settings">Set one</button>
    </div>`);
  }
  $('#notices').innerHTML = notes.join('');
}

function render() {
  const name = state.displayName || 'Game Night';
  $('#app-name').textContent = name;
  if (document.title !== name) document.title = name;

  $('#bot-state').innerHTML = state.botConnected
    ? '<span class="dot on"></span>Bot online'
    : '<span class="dot off"></span>Bot offline';
  $('#bot-state').title = state.botConnected
    ? 'Connected to Discord.'
    : 'Not connected to Discord. Edits still save, but nothing will be announced until it reconnects.';
  $('#clock').textContent = `${prettyDate(state.today)} · ${state.timezone}`;

  renderNotices();
  renderUpcoming();
  renderHistory();
  renderPlayers();
  renderGames();
  renderSettings();

  if (!proposal && !$('#rot-start').dataset.touched) prefillRotation();
  if (!$('#add-date').value) $('#add-date').value = state.today;
}

// ---------------------------------------------------------------- editor

let editingId = null;

function openEditor(id) {
  const entry = [...state.upcoming, ...state.past].find(e => e.id === id);
  if (!entry) return;
  editingId = id;

  const linkable = state.players.filter(p => p.discord_id);
  $('#editor-title').textContent = prettyDate(entry.game_date, true);
  $('#editor-sub').textContent = `Hosted by ${entry.host}`;

  $('#editor-body').innerHTML = `
    <div class="form-row">
      <div class="field narrow">
        <label for="ed-date">Date</label>
        <input type="date" id="ed-date" value="${esc(entry.game_date)}">
      </div>
      <div class="field">
        <label for="ed-host">Host</label>
        <select id="ed-host">${hostOptions(entry.player_id)}</select>
      </div>
      <div class="field narrow">
        <label for="ed-status">Outcome</label>
        <select id="ed-status">
          <option value="pending"${entry.status === 'pending' ? ' selected' : ''}>Not answered</option>
          <option value="completed"${entry.status === 'completed' ? ' selected' : ''}>Played</option>
          <option value="skipped"${entry.status === 'skipped' ? ' selected' : ''}>Called off</option>
        </select>
      </div>
    </div>

    <div class="field">
      <label for="ed-notes">Notes</label>
      <textarea id="ed-notes" maxlength="2000" placeholder="What got played, who turned up, why it was called off…">${esc(entry.notes)}</textarea>
    </div>

    <fieldset>
      <legend>Replies</legend>
      <div class="rsvps" id="ed-rsvps">${rsvpChips(entry.rsvps, { removable: true })}</div>
      <div class="form-row" style="margin-top:.6rem">
        <div class="field">
          <label for="ed-rsvp-who">Player</label>
          <select id="ed-rsvp-who">${linkable.map(p => `<option value="${esc(p.discord_id)}">${esc(p.name)}</option>`).join('') || '<option value="">No players have a Discord ID</option>'}</select>
        </div>
        <div class="field narrow">
          <label for="ed-rsvp-status">Reply</label>
          <select id="ed-rsvp-status">
            <option value="going">In</option>
            <option value="tentative">Maybe</option>
            <option value="out">Out</option>
          </select>
        </div>
        <div class="actions">
          <button class="btn" id="ed-rsvp-add"${linkable.length ? '' : ' disabled'}>Set reply</button>
        </div>
      </div>
    </fieldset>

    <fieldset>
      <legend>Already sent</legend>
      <p class="hint" style="margin:0 0 .5rem">Untick something to let the bot send it again.</p>
      <div class="form-row">
        <label class="hint"><input type="checkbox" id="ed-notified"${entry.notified ? ' checked' : ''}> Host asked</label>
        <label class="hint"><input type="checkbox" id="ed-reminder"${entry.reminder_sent ? ' checked' : ''}> Reminder posted</label>
        <label class="hint"><input type="checkbox" id="ed-summary"${entry.summary_sent ? ' checked' : ''}> Summary posted</label>
      </div>
    </fieldset>

    ${entry.status === 'pending' ? `
    <fieldset>
      <legend>Call this night off</legend>
      <p class="hint" style="margin:0 0 .5rem">
        ${esc(entry.host)} keeps their turn and takes the next slot; every later night moves forward one interval.
      </p>
      <button class="btn" id="ed-skip">Call off and shift the rotation</button>
    </fieldset>` : ''}
  `;

  // RSVP edits apply immediately -- they are their own endpoints, and batching
  // them into Save would mean re-implementing the merge on the client.
  $('#ed-rsvps').onclick = async ev => {
    const discordId = ev.target.dataset?.drop;
    if (!discordId) return;
    await mutate(`schedule/${id}/rsvp/${discordId}`, { method: 'DELETE' }, 'Reply cleared');
    openEditor(id);
  };
  $('#ed-rsvp-add').onclick = async () => {
    const discordId = $('#ed-rsvp-who').value;
    if (!discordId) return;
    await mutate(`schedule/${id}/rsvp`, {
      method: 'POST',
      body: { discord_id: discordId, status: $('#ed-rsvp-status').value }
    }, 'Reply set');
    openEditor(id);
  };

  const skip = $('#ed-skip');
  if (skip) {
    skip.onclick = async () => {
      if (!confirm(`Call off ${prettyDate(entry.game_date)}?\n\n${entry.host} keeps their turn and every later night moves forward.`)) return;
      await mutate(`schedule/${id}/postpone`, { method: 'POST' }, 'Night called off, rotation shifted');
      $('#editor').close();
    };
  }

  $('#editor').showModal();
}

async function saveEditor() {
  const id = editingId;
  const entry = [...state.upcoming, ...state.past].find(e => e.id === id);
  if (!entry) return;

  const body = {
    player_id: Number($('#ed-host').value),
    status: $('#ed-status').value,
    notes: $('#ed-notes').value,
    flags: {
      notified: $('#ed-notified').checked,
      reminder_sent: $('#ed-reminder').checked,
      summary_sent: $('#ed-summary').checked
    }
  };
  // setEntryDate refuses non-pending entries, so only send a date change when
  // there actually is one -- otherwise editing the notes on a played night
  // would fail on a date that never moved.
  if ($('#ed-date').value !== entry.game_date) body.game_date = $('#ed-date').value;

  await mutate(`schedule/${id}`, { method: 'PATCH', body }, 'Saved');
  $('#editor').close();
}

async function deleteFromEditor() {
  const id = editingId;
  const entry = [...state.upcoming, ...state.past].find(e => e.id === id);
  if (!entry) return;
  if (!confirm(`Delete ${prettyDate(entry.game_date, true)} (${entry.host})?\n\nEvery other date stays where it is. This cannot be undone.`)) return;
  await mutate(`schedule/${id}`, { method: 'DELETE' }, 'Night deleted');
  $('#editor').close();
}

// ---------------------------------------------------------------- rotation

function prefillRotation() {
  api('suggest-next-date').then(s => {
    if ($('#rot-start').dataset.touched) return;
    $('#rot-start').value = s.start_date;
    $('#rot-interval').value = s.interval_days;
  }).catch(() => {});
}

function renderProposal() {
  const host = $('#rot-preview');
  if (!proposal) { host.innerHTML = ''; return; }

  const clash = proposal.some(p => p.collides);
  host.innerHTML = `
    <div class="card" style="margin:.9rem 0 0">
      <header>
        <h2>Proposed rotation</h2>
        <span class="sub">${plural(proposal.length, 'night', 'nights')} · not saved yet</span>
      </header>
      <div class="rows upcoming">
        <div class="row row-head" aria-hidden="true"><div>Date</div><div>Host</div><div></div><div></div></div>
        ${proposal.map((p, i) => `
          <div class="row">
            <div class="cell cell-date">
              <span class="cell-label">Date</span>
              <div class="cell-body">
                <input type="date" value="${esc(p.game_date)}" data-prop-date="${i}" aria-label="Date for proposed night ${i + 1}">
              </div>
            </div>
            <div class="cell">
              <span class="cell-label">Host</span>
              <div class="cell-body">
                <select data-prop-host="${i}" aria-label="Host for proposed night ${i + 1}">${hostOptions(p.player_id)}</select>
              </div>
            </div>
            <div class="cell">${p.collides ? '<span class="pill attention">Date already taken</span>' : ''}</div>
            <div class="cell-actions">
              <button class="btn sm quiet" data-prop-drop="${i}" aria-label="Remove proposed night ${i + 1}">Remove</button>
            </div>
          </div>`).join('')}
      </div>
      <div class="body">
        <div class="form-row">
          <div class="actions">
            <button class="btn primary" id="rot-append"${clash ? ' disabled' : ''}>Add to schedule</button>
            <button class="btn" id="rot-reroll">Reroll</button>
            <button class="btn danger" id="rot-replace"${clash ? ' disabled' : ''}>Replace all upcoming</button>
            <button class="btn quiet" id="rot-discard">Discard</button>
          </div>
        </div>
        <p class="hint">${clash
          ? 'One of these dates already has a night on it. Change it or remove that row first.'
          : '“Add” keeps the nights already scheduled. “Replace” clears every upcoming night first — past nights are never touched.'}</p>
      </div>
    </div>`;
}

async function rollRotation() {
  try {
    const res = await api('schedule/randomize', {
      method: 'POST',
      body: { start_date: $('#rot-start').value, interval_days: Number($('#rot-interval').value) }
    });
    proposal = res.proposal;
    renderProposal();
    $('#rot-preview').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } catch (err) {
    toast(err.message, true);
  }
}

async function commitRotation(mode) {
  await mutate('schedule/commit', {
    method: 'POST',
    body: { mode, entries: proposal.map(p => ({ player_id: p.player_id, game_date: p.game_date })) }
  }, mode === 'replace' ? 'Schedule replaced' : 'Rotation added');
  proposal = null;
  renderProposal();
  delete $('#rot-start').dataset.touched;
  prefillRotation();
}

function recheckCollisions() {
  const taken = new Set(state.upcoming.map(e => e.game_date));
  const seen = new Set();
  for (const p of proposal) {
    p.collides = taken.has(p.game_date) || seen.has(p.game_date);
    seen.add(p.game_date);
  }
}

// ---------------------------------------------------------------- tabs

function showTab(name) {
  $$('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  $$('main > section').forEach(s => { s.hidden = s.id !== `tab-${name}`; });
}

// ---------------------------------------------------------------- wiring

document.addEventListener('DOMContentLoaded', () => {
  $$('.tabs button').forEach(btn => {
    btn.onclick = () => showTab(btn.dataset.tab);
    // Left/right arrows move between tabs, which is what a tablist should do.
    btn.onkeydown = ev => {
      const dir = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0;
      if (!dir) return;
      ev.preventDefault();
      const all = $$('.tabs button');
      const next = all[(all.indexOf(btn) + dir + all.length) % all.length];
      next.focus();
      showTab(next.dataset.tab);
    };
  });

  // Any button anywhere can send you to a tab.
  document.addEventListener('click', ev => {
    const to = ev.target.closest('[data-goto]')?.dataset.goto;
    if (!to) return;
    showTab(to);
    $(`#tab-${to}`).focus();
  });

  $('#refresh').onclick = () => refresh().then(() => toast('Reloaded'));

  // --- upcoming ---
  $('#upcoming-rows').onchange = ev => {
    const row = ev.target.closest('.row');
    if (!row) return;
    const id = Number(row.dataset.id);
    if (ev.target.dataset.act === 'date') {
      mutate(`schedule/${id}`, { method: 'PATCH', body: { game_date: ev.target.value } }, 'Date moved');
    } else if (ev.target.dataset.act === 'host') {
      mutate(`schedule/${id}`, { method: 'PATCH', body: { player_id: Number(ev.target.value) } }, 'Host changed');
    }
  };
  $('#upcoming-rows').onclick = ev => {
    const button = ev.target.closest('button[data-act="edit"]');
    if (button) openEditor(Number(button.closest('.row').dataset.id));
  };

  $('#add-night').onclick = () => {
    const date = $('#add-date').value;
    if (!date) return toast('Pick a date first', true);
    mutate('schedule/commit', {
      method: 'POST',
      body: { mode: 'append', entries: [{ player_id: Number($('#add-host').value), game_date: date }] }
    }, 'Night added');
  };

  // --- history ---
  $('#history-rows').onchange = ev => {
    if (ev.target.dataset.act !== 'status') return;
    const id = Number(ev.target.closest('.row').dataset.id);
    mutate(`schedule/${id}`, { method: 'PATCH', body: { status: ev.target.value } }, 'Outcome recorded');
  };
  $('#history-rows').onclick = ev => {
    const button = ev.target.closest('button[data-act="edit"]');
    if (button) openEditor(Number(button.closest('.row').dataset.id));
  };

  // --- players ---
  $('#player-rows').onchange = ev => {
    const row = ev.target.closest('.row');
    if (!row) return;
    const id = Number(row.dataset.id);
    const act = ev.target.dataset.act;
    if (act === 'name') mutate(`players/${id}`, { method: 'PATCH', body: { name: ev.target.value } }, 'Renamed');
    if (act === 'discord') mutate(`players/${id}`, { method: 'PATCH', body: { discord_id: ev.target.value.trim() } }, 'Discord link updated');
    if (act === 'active') mutate(`players/${id}`, { method: 'PATCH', body: { is_active: ev.target.checked } },
      ev.target.checked ? 'Back in the rotation' : 'Benched');
    if (act === 'bgg') {
      const bggUserId = ev.target.value ? Number(ev.target.value) : null;
      const user = (library?.users || []).find(u => u.id === bggUserId);
      mutate(`players/${id}`, {
        method: 'PATCH',
        body: { bgg_user_id: bggUserId, bgg_username: user?.username || null }
      }, bggUserId ? 'BGG account linked' : 'BGG account unlinked')
        .then(() => api('games/rebuild', { method: 'POST' }))
        .then(loadLibrary)
        .catch(() => {});
    }
    if (act === 'bgg-name') {
      const username = ev.target.value.trim();
      if (!username) {
        mutate(`players/${id}`, { method: 'PATCH', body: { bgg_user_id: null } }, 'BGG account unlinked');
        return;
      }
      api('games/user', { method: 'POST', body: { username } })
        .then(user => mutate(`players/${id}`, {
          method: 'PATCH',
          body: { bgg_user_id: user.id, bgg_username: user.username }
        }, 'BGG account linked'))
        .then(() => api('games/rebuild', { method: 'POST' }))
        .then(loadLibrary)
        .catch(err => toast(err.message, true));
    }
  };
  $('#player-rows').onclick = ev => {
    const button = ev.target.closest('button[data-act="remove"]');
    if (!button) return;
    const id = Number(button.closest('.row').dataset.id);
    const player = state.players.find(p => p.id === id);
    if (confirm(`Remove ${player.name}?\n\nThis also deletes every night they hosted, past and future. To keep their history, untick "in rotation" instead.`)) {
      mutate(`players/${id}`, { method: 'DELETE' }, 'Player removed');
    }
  };
  $('#add-player').onclick = () => {
    const name = $('#new-player-name').value.trim();
    if (!name) return toast('A name is required', true);
    mutate('players', {
      method: 'POST',
      body: { name, discord_id: $('#new-player-discord').value.trim() || null }
    }, `${name} added`).then(() => {
      $('#new-player-name').value = '';
      $('#new-player-discord').value = '';
      $('#new-player-name').focus();
    }).catch(() => {});
  };

  // --- settings ---
  $('#save-settings').onclick = () => mutate('settings', {
    method: 'PATCH',
    body: {
      displayName: $('#set-name').value.trim(),
      reminderTime: $('#set-reminder').value,
      timezone: $('#set-tz').value.trim(),
      announcementsChannel: $('#set-announce').value.trim(),
      notificationsChannel: $('#set-notify').value.trim(),
      bggUsername: $('#set-bgg-username').value.trim()
    }
  }, 'Settings saved').catch(() => {});

  // --- board game collection ---
  // Its own Save, deliberately. The global "Save settings" button lives at the
  // bottom of the tab past two other cards, and a token typed up here and left
  // unsaved looks identical to one that saved and cleared itself.
  const saveCollectionSettings = () => {
    const pasted = $('#set-bgg-request').value.trim();
    // An untouched box means "keep what is stored", not "clear it" -- there is
    // no way to tell those apart from an empty box, so the safe reading wins.
    if (!pasted) return Promise.resolve();
    return mutate('settings', {
      method: 'PATCH',
      body: { bggRequest: pasted }
    }, 'Request saved').then(() => { $('#set-bgg-request').value = ''; });
  };

  $('#bgg-save').onclick = () => saveCollectionSettings().catch(() => {});

  $('#bgg-test').onclick = async () => {
    // Save first, so Test never reports on a token you typed but did not store.
    try {
      await saveCollectionSettings();
    } catch {
      return;
    }
    $('#bgg-hint').textContent = 'Testing…';
    try {
      const result = await api('games/test', { method: 'POST' });
      $('#bgg-hint').textContent = result.message;
      toast(result.ok ? 'Connection looks good' : 'Wrong collection came back', !result.ok);
    } catch (err) {
      $('#bgg-hint').textContent = err.message;
      toast(err.message, true);
    }
  };

  // --- games ---
  $('#games-search').oninput = ev => {
    gameFilter = ev.target.value;
    renderGames();
  };
  $('#games-sync').onclick = async () => {
    try {
      library.sync = await api('games/sync', { method: 'POST' });
      renderGames();
      watchSync();
    } catch (err) {
      toast(err.message, true);
    }
  };
  $('#games-sync-bgg').onclick = async () => {
    try {
      library.sync = await api('games/sync', { method: 'POST', body: { source: 'bgg' } });
      renderGames();
      watchSync();
    } catch (err) {
      toast(err.message, true);
    }
  };
  $('#games-import').onclick = async () => {
    const file = $('#games-import-file').value;
    if (!file) return;
    try {
      await api('games/import', { method: 'POST', body: { file } });
      await loadLibrary();
      refresh();
      toast('Collection imported');
    } catch (err) {
      toast(err.message, true);
    }
  };
  $('#games-rebuild').onclick = async () => {
    try {
      await api('games/rebuild', { method: 'POST' });
      await loadLibrary();
      toast('Library rebuilt from the last sync');
    } catch (err) {
      toast(err.message, true);
    }
  };

  // --- rotation ---
  for (const id of ['#rot-start', '#rot-interval']) {
    $(id).oninput = () => { $('#rot-start').dataset.touched = 'true'; };
  }
  $('#rot-roll').onclick = rollRotation;
  $('#rot-preview').onclick = ev => {
    const button = ev.target.closest('button');
    if (!button) return;
    if (button.id === 'rot-reroll') return rollRotation();
    if (button.id === 'rot-append') return commitRotation('append');
    if (button.id === 'rot-replace') {
      if (confirm('Replace every upcoming night with this rotation?\n\nPast nights are untouched.')) commitRotation('replace');
      return;
    }
    if (button.id === 'rot-discard') { proposal = null; renderProposal(); return; }
    if (button.dataset.propDrop !== undefined) {
      proposal.splice(Number(button.dataset.propDrop), 1);
      if (!proposal.length) { proposal = null; renderProposal(); return; }
      recheckCollisions();
      renderProposal();
    }
  };
  $('#rot-preview').onchange = ev => {
    const dateIndex = ev.target.dataset.propDate;
    const hostIndex = ev.target.dataset.propHost;
    if (dateIndex !== undefined) proposal[Number(dateIndex)].game_date = ev.target.value;
    if (hostIndex !== undefined) {
      const player = state.players.find(p => p.id === Number(ev.target.value));
      proposal[Number(hostIndex)].player_id = player.id;
      proposal[Number(hostIndex)].playerName = player.name;
    }
    recheckCollisions();
    renderProposal();
  };

  // --- editor ---
  $('#editor-cancel').onclick = () => $('#editor').close();
  $('#editor-save').onclick = saveEditor;
  $('#editor-delete').onclick = deleteFromEditor;

  refresh();
  loadLibrary();
  // db.json can also be edited from Discord or by hand. A quiet poll keeps an
  // open tab from showing a schedule that changed underneath it -- but never
  // while a dialog is open or a field is focused, which would yank input away.
  setInterval(() => {
    if (document.hidden) return;
    if (document.querySelector('dialog[open]')) return;
    if (proposal) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    refresh();
  }, 30000);
});
