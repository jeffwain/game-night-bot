// The background scans. Each runs on a timer (see index.js and
// reminderScheduler.js) and is also invocable on demand via /admin scan.
//
// Every runner returns { scannedAt, foundCount, results } so /admin scan can
// report what it did without knowing anything about the individual scan.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import * as db from './database.js';
import { today } from './config.js';
import { formatDateBeautiful, buildPostponeEmbed } from './format.js';
import { announceToPublicChannel } from './announce.js';
import { cid } from './customId.js';
import { buildRsvpEmbed, formatRsvpSummaryText } from './rsvp.js';
import { CLAIM_DEADLINE_DAYS_BEFORE, closeClaimCall } from './hostCalls.js';

// Read by /admin status. `export let` is a live binding, so importers see each
// update rather than the value at import time.
export let lastDmCheckTime = null;

// 1. DM CHECK-IN RUNNER (POST-GAME NIGHT STATUS CHECKS)
export async function runDmCheck(client) {
  lastDmCheckTime = new Date();
  const todayStr = today();
  const pendingGames = db.getPendingUnnotifiedPastGames(todayStr);
  const results = [];

  for (const game of pendingGames) {
    const gameId = game.id;
    const playerName = game.playerName;
    const discordId = game.playerDiscordId;
    const gameDate = game.game_date;

    if (!discordId) {
      console.log(`Game ID ${gameId} for ${playerName} has no linked Discord account. Skipping DM.`);
      let announced = false;
      const channelId = db.getSettings().announcementsChannel;
      if (channelId) {
        try {
          const channel = await client.channels.fetch(channelId);
          if (channel && channel.isTextBased()) {
            const embed = new EmbedBuilder()
              .setTitle('Game Night Review Required')
              .setColor(0xF39C12)
              .setDescription(`**${playerName}**'s game night on **${formatDateBeautiful(gameDate)}** passed with no Discord link. Mark it with \`/update done player: ${playerName}\`.`)
              .setTimestamp();
            await channel.send({ embeds: [embed] });
            announced = true;
          }
        } catch (err) {
          console.error(`Failed to post public fallback notification for ${playerName}:`, err.message);
        }
      }

      db.markGameAsNotified(gameId);
      results.push({
        playerName,
        gameDate,
        status: 'unlinked',
        detail: announced ? 'Public channel reminder posted' : 'No channel set for fallback alert'
      });
      continue;
    }

    try {
      const user = await client.users.fetch(discordId);
      if (!user) {
        console.warn(`Could not find Discord user with ID ${discordId} for player ${playerName}`);
        results.push({
          playerName,
          gameDate,
          status: 'error',
          detail: `Discord account not found`
        });
        continue;
      }

      const embed = new EmbedBuilder()
        .setTitle('Host Check-in')
        .setColor(0x34495E)
        .setDescription(`Did you host game night on **${formatDateBeautiful(gameDate)}**?`)
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(cid('checkin', 'yes', gameId))
          .setLabel('Yes, I hosted')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(cid('checkin', 'skip', gameId))
          .setLabel('Skipped / Rescheduled')
          .setStyle(ButtonStyle.Danger)
      );

      await user.send({ embeds: [embed], components: [row] });
      console.log(`Successfully sent host check-in DM to ${playerName} (${user.tag}) for game date ${gameDate}`);

      db.markGameAsNotified(gameId);
      results.push({
        playerName,
        gameDate,
        status: 'dm_sent',
        detail: `DM sent to ${user.username}`
      });
    } catch (err) {
      console.error(`Failed to send DM to ${playerName} (ID: ${discordId}):`, err.message);
      let fallbackPosted = false;

      const channelId = db.getSettings().announcementsChannel;
      if (channelId) {
        try {
          const channel = await client.channels.fetch(channelId);
          if (channel && channel.isTextBased()) {
            const embed = new EmbedBuilder()
              .setTitle('Game Night Review Required')
              .setColor(0xF39C12)
              .setDescription(`Couldn't DM <@${discordId}> about **${formatDateBeautiful(gameDate)}**. Mark it with \`/update done player: ${playerName}\`.`)
              .setTimestamp();
            await channel.send({ embeds: [embed] });
            fallbackPosted = true;
          }
        } catch (postErr) {
          console.error(`Failed to post public fallback notification for blocked DM:`, postErr.message);
        }
      }
      db.markGameAsNotified(gameId);
      results.push({
        playerName,
        gameDate,
        status: 'dm_failed',
        detail: `DM blocked. ${fallbackPosted ? 'Public alert posted.' : 'No public channel configured.'}`
      });
    }
  }

  return {
    scannedAt: lastDmCheckTime,
    foundCount: pendingGames.length,
    results
  };
}

// 2. UPCOMING GAME NIGHT REMINDER SCANNER
// Checks for scheduled pending game nights exactly 3 days in the future, posts public RSVPs, DMs host
export async function runUpcomingReminderCheck(client) {
  const targetDate = today(3);
  const upcomingGames = db.getPendingUnremindedGamesForDate(targetDate);
  const results = [];

  for (const game of upcomingGames) {
    const gameId = game.id;
    const playerName = game.playerName;
    const discordId = game.playerDiscordId;
    const gameDate = game.game_date;

    const channelId = db.getSettings().announcementsChannel;
    let announced = false;

    // 0. Post plain-text notification to the notifications channel
    const notificationsChannelId = db.getSettings().notificationsChannel || channelId;
    if (notificationsChannelId) {
      try {
        const notifChannel = await client.channels.fetch(notificationsChannelId);
        if (notifChannel && notifChannel.isTextBased()) {
          const hostMention = discordId ? `<@${discordId}>` : `**${playerName}**`;
          await notifChannel.send(`🎲 **Game night reminder!** ${hostMention} is hosting on **${formatDateBeautiful(gameDate)}**.`);
        }
      } catch (err) {
        console.error(`Failed to post plain-text upcoming reminder:`, err.message);
      }
    }

    // 1. Post the public self-updating RSVP embed to the announcements channel
    if (channelId) {
      try {
        const channel = await client.channels.fetch(channelId);
        if (channel && channel.isTextBased()) {
          const embed = buildRsvpEmbed(game);

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(cid('rsvp', 'going', gameId))
              .setLabel("I'm in")
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId(cid('rsvp', 'tentative', gameId))
              .setLabel('Maybe')
              .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
              .setCustomId(cid('rsvp', 'out', gameId))
              .setLabel("I'm out")
              .setStyle(ButtonStyle.Danger)
          );

          await channel.send({ embeds: [embed], components: [row] });
          announced = true;
        }
      } catch (err) {
        console.error(`Failed to post public upcoming RSVP reminder for ${playerName}:`, err.message);
      }
    }

    // 2. DM the host with scheduling adjustment controls
    if (discordId) {
      try {
        const user = await client.users.fetch(discordId);
        if (user) {
          const hostEmbed = new EmbedBuilder()
            .setTitle('Hosting Notice')
            .setColor(0x34495E)
            .setDescription(
              `You're up for game night on **${formatDateBeautiful(gameDate)}** (3 days out).\n\n` +
              `Drop what you're playing — and any teach videos — in the channel when you get a chance.\n\n` +
              `Can't make it?\n` +
              `• **Swap with…** — trade dates with another upcoming host. Only you two move.\n` +
              `• **I'm out** — ask the channel to cover. Unclaimed by the day before, the night is off ` +
              `and the schedule moves back a week with you still up first.\n` +
              `• **Remove me** — leave the rotation for good; everyone after moves up a week.`
            )
            .setTimestamp();

          const hostRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(cid('host', 'swap', gameId))
              .setLabel('Swap with...')
              .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
              .setCustomId(cid('host', 'out', gameId))
              .setLabel("I'm out")
              .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
              .setCustomId(cid('host', 'remove', gameId))
              .setLabel('Remove me')
              .setStyle(ButtonStyle.Danger)
          );

          await user.send({ embeds: [hostEmbed], components: [hostRow] });
          console.log(`Sent personal host options DM to ${playerName}`);
        }
      } catch (err) {
        console.error(`Failed to send personal host options DM to ${playerName}:`, err.message);
      }
    }

    db.markGameAsReminded(gameId);
    results.push({
      playerName,
      gameDate,
      status: announced ? 'reminded' : 'skipped_no_channel',
      detail: announced ? `Announced in public channel & DM sent` : `No public channel configured`
    });
  }

  return {
    scannedAt: new Date(),
    foundCount: upcomingGames.length,
    results
  };
}

// 2b. UNCLAIMED OPEN NIGHT SWEEP
// Must run BEFORE the attendance summary: a night that times out here is
// cancelled, and the summary must not go on to advertise a host who bowed out.
export async function runUnclaimedGameCheck(client) {
  const cutoff = today(CLAIM_DEADLINE_DAYS_BEFORE);
  const due = db.getUnclaimedGamesDueBy(cutoff);
  const results = [];

  for (const game of due) {
    // Read the claim post's location before postponing -- postponeGameAndShift
    // clears those fields off the entry.
    const claimChannelId = game.claim_channel_id;
    const claimMessageId = game.claim_message_id;

    let result;
    try {
      result = db.postponeGameAndShift(game.id);
    } catch (err) {
      console.error(`Failed to postpone unclaimed game ${game.id}:`, err.message);
      results.push({
        playerName: game.playerName,
        gameDate: game.game_date,
        status: 'error',
        detail: err.message
      });
      continue;
    }

    const embed = buildPostponeEmbed(
      result,
      `Nobody could take **${formatDateBeautiful(result.skipped.game_date)}**, so there's no game night that week.`
    );

    await closeClaimCall(client, claimChannelId, claimMessageId, embed);
    await announceToPublicChannel(client, embed);

    results.push({
      playerName: result.skipped.playerName,
      gameDate: result.skipped.game_date,
      status: 'postponed',
      detail: `Unclaimed — rotation moved back to ${formatDateBeautiful(result.rescheduled.game_date)}`
    });
  }

  return {
    scannedAt: new Date(),
    foundCount: due.length,
    results
  };
}

// 3. ATTENDANCE SUMMARY REMINDER (1 DAY BEFORE GAME NIGHT)
export async function runAttendanceSummaryCheck(client) {
  const tomorrowStr = today(1);
  const tomorrowGames = db.getPendingGamesForDate(tomorrowStr);
  const results = [];

  for (const game of tomorrowGames) {
    if (game.summary_sent) continue;

    const gameId = game.id;
    const playerName = game.playerName;
    const discordId = game.playerDiscordId;
    const gameDate = game.game_date;

    const channelId = db.getSettings().announcementsChannel;
    let announced = false;

    if (channelId) {
      try {
        const channel = await client.channels.fetch(channelId);
        if (channel && channel.isTextBased()) {
          const hostMention = discordId ? `<@${discordId}>` : `**${playerName}**`;
          const summaryText = formatRsvpSummaryText(game.rsvps);
          const embed = new EmbedBuilder()
            .setTitle('Game night')
            .setColor(0x34495E)
            .setDescription(`Tomorrow's game night is hosted by ${hostMention}. ${summaryText}`)
            .setTimestamp();

          await channel.send({ embeds: [embed] });
          announced = true;
        }
      } catch (err) {
        console.error(`Failed to post attendance summary for ${playerName}:`, err.message);
      }
    }

    db.markSummarySent(gameId);
    results.push({
      playerName,
      gameDate,
      status: announced ? 'summary_posted' : 'skipped_no_channel',
      detail: announced ? 'Tomorrow summary posted' : 'No public channel configured'
    });
  }

  return {
    scannedAt: new Date(),
    foundCount: results.length,
    results
  };
}
