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
    ['/', 'id="app-name"'],
    ['/app.css', '--accent'],
    ['/app.js', 'control panel'],
    ['/search.js', 'export function searchGames']
  ]) {
    const res = await req('GET', path);
    assert.equal(res.status, 200, `${path} should serve`);
    assert.ok(res.text.includes(needle), `${path} should contain ${needle}`);
  }
  ok('control panel HTML, CSS and JS all serve');

  // app.js imports search.js, so the tag has to say module and the import has
  // to be reachable -- miss either and the panel dies silently on load.
  const shell = (await req('GET', '/')).text;
  assert.match(shell, /<script type="module" src="app\.js">/, 'app.js must load as a module');
  assert.ok((await req('GET', '/')).text.includes('id="games-sync-bgg"'),
    'the Games tab offers a BGG XML API sync');
  const gamesTab = (await req('GET', '/')).text;
  assert.ok(gamesTab.includes('id="games-search"'), 'search is on the Games tab');
  assert.ok(gamesTab.includes('id="games-expansions"'), 'Show expansions is a checkbox');
  assert.ok(gamesTab.includes('id="games-owned"'), 'Owned only is a checkbox');
  assert.match(gamesTab, /Show expansions/);
  assert.match(gamesTab, /Owned only/);
  assert.ok(gamesTab.includes('id="games-upload"'), 'the import card can take a file from the browser');
  assert.equal((await req('GET', '/not-an-asset.js')).status, 404, 'the asset allowlist stays closed');
  ok('the panel loads as an ES module and its shared scorer resolves');

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
  assert.ok(pub.text.includes('Coming up'), 'public page renders');
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

  // ---------- 13. THE INSTALL NAMES ITSELF ----------
  console.log('\n13. Display name');
  // Every install is somebody else's group. The panel, the browser tab and the
  // public page all read from one setting rather than a hardcoded string.
  let named = (await req('GET', '/api/state')).json;
  assert.equal(named.displayName, 'Game Night', 'unset falls back to a sane default');

  named = (await req('PATCH', '/api/settings', { displayName: '  The Dice Monster  ' })).json;
  assert.equal(named.displayName, 'The Dice Monster', 'a set name is trimmed and used');
  assert.equal(named.settings.displayName, 'The Dice Monster', 'and is reported as explicitly set');
  assert.equal((await req('GET', '/public/schedule.json')).json.displayName, 'The Dice Monster',
    'the public page names the group too');
  ok('a group can name itself, and the name reaches the public page');

  const longName = 'x'.repeat(200);
  named = (await req('PATCH', '/api/settings', { displayName: longName })).json;
  assert.equal(named.displayName.length, 60, 'an over-long name is capped rather than rejected');
  ok('an absurd name is truncated, not an error');

  named = (await req('PATCH', '/api/settings', { displayName: '' })).json;
  assert.equal(named.displayName, 'Game Night', 'clearing it returns to the default');
  assert.equal(named.settings.displayName, '', 'and the raw setting reads back empty');
  ok('clearing the name falls back rather than showing blank');

  // ---------- 14. GAME LIBRARY ----------
  console.log('\n14. Game library');
  // The library is imported from a Geekgroup dump rather than fetched, so this
  // section stands up a two-game one by hand. The interesting parts are the
  // shape of the clean model and the joins onto the roster -- who owns what,
  // and whose ratings count as "ours".
  const importDir = `${DIR}/bgg-import`;
  fs.mkdirSync(importDir, { recursive: true });

  const bggUser = (id, name, fullname) => ({ id, name, fullname, sortname: fullname.toLowerCase(), avatar: '' });
  const statuses = own => ({
    own, prevowned: [], fortrade: [], want: [], wanttoplay: [],
    wanttobuy: [], wishlist: [], preordered: [], hasparts: [], wantparts: []
  });
  const dump = {
    pages: 1,
    collection: [
      {
        id: 13, nested: [99],
        game: {
          id: 13, type: 1, rename: '', name: 'Catan', originalName: 'Die Siedler von Catan',
          published: 1995, rating_avg: 7.1, rating_count: 12000, contains: [],
          players_min: 3, players_max: 4, players_community: { best: [4], recommended: [3, 4] },
          time_min: 60, time_max: 120, weight_avg: 2.3, rank: 500, worth: { value: 42.5 }
        },
        group: { rating_avg: 6.4, rating_count: 2 },
        users: { play_last: '1596240000', totalPlays: 9, played: { 501: 9 }, rated: { 501: 6.0, 502: 8.0, 503: 9.5 }, status: statuses([501, 502]) }
      },
      {
        id: 21, nested: [],
        game: {
          id: 21, type: 1, rename: 'House Rules Chess', name: 'Chess', originalName: 'Chess',
          published: 1475, rating_avg: 7.2, rating_count: 5000, contains: []
        },
        group: { rating_avg: 0, rating_count: 0 },
        users: { play_last: 0, totalPlays: 0, played: [], rated: [], status: statuses([503]) }
      }
    ],
    data: {
      games: [{ id: 13, name: 'Catan' }, { id: 99, name: 'Catan: Seafarers' }],
      users: [bggUser(501, 'ada', 'Ada Lovelace'), bggUser(502, 'grace', 'Grace Hopper'), bggUser(503, 'alan', 'Alan Turing')],
      nested: [{
        id: 99, nested: [],
        game: { id: 99, type: 2, rename: '', name: 'Catan: Seafarers', originalName: 'Catan: Seafarers', published: 1997, contains: [] },
        users: { status: statuses([501]) }
      }],
      contains: []
    }
  };
  fs.writeFileSync(`${importDir}/dump.json`, JSON.stringify(dump));

  let lib = (await req('GET', '/api/games')).json;
  assert.deepEqual(lib.games, [], 'no library before the first import');
  assert.ok(lib.imports.includes('dump.json'), 'a dump dropped into bgg-import is offered');
  ok('an empty library reads back empty rather than erroring');

  for (const [file, needle] of [
    ['../db.json', 'must be a .json or .csv'],
    ['..\\db.json', 'must be a .json or .csv'],
    ['nope.json', 'No import file'],
    ['notes.txt', 'must be a .json or .csv']
  ]) {
    const bad = await req('POST', '/api/games/import', { file });
    assert.equal(bad.status, 400, `${file} should be refused`);
    assert.ok(bad.json.error.includes(needle), `${file}: ${bad.json.error}`);
  }
  ok('path traversal and unsupported extensions are refused');

  // JSON API bodies stay at 256 KB so a dump cannot ride in on /import. The
  // upload route reads the file as a raw body with a higher cap instead.
  const bloated = await req('PATCH', '/api/settings', { displayName: 'x'.repeat(300 * 1024) });
  assert.equal(bloated.status, 400, 'other endpoints keep the small JSON cap');
  assert.match(bloated.json.error, /too large/i);

  async function upload(name, body) {
    const res = await fetch(`${BASE}/api/games/import-upload?file=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* */ }
    return { status: res.status, json };
  }

  const uploaded = await upload('from-panel.json', '{"pages":1,"collection":[]}');
  assert.equal(uploaded.status, 200, uploaded.json?.error);
  assert.equal(uploaded.json.file, 'from-panel.json');
  assert.ok(uploaded.json.imports.includes('from-panel.json'));
  assert.equal(fs.readFileSync(`${importDir}/from-panel.json`, 'utf-8'), '{"pages":1,"collection":[]}');

  const fat = await upload('fat.json', `{"collection":[]}${ ' '.repeat(300 * 1024)}`);
  assert.equal(fat.status, 200, 'a dump larger than the JSON cap still lands');
  assert.ok(fs.statSync(`${importDir}/fat.json`).size > 300 * 1024);

  for (const [file, needle] of [
    ['../db.json', 'must be a .json or .csv'],
    ['notes.txt', 'must be a .json or .csv'],
    ['', 'filename is required']
  ]) {
    const bad = await upload(file, '{"collection":[]}');
    assert.equal(bad.status, 400, `${file || '(empty)'} should be refused`);
    assert.ok(bad.json.error.includes(needle), `${file || '(empty)'}: ${bad.json.error}`);
  }
  assert.equal((await upload('empty.json', '')).status, 400, 'an empty upload is refused');
  ok('a dump can be uploaded into bgg-import from the panel');

  assert.equal((await req('POST', '/api/games/import', { file: 'dump.json' })).status, 200);
  lib = (await req('GET', '/api/games')).json;
  assert.equal(lib.games.length, 2, 'two base games; the expansion is not a row of its own');
  assert.equal(lib.meta.expansion_count, 1, 'the expansion is attached to its parent');
  assert.equal(lib.users.length, 3, 'the group members come across');

  const catan = lib.games.find(g => g.id === 13);
  assert.equal(catan.original_name, 'Die Siedler von Catan', 'the original name is kept alongside');
  assert.equal(catan.published, 1995);
  assert.deepEqual(catan.status.own, [501, 502], 'ownership is a list of BGG user ids');
  assert.deepEqual(catan.status.prev_owned, [], 'run-together source keys are spelled out');
  assert.equal(catan.rating.bgg_average, 7.1, 'BGG average');
  assert.equal(catan.rating.group_average, 6.4, 'Geekgroup average');
  assert.equal(catan.plays.total_plays, 9);
  assert.equal(catan.plays.last_play, '2020-08-01', 'epoch seconds become a calendar date');
  assert.deepEqual(catan.expansions.map(e => e.name), ['Catan: Seafarers']);
  ok('a dump normalizes into the clean model, expansions folded into their parent');

  const chess = lib.games.find(g => g.id === 21);
  assert.equal(chess.name, 'House Rules Chess', 'a local rename wins over the catalogue name');
  assert.equal(chess.rating.average, null, 'no ratings averages to nothing, not to zero');
  assert.equal(chess.plays.last_play, null, 'never played reads as null, not 1970');
  ok('renames, missing ratings and missing plays all degrade honestly');

  // Nobody is linked yet, so "our average" has nobody to restrict to and falls
  // back to every rater: (6.0 + 8.0 + 9.5) / 3.
  assert.equal(catan.rating.average, 7.83, 'unlinked, the average covers every rater');

  const ada = (await req('POST', '/api/players', { name: 'Ada' })).json.players.find(p => p.name === 'Ada');
  assert.equal((await req('PATCH', `/api/players/${ada.id}`, { bgg_user_id: 501, bgg_username: 'ada' })).status, 200);
  const grace = (await req('POST', '/api/players', { name: 'Grace' })).json.players.find(p => p.name === 'Grace');
  await req('PATCH', `/api/players/${grace.id}`, { bgg_user_id: 502, bgg_username: 'grace' });

  const clash = await req('PATCH', `/api/players/${grace.id}`, { bgg_user_id: 501, bgg_username: 'ada' });
  assert.equal(clash.status, 400, 'two players cannot share one BGG account');
  assert.ok(clash.json.error.includes('already linked to Ada'), clash.json.error);
  ok('a BGG account links to exactly one player');

  assert.equal((await req('POST', '/api/games/rebuild')).status, 200);
  lib = (await req('GET', '/api/games')).json;
  const relinked = lib.games.find(g => g.id === 13);
  assert.equal(relinked.rating.average, 7, 'with Ada and Grace linked, the average is theirs alone: (6.0 + 8.0) / 2');
  assert.equal(relinked.rating.bgg_average, 7.1, 'the BGG average is untouched by who we linked');
  assert.equal(lib.users.find(u => u.id === 501).discord, null, 'an unlinked Discord stays null');
  ok('linking a player narrows the group average to us, without refetching');

  const unlinked = await req('PATCH', `/api/players/${grace.id}`, { bgg_user_id: null });
  assert.equal(unlinked.json.players.find(p => p.id === grace.id).bgg_user_id, null);
  ok('a BGG link can be cleared again');

  // Sync is configured entirely through settings, and refuses to run unconfigured.
  const unconfigured = await req('POST', '/api/games/sync');
  assert.equal(unconfigured.status, 400);
  assert.ok(unconfigured.json.error.includes('No collection request'), unconfigured.json.error);

  // BGG_APP_TOKEN lives in the environment, never in db.json, and never in
  // a payload the browser can read. The Geekgroup token below is a different
  // secret (bggTokenSet); this one is the XML API bearer.
  const prevAppToken = process.env.BGG_APP_TOKEN;
  const APP_TOKEN = 'web-test-bgg-app-token';
  delete process.env.BGG_APP_TOKEN;
  const noApp = (await req('GET', '/api/state')).json.settings;
  assert.equal(noApp.bggAppTokenSet, false);
  assert.equal(noApp.bggAppToken, undefined);
  const missing = await req('POST', '/api/games/sync', { source: 'bgg' });
  assert.equal(missing.status, 400);
  assert.match(missing.json.error, /BGG_APP_TOKEN/);

  process.env.BGG_APP_TOKEN = APP_TOKEN;
  const flagged = (await req('GET', '/api/state')).json;
  assert.equal(flagged.settings.bggAppTokenSet, true, 'the panel is told the XML API token is set');
  assert.equal(flagged.settings.bggAppToken, undefined, 'but never what it is');
  assert.ok(!JSON.stringify(flagged).includes(APP_TOKEN), 'the token is absent from state');

  await req('PATCH', `/api/players/${ada.id}`, { bgg_user_id: null });
  const noNames = await req('POST', '/api/games/sync', { source: 'bgg' });
  assert.equal(noNames.status, 400);
  assert.match(noNames.json.error, /BGG username/);
  assert.ok(!JSON.stringify(noNames.json).includes(APP_TOKEN));
  await req('PATCH', `/api/players/${ada.id}`, { bgg_user_id: 501, bgg_username: 'ada' });
  if (prevAppToken === undefined) delete process.env.BGG_APP_TOKEN;
  else process.env.BGG_APP_TOKEN = prevAppToken;
  ok('the BGG XML API token is env-only and never returned to the browser');

  delete process.env.BGG_APP_TOKEN;
  const noUser = await req('POST', '/api/games/user', { username: 'ada' });
  assert.equal(noUser.status, 400);
  assert.match(noUser.json.error, /BGG_APP_TOKEN/);
  process.env.BGG_APP_TOKEN = APP_TOKEN;
  assert.equal((await req('POST', '/api/games/user', { username: '' })).status, 400);
  if (prevAppToken === undefined) delete process.env.BGG_APP_TOKEN;
  else process.env.BGG_APP_TOKEN = prevAppToken;
  ok('a username lookup refuses to run without the XML API token');

  const badUrl = await req('PATCH', '/api/settings', { bggCollectionUrl: 'not-a-url' });
  assert.equal(badUrl.status, 400, 'a collection URL has to look like one');

  const configured = (await req('PATCH', '/api/settings', {
    bggCollectionUrl: 'https://api.geekgroup.app/api/groups/collection.json?page={page}',
    bggToken: 'a-geekgroup-token'
  })).json;
  assert.equal(configured.settings.bggCollectionUrl, 'https://api.geekgroup.app/api/groups/collection.json?page={page}');
  assert.equal(configured.settings.bggTokenSet, true, 'the panel is told a token is set');
  assert.equal(configured.settings.bggToken, undefined, 'but the token itself never leaves the server');
  ok('the collection URL is validated and the access token is write-only');

  const PLAY_SECRET = 'bgg-play-password-not-real';
  const prevPlay = process.env.BGG_PASSWORD;
  delete process.env.BGG_PASSWORD;
  const withUser = (await req('PATCH', '/api/settings', { bggUsername: 'jeffwain' })).json;
  assert.equal(withUser.settings.bggUsername, 'jeffwain');
  assert.equal(withUser.settings.bggPasswordSet, false, 'username alone is not a login');
  assert.equal(withUser.settings.bggPassword, undefined);

  process.env.BGG_PASSWORD = PLAY_SECRET;
  const withPass = (await req('GET', '/api/state')).json;
  assert.equal(withPass.settings.bggPasswordSet, true);
  assert.equal(withPass.settings.bggPassword, undefined);
  assert.ok(!JSON.stringify(withPass).includes(PLAY_SECRET), 'the BGG password never leaves the server');

  const stuffed = (await req('PATCH', '/api/settings', { bggPassword: PLAY_SECRET })).json;
  assert.equal(stuffed.settings.bggPassword, undefined);
  assert.ok(!JSON.stringify(stuffed).includes(PLAY_SECRET), 'a password in the PATCH body is ignored');

  delete process.env.BGG_PASSWORD;
  const wipedLogin = (await req('PATCH', '/api/settings', { bggUsername: '' })).json;
  assert.equal(wipedLogin.settings.bggUsername, '');
  assert.equal(wipedLogin.settings.bggPasswordSet, false);
  if (prevPlay === undefined) delete process.env.BGG_PASSWORD;
  else process.env.BGG_PASSWORD = prevPlay;
  ok('BGG play username is in settings; the password is env-only');

  assert.equal((await req('GET', '/api/games/sync')).json.status, 'ok', 'sync status is pollable');

  // Saving just the collection fields must not disturb everything else, which
  // is what the card's own Save button does.
  const priorSettings = (await req('GET', '/api/state')).json.settings;
  const only = (await req('PATCH', '/api/settings', { bggToken: 'a-replacement-token' })).json;
  assert.equal(only.settings.bggTokenSet, true, 'the token survives a partial save');
  assert.equal(only.settings.reminderTime, priorSettings.reminderTime, 'and an unsent field is left alone');
  assert.equal(only.settings.timezone, priorSettings.timezone, 'as is the timezone');

  // Omitting the key entirely means "leave it", not "clear it" -- the panel
  // sends nothing when the box is empty, and the stored token has to survive.
  const untouched = (await req('PATCH', '/api/settings', { bggCollectionUrl: 'https://example.test/c.json' })).json;
  assert.equal(untouched.settings.bggTokenSet, true, 'an absent bggToken leaves the saved one in place');
  ok('the token survives saves that do not mention it');

  // Clearing the URL and testing needs no network, and is the branch worth
  // pinning: the rest of the probe is one HTTP call to somebody else's server.
  await req('PATCH', '/api/settings', { bggCollectionUrl: '' });
  const noUrl = await req('POST', '/api/games/test');
  assert.equal(noUrl.status, 400);
  assert.ok(noUrl.json.error.includes('No collection request'), noUrl.json.error);
  assert.equal((await req('GET', '/api/state')).json.settings.bggTokenSet, true,
    'clearing the URL does not clear the token');
  ok('the connection test refuses to run unconfigured, and says why');

  // ---------- 16. CAPTURED REQUEST ----------
  console.log('\n16. Captured collection request');
  // The collection endpoint is an undocumented POST: the group lives in a
  // multi-kilobyte JSON body and the sign-in rides on session cookies, so the
  // panel stores a whole request copied out of the browser rather than trying
  // to rebuild one from a URL and a token.
  const curl = [
    "curl 'https://api.geekgroup.app/api/groups/collection.json'",
    '--compressed',
    '-X POST',
    "-H 'User-Agent: Mozilla/5.0'",
    "-H 'Content-Type: application/json'",
    "-H 'Authorization: sekrit-token'",
    "-H 'Host: api.geekgroup.app'",
    "-H 'Content-Length: 24'",
    "-b 'token=sekrit-token; fueldid=abc'",
    `--data-raw '${JSON.stringify({ page: 1, sort: 'name', filters: { own: true } })}'`
  ].join(' \\\n  ');

  const notCurl = await req('PATCH', '/api/settings', { bggRequest: 'not a curl command' });
  assert.equal(notCurl.status, 400);
  assert.ok(notCurl.json.error.includes('cURL'), notCurl.json.error);

  const saved = (await req('PATCH', '/api/settings', { bggRequest: curl })).json;
  const cap = saved.settings.bggRequest;
  assert.equal(cap.method, 'POST', 'the method is taken from the capture, not assumed');
  assert.equal(cap.host, 'api.geekgroup.app');
  assert.ok(cap.bodyBytes > 0, 'the JSON body is kept -- it is what selects the group');
  assert.deepEqual(cap.secrets, ['Authorization', 'Cookie'], 'and so are the credentials');
  assert.ok(!JSON.stringify(cap).includes('sekrit-token'),
    'but the panel is told only that they exist, never what they are');
  // Connection-level headers describe the browser's socket, not the request.
  assert.ok(!cap.headers.includes('Host'), 'Host is dropped');
  assert.ok(!cap.headers.includes('Content-Length'), 'so is Content-Length');
  assert.equal(saved.settings.bggCollectionUrl, 'https://api.geekgroup.app/api/groups/collection.json',
    'the URL is kept in step so the rest of the panel can show it');
  ok('a copied cURL command is parsed, stored, and described without leaking its secrets');

  const { parseCurl } = await import('./bgg/curl.js');
  const { bodyForPage } = await import('./bgg/geekgroup.js');
  // Windows browsers copy with double quotes and ^ escapes instead.
  const win = parseCurl(`curl "https://api.geekgroup.app/api/groups/collection.json" ^\n  -X POST ^\n  -H "Authorization: abc" ^\n  --data-raw "{\\"page\\":1}"`);
  assert.equal(win.url, 'https://api.geekgroup.app/api/groups/collection.json');
  assert.equal(win.method, 'POST');
  assert.equal(win.headers.Authorization, 'abc');
  assert.equal(win.body, '{"page":1}');
  ok('the Windows flavour of Copy as cURL parses too');

  // Paging has to reach into the body, since that is where the page number is.
  assert.equal(JSON.parse(bodyForPage('{"page":1,"sort":"name"}', 7)).page, 7);
  assert.equal(JSON.parse(bodyForPage('{"sort":"name"}', 3)).page, 3, 'added when absent');
  assert.equal(bodyForPage('{"p":{page}}', 4), '{"p":4}', 'an explicit placeholder wins');
  assert.equal(bodyForPage(null, 2), null, 'a bodyless request stays bodyless');
  assert.equal(bodyForPage('not json', 2), 'not json', 'and a non-JSON body is replayed untouched');
  ok('the page number is substituted into the request body');

  // A saved capture must not be wiped by an unrelated settings save.
  await req('PATCH', '/api/settings', { displayName: 'Klatch Night' });
  assert.equal((await req('GET', '/api/state')).json.settings.bggRequest.method, 'POST',
    'an unrelated save leaves the capture alone');
  const cleared = (await req('PATCH', '/api/settings', { bggRequest: '' })).json;
  assert.equal(cleared.settings.bggRequest, null, 'and an explicit empty clears it');
  ok('the capture survives unrelated saves and clears only on request');
  assert.ok(
    (await req('GET', '/')).headers.get('content-security-policy').includes('cf.geekdo-static.com'),
    'avatars need the CDN in img-src'
  );
  assert.ok(
    (await req('GET', '/')).headers.get('content-security-policy').includes("default-src 'self'"),
    'and nothing else about the policy loosened'
  );
  ok('the CSP allows BGG avatars and nothing more');

  // ---------- 15. CSV EXPORT IMPORT ----------
  console.log('\n15. CSV import');
  // Geekgroup also exports a CSV covering the whole collection in one file. It
  // is the only source that needs no token, and it costs the per-person detail:
  // an owner count instead of names, no per-member ratings, no last-play date.
  fs.writeFileSync(`${importDir}/export.csv`, [
    '"Game ID",Name,Expansion,Owners,"Min Players","Max Players","Recommended Players","Best Players","Min Duration","Max Duration",Weight,Plays,"Group Rating","Group Votes","BGG Rating",Rank,"Estimated Value"',
    '13,Catan,-,2,3,4,"3,4","3,4",60,120,2.3,9,6.4,2,7.1,500,42.5',
    '99,"Catan: Seafarers",Y,1,3,4,"3,4",4,90,150,2.5,0,-,0,7.3,0,25',
    '21,"Chess, with commas",-,0,2,2,2,2,10,60,3.7,0,-,0,7.2,-,10'
  ].join('\n'));

  const csvList = (await req('GET', '/api/games')).json.imports;
  assert.ok(csvList.includes('export.csv'), 'a .csv is offered alongside .json dumps');

  assert.equal((await req('POST', '/api/games/import', { file: 'export.csv' })).status, 200);
  const csvLib = (await req('GET', '/api/games')).json;
  assert.equal(csvLib.meta.source, 'csv', 'the library records which source built it');
  assert.equal(csvLib.games.length, 3, 'expansions are flat rows: the CSV carries no parent link');

  const csvCatan = csvLib.games.find(g => g.id === 13);
  assert.deepEqual(csvCatan.status.own, [], 'the CSV cannot name owners');
  assert.equal(csvCatan.owner_count, 2, 'but it does count them, and that is not "nobody"');
  assert.equal(csvCatan.rating.average, null, 'no per-member ratings to average');
  assert.equal(csvCatan.rating.group_average, 6.4);
  assert.equal(csvCatan.rating.bgg_average, 7.1);
  assert.equal(csvCatan.plays.total_plays, 9);
  assert.equal(csvCatan.plays.last_play, null, 'the export drops the date, keeping only the count');
  assert.deepEqual(csvCatan.details.players_best, [3, 4], 'a quoted comma-separated column parses as a list');
  assert.equal(csvCatan.details.weight, 2.3);
  assert.ok(csvLib.games.find(g => g.id === 99).is_expansion, 'the Expansion column is honoured');
  assert.equal(csvLib.games.find(g => g.id === 21).name, 'Chess, with commas', 'quoted commas survive');
  assert.equal(csvLib.games.find(g => g.id === 21).details.rank, null, '"-" is not zero');
  ok('a CSV export imports, with its per-person gaps reported rather than faked');

  // Rebuild reads whatever the last run archived; a CSV run is one file, not pages.
  assert.equal((await req('POST', '/api/games/rebuild')).status, 200);
  assert.equal((await req('GET', '/api/games')).json.games.length, 3,
    'rebuilding a CSV-sourced library does not empty it');
  ok('rebuild works against a CSV archive as well as a JSON one');

  // Back to the richer source, which must fully replace the thinner one.
  await req('POST', '/api/games/import', { file: 'dump.json' });
  const back = (await req('GET', '/api/games')).json;
  assert.equal(back.games.length, 2, 'the JSON import replaces the CSV library outright');
  assert.deepEqual(back.games.find(g => g.id === 13).status.own, [501, 502], 'named owners are back');
  const backDetails = back.games.find(g => g.id === 13).details;
  assert.equal(backDetails.players_min, 3, 'the JSON path fills in the same details the CSV does');
  assert.deepEqual(backDetails.players_best, [4], 'including the community best-player vote');
  assert.equal(backDetails.weight, 2.3);
  assert.equal(backDetails.value, 42.5);
  ok('the two sources produce one model, and the richer one wins');

  // The whole reason the library lives in its own file.
  assert.ok(!JSON.parse(fs.readFileSync(`${DIR}/db.json`, 'utf-8')).games, 'db.json stays free of the library');
  assert.ok(fs.existsSync(`${DIR}/games.json`), 'the library has its own file');

  // Four imports have run by now; the archive keeps the newest three.
  const runs = fs.readdirSync(`${DIR}/bgg-raw`).sort();
  assert.equal(runs.length, 3, 'the raw archive is capped rather than growing forever');
  const archived = runs.flatMap(r => fs.readdirSync(`${DIR}/bgg-raw/${r}`));
  assert.ok(archived.some(f => f.endsWith('.csv')), 'a CSV run is archived as a CSV');
  assert.ok(archived.some(f => f.endsWith('.json')), 'and JSON runs as JSON pages');
  ok('the library is stored apart from db.json, with its raw source kept and capped');

  console.log(`\n✅ ALL WEB TESTS PASSED (${pass} checks) ✅`);
} finally {
  stopWebServer(server);
  fs.rmSync(DIR, { recursive: true, force: true });
}
