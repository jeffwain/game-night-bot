/* Game Night control panel. Vanilla ES2022, no build step, no dependencies.
 *
 * Shape of the thing: every mutation POSTs/PATCHes and the server answers with
 * the complete new state, which is then re-rendered wholesale. For a table of
 * a dozen rows that is faster than any diffing scheme and, more to the point,
 * it means the page can never disagree with db.json about what happened. */

'use strict';

let state = null;
let proposal = null;

// ---------------------------------------------------------------- helpers

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const WEEKDAY_YEAR = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

// Parse as local noon, never `new Date(iso)`. The bare string is parsed as UTC
// and renders as the previous day for anyone west of Greenwich -- which is
// every user of this bot, and exactly the class of bug the server side already
// went out of its way to avoid.
function asDate(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}

function prettyDate(iso, withYear = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso))) return String(iso ?? '');
  return (withYear ? WEEKDAY_YEAR : WEEKDAY).format(asDate(iso));
}

function relativeDays(iso, todayIso) {
  const days = Math.round((asDate(iso) - asDate(todayIso)) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days > 1) return `in ${days} days`;
  if (days === -1) return 'yesterday';
  return `${Math.abs(days)} days ago`;
}

function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.remove('show'), isError ? 5000 : 2600);
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
    $('#banner').innerHTML = `<div class="banner">Could not reach the bot: ${esc(err.message)}</div>`;
  }
}

// ---------------------------------------------------------------- rendering

function hostOptions(selectedId) {
  return state.players
    .map(p => `<option value="${p.id}"${p.id === selectedId ? ' selected' : ''}>${esc(p.name)}${p.is_active ? '' : ' (inactive)'}</option>`)
    .join('');
}

function rsvpChips(entry) {
  if (entry.rsvps.length === 0) return '<span class="none">no RSVPs</span>';
  return entry.rsvps
    .map(r => `<span class="who ${esc(r.status)}" title="${esc(r.status)}${r.source === 'unknown' ? ' — not linked to a player' : ''}">${esc(r.name)}</span>`)
    .join('');
}

function renderUpcoming() {
  const rows = state.upcoming.map(e => `
    <tr data-id="${e.id}">
      <td>
        <input type="date" value="${esc(e.game_date)}" data-act="date">
        <div class="hint" style="margin:.15rem 0 0">${esc(prettyDate(e.game_date))} · ${esc(relativeDays(e.game_date, state.today))}</div>
      </td>
      <td><select data-act="host">${hostOptions(e.player_id)}</select></td>
      <td><div class="rsvp">${rsvpChips(e)}</div></td>
      <td class="hint">${e.reminder_sent ? 'reminder' : ''}${e.reminder_sent && e.notified ? ' · ' : ''}${e.notified ? 'host asked' : ''}${!e.reminder_sent && !e.notified ? '—' : ''}</td>
      <td class="actions">
        <button class="btn" data-act="edit">Edit</button>
        <button class="btn" data-act="postpone" title="Cancel this night; every later night slides forward one interval">Skip</button>
        <button class="btn danger" data-act="delete" title="Delete this night, leaving other dates alone">Delete</button>
      </td>
    </tr>`).join('');

  $('#upcoming-rows').innerHTML = rows ||
    '<tr><td colspan="5" class="hint">Nothing scheduled. Randomize a rotation below.</td></tr>';
  $('#count-upcoming').textContent = state.upcoming.length;
}

function renderHistory() {
  const rows = state.past.map(e => {
    const overdue = e.status === 'pending';
    const attended = e.rsvps.filter(r => r.status === 'going' || r.status === 'tentative');
    return `
    <tr data-id="${e.id}">
      <td>${esc(prettyDate(e.game_date, true))}<div class="hint" style="margin:.15rem 0 0">${esc(relativeDays(e.game_date, state.today))}</div></td>
      <td>${esc(e.host)}</td>
      <td>
        <select data-act="status">
          <option value="pending"${overdue ? ' selected' : ''}>unresolved</option>
          <option value="completed"${e.status === 'completed' ? ' selected' : ''}>played</option>
          <option value="skipped"${e.status === 'skipped' ? ' selected' : ''}>called off</option>
        </select>
        ${overdue ? '<span class="pill overdue" style="margin-left:.35rem">needs an answer</span>' : ''}
        ${e.notes ? `<div class="hint" style="margin:.25rem 0 0">${esc(e.notes)}</div>` : ''}
      </td>
      <td>
        <div class="rsvp">${attended.length ? rsvpChips({ rsvps: attended }) : '<span class="none">no RSVPs</span>'}</div>
        ${e.counts.out ? `<div class="hint" style="margin:.15rem 0 0">${e.counts.out} out</div>` : ''}
      </td>
      <td class="actions"><button class="btn" data-act="edit">Edit</button></td>
    </tr>`;
  }).join('');

  $('#history-rows').innerHTML = rows || '<tr><td colspan="5" class="hint">No history yet.</td></tr>';
  $('#count-history').textContent = state.past.length;

  const played = state.past.filter(e => e.status === 'completed').length;
  const called = state.past.filter(e => e.status === 'skipped').length;
  $('#history-summary').textContent =
    `${played} played · ${called} called off${state.unresolved ? ` · ${state.unresolved} still unresolved` : ''}`;
}

function renderPlayers() {
  const counts = new Map();
  for (const e of [...state.upcoming, ...state.past]) {
    counts.set(e.player_id, (counts.get(e.player_id) || 0) + 1);
  }

  $('#player-rows').innerHTML = state.players.map(p => `
    <tr data-id="${p.id}">
      <td><input value="${esc(p.name)}" data-act="name" style="width:9rem"></td>
      <td><input value="${esc(p.discord_id || '')}" data-act="discord" inputmode="numeric" placeholder="not linked" style="width:12rem"></td>
      <td><input type="checkbox" data-act="active"${p.is_active ? ' checked' : ''}></td>
      <td class="hint">${counts.get(p.id) || 0}</td>
      <td class="actions"><button class="btn danger" data-act="remove">Remove</button></td>
    </tr>`).join('') || '<tr><td colspan="5" class="hint">No players yet.</td></tr>';

  $('#count-players').textContent = state.players.filter(p => p.is_active).length;
  $('#add-host').innerHTML = hostOptions(state.players.find(p => p.is_active)?.id);
}

function renderSettings() {
  $('#set-reminder').value = state.settings.reminderTime || state.reminder.timeLabel;
  $('#set-tz').value = state.settings.timezone || state.timezone;
  $('#set-announce').value = state.settings.announcementsChannel;
  $('#set-notify').value = state.settings.notificationsChannel;
  $('#settings-hint').textContent =
    `Reminders fire at ${state.reminder.timeLabel} ${state.reminder.timezone}. Saving reschedules the job immediately — no restart.`;

  const s = state.stats;
  $('#storage-hint').textContent =
    `${s.dbPath} · ${s.totalPlayers} players (${s.activePlayers} active) · ${s.totalGames} nights · ${s.backupCount} backups`;

  if (!$('#tz-list').children.length && typeof Intl.supportedValuesOf === 'function') {
    $('#tz-list').innerHTML = Intl.supportedValuesOf('timeZone')
      .map(tz => `<option value="${esc(tz)}">`).join('');
  }
}

function renderBanner() {
  const notes = [];
  if (!state.botConnected) notes.push('The Discord client is not connected right now — edits still save, but nothing will be announced until it reconnects.');
  if (state.unresolved) notes.push(`${state.unresolved} past night${state.unresolved === 1 ? '' : 's'} still marked pending. Resolve them under History so the rotation reads correctly.`);
  $('#banner').innerHTML = notes.map(n => `<div class="banner">${esc(n)}</div>`).join('');
}

function render() {
  renderBanner();
  renderUpcoming();
  renderHistory();
  renderPlayers();
  renderSettings();
  $('#bot-state').innerHTML =
    `<span class="dot${state.botConnected ? ' on' : ''}"></span>${state.botConnected ? 'bot online' : 'bot offline'}`;
  $('#clock').textContent = `${prettyDate(state.today)} · ${state.timezone}`;

  // Re-suggest the rotation start after anything that moved the schedule --
  // skipping a night shifts every later date, and a start date left over from
  // before the shift lands on top of one of them. Only while the field is
  // untouched and no proposal is on screen, so this never overwrites typing.
  if (!proposal && !$('#rot-start').dataset.touched) prefillRotation();
  if (!$('#add-date').value) $('#add-date').value = state.today;
}

// ---------------------------------------------------------------- editor dialog

function openEditor(id) {
  const entry = [...state.upcoming, ...state.past].find(e => e.id === id);
  if (!entry) return;

  const linkable = state.players.filter(p => p.discord_id);
  $('#editor-title').textContent = `${prettyDate(entry.game_date, true)} — ${entry.host}`;
  $('#editor-body').innerHTML = `
    <div class="row">
      <div class="field"><label for="ed-date">Date</label><input type="date" id="ed-date" value="${esc(entry.game_date)}"></div>
      <div class="field"><label for="ed-host">Host</label><select id="ed-host">${hostOptions(entry.player_id)}</select></div>
      <div class="field"><label for="ed-status">Outcome</label>
        <select id="ed-status">
          <option value="pending"${entry.status === 'pending' ? ' selected' : ''}>pending</option>
          <option value="completed"${entry.status === 'completed' ? ' selected' : ''}>played</option>
          <option value="skipped"${entry.status === 'skipped' ? ' selected' : ''}>called off</option>
        </select>
      </div>
    </div>
    <div class="field" style="margin-top:.8rem">
      <label for="ed-notes">Notes — what got played, who turned up, why it was called off</label>
      <textarea id="ed-notes" maxlength="2000">${esc(entry.notes)}</textarea>
    </div>
    <div class="field" style="margin-top:.8rem">
      <label>RSVPs</label>
      <div class="rsvp" id="ed-rsvps">
        ${entry.rsvps.map(r => `<span class="who ${esc(r.status)}">${esc(r.name)} <button class="link" data-drop="${esc(r.id)}" title="Clear this RSVP">×</button></span>`).join('') || '<span class="none">none yet</span>'}
      </div>
      <div class="row" style="margin-top:.4rem">
        <select id="ed-rsvp-who">${linkable.map(p => `<option value="${esc(p.discord_id)}">${esc(p.name)}</option>`).join('') || '<option value="">no linked players</option>'}</select>
        <select id="ed-rsvp-status"><option value="going">in</option><option value="tentative">maybe</option><option value="out">out</option></select>
        <button class="btn" id="ed-rsvp-add"${linkable.length ? '' : ' disabled'}>Set</button>
      </div>
    </div>
    <div class="field" style="margin-top:.8rem">
      <label>Already sent — untick to make the bot send it again</label>
      <div class="row" style="gap:1rem">
        <label class="hint"><input type="checkbox" id="ed-notified"${entry.notified ? ' checked' : ''}> host asked</label>
        <label class="hint"><input type="checkbox" id="ed-reminder"${entry.reminder_sent ? ' checked' : ''}> reminder posted</label>
        <label class="hint"><input type="checkbox" id="ed-summary"${entry.summary_sent ? ' checked' : ''}> summary posted</label>
      </div>
    </div>`;

  // RSVP edits apply immediately -- they are their own endpoints, and batching
  // them into Save would mean re-implementing the merge on the client.
  $('#ed-rsvps').onclick = async ev => {
    const discordId = ev.target.dataset?.drop;
    if (!discordId) return;
    await mutate(`schedule/${id}/rsvp/${discordId}`, { method: 'DELETE' }, 'RSVP cleared');
    openEditor(id);
  };
  $('#ed-rsvp-add').onclick = async () => {
    const discordId = $('#ed-rsvp-who').value;
    if (!discordId) return;
    await mutate(`schedule/${id}/rsvp`, {
      method: 'POST',
      body: { discord_id: discordId, status: $('#ed-rsvp-status').value }
    }, 'RSVP set');
    openEditor(id);
  };

  $('#editor-save').onclick = async () => {
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
  };

  $('#editor').showModal();
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
  if (!proposal) { $('#rot-preview').innerHTML = ''; return; }

  const collides = proposal.some(p => p.collides);
  $('#rot-preview').innerHTML = `
    <div class="card" style="margin-top:.9rem">
      <h2>Proposed — not saved yet</h2>
      <div class="scroll">
        <table>
          <thead><tr><th>Date</th><th>Host</th><th></th></tr></thead>
          <tbody>${proposal.map((p, i) => `
            <tr>
              <td><input type="date" value="${esc(p.game_date)}" data-prop-date="${i}">
                ${p.collides ? '<span class="pill overdue" style="margin-left:.35rem">date taken</span>' : ''}
              </td>
              <td><select data-prop-host="${i}">${hostOptions(p.player_id)}</select></td>
              <td class="actions"><button class="btn" data-prop-drop="${i}">Drop</button></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="body">
        <div class="row">
          <button class="btn" id="rot-reroll">Reroll</button>
          <button class="btn primary" id="rot-append"${collides ? ' disabled' : ''}>Add to schedule</button>
          <button class="btn danger" id="rot-replace"${collides ? ' disabled' : ''}>Replace all upcoming</button>
          <button class="btn" id="rot-discard">Discard</button>
        </div>
        <p class="hint">${collides
          ? 'One of these dates already has a night on it. Move it or drop it before committing.'
          : '“Add” keeps existing upcoming nights. “Replace” clears every pending night first — history is never touched.'}</p>
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

// ---------------------------------------------------------------- wiring

document.addEventListener('DOMContentLoaded', () => {
  // tabs
  document.querySelectorAll('nav button').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('nav button').forEach(b => b.setAttribute('aria-selected', String(b === btn)));
      document.querySelectorAll('main > section').forEach(s => {
        s.hidden = s.id !== `tab-${btn.dataset.tab}`;
      });
    };
  });

  $('#refresh').onclick = () => refresh().then(() => toast('Reloaded'));

  // --- upcoming table ---
  $('#upcoming-rows').onchange = ev => {
    const row = ev.target.closest('tr');
    const id = Number(row.dataset.id);
    if (ev.target.dataset.act === 'date') {
      mutate(`schedule/${id}`, { method: 'PATCH', body: { game_date: ev.target.value } }, 'Date moved');
    } else if (ev.target.dataset.act === 'host') {
      mutate(`schedule/${id}`, { method: 'PATCH', body: { player_id: Number(ev.target.value) } }, 'Host changed');
    }
  };
  $('#upcoming-rows').onclick = ev => {
    const button = ev.target.closest('button');
    if (!button) return;
    const id = Number(button.closest('tr').dataset.id);
    const entry = state.upcoming.find(e => e.id === id);
    if (button.dataset.act === 'edit') openEditor(id);
    if (button.dataset.act === 'postpone' &&
        confirm(`Call off ${prettyDate(entry.game_date)}?\n\n${entry.host} keeps their turn and every later night moves forward one interval.`)) {
      mutate(`schedule/${id}/postpone`, { method: 'POST' }, 'Night called off, rest shifted');
    }
    if (button.dataset.act === 'delete' &&
        confirm(`Delete ${prettyDate(entry.game_date)} (${entry.host})?\n\nOther dates stay where they are.`)) {
      mutate(`schedule/${id}`, { method: 'DELETE' }, 'Night deleted');
    }
  };

  $('#add-night').onclick = () => {
    const date = $('#add-date').value;
    if (!date) return toast('Pick a date first', true);
    mutate('schedule/commit', {
      method: 'POST',
      body: { mode: 'append', entries: [{ player_id: Number($('#add-host').value), game_date: date }] }
    }, 'Night added');
  };

  // --- history table ---
  $('#history-rows').onchange = ev => {
    if (ev.target.dataset.act !== 'status') return;
    const id = Number(ev.target.closest('tr').dataset.id);
    mutate(`schedule/${id}`, { method: 'PATCH', body: { status: ev.target.value } }, 'Outcome recorded');
  };
  $('#history-rows').onclick = ev => {
    const button = ev.target.closest('button[data-act="edit"]');
    if (button) openEditor(Number(button.closest('tr').dataset.id));
  };

  // --- players table ---
  $('#player-rows').onchange = ev => {
    const id = Number(ev.target.closest('tr').dataset.id);
    const act = ev.target.dataset.act;
    if (act === 'name') mutate(`players/${id}`, { method: 'PATCH', body: { name: ev.target.value } }, 'Renamed');
    if (act === 'discord') mutate(`players/${id}`, { method: 'PATCH', body: { discord_id: ev.target.value.trim() } }, 'Discord link updated');
    if (act === 'active') mutate(`players/${id}`, { method: 'PATCH', body: { is_active: ev.target.checked } }, ev.target.checked ? 'Back in the rotation' : 'Out of the rotation');
  };
  $('#player-rows').onclick = ev => {
    const button = ev.target.closest('button[data-act="remove"]');
    if (!button) return;
    const id = Number(button.closest('tr').dataset.id);
    const player = state.players.find(p => p.id === id);
    if (confirm(`Remove ${player.name}?\n\nThis also deletes every scheduled and past night they hosted. To keep their history, untick "in rotation" instead.`)) {
      mutate(`players/${id}`, { method: 'DELETE' }, 'Player removed');
    }
  };
  $('#add-player').onclick = () => {
    const name = $('#new-player-name').value.trim();
    if (!name) return toast('A name is required', true);
    mutate('players', {
      method: 'POST',
      body: { name, discord_id: $('#new-player-discord').value.trim() || null }
    }, 'Player added').then(() => {
      $('#new-player-name').value = '';
      $('#new-player-discord').value = '';
    }).catch(() => {});
  };

  // --- settings ---
  $('#save-settings').onclick = () => mutate('settings', {
    method: 'PATCH',
    body: {
      reminderTime: $('#set-reminder').value,
      timezone: $('#set-tz').value.trim(),
      announcementsChannel: $('#set-announce').value.trim(),
      notificationsChannel: $('#set-notify').value.trim()
    }
  }, 'Settings saved');

  // --- rotation ---
  // Once you have picked a date or an interval yourself, the suggestion stops
  // second-guessing you.
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
    // Recheck collisions locally so the commit buttons stay honest.
    const taken = new Set(state.upcoming.map(e => e.game_date));
    const seen = new Set();
    for (const p of proposal) {
      p.collides = taken.has(p.game_date) || seen.has(p.game_date);
      seen.add(p.game_date);
    }
    renderProposal();
  };

  $('#editor-cancel').onclick = () => $('#editor').close();

  refresh();
  // db.json can also be edited from Discord or by hand. A quiet poll keeps an
  // open tab from showing a schedule that changed underneath it.
  setInterval(() => { if (!document.hidden && !document.querySelector('dialog[open]')) refresh(); }, 30000);
});
