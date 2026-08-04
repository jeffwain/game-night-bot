// Open host calls: posting a night to the channel when its host bows out, and
// retiring that post once the night is settled.
//
// Shared by ./scanners.js (which times unclaimed nights out) and
// ./interactions.js (which posts the call and handles claims).

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import * as db from './database.js';
import { formatDateBeautiful, mentionFor, intervalLabel } from './format.js';
import { cid } from './customId.js';

// -------------------------------------------------------------
// OPEN HOST CALLS
//
// A host who bows out does not get swapped with the next person in line --
// that quietly stole someone else's turn. Instead the night is offered to the
// channel. A volunteer is a straight date trade. If the deadline passes with
// nobody claiming it, the night is called off and the rotation postpones.
// -------------------------------------------------------------

// How close to game day an open night can sit before it is written off. One
// day, so the call-off lands before the "game night is tomorrow" summary.
export const CLAIM_DEADLINE_DAYS_BEFORE = 1;

function buildClaimCallMessage(game) {
  const hostMention = mentionFor(game);
  const shift = intervalLabel(Math.max(1, db.getRotationIntervalDays()));

  const embed = new EmbedBuilder()
    .setTitle('Host needed')
    .setColor(0xF39C12)
    .setDescription(
      `${hostMention} can't host on **${formatDateBeautiful(game.game_date)}**.\n\n` +
      `Can anyone take it? Whoever claims it trades dates with ${hostMention} — ` +
      `you host **${formatDateBeautiful(game.game_date)}**, they take your night.\n\n` +
      `If nobody claims it by the day before, game night is off that week and the ` +
      `whole schedule moves back ${shift}.`
    )
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(cid('claim', 'take', game.id))
      .setLabel("I'll host it")
      .setStyle(ButtonStyle.Success)
  );

  return { embeds: [embed], components: [row] };
}

export async function postClaimCall(client, game) {
  const channelId = db.getSettings().announcementsChannel;
  if (!channelId) return null;

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) return null;

    const message = await channel.send(buildClaimCallMessage(game));
    db.setClaimMessage(game.id, channel.id, message.id);
    return message;
  } catch (err) {
    console.error('Failed to post the open-host call:', err.message);
    return null;
  }
}

// Retire a claim call once the night is settled, so the button stops inviting
// clicks that can only fail.
export async function closeClaimCall(client, channelId, messageId, embed) {
  if (!channelId || !messageId) return;
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) return;
    const message = await channel.messages.fetch(messageId);
    await message.edit({ embeds: [embed], components: [] });
  } catch (err) {
    console.error('Failed to close the open-host call:', err.message);
  }
}
