/* Fetches a Geekgroup collection, one page at a time.
 *
 * https://api.geekgroup.app/api/groups/collection.json answers without any
 * credentials -- but what it answers with, unauthenticated, is the site-wide
 * collection (ten thousand games, 214 pages) rather than your group.
 *
 * Scoping is by an `Authorization` header. Geekgroup's own front end keeps the
 * value in a browser cookie named `token` and copies it verbatim into that
 * header on every call -- no "Bearer " prefix, no query parameter. Verified
 * against their app bundle; a session hash passed as ?session=, or as any
 * cookie, is ignored.
 *
 * The trap: a missing, wrong or expired token does not produce a 401. The API
 * answers 200 with the public collection, so the only way to notice is that the
 * page count is far too high -- which is what ANON_PAGE_LIMIT is for. Without
 * that check a failed sync looks like a successful one that took twenty minutes
 * and filled data/ with somebody else's library.
 *
 * Uses global fetch (Node 20+). No HTTP dependency, and none wanted.
 */

// Our group is 13 pages. The anonymous firehose is 214.
const ANON_PAGE_LIMIT = 50;
const PAGE_DELAY_MS = 500;
const REQUEST_TIMEOUT_MS = 30000;
const MAX_PAGES = 500;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// The URL is configured by pasting it out of the browser network tab, so it
// arrives with whatever page parameter that request happened to use. Honour a
// {page} placeholder if the user marked one; otherwise set page= ourselves.
export function pageUrl(template, page) {
  const raw = String(template || '').trim();
  if (!raw) throw new Error('No collection URL is configured.');
  if (raw.includes('{page}')) return raw.replace(/\{page\}/g, String(page));

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Collection URL is not a valid URL: ${raw}`);
  }
  url.searchParams.set('page', String(page));
  return url.toString();
}

// The page number can live in the query string, in the JSON body, or both.
// Set it wherever it can be set rather than guessing which one this deployment
// reads -- an extra correct `page` never hurt anyone.
export function bodyForPage(body, page) {
  if (body === null || body === undefined) return null;
  const text = String(body);
  if (text.includes('{page}')) return text.replace(/\{page\}/g, String(page));

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return JSON.stringify({ ...parsed, page });
    }
  } catch {
    // Not JSON: replay it untouched rather than corrupting it.
  }
  return text;
}

async function fetchPage(url, { token = '', method = 'GET', headers = {}, body = null } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body !== null ? { 'Content-Type': 'application/json' } : {}),
      // A captured request brings its own Authorization and Cookie; the bare
      // token path is the fallback when there is no capture.
      ...(token ? { Authorization: token } : {}),
      ...headers
    },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });

  if (!res.ok) {
    throw new Error(`Collection request failed (${res.status} ${res.statusText}).`);
  }

  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    // A login redirect answers with HTML and a 200, which is worth naming
    // rather than reporting as a JSON syntax error at position 0.
    const looksLikeHtml = text.trimStart().startsWith('<');
    throw new Error(looksLikeHtml
      ? 'Collection URL returned a web page, not JSON. The token is probably expired.'
      : 'Collection URL returned a response that is not JSON.');
  }
}

/**
 * Fetch page one only, and report what came back.
 *
 * This exists because the API never says "no". A missing or expired token gets
 * a 200 and the public collection, so the only way to know your credentials
 * work is to look at the size of what you were handed and judge it.
 *
 * @returns {Promise<{ok: boolean, pages: number, total: number, members: string[]}>}
 */
export async function probeCollection({ url, token = '', method, headers, body } = {}) {
  const page = await fetchPage(pageUrl(url, 1), {
    token, method, headers, body: bodyForPage(body, 1)
  });
  const pages = Math.max(1, Number(page.pages) || 1);
  const total = Number(page.total) || 0;
  const members = (Array.isArray(page?.data?.users) ? page.data.users : [])
    .map(u => String(u.name || u.fullname || u.id));

  return { ok: pages <= ANON_PAGE_LIMIT, pages, total, members };
}

/**
 * Walk every page of the configured collection.
 *
 * @param {object}   opts
 * @param {string}   opts.url        URL template, optionally containing {page}
 * @param {string}   [opts.token]    Authorization header value scoping the request to your group
 * @param {function} [opts.onProgress] called as ({ page, pages }) after each page
 * @returns {Promise<object[]>} raw page bodies, in order
 */
export async function fetchAllPages({ url, token = '', method, headers, body = null, onProgress = () => {} } = {}) {
  const request = { token, method, headers };
  const first = await fetchPage(pageUrl(url, 1), { ...request, body: bodyForPage(body, 1) });
  const pages = Math.max(1, Number(first.pages) || 1);

  // Note this fires whether or not a token was sent: an expired one degrades to
  // exactly the same public response as none at all, so the page count is the
  // only evidence either way.
  if (pages > ANON_PAGE_LIMIT) {
    throw new Error(
      `That URL returned ${pages} pages, which is the whole public Geekgroup collection rather than yours. ` +
      (token
        ? 'The access token is probably expired — copy a fresh one from the token cookie on geekgroup.app.'
        : 'Add your Geekgroup access token in Settings so the request is scoped to your group.')
    );
  }
  if (pages > MAX_PAGES) {
    throw new Error(`Refusing to sync ${pages} pages; check the collection URL.`);
  }

  onProgress({ page: 1, pages });
  const bodies = [first];

  for (let page = 2; page <= pages; page += 1) {
    await sleep(PAGE_DELAY_MS);
    bodies.push(await fetchPage(pageUrl(url, page), { ...request, body: bodyForPage(body, page) }));
    onProgress({ page, pages });
  }

  return bodies;
}
