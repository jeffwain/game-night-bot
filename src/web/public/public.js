/* The public schedule page's loader.
 *
 * This lives in its own file rather than inline in public.html because every
 * response carries `Content-Security-Policy: default-src 'self'`, which
 * forbids inline scripts. A blocked inline script throws nothing the page can
 * catch: it simply never runs, and the table sits on "Loading..." forever.
 * Keep it external. */

'use strict';
  // Served by the bot itself now, rather than exported to a file on disk.
  // The relative URL keeps working behind a reverse proxy at any path.
  const fmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function label(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return fmt.format(new Date(y, m - 1, d));
  }

  async function load() {
    const res = await fetch('schedule.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    const todayIso = new Date().toLocaleDateString('en-CA');
    const rows = data.schedule.map(g => {
      const past = g.date < todayIso;
      const status = g.status === 'pending' ? (past ? '' : 'scheduled') : g.status;
      return `<tr class="${past ? 'past' : ''}"><td>${label(g.date)}</td><td>${esc(g.host)}</td><td class="status">${esc(status)}</td></tr>`;
    }).join('');
    document.getElementById('rows').innerHTML = rows || '<tr><td colspan="3">Nothing scheduled yet.</td></tr>';
    document.getElementById('updated').textContent = 'Updated ' + new Date(data.updatedAt).toLocaleString();
  }

  load().catch(() => {
    document.getElementById('rows').innerHTML = '<tr><td colspan="3">Could not load the schedule.</td></tr>';
  });
