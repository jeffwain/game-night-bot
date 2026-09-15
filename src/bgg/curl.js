/* Parses a "Copy as cURL" command into the pieces needed to replay it.
 *
 * Why this exists rather than a tidy set of URL/token/body fields: the
 * Geekgroup collection call is an undocumented POST whose JSON body runs to
 * several kilobytes of filters, sorts and group context, and whose auth is an
 * Authorization header *plus* session cookies. Every attempt to reconstruct
 * that by hand got a 200 carrying somebody else's collection, because the API
 * answers an unauthenticated request with a default public group instead of an
 * error. Copying the whole request out of the browser removes the guesswork:
 * whatever the site sends, we send.
 *
 * Handles both flavours the browsers offer -- POSIX single-quoted and Windows
 * cmd double-quoted with ^ escapes.
 */

// Header names that must not be replayed: they describe the browser's own
// connection, and copying them either breaks the request or lies about it.
const DROP_HEADERS = new Set([
  'host', 'content-length', 'connection', 'accept-encoding',
  'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'sec-ch-ua',
  'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'te', 'upgrade-insecure-requests'
]);

// Shell-ish tokenizer. Not a shell -- just enough to split a copied command
// into arguments without tripping over a JSON body full of quotes and braces.
function tokenize(input) {
  const text = String(input)
    // Line continuations, both shells.
    .replace(/\\\r?\n/g, ' ')
    .replace(/\^\r?\n/g, ' ')
    .trim();

  const args = [];
  let current = '';
  let started = false;
  let i = 0;

  const push = () => { if (started) { args.push(current); current = ''; started = false; } };

  while (i < text.length) {
    const c = text[i];

    if (c === "'") {
      started = true;
      i += 1;
      while (i < text.length && text[i] !== "'") { current += text[i]; i += 1; }
      i += 1;
      continue;
    }

    if (c === '"') {
      started = true;
      i += 1;
      while (i < text.length && text[i] !== '"') {
        // Inside double quotes both shells let a backslash escape the next char.
        if (text[i] === '\\' && i + 1 < text.length) { current += text[i + 1]; i += 2; continue; }
        current += text[i];
        i += 1;
      }
      i += 1;
      continue;
    }

    if (/\s/.test(c)) { push(); i += 1; continue; }

    // cmd.exe escapes with ^; strip it and take the next character literally.
    if (c === '^' && i + 1 < text.length) { started = true; current += text[i + 1]; i += 2; continue; }
    if (c === '\\' && i + 1 < text.length && /\s/.test(text[i + 1])) { started = true; current += text[i + 1]; i += 2; continue; }

    started = true;
    current += c;
    i += 1;
  }
  push();
  return args;
}

const BODY_FLAGS = new Set(['-d', '--data', '--data-raw', '--data-binary', '--data-ascii']);
const VALUE_FLAGS = new Set(['-H', '--header', '-X', '--request', '-b', '--cookie', '--url', '-A', '--user-agent', '-e', '--referer', ...BODY_FLAGS]);

/**
 * @param {string} command a copied cURL command
 * @returns {{url: string, method: string, headers: object, body: string|null}}
 */
export function parseCurl(command) {
  const args = tokenize(command);
  if (!args.length || !/curl(\.exe)?$/i.test(args[0])) {
    throw new Error('That does not look like a copied cURL command (it should start with "curl").');
  }

  const headers = {};
  let url = '';
  let method = '';
  let body = null;

  const setHeader = (name, value) => {
    const key = String(name).trim();
    if (!key || DROP_HEADERS.has(key.toLowerCase())) return;
    headers[key] = String(value).trim();
  };

  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];

    if (VALUE_FLAGS.has(arg)) {
      const value = args[i + 1] ?? '';
      i += 1;
      if (arg === '-H' || arg === '--header') {
        const at = value.indexOf(':');
        if (at > 0) setHeader(value.slice(0, at), value.slice(at + 1));
      } else if (arg === '-X' || arg === '--request') {
        method = value.toUpperCase();
      } else if (arg === '-b' || arg === '--cookie') {
        setHeader('Cookie', value);
      } else if (arg === '--url') {
        url = value;
      } else if (arg === '-A' || arg === '--user-agent') {
        setHeader('User-Agent', value);
      } else if (arg === '-e' || arg === '--referer') {
        setHeader('Referer', value);
      } else if (BODY_FLAGS.has(arg)) {
        body = value;
      }
      continue;
    }

    // Flags we deliberately ignore (--compressed, --insecure, -s ...) and the
    // bare URL, which is the only positional argument cURL takes.
    if (arg.startsWith('-')) continue;
    if (!url) url = arg;
  }

  if (!url) throw new Error('No URL found in that cURL command.');
  if (!/^https?:\/\//i.test(url)) throw new Error(`That cURL command's URL is not http(s): ${url}`);

  return {
    url,
    method: method || (body === null ? 'GET' : 'POST'),
    headers,
    body
  };
}

// Cookies and Authorization are the whole point of the capture, and also the
// parts that must never be echoed back to a browser. Everything else is safe
// to show so the panel can prove what it stored.
const SECRET_HEADERS = new Set(['authorization', 'cookie']);

export function describeRequest(request) {
  if (!request?.url) return null;
  let host = request.url;
  try { host = new URL(request.url).host; } catch { /* show the raw string */ }

  return {
    host,
    method: request.method,
    headers: Object.keys(request.headers || {}).sort(),
    secrets: Object.keys(request.headers || {})
      .filter(h => SECRET_HEADERS.has(h.toLowerCase()))
      .sort(),
    bodyBytes: request.body ? Buffer.byteLength(request.body, 'utf-8') : 0
  };
}
