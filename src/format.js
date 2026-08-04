// Presentation helpers: date parsing, embed wording, and Discord size limits.
//
// This module is a leaf. It imports nothing from ./commands/ or ./dmCheck.js,
// which is the point -- both of those need these helpers, and when they lived
// in commands.js the result was a circular dependency that dmCheck.js and
// commands.js were both working around with `await import()`.

import { EmbedBuilder } from 'discord.js';
import { today } from './config.js';

// Format a YYYY-MM-DD string as e.g. "Tue 6/2".
export function formatDateBeautiful(dateStr) {
  try {
    const [year, month, day] = dateStr.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    const options = { weekday: 'short', month: 'numeric', day: 'numeric' };
    return date.toLocaleDateString('en-US', options);
  } catch {
    return dateStr;
  }
}

// Ping the player if we know their Discord account, otherwise bold their name.
// Takes a schedule entry (playerDiscordId / playerName), not a player row.
export function mentionFor(entry) {
  return entry.playerDiscordId ? `<@${entry.playerDiscordId}>` : `**${entry.playerName}**`;
}

export function formatSwapAnnouncement(entry1, entry2) {
  const p1Mention = mentionFor(entry1);
  const p2Mention = mentionFor(entry2);
  const date1 = formatDateBeautiful(entry1.game_date);
  const date2 = formatDateBeautiful(entry2.game_date);
  return `${p1Mention} and ${p2Mention} swapped dates. ${p2Mention} hosts **${date1}**; ${p1Mention} hosts **${date2}**.`;
}

// "a week" reads better than "7 days", but the rotation interval is measured
// from the actual schedule and is not always 7.
export function intervalLabel(days) {
  if (days === 7) return 'a week';
  if (days === 14) return 'two weeks';
  return `${days} days`;
}

// Shared wording for every path that cancels a night and slides the rotation.
// `reason` is a full sentence explaining why the night is off.
export function buildPostponeEmbed(result, reason) {
  const host = mentionFor(result.skipped);
  const tail = result.shiftedCount > 0
    ? ` Everyone after moves back ${intervalLabel(result.intervalDays)} too — see \`/schedule\`.`
    : '';

  return new EmbedBuilder()
    .setTitle('Game night postponed')
    .setColor(0xF39C12)
    .setDescription(
      `${reason} Nobody loses their turn: ${host} still hosts next, now on ` +
      `**${formatDateBeautiful(result.rescheduled.game_date)}**.${tail}`
    )
    .setTimestamp();
}

export function formatClaimAnnouncement(result) {
  const claimer = mentionFor(result.claimed);
  const original = mentionFor(result.handedOff);
  return `${claimer} is taking **${formatDateBeautiful(result.claimed.game_date)}**. ` +
         `${original} moves to **${formatDateBeautiful(result.handedOff.game_date)}**.`;
}

export function formatGameNightOutcome(hostMention, gameDate, status) {
  const date = formatDateBeautiful(gameDate);
  if (status === 'completed') {
    return `${hostMention} hosted game night on **${date}**.`;
  }
  return `No game night on **${date}** — ${hostMention} skipped or rescheduled.`;
}

// Robustly parse and normalize various date input formats into YYYY-MM-DD.
export function parseAndNormalizeDate(inputStr) {
  if (!inputStr) return null;
  const normalized = inputStr.trim().replace(/\//g, '-');

  // Resolved in the bot's configured timezone, not the container's.
  if (normalized.toLowerCase() === 'today') return today(0);
  if (normalized.toLowerCase() === 'tomorrow') return today(1);

  // Try YYYY-MM-DD or YYYY-M-D
  let match = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) {
    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    const day = parseInt(match[3], 10);
    const date = new Date(year, month - 1, day);
    if (!isNaN(date.getTime()) && date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // Try MM-DD-YYYY or M-D-YYYY
  match = normalized.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (match) {
    const month = parseInt(match[1], 10);
    const day = parseInt(match[2], 10);
    const year = parseInt(match[3], 10);
    const date = new Date(year, month - 1, day);
    if (!isNaN(date.getTime()) && date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // Try M-D / MM-DD with no year (e.g. "8/11") — default to the current year.
  // Without this the fallback hands "8/11" to new Date(), which fills in a
  // bogus default year (V8 uses 2001).
  match = normalized.match(/^(\d{1,2})-(\d{1,2})$/);
  if (match) {
    const month = parseInt(match[1], 10);
    const day = parseInt(match[2], 10);
    const todayIso = today(0);
    let year = Number(todayIso.slice(0, 4));
    const date = new Date(year, month - 1, day);
    if (!isNaN(date.getTime()) && date.getMonth() === month - 1 && date.getDate() === day) {
      // Roll forward: if that month/day already passed this year, assume next year.
      const candidateIso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      if (candidateIso < todayIso) {
        year += 1;
        const rolled = new Date(year, month - 1, day);
        if (isNaN(rolled.getTime()) || rolled.getMonth() !== month - 1 || rolled.getDate() !== day) {
          return null;
        }
      }
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // If the input LOOKS like one of the numeric shapes above but failed
  // validation, it is simply not a real date -- stop here. Falling through to
  // `new Date()` would silently roll it over, so "2026-02-30" became March 1st
  // and got scheduled without complaint.
  const numericShapes = [
    /^\d{4}-\d{1,2}-\d{1,2}$/,
    /^\d{1,2}-\d{1,2}-\d{4}$/,
    /^\d{1,2}-\d{1,2}$/
  ];
  if (numericShapes.some(re => re.test(normalized))) return null;

  // Fallback for written-out forms like "August 11, 2026".
  const genericDate = new Date(inputStr);
  if (!isNaN(genericDate.getTime())) {
    const year = genericDate.getFullYear();
    const month = String(genericDate.getMonth() + 1).padStart(2, '0');
    const day = String(genericDate.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  return null;
}

// -------------------------------------------------------------
// EMBED SIZE LIMITS
//
// Discord rejects an embed field whose value exceeds 1024 characters, and
// allows at most 25 fields. A rotation line runs ~47 characters, so a single
// field held roughly 22 players before the API started erroring -- invisible
// with a group of four, immediate for a group of thirty.
// -------------------------------------------------------------

const FIELD_VALUE_LIMIT = 1024;
const MAX_FIELDS = 25;

// Exported: dmCheck.js slices its select-menu option lists to this.
export const SELECT_MENU_LIMIT = 25;

export function chunkToFields(name, lines, emptyText = 'None.') {
  if (lines.length === 0) return [{ name, value: emptyText }];

  const safe = lines.map(l =>
    l.length > FIELD_VALUE_LIMIT ? `${l.slice(0, FIELD_VALUE_LIMIT - 1)}…` : l
  );

  const fields = [];
  let buffer = [];
  let length = 0;

  const flush = () => {
    if (buffer.length === 0) return;
    fields.push({
      name: fields.length === 0 ? name : `${name} (continued)`,
      value: buffer.join('\n')
    });
    buffer = [];
    length = 0;
  };

  for (const line of safe) {
    if (length + line.length + 1 > FIELD_VALUE_LIMIT) flush();
    buffer.push(line);
    length += line.length + 1;
  }
  flush();

  if (fields.length > MAX_FIELDS) {
    const kept = fields.slice(0, MAX_FIELDS - 1);
    const dropped = fields.length - kept.length;
    kept.push({
      name: `${name} (truncated)`,
      value: `…and ${dropped} more section(s).`
    });
    return kept;
  }
  return fields;
}

// Select menus hard-cap at 25 options. Say so rather than silently dropping
// entries off the end of the list.
export function truncationNote(total, shown = SELECT_MENU_LIMIT) {
  return total > shown ? `\n\n*Showing the first ${shown} of ${total}.*` : '';
}
