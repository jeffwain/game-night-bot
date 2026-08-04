import { DEFAULT_TIMEZONE } from './constants.js';

// Pure time helpers. This module intentionally imports nothing from the
// project so that database.js / config.js can depend on it without cycles.

export const DEFAULT_REMINDER_TIME = { hour: 9, minute: 0 };

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
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Today's calendar date in the given IANA zone, as YYYY-MM-DD.
// en-CA formats as YYYY-MM-DD, which is exactly the shape the DB stores.
export function dateStringInZone(timezone, date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
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
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date);

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
