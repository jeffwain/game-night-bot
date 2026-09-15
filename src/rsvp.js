// RSVP tallying and the self-updating RSVP embed.
//
// Split out of dmCheck.js: the reminder scanner posts this embed and the RSVP
// buttons re-render it, so it belongs to neither of them exclusively.

import { EmbedBuilder } from 'discord.js';
import { getActivePlayers } from './database.js';
import { formatDateBeautiful, mentionFor } from './format.js';

function splitRsvps(rsvps) {
  const going = [];
  const tentative = [];
  const out = [];
  for (const [userId, status] of Object.entries(rsvps || {})) {
    const mention = `<@${userId}>`;
    if (status === 'going') going.push(mention);
    else if (status === 'tentative') tentative.push(mention);
    else if (status === 'out') out.push(mention);
  }
  return { going, tentative, out };
}
function formatMentionList(mentions) {
  if (mentions.length === 0) return '';
  if (mentions.length === 1) return mentions[0];
  if (mentions.length === 2) return `${mentions[0]} and ${mentions[1]}`;
  return `${mentions.slice(0, -1).join(', ')}, and ${mentions[mentions.length - 1]}`;
}
function formatMentionGroup(mentions, singular, plural) {
  if (mentions.length === 0) return '';
  if (mentions.length === 1) return `${mentions[0]} ${singular}`;
  return `${formatMentionList(mentions)} ${plural}`;
}

// Active rotation members with a linked Discord account — the people the RSVP
// post is really asking. Anyone else in the channel can still click a button,
// but "Everyone's in" waits on this list.
export function rosterDiscordIdsForRsvp() {
  return getActivePlayers()
    .map(p => p.discord_id)
    .filter(Boolean)
    .map(String);
}

function pendingRosterMentions(rsvps, expectedDiscordIds) {
  if (!expectedDiscordIds?.length) return [];
  const map = rsvps || {};
  return expectedDiscordIds
    .filter(id => !(id in map))
    .map(id => `<@${id}>`);
}

function appendStillWaiting(text, pending) {
  if (!pending.length) return text;
  const clause = `Still waiting on ${formatMentionList(pending)}.`;
  if (!text) return clause;
  return text.endsWith('.') ? `${text.slice(0, -1)}; ${clause}` : `${text}. ${clause}`;
}

export function formatRsvpSummaryText(rsvps, expectedDiscordIds = null) {
  const { going, tentative, out } = splitRsvps(rsvps);
  const pending = pendingRosterMentions(rsvps, expectedDiscordIds);
  const responded = going.length + tentative.length + out.length;

  if (responded === 0) {
    if (pending.length > 0) {
      return `No replies yet. Still waiting on ${formatMentionList(pending)}.`;
    }
    return 'No RSVPs yet.';
  }

  if (tentative.length === 0 && out.length === 0) {
    if (pending.length === 0) return "Everyone's in.";
    const inSoFar = formatMentionGroup(going, 'is in', 'are in');
    return appendStillWaiting(`${inSoFar}.`, pending);
  }

  let summary;
  if (going.length === 0 && tentative.length === 0) {
    summary = `${formatMentionGroup(out, 'is out', 'are out')}.`;
  } else if (going.length > 0 && going.length < out.length) {
    const parts = [`Only ${formatMentionGroup(going, 'is in', 'are in')}.`];
    if (tentative.length > 0) parts.push(`${formatMentionGroup(tentative, 'is a maybe', 'are maybes')}.`);
    summary = parts.join(' ');
  } else if (going.length === 0) {
    const parts = [];
    if (out.length > 0) parts.push(formatMentionGroup(out, 'is out', 'are out'));
    if (tentative.length > 0) parts.push(formatMentionGroup(tentative, 'is a maybe', 'are maybes'));
    summary = `${parts.join('. ')}.`;
  } else {
    const parts = [];
    if (out.length > 0) parts.push(formatMentionGroup(out, 'is out', 'are out'));
    if (tentative.length > 0) parts.push(formatMentionGroup(tentative, 'is a maybe', 'are maybes'));
    summary = `${parts.join('. ')}.`;
  }

  return appendStillWaiting(summary, pending);
}

// Helper to build the self-updating RSVP embed
export function buildRsvpEmbed(game) {
  const hostMention = mentionFor(game);
  const summaryText = formatRsvpSummaryText(game.rsvps, rosterDiscordIdsForRsvp());

  return new EmbedBuilder()
    .setTitle('Game Night RSVP')
    .setColor(0x34495E)
    .setDescription(`Host: ${hostMention}\nDate: **${formatDateBeautiful(game.game_date)}**\n\n${summaryText}`)
    .setTimestamp();
}
