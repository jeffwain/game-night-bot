import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi, buildPublicSnapshot } from './api.js';

// A dependency-free control panel for the bot, served by the same process.
//
// Why node:http and not Express: this container's whole job is to idle until a
// cron tick. Express plus its dependency tree is roughly 2 MB of resident
// memory and ~50 modules to keep patched, in exchange for routing sugar that
// three dozen lines cover here. The server holds no per-request state and no
// session store; the only long-lived allocation is a small cache of the static
// files, read once on first request.

const ASSET_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MAX_BODY_BYTES = 256 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8'
};

// Read-once cache. In a running container these files never change, so the
// alternative is a disk hit on every page load for no benefit.
//
// Off outside production, because the first thing anyone customising this panel
// does is edit app.css and reload -- and a cache that survives the edit makes it
// look like the change did nothing. `npm run web` therefore picks up edits on
// refresh, while the shipped container still reads each file exactly once.
const CACHE_ASSETS = process.env.NODE_ENV === 'production';
const assetCache = new Map();

function readAsset(name) {
  if (CACHE_ASSETS && assetCache.has(name)) return assetCache.get(name);
  const full = path.join(ASSET_DIR, name);
  // Defence in depth: nothing builds `name` from user input today, and this
  // makes sure that stays true if a future route does.
  if (!full.startsWith(ASSET_DIR + path.sep)) return null;
  let entry;
  try {
    entry = { body: fs.readFileSync(full), type: MIME[path.extname(name)] || 'application/octet-stream' };
  } catch {
    // Cache the miss too, so a typo'd route cannot turn into a stat() per hit.
    entry = null;
  }
  if (CACHE_ASSETS) assetCache.set(name, entry);
  return entry;
}

// -------------------------------------------------------------
// ACCESS CONTROL
// -------------------------------------------------------------
//
// There is no password. The control panel is gated on the request coming from
// a private address instead, because that is the deployment this is built for:
// a box on your LAN, reachable from your own machines and nothing else.
//
// This matters more than it looks. A container that listens on 0.0.0.0 is one
// careless port-forward or one UPnP-happy router away from being on the open
// internet, and the panel can rewrite the whole schedule. The address check
// means that in that scenario the admin routes still refuse to answer, while
// the public read-only page keeps working -- which is exactly what you want,
// since that page is meant to be proxied to the internet on purpose.
//
// Set WEB_ALLOW_REMOTE=true only if you are putting your own authentication in
// front of this (an authenticated reverse proxy, a VPN, an SSO gateway).

const PRIVATE_V4 = [
  [10, 0, 0, 0, 8],
  [127, 0, 0, 0, 8],
  [169, 254, 0, 0, 16],
  [172, 16, 0, 0, 12],
  [192, 168, 0, 0, 16]
];

export function isPrivateAddress(address) {
  if (!address) return false;
  let addr = String(address).trim().toLowerCase();

  // Node reports IPv4 clients on a dual-stack socket as ::ffff:192.168.1.5
  if (addr.startsWith('::ffff:')) addr = addr.slice(7);
  if (addr === '::1') return true;

  if (/^[0-9.]+$/.test(addr)) {
    const octets = addr.split('.').map(Number);
    if (octets.length !== 4 || octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    const value = ((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3];
    return PRIVATE_V4.some(([a, b, c, d, bits]) => {
      const base = ((a << 24) >>> 0) + (b << 16) + (c << 8) + d;
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      return (value & mask) === (base & mask);
    });
  }

  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10)
  return /^f[cd]/.test(addr) || /^fe[89ab]/.test(addr);
}

function adminAllowed(req) {
  if (String(process.env.WEB_ALLOW_REMOTE).toLowerCase() === 'true') return true;
  return isPrivateAddress(req.socket.remoteAddress);
}

// -------------------------------------------------------------
// PLUMBING
// -------------------------------------------------------------

function send(res, status, type, body, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    // The panel loads no off-origin *code*, so lock that down rather than
    // leaving a schedule editor open to an injected script. Images are the one
    // exception: member avatars are served from BGG's CDN, and proxying them
    // would mean a cache directory to maintain for the sake of four thumbnails.
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://cf.geekdo-images.com https://cf.geekdo-static.com",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...extraHeaders
  });
  res.end(body);
}

function sendJson(res, status, payload) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(payload));
}

function sendAsset(res, name, status = 200) {
  const asset = readAsset(name);
  if (!asset) return send(res, 404, 'text/plain; charset=utf-8', 'Not found');
  return send(res, status, asset.type, asset.body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Request body was not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

// -------------------------------------------------------------
// ROUTING
// -------------------------------------------------------------

async function route(req, res, deps) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  if (pathname === '/healthz') {
    return sendJson(res, 200, { ok: true });
  }

  // --- public, unauthenticated, safe to proxy to the internet ---
  //
  // The snapshot route matches on the suffix so it answers whether or not the
  // reverse proxy in front of it rewrites the path prefix. Getting that wrong
  // is the classic way a proxied page ends up showing an empty table.
  if (req.method === 'GET' && pathname.endsWith('/schedule.json')) {
    return send(res, 200, 'application/json; charset=utf-8',
      JSON.stringify(buildPublicSnapshot(), null, 2),
      { 'Cache-Control': 'public, max-age=60' });
  }
  if (req.method === 'GET' && (pathname === '/public' || pathname.endsWith('/public/index.html'))) {
    return sendAsset(res, 'public.html');
  }
  // Matched on the suffix for the same reason the snapshot is: the public page
  // is the one thing here meant to sit behind a reverse proxy, and its script
  // has to load whether or not the proxy rewrites the path prefix.
  if (req.method === 'GET' && pathname.endsWith('/public.js')) {
    return sendAsset(res, 'public.js');
  }

  // --- everything below is the control panel ---
  if (!adminAllowed(req)) {
    return sendJson(res, 403, {
      error: 'The control panel only answers requests from a private network address.'
    });
  }

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    return sendAsset(res, 'admin.html');
  }
  // search.js is imported by app.js as an ES module, and imported again by the
  // Discord command layer, so both surfaces rank search results identically.
  if (req.method === 'GET' &&
      (pathname === '/app.css' || pathname === '/app.js' || pathname === '/search.js')) {
    return sendAsset(res, pathname.slice(1));
  }

  if (pathname === '/api' || pathname.startsWith('/api/')) {
    let body = {};
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      try {
        body = await readBody(req);
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
    const result = await handleApi({
      method: req.method,
      segments: pathname.split('/').filter(Boolean).slice(1),
      body,
      deps
    });
    return sendJson(res, result.status, result.payload);
  }

  return send(res, 404, 'text/plain; charset=utf-8', 'Not found');
}

// -------------------------------------------------------------
// LIFECYCLE
// -------------------------------------------------------------

export function startWebServer(deps = {}) {
  const port = Number(process.env.WEB_PORT ?? 8120);
  if (!port) {
    console.log('🌐 Web control panel disabled (WEB_PORT=0).');
    return null;
  }

  // 0.0.0.0 inside the container is not the same thing as exposing it: Docker
  // publishes nothing you did not ask it to. Binding to loopback instead would
  // make the panel unreachable even from the machine running the container,
  // because the container's loopback is its own.
  const host = process.env.WEB_HOST || '0.0.0.0';

  const server = http.createServer((req, res) => {
    route(req, res, deps).catch(err => {
      console.error('Web request failed:', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error.' });
      else res.end();
    });
  });

  // An idle keep-alive socket per browser tab is free; a slow-loris one is not.
  server.headersTimeout = 10000;
  server.requestTimeout = 30000;
  server.keepAliveTimeout = 5000;

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.error(`❌ Web control panel could not start: port ${port} is already in use.`);
      console.error('   Set WEB_PORT to a free port, or WEB_PORT=0 to turn the panel off.');
    } else {
      console.error('❌ Web control panel error:', err.message);
    }
  });

  server.listen(port, host, () => {
    console.log(`🌐 Web control panel listening on http://${host}:${port}`);
    console.log(`   • Control panel: http://localhost:${port}/`);
    console.log(`   • Public page:   http://localhost:${port}/public`);
    if (String(process.env.WEB_ALLOW_REMOTE).toLowerCase() === 'true') {
      console.warn('   ⚠️  WEB_ALLOW_REMOTE=true: the panel answers any address. Put auth in front of it.');
    }
  });

  return server;
}

export function stopWebServer(server) {
  if (!server) return;
  server.closeAllConnections?.();
  server.close();
}
