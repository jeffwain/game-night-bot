// Regression tests for rotation generation.
//
// testFeatures covers database.js and the scanners, but nothing exercised the
// /update handler itself -- so when its inline Fisher-Yates + date-spacing
// block was replaced by the shared buildRotation() in rotation.js, no test
// would have caught a mistake. This drives the real handler with a stub
// interaction, and checks that the shared module and the handler agree.
//
// Run with: npm test
import fs from 'fs';
import assert from 'node:assert/strict';

const DIR = './data-rotation';
fs.rmSync(DIR, { recursive: true, force: true });
process.env.DB_DIR = DIR;
process.env.TZ = 'America/Chicago';

const db = await import('./database.js');
const { cmdRotationGenerate } = await import('./commands/rotation.js');
const { buildRotation, upcomingIntervalDays, suggestNextStart } = await import('./rotation.js');

const roster = ['Alice', 'Bob', 'Carol', 'Dan', 'Erin'];
roster.forEach((n, i) => db.addPlayer(n, String(100000000000000001n + BigInt(i))));
db.togglePlayer('Erin');

let pass = 0;
const ok = m => { console.log('  PASS  ' + m); pass++; };

function stubInteraction() {
  const calls = [];
  return {
    calls,
    client: { channels: { cache: { get: () => null } } },
    replied: false, deferred: false,
    reply: async (p) => { calls.push(p); },
    editReply: async (p) => { calls.push(p); }
  };
}
const opts = (map) => ({
  getString: k => (k in map ? map[k] : null),
  getInteger: k => (k in map ? map[k] : null)
});
const pend = () => db.getSchedule().filter(s => s.status === 'pending').sort((a, b) => a.game_date.localeCompare(b.game_date));

let it = stubInteraction();
await cmdRotationGenerate(it, opts({ start_date: '2099-04-06', interval_days: 7 }), 'update:new');
let p = pend();
assert.equal(p.length, 4, 'one night per ACTIVE player');
assert.deepEqual(p.map(s => s.game_date), ['2099-04-06', '2099-04-13', '2099-04-20', '2099-04-27']);
assert.deepEqual([...new Set(p.map(s => s.playerName))].sort(), ['Alice', 'Bob', 'Carol', 'Dan']);
assert.equal(p.some(s => s.playerName === 'Erin'), false, 'benched player must not be drawn');
assert.ok(it.calls[0]?.embeds?.length, '/update new replied with an embed');
ok('/update new lays out one night per active player at the right interval');

it = stubInteraction();
await cmdRotationGenerate(it, opts({ start_date: '2099-06-01', interval_days: 14 }), 'update:add');
p = pend();
assert.equal(p.length, 8, 'append kept the existing four');
assert.deepEqual(p.slice(4).map(s => s.game_date), ['2099-06-01', '2099-06-15', '2099-06-29', '2099-07-13']);
ok('/update add appends at the interval given and keeps what was there');

it = stubInteraction();
await cmdRotationGenerate(it, opts({ interval_days: 7 }), 'update:add');
p = pend();
assert.equal(p[8].game_date, '2099-07-20', 'continues one interval past the last night');
ok('/update add with no start date continues from the end of the schedule');

db.clearPendingSchedule();
it = stubInteraction();
await cmdRotationGenerate(it, opts({ start_date: '2099-10-25', interval_days: 7 }), 'update:new');
assert.deepEqual(pend().map(s => s.game_date), ['2099-10-25', '2099-11-01', '2099-11-08', '2099-11-15'],
  'exact 7-day steps across the US DST boundary');
ok('rotation dates step exactly across a DST transition');

it = stubInteraction();
await cmdRotationGenerate(it, opts({ start_date: 'not-a-date' }), 'update:new');
assert.ok(JSON.stringify(it.calls[0] ?? {}).toLowerCase().includes('invalid'), 'bad date reported');
ok('an unparseable start date is still reported rather than throwing');

const proposal = buildRotation('2099-04-06', 7);
assert.equal(proposal.length, 4, 'buildRotation draws only active players');
assert.deepEqual(proposal.map(x => x.game_date), ['2099-04-06', '2099-04-13', '2099-04-20', '2099-04-27']);
assert.equal(proposal.some(x => x.playerName === 'Erin'), false);
assert.equal(pend().length, 4, 'buildRotation WROTE NOTHING');
ok('buildRotation matches the handler and writes nothing');

db.clearPendingSchedule();
db.appendSchedule([
  { player_id: 1, game_date: '2099-01-05' },
  { player_id: 2, game_date: '2099-01-12' },
  { player_id: 3, game_date: '2099-01-19' }
]);
db.appendSchedule([{ player_id: 4, game_date: '2020-01-01' }]);
assert.equal(upcomingIntervalDays(), 7, 'a stale past night must not set the cadence');
assert.notEqual(db.getRotationIntervalDays(), 7, 'database.js still reports the skewed one');
assert.deepEqual(suggestNextStart(), { start_date: '2099-01-26', interval_days: 7 });
ok('upcomingIntervalDays ignores unresolved past nights; database.js is left untouched');

console.log(`\n✅ ALL ROTATION TESTS PASSED (${pass} checks) ✅`);
fs.rmSync(DIR, { recursive: true, force: true });
