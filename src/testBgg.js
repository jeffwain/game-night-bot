// BoardGameGeek XML API2: auth header, collection parse/merge, and the
// guarantee that the application token never appears in errors or state.
// Run with: npm run test:bgg
import assert from 'node:assert/strict';

const TOKEN = 'test-bgg-token-0000-not-real';
const prev = process.env.BGG_APP_TOKEN;
process.env.BGG_APP_TOKEN = TOKEN;

const xmlapi = await import('./bgg/xmlapi.js');

let pass = 0;
const ok = (m) => { console.log('  PASS  ' + m); pass++; };

const COLLECTION = `<?xml version="1.0" encoding="utf-8"?>
<items totalitems="2" termsofuse="https://boardgamegeek.com/xmlapi/termsofuse">
  <item objecttype="thing" objectid="13" subtype="boardgame" collid="1">
    <name sortindex="1">Catan</name>
    <yearpublished>1995</yearpublished>
    <stats minplayers="3" maxplayers="4" minplaytime="60" maxplaytime="120">
      <rating value="8">
        <average value="7.14"/>
        <ranks>
          <rank type="subtype" id="1" name="boardgame" value="400"/>
        </ranks>
      </rating>
    </stats>
    <status own="1" prevowned="0" fortrade="0" want="0" wanttoplay="0" wanttobuy="0" wishlist="0" preordered="0"/>
    <numplays>5</numplays>
  </item>
  <item objecttype="thing" objectid="325" subtype="boardgameexpansion" collid="2">
    <name>Catan: Seafarers</name>
    <yearpublished>1997</yearpublished>
    <stats minplayers="3" maxplayers="4">
      <rating value="N/A">
        <average value="7.0"/>
      </rating>
    </stats>
    <status own="1" prevowned="0" fortrade="0" want="0" wanttoplay="0" wanttobuy="0" wishlist="0" preordered="0"/>
    <numplays>0</numplays>
  </item>
</items>`;

// What BGG actually sends for /collection with no subtype: expansions are in
// the dump, but every item is subtype="boardgame". The expansion collection
// is a second request; that is the only signal we get.
const COLLECTION_FLAT = COLLECTION.replace('subtype="boardgameexpansion"', 'subtype="boardgame"');
const EXPANSIONS = `<?xml version="1.0" encoding="utf-8"?>
<items totalitems="1">
  <item objecttype="thing" objectid="325" subtype="boardgame" collid="2">
    <name>Catan: Seafarers</name>
    <yearpublished>1997</yearpublished>
    <stats minplayers="3" maxplayers="4">
      <rating value="N/A"><average value="7.0"/></rating>
    </stats>
    <status own="1" prevowned="0" fortrade="0" want="0" wanttoplay="0" wanttobuy="0" wishlist="0" preordered="0"/>
    <numplays>0</numplays>
  </item>
</items>`;

const THING = `<?xml version="1.0" encoding="utf-8"?>
<items>
  <item type="boardgameexpansion" id="325">
    <name type="primary" value="Catan: Seafarers"/>
    <link type="boardgameexpansion" id="13" value="Catan"/>
  </item>
  <item type="boardgame" id="13">
    <name type="primary" value="Catan"/>
    <link type="boardgameexpansion" id="325" value="Catan: Seafarers" inbound="true"/>
  </item>
</items>`;

try {
  console.log('\nBGG XML API');

  const headers = xmlapi.authHeaders();
  assert.equal(headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(headers.Authorization.includes('Bearer '), true, 'Bearer then a space, no colon');
  ok('the token is sent as Authorization: Bearer');

  assert.throws(() => xmlapi.authHeaders(''), /BGG_APP_TOKEN/);
  ok('a missing token is refused before any request is made');

  const leaked = xmlapi.redact(`failed: ${TOKEN} in the body`);
  assert.equal(leaked.includes(TOKEN), false, 'the raw token is stripped');
  assert.match(leaked, /\[redacted\]/);
  ok('error text never echoes the token');

  const url = xmlapi.collectionUrl('Ada Lovelace');
  assert.match(url, /^https:\/\/boardgamegeek\.com\/xmlapi2\/collection/);
  assert.doesNotMatch(url, /www\./, 'www breaks Authorization');
  assert.match(url, /username=Ada\+Lovelace/, 'usernames are encoded');
  assert.match(url, /stats=1/);
  ok('collection URLs hit boardgamegeek.com, not www');
  assert.doesNotMatch(xmlapi.collectionUrl('ada'), /subtype=/);
  assert.match(
    xmlapi.collectionUrl('ada', { subtype: 'boardgameexpansion' }),
    /subtype=boardgameexpansion/
  );
  ok('the expansion collection is a second request, not a guess from the name');

  const items = xmlapi.parseCollectionXml(COLLECTION);
  assert.equal(items.length, 2);
  assert.equal(items[0].id, 13);
  assert.equal(items[0].name, 'Catan');
  assert.equal(items[0].published, 1995);
  assert.equal(items[0].is_expansion, false);
  assert.equal(items[0].own, true);
  assert.equal(items[0].rating, 8);
  assert.equal(items[0].bgg_average, 7.14);
  assert.equal(items[0].numplays, 5);
  assert.equal(items[0].details.players_min, 3);
  assert.equal(items[1].id, 325);
  assert.equal(items[1].is_expansion, true);
  assert.equal(items[1].rating, null, 'N/A is not a rating');
  ok('collection XML becomes the fields the library already stores');

  const WISH = `<?xml version="1.0" encoding="utf-8"?>
<items totalitems="1">
  <item objecttype="thing" objectid="421" subtype="boardgame" collid="3">
    <name>1830: Railways &amp; Robber Barons</name>
    <yearpublished>1986</yearpublished>
    <stats minplayers="2" maxplayers="6">
      <rating value="N/A"><average value="7.8"/></rating>
    </stats>
    <status own="0" prevowned="1" fortrade="0" want="0" wanttoplay="1" wanttobuy="0" wishlist="1" wishlistpriority="2" preordered="0"/>
    <numplays>0</numplays>
  </item>
</items>`;
  const wish = xmlapi.parseCollectionXml(WISH)[0];
  assert.equal(wish.own, false);
  assert.equal(wish.status.own, false);
  assert.equal(wish.status.prev_owned, true);
  assert.equal(wish.status.want_to_play, true);
  assert.equal(wish.status.wishlist, true);
  const wished = xmlapi.toLibrary(
    [{ userId: 501, username: 'ada', items: [wish] }],
    [{ bgg_user_id: 501, bgg_username: 'ada', name: 'Ada' }],
    { syncedAt: new Date('2026-09-14T12:00:00Z') }
  ).games[0];
  assert.deepEqual(wished.status.own, []);
  assert.deepEqual(wished.status.prev_owned, [501]);
  assert.deepEqual(wished.status.want_to_play, [501]);
  assert.deepEqual(wished.status.wishlist, [501]);
  assert.equal(wished.owner_count, 0);
  assert.doesNotMatch(
    xmlapi.collectionUrl('ada', { subtype: 'boardgameexpansion' }),
    /own=/
  );
  ok('wishlist, previously owned, and want-to-play flags survive into the library');

  const parents = xmlapi.parseThingParents(THING);
  assert.equal(parents.get(325), 13, 'an expansion points at its base game');
  assert.equal(parents.has(13), false, 'inbound links on the base game are not parents');
  ok('thing XML yields expansion -> parent, not the reverse');

  const ada = { userId: 501, username: 'ada', items: xmlapi.parseCollectionXml(COLLECTION) };
  const graceXml = COLLECTION.replace('objectid="13"', 'objectid="13"')
    .replace('<name sortindex="1">Catan</name>', '<name sortindex="1">Catan</name>')
    .replace('value="8"', 'value="6"')
    .replace('objectid="325"', 'objectid="999"')
    .replace('Catan: Seafarers', 'A Game Grace Only Owns')
    .replace('subtype="boardgameexpansion"', 'subtype="boardgame"');
  const grace = { userId: 502, username: 'grace', items: xmlapi.parseCollectionXml(graceXml) };

  const players = [
    { id: 1, bgg_user_id: 501, bgg_username: 'ada', discord_id: '11', name: 'Ada' },
    { id: 2, bgg_user_id: 502, bgg_username: 'grace', discord_id: '22', name: 'Grace' }
  ];
  const library = xmlapi.toLibrary([ada, grace], players, {
    parents,
    syncedAt: new Date('2026-09-14T12:00:00Z')
  });

  assert.equal(library.source, 'bgg');
  assert.equal(library.synced_at, '2026-09-14T12:00:00.000Z');
  const catan = library.games.find(g => g.id === 13);
  assert.ok(catan, 'Catan is a row');
  assert.deepEqual(catan.status.own.slice().sort(), [501, 502], 'both owners');
  assert.equal(catan.owner_count, 2);
  assert.equal(catan.rating.users[501], 8);
  assert.equal(catan.rating.users[502], 6);
  assert.equal(catan.rating.average, 7);
  assert.equal(catan.expansions.length, 1, 'Seafarers hangs off Catan');
  assert.equal(catan.expansions[0].id, 325);
  assert.equal(library.games.find(g => g.id === 325), undefined, 'the expansion is not also a top-level row');
  assert.ok(library.games.find(g => g.id === 999), 'a game with no parent stays a row');
  assert.deepEqual(library.users.map(u => u.username), ['ada', 'grace']);
  ok('two collections merge into the same library shape Geekgroup writes');

  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls += 1;
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.doesNotMatch(url, /www\./);
    if (calls === 1) return { ok: true, status: 202, text: async () => 'queued' };
    return { ok: true, status: 200, text: async () => COLLECTION };
  };
  const sleeps = [];
  const xml = await xmlapi.fetchXml('https://boardgamegeek.com/xmlapi2/collection?username=ada', {
    fetchImpl,
    sleep: async (ms) => { sleeps.push(ms); },
    delayMs: 50
  });
  assert.equal(calls, 2, '202 is retried');
  assert.deepEqual(sleeps, [50]);
  assert.equal(xmlapi.parseCollectionXml(xml).length, 2);
  ok('a 202 queue response is retried rather than treated as an empty collection');

  const boom = async () => ({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    text: async () => `token ${TOKEN} rejected`
  });
  await assert.rejects(
    () => xmlapi.fetchXml('https://boardgamegeek.com/xmlapi2/thing?id=13', { fetchImpl: boom }),
    (err) => {
      assert.equal(String(err.message).includes(TOKEN), false, '401 body must not leak the token');
      return true;
    }
  );
  ok('a failed BGG response is redacted before it becomes an Error');

  const linked = [
    { id: 1, bgg_user_id: 501, bgg_username: 'ada', discord_id: '11', name: 'Ada' }
  ];
  const seen = [];
  const fetchAll = async (url, init) => {
    seen.push(url);
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    if (url.includes('/collection') && url.includes('subtype=boardgameexpansion')) {
      return { ok: true, status: 200, text: async () => EXPANSIONS };
    }
    if (url.includes('/collection')) return { ok: true, status: 200, text: async () => COLLECTION };
    if (url.includes('/thing')) return { ok: true, status: 200, text: async () => THING };
    throw new Error(`unexpected ${url}`);
  };
  await assert.rejects(
    () => xmlapi.fetchCollections([], { fetchImpl: fetchAll, delayMs: 0 }),
    /BGG username/
  );
  const pulled = await xmlapi.fetchCollections(linked, {
    fetchImpl: fetchAll,
    delayMs: 0,
    sleep: async () => {}
  });
  assert.ok(seen.some(u => u.includes('/xmlapi2/collection') && u.includes('username=ada')));
  assert.ok(seen.some(u => u.includes('/xmlapi2/thing') && u.includes('325')),
    'expansions are resolved through /thing so they can hang off the base game');
  assert.equal(pulled.library.games.find(g => g.id === 13).expansions[0].id, 325);
  assert.ok(pulled.xmlFiles.some(f => f.name.startsWith('collection-') && f.text.includes('Catan')));
  ok('a linked username is fetched, archived as XML, and folded via /thing');

  const flatSeen = [];
  const fetchFlat = async (url, init) => {
    flatSeen.push(url);
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    if (url.includes('/collection') && url.includes('subtype=boardgameexpansion')) {
      return { ok: true, status: 200, text: async () => EXPANSIONS };
    }
    if (url.includes('/collection')) {
      return { ok: true, status: 200, text: async () => COLLECTION_FLAT };
    }
    if (url.includes('/thing')) return { ok: true, status: 200, text: async () => THING };
    throw new Error(`unexpected ${url}`);
  };
  const folded = await xmlapi.fetchCollections(linked, {
    fetchImpl: fetchFlat,
    delayMs: 0,
    sleep: async () => {}
  });
  assert.ok(flatSeen.some(u => u.includes('subtype=boardgameexpansion')),
    'expansions are a second collection request; the main dump does not name them');
  const foldedCatan = folded.library.games.find(g => g.id === 13);
  assert.equal(foldedCatan.expansions[0]?.id, 325, 'Seafarers hangs off Catan even when the main dump hid the subtype');
  assert.equal(folded.library.games.find(g => g.id === 325), undefined, 'the expansion is not also a top-level row');
  assert.ok(folded.xmlFiles.some(f => f.name.startsWith('expansions-') && f.text.includes('Seafarers')));
  ok('a collection that labels every item boardgame still nests expansions');

  const userXml = `<?xml version="1.0"?><user id="501" name="ada" termsofuse="https://boardgamegeek.com/xmlapi/termsofuse"><firstname value="Ada"/></user>`;
  assert.deepEqual(xmlapi.parseUserXml(userXml), { id: 501, username: 'ada' });
  assert.equal(xmlapi.parseUserXml('<?xml version="1.0"?><user id="0" name=""></user>'), null);
  const looked = await xmlapi.lookupUser('ada', {
    fetchImpl: async (url, init) => {
      assert.match(url, /\/xmlapi2\/user\?name=ada/);
      assert.doesNotMatch(url, /www\./);
      assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
      return { ok: true, status: 200, text: async () => userXml };
    }
  });
  assert.deepEqual(looked, { id: 501, username: 'ada' });
  ok('a BGG username resolves to a numeric id without using Geekgroup');

  console.log('\nBGG play logging');
  const plays = await import('./bgg/plays.js');
  const { playPayload } = await import('./plays.js');

  const SECRET = 'not-a-real-password';
  const loginCalls = [];
  const session = await plays.loginBgg('jeff', SECRET, {
    fetchImpl: async (url, init) => {
      loginCalls.push({ url, init });
      return {
        ok: true,
        status: 200,
        headers: {
          getSetCookie: () => [
            'bggusername=jeff; Path=/',
            'bggpassword=HASH; Path=/',
            'SessionID=abc123; Path=/'
          ],
          get: () => null
        },
        text: async () => '{}'
      };
    }
  });
  assert.match(loginCalls[0].url, /boardgamegeek\.com\/login\/api\/v1/);
  assert.doesNotMatch(loginCalls[0].url, /www\./);
  const creds = JSON.parse(loginCalls[0].init.body);
  assert.equal(creds.credentials.username, 'jeff');
  assert.equal(creds.credentials.password, SECRET);
  assert.match(session, /bggusername=jeff/);
  assert.match(session, /SessionID=abc123/);
  ok('login posts to boardgamegeek.com and keeps the session cookies');

  try {
    await plays.loginBgg('jeff', SECRET, {
      fetchImpl: async () => ({
        ok: false,
        status: 400,
        headers: { getSetCookie: () => [], get: () => null },
        text: async () => `bad login ${SECRET}`
      })
    });
    assert.fail('bad credentials should throw');
  } catch (err) {
    assert.equal(String(err.message).includes(SECRET), false, 'the password must not appear in the error');
    assert.match(err.message, /login|credentials|password/i);
  }
  ok('a rejected login is an error that never echoes the password');

  const payload = playPayload({
    objectId: 13,
    playdate: '2026-09-14',
    location: 'Game Night',
    players: [{ name: 'Alice', username: 'ada' }]
  });
  let posted;
  await plays.logPlay(session, payload, {
    fetchImpl: async (url, init) => {
      posted = { url, init };
      return { ok: true, status: 200, text: async () => '{"playid": 99}' };
    }
  });
  assert.match(posted.url, /geekplay\.php/);
  assert.match(posted.init.headers.cookie, /SessionID=abc123/);
  const sent = JSON.parse(posted.init.body);
  assert.equal(sent.objectid, 13);
  assert.equal(sent.playdate, '2026-09-14');
  ok('a play posts to geekplay.php with the session cookie');

  console.log(`\n\u2705 BGG XML API TESTS PASSED (${pass} checks) \u2705`);
} finally {
  if (prev === undefined) delete process.env.BGG_APP_TOKEN;
  else process.env.BGG_APP_TOKEN = prev;
}
