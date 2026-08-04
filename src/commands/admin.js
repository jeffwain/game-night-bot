// /admin -- diagnostics, manual scans, and bot configuration.
//
// Gated at the Discord level by setDefaultMemberPermissions(Administrator) on
// the /admin command itself (see ./definitions.js).

import { EmbedBuilder, MessageFlags } from 'discord.js';
import fs from 'fs';
import * as db from '../database.js';
import { replyProblem, replyError } from './respond.js';
import { formatDateBeautiful, chunkToFields } from '../format.js';
import { buildSetupMessage } from '../setup.js';
import {
  lastDmCheckTime,
  runDmCheck,
  runUpcomingReminderCheck,
  runAttendanceSummaryCheck,
  runUnclaimedGameCheck
} from '../scanners.js';
import {
  resolveReminderConfig,
  parseReminderTime,
  isValidTimezone,
  scheduleReminders
} from '../reminderScheduler.js';

// App version, read from package.json so /admin status reflects the actual build.
const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'));

export async function cmdSetup(interaction) {
  return interaction.reply(buildSetupMessage());
}

export async function cmdStatus(interaction) {
  try {
    const reminderConfig = resolveReminderConfig();
    const stats = db.getDbStats();

    const uptimeMs = process.uptime() * 1000;
    const uptimeSec = Math.floor((uptimeMs / 1000) % 60);
    const uptimeMin = Math.floor((uptimeMs / (1000 * 60)) % 60);
    const uptimeHr = Math.floor((uptimeMs / (1000 * 60 * 60)) % 24);
    const uptimeDays = Math.floor(uptimeMs / (1000 * 60 * 60 * 24));

    let uptimeStr = '';
    if (uptimeDays > 0) uptimeStr += `${uptimeDays}d `;
    if (uptimeHr > 0 || uptimeDays > 0) uptimeStr += `${uptimeHr}h `;
    if (uptimeMin > 0 || uptimeHr > 0 || uptimeDays > 0) uptimeStr += `${uptimeMin}m `;
    uptimeStr += `${uptimeSec}s`;

    const tz = process.env.TZ || 'Not Configured (UTC)';
    const localTime = new Date().toLocaleString('en-US', { hour12: true });

    const mem = process.memoryUsage();
    const formatBytes = (bytes) => {
      if (bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    const scanTimeStr = lastDmCheckTime
      ? `<t:${Math.floor(lastDmCheckTime.getTime() / 1000)}:R> (<t:${Math.floor(lastDmCheckTime.getTime() / 1000)}:f>)`
      : 'Never';

    const backupTimeStr = stats.latestBackupTime
      ? `<t:${Math.floor(stats.latestBackupTime.getTime() / 1000)}:R>`
      : 'Never';

    const embed = new EmbedBuilder()
      .setTitle('System Status & Diagnostics')
      .setColor(0x34495E)
      .setThumbnail(interaction.client.user.displayAvatarURL())
      .addFields(
        {
          name: 'System Info',
          value: `• **Version:** ${pkg.version}\n⏰ **Uptime:** \`${uptimeStr}\`\n• **Timezone:** \`${tz}\`\n• **Container Time:** \`${localTime}\`\n• **Platform:** \`${process.platform}\` (Synology)\n• **Node.js:** \`${process.version}\`\n• **Memory:** \`${formatBytes(mem.rss)}\` (RSS)`
        },
        {
          name: 'Database Status',
          value: `• **Size:** \`${formatBytes(stats.dbSize)}\`\n• **Players:** \`${stats.totalPlayers}\` (${stats.activePlayers} active)\n• **Schedule Items:** \`${stats.totalGames}\` (${stats.pendingGames} pending, ${stats.completedGames} completed, ${stats.skippedGames} skipped)\n• **Backups:** \`${stats.backupCount} / 12\` (5 rolling + 7 daily) (Last: ${backupTimeStr})`
        },
        {
          name: 'Check-in Engine',
          value: `• **Interval:** \`${(Number(process.env.CHECK_INTERVAL_MS) || 3600000) / 1000}s\`\n• **Last Checked:** ${scanTimeStr}\n• **Daily Reminder:** \`${reminderConfig.timeLabel}\` (${reminderConfig.timezone})`
        }
      )
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  } catch (err) {
    return replyError(interaction, err, 'Error fetching system status');
  }
}

export async function cmdScan(interaction, options) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const type = options.getString('type') || 'all';

  try {
    const lines = [];
    let processed = 0;

    if (type === 'checkin' || type === 'all') {
      const report = await runDmCheck(interaction.client);
      processed += report.foundCount;
      report.results.forEach(r =>
        lines.push(`**Check-in:** ${r.playerName} (${formatDateBeautiful(r.gameDate)}) — ${r.detail}`));
    }

    // Deliberately ahead of the reminder block: an unclaimed night that times
    // out is cancelled, and the attendance summary must not announce a host who
    // already bowed out.
    if (type === 'claims' || type === 'all') {
      const claims = await runUnclaimedGameCheck(interaction.client);
      processed += claims.foundCount;
      claims.results.forEach(r =>
        lines.push(`**Unclaimed:** ${r.playerName} (${formatDateBeautiful(r.gameDate)}) — ${r.detail}`));
    }

    if (type === 'reminders' || type === 'all') {
      const reminders = await runUpcomingReminderCheck(interaction.client);
      const summaries = await runAttendanceSummaryCheck(interaction.client);
      processed += reminders.foundCount + summaries.foundCount;
      reminders.results.forEach(r =>
        lines.push(`**Reminder:** ${r.playerName} (${formatDateBeautiful(r.gameDate)}) — ${r.detail}`));
      summaries.results.forEach(r =>
        lines.push(`**Summary:** ${r.playerName} (${formatDateBeautiful(r.gameDate)}) — ${r.detail}`));
    }

    const embed = new EmbedBuilder()
      .setTitle('Scan Report')
      .setColor(0x34495E)
      .setDescription(`Ran the **${type}** scan.`)
      .addFields(
        { name: 'Scan Time', value: `<t:${Math.floor(Date.now() / 1000)}:f>`, inline: true },
        { name: 'Items Processed', value: String(processed), inline: true }
      )
      .setTimestamp();

    embed.addFields(...chunkToFields('Actions Taken', lines, 'Nothing needed attention.'));

    return interaction.editReply({ embeds: [embed] });
  } catch (err) {
    return replyError(interaction, err, 'Error running scan');
  }
}

export async function cmdConfig(interaction, options) {
  const announcements = options.getChannel('announcements');
  const notifications = options.getChannel('notifications');
  const reminderTimeRaw = options.getString('reminder_time');
  const timezoneRaw = options.getString('timezone');

  if (!announcements && !notifications && !reminderTimeRaw && !timezoneRaw) {
    return replyProblem(interaction, 'Provide at least one value to update (`announcements`, `notifications`, `reminder_time`, and/or `timezone`).');
  }

  // Validate before persisting anything.
  let normalizedReminderTime = null;
  if (reminderTimeRaw) {
    const parsed = parseReminderTime(reminderTimeRaw);
    if (!parsed) {
      return replyProblem(interaction, 'Invalid `reminder_time`. Use 24-hour `HH:MM` (e.g. `10:00` or `18:30`).');
    }
    normalizedReminderTime = `${String(parsed.hour).padStart(2, '0')}:${String(parsed.minute).padStart(2, '0')}`;
  }

  let normalizedTimezone = null;
  if (timezoneRaw) {
    if (!isValidTimezone(timezoneRaw.trim())) {
      return replyProblem(interaction, 'Invalid `timezone`. Use an IANA name like `America/Chicago` or `Europe/London`.');
    }
    normalizedTimezone = timezoneRaw.trim();
  }

  try {
    if (announcements) db.updateSettings('announcementsChannel', announcements.id);
    if (notifications) db.updateSettings('notificationsChannel', notifications.id);
    if (normalizedReminderTime) db.updateSettings('reminderTime', normalizedReminderTime);
    if (normalizedTimezone) db.updateSettings('timezone', normalizedTimezone);

    const embed = new EmbedBuilder()
      .setTitle('Configuration Updated')
      .setColor(0x2ECC71)
      .setTimestamp();

    const lines = [];
    if (announcements) lines.push(`• **Announcements:** <#${announcements.id}>`);
    if (notifications) lines.push(`• **Notifications:** <#${notifications.id}>`);
    if (normalizedReminderTime || normalizedTimezone) {
      const { timeLabel, timezone } = scheduleReminders(interaction.client);
      lines.push(`• **Daily reminder:** ${timeLabel} (${timezone})`);
    }
    embed.setDescription(lines.join('\n'));

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  } catch (err) {
    return replyError(interaction, err);
  }
}
