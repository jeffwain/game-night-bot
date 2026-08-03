// Database layer tests.
//
// Hand-rolled rather than node:test: this suite is as much a readable trace of
// how the schedule mutates as it is a set of assertions, and the console output
// is genuinely useful when a rotation behaves unexpectedly. Assertion-style
// coverage of the pure functions lives in testFeatures.js. Both run in CI.

import {
  addPlayer,
  updatePlayer,
  togglePlayer,
  getAllPlayers,
  getActivePlayers,
  createSchedule,
  getSchedule,
  markAsPlayed,
  markLatestAsPlayedForPlayer,
  swapScheduleDates,
  getPendingUnnotifiedPastGames,
  markGameAsNotified,
  clearPendingSchedule,
  getPendingUnremindedGamesForDate,
  markGameAsReminded,
  setRsvp,
  swapTwoSpecificGames,
  postponeGameAndShift,
  openGameForClaim,
  claimOpenGame,
  getUnclaimedGamesDueBy,
  findPlayerByDiscordId,
  removeGameAndShiftSchedule,
  appendSchedule
} from './database.js';
import fs from 'fs';

const TEST_DB_DIR = './data-test';
process.env.DB_DIR = TEST_DB_DIR;

function cleanup() {
  if (fs.existsSync(TEST_DB_DIR)) {
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  }
}

function runTests() {
  console.log('--- STARTING DATABASE LAYER TESTS ---');
  
  cleanup();

  try {
    // 2. Add players
    console.log('Testing: addPlayer...');
    addPlayer('Jeff', '11111');
    addPlayer('Phil', '22222');
    addPlayer('Aaron');
    addPlayer('Miguel', '44444');
    
    console.log('Successfully added players:', getAllPlayers().map(p => p.name));
    if (getAllPlayers().length !== 4) throw new Error('Expected 4 players');

    // 3. Test uniqueness constraint
    console.log('Testing: Name uniqueness...');
    try {
      addPlayer('jeff');
      throw new Error('Allowed duplicate name "jeff" case-insensitively!');
    } catch (e) {
      console.log('  Successfully rejected duplicate player: ' + e.message);
    }

    // 4. Toggle active state
    console.log('Testing: togglePlayer...');
    togglePlayer('Aaron');
    let active = getActivePlayers();
    console.log('  Active players after toggling Aaron:', active.map(p => p.name));
    if (active.some(p => p.name === 'Aaron')) throw new Error('Aaron should be inactive');

    // Toggle back
    togglePlayer('Aaron');
    active = getActivePlayers();
    if (!active.some(p => p.name === 'Aaron')) throw new Error('Aaron should be active again');

    // 5. Update player
    console.log('Testing: updatePlayer...');
    updatePlayer('Aaron', false, '33333');
    const aaron = getAllPlayers().find(p => p.name === 'Aaron');
    console.log('  Aaron updated:', aaron);
    if (aaron.is_active !== false || aaron.discord_id !== '33333') {
      throw new Error('Aaron did not update properly');
    }
    
    // Set Aaron active again for schedule tests
    updatePlayer('Aaron', true);

    // 6. Create schedule
    console.log('Testing: createSchedule...');
    const activeList = getActivePlayers();
    const dates = ['2026-06-02', '2026-06-09', '2026-06-16', '2026-06-23'];
    const entries = activeList.map((player, index) => ({
      player_id: player.id,
      game_date: dates[index]
    }));
    
    const sched = createSchedule(entries);
    console.log('  Generated Schedule:');
    sched.forEach(s => console.log(`    - ID: ${s.id} | Date: ${s.game_date} | Host: ${s.playerName} | Status: ${s.status}`));
    if (sched.length !== 4) throw new Error('Expected 4 schedule entries');

    // 7. Swap players
    console.log('Testing: swapScheduleDates...');
    console.log('  Before swap:');
    console.log('    Jeff is scheduled for Date:', getSchedule().find(s => s.playerName === 'Jeff').game_date);
    console.log('    Phil is scheduled for Date:', getSchedule().find(s => s.playerName === 'Phil').game_date);
    
    const swapResult = swapScheduleDates('Jeff', 'Phil');
    console.log('  Swapped Jeff and Phil!');
    console.log('    Jeff is now scheduled for Date:', getSchedule().find(s => s.playerName === 'Jeff').game_date);
    console.log('    Phil is now scheduled for Date:', getSchedule().find(s => s.playerName === 'Phil').game_date);

    if (swapResult.entry1.playerName !== 'Phil' || swapResult.entry2.playerName !== 'Jeff') {
      throw new Error('Swap return value was incorrect');
    }

    // 8. Mark as played
    console.log('Testing: markAsPlayed...');
    const jeffGame = getSchedule().find(s => s.playerName === 'Jeff');
    const played = markAsPlayed(jeffGame.id, 'completed');
    console.log(`  Marked game ${played.id} for ${played.playerName} as completed:`, played);
    if (played.status !== 'completed') throw new Error('Expected status to be completed');

    // 9. Mark latest as played for player
    console.log('Testing: markLatestAsPlayedForPlayer...');
    const played2 = markLatestAsPlayedForPlayer('Phil', 'skipped');
    console.log(`  Marked latest for Phil as skipped:`, played2);
    if (played2.status !== 'skipped') throw new Error('Expected status to be skipped');

    // 10. Check DMs notification logic
    console.log('Testing: getPendingUnnotifiedPastGames...');
    const pastGames = getPendingUnnotifiedPastGames('2026-06-17');
    console.log('  Unnotified pending games as of 2026-06-17:', pastGames);
    if (pastGames.length !== 1 || pastGames[0].playerName !== 'Aaron') {
      throw new Error('Expected exactly 1 pending past game (Aaron)');
    }

    console.log('Testing: markGameAsNotified...');
    markGameAsNotified(pastGames[0].id);
    const pastGamesAfter = getPendingUnnotifiedPastGames('2026-06-17');
    console.log('  Unnotified games after marking Aaron as notified:', pastGamesAfter);
    if (pastGamesAfter.length !== 0) throw new Error('Expected 0 unnotified games');

    // 11. Test upcoming game night reminders
    console.log('Testing: getPendingUnremindedGamesForDate...');
    const unreminded = getPendingUnremindedGamesForDate('2026-06-16');
    console.log('  Unreminded games for 2026-06-16:', unreminded);
    if (unreminded.length !== 1 || unreminded[0].playerName !== 'Aaron') {
      throw new Error('Expected exactly 1 unreminded game night for Aaron on 2026-06-16');
    }

    console.log('Testing: markGameAsReminded...');
    markGameAsReminded(unreminded[0].id);
    const unremindedAfter = getPendingUnremindedGamesForDate('2026-06-16');
    console.log('  Unreminded games after marking Aaron as reminded:', unremindedAfter);
    if (unremindedAfter.length !== 0) {
      throw new Error('Expected 0 unreminded games after marking as reminded');
    }

    // 12. Test RSVP & Host DM Actions
    console.log('Testing: setRsvp...');
    setRsvp(4, 'user_a', 'going');
    setRsvp(4, 'user_b', 'tentative');
    setRsvp(4, 'user_c', 'out');
    setRsvp(4, 'user_a', 'going');
    
    const game4 = getSchedule().find(s => s.id === 4);
    console.log('  Game 4 RSVPs:', game4.rsvps);
    if (game4.rsvps['user_a'] !== 'going' || game4.rsvps['user_b'] !== 'tentative' || game4.rsvps['user_c'] !== 'out') {
      throw new Error('RSVPs were not stored correctly.');
    }

    console.log('Testing: swapTwoSpecificGames...');
    console.log('  Before specific swap:');
    console.log('    ID 3 Host:', getSchedule().find(s => s.id === 3).playerName);
    console.log('    ID 4 Host:', getSchedule().find(s => s.id === 4).playerName);
    
    swapTwoSpecificGames(3, 4);
    console.log('  After specific swap:');
    console.log('    ID 3 Host (should be Miguel):', getSchedule().find(s => s.id === 3).playerName);
    console.log('    ID 4 Host (should be Aaron):', getSchedule().find(s => s.id === 4).playerName);
    if (getSchedule().find(s => s.id === 3).playerName !== 'Miguel' || getSchedule().find(s => s.id === 4).playerName !== 'Aaron') {
      throw new Error('Specific swap failed.');
    }

    // postponeGameAndShift: skipping CANCELS the night. The host keeps their
    // turn and takes the next slot; everyone behind slides one interval. The
    // old skipHostAndSwapWithNext handed the night to the next person, which
    // silently cost that person their turn.
    console.log('Testing: postponeGameAndShift (order preserved, nobody loses a turn)...');
    const beforeSkip = getSchedule().filter(s => s.status === 'pending')
      .sort((a, b) => a.game_date.localeCompare(b.game_date));
    console.log('  Before skip:');
    beforeSkip.forEach(s => console.log(`    - ${s.game_date} | ${s.playerName}`));

    const orderBefore = beforeSkip.map(s => s.playerName);
    const datesBefore = beforeSkip.map(s => s.game_date);
    const postponed = postponeGameAndShift(beforeSkip[0].id);
    console.log('  postponeGameAndShift result:', {
      skipped: postponed.skipped.game_date,
      rescheduledTo: postponed.rescheduled.game_date,
      intervalDays: postponed.intervalDays,
      shiftedCount: postponed.shiftedCount
    });

    const afterSkip = getSchedule().filter(s => s.status === 'pending')
      .sort((a, b) => a.game_date.localeCompare(b.game_date));
    console.log('  After skip:');
    afterSkip.forEach(s => console.log(`    - ${s.game_date} | ${s.playerName}`));

    if (afterSkip.length !== beforeSkip.length) {
      throw new Error(`Skip changed the pending count (${beforeSkip.length} -> ${afterSkip.length}); nobody should lose a turn.`);
    }
    if (afterSkip.map(s => s.playerName).join('|') !== orderBefore.join('|')) {
      throw new Error(`Skip reordered hosts. Expected ${orderBefore.join(', ')}, got ${afterSkip.map(s => s.playerName).join(', ')}.`);
    }
    for (let i = 0; i < afterSkip.length; i++) {
      const expected = new Date(datesBefore[i] + 'T00:00:00');
      expected.setDate(expected.getDate() + postponed.intervalDays);
      const expectedStr = [
        expected.getFullYear(),
        String(expected.getMonth() + 1).padStart(2, '0'),
        String(expected.getDate()).padStart(2, '0')
      ].join('-');
      if (afterSkip[i].game_date !== expectedStr) {
        throw new Error(`Entry ${i} should have moved to ${expectedStr}, got ${afterSkip[i].game_date}.`);
      }
    }
    if (getSchedule().find(s => s.id === beforeSkip[0].id).status !== 'skipped') {
      throw new Error('The cancelled night should be kept as history with status "skipped".');
    }

    // Open host call: bowing out offers the night to the group, and a claim is
    // a straight two-person date trade.
    console.log('Testing: openGameForClaim / claimOpenGame (straight swap)...');
    const openTarget = getSchedule().filter(s => s.status === 'pending')
      .sort((a, b) => a.game_date.localeCompare(b.game_date))[0];
    const openedGame = openGameForClaim(openTarget.id);
    console.log(`  ${openedGame.playerName} opened up ${openedGame.game_date}`);

    if (!getUnclaimedGamesDueBy(openTarget.game_date).some(s => s.id === openTarget.id)) {
      throw new Error('An open night should appear in getUnclaimedGamesDueBy at its own date.');
    }

    const volunteer = getSchedule().filter(s => s.status === 'pending' && s.id !== openTarget.id)
      .sort((a, b) => a.game_date.localeCompare(b.game_date))[0];
    const volunteerPlayerId = getAllPlayers().find(p => p.name === volunteer.playerName).id;
    const volunteerOldDate = volunteer.game_date;

    const claimResult = claimOpenGame(openTarget.id, volunteerPlayerId);
    console.log('  claimOpenGame result:', {
      claimedBy: claimResult.claimed.playerName,
      claimedDate: claimResult.claimed.game_date,
      handedTo: claimResult.handedOff.playerName,
      handedDate: claimResult.handedOff.game_date
    });

    if (claimResult.claimed.game_date !== openTarget.game_date) {
      throw new Error('A claim must not move the open night to a different date.');
    }
    if (claimResult.handedOff.game_date !== volunteerOldDate) {
      throw new Error('The host who bowed out should inherit the volunteer original date.');
    }
    if (getSchedule().find(s => s.id === openTarget.id).awaiting_claim) {
      throw new Error('awaiting_claim should be cleared once the night is claimed.');
    }

    console.log('Testing: findPlayerByDiscordId...');
    if (findPlayerByDiscordId('11111').name !== 'Jeff') {
      throw new Error('findPlayerByDiscordId did not resolve a linked account.');
    }
    if (findPlayerByDiscordId('nobody-has-this') !== null) {
      throw new Error('findPlayerByDiscordId should return null for an unknown snowflake.');
    }

    // Counts are asserted RELATIVE to the state this point in the trace has
    // reached. Hard-coded totals here broke every time an earlier test changed
    // how many nights it left behind, which said nothing about removal itself.
    console.log('Testing: removeGameAndShiftSchedule (marks player inactive)...');
    const pendingBeforeRem = getSchedule().filter(s => s.status === 'pending').length;
    const gameToRem = getSchedule().filter(s => s.status === 'pending')
      .sort((a, b) => a.game_date.localeCompare(b.game_date))[0];
    console.log('  Removing game on 2026-06-23 hosted by:', gameToRem.playerName);
    
    // Check active status before
    const hostPlayer = getAllPlayers().find(p => p.name === gameToRem.playerName);
    console.log(`    Before removal, ${hostPlayer.name} is_active:`, hostPlayer.is_active);
    if (!hostPlayer.is_active) throw new Error('Player should be active before removal.');

    removeGameAndShiftSchedule(gameToRem.id);
    
    // Check active status after
    console.log(`    After removal, ${hostPlayer.name} is_active:`, hostPlayer.is_active);
    if (hostPlayer.is_active) throw new Error('Player should be marked inactive after removal.');
    
    const afterRem = getSchedule().filter(s => s.status === 'pending').sort((a, b) => a.game_date.localeCompare(b.game_date));
    console.log(`  Pending schedule after removal (should be ${pendingBeforeRem - 1} games, shifted up):`);
    afterRem.forEach(s => console.log(`    - Date: ${s.game_date} | Host: ${s.playerName}`));
    if (afterRem.length !== pendingBeforeRem - 1) {
      throw new Error(`Expected ${pendingBeforeRem - 1} pending games after removal, got ${afterRem.length}.`);
    }

    console.log('Testing: appendSchedule...');
    const activeBeforeAppend = getActivePlayers();
    console.log('  Active players before append (should be 3):', activeBeforeAppend.map(p => p.name));
    if (activeBeforeAppend.length !== 3) {
      throw new Error('Expected 3 active players after one was set inactive.');
    }

    const appendDates = ['2026-07-28', '2026-08-04', '2026-08-11'];
    const appendEntries = activeBeforeAppend.map((player, index) => ({
      player_id: player.id,
      game_date: appendDates[index]
    }));

    const appended = appendSchedule(appendEntries);
    console.log('  Appended entries returned:');
    appended.forEach(s => console.log(`    - ID: ${s.id} | Date: ${s.game_date} | Host: ${s.playerName}`));
    if (appended.length !== 3) {
      throw new Error('Expected 3 entries to be appended and returned.');
    }

    const expectedPending = afterRem.length + 3;
    const totalPendingAfter = getSchedule().filter(s => s.status === 'pending');
    console.log(`  Total pending games after append (should be ${afterRem.length} + 3 = ${expectedPending}):`, totalPendingAfter.length);
    if (totalPendingAfter.length !== expectedPending) {
      throw new Error(`Expected ${expectedPending} pending games in total, got ${totalPendingAfter.length}.`);
    }

    // 14. Test clear pending schedule
    console.log('Testing: clearPendingSchedule...');
    const historyCount = getSchedule().filter(s => s.status !== 'pending').length;
    const initialSched = getSchedule();
    console.log(`  Total games before clearing: ${initialSched.length} (${initialSched.filter(s => s.status === 'pending').length} pending)`);
    clearPendingSchedule();
    const clearedSched = getSchedule();
    console.log(`  Total games after clearing: ${clearedSched.length} (${clearedSched.filter(s => s.status === 'pending').length} pending)`);
    if (clearedSched.some(s => s.status === 'pending')) {
      throw new Error('Pending games still exist after clearPendingSchedule');
    }
    if (clearedSched.length !== historyCount) {
      throw new Error(`Historical completed/skipped games were incorrectly deleted (${historyCount} -> ${clearedSched.length})`);
    }
    console.log('  Successfully cleared pending games while retaining history!');

    console.log('\n✅ ALL DATABASE TESTS PASSED SUCCESSFULLY! ✅');
  } catch (err) {
    console.error('\n❌ DATABASE TESTS FAILED! ❌');
    console.error(err);
    process.exit(1);
  } finally {
    cleanup();
  }
}

runTests();
