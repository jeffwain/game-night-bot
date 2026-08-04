import { getSettings } from './database.js';
import {
  DEFAULT_REMINDER_TIME,
  parseReminderTime,
  isValidTimezone,
  dateStringInZone,
  addDaysIso,
  zonedHourMinute
} from './time.js';
import { DEFAULT_TIMEZONE } from './constants.js';

// The single authority for "what timezone is this bot operating in".
//
// Precedence: db settings.timezone (set via /config) > TZ env var > default.
// Everything that computes a date or gates on wall-clock time must go through
// here. Previously date strings came from the container TZ while the reminder
// window came from settings.timezone, so the two could disagree.
function resolveTimezone() {
  const candidate = getSettings().timezone || process.env.TZ || DEFAULT_TIMEZONE;
  if (!isValidTimezone(candidate)) {
    console.warn(`Invalid timezone "${candidate}"; falling back to ${DEFAULT_TIMEZONE}.`);
    return DEFAULT_TIMEZONE;
  }
  return candidate;
}

// Resolve the effective cron config from db settings, applying fallbacks.
export function resolveReminderConfig() {
  const settings = getSettings();

  const parsed = parseReminderTime(settings.reminderTime);
  const time = parsed || DEFAULT_REMINDER_TIME;
  if (settings.reminderTime && !parsed) {
    console.warn(`Invalid reminderTime "${settings.reminderTime}" in settings; using default ${DEFAULT_REMINDER_TIME.hour}:00.`);
  }

  const timezone = resolveTimezone();

  // node-cron pattern: "minute hour * * *"
  const expression = `${time.minute} ${time.hour} * * *`;
  const timeLabel = `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`;

  return { expression, timezone, timeLabel, time };
}

// Today's date (YYYY-MM-DD) in the bot's configured timezone, optionally
// offset by whole calendar days. Replaces the old getLocalDateString /
// getFutureLocalDateString pair, which read the container TZ instead.
export function today(daysAhead = 0) {
  const iso = dateStringInZone(resolveTimezone());
  return daysAhead === 0 ? iso : addDaysIso(iso, daysAhead);
}

// True when the current local time (in the configured timezone) is at or past
// the daily reminder time. Used to gate hourly scans so user-facing posts/DMs
// never go out before reminderTime (e.g. on midnight date rollovers).
export function isReminderWindowOpen(date = new Date()) {
  const { timezone, time } = resolveReminderConfig();
  const now = zonedHourMinute(timezone, date);
  const nowMinutes = now.hour * 60 + now.minute;
  const reminderMinutes = time.hour * 60 + time.minute;
  return nowMinutes >= reminderMinutes;
}

export { parseReminderTime, isValidTimezone, addDaysIso };
