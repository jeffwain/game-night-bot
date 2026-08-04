// /update -- everything that mutates the rotation.
//
// Gated at the Discord level by setDefaultMemberPermissions(ManageGuild) on
// the /update command itself (see ./definitions.js), so no in-handler check is
// needed here.

import { EmbedBuilder, MessageFlags } from 'discord.js';
import * as db from '../database.js';
import { announceToPublicChannel } from '../announce.js';
import { replyProblem, replyError } from './respond.js';
import { buildScheduleEditorMessage } from '../scheduleEditor.js';
import {
  formatDateBeautiful,
  formatSwapAnnouncement,
  formatGameNightOutcome,
  buildPostponeEmbed,
  parseAndNormalizeDate,
  chunkToFields,
  mentionFor
} from '../format.js';

// Serves both `update:new` (replaces the pending schedule) and `update:add`
// (appends to it). The two differ only in which db call runs at the end, so
// they share the shuffle-and-date-math body rather than duplicating it.
export async function cmdRotationGenerate(interaction, options, action) {
  const mode = action === 'update:add' ? 'append' : 'new';
  const startDateStr = options.getString('start_date');
  const intervalDays = options.getInteger('interval_days') || 7;

  let targetStartDate;

  if (mode === 'new') {
    if (!startDateStr) {
      return replyProblem(interaction, 'A starting date is required to generate a new schedule.');
    }
    targetStartDate = parseAndNormalizeDate(startDateStr);
    if (!targetStartDate) {
      return replyProblem(interaction, 'Invalid date format. Use YYYY-MM-DD or MM/DD/YYYY.');
    }
  } else {
    // mode === 'append'
    if (startDateStr) {
      targetStartDate = parseAndNormalizeDate(startDateStr);
      if (!targetStartDate) {
        return replyProblem(interaction, 'Invalid date format. Use YYYY-MM-DD or MM/DD/YYYY.');
      }
    } else {
      const pending = db.getSchedule()
        .filter(s => s.status === 'pending')
        .sort((a, b) => b.game_date.localeCompare(a.game_date));

      if (pending.length > 0) {
        const lastDate = new Date(pending[0].game_date + 'T00:00:00');
        lastDate.setDate(lastDate.getDate() + intervalDays);
        const year = lastDate.getFullYear();
        const month = String(lastDate.getMonth() + 1).padStart(2, '0');
        const day = String(lastDate.getDate()).padStart(2, '0');
        targetStartDate = `${year}-${month}-${day}`;
      } else {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        targetStartDate = `${year}-${month}-${day}`;
      }
    }
  }

  const parsedDate = new Date(targetStartDate + 'T00:00:00');
  if (isNaN(parsedDate.getTime())) {
    return replyProblem(interaction, 'Invalid date value.');
  }

  const activePlayers = db.getActivePlayers();
  if (activePlayers.length === 0) {
    return replyProblem(interaction, 'No active players found.');
  }

  // Fisher-Yates Shuffle
  const shuffled = [...activePlayers];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const entries = shuffled.map((player, index) => {
    const gameDate = new Date(parsedDate);
    gameDate.setDate(parsedDate.getDate() + index * intervalDays);
    const year = gameDate.getFullYear();
    const month = String(gameDate.getMonth() + 1).padStart(2, '0');
    const day = String(gameDate.getDate()).padStart(2, '0');
    return {
      player_id: player.id,
      game_date: `${year}-${month}-${day}`
    };
  });

  try {
    let resultSchedule;
    let title;

    if (mode === 'new') {
      resultSchedule = db.createSchedule(entries);
      title = 'Rotation Created';
    } else {
      resultSchedule = db.appendSchedule(entries);
      title = 'Rotation Appended';
    }

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setColor(0x34495E)
      .setDescription(`Generated **${entries.length}** games starting **${formatDateBeautiful(targetStartDate)}** (every ${intervalDays} days).`)
      .setTimestamp();

    const scheduleLines = resultSchedule.map((s, index) =>
      `**${index + 1}.** ${formatDateBeautiful(s.game_date)} — Host: ${mentionFor(s)}`);

    embed.addFields(...chunkToFields(mode === 'new' ? 'Upcoming Schedule' : 'Appended Games', scheduleLines));

    const unlinked = activePlayers.filter(p => !p.discord_id);
    if (unlinked.length > 0) {
      const names = unlinked.map(p => p.name).join(', ');
      embed.setFooter({
        text: `Note: ${names} do not have linked Discord accounts and won't receive DM notifications.`
      });
    }

    await interaction.reply({ embeds: [embed] });
    return;
  } catch (err) {
    return replyError(interaction, err);
  }
}

export async function cmdMarkPlayed(interaction, options) {
  const targetPlayerName = options.getString('player');
  const status = options.getString('status') || 'completed';

  try {
    // Resolve WHICH night first. Skipping does more than flip a status now --
    // it cancels the night and slides the rotation -- so both paths need the id
    // rather than the old fire-and-forget markLatestAsPlayedForPlayer call.
    let target;
    if (targetPlayerName) {
      const player = db.findPlayerByName(targetPlayerName);
      if (!player) {
        return replyProblem(interaction, `Player "${targetPlayerName}" not found.`);
      }
      target = db.getSchedule()
        .filter(s => s.status === 'pending' && s.player_id === player.id)
        .sort((a, b) => a.game_date.localeCompare(b.game_date))[0];
      if (!target) {
        return replyProblem(interaction, `No pending game night found for ${player.name}.`);
      }
    } else {
      target = db.getSchedule()
        .filter(s => s.status === 'pending')
        .sort((a, b) => a.game_date.localeCompare(b.game_date))[0];
      if (!target) {
        return replyProblem(interaction, `No pending scheduled games found to mark as ${status}.`);
      }
    }

    if (status === 'skipped') {
      const result = db.postponeGameAndShift(target.id);
      const embed = buildPostponeEmbed(
        result,
        `No game night on **${formatDateBeautiful(result.skipped.game_date)}**.`
      );
      await interaction.reply({ embeds: [embed] });
      announceToPublicChannel(interaction.client, embed);
      return;
    }

    const playedGame = db.markAsPlayed(target.id, status);

    const hostMention = mentionFor(playedGame);
    const isCompleted = status === 'completed';
    const embedColor = isCompleted ? 0x2ECC71 : 0xF39C12;
    const embedTitle = isCompleted ? 'Game Night Completed' : 'Game Night Skipped';
    const embedDesc = formatGameNightOutcome(hostMention, playedGame.game_date, status);

    const embed = new EmbedBuilder()
      .setTitle(embedTitle)
      .setColor(embedColor)
      .setDescription(embedDesc)
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
    announceToPublicChannel(interaction.client, embed);
    return;
  } catch (err) {
    return replyError(interaction, err);
  }
}

export async function cmdSwap(interaction, options) {
  const player1Name = options.getString('player1');
  const player2Name = options.getString('player2');

  try {
    const swapResult = db.swapScheduleDates(player1Name, player2Name);

    const embed = new EmbedBuilder()
      .setTitle('Schedule swapped')
      .setColor(0xF39C12)
      .setDescription(formatSwapAnnouncement(swapResult.entry1, swapResult.entry2))
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
    announceToPublicChannel(interaction.client, embed);
    return;
  } catch (err) {
    return replyError(interaction, err);
  }
}

export async function cmdEditSchedule(interaction) {
  return interaction.reply({ ...buildScheduleEditorMessage(), flags: MessageFlags.Ephemeral });
}

export async function cmdClearSchedule(interaction) {
  try {
    db.clearPendingSchedule();
    const embed = new EmbedBuilder()
      .setTitle('Schedule Cleared')
      .setColor(0xE74C3C)
      .setDescription('All upcoming pending games have been cleared from the rotation. Roster and history are preserved.')
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
    announceToPublicChannel(interaction.client, embed);
    return;
  } catch (err) {
    return replyError(interaction, err, 'Error clearing schedule');
  }
}
