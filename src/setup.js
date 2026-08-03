import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  PermissionFlagsBits
} from 'discord.js';
import * as db from './database.js';
import { cid } from './customId.js';
import { resolveReminderConfig } from './config.js';
import { parseReminderTime, isValidTimezone } from './time.js';

// First-run setup.
//
// The bot posts this card automatically the first time it joins a server, so a
// new self-hoster configures it by clicking rather than by reading the README.
// `/admin setup` re-posts it at any time.

function settingsSummary() {
  const settings = db.getSettings();
  const { timeLabel, timezone } = resolveReminderConfig();
  return [
    settings.announcementsChannel
      ? `✅ Announcements: <#${settings.announcementsChannel}>`
      : '⬜ Announcements: *not set* — RSVP posts have nowhere to go',
    settings.notificationsChannel
      ? `✅ Notifications: <#${settings.notificationsChannel}>`
      : `⬜ Notifications: *not set* — will reuse the announcements channel`,
    `✅ Daily reminder: **${timeLabel}** (${timezone})`
  ].join('\n');
}

export function buildSetupMessage() {
  const embed = new EmbedBuilder()
    .setTitle('Set up game night')
    .setColor(0x34495E)
    .setDescription(
      'Two clicks and you\'re running.\n\n' +
      '**1.** Pick a channel for RSVP posts and schedule updates.\n' +
      '**2.** Adjust the daily reminder time if 09:00 isn\'t right.\n\n' +
      'Then add players with `/player add` and build a rotation with `/update new`.'
    )
    .addFields({ name: 'Current configuration', value: settingsSummary() })
    .setFooter({ text: 'Only members with Manage Server can change these.' })
    .setTimestamp();

  const announcements = new ChannelSelectMenuBuilder()
    .setCustomId(cid('setup', 'announcements'))
    .setPlaceholder('Announcements channel (RSVPs, schedule updates)')
    .addChannelTypes(ChannelType.GuildText);

  const notifications = new ChannelSelectMenuBuilder()
    .setCustomId(cid('setup', 'notifications'))
    .setPlaceholder('Optional: separate channel for plain-text reminders')
    .addChannelTypes(ChannelType.GuildText);

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(cid('setup', 'time')).setLabel('Reminder time').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(cid('setup', 'timezone')).setLabel('Timezone').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(cid('setup', 'refresh')).setLabel('Refresh').setStyle(ButtonStyle.Secondary)
  );

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(announcements),
      new ActionRowBuilder().addComponents(notifications),
      buttons
    ]
  };
}

// The setup card is posted publicly, so every control re-checks permissions.
// Component clicks are not covered by a command's default_member_permissions.
async function denyIfNotAdmin(interaction) {
  const allowed = interaction.inGuild() &&
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
  if (allowed) return false;
  await interaction.reply({
    content: 'You need the **Manage Server** permission to change these settings.',
    flags: MessageFlags.Ephemeral
  });
  return true;
}

async function saveChannel(interaction, key, label) {
  if (await denyIfNotAdmin(interaction)) return;
  await interaction.deferUpdate();
  db.updateSettings(key, interaction.values[0]);
  await interaction.message.edit(buildSetupMessage());
  await interaction.followUp({
    content: `${label} channel set to <#${interaction.values[0]}>.`,
    flags: MessageFlags.Ephemeral
  });
}

function textModal(customId, title, fieldId, label, placeholder) {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title)
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId(fieldId)
        .setLabel(label)
        .setPlaceholder(placeholder)
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
    ));
}

export const setupSelectRoutes = new Map([
  ['setup:announcements', (i) => saveChannel(i, 'announcementsChannel', 'Announcements')],
  ['setup:notifications', (i) => saveChannel(i, 'notificationsChannel', 'Notifications')]
]);

export const setupButtonRoutes = new Map([
  ['setup:refresh', async (i) => {
    await i.deferUpdate();
    await i.editReply(buildSetupMessage());
  }],
  ['setup:time', async (i) => {
    if (await denyIfNotAdmin(i)) return;
    await i.showModal(textModal(cid('setup', 'timesubmit'), 'Daily reminder time', 'value', 'Time (24-hour)', 'e.g. 09:00 or 18:30'));
  }],
  ['setup:timezone', async (i) => {
    if (await denyIfNotAdmin(i)) return;
    await i.showModal(textModal(cid('setup', 'tzsubmit'), 'Timezone', 'value', 'IANA timezone', 'e.g. America/Chicago'));
  }]
]);

export const setupModalRoutes = new Map([
  ['setup:timesubmit', async (i) => {
    const raw = i.fields.getTextInputValue('value').trim();
    const parsed = parseReminderTime(raw);
    if (!parsed) {
      await i.reply({ content: `"${raw}" isn't a valid time. Use 24-hour HH:MM, like 09:00 or 18:30.`, flags: MessageFlags.Ephemeral });
      return;
    }
    const normalized = `${String(parsed.hour).padStart(2, '0')}:${String(parsed.minute).padStart(2, '0')}`;
    db.updateSettings('reminderTime', normalized);
    const { scheduleReminders } = await import('./reminderScheduler.js');
    scheduleReminders(i.client);
    await i.update(buildSetupMessage());
  }],
  ['setup:tzsubmit', async (i) => {
    const raw = i.fields.getTextInputValue('value').trim();
    if (!isValidTimezone(raw)) {
      await i.reply({ content: `"${raw}" isn't a valid IANA timezone. Try something like America/Chicago or Europe/London.`, flags: MessageFlags.Ephemeral });
      return;
    }
    db.updateSettings('timezone', raw);
    const { scheduleReminders } = await import('./reminderScheduler.js');
    scheduleReminders(i.client);
    await i.update(buildSetupMessage());
  }]
]);

// Pick somewhere the bot can actually post: the server's system channel if it
// is writable, otherwise the first text channel that permits sending.
export function findWelcomeChannel(guild) {
  const me = guild.members.me;
  const canPost = (ch) =>
    ch?.isTextBased?.() && ch.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages);

  if (canPost(guild.systemChannel)) return guild.systemChannel;
  return guild.channels.cache
    .filter(ch => ch.type === ChannelType.GuildText && canPost(ch))
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .first() ?? null;
}
