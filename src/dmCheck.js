import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags
} from 'discord.js';
import * as db from './database.js';
import {
  formatDateBeautiful,
  announceToPublicChannel,
  formatSwapAnnouncement,
  formatClaimAnnouncement,
  buildPostponeEmbed,
  intervalLabel,
  chunkToFields,
  truncationNote,
  SELECT_MENU_LIMIT
} from './commands.js';
import { cid, parseCid } from './customId.js';
import { setupButtonRoutes, setupSelectRoutes, setupModalRoutes } from './setup.js';
import { today } from './config.js';
import { addDaysIso } from './time.js';

export let lastDmCheckTime = null;

// Date helpers now live in config.js / time.js so that every date string in
// the bot is computed in the SAME timezone the reminder cron uses. These two
// wrappers remain only so external callers keep working.
export const getLocalDateString = () => today(0);
export const getFutureLocalDateString = (daysAhead) => today(daysAhead);

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
  const hostMention = game.playerDiscordId ? `<@${game.playerDiscordId}>` : `**${game.playerName}**`;
  const summaryText = formatRsvpSummaryText(game.rsvps);

  return new EmbedBuilder()
    .setTitle('Game Night RSVP')
    .setColor(0x34495E)
    .setDescription(`Host: ${hostMention}\nDate: **${formatDateBeautiful(game.game_date)}**\n\n${summaryText}`)
    .setTimestamp();
}

// -------------------------------------------------------------
// SCHEDULE EDITOR (/edit-schedule) — ephemeral, admin-only.
// A step-through editor: pick an entry, then change its date, change its
// host, or delete it. Every action refreshes the same ephemeral message.
// -------------------------------------------------------------

// The top-level list view with a select menu of pending entries.
export function buildScheduleEditorMessage() {
  const pending = db.getSchedule()
    .filter(s => s.status === 'pending')
    .sort((a, b) => a.game_date.localeCompare(b.game_date));

  const embed = new EmbedBuilder()
    .setTitle('Edit Schedule')
    .setColor(0x34495E)
    .setTimestamp();

  if (pending.length === 0) {
    embed.setDescription('No pending game nights to edit. Use `/update new` to build a rotation.');
    return { embeds: [embed], components: [] };
  }

  const lines = pending.map((s, i) => {
    const mention = s.playerDiscordId ? `<@${s.playerDiscordId}>` : `**${s.playerName}**`;
    return `**${i + 1}.** ${formatDateBeautiful(s.game_date)} — ${mention}`;
  });
  embed.setDescription(`Pick an entry to change its date, change its host, or delete it.${truncationNote(pending.length)}`);
  embed.addFields(...chunkToFields('Pending game nights', lines));

  const select = new StringSelectMenuBuilder()
    .setCustomId(cid('edit', 'selectentry'))
    .setPlaceholder('Choose a game night to edit')
    .addOptions(
      pending.slice(0, SELECT_MENU_LIMIT).map(s => ({
        label: `${formatDateBeautiful(s.game_date)} — ${s.playerName}`,
        value: String(s.id)
      }))
    );

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] };
}

// The per-entry view: one entry plus its action buttons.
function buildEntryFocusMessage(gameId) {
  const game = db.getSchedule().find(s => s.id === Number(gameId));

  const embed = new EmbedBuilder()
    .setTitle('Edit Entry')
    .setColor(0x34495E)
    .setTimestamp();

  if (!game || game.status !== 'pending') {
    embed.setDescription('That entry is no longer available. Press **Back** to return to the list.');
    return { embeds: [embed], components: [buildBackRow()] };
  }

  const mention = game.playerDiscordId ? `<@${game.playerDiscordId}>` : `**${game.playerName}**`;
  embed.setDescription(`**${formatDateBeautiful(game.game_date)}** — ${mention}\n\nChange the date, change the host, or delete this entry.`);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(cid('edit', 'datemenu', gameId)).setLabel('Change date').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(cid('edit', 'host', gameId)).setLabel('Change host').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(cid('edit', 'delete', gameId)).setLabel('Delete').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(cid('edit', 'back')).setLabel('Back').setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row] };
}

function buildBackRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(cid('edit', 'back')).setLabel('Back').setStyle(ButtonStyle.Secondary)
  );
}

// The change-date view: quick-pick buttons for 2 days before / 4 days after
// the entry's current date, plus a Custom-date modal fallback.
function buildDateMenuMessage(gameId) {
  const game = db.getSchedule().find(s => s.id === Number(gameId));

  const embed = new EmbedBuilder()
    .setTitle('Change Date')
    .setColor(0x34495E)
    .setTimestamp();

  if (!game || game.status !== 'pending') {
    embed.setDescription('That entry is no longer available. Press **Back** to return to the list.');
    return { embeds: [embed], components: [buildBackRow()] };
  }

  embed.setDescription(`Current: **${formatDateBeautiful(game.game_date)}**\n\nPick a new date, or use **Custom date…** to type one.`);

  const dateButtons = [-2, -1, 1, 2, 3, 4].map(offset => {
    const iso = addDaysIso(game.game_date, offset);
    return new ButtonBuilder()
      .setCustomId(cid('edit', 'setdate', gameId, iso))
      .setLabel(formatDateBeautiful(iso))
      .setStyle(ButtonStyle.Primary);
  });

  // Max 5 buttons per row: 5 dates on row 1, the 6th plus utilities on row 2.
  const row1 = new ActionRowBuilder().addComponents(...dateButtons.slice(0, 5));
  const row2 = new ActionRowBuilder().addComponents(
    ...dateButtons.slice(5),
    new ButtonBuilder().setCustomId(cid('edit', 'datemodal', gameId)).setLabel('Custom date…').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(cid('edit', 'entry', gameId)).setLabel('Back').setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row1, row2] };
}

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

export function buildClaimCallMessage(game) {
  const hostMention = game.playerDiscordId ? `<@${game.playerDiscordId}>` : `**${game.playerName}**`;
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

async function postClaimCall(client, game) {
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
async function closeClaimCall(client, channelId, messageId, embed) {
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

// -------------------------------------------------------------
// 4. INTERACTION ROUTING
//
// Buttons, select menus, and modals dispatch from exact-match route tables
// keyed by "<namespace>:<action>". Adding an interaction means adding a row.
// It no longer means appending another startsWith() branch whose correctness
// depends on where in the chain it happens to land.
// -------------------------------------------------------------

const DISABLED_CHECKIN_ROW = () => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('checkin:done:yes').setLabel('Yes, I hosted').setStyle(ButtonStyle.Success).setDisabled(true),
  new ButtonBuilder().setCustomId('checkin:done:skip').setLabel('Skipped / Rescheduled').setStyle(ButtonStyle.Danger).setDisabled(true)
);

// Resolve a still-pending game, or tell the user why we can't act on it.
async function requirePendingGame(interaction, gameId) {
  const game = db.getSchedule().find(s => s.id === gameId);
  if (!game || game.status !== 'pending') {
    await interaction.reply({
      content: 'This game night is no longer pending or could not be found.',
      flags: MessageFlags.Ephemeral
    });
    return null;
  }
  return game;
}

// --- factories: one definition covers all three RSVP / both check-in buttons,
// --- replacing the old chain of customId string surgery.

function rsvpHandler(status) {
  return async (interaction, [gameIdRaw]) => {
    await interaction.deferUpdate();
    const gameId = Number(gameIdRaw);
    try {
      db.setRsvp(gameId, interaction.user.id, status);
      const game = db.getSchedule().find(s => s.id === gameId);
      if (game) await interaction.editReply({ embeds: [buildRsvpEmbed(game)] });
    } catch (err) {
      console.error('RSVP button error:', err.message);
    }
  };
}

function checkinHandler(status) {
  return async (interaction, [gameIdRaw]) => {
    await interaction.deferUpdate();
    const gameId = Number(gameIdRaw);
    try {
      const current = db.getSchedule().find(s => s.id === gameId);

      // Already answered (e.g. the host clicked in both the DM and a stale copy).
      if (current && current.status !== 'pending') {
        const statusText = current.status === 'completed' ? 'Completed' : 'Skipped';
        const embed = new EmbedBuilder()
          .setTitle('Host Check-in')
          .setColor(0x7F8C8D)
          .setDescription(`Game night on **${formatDateBeautiful(current.game_date)}** is already marked **${statusText}**.`)
          .setTimestamp();
        await interaction.editReply({ embeds: [embed], components: [DISABLED_CHECKIN_ROW()] });
        return;
      }

      // "Skipped" means the night did not happen. It is NOT handed to the
      // next host -- everyone keeps their turn and the rotation slides.
      if (status === 'skipped') {
        const result = db.postponeGameAndShift(gameId);
        const moved = result.shiftedCount > 0
          ? ` Everyone after you moved back ${intervalLabel(result.intervalDays)}.`
          : '';

        await interaction.editReply({
          embeds: [new EmbedBuilder()
            .setTitle('Host Check-in')
            .setColor(0xF39C12)
            .setDescription(
              `Got it — **${formatDateBeautiful(result.skipped.game_date)}** didn't happen. ` +
              `You keep your turn: you're up on **${formatDateBeautiful(result.rescheduled.game_date)}**.${moved}`
            )
            .setTimestamp()],
          components: [DISABLED_CHECKIN_ROW()]
        });

        await announceToPublicChannel(interaction.client, buildPostponeEmbed(
          result,
          `No game night on **${formatDateBeautiful(result.skipped.game_date)}**.`
        ));
        return;
      }

      const updated = db.markAsPlayed(gameId, status);
      const embed = new EmbedBuilder()
        .setTitle('Host Check-in')
        .setColor(0x2ECC71)
        .setDescription(`Got it — **${formatDateBeautiful(updated.game_date)}** is marked ${status}.`)
        .setTimestamp();

      await interaction.editReply({ embeds: [embed], components: [DISABLED_CHECKIN_ROW()] });
    } catch (err) {
      console.error('Check-in button error:', err.message);
    }
  };
}

// --- host DM actions ----------------------------------------------------

async function hostSwapPrompt(interaction, [gameIdRaw]) {
  const gameId = Number(gameIdRaw);
  const game = await requirePendingGame(interaction, gameId);
  if (!game) return;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const otherPending = db.getSchedule()
    .filter(s => s.status === 'pending' && s.id !== gameId)
    .sort((a, b) => a.game_date.localeCompare(b.game_date));

  if (otherPending.length === 0) {
    await interaction.editReply({ content: 'There are no other scheduled game nights in the rotation to swap with.' });
    return;
  }

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(cid('host', 'swapselect', gameId))
    .setPlaceholder('Choose a player to swap dates with')
    .addOptions(
      otherPending.slice(0, 25).map(s => ({
        label: `${s.playerName} (${formatDateBeautiful(s.game_date)})`,
        value: String(s.id)
      }))
    );

  await interaction.editReply({
    content: `Pick an upcoming host to swap dates with:${truncationNote(otherPending.length)}`,
    components: [new ActionRowBuilder().addComponents(selectMenu)]
  });
}

// "I'm out" opens the night to the group rather than reshuffling on the spot.
// Nothing about the schedule changes yet -- that only happens when someone
// claims it, or when the deadline passes with no takers.
async function hostOut(interaction, [gameIdRaw]) {
  const gameId = Number(gameIdRaw);
  const game = await requirePendingGame(interaction, gameId);
  if (!game) return;

  await interaction.deferUpdate();

  let opened;
  try {
    opened = db.openGameForClaim(gameId);
  } catch (err) {
    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setTitle('Nothing to do')
        .setColor(0x7F8C8D)
        .setDescription(err.message)
        .setTimestamp()],
      components: []
    });
    return;
  }

  const posted = await postClaimCall(interaction.client, opened);
  const shift = intervalLabel(Math.max(1, db.getRotationIntervalDays()));

  const description = posted
    ? `Asked the channel who can take **${formatDateBeautiful(opened.game_date)}**.\n\n` +
      `If someone claims it you'll trade dates with them. If nobody does by the day ` +
      `before, that week is off and the whole schedule moves back ${shift} — you'd ` +
      `still be up first, just a week later.`
    : `You're marked as out for **${formatDateBeautiful(opened.game_date)}**, but there's no ` +
      `announcements channel set, so nobody was asked to cover. An admin needs to run ` +
      `\`/admin config\`. Unclaimed, that week will be called off and the schedule moves back ${shift}.`;

  await interaction.editReply({
    embeds: [new EmbedBuilder()
      .setTitle('Asking for a fill-in')
      .setColor(0xF39C12)
      .setDescription(description)
      .setTimestamp()],
    components: []
  });
}

// Someone volunteering for an open night. A straight trade: the claimer takes
// the open date, the host who bowed out takes the claimer's next slot.
async function claimTake(interaction, [gameIdRaw]) {
  const gameId = Number(gameIdRaw);

  const claimer = db.findPlayerByDiscordId(interaction.user.id);
  if (!claimer) {
    await interaction.reply({
      content: "You're not on the roster, so I can't put you on the schedule. Ask an admin to run `/player add`.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  let result;
  try {
    result = db.claimOpenGame(gameId, claimer.id);
  } catch (err) {
    await interaction.reply({ content: err.message, flags: MessageFlags.Ephemeral });
    return;
  }

  // The claim call itself lives in the announcements channel, so editing it in
  // place is the announcement -- no second post.
  await interaction.update({
    embeds: [new EmbedBuilder()
      .setTitle('Host found')
      .setColor(0x2ECC71)
      .setDescription(formatClaimAnnouncement(result))
      .setTimestamp()],
    components: []
  });

  // Tell the host who bowed out where they landed; they asked in a DM, so the
  // answer belongs in one too.
  if (result.handedOff.playerDiscordId) {
    try {
      const user = await interaction.client.users.fetch(result.handedOff.playerDiscordId);
      await user.send({
        embeds: [new EmbedBuilder()
          .setTitle('Someone covered your night')
          .setColor(0x2ECC71)
          .setDescription(
            `**${result.claimed.playerName}** is taking **${formatDateBeautiful(result.claimed.game_date)}**. ` +
            `You're now hosting **${formatDateBeautiful(result.handedOff.game_date)}**.`
          )
          .setTimestamp()]
      });
    } catch (err) {
      console.error('Failed to DM the original host about a claim:', err.message);
    }
  }
}

async function hostRemove(interaction, [gameIdRaw]) {
  const gameId = Number(gameIdRaw);
  const game = await requirePendingGame(interaction, gameId);
  if (!game) return;

  await interaction.deferUpdate();
  const removed = db.removeGameAndShiftSchedule(gameId);

  await interaction.editReply({
    embeds: [new EmbedBuilder()
      .setTitle('Removed from Rotation')
      .setColor(0xE74C3C)
      .setDescription(`You're out for **${formatDateBeautiful(removed.game_date)}**. Everyone after you moved up in the rotation.`)
      .setTimestamp()],
    components: []
  });

  const hostMention = game.playerDiscordId ? `<@${game.playerDiscordId}>` : `**${game.playerName}**`;
  await announceToPublicChannel(interaction.client, new EmbedBuilder()
    .setTitle('Schedule Shifted')
    .setColor(0xE74C3C)
    .setDescription(`${hostMention} left the rotation for **${formatDateBeautiful(removed.game_date)}**. Later dates shifted up — see \`/schedule\` for the updated dates.`)
    .setTimestamp());
}

// --- schedule editor ----------------------------------------------------

async function editRefresh(interaction, build) {
  await interaction.deferUpdate();
  await interaction.editReply(build());
}

// -------------------------------------------------------------
// ROUTE TABLES
// -------------------------------------------------------------

const buttonRoutes = new Map([
  ['edit:back',      (i) => editRefresh(i, () => buildScheduleEditorMessage())],
  ['edit:entry',     (i, [id]) => editRefresh(i, () => buildEntryFocusMessage(Number(id)))],
  ['edit:datemenu',  (i, [id]) => editRefresh(i, () => buildDateMenuMessage(Number(id)))],

  ['edit:setdate', async (i, [id, iso]) => {
    await i.deferUpdate();
    try {
      db.setEntryDate(Number(id), iso);
    } catch (err) {
      console.error('Schedule editor quick-date error:', err.message);
    }
    await i.editReply(buildScheduleEditorMessage());
  }],

  ['edit:delete', async (i, [id]) => {
    await i.deferUpdate();
    try {
      db.deleteEntry(Number(id));
    } catch (err) {
      console.error('Schedule editor delete error:', err.message);
    }
    await i.editReply(buildScheduleEditorMessage());
  }],

  ['edit:datemodal', async (i, [id]) => {
    const modal = new ModalBuilder()
      .setCustomId(cid('edit', 'datesubmit', id))
      .setTitle('Change Date');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('new_date')
        .setLabel('New date')
        .setPlaceholder('e.g. 2026-06-24, 6/24, or tomorrow')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
    ));
    await i.showModal(modal);
  }],

  ['edit:host', async (i, [id]) => {
    await i.deferUpdate();
    const activePlayers = db.getActivePlayers();

    if (activePlayers.length === 0) {
      await i.editReply({
        embeds: [new EmbedBuilder()
          .setTitle('Change Host')
          .setColor(0x34495E)
          .setDescription('No active players to assign. Add one with `/player add` first.')
          .setTimestamp()],
        components: [buildBackRow()]
      });
      return;
    }

    const select = new StringSelectMenuBuilder()
      .setCustomId(cid('edit', 'hostselect', id))
      .setPlaceholder('Choose the new host')
      .addOptions(activePlayers.slice(0, 25).map(p => ({ label: p.name, value: String(p.id) })));

    await i.editReply({
      embeds: [new EmbedBuilder()
        .setTitle('Change Host')
        .setColor(0x34495E)
        .setDescription('Pick the new host for this game night.')
        .setTimestamp()],
      components: [new ActionRowBuilder().addComponents(select), buildBackRow()]
    });
  }],

  ['rsvp:going',     rsvpHandler('going')],
  ['rsvp:tentative', rsvpHandler('tentative')],
  ['rsvp:out',       rsvpHandler('out')],

  ['checkin:yes',    checkinHandler('completed')],
  ['checkin:skip',   checkinHandler('skipped')],

  ['host:swap',      hostSwapPrompt],
  ['host:out',       hostOut],
  ['host:remove',    hostRemove],

  ['claim:take',     claimTake],

  ...setupButtonRoutes
]);

const selectRoutes = new Map([
  ['edit:selectentry', async (i) => {
    await i.deferUpdate();
    await i.editReply(buildEntryFocusMessage(Number(i.values[0])));
  }],

  ['edit:hostselect', async (i, [id]) => {
    await i.deferUpdate();
    try {
      db.setEntryHost(Number(id), Number(i.values[0]));
    } catch (err) {
      console.error('Schedule editor host change error:', err.message);
    }
    await i.editReply(buildEntryFocusMessage(Number(id)));
  }],

  ['host:swapselect', async (i, [id]) => {
    await i.deferUpdate();
    try {
      const result = db.swapTwoSpecificGames(Number(id), Number(i.values[0]));

      await i.editReply({
        content: null,
        embeds: [new EmbedBuilder()
          .setTitle('Hosting Swap Completed')
          .setColor(0x2ECC71)
          .setDescription(`Done. You're hosting **${formatDateBeautiful(result.entry2.game_date)}** now (swapped with **${result.entry1.playerName}** on **${formatDateBeautiful(result.entry1.game_date)}**).`)
          .setTimestamp()],
        components: []
      });

      await announceToPublicChannel(i.client, new EmbedBuilder()
        .setTitle('Schedule swapped')
        .setColor(0xF39C12)
        .setDescription(formatSwapAnnouncement(result.entry1, result.entry2))
        .setTimestamp());
    } catch (err) {
      console.error('Host swap select error:', err.message);
      await i.editReply({ content: `Error completing swap: ${err.message}`, components: [] });
    }
  }],

  ...setupSelectRoutes
]);

const modalRoutes = new Map([
  ['edit:datesubmit', async (i, [id]) => {
    const raw = i.fields.getTextInputValue('new_date');
    const { parseAndNormalizeDate } = await import('./commands.js');
    const normalized = parseAndNormalizeDate(raw);

    if (!normalized) {
      await i.reply({ content: `Couldn't read "${raw}" as a date. Try YYYY-MM-DD (e.g. 2026-06-24).`, flags: MessageFlags.Ephemeral });
      return;
    }

    try {
      db.setEntryDate(Number(id), normalized);
    } catch (err) {
      await i.reply({ content: err.message, flags: MessageFlags.Ephemeral });
      return;
    }

    // A date change can reorder the list, so go back to the refreshed list view.
    await i.update(buildScheduleEditorMessage());
  }],

  ...setupModalRoutes
]);

// -------------------------------------------------------------
// 5. DISPATCHERS
// -------------------------------------------------------------

async function dispatch(interaction, routes, label) {
  const { key, args } = parseCid(interaction.customId);
  const handler = routes.get(key);
  if (!handler) {
    console.warn(`Unrouted ${label} interaction: "${interaction.customId}" (key "${key}")`);
    return;
  }
  await handler(interaction, args);
}

export async function handleButtonInteraction(interaction) {
  if (!interaction.isButton()) return;
  await dispatch(interaction, buttonRoutes, 'button');
}

export async function handleSelectInteraction(interaction) {
  // Covers string selects and the channel selects used by the setup card.
  if (!interaction.isAnySelectMenu()) return;
  await dispatch(interaction, selectRoutes, 'select menu');
}

export async function handleModalSubmit(interaction) {
  if (!interaction.isModalSubmit()) return;
  await dispatch(interaction, modalRoutes, 'modal');
}

// Exposed so tests can assert every route is reachable.
export const __routes = { buttonRoutes, selectRoutes, modalRoutes };
