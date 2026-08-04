import fs from 'fs';
import path from 'path';
import { addDaysIso } from './time.js';

let dbCache = null;
let dbLastModified = 0;

function getDbPaths() {
  const dbDir = process.env.DB_DIR || './data';
  const dbPath = path.join(dbDir, 'db.json');
  return { dbPath, dbDir };
}

function ensureDbExists() {
  const { dbPath, dbDir } = getDbPaths();
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  if (!fs.existsSync(dbPath)) {
    const initialData = { players: [], schedule: [], settings: {} };
    fs.writeFileSync(dbPath, JSON.stringify(initialData, null, 2), 'utf-8');
    dbCache = initialData;
    dbLastModified = fs.statSync(dbPath).mtimeMs;
  }
}

function readDb() {
  ensureDbExists();
  const { dbPath } = getDbPaths();
  
  try {
    const stat = fs.statSync(dbPath);
    if (dbCache && stat.mtimeMs === dbLastModified) {
      return dbCache;
    }
    const data = fs.readFileSync(dbPath, 'utf-8');
    dbCache = JSON.parse(data);
    
    // BACKWARD COMPATIBILITY
    if (!dbCache.settings) {
      dbCache.settings = {};
      const envAnnounce = process.env.DISCORD_CHANNEL_ID;
      const envNotif = process.env.NOTIFICATIONS_CHANNEL_ID;
      if (envAnnounce) dbCache.settings.announcementsChannel = envAnnounce;
      if (envNotif) dbCache.settings.notificationsChannel = envNotif;
      fs.writeFileSync(dbPath, JSON.stringify(dbCache, null, 2), 'utf-8');
    }
    
    dbLastModified = fs.statSync(dbPath).mtimeMs;
    return dbCache;
  } catch (err) {
    console.error('❌ Failed to read database, attempting recovery:', err.message);
    
    try {
      const { dbDir } = getDbPaths();
      const backupDir = path.join(dbDir, 'backups');
      if (fs.existsSync(backupDir)) {
        const files = fs.readdirSync(backupDir)
          .filter(f => (f.startsWith('db_backup_') || f.startsWith('db_daily_')) && f.endsWith('.json'))
          .map(f => ({ 
            name: f, 
            filePath: path.join(backupDir, f), 
            time: fs.statSync(path.join(backupDir, f)).mtimeMs 
          }))
          .sort((a, b) => b.time - a.time);
          
        for (const backup of files) {
          try {
            console.log(`🔄 Attempting auto-recovery using backup: ${backup.name}`);
            const rawBackup = fs.readFileSync(backup.filePath, 'utf-8');
            const parsedBackup = JSON.parse(rawBackup);
            if (parsedBackup.players && parsedBackup.schedule) {
              if (!parsedBackup.settings) parsedBackup.settings = {};
              fs.writeFileSync(dbPath, rawBackup, 'utf-8');
              dbCache = parsedBackup;
              dbLastModified = fs.statSync(dbPath).mtimeMs;
              console.log(`✅ SUCCESS: Automatically recovered database from backup: ${backup.name}`);
              return dbCache;
            }
          } catch (backupErr) {
            console.error(`❌ Backup file ${backup.name} is also corrupted:`, backupErr.message);
          }
        }
      }
    } catch (backupScanErr) {
      console.error('❌ Failed to scan backups directory for recovery:', backupScanErr.message);
    }
    
    if (dbCache) {
      console.warn('⚠️ Warning: Using previously loaded in-memory database cache to prevent data loss.');
      return dbCache;
    }
    
    console.error('⚠️ Critical Warning: Could not recover from any backup. Using empty schema but write operations are unsafe.');
    dbCache = { players: [], schedule: [], settings: {} };
    return dbCache;
  }
}

export function getDbStats() {
  ensureDbExists();
  const { dbPath, dbDir } = getDbPaths();
  const db = readDb();
  const totalPlayers = db.players.length;
  const activePlayers = db.players.filter(p => p.is_active).length;
  const totalGames = db.schedule.length;
  const pendingGames = db.schedule.filter(s => s.status === 'pending').length;
  const completedGames = db.schedule.filter(s => s.status === 'completed').length;
  const skippedGames = db.schedule.filter(s => s.status === 'skipped').length;
  
  let dbSize = 0;
  try {
    if (fs.existsSync(dbPath)) {
      dbSize = fs.statSync(dbPath).size;
    }
  } catch {
    // Ignore
  }

  let backupCount = 0;
  let latestBackupTime = null;
  try {
    const backupDir = path.join(dbDir, 'backups');
    if (fs.existsSync(backupDir)) {
      const files = fs.readdirSync(backupDir)
        .filter(f => (f.startsWith('db_backup_') || f.startsWith('db_daily_')) && f.endsWith('.json'))
        .map(f => fs.statSync(path.join(backupDir, f)).mtimeMs);
      backupCount = files.length;
      if (backupCount > 0) {
        latestBackupTime = new Date(Math.max(...files));
      }
    }
  } catch {
    // Ignore
  }
  
  return {
    dbPath: path.resolve(dbPath),
    dbSize,
    totalPlayers,
    activePlayers,
    totalGames,
    pendingGames,
    completedGames,
    skippedGames,
    backupCount,
    latestBackupTime
  };
}

// Backups are two-tiered.
//
// The old scheme kept 5 rolling snapshots and wrote one on EVERY mutation --
// including each RSVP click and each notified/reminded/summary_sent flag flip.
// On an active day all 5 slots filled with post-change state within minutes,
// so the thing they were meant to protect against ("someone cleared the
// schedule yesterday") was already unrecoverable.
//
//   ROLLING (5)  -- fine-grained undo, skipped when nothing actually changed.
//   DAILY   (7)  -- one snapshot per ~day, so a week of history always exists.
const ROLLING_KEEP = 5;
const DAILY_KEEP = 7;
const DAILY_MIN_AGE_MS = 20 * 60 * 60 * 1000; // 20h, so a daily lands each day

function listBackups(backupDir, prefix) {
  return fs.readdirSync(backupDir)
    .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
    .map(f => ({
      name: f,
      filePath: path.join(backupDir, f),
      time: fs.statSync(path.join(backupDir, f)).mtimeMs
    }))
    // Newest first. Name breaks mtime ties, because two backups can land in
    // the same millisecond. Filenames end in a zero-padded sequence number so
    // plain code-unit comparison orders them correctly; localeCompare is NOT
    // used here since its punctuation handling is locale-dependent.
    .sort((a, b) => (b.time - a.time) || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
}

// Never reuse a filename. Several operations write twice in a row
// (skipHostAndSwapWithNext appends a rotation, then swaps into it), and those
// land in the same millisecond -- so a timestamp alone silently overwrote the
// previous snapshot instead of keeping it.
//
// The trailing sequence number is always present and zero-padded so that
// filenames sort in write order lexicographically, which is what listBackups
// relies on to break mtime ties.
function uniqueBackupPath(backupDir, prefix, timestamp) {
  for (let n = 0; n < 1000; n++) {
    const candidate = path.join(backupDir, `${prefix}${timestamp}_${String(n).padStart(3, '0')}.json`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  // 1000 backups inside one millisecond is not a real scenario, but never
  // return undefined.
  return path.join(backupDir, `${prefix}${timestamp}_${Date.now()}.json`);
}

function prune(files, keep) {
  for (const file of files.slice(keep)) {
    try {
      fs.unlinkSync(file.filePath);
    } catch {
      // Best effort; a failed prune must never break a DB write.
    }
  }
}

function backupTimestamp(now = new Date()) {
  const p2 = (n) => String(n).padStart(2, '0');
  // Millisecond suffix matters: two writes inside the same second would
  // otherwise resolve to the same filename and silently overwrite each other,
  // so a burst of changes left only one recoverable snapshot.
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}_` +
         `${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}_${ms}`;
}

function createBackup(data) {
  try {
    const { dbDir } = getDbPaths();
    const backupDir = path.join(dbDir, 'backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const serialized = JSON.stringify(data, null, 2);
    const timestamp = backupTimestamp();

    // --- Daily tier: first write after the newest daily ages out. -----------
    const dailies = listBackups(backupDir, 'db_daily_');
    const newestDaily = dailies[0];
    if (!newestDaily || (Date.now() - newestDaily.time) > DAILY_MIN_AGE_MS) {
      fs.writeFileSync(uniqueBackupPath(backupDir, 'db_daily_', timestamp), serialized, 'utf-8');
      prune(listBackups(backupDir, 'db_daily_'), DAILY_KEEP);
    }

    // --- Rolling tier: skip no-op writes. -----------------------------------
    // markGameAsNotified & friends re-save an already-identical document on
    // every scan tick; without this check those alone would churn all 5 slots.
    const rolling = listBackups(backupDir, 'db_backup_');
    if (rolling.length > 0) {
      try {
        if (fs.readFileSync(rolling[0].filePath, 'utf-8') === serialized) return;
      } catch {
        // Unreadable newest backup -- fall through and write a fresh one.
      }
    }

    fs.writeFileSync(uniqueBackupPath(backupDir, 'db_backup_', timestamp), serialized, 'utf-8');
    prune(listBackups(backupDir, 'db_backup_'), ROLLING_KEEP);
  } catch (err) {
    console.error('❌ Warning: Failed to create database backup:', err.message);
  }
}

function exportWeb(data) {
  const webDir = process.env.WEB_EXPORT_DIR;
  if (!webDir) return; // no-op unless configured
  try {
    const names = new Map(data.players.map(p => [p.id, p.name]));
    const schedule = data.schedule
      .map(s => {
        const fullName = names.get(s.player_id) ?? 'Unknown';
        return {
          date: s.game_date,
          // First name only: this snapshot is published publicly at thedice.monster/games.
          host: fullName.split(' ')[0],
          status: s.status
        };
      })
      .sort((a, b) => a.date.localeCompare(b.date));
    const payload = { updatedAt: new Date().toISOString(), schedule };
    // Atomic write (temp + rename) so the page never reads a half-written file.
    const outPath = path.join(webDir, 'schedule.json');
    const tempPath = `${outPath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf-8');
    fs.renameSync(tempPath, outPath);
  } catch (err) {
    // Never let the public viewer break a DB write.
    console.error('Web export failed:', err.message);
  }
}

function writeDbSync(data) {
  dbCache = data;
  const { dbPath } = getDbPaths();
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  const tempPath = `${dbPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tempPath, dbPath);
  
  try {
    dbLastModified = fs.statSync(dbPath).mtimeMs;
  } catch {
    dbLastModified = Date.now();
  }
  
  createBackup(data);
  exportWeb(data);
}

// Re-export the current DB to the public web snapshot (used at startup).
export function exportWebSnapshot() {
  try {
    exportWeb(readDb());
  } catch (err) {
    console.error('Web export snapshot failed:', err.message);
  }
}

// -------------------------------------------------------------
// PLAYER OPERATIONS
// -------------------------------------------------------------

export function getAllPlayers() {
  const db = readDb();
  return db.players;
}

export function getActivePlayers() {
  const db = readDb();
  return db.players.filter(p => p.is_active);
}

export function findPlayerByName(name) {
  const db = readDb();
  return db.players.find(p => p.name.toLowerCase() === name.toLowerCase());
}

// Buttons only ever hand us a Discord snowflake, so claim handling needs the
// reverse lookup of findPlayerByName.
export function findPlayerByDiscordId(discordId) {
  if (!discordId) return null;
  const db = readDb();
  const wanted = String(discordId);
  return db.players.find(p => p.discord_id && String(p.discord_id) === wanted) || null;
}

export function addPlayer(name, discordId = null) {
  const db = readDb();
  const normalizedName = name.trim();
  
  if (db.players.some(p => p.name.toLowerCase() === normalizedName.toLowerCase())) {
    throw new Error(`Player with name "${normalizedName}" already exists.`);
  }

  const nextId = db.players.reduce((max, p) => p.id > max ? p.id : max, 0) + 1;
  const newPlayer = {
    id: nextId,
    name: normalizedName,
    discord_id: discordId ? String(discordId).trim() : null,
    is_active: true
  };

  db.players.push(newPlayer);
  writeDbSync(db);
  return newPlayer;
}

export function removePlayer(name) {
  const db = readDb();
  const playerIndex = db.players.findIndex(p => p.name.toLowerCase() === name.toLowerCase());
  
  if (playerIndex === -1) {
    throw new Error(`Player "${name}" not found.`);
  }

  const player = db.players[playerIndex];
  
  db.players.splice(playerIndex, 1);
  db.schedule = db.schedule.filter(s => s.player_id !== player.id);
  
  writeDbSync(db);
  return player;
}

export function updatePlayer(name, isActive = null, discordId = undefined) {
  const db = readDb();
  const player = db.players.find(p => p.name.toLowerCase() === name.toLowerCase());
  
  if (!player) {
    throw new Error(`Player "${name}" not found.`);
  }

  if (isActive !== null) {
    player.is_active = Boolean(isActive);
  }
  
  if (discordId !== undefined) {
    player.discord_id = discordId ? String(discordId).trim() : null;
  }

  writeDbSync(db);
  return player;
}

export function togglePlayer(name) {
  const db = readDb();
  const player = db.players.find(p => p.name.toLowerCase() === name.toLowerCase());
  
  if (!player) {
    throw new Error(`Player "${name}" not found.`);
  }

  player.is_active = !player.is_active;
  writeDbSync(db);
  return player;
}

// -------------------------------------------------------------
// SCHEDULE OPERATIONS
// -------------------------------------------------------------

export function getSchedule() {
  const db = readDb();
  return db.schedule.map(entry => {
    const player = db.players.find(p => p.id === entry.player_id);
    return {
      rsvps: {},
      summary_sent: false,
      awaiting_claim: false,
      ...entry,
      playerName: player ? player.name : 'Unknown Player',
      playerDiscordId: player ? player.discord_id : null
    };
  });
}

export function getPendingGamesForDate(dateStr) {
  return getSchedule().filter(s => s.status === 'pending' && s.game_date === dateStr);
}

export function getRotationIntervalDays() {
  const db = readDb();

  // Deduplicate dates before measuring the gap. Reading the raw first two
  // entries returned 0 whenever they shared a date -- which is exactly the
  // state setEntryDate is in when it asks for the interval in order to space
  // a collision apart. A 0-day interval made the ripple loop bump entries by
  // nothing, spin until its guard tripped, and leave the night double-booked.
  const dates = [...new Set(
    db.schedule.filter(s => s.status === 'pending').map(s => s.game_date)
  )].sort();

  for (let i = 0; i + 1 < dates.length; i++) {
    const d1 = new Date(dates[i] + 'T00:00:00');
    const d2 = new Date(dates[i + 1] + 'T00:00:00');
    const diffDays = Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
    if (diffDays > 0) return diffDays;
  }
  return 7;
}

// Note: rotation generation (shuffle + date spacing) lives in the /update
// handler, not here -- see commands/rotation.js. This module only persists the
// entries it is handed. A second, self-shuffling `appendNewRotation` used to
// sit here; it had no callers and duplicated that logic, so it is gone.

export function appendSchedule(entries) {
  const db = readDb();
  let nextId = db.schedule.reduce((max, s) => s.id > max ? s.id : max, 0) + 1;
  const newIds = [];
  const newEntries = entries.map(e => {
    const id = nextId++;
    newIds.push(id);
    return {
      id,
      player_id: e.player_id,
      game_date: e.game_date,
      status: 'pending',
      notified: false,
      reminder_sent: false,
      summary_sent: false,
      rsvps: {}
    };
  });

  db.schedule = [...db.schedule, ...newEntries];
  writeDbSync(db);
  
  return getSchedule().filter(s => newIds.includes(s.id));
}

export function createSchedule(entries) {
  const db = readDb();
  const history = db.schedule.filter(s => s.status !== 'pending');
  
  let nextId = history.reduce((max, s) => s.id > max ? s.id : max, 0) + 1;
  const newEntries = entries.map(e => ({
    id: nextId++,
    player_id: e.player_id,
    game_date: e.game_date,
    status: 'pending',
    notified: false,
    reminder_sent: false,
    summary_sent: false,
    rsvps: {}
  }));

  db.schedule = [...history, ...newEntries];
  writeDbSync(db);
  return getSchedule().filter(s => s.status === 'pending');
}

export function clearPendingSchedule() {
  const db = readDb();
  const history = db.schedule.filter(s => s.status !== 'pending');
  db.schedule = history;
  writeDbSync(db);
  return getSchedule();
}

export function markAsPlayed(gameId, status = 'completed') {
  const db = readDb();
  const entry = db.schedule.find(s => s.id === Number(gameId));
  
  if (!entry) {
    throw new Error(`Schedule entry ID ${gameId} not found.`);
  }

  if (!['pending', 'completed', 'skipped'].includes(status)) {
    throw new Error(`Invalid status "${status}". Must be pending, completed, or skipped.`);
  }

  entry.status = status;
  writeDbSync(db);
  
  const player = db.players.find(p => p.id === entry.player_id);
  return {
    ...entry,
    playerName: player ? player.name : 'Unknown Player',
    playerDiscordId: player ? player.discord_id : null
  };
}

export function markLatestAsPlayedForPlayer(playerName, status = 'completed') {
  const db = readDb();
  const player = db.players.find(p => p.name.toLowerCase() === playerName.toLowerCase());
  
  if (!player) {
    throw new Error(`Player "${playerName}" not found.`);
  }

  const pendingEntry = db.schedule
    .filter(s => s.player_id === player.id && s.status === 'pending')
    .sort((a, b) => a.game_date.localeCompare(b.game_date))[0];

  if (!pendingEntry) {
    throw new Error(`No pending scheduled game night found for player "${player.name}".`);
  }

  pendingEntry.status = status;
  writeDbSync(db);

  return {
    ...pendingEntry,
    playerName: player.name,
    playerDiscordId: player.discord_id
  };
}

export function swapScheduleDates(player1Name, player2Name) {
  const db = readDb();
  const player1 = db.players.find(p => p.name.toLowerCase() === player1Name.toLowerCase());
  const player2 = db.players.find(p => p.name.toLowerCase() === player2Name.toLowerCase());

  if (!player1) throw new Error(`Player "${player1Name}" not found.`);
  if (!player2) throw new Error(`Player "${player2Name}" not found.`);

  const entry1 = db.schedule
    .filter(s => s.player_id === player1.id && s.status === 'pending')
    .sort((a, b) => a.game_date.localeCompare(b.game_date))[0];

  const entry2 = db.schedule
    .filter(s => s.player_id === player2.id && s.status === 'pending')
    .sort((a, b) => a.game_date.localeCompare(b.game_date))[0];

  if (!entry1) throw new Error(`No pending schedule entry found for ${player1.name}.`);
  if (!entry2) throw new Error(`No pending schedule entry found for ${player2.name}.`);

  const tempPlayerId = entry1.player_id;
  entry1.player_id = entry2.player_id;
  entry2.player_id = tempPlayerId;

  entry1.notified = false;
  entry2.notified = false;
  entry1.reminder_sent = false;
  entry2.reminder_sent = false;

  writeDbSync(db);
  
  return {
    entry1: { ...entry1, playerName: player2.name, playerDiscordId: player2.discord_id },
    entry2: { ...entry2, playerName: player1.name, playerDiscordId: player1.discord_id }
  };
}

export function swapTwoSpecificGames(gameId1, gameId2) {
  const db = readDb();
  const entry1 = db.schedule.find(s => s.id === Number(gameId1));
  const entry2 = db.schedule.find(s => s.id === Number(gameId2));
  if (!entry1 || !entry2) throw new Error('One of the scheduled games could not be found.');
  if (entry1.status !== 'pending' || entry2.status !== 'pending') {
    throw new Error('Can only swap pending game nights.');
  }
  
  const tempPlayerId = entry1.player_id;
  entry1.player_id = entry2.player_id;
  entry2.player_id = tempPlayerId;
  
  entry1.notified = false;
  entry1.reminder_sent = false;
  entry2.notified = false;
  entry2.reminder_sent = false;
  
  writeDbSync(db);
  
  const p1 = db.players.find(p => p.id === entry1.player_id);
  const p2 = db.players.find(p => p.id === entry2.player_id);
  
  return {
    entry1: { ...entry1, playerName: p1 ? p1.name : 'Unknown', playerDiscordId: p1 ? p1.discord_id : null },
    entry2: { ...entry2, playerName: p2 ? p2.name : 'Unknown', playerDiscordId: p2 ? p2.discord_id : null }
  };
}

// -------------------------------------------------------------
// SKIPPING AND OPEN NIGHTS
// -------------------------------------------------------------

// A skipped night is CANCELLED, not handed to the next host in line.
//
// The old skipHostAndSwapWithNext swapped the skipping host with whoever was
// up next, so the night still happened -- just with a different host. That is
// not what "skip" means to anyone pressing the button, and it quietly cost the
// next host their turn. Now the night simply does not occur: the host keeps
// their turn and takes the next slot, and every later pending night slides
// forward by one rotation interval. Relative order never changes.
//
//   before:  Aaron 8/2   Jeff 8/9   Miguel 8/16
//   Aaron skips 8/2
//   after:   [8/2 skipped]   Aaron 8/9   Jeff 8/16   Miguel 8/23
export function postponeGameAndShift(gameId) {
  const db = readDb();
  const entry = db.schedule.find(s => s.id === Number(gameId));
  if (!entry) throw new Error(`Schedule entry ID ${gameId} not found.`);
  if (entry.status !== 'pending') throw new Error(`Game is already ${entry.status}.`);

  // Measured BEFORE anything moves, and never zero: a zero-day interval would
  // stack the replacement night on top of the one it just displaced.
  const intervalDays = Math.max(1, getRotationIntervalDays());
  const skippedDate = entry.game_date;

  const shifted = db.schedule.filter(s =>
    s.status === 'pending' && s.id !== entry.id && s.game_date > skippedDate
  );
  for (const s of shifted) {
    s.game_date = addDaysIso(s.game_date, intervalDays);
    // The night moved, so anything already announced about it is stale.
    s.notified = false;
    s.reminder_sent = false;
    s.summary_sent = false;
  }

  // Keep the cancelled night as history rather than rewriting the past, so
  // /admin status and the public schedule still show a night was called off.
  entry.status = 'skipped';
  entry.awaiting_claim = false;
  delete entry.claim_channel_id;
  delete entry.claim_message_id;

  const replacement = {
    id: db.schedule.reduce((max, s) => s.id > max ? s.id : max, 0) + 1,
    player_id: entry.player_id,
    game_date: addDaysIso(skippedDate, intervalDays),
    status: 'pending',
    notified: false,
    reminder_sent: false,
    summary_sent: false,
    rsvps: {}
  };
  db.schedule.push(replacement);

  writeDbSync(db);

  const player = db.players.find(p => p.id === entry.player_id);
  const hydrate = (e) => ({
    ...e,
    playerName: player ? player.name : 'Unknown Player',
    playerDiscordId: player ? player.discord_id : null
  });

  return {
    skipped: hydrate(entry),
    rescheduled: hydrate(replacement),
    intervalDays,
    shiftedCount: shifted.length
  };
}

// --- open host calls ---------------------------------------------------
//
// A host bowing out does NOT immediately reshuffle anything. The night is
// offered to the group first, because a volunteer is a straight date swap:
// the calendar keeps its cadence and only two people move. Postponing the
// whole rotation is the fallback for when nobody takes it.

export function openGameForClaim(gameId) {
  const db = readDb();
  const entry = db.schedule.find(s => s.id === Number(gameId));
  if (!entry) throw new Error(`Schedule entry ID ${gameId} not found.`);
  if (entry.status !== 'pending') throw new Error(`That game night is already ${entry.status}.`);
  if (entry.awaiting_claim) throw new Error('That night is already open for someone else to claim.');

  entry.awaiting_claim = true;
  writeDbSync(db);

  const player = db.players.find(p => p.id === entry.player_id);
  return {
    ...entry,
    playerName: player ? player.name : 'Unknown Player',
    playerDiscordId: player ? player.discord_id : null
  };
}

// Remember where the "who can take this?" post lives, so it can be closed out
// when the night is claimed or postponed instead of sitting in the channel
// advertising an opening that shut days ago.
export function setClaimMessage(gameId, channelId, messageId) {
  const db = readDb();
  const entry = db.schedule.find(s => s.id === Number(gameId));
  if (!entry) return;
  entry.claim_channel_id = channelId;
  entry.claim_message_id = messageId;
  writeDbSync(db);
}

export function clearClaim(gameId) {
  const db = readDb();
  const entry = db.schedule.find(s => s.id === Number(gameId));
  if (!entry) return;
  entry.awaiting_claim = false;
  delete entry.claim_channel_id;
  delete entry.claim_message_id;
  writeDbSync(db);
}

// Open nights whose date has reached the deadline -- out of time to find a
// volunteer.
export function getUnclaimedGamesDueBy(cutoffDate) {
  return getSchedule().filter(s =>
    s.status === 'pending' && s.awaiting_claim && s.game_date <= cutoffDate
  );
}

// Hand an open night to a volunteer as a straight swap: the volunteer's own
// next pending night goes to the host who bowed out. Same number of nights,
// same dates, two people move.
export function claimOpenGame(gameId, claimerPlayerId) {
  const db = readDb();
  const entry = db.schedule.find(s => s.id === Number(gameId));
  if (!entry) throw new Error(`Schedule entry ID ${gameId} not found.`);
  if (entry.status !== 'pending') throw new Error(`That game night is already ${entry.status}.`);
  if (!entry.awaiting_claim) throw new Error('That night is not open for claiming any more.');

  const claimer = db.players.find(p => p.id === Number(claimerPlayerId));
  if (!claimer) throw new Error(`Player ID ${claimerPlayerId} not found.`);
  if (claimer.id === entry.player_id) throw new Error('You are the host who opened this night up.');

  const originalHost = db.players.find(p => p.id === entry.player_id);

  const claimerEntry = db.schedule
    .filter(s => s.status === 'pending' && s.player_id === claimer.id && s.id !== entry.id)
    .sort((a, b) => a.game_date.localeCompare(b.game_date))[0];

  let handedOff;
  if (claimerEntry) {
    claimerEntry.player_id = entry.player_id;
    claimerEntry.notified = false;
    claimerEntry.reminder_sent = false;
    handedOff = claimerEntry;
  } else {
    // The volunteer has no slot of their own -- a new player, or someone who
    // already hosted this rotation. Give the original host a fresh night at
    // the back rather than silently dropping them from the rotation.
    const intervalDays = Math.max(1, getRotationIntervalDays());
    const lastDate = db.schedule
      .filter(s => s.status === 'pending')
      .map(s => s.game_date)
      .sort()
      .pop() || entry.game_date;

    handedOff = {
      id: db.schedule.reduce((max, s) => s.id > max ? s.id : max, 0) + 1,
      player_id: entry.player_id,
      game_date: addDaysIso(lastDate, intervalDays),
      status: 'pending',
      notified: false,
      reminder_sent: false,
      summary_sent: false,
      rsvps: {}
    };
    db.schedule.push(handedOff);
  }

  entry.player_id = claimer.id;
  entry.awaiting_claim = false;
  delete entry.claim_channel_id;
  delete entry.claim_message_id;
  // Only the host changed -- the date held, so the RSVPs already collected for
  // this night are still valid and are deliberately kept.
  entry.notified = false;
  entry.reminder_sent = false;

  writeDbSync(db);

  return {
    claimed: { ...entry, playerName: claimer.name, playerDiscordId: claimer.discord_id },
    handedOff: {
      ...handedOff,
      playerName: originalHost ? originalHost.name : 'Unknown Player',
      playerDiscordId: originalHost ? originalHost.discord_id : null
    }
  };
}

export function removeGameAndShiftSchedule(gameId) {
  const db = readDb();
  const index = db.schedule.findIndex(s => s.id === Number(gameId));
  if (index === -1) {
    throw new Error(`Schedule entry ID ${gameId} not found.`);
  }

  const removedGame = db.schedule[index];
  if (removedGame.status !== 'pending') {
    throw new Error(`Cannot remove a game that is already ${removedGame.status}.`);
  }

  const player = db.players.find(p => p.id === removedGame.player_id);
  if (player) {
    player.is_active = false;
  }

  const subsequent = db.schedule
    .filter(s => s.status === 'pending' && s.game_date > removedGame.game_date)
    .sort((a, b) => a.game_date.localeCompare(b.game_date));

  if (subsequent.length > 0) {
    const d1 = new Date(removedGame.game_date + 'T00:00:00');
    const d2 = new Date(subsequent[0].game_date + 'T00:00:00');
    const diffTime = Math.abs(d2 - d1);
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    
    for (const game of subsequent) {
      const dbEntry = db.schedule.find(s => s.id === game.id);
      if (dbEntry) {
        dbEntry.game_date = addDaysIso(dbEntry.game_date, -diffDays);
        dbEntry.reminder_sent = false;
      }
    }
  }

  db.schedule.splice(index, 1);
  writeDbSync(db);

  return {
    ...removedGame,
    playerName: player ? player.name : 'Unknown Player'
  };
}

// Manual editor helpers (used by /edit-schedule). These edit a single entry
// surgically — no player deactivation, no rotation reshuffle — except that
// moving an entry onto a date another pending entry already holds ripples the
// conflicting entries forward by the rotation interval so no two share a night.

export function setEntryDate(gameId, newDateStr) {
  const db = readDb();
  const entry = db.schedule.find(s => s.id === Number(gameId));
  if (!entry) throw new Error(`Schedule entry ID ${gameId} not found.`);
  if (entry.status !== 'pending') throw new Error(`Can only edit pending game nights.`);

  entry.game_date = newDateStr;
  entry.notified = false;
  entry.reminder_sent = false;

  // Resolve any date collisions. The entry we just moved keeps its date; the
  // entry it lands on gets pushed forward by the interval, rippling to any it
  // then bumps into. Dates strictly increase each pass, so this terminates.
  // Never zero: a zero interval cannot separate two entries sharing a date.
  const interval = Math.max(1, getRotationIntervalDays());
  let guard = 0;
  while (guard++ < 1000) {
    const pending = db.schedule
      .filter(s => s.status === 'pending')
      .sort((a, b) => a.game_date.localeCompare(b.game_date));

    let bumped = false;
    for (let i = 0; i < pending.length - 1; i++) {
      if (pending[i].game_date !== pending[i + 1].game_date) continue;

      // Keep the entry we explicitly moved; otherwise push the later one forward.
      let target;
      if (pending[i].id === entry.id) target = pending[i + 1];
      else if (pending[i + 1].id === entry.id) target = pending[i];
      else target = pending[i + 1];

      target.game_date = addDaysIso(target.game_date, interval);
      target.notified = false;
      target.reminder_sent = false;
      bumped = true;
      break;
    }
    if (!bumped) break;
  }

  if (guard >= 1000) {
    console.error('⚠️ setEntryDate: collision resolution hit its iteration guard; the schedule may contain a duplicate date.');
  }

  writeDbSync(db);
  const player = db.players.find(p => p.id === entry.player_id);
  return {
    ...entry,
    playerName: player ? player.name : 'Unknown Player',
    playerDiscordId: player ? player.discord_id : null
  };
}

export function setEntryHost(gameId, newPlayerId) {
  const db = readDb();
  const entry = db.schedule.find(s => s.id === Number(gameId));
  if (!entry) throw new Error(`Schedule entry ID ${gameId} not found.`);

  const player = db.players.find(p => p.id === Number(newPlayerId));
  if (!player) throw new Error(`Player ID ${newPlayerId} not found.`);

  entry.player_id = player.id;
  // New host should get their own hosting notice/check-in, so clear the flags.
  entry.notified = false;
  entry.reminder_sent = false;

  writeDbSync(db);
  return {
    ...entry,
    playerName: player.name,
    playerDiscordId: player.discord_id
  };
}

export function deleteEntry(gameId) {
  const db = readDb();
  const index = db.schedule.findIndex(s => s.id === Number(gameId));
  if (index === -1) throw new Error(`Schedule entry ID ${gameId} not found.`);

  const removed = db.schedule[index];
  const player = db.players.find(p => p.id === removed.player_id);

  db.schedule.splice(index, 1);
  writeDbSync(db);

  return {
    ...removed,
    playerName: player ? player.name : 'Unknown Player',
    playerDiscordId: player ? player.discord_id : null
  };
}

// -------------------------------------------------------------
// NOTIFICATION OPERATIONS
// -------------------------------------------------------------

export function getPendingUnnotifiedPastGames(todayDateString) {
  const db = readDb();
  const hydrated = db.schedule.map(entry => {
    const player = db.players.find(p => p.id === entry.player_id);
    return {
      rsvps: {},
      summary_sent: false,
      ...entry,
      playerName: player ? player.name : 'Unknown Player',
      playerDiscordId: player ? player.discord_id : null
    };
  });

  // Strictly-before-today: a game night is only "past" the day AFTER it
  // happens, so the host check-in fires the next morning, never on game day.
  return hydrated.filter(s =>
    s.status === 'pending' &&
    !s.notified &&
    s.game_date < todayDateString
  );
}

export function markGameAsNotified(gameId) {
  const db = readDb();
  const entry = db.schedule.find(s => s.id === Number(gameId));
  if (entry) {
    entry.notified = true;
    writeDbSync(db);
  }
}

export function getPendingUnremindedGamesForDate(targetDateStr) {
  const db = readDb();
  const hydrated = db.schedule.map(entry => {
    const player = db.players.find(p => p.id === entry.player_id);
    return {
      rsvps: {},
      summary_sent: false,
      ...entry,
      playerName: player ? player.name : 'Unknown Player',
      playerDiscordId: player ? player.discord_id : null
    };
  });

  return hydrated.filter(s =>
    s.status === 'pending' &&
    !s.reminder_sent &&
    s.game_date === targetDateStr
  );
}

export function markGameAsReminded(gameId) {
  const db = readDb();
  const entry = db.schedule.find(s => s.id === Number(gameId));
  if (entry) {
    entry.reminder_sent = true;
    writeDbSync(db);
  }
}

export function setRsvp(gameId, discordUserId, status) {
  const db = readDb();
  const entry = db.schedule.find(s => s.id === Number(gameId));
  if (!entry) {
    throw new Error(`Schedule entry ID ${gameId} not found.`);
  }

  if (!entry.rsvps) {
    entry.rsvps = {};
  }

  if (!['going', 'tentative', 'out'].includes(status)) {
    throw new Error(`Invalid RSVP status "${status}".`);
  }

  entry.rsvps[discordUserId] = status;
  writeDbSync(db);
  
  const player = db.players.find(p => p.id === entry.player_id);
  return {
    ...entry,
    playerName: player ? player.name : 'Unknown Player',
    playerDiscordId: player ? player.discord_id : null
  };
}

export function markSummarySent(gameId) {
  const db = readDb();
  const entry = db.schedule.find(s => s.id === Number(gameId));
  if (entry) {
    entry.summary_sent = true;
    writeDbSync(db);
  }
}

export function getSettings() {
  const db = readDb();
  return db.settings || {};
}

export function updateSettings(key, value) {
  const db = readDb();
  if (!db.settings) db.settings = {};
  db.settings[key] = value;
  writeDbSync(db);
  return db.settings;
}
