// RSVP tallying and the self-updating RSVP embed.
//
// Split out of dmCheck.js: the reminder scanner posts this embed and the RSVP
// buttons re-render it, so it belongs to neither of them exclusively.

import { EmbedBuilder } from 'discord.js';
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
export function formatRsvpSummaryText(rsvps) {
  const { going, tentative, out } = splitRsvps(rsvps);
  const responded = going.length + tentative.length + out.length;
  if (responded === 0) return 'No RSVPs yet.';
  if (tentative.length === 0 && out.length === 0) return "Everyone's in.";
  if (going.length === 0 && tentative.length === 0) return `${formatMentionGroup(out, 'is out', 'are out')}.`;
  if (going.length > 0 && going.length < out.length) {
    const parts = [`Only ${formatMentionGroup(going, 'is in', 'are in')}.`];
    if (tentative.length > 0) parts.push(`${formatMentionGroup(tentative, 'is a maybe', 'are maybes')}.`);
    return parts.join(' ');
  }
  if (going.length === 0) {
    const parts = [];
    if (out.length > 0) parts.push(formatMentionGroup(out, 'is out', 'are out'));
    if (tentative.length > 0) parts.push(formatMentionGroup(tentative, 'is a maybe', 'are maybes'));
    return `${parts.join('. ')}.`;
  }
  const parts = [];
  if (out.length > 0) parts.push(formatMentionGroup(out, 'is out', 'are out'));
  if (tentative.length > 0) parts.push(formatMentionGroup(tentative, 'is a maybe', 'are maybes'));
  return `${parts.join('. ')}.`;
}
// Helper to build the self-updating RSVP embed
export function buildRsvpEmbed(game) {
  const hostMention = mentionFor(game);
  const summaryText = formatRsvpSummaryText(game.rsvps);

  return new EmbedBuilder()
    .setTitle('Game Night RSVP')
    .setColor(0x34495E)
    .setDescription(`Host: ${hostMention}\nDate: **${formatDateBeautiful(game.game_date)}**\n\n${summaryText}`)
    .setTimestamp();
}
