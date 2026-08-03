// Feature-level regression tests for the changes in v1.3.0:
// backup tiering, timezone authority, permission gates, autocomplete.
// Run with: npm test
import fs from 'fs';
import assert from 'node:assert/strict';

const DIR = './data-features';
fs.rmSync(DIR, { recursive: true, force: true });
process.env.DB_DIR = DIR;
process.env.TZ = 'America/Chicago';

const db = await import('./database.js');
const { commands, handleAutocomplete } = await import('./commands.js');
const { today } = await import('./config.js');

let pass = 0;
const ok = (m) => { console.log('  PASS  ' + m); pass++; };

const backups = (pfx) => fs.existsSync(`${DIR}/backups`)
  ? fs.readdirSync(`${DIR}/backups`).filter(f => f.startsWith(pfx)) : [];

// ---------- 1. BACKUP CHURN ----------
console.log('\n1. Backup tiering');
db.addPlayer('Alice', '1'); db.addPlayer('Bob', '2');
const rollingAfterRealWrites = backups('db_backup_').length;
assert.equal(rollingAfterRealWrites, 2, 'two distinct writes -> two rolling backups');
ok('distinct writes still produce rolling backups');

// 20 no-op writes: exactly what markGameAsNotified/markGameAsReminded do on
// every scan tick. Under the old scheme these alone wiped all 5 slots.
for (let i = 0; i < 20; i++) db.updateSettings('announcementsChannel', '999');
assert.equal(backups('db_backup_').length, 3,
  `expected 3 rolling backups (2 + the one real settings change), got ${backups('db_backup_').length}`);
ok('20 no-op writes produced 0 extra rolling backups (was: 20)');

assert.equal(backups('db_daily_').length, 1, 'exactly one daily snapshot');
ok('daily tier wrote exactly one snapshot');

// The oldest daily must survive heavy churn -- that is the whole point.
const dailyBefore = fs.readFileSync(`${DIR}/backups/${backups('db_daily_')[0]}`, 'utf-8');
for (let i = 0; i < 30; i++) db.updateSettings('churn', String(i));
assert.equal(backups('db_daily_').length, 1, 'daily tier not churned by 30 real writes');
assert.equal(fs.readFileSync(`${DIR}/backups/${backups('db_daily_')[0]}`, 'utf-8'), dailyBefore,
  'daily snapshot content unchanged');
assert.equal(backups('db_backup_').length, 5, 'rolling tier still capped at 5');
ok('30 real writes rotated rolling (capped 5) but preserved the daily snapshot');

// ---------- 2. TIMEZONE AUTHORITY ----------
console.log('\n2. Timezone is settings-driven, not container-driven');
const chicago = today(0);
db.updateSettings('timezone', 'Pacific/Kiritimati');   // UTC+14
const kiritimati = today(0);
db.updateSettings('timezone', 'Pacific/Niue');         // UTC-11
const niue = today(0);
assert.notEqual(kiritimati, niue, 'opposite ends of the date line must differ');
ok(`today() follows settings.timezone (TZ=America/Chicago -> ${chicago}, Kiritimati -> ${kiritimati}, Niue -> ${niue})`);

db.updateSettings('timezone', 'America/Chicago');
// Calendar math must not drift across a DST boundary.
const { addDaysIso } = await import('./time.js');
assert.equal(addDaysIso('2026-03-07', 7), '2026-03-14', 'spans US DST spring-forward');
assert.equal(addDaysIso('2026-10-31', 7), '2026-11-07', 'spans US DST fall-back');
assert.equal(addDaysIso('2026-12-28', 7), '2027-01-04', 'spans year boundary');
assert.equal(addDaysIso('2028-02-28', 1), '2028-02-29', 'leap day');
ok('addDaysIso survives DST, year rollover, and leap day');

// ---------- 3. PERMISSION GATES ----------
console.log('\n3. Permission gates');
const MANAGE_GUILD = '32', ADMIN = '8';
const byName = Object.fromEntries(commands.map(c => [c.name, c]));
assert.equal(commands.length, 5, 'five top-level commands');
const expect = { update: MANAGE_GUILD, admin: ADMIN, schedule: null, help: null, player: null };
for (const [name, want] of Object.entries(expect)) {
  const got = byName[name].default_member_permissions ?? null;
  assert.equal(got, want, `${name}: expected ${want}, got ${got}`);
}
const subs = (n) => byName[n].options.filter(o => o.type === 1).map(o => o.name);
assert.deepEqual(subs('update'), ['new', 'add', 'done', 'swap', 'edit', 'clear']);
assert.deepEqual(subs('admin'), ['setup', 'status', 'scan', 'config']);
assert.deepEqual(subs('player'), ['add', 'remove', 'toggle', 'link', 'list']);
ok('12 commands collapsed to 5: /update gated to Manage Server, /admin to Administrator, 3 public');

// The destructive path must be its own verb, never a default argument value.
const updNew = byName.update.options.find(o => o.name === 'new');
assert.equal(updNew.options.find(o => o.name === 'start_date').required, true,
  '/update new must require an explicit start_date');
assert.equal(byName.update.options.find(o => o.name === 'add')
  .options.find(o => o.name === 'start_date').required ?? false, false,
  '/update add start_date stays optional');
ok('/update new requires start_date; the old `mode:new` default-argument footgun is gone');

// ---------- 4. AUTOCOMPLETE ----------
console.log('\n4. Autocomplete');
const acOpts = [];
for (const c of commands) {
  const walk = (opts, path) => (opts || []).forEach(o => {
    if (o.options) walk(o.options, `${path} ${o.name}`);
    if (o.autocomplete) acOpts.push(`${path} ${o.name}`.trim());
  });
  walk(c.options, `/${c.name}`);
}
assert.equal(acOpts.length, 8, `expected 8 autocompleting options, got ${acOpts.length}: ${acOpts}`);
ok('autocomplete enabled on: ' + acOpts.join(', '));

function fakeAc(commandName, optName, value) {
  let captured = null;
  return {
    interaction: {
      commandName,
      options: { getFocused: () => ({ name: optName, value }) },
      respond: (c) => { captured = c; },
    },
    get result() { return captured; },
  };
}

let f = fakeAc('player', 'name', 'al');
await handleAutocomplete(f.interaction);
assert.deepEqual(f.result.map(c => c.value), ['Alice'], 'substring filter on roster');
ok('/player name: typing "al" narrows to Alice');

db.createSchedule([{ player_id: 1, game_date: today(3) }, { player_id: 2, game_date: today(10) }]);
f = fakeAc('update', 'player', '');
await handleAutocomplete(f.interaction);
assert.equal(f.result.length, 2);
assert.match(f.result[0].name, /^Alice - /, 'label carries the date');
assert.equal(f.result[0].value, 'Alice', 'value stays the bare name the handler looks up');
ok('/update done player: suggests only pending hosts, labelled with their date');

f = fakeAc('update', 'start_date', '');
await handleAutocomplete(f.interaction);
assert.equal(f.result.length, 25, 'capped at Discord max of 25');
assert.match(f.result[0].name, /^Today - /);
assert.equal(f.result[0].value, today(0));
assert.match(f.result[1].name, /^Tomorrow - /);
ok('/update start_date: offers 25 dates, ISO values, Today/Tomorrow labelled');

f = fakeAc('help', 'nope', 'x');
await handleAutocomplete(f.interaction);
assert.deepEqual(f.result, [], 'unknown command responds empty rather than throwing');
ok('unhandled autocomplete responds empty instead of erroring');

// ---------- 5. CUSTOM ID ROUTER ----------
console.log('\n5. Custom ID router');
const { cid, parseCid } = await import('./customId.js');
const { __routes } = await import('./dmCheck.js');
const allRoutes = new Set([
  ...__routes.buttonRoutes.keys(),
  ...__routes.selectRoutes.keys(),
  ...__routes.modalRoutes.keys(),
]);

// The exact overlap the old prefix chain depended on check-order to survive.
assert.equal(parseCid('edit_date_7').key, 'edit:datemodal');
assert.equal(parseCid('edit_date_modal_7').key, 'edit:datesubmit');
assert.equal(parseCid('edit_datemenu_7').key, 'edit:datemenu');
ok('edit_date_ / edit_date_modal_ / edit_datemenu_ resolve distinctly, order-independently');

// Every component ID a pre-upgrade message could still carry must land on a
// live route -- otherwise old RSVP buttons go dead the moment the bot restarts.
const legacyIds = [
  'edit_back', 'edit_select_entry', 'edit_entry_7', 'edit_datemenu_7',
  'edit_setdate_7_2026-08-11', 'edit_delete_7', 'edit_date_7', 'edit_host_7',
  'edit_host_select_7', 'edit_date_modal_7',
  'rsvp_going_7', 'rsvp_tentative_7', 'rsvp_out_7',
  'confirm_host_yes_7', 'confirm_host_skip_7',
  'host_action_swap_7', 'host_action_out_7', 'host_action_remove_7',
  'host_select_swap_7',
];
for (const id of legacyIds) {
  assert.ok(allRoutes.has(parseCid(id).key), `legacy id "${id}" -> "${parseCid(id).key}" has no route`);
}
ok(`all ${legacyIds.length} pre-upgrade component IDs still route (buttons already in Discord keep working)`);

// Every ID the bot BUILDS must land on a route too. A button posted into a
// channel with no handler is silent -- it just never does anything.
for (const id of [cid('claim', 'take', 7), cid('host', 'out', 7), cid('checkin', 'skip', 7)]) {
  assert.ok(allRoutes.has(parseCid(id).key), `built id "${id}" has no route`);
}
ok('the open-host-call and skip buttons the bot posts all have live routes');

assert.deepEqual(parseCid('edit_setdate_7_2026-08-11').args, ['7', '2026-08-11'], 'multi-arg legacy id');
assert.equal(parseCid(cid('edit', 'setdate', 7, '2026-08-11')).key, 'edit:setdate', 'new format round-trips');
assert.throws(() => cid('edit', 'setdate', 'x'.repeat(200)), /exceeds 100/, 'over-long IDs throw at build time');
ok('multi-arg IDs round-trip; over-length IDs fail loudly instead of at send time');

// ---------- 6. COMMAND DISPATCH ----------
console.log('\n6. Command dispatch');
const { __commandRoutes, resolveAction } = await import('./commands.js');

// Derive every action the slash-command tree can actually produce, and require
// a handler for each. This is what catches "added a subcommand, forgot to wire
// it up" -- which used to surface as a silent no-op in Discord.
const declared = new Set();
for (const cmd of commands) {
  const subs = (cmd.options || []).filter(o => o.type === 1);
  if (subs.length === 0) declared.add(cmd.name);
  else subs.forEach(sub => declared.add(`${cmd.name}:${sub.name}`));
}

const routed = new Set(__commandRoutes.keys());
const missing = [...declared].filter(a => !routed.has(a));
const orphaned = [...routed].filter(a => !declared.has(a));
assert.deepEqual(missing, [], `declared actions with no handler: ${missing}`);
assert.deepEqual(orphaned, [], `handlers for actions that cannot be invoked: ${orphaned}`);
ok(`all ${declared.size} invocable actions have a handler, and no handler is unreachable`);

// resolveAction must agree with those keys for both grouped and flat commands.
const fakeInteraction = (commandName, sub) => ({
  commandName,
  options: { getSubcommand: () => sub }
});
assert.equal(resolveAction(fakeInteraction('update', 'new')), 'update:new');
assert.equal(resolveAction(fakeInteraction('admin', 'config')), 'admin:config');
assert.equal(resolveAction(fakeInteraction('player', 'list')), 'player:list');
assert.equal(resolveAction(fakeInteraction('schedule')), 'schedule');
assert.equal(resolveAction(fakeInteraction('help')), 'help');
ok('resolveAction produces the same keys the dispatch table is built from');

// ---------- 7. PURE FUNCTIONS ----------
// These carry the densest edge cases in the codebase and had no coverage.
console.log('\n7. Date parsing, RSVP phrasing, schedule rippling');

const { parseAndNormalizeDate, chunkToFields } = await import('./commands.js');
const { formatRsvpSummaryText } = await import('./dmCheck.js');

db.updateSettings('timezone', 'America/Chicago');
const todayIso = today(0);
const thisYear = Number(todayIso.slice(0, 4));

assert.equal(parseAndNormalizeDate('today'), todayIso);
assert.equal(parseAndNormalizeDate('tomorrow'), today(1));
assert.equal(parseAndNormalizeDate('2026-08-11'), '2026-08-11');
assert.equal(parseAndNormalizeDate('2026-8-11'), '2026-08-11', 'single-digit month/day');
assert.equal(parseAndNormalizeDate('08/11/2026'), '2026-08-11', 'US M/D/Y');
assert.equal(parseAndNormalizeDate('2026-02-30'), null, 'rejects a date that does not exist');
assert.equal(parseAndNormalizeDate('nonsense'), null);
assert.equal(parseAndNormalizeDate(''), null);
assert.equal(parseAndNormalizeDate(null), null);
ok('parseAndNormalizeDate handles every format branch and rejects impossible dates');

// The bare M/D branch must roll forward, and must never fall through to
// `new Date()`, which fills in year 2001 for these inputs.
const janFirst = parseAndNormalizeDate('1/1');
assert.match(janFirst, /^\d{4}-01-01$/);
assert.ok(Number(janFirst.slice(0, 4)) >= thisYear, `1/1 resolved to ${janFirst}, before today`);
assert.ok(janFirst >= todayIso, 'a bare M/D must never resolve into the past');
assert.equal(parseAndNormalizeDate('12/31').slice(5), '12-31');
ok('bare M/D rolls forward instead of landing in the past (or in the year 2001)');

// formatRsvpSummaryText: eight branches of natural-language assembly.
assert.equal(formatRsvpSummaryText({}), 'No RSVPs yet.');
assert.equal(formatRsvpSummaryText({ a: 'going' }), "Everyone's in.");
assert.equal(formatRsvpSummaryText({ a: 'going', b: 'going' }), "Everyone's in.");
assert.match(formatRsvpSummaryText({ a: 'out' }), /is out/);
assert.match(formatRsvpSummaryText({ a: 'out', b: 'out' }), /are out/);
assert.match(formatRsvpSummaryText({ a: 'going', b: 'tentative' }), /is a maybe/);
assert.match(formatRsvpSummaryText({ a: 'going', b: 'out', c: 'out' }), /Only .* is in/);
for (const rsvps of [{}, { a: 'going' }, { a: 'out', b: 'tentative', c: 'going' }]) {
  assert.equal(typeof formatRsvpSummaryText(rsvps), 'string');
}
ok('formatRsvpSummaryText covers singular/plural and every in/maybe/out mix');

// setEntryDate: moving an entry onto an occupied date ripples the others
// forward. The loop has a 1000-iteration guard; verify it terminates cleanly
// and never double-books.
db.clearPendingSchedule();
const roster = db.getAllPlayers();
db.createSchedule([0, 1, 2, 3].map((n, i) => ({
  player_id: roster[i % roster.length].id,
  game_date: addDaysIso('2026-09-01', n * 7)
})));
const entries = db.getSchedule().filter(s => s.status === 'pending')
  .sort((a, b) => a.game_date.localeCompare(b.game_date));

// Drop the last entry directly onto the first entry's date.
db.setEntryDate(entries[3].id, entries[0].game_date);
const after = db.getSchedule().filter(s => s.status === 'pending').map(s => s.game_date);
assert.equal(new Set(after).size, after.length, `two entries share a date: ${after.sort()}`);
assert.ok(after.includes('2026-09-01'), 'the entry we moved keeps the date it was given');
ok('setEntryDate ripples collisions forward and never double-books a night');

// postponeGameAndShift is the whole point of the skip rework: a skipped night
// is CANCELLED, not handed to the next host. Everyone keeps their turn and
// their relative position; only the dates move.
db.clearPendingSchedule();
// Roster is Alice, Bob -- so this rotation is Alice, Bob, Alice.
db.createSchedule([
  { player_id: roster[0].id, game_date: '2026-10-01' },
  { player_id: roster[1].id, game_date: '2026-10-08' },
  { player_id: roster[0].id, game_date: '2026-10-15' }
]);
const rota = db.getSchedule().filter(s => s.status === 'pending')
  .sort((a, b) => a.game_date.localeCompare(b.game_date));
const namesBefore = rota.map(s => s.playerName);

const skipResult = db.postponeGameAndShift(rota[0].id);
assert.equal(skipResult.intervalDays, 7, 'interval read off the schedule');
assert.equal(skipResult.rescheduled.game_date, '2026-10-08', 'the skipping host takes the next slot');
assert.equal(skipResult.shiftedCount, 2, 'both later nights moved');

const rotaAfter = db.getSchedule().filter(s => s.status === 'pending')
  .sort((a, b) => a.game_date.localeCompare(b.game_date));
assert.deepEqual(rotaAfter.map(s => s.game_date), ['2026-10-08', '2026-10-15', '2026-10-22']);
assert.deepEqual(rotaAfter.map(s => s.playerName), namesBefore, 'skipping must not reorder hosts');
assert.equal(rotaAfter.length, 3, 'nobody loses a turn to a skip');
assert.equal(db.getSchedule().find(s => s.id === rota[0].id).status, 'skipped',
  'the cancelled night is kept as history');
ok('postponeGameAndShift cancels the night and slides the rotation, order intact');

// A claim is a straight two-person trade: the volunteer takes the open date,
// the host who bowed out inherits the volunteer's slot. No other date moves.
const open = db.getSchedule().filter(s => s.status === 'pending')
  .sort((a, b) => a.game_date.localeCompare(b.game_date))[0];
db.openGameForClaim(open.id);
assert.ok(db.getUnclaimedGamesDueBy('2026-10-08').some(s => s.id === open.id),
  'an open night is due once the cutoff reaches its date');
assert.equal(db.getUnclaimedGamesDueBy('2026-10-07').length, 0,
  'an open night is not due before the cutoff reaches it');

// Someone other than the host who bowed out -- claiming your own night is
// rejected, and that rejection is asserted separately below.
const taker = db.getSchedule().filter(s => s.status === 'pending' && s.player_id !== open.player_id)
  .sort((a, b) => a.game_date.localeCompare(b.game_date))[0];
const takerId = taker.player_id;
const claim = db.claimOpenGame(open.id, takerId);
assert.equal(claim.claimed.game_date, '2026-10-08', 'the claimed night keeps its date');
assert.equal(claim.handedOff.game_date, taker.game_date, 'the bailing host takes the volunteer slot');
assert.equal(claim.claimed.playerName, taker.playerName, 'the volunteer is now the host');
assert.deepEqual(
  db.getSchedule().filter(s => s.status === 'pending').map(s => s.game_date).sort(),
  ['2026-10-08', '2026-10-15', '2026-10-22'],
  'a claim moves nobody else'
);
assert.throws(() => db.claimOpenGame(open.id, takerId), /not open for claiming/,
  'a night can only be claimed once');

// The host who bowed out cannot quietly claim their own night back.
const selfOpen = db.getSchedule().filter(s => s.status === 'pending')
  .sort((a, b) => a.game_date.localeCompare(b.game_date))[0];
db.openGameForClaim(selfOpen.id);
assert.throws(() => db.claimOpenGame(selfOpen.id, selfOpen.player_id), /opened this night up/,
  'the bailing host cannot claim their own open night');
db.clearClaim(selfOpen.id);
assert.equal(db.getUnclaimedGamesDueBy('2099-01-01').length, 0, 'clearClaim closes the call');
ok('claimOpenGame trades dates with the volunteer and rejects self-claims');

// chunkToFields: the fix for the ~22-player ceiling.
const longLines = Array.from({ length: 60 }, (_, i) => `**${i + 1}.** Tue, 6/23 — Host: <@283253589525397524>`);
const fields = chunkToFields('Upcoming', longLines);
assert.ok(fields.length > 1, 'a 60-entry rotation must span multiple fields');
for (const f of fields) assert.ok(f.value.length <= 1024, `field ${f.name} is ${f.value.length} chars`);
assert.equal(fields.reduce((n, f) => n + f.value.split('\n').length, 0), 60, 'no lines dropped');
assert.deepEqual(chunkToFields('Empty', [], 'Nothing.'), [{ name: 'Empty', value: 'Nothing.' }]);
const huge = chunkToFields('One', ['x'.repeat(3000)]);
assert.ok(huge[0].value.length <= 1024, 'a single over-long line is truncated, not rejected');
ok('chunkToFields keeps every field under 1024 chars and drops no lines (60 players OK)');

console.log(`\n\u2705 ALL FEATURE TESTS PASSED (${pass} checks) \u2705`);
fs.rmSync(DIR, { recursive: true, force: true });
