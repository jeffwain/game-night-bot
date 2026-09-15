/* Log plays on BoardGameGeek as a signed-in user.
 *
 * XML API2 (BGG_APP_TOKEN) is read-only. Posting a play goes through the
 * website: login/api/v1 for a session, then POST /geekplay.php. The password
 * lives in settings, never in the environment, and must never appear in
 * thrown errors.
 */

const BGG_ORIGIN = 'https://boardgamegeek.com';

function redact(text, secret) {
  const value = String(text ?? '');
  if (!secret) return value;
  return value.split(secret).join('[redacted]');
}

function cookieHeader(headers) {
  const list = typeof headers?.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [];
  return (list || [])
    .map(raw => String(raw).split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

export async function loginBgg(username, password, {
  fetchImpl = globalThis.fetch
} = {}) {
  const user = String(username || '').trim();
  const pass = String(password || '');
  if (!user || !pass) throw new Error('BGG username and password are required to log a play.');

  let res;
  try {
    res = await fetchImpl(`${BGG_ORIGIN}/login/api/v1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ credentials: { username: user, password: pass } })
    });
  } catch (err) {
    throw new Error(redact(err.message || 'BGG login failed', pass), { cause: err });
  }

  const body = await res.text();
  if (!res.ok) {
    throw new Error(redact(
      `BGG login failed (${res.status}). ${body}`.trim(),
      pass
    ));
  }

  const cookies = cookieHeader(res.headers);
  if (!/SessionID=/i.test(cookies)) {
    throw new Error('BGG login did not return a session. Check the username and password in Settings.');
  }
  return cookies;
}

export async function logPlay(session, payload, {
  fetchImpl = globalThis.fetch
} = {}) {
  const cookie = String(session || '').trim();
  if (!cookie) throw new Error('No BGG session; log in before posting a play.');

  let res;
  try {
    res = await fetchImpl(`${BGG_ORIGIN}/geekplay.php`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        Accept: 'application/json',
        cookie
      },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    throw new Error(err.message || 'BGG play post failed', { cause: err });
  }

  const body = await res.text();
  if (!res.ok) {
    throw new Error(`BGG play post failed (${res.status}). ${body}`.trim());
  }
  return body;
}

export async function logPlays(credentials, payloads, {
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
  delayMs = 5000
} = {}) {
  const session = await loginBgg(credentials.username, credentials.password, { fetchImpl });
  const results = [];
  for (let i = 0; i < payloads.length; i += 1) {
    if (i > 0 && delayMs > 0) await sleep(delayMs);
    try {
      await logPlay(session, payloads[i], { fetchImpl });
      results.push({ ok: true, objectid: payloads[i].objectid });
    } catch (err) {
      results.push({
        ok: false,
        objectid: payloads[i].objectid,
        error: redact(err.message, credentials.password)
      });
    }
  }
  return results;
}
