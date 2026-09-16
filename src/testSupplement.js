// Geekgroup supplementation: what a second source may add to a BGG library,
// and — more to the point — what it may never touch.
// Run with: npm run test:supplement
import assert from 'node:assert/strict';

const { supplement, supplementFromPages } = await import('./bgg/supplement.js');

let pass = 0;
const ok = (m) => { console.log('  PASS  ' + m); pass++; };

// A BGG sync: artwork and per-person statuses, but no weight, no community
// player counts, no estimated value, and no group rating — BGG has no group.
function bggLibrary() {
  return {
    synced_at: '2026-09-15T02:00:00.000Z',
    source: 'bgg',
    users: [{ id: 501, username: 'ada', full_name: 'Ada', sort_name: 'ada', discord: '11', avatar: null }],
    games: [
      {
        id: 13,
        name: 'Catan',
        original_name: 'Catan',
        published: 1995,
        is_expansion: false,
        image: 'https://img/catan.jpg',
        thumbnail: 'https://img/catan-small.jpg',
        status: { own: [501], prev_owned: [], for_trade: [], want: [], want_to_play: [], want_to_buy: [], wishlist: [], preordered: [], has_parts: [], want_parts: [] },
        owner_count: 1,
        rating: { average: 8, bgg_average: 7.14, group_average: null, rating_count: 1, group_votes: 0, users: { 501: 8 } },
        plays: { last_play: null, total_plays: 5, users: { 501: 5 } },
        details: {
          players_min: 3, players_max: 4, players_best: [], players_recommended: [],
          time_min: 60, time_max: 120, weight: null, rank: 400, value: null
        },
        expansions: []
      },
      {
        id: 999,
        name: 'Not In The Group',
        original_name: 'Not In The Group',
        published: 2001,
        is_expansion: false,
        image: null,
        thumbnail: null,
        status: { own: [501], prev_owned: [], for_trade: [], want: [], want_to_play: [], want_to_buy: [], wishlist: [], preordered: [], has_parts: [], want_parts: [] },
        owner_count: 1,
        rating: { average: null, bgg_average: 6, group_average: null, rating_count: 0, group_votes: 0, users: {} },
        plays: { last_play: null, total_plays: 0, users: {} },
        details: {
          players_min: 2, players_max: 5, players_best: [], players_recommended: [],
          time_min: 30, time_max: 45, weight: null, rank: null, value: null
        },
        expansions: []
      }
    ]
  };
}

// What normalize() produces from a Geekgroup dump. Deliberately disagrees with
// the BGG library on ownership, artwork and ratings, so the "never touch" rules
// have something to fail against.
function geekgroupLibrary() {
  return {
    synced_at: '2026-09-16T09:00:00.000Z',
    source: 'geekgroup',
    users: [],
    games: [
      {
        id: 13,
        name: 'Catan (Geekgroup rename)',
        original_name: 'Catan',
        published: 1995,
        is_expansion: false,
        status: { own: [601, 602], prev_owned: [603], for_trade: [], want: [], want_to_play: [], want_to_buy: [], wishlist: [], preordered: [], has_parts: [], want_parts: [] },
        owner_count: 2,
        rating: { average: 5, bgg_average: 7.2, group_average: 8.4, rating_count: 3000, group_votes: 9, users: { 601: 5 } },
        plays: { last_play: '2020-01-01', total_plays: 99, users: { 601: 99 } },
        details: {
          players_min: 3, players_max: 4, players_best: [4], players_recommended: [3, 4],
          time_min: 60, time_max: 120, weight: 2.31, rank: 420, value: 34.5
        },
        expansions: []
      }
    ]
  };
}

// -------------------------------------------------------------
console.log('\nGeekgroup supplementation');

{
  const base = bggLibrary();
  const out = supplement(base, geekgroupLibrary());
  const catan = out.games.find(g => g.id === 13);

  assert.equal(catan.details.weight, 2.31, 'weight is a gap BGG cannot fill');
  assert.deepEqual(catan.details.players_best, [4]);
  assert.deepEqual(catan.details.players_recommended, [3, 4]);
  assert.equal(catan.details.value, 34.5);
  ok('the four fields BGG never sends are filled in');
}

{
  const base = bggLibrary();
  const out = supplement(base, geekgroupLibrary());
  const catan = out.games.find(g => g.id === 13);

  assert.equal(catan.rating.group_average, 8.4, 'the group rating is refreshed, not gap-filled');
  assert.equal(catan.rating.group_votes, 9);
  ok('group ratings are refreshed — Geekgroup is the only source that has a group');
}

{
  // The same call, run over a library that already has a stale group rating.
  const base = bggLibrary();
  base.games[0].rating.group_average = 1.1;
  base.games[0].rating.group_votes = 2;
  const catan = supplement(base, geekgroupLibrary()).games.find(g => g.id === 13);
  assert.equal(catan.rating.group_average, 8.4, 'a stale group rating is overwritten');
  assert.equal(catan.rating.group_votes, 9);
  ok('a group rating already on file is replaced rather than kept');
}

{
  // Refresh means "replace with a newer answer", not "replace with silence". A
  // second, thinner dump — one page of thirteen, say — must not blank a group
  // rating an earlier, fuller supplement put there.
  const base = bggLibrary();
  base.games[0].rating.group_average = 7.7;
  base.games[0].rating.group_votes = 5;
  const thin = geekgroupLibrary();
  thin.games[0].rating.group_average = null;
  thin.games[0].rating.group_votes = 0;
  const catan = supplement(base, thin).games.find(g => g.id === 13);
  assert.equal(catan.rating.group_average, 7.7, 'no group rating in the dump keeps the one on file');
  assert.equal(catan.rating.group_votes, 5, 'and its vote count with it');
  ok('a dump with no group rating for a game does not erase the one already there');
}

{
  const base = bggLibrary();
  const catan = supplement(base, geekgroupLibrary()).games.find(g => g.id === 13);

  assert.deepEqual(catan.status.own, [501], 'ownership stays what BGG said');
  assert.deepEqual(catan.status.prev_owned, []);
  assert.equal(catan.owner_count, 1);
  assert.equal(catan.image, 'https://img/catan.jpg', 'artwork is never touched');
  assert.equal(catan.thumbnail, 'https://img/catan-small.jpg');
  assert.equal(catan.rating.average, 8, 'our own average is not Geekgroup\'s');
  assert.deepEqual(catan.rating.users, { 501: 8 });
  assert.equal(catan.plays.total_plays, 5);
  assert.equal(catan.plays.last_play, null);
  assert.equal(catan.name, 'Catan', 'the BGG name stands');
  ok('ownership, artwork, our ratings, plays and names are left alone');
}

{
  const base = bggLibrary();
  // rank is already 400 from BGG, so Geekgroup's 420 must not win.
  const catan = supplement(base, geekgroupLibrary()).games.find(g => g.id === 13);
  assert.equal(catan.details.rank, 400, 'a rank BGG supplied is not replaced');
  assert.equal(catan.details.players_min, 3, 'player counts BGG supplied stand');
  assert.equal(catan.details.time_max, 120);
  ok('gap-fill means gap-fill: fields BGG already answered are kept');
}

{
  const base = bggLibrary();
  const out = supplement(base, geekgroupLibrary());
  const orphan = out.games.find(g => g.id === 999);
  assert.equal(orphan.details.weight, null, 'a game Geekgroup has never heard of is untouched');
  assert.equal(out.games.length, 2, 'supplementing never adds or drops rows');
  assert.equal(out.games.find(g => g.id === 601), undefined);
  ok('a game missing from the supplement is left as it was, and no rows appear');
}

{
  const base = bggLibrary();
  const before = JSON.parse(JSON.stringify(base));
  supplement(base, geekgroupLibrary());
  assert.deepEqual(base, before, 'supplement() does not mutate what it is given');
  ok('the input library is not modified in place');
}

{
  const out = supplement(bggLibrary(), geekgroupLibrary());
  assert.equal(out.source, 'bgg', 'the primary source still owns the library');
  assert.equal(out.synced_at, '2026-09-15T02:00:00.000Z', 'the sync time is the BGG sync');
  assert.equal(out.supplement_source, 'geekgroup');
  assert.equal(out.supplemented_at, '2026-09-16T09:00:00.000Z');
  assert.equal(out.supplemented_count, 1, 'one game actually matched');
  ok('the payload records that it was supplemented, and by what');
}

{
  // Nothing to supplement with is not an error — it is the normal state.
  const base = bggLibrary();
  assert.deepEqual(supplement(base, null), base);
  assert.deepEqual(supplement(base, { games: [] }), base);
  ok('an absent or empty supplement returns the library unchanged');
}

{
  // Zero is Geekgroup's "no answer" for weight and value, not a real reading.
  const gg = geekgroupLibrary();
  gg.games[0].details.weight = 0;
  gg.games[0].details.value = 0;
  gg.games[0].rating.group_average = 0;
  const catan = supplement(bggLibrary(), gg).games.find(g => g.id === 13);
  assert.equal(catan.details.weight, null, 'a zero weight is no weight');
  assert.equal(catan.details.value, null);
  assert.equal(catan.rating.group_average, null, 'a zero group rating is no rating');
  ok('Geekgroup zeroes are absences, not measurements');
}

{
  // Raw Geekgroup page bodies, the shape the import route actually holds.
  const pages = [{
    collection: [{
      id: 13,
      users: { status: { own: [601] }, rated: {}, played: {} },
      group: { rating_avg: 8.4, rating_count: 9 },
      game: {
        id: 13, type: 1, name: 'Catan', originalName: 'Catan', published: 1995,
        players_min: 3, players_max: 4, players_community: { best: [4], recommended: [3, 4] },
        time_min: 60, time_max: 120, weight_avg: 2.31, rank: 420,
        rating_avg: 7.2, rating_count: 9, worth: { value: 34.5 }, contains: []
      }
    }]
  }];
  const catan = supplementFromPages(bggLibrary(), pages).games.find(g => g.id === 13);
  assert.equal(catan.details.weight, 2.31);
  assert.deepEqual(catan.details.players_best, [4]);
  assert.equal(catan.rating.group_average, 8.4);
  assert.deepEqual(catan.status.own, [501], 'going through normalize() changes none of the rules');
  ok('raw Geekgroup pages can supplement without being normalized by the caller');
}

console.log(`\n✅ SUPPLEMENT TESTS PASSED (${pass} checks) ✅`);
