// Start ONLY the web control panel, with no Discord connection.
//
//   npm run web
//
// For looking at the panel without deploying a container or logging a second
// bot session into Discord. Everything works except the parts that need the
// gateway: RSVP names fall back to linked players, and "bot offline" shows in
// the header, which is accurate -- nothing here will announce anything.
//
// Point it at a copy if you would rather not touch live data:
//   DB_DIR=./data-scratch npm run web

import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { startWebServer } from '../src/web/server.js';

if (process.env.BGG_APP_TOKEN === '') delete process.env.BGG_APP_TOKEN;
if (process.env.BGG_PASSWORD === '') delete process.env.BGG_PASSWORD;
for (const p of ['data/.env', '.env']) {
  if (fs.existsSync(p)) dotenv.config({ path: p });
}

const dbDir = process.env.DB_DIR || './data';
process.env.DB_DIR = dbDir;

// Loopback by default: this is a look-at-it tool, not a deployment. Set
// WEB_HOST=0.0.0.0 to reach it from your phone on the same network.
if (!process.env.WEB_HOST) process.env.WEB_HOST = '127.0.0.1';
if (!process.env.WEB_PORT) process.env.WEB_PORT = '8120';

console.log(`\nReading and WRITING ${path.resolve(dbDir, 'db.json')}`);
console.log('Edits made in the browser change that file for real.\n');

const server = startWebServer({
  client: null,
  onSettingsChanged: () => console.log('Settings changed. The reminder cron is not running here.')
});

if (server) {
  const port = process.env.WEB_PORT;
  console.log(`\n  Control panel  http://localhost:${port}/`);
  console.log(`  Public page    http://localhost:${port}/public`);
  console.log('\nCtrl-C to stop.\n');
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\nStopping.');
    server?.closeAllConnections?.();
    server?.close();
    process.exit(0);
  });
}
