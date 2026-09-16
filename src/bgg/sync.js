/* Sync orchestration: fetch -> archive raw -> normalize -> write games.json.
 *
 * The only stateful piece of the BGG stack. A sync of thirteen pages takes ten
 * seconds or so, which is too long to hold an HTTP request open for and long
 * enough that the panel should say what it is doing, so POST /api/games/sync
 * starts one and the browser polls GET /api/games/sync for progress.
 */

import fs from 'fs';
import path from 'path';
import * as db from '../database.js';
import * as library from '../games.js';
import { normalize } from './normalize.js';
import { normalizeCsv } from './csv.js';
import { supplement } from './supplement.js';
import { fetchAllPages, probeCollection } from './geekgroup.js';
import { getAppToken, authHeaders, fetchCollections, parseCollectionXml, parseThingParents, mergeExpansionFlag, toLibrary, redact } from './xmlapi.js';

let syncState = {
  status: 'idle', // idle | running | ok | error
  source: null,
  page: 0,
  pages: 0,
  error: null,
  startedAt: null,
  finishedAt: null
};

export function getSyncStatus() {
  return { ...syncState };
}

export function isSyncing() {
  return syncState.status === 'running';
}

function begin(source) {
  if (syncState.status === 'running') {
    throw new Error('A sync is already running.');
  }
  syncState = {
    status: 'running',
    source,
    page: 0,
    pages: 0,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null
  };
}

function finish(error = null) {
  syncState = {
    ...syncState,
    status: error ? 'error' : 'ok',
    error: error ? error.message : null,
    finishedAt: new Date().toISOString()
  };
}

// Shared tail of both paths: archive what we were given, then rebuild.
function rebuild(pages, source) {
  library.archiveRaw(pages);
  const payload = normalize(pages, db.getAllPlayers(), { source });
  library.writeLibrary(payload);
  return payload;
}

// -------------------------------------------------------------
// LIVE SYNC
// -------------------------------------------------------------

/**
 * Kick off a background sync. Returns immediately with the running status;
 * progress and the outcome are read back through getSyncStatus().
 */
// One place that decides what request the sync replays. A captured request
// wins outright: it carries the POST body and session cookies that the bare
// URL-and-token path cannot reconstruct.
export function resolveRequest() {
  const settings = db.getSettings();
  const captured = settings.bggRequest;

  if (captured?.url) {
    return {
      url: captured.url,
      method: captured.method || 'POST',
      headers: captured.headers || {},
      body: captured.body ?? null,
      token: ''
    };
  }

  const url = settings.bggCollectionUrl || '';
  if (!url) {
    throw new Error('No collection request is configured. Paste one under Settings.');
  }
  return { url, method: 'GET', headers: {}, body: null, token: settings.bggToken || '' };
}

export function startSync() {
  const request = resolveRequest();

  begin('geekgroup');

  // Deliberately not awaited: the caller is an HTTP handler that must answer now.
  (async () => {
    try {
      const pages = await fetchAllPages({
        ...request,
        onProgress: ({ page, pages: total }) => {
          syncState = { ...syncState, page, pages: total };
        }
      });
      rebuild(pages, 'geekgroup');
      finish();
    } catch (err) {
      console.error('❌ Collection sync failed:', err.message);
      finish(err);
    }
  })();

  return getSyncStatus();
}

function linkedBggPlayers() {
  return db.getAllPlayers().filter(p => String(p?.bgg_username || '').trim() && Number(p.bgg_user_id) > 0);
}

/**
 * Sync from BoardGameGeek's XML API2 using BGG_APP_TOKEN. Refuses before
 * starting if the token or at least one linked username is missing, so the
 * HTTP handler can 400 rather than leaving a failed run in the progress poll.
 */
export function startBggSync() {
  authHeaders(getAppToken());
  if (!linkedBggPlayers().length) {
    throw new Error('Link at least one player to a BGG username before syncing from BoardGameGeek.');
  }

  begin('bgg');

  (async () => {
    try {
      const result = await fetchCollections(db.getAllPlayers(), {
        onProgress: ({ page, pages: total }) => {
          syncState = { ...syncState, page, pages: total };
        }
      });
      library.archiveRawFiles(result.xmlFiles);
      library.writeLibrary(result.library);
      syncState = { ...syncState, page: result.xmlFiles.length, pages: result.xmlFiles.length };
      finish();
    } catch (err) {
      console.error('❌ BGG XML API sync failed:', redact(err.message));
      finish(new Error(redact(err.message)));
    }
  })();

  return getSyncStatus();
}

/**
 * Fetch one page and report whether the credentials actually scoped it to this
 * group -- without writing anything. Worth having as its own action because the
 * failure mode is a successful-looking 200.
 */
export async function testConnection() {
  const request = resolveRequest();
  const result = await probeCollection(request);
  const captured = request.method !== 'GET';

  return {
    ...result,
    message: result.ok
      ? `Looks right: ${result.total} games over ${result.pages} ${result.pages === 1 ? 'page' : 'pages'}` +
        (result.members.length ? `, members ${result.members.join(', ')}.` : '.')
      : `That came back with ${result.total} games over ${result.pages} pages, which is a public group rather ` +
        'than yours — the request is not being recognised as signed in. ' +
        (captured
          ? 'The captured session has probably expired; copy the request again from a logged-in tab.'
          : 'Paste the request from your browser (Copy as cURL) rather than just a URL: this API needs the POST body and session cookies.')
  };
}

// -------------------------------------------------------------
// FILE IMPORT
// -------------------------------------------------------------

// JSON API bodies stay at 256 KB (a single page dump is 279 KB). Upload is a
// separate raw-body route with its own cap so that limit can stay small.
// Copying a file into data/bgg-import/ by hand still works.
//
// Two shapes are accepted. The .json pages are what the API answers with and
// carry everything; the .csv export covers the whole collection in one file but
// loses the per-person detail (see csv.js). Geekgroup offers both, so the panel
// takes both rather than making anyone convert one into the other.
const IMPORT_NAME = /^[\w .()-]+\.(json|csv)$/;

export function listImportFiles() {
  const { importDir } = library.getPaths();
  try {
    return fs.readdirSync(importDir)
      .filter(name => IMPORT_NAME.test(name))
      .sort();
  } catch {
    return [];
  }
}

export function saveImportFile(filename, text) {
  const name = String(filename || '').trim();
  if (!name) throw new Error('An import filename is required.');
  if (!IMPORT_NAME.test(name)) {
    throw new Error('Import file must be a .json or .csv file in data/bgg-import/.');
  }
  if (!String(text ?? '')) throw new Error('The upload was empty.');

  const { importDir } = library.getPaths();
  fs.mkdirSync(importDir, { recursive: true });
  const target = path.resolve(importDir, name);
  if (path.relative(path.resolve(importDir), target).startsWith('..')) {
    throw new Error('Import file must be inside the import directory.');
  }
  fs.writeFileSync(target, text, 'utf-8');
  return name;
}

function resolveImport(filename) {
  const name = String(filename || '').trim();
  if (!IMPORT_NAME.test(name)) {
    throw new Error('Import file must be a .json or .csv file in data/bgg-import/.');
  }

  const { importDir } = library.getPaths();
  const target = path.resolve(importDir, name);
  // Belt and braces: the pattern already rejects slashes and "..", but the
  // containment check is what makes that a guarantee rather than a reading.
  if (path.relative(path.resolve(importDir), target).startsWith('..')) {
    throw new Error('Import file must be inside the import directory.');
  }

  try {
    return { name, text: fs.readFileSync(target, 'utf-8') };
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`No import file named "${name}".`, { cause: err });
    throw new Error(`Could not read "${name}": ${err.message}`, { cause: err });
  }
}

// Parse an import file into a library payload, without deciding what to do
// with it. Both import modes need exactly this and differ only afterwards.
function libraryFromImport(name, text, source) {
  if (name.toLowerCase().endsWith('.csv')) {
    return { payload: normalizeCsv(text, db.getAllPlayers(), { source }), pages: 1, text };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`"${name}" is not valid JSON.`, { cause: err });
  }
  const pages = Array.isArray(parsed) ? parsed : [parsed];
  if (!pages.some(p => Array.isArray(p?.collection))) {
    throw new Error(`"${name}" does not look like a Geekgroup collection dump.`);
  }
  return {
    payload: normalize(pages, db.getAllPlayers(), { source }),
    pages: pages.length,
    rawPages: pages
  };
}

/**
 * Rebuild the library from a dump sitting in data/bgg-import/. Synchronous --
 * it is a file read, not a crawl.
 *
 * A .json file may be a single page body or an array of them; a multi-page
 * capture saved as one file is the obvious thing for someone to do.
 *
 * Two modes, because a Geekgroup dump is useful in two different ways:
 *
 *   'replace'    the dump becomes the library. What this has always done, and
 *                the right answer when Geekgroup is the only source there is.
 *   'supplement' the dump fills the holes in the library already on disk --
 *                weight, best/recommended players, value, the group rating --
 *                and touches nothing else. The right answer once a BGG sync
 *                has supplied artwork and real per-person ownership.
 *
 * A supplement deliberately does not archive into data/bgg-raw/. That archive
 * is what rebuildFromArchive() replays, and writing a Geekgroup run into it
 * would leave the next Rebuild reconstructing the library from the supplement
 * rather than from the BGG sync it was supplementing. The file stays in
 * data/bgg-import/, which is durable on its own.
 */
export function importFromFile(filename, { mode = 'replace' } = {}) {
  const { name, text } = resolveImport(filename);
  const supplementing = mode === 'supplement';

  begin(supplementing ? 'supplement' : 'import');
  try {
    const isCsv = name.toLowerCase().endsWith('.csv');
    // As the library, a dump is labelled by how it arrived ("imported"). As a
    // supplement it is labelled by what it is, since that is what the panel
    // reports it as: gaps filled from Geekgroup, or from its CSV export.
    const source = isCsv ? 'csv' : (supplementing ? 'geekgroup' : 'import');
    const { payload: parsedLibrary, pages, text: csvText, rawPages } = libraryFromImport(name, text, source);

    let payload;
    if (supplementing) {
      const current = library.readLibrary();
      if (!(current.games || []).length) {
        throw new Error('There is no library to supplement yet. Sync from BoardGameGeek first, or import this file instead.');
      }
      payload = supplement(current, parsedLibrary);
      library.writeLibrary(payload);
    } else {
      if (csvText !== undefined) library.archiveRawText(csvText, 'csv');
      else library.archiveRaw(rawPages || []);
      payload = library.writeLibrary(parsedLibrary);
    }

    syncState = { ...syncState, page: pages, pages };
    finish();
    return payload;
  } catch (err) {
    finish(err);
    throw err;
  }
}

/**
 * Re-run normalization over the newest archived raw run, without refetching.
 * The reason the archive exists: surfacing a field we skipped, or picking up a
 * newly linked BGG account in the group average, costs a re-parse.
 */
export function rebuildFromArchive() {
  const runs = library.listRawRuns();
  if (!runs.length) throw new Error('No archived sync to rebuild from.');

  const { rawDir } = library.getPaths();
  const runDir = path.join(rawDir, runs[0]);
  const files = fs.readdirSync(runDir).sort();
  const source = library.readLibrary().source || 'geekgroup';

  const collectionXml = files.filter(f => /^collection-.*\.xml$/i.test(f));
  if (collectionXml.length) {
    const expansionByUser = new Map();
    for (const name of files.filter(f => /^expansions-.*\.xml$/i.test(f))) {
      const m = name.match(/^expansions-(\d+)-/i);
      const xml = fs.readFileSync(path.join(runDir, name), 'utf-8');
      expansionByUser.set(m ? Number(m[1]) : 0, parseCollectionXml(xml));
    }
    const collections = collectionXml.map(name => {
      const m = name.match(/^collection-(\d+)-(.+)\.xml$/i);
      const xml = fs.readFileSync(path.join(runDir, name), 'utf-8');
      const userId = m ? Number(m[1]) : 0;
      return {
        userId,
        username: m ? m[2] : '',
        items: mergeExpansionFlag(parseCollectionXml(xml), expansionByUser.get(userId) || [])
      };
    });
    const parents = new Map();
    for (const name of files.filter(f => /^things-.*\.xml$/i.test(f))) {
      for (const [child, parent] of parseThingParents(fs.readFileSync(path.join(runDir, name), 'utf-8'))) {
        parents.set(child, parent);
      }
    }
    const payload = toLibrary(collections, db.getAllPlayers(), { parents, source: 'bgg' });
    library.writeLibrary(payload);
    return payload;
  }

  // A CSV run archives one file; a JSON run archives one per page.
  const csv = files.find(f => f.endsWith('.csv'));
  const payload = csv
    ? normalizeCsv(fs.readFileSync(path.join(runDir, csv), 'utf-8'), db.getAllPlayers(), { source })
    : normalize(
      files.filter(f => f.endsWith('.json'))
        .map(f => JSON.parse(fs.readFileSync(path.join(runDir, f), 'utf-8'))),
      db.getAllPlayers(),
      { source }
    );

  library.writeLibrary(payload);
  return payload;
}
