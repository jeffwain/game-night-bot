/* The game library store: data/games.json.
 *
 * Kept out of db.json on purpose. db.json is rewritten and backed up on every
 * player edit and every RSVP click (see createBackup in database.js), and a
 * six-hundred-game library riding along would multiply the size of all twelve
 * retained backups for no gain -- nothing in the library is hand-edited, and a
 * resync rebuilds the whole file from the raw archive.
 *
 * That archive is why there is no backup tier here: data/bgg-raw/ holds the
 * verbatim pages every sync fetched, so games.json is always reproducible.
 */

import fs from 'fs';
import path from 'path';

let cache = null;
let lastModified = 0;

const EMPTY = { synced_at: null, source: null, users: [], games: [] };

export function getPaths() {
  const dir = process.env.DB_DIR || './data';
  return {
    dir,
    libraryPath: path.join(dir, 'games.json'),
    rawDir: path.join(dir, 'bgg-raw'),
    importDir: path.join(dir, 'bgg-import')
  };
}

// A missing library is the normal state before the first sync, not an error.
export function readLibrary() {
  const { libraryPath } = getPaths();
  try {
    const stat = fs.statSync(libraryPath);
    if (cache && stat.mtimeMs === lastModified) return cache;
    cache = JSON.parse(fs.readFileSync(libraryPath, 'utf-8'));
    lastModified = stat.mtimeMs;
    return cache;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('❌ Failed to read game library:', err.message);
      if (cache) return cache;
    }
    return EMPTY;
  }
}

export function getGames() {
  return readLibrary().games || [];
}

export function getGamesUsers() {
  return readLibrary().users || [];
}

export function getGamesMeta() {
  const library = readLibrary();
  const games = library.games || [];
  return {
    synced_at: library.synced_at || null,
    source: library.source || null,
    game_count: games.length,
    expansion_count: games.reduce((n, g) => n + (g.expansions?.length || 0), 0),
    user_count: (library.users || []).length,
    // Null until a Geekgroup dump has been folded in on top of a sync.
    supplement_source: library.supplement_source || null,
    supplemented_at: library.supplemented_at || null,
    supplemented_count: library.supplemented_count || 0,
    image_count: games.filter(g => g.thumbnail || g.image).length
  };
}

// Same atomic temp+rename as writeDbSync: a crash mid-write leaves the previous
// library intact rather than a half-written file that fails to parse.
export function writeLibrary(payload) {
  const { dir, libraryPath } = getPaths();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const tempPath = `${libraryPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf-8');
  fs.renameSync(tempPath, libraryPath);

  cache = payload;
  try {
    lastModified = fs.statSync(libraryPath).mtimeMs;
  } catch {
    lastModified = Date.now();
  }
  return payload;
}

// -------------------------------------------------------------
// RAW ARCHIVE
// -------------------------------------------------------------

const RAW_KEEP = 3;

// Colons are legal in an ISO timestamp and illegal in a Windows filename, and
// this repo is developed on Windows and deployed on Alpine.
function stampFor(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z');
}

/**
 * Write the untouched page bodies to data/bgg-raw/<stamp>/page-NN.json before
 * anything normalizes them, so a field we do not surface yet is a re-parse away
 * rather than another crawl.
 */
export function archiveRaw(pages, date = new Date()) {
  const { rawDir } = getPaths();
  const runDir = path.join(rawDir, stampFor(date));
  fs.mkdirSync(runDir, { recursive: true });

  pages.forEach((page, i) => {
    const name = `page-${String(i + 1).padStart(2, '0')}.json`;
    fs.writeFileSync(path.join(runDir, name), JSON.stringify(page), 'utf-8');
  });

  pruneRaw();
  return runDir;
}

/**
 * Archive a raw file that is not a set of JSON pages -- the CSV export. Same
 * contract as archiveRaw: whatever the library was built from is kept verbatim,
 * so a rebuild never has to go back to the network.
 */
export function archiveRawText(text, extension = 'txt', date = new Date()) {
  return archiveRawFiles([{ name: `page-01.${extension}`, text }], date);
}

/**
 * Write named files into one run directory. Used by the BGG XML API path,
 * which archives one collection document per user plus any /thing batches.
 */
export function archiveRawFiles(files, date = new Date()) {
  const { rawDir } = getPaths();
  const runDir = path.join(rawDir, stampFor(date));
  fs.mkdirSync(runDir, { recursive: true });
  for (const file of files || []) {
    const name = path.basename(String(file.name || 'page.bin'));
    fs.writeFileSync(path.join(runDir, name), file.text ?? '', 'utf-8');
  }
  pruneRaw();
  return runDir;
}

export function pruneRaw(keep = RAW_KEEP) {
  const { rawDir } = getPaths();
  try {
    const runs = fs.readdirSync(rawDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort();
    for (const name of runs.slice(0, Math.max(0, runs.length - keep))) {
      fs.rmSync(path.join(rawDir, name), { recursive: true, force: true });
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('❌ Failed to prune raw archive:', err.message);
  }
}

export function listRawRuns() {
  const { rawDir } = getPaths();
  try {
    return fs.readdirSync(rawDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}
