/* The public schedule page's loader.
 *
 * This lives in its own file rather than inline in public.html because every
 * response carries `Content-Security-Policy: default-src 'self'`, which
 * forbids inline scripts. A blocked inline script throws nothing the page can
 * catch: it simply never runs, and the page sits on "Loading..." forever.
 * Keep it external.
 *
 * The snapshot it reads carries first names, dates and status only -- no
 * Discord IDs, no RSVPs, no notes -- because this page is built to be proxied
 * to the open internet.
 */

'use strict';

const DAY = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const esc = s => String(s ?? '').replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Local noon, never `new Date(iso)`: the bare string parses as UTC and renders
// as the previous day for anyone west of Greenwich.
function label(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return DAY.format(new Date(y, m - 1, d, 12));
}

function row(game, { next = false, done = false } = {}) {
  const cls = [next ? 'next' : '', done ? 'done' : ''].filter(Boolean).join(' ');
  let tag = '';
  if (done) tag = game.status === 'skipped' ? 'called off' : 'played';
  else if (next) tag = 'next up';
  return `<li${cls ? ` class="${cls}"` : ''}>
      <span class="date">${esc(label(game.date))}</span>
      <span class="host">${esc(game.host)}</span>
      <span class="tag">${esc(tag)}</span>
    </li>`;
}

async function load() {
  const res = await fetch('schedule.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(String(res.status));
  const data = await res.json();

  if (data.displayName) {
    document.getElementById('title').textContent = data.displayName;
    document.title = data.displayName;
  }

  // en-CA gives YYYY-MM-DD, which is the shape the snapshot stores, so these
  // compare as plain strings.
  const todayIso = new Date().toLocaleDateString('en-CA');
  const all = [...data.schedule].sort((a, b) => a.date.localeCompare(b.date));

  const upcoming = all.filter(g => g.date >= todayIso && g.status === 'pending');
  const played = all.filter(g => g.date < todayIso && g.status !== 'pending').slice(-5).reverse();

  document.getElementById('upcoming').innerHTML =
    upcoming.map((g, i) => row(g, { next: i === 0 })).join('') ||
    '<li class="none">Nothing scheduled right now.</li>';

  if (played.length) {
    document.getElementById('recent').innerHTML = played.map(g => row(g, { done: true })).join('');
    document.getElementById('recent-wrap').hidden = false;
  }

  document.getElementById('updated').textContent =
    'Updated ' + new Date(data.updatedAt).toLocaleString();
}

load().catch(() => {
  document.getElementById('upcoming').innerHTML =
    '<li class="none">Could not load the schedule.</li>';
});
