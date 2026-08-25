// End-to-end tests for the web control panel: real HTTP against the real
// server, against a real (scratch) db.json. No mocks -- the point is to catch
// the wiring, and a mocked request object cannot tell you that a route is
// unreachable or that a body never gets parsed.
//
// Run with: npm test
import fs from 'fs';
import assert from 'node:assert/strict';

const DIR = './data-web';
fs.rmSync(DIR, { recursive: true, force: true });
process.env.DB_DIR = DIR;
process.env.TZ = 'America/Chicago';
process.env.WEB_PORT = '8799';
process.env.WEB_HOST = '127.0.0.1';
delete process.env.WEB_ALLOW_REMOTE;

// Count Intl.DateTimeFormat constructions before anything imports time.js.
// Each one pins ~27 KB of ICU data outside the JS heap, so building them per
// request is invisible to heapUsed and very visible in `docker stats`.
let intlBuilds = 0;
const RealDateTimeFormat = Intl.DateTimeFormat;
function CountingDateTimeFormat(...args) {
  intlBuilds++;
  return new RealDateTimeFormat(...args);
}
CountingDateTimeFormat.supportedLocalesOf = RealDateTimeFormat.supportedLocalesOf.bind(RealDateTimeFormat);
CountingDateTimeFormat.prototype = RealDateTimeFormat.prototype;
Intl.DateTimeFormat = CountingDateTimeFormat;

const db = await import('./database.js');
const { today, isReminderWindowOpen } = await import('./config.js');
const { startWebServer, stopWebServer, isPrivateAddress } = await import('./web/server.js');

let pass = 0;
const ok = (m) => { console.log('  PASS  ' + m); pass++; };

const BASE = 'http://127.0.0.1:8799';
let settingsHookCalls = 0;
const server = startWebServer({ client: null, onSettingsChanged: () => { settingsHookCalls++; } });
await new Promise(resolve => server.once('listening', resolve));

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* asset routes return HTML/CSS */ }
  return { status: res.status, json, text, headers: res.headers };
}

try {
  // ---------- 1. STATIC + PUBLIC ROUTES ----------
  console.log('\n1. Static and public routes');
  for (const [path, needle] of [
    ['/', 'Game Night Control Panel'],
    ['/app.css', '--accent'],
    ['/app.js', 'control panel']
  ]) {
    const res = await req('GET', path);
    assert.equal(res.status, 200, `${path} should serve`);
    assert.ok(res.text.includes(needle), `${path} should contain ${needle}`);
  }
  ok('control panel HTML, CSS and JS all serve');

  assert.equal((await req('GET', '/healthz')).json.ok, true);
  assert.equal((await req('GET', '/definitely-not-a-route')).status, 404);
  ok('/healthz answers and unknown paths 404');

  // The suffix match is what makes the page survive a reverse proxy that does
  // not rewrite its path prefix. Regressing it produces an empty public table.
  for (const path of ['/public/schedule.json', '/schedule.json', '/games/schedule.json']) {
    const res = await req('GET', path);
    assert.equal(res.status, 200, `${path} should serve the snapshot`);
    assert.ok(Array.isArray(res.json.schedule), `${path} should return a schedule array`);
  }
  ok('the public snapshot answers at every path a reverse proxy might use');

  const pub = await req('GET', '/public');
  assert.equal(pub.status, 200);
  assert.ok(pub.text.includes('Upcoming Games'), 'public page renders');
  ok('the public page serves without touching the admin gate');

  for (const path of ['/public.js', '/public/public.js', '/games/public.js']) {
    const res = await req('GET', path);
    assert.equal(res.status, 200, `${path} should serve the public page's script`);
    assert.ok(res.text.includes('schedule.json'), `${path} should be the loader`);
  }
  ok("the public page's script loads at every path a reverse proxy might use");

  // Every response carries default-src 'self', which FORBIDS inline scripts.
  // A blocked inline script throws nothing catchable -- the page just never
  // loads its data. This shipped broken once; it does not get to again.
  const csp = pub.headers.get('content-security-policy') || '';
  assert.match(csp, /default-src 'self'/, 'responses must carry a restrictive CSP');
  assert.equal(/script-src[^;]*unsafe-inline/.test(csp), false, 'inline scripts must stay forbidden');
  for (const [name, path] of [['public page', '/public'], ['control panel', '/']]) {
    const html = (await req('GET', path)).text;
    const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
      .filter(m => m[1].trim().length > 0);
    assert.equal(inline.length, 0,
      `the ${name} has ${inline.length} inline <script> block(s), which the CSP will silently block`);
  }
  ok('neither page relies on an inline script the CSP would silently kill');

  // ---------- 2. ADDRESS GATE ----------
  console.log('\n2. Private-address gate');
  for (const addr of ['127.0.0.1', '::1', '::ffff:192.168.1.40', '10.4.4.4', '172.16.0.1', '172.31.255.254', '192.168.0.1', 'fd00::1', 'fe80::1']) {
    assert.equal(isPrivateAddress(addr), true, `${addr} should be private`);
  }
  for (const addr of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.0.1', '2606:4700::1', '', null, 'garbage']) {
    assert.equal(isPrivateAddress(addr), false, `${addr} should NOT be private`);
  }
  ok('isPrivateAddress accepts every RFC1918 range and rejects public ones');

  // ---------- 3. READ MODEL ----------
  console.log('\n3. State');
  db.addPlayer('Alice', '100000000000000001');
  db.addPlayer('Bob', '100000000000000002');
  db.addPlayer('Carol');
  db.appendSchedule([{ player_id: 1, game_date: '2099-01-05' }, { player_id: 2, game_date: '2099-01-12' }]);

  let state = (await req('GET', '/api/state')).json;
  assert.equal(state.players.length, 3);
  assert.equal(state.upcoming.length, 2, 'two future nights');
  assert.equal(state.upcoming[0].host, 'Alice', 'upcoming is sorted ascending');
  assert.equal(state.botConnected, false, 'no client was passed');
  ok('GET /api/state returns players, schedule, settings and stats');

  // A pending night in the past is history that needs resolving, not upcoming.
  db.appendSchedule([{ player_id: 3, game_date: '2020-01-01' }]);
  state = (await req('GET', '/api/state')).json;
  assert.equal(state.upcoming.length, 2, 'a past pending night is not "upcoming"');
  assert.equal(state.past[0].game_date, '2020-01-01');
  assert.equal(state.unresolved, 1, 'and it is counted as unresolved');
  ok('past-but-pending nights fall into history and are flagged unresolved');

  // ---------- 4. RANDOMIZE: PREVIEW THEN COMMIT ----------
  console.log('\n4. Randomize');
  const before = db.getSchedule().length;
  const preview = await req('POST', '/api/schedule/randomize', { start_date: '2099-03-01', interval_days: 14 });
  assert.equal(preview.status, 200);
  assert.equal(preview.json.proposal.length, 3, 'one night per active player');
  assert.deepEqual(preview.json.proposal.map(p => p.game_date), ['2099-03-01', '2099-03-15', '2099-03-29']);
  assert.equal(db.getSchedule().length, before, 'PREVIEW MUST NOT WRITE');
  ok('randomize proposes a rotation and writes nothing');

  const committed = await req('POST', '/api/schedule/commit', {
    mode: 'append',
    entries: preview.json.proposal.map(p => ({ player_id: p.player_id, game_date: p.game_date }))
  });
  assert.equal(committed.status, 200);
  assert.equal(committed.json.upcoming.length, 5, 'appended to the existing two');
  ok('commit(append) keeps the nights that were already scheduled');

  const historyBefore = db.getSchedule().filter(s => s.status !== 'pending').length;
  const replaced = await req('POST', '/api/schedule/commit', {
    mode: 'replace',
    entries: [{ player_id: 1, game_date: '2099-06-01' }]
  });
  assert.equal(replaced.json.upcoming.length, 1, 'replace clears other pending nights');
  assert.equal(db.getSchedule().filter(s => s.status !== 'pending').length, historyBefore,
    'REPLACE MUST NEVER TOUCH HISTORY');
  ok('commit(replace) clears pending nights and leaves history intact');

  // ---------- 5. VALIDATION ----------
  console.log('\n5. Validation');
  const bad = [
    ['POST', '/api/schedule/randomize', { start_date: '2099-02-30' }, /not a real calendar date/],
    ['POST', '/api/schedule/randomize', { start_date: 'tuesday' }, /YYYY-MM-DD/],
    ['POST', '/api/schedule/commit', { mode: 'append', entries: [{ player_id: 1, game_date: '2099-08-01' }, { player_id: 2, game_date: '2099-08-01' }] }, /same date/],
    ['POST', '/api/players', { name: '' }, /name is required/],
    ['POST', '/api/players', { name: 'Dave', discord_id: 'not-a-snowflake' }, /Discord ID/],
    ['PATCH', '/api/settings', { timezone: 'Mars/Olympus' }, /not a valid IANA timezone/],
    ['PATCH', '/api/settings', { reminderTime: '25:99' }, /not a valid HH:MM/],
    ['PATCH', '/api/schedule/999999', { status: 'completed' }, /not found/],
    ['PATCH', '/api/schedule/1', { status: 'invented' }, /Status must be one of/]
  ];
  for (const [method, path, body, pattern] of bad) {
    const res = await req(method, path, body);
    assert.ok(res.status >= 400, `${method} ${path} should be rejected, got ${res.status}`);
    assert.match(res.json.error, pattern, `${method} ${path} error text`);
  }
  ok(`${bad.length} malformed requests were all rejected with a readable message`);

  const malformed = await fetch(BASE + '/api/players', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oh no'
  });
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).error, /valid JSON/);
  ok('a malformed JSON body is a 400, not a crash');

  // ---------- 6. EDITING A NIGHT ----------
  console.log('\n6. Editing');
  const target = (await req('GET', '/api/state')).json.upcoming[0];
  let after = (await req('PATCH', `/api/schedule/${target.id}`, { game_date: '2099-07-04' })).json;
  assert.equal(after.upcoming[0].game_date, '2099-07-04');
  ok('PATCH moves a night');

  after = (await req('PATCH', `/api/schedule/${target.id}`, { player_id: 2 })).json;
  assert.equal(after.upcoming[0].host, 'Bob');
  assert.equal(after.upcoming[0].notified, false, 'a new host has not been asked yet');
  ok('PATCH changes the host and clears the "already asked" flag');

  after = (await req('POST', `/api/schedule/${target.id}/rsvp`, {
    discord_id: '100000000000000001', status: 'going'
  })).json;
  assert.equal(after.upcoming[0].counts.going, 1);
  assert.equal(after.upcoming[0].rsvps[0].name, 'Alice', 'a linked player resolves to their name');
  ok('RSVPs can be set from the panel and resolve to player names');

  after = (await req('DELETE', `/api/schedule/${target.id}/rsvp/100000000000000001`)).json;
  assert.equal(after.upcoming[0].rsvps.length, 0);
  ok('an RSVP can be cleared back to "no answer"');

  after = (await req('PATCH', `/api/schedule/${target.id}`, { notes: 'Played Brass. Miguel won.' })).json;
  assert.equal(after.upcoming[0].notes, 'Played Brass. Miguel won.');
  ok('a night carries free-text notes for the history page');

  after = (await req('PATCH', `/api/schedule/${target.id}`, { flags: { reminder_sent: true } })).json;
  assert.equal(after.upcoming[0].reminder_sent, true);
  ok('the "already sent" flags are editable so a notice can be re-sent');

  // Status last: it moves the entry out of `upcoming` entirely.
  after = (await req('PATCH', `/api/schedule/${target.id}`, { status: 'completed' })).json;
  assert.ok(after.past.some(e => e.id === target.id && e.status === 'completed'));
  assert.equal(after.past.find(e => e.id === target.id).notes, 'Played Brass. Miguel won.',
    'notes survive the status change');
  ok('recording an outcome moves the night into history with its notes');

  // ---------- 7. DELETING AND SHIFTING ----------
  console.log('\n7. Deleting and shifting');
  await req('POST', '/api/schedule/commit', {
    mode: 'replace',
    entries: [
      { player_id: 1, game_date: '2099-09-01' },
      { player_id: 2, game_date: '2099-09-08' },
      { player_id: 3, game_date: '2099-09-15' }
    ]
  });
  let ids = (await req('GET', '/api/state')).json.upcoming.map(e => e.id);
  after = (await req('POST', `/api/schedule/${ids[0]}/postpone`)).json;
  assert.deepEqual(after.upcoming.map(e => e.game_date), ['2099-09-08', '2099-09-15', '2099-09-22'],
    'the whole season slides forward one interval');
  assert.equal(after.upcoming[0].host, 'Alice', 'and the skipping host keeps their turn');
  ok('postpone cancels the night and shifts everything after it');

  ids = after.upcoming.map(e => e.id);
  after = (await req('DELETE', `/api/schedule/${ids[1]}`)).json;
  assert.deepEqual(after.upcoming.map(e => e.game_date), ['2099-09-08', '2099-09-22'],
    'a plain delete leaves the other dates alone');
  ok('a plain delete removes one night without moving any other');

  // database.js's removeGameAndShiftSchedule is deliberately NOT reachable from
  // the panel: it deactivates the host as a side effect, which is right for the
  // Discord "I'm out of the rotation" button and wrong for a Delete button.
  const hostBefore = after.upcoming[0].player_id;
  after = (await req('DELETE', `/api/schedule/${after.upcoming[0].id}?shift=true`)).json;
  assert.equal(after.players.find(p => p.id === hostBefore).is_active, true,
    'DELETING A NIGHT MUST NEVER DEACTIVATE ITS HOST');
  assert.deepEqual(after.upcoming.map(e => e.game_date), ['2099-09-22'],
    'the query string is ignored; other dates never move');
  ok('no query string can turn a delete into a rotation-wide shift');

  // ---------- 8. PLAYERS ----------
  console.log('\n8. Players');
  after = (await req('POST', '/api/players', { name: 'Dave', discord_id: '100000000000000003' })).json;
  assert.ok(after.players.some(p => p.name === 'Dave' && p.is_active));
  ok('a player can be added with a Discord link');

  const dave = after.players.find(p => p.name === 'Dave');
  after = (await req('PATCH', `/api/players/${dave.id}`, { name: 'David', is_active: false })).json;
  const david = after.players.find(p => p.id === dave.id);
  assert.equal(david.name, 'David', 'renamed');
  assert.equal(david.is_active, false, 'and deactivated in the same request');
  assert.equal(david.discord_id, '100000000000000003', 'without losing the Discord link');
  ok('a rename and a status change in one PATCH do not clobber each other');

  after = (await req('PATCH', `/api/players/${dave.id}`, { discord_id: '' })).json;
  assert.equal(after.players.find(p => p.id === dave.id).discord_id, null);
  ok('clearing the Discord ID unlinks rather than storing an empty string');

  const inactiveCount = (await req('POST', '/api/schedule/randomize', { start_date: '2099-11-01' })).json.proposal.length;
  assert.equal(inactiveCount, 3, 'a deactivated player is left out of new rotations');
  ok('deactivated players keep their history but draw no new nights');

  after = (await req('DELETE', `/api/players/${dave.id}`)).json;
  assert.equal(after.players.some(p => p.id === dave.id), false);
  ok('a player can be removed outright');

  // ---------- 9. SETTINGS ----------
  console.log('\n9. Settings');
  const hookBefore = settingsHookCalls;
  after = (await req('PATCH', '/api/settings', {
    reminderTime: '18:30',
    timezone: 'America/Denver',
    announcementsChannel: '100000000000000009',
    notificationsChannel: ''
  })).json;
  assert.equal(after.settings.reminderTime, '18:30');
  assert.equal(after.reminder.timeLabel, '18:30', 'the resolved cron reflects it immediately');
  assert.equal(after.reminder.timezone, 'America/Denver');
  assert.equal(after.settings.notificationsChannel, '', 'an empty channel clears the setting');
  assert.ok(settingsHookCalls > hookBefore, 'the cron must be rebuilt on save, not on next restart');
  ok('settings save, re-resolve the cron, and fire the reschedule hook');

  // ---------- 10. THE PUBLIC SNAPSHOT IS STILL PUBLIC ----------
  console.log('\n10. Public snapshot hygiene');
  db.updateSettings('timezone', 'America/Chicago');
  const snapshot = (await req('GET', '/public/schedule.json')).json;
  const serialized = JSON.stringify(snapshot);
  assert.ok(snapshot.updatedAt && Array.isArray(snapshot.schedule));
  assert.deepEqual(Object.keys(snapshot.schedule[0]).sort(), ['date', 'host', 'status'],
    'the public snapshot exposes exactly three fields');
  assert.equal(serialized.includes('100000000000000'), false, 'NO DISCORD IDS IN THE PUBLIC SNAPSHOT');
  assert.equal(serialized.includes('rsvp'), false, 'no RSVPs in the public snapshot');
  assert.equal(serialized.includes('notes'), false, 'no notes in the public snapshot');
  ok('the public snapshot leaks no Discord IDs, RSVPs or notes');

  // ---------- 11. NO PER-REQUEST Intl CHURN ----------
  console.log('\n11. Formatter reuse');
  // Warm every timezone-dependent path once, then check that repeating it
  // builds nothing new. Without the cache in time.js this counts in the
  // hundreds per page load, and the container's resident memory climbs and
  // never comes back down.
  today(0); isReminderWindowOpen(); await req('GET', '/api/state');
  const buildsBefore = intlBuilds;
  for (let i = 0; i < 50; i++) { today(0); isReminderWindowOpen(); }
  assert.equal(intlBuilds, buildsBefore,
    `100 date/clock formats built ${intlBuilds - buildsBefore} new Intl formatters; expected 0`);

  for (let i = 0; i < 25; i++) await req('GET', '/api/state');
  assert.equal(intlBuilds, buildsBefore,
    `25 /api/state calls built ${intlBuilds - buildsBefore} new Intl formatters; expected 0`);
  ok('neither date maths nor /api/state constructs a new Intl formatter after warm-up');

  // The cache must not become its own leak when fed arbitrary strings.
  const { isValidTimezone } = await import('./time.js');
  for (let i = 0; i < 500; i++) assert.equal(isValidTimezone(`Not/AZone${i}`), false);
  assert.equal(isValidTimezone('America/Chicago'), true, 'a real zone still validates after a flood');
  ok('the timezone cache is capped, so bogus input cannot grow it without bound');

  // ---------- 12. THE SUGGESTED INTERVAL ----------
  console.log('\n12. Randomizer pre-fill');
  // A weekly rotation plus one unresolved night from a month ago. Measuring the
  // gap across that stale entry reports 35 days, and the randomizer would then
  // offer 35 as the interval -- a number somebody accepts without reading.
  await req('POST', '/api/schedule/commit', { mode: 'replace', entries: [
    { player_id: 1, game_date: '2099-12-01' },
    { player_id: 2, game_date: '2099-12-08' },
    { player_id: 3, game_date: '2099-12-15' }
  ] });
  db.appendSchedule([{ player_id: 1, game_date: '2020-05-05' }]);   // long past, still pending

  let suggestion = (await req('GET', '/api/suggest-next-date')).json;
  assert.equal(suggestion.interval_days, 7,
    `stale pending night skewed the suggested interval to ${suggestion.interval_days}`);
  assert.equal(suggestion.start_date, '2099-12-22', 'the next slot follows the last FUTURE night');
  assert.equal((await req('GET', '/api/state')).json.intervalDays, 7);
  ok('an unresolved night from months ago does not set the randomizer pace');

  // One hand-moved night should not either: 7, 7, 9 is still a weekly rotation.
  const rows = (await req('GET', '/api/state')).json.upcoming;
  await req('PATCH', `/api/schedule/${rows[rows.length - 1].id}`, { game_date: '2099-12-17' });
  suggestion = (await req('GET', '/api/suggest-next-date')).json;
  assert.equal(suggestion.interval_days, 7, 'the most common gap wins over an odd one');
  ok('a single hand-moved night does not change the suggested interval');

  // With nothing ahead at all it still has to answer something usable.
  await req('POST', '/api/schedule/commit', { mode: 'replace', entries: [{ player_id: 1, game_date: '2099-12-01' }] });
  suggestion = (await req('GET', '/api/suggest-next-date')).json;
  assert.ok(suggestion.interval_days >= 1, 'a single upcoming night still yields a usable interval');
  assert.match(suggestion.start_date, /^\d{4}-\d{2}-\d{2}$/);
  ok('a one-night schedule still produces a sane suggestion');

  console.log(`\n✅ ALL WEB TESTS PASSED (${pass} checks) ✅`);
} finally {
  stopWebServer(server);
  fs.rmSync(DIR, { recursive: true, force: true });
}
