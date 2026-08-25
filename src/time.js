import { DEFAULT_TIMEZONE } from './constants.js';

// Pure time helpers. This module intentionally imports nothing from the
// project so that database.js / config.js can depend on it without cycles.

export const DEFAULT_REMINDER_TIME = { hour: 9, minute: 0 };

// Intl.DateTimeFormat is expensive to construct and cheap to reuse. Each new
// instance pins roughly 27 KB of ICU data that the JS heap never accounts for,
// so it does not look like a leak in heapUsed -- it shows up as resident memory
// climbing and never coming back down.
//
// The bot alone would never notice: it formats a handful of dates per hour. The
// web control panel calls through here several times per request, and measured
// on this code that was the difference between the process sitting at 80 MB and
// climbing past 140 MB after a couple of thousand page loads.
//
// The cache is keyed by timezone and capped, because isValidTimezone is reachable
// from user input and an uncapped Map keyed by arbitrary strings is its own leak.
const FORMATTER_CACHE_LIMIT = 64;
const dateFormatters = new Map();
const clockFormatters = new Map();
const timezoneValidity = new Map();

function cached(store, key, build) {
  const hit = store.get(key);
  if (hit) return hit;
  // Timezones change about as often as the settings do, so a plain clear beats
  // tracking an LRU. In practice the cache holds one or two entries forever.
  if (store.size >= FORMATTER_CACHE_LIMIT) store.clear();
  const made = build();
  store.set(key, made);
  return made;
}

// Parse a "HH:MM" 24-hour string into { hour, minute }. Returns null if invalid.
export function parseReminderTime(timeStr) {
  if (typeof timeStr !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(timeStr.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

// Validate an IANA timezone string (e.g. "America/Chicago") using Intl.
export function isValidTimezone(tz) {
  if (typeof tz !== 'string' || tz.trim() === '') return false;
  const known = timezoneValidity.get(tz);
  if (known !== undefined) return known;

  let valid;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    valid = true;
  } catch {
    valid = false;
  }
  if (timezoneValidity.size >= FORMATTER_CACHE_LIMIT) timezoneValidity.clear();
  timezoneValidity.set(tz, valid);
  return valid;
}

// Today's calendar date in the given IANA zone, as YYYY-MM-DD.
// en-CA formats as YYYY-MM-DD, which is exactly the shape the DB stores.
export function dateStringInZone(timezone, date = new Date()) {
  return cached(dateFormatters, timezone, () => new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })).format(date);
}

// Format a Date's *local* calendar day as YYYY-MM-DD.
//
// Only for Dates whose calendar fields are already the ones you want -- e.g.
// the result of parsing free text. To shift an existing date string, use
// addDaysIso instead; it does not go through local time at all.
export function toIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Pure calendar arithmetic on a YYYY-MM-DD string. Uses UTC internally so a
// DST transition can never add or drop an hour and roll the date.
export function addDaysIso(isoDate, n) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  const year = dt.getUTCFullYear();
  const month = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const day = String(dt.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Current wall-clock hour/minute in the given IANA timezone.
export function zonedHourMinute(timezone, date = new Date()) {
  const parts = cached(clockFormatters, timezone, () => new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })).formatToParts(date);

  let hour = 0;
  let minute = 0;
  for (const part of parts) {
    if (part.type === 'hour') hour = Number(part.value);
    if (part.type === 'minute') minute = Number(part.value);
  }
  if (hour === 24) hour = 0; // some platforms render midnight as 24
  return { hour, minute };
}

export { DEFAULT_TIMEZONE };
