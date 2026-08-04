// /player -- roster management.
//
// `list` is public. The four mutating subcommands are gated in the dispatcher
// (see REQUIRES_MANAGE_GUILD in ./index.js) rather than by Discord, because
// Discord gates whole commands and cannot gate an individual subcommand.

import { EmbedBuilder } from 'discord.js';
import * as db from '../database.js';
import { replyProblem, replyError } from './respond.js';

export async function cmdPlayerAdd(interaction, options) {
  const name = options.getString('name');
  const discordUser = options.getUser('user');
  const discordId = discordUser ? discordUser.id : null;

  try {
    const player = db.addPlayer(name, discordId);
    const mention = discordId ? `<@${discordId}>` : 'Not linked';

    const embed = new EmbedBuilder()
      .setTitle('Player Added')
      .setColor(0x2ECC71)
      .setDescription(`**${player.name}** has been added to the game group.`)
      .addFields(
        { name: 'Status', value: 'Active', inline: true },
        { name: 'Discord Account', value: mention, inline: true }
      )
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  } catch (err) {
    return replyError(interaction, err);
  }
}

export async function cmdPlayerRemove(interaction, options) {
  const name = options.getString('name');

  try {
    const player = db.removePlayer(name);

    const embed = new EmbedBuilder()
      .setTitle('Player Removed')
      .setColor(0xE74C3C)
      .setDescription(`**${player.name}** has been removed. Upcoming schedule slots were cleared.`)
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  } catch (err) {
    return replyError(interaction, err);
  }
}

export async function cmdPlayerToggle(interaction, options) {
  const name = options.getString('name');

  try {
    const player = db.togglePlayer(name);
    const statusStr = player.is_active ? 'Active' : 'Inactive';
    const explStr = player.is_active
      ? 'They will be included in future randomizations.'
      : 'They will be excluded from future randomizations.';

    const embed = new EmbedBuilder()
      .setTitle('Player Status Updated')
      .setColor(player.is_active ? 0x2ECC71 : 0xF39C12)
      .setDescription(`**${player.name}** is now **${statusStr}**.\n${explStr}`)
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  } catch (err) {
    return replyError(interaction, err);
  }
}

export async function cmdPlayerLink(interaction, options) {
  const name = options.getString('name');
  const discordUser = options.getUser('user');
  const discordId = discordUser ? discordUser.id : null;

  try {
    const player = db.updatePlayer(name, null, discordId);
    const embed = new EmbedBuilder()
      .setTimestamp();

    if (discordId) {
      embed
        .setTitle('Player Linked')
        .setColor(0x2ECC71)
        .setDescription(`Linked **${player.name}** to <@${discordId}>.`);
    } else {
      embed
        .setTitle('Player Unlinked')
        .setColor(0xF39C12)
        .setDescription(`Removed Discord link for **${player.name}**.`);
    }

    return interaction.reply({ embeds: [embed] });
  } catch (err) {
    return replyError(interaction, err);
  }
}

export async function cmdPlayerList(interaction) {
  const players = db.getAllPlayers();

  if (players.length === 0) {
    return replyProblem(interaction, 'No players found. Add players using `/player add`.');
  }

  const embed = new EmbedBuilder()
    .setTitle('Player Roster')
    .setColor(0x34495E)
    .setTimestamp();

  const listContent = players.map(p => {
    const activeIndicator = p.is_active ? 'Active' : 'Inactive';
    const mention = p.discord_id ? `<@${p.discord_id}>` : 'None';
    return `• **${p.name}** — ${activeIndicator} | Discord: ${mention}`;
  }).join('\n');

  embed.setDescription(listContent);
  return interaction.reply({ embeds: [embed] });
}
