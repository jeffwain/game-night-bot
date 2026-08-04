// Public, ungated commands: /schedule and /help.

import { EmbedBuilder } from 'discord.js';
import * as db from '../database.js';
import { formatDateBeautiful, chunkToFields, mentionFor } from '../format.js';

export async function cmdSchedule(interaction) {
  const allSchedule = db.getSchedule();

  const pending = allSchedule
    .filter(s => s.status === 'pending')
    .sort((a, b) => a.game_date.localeCompare(b.game_date));

  const embed = new EmbedBuilder()
    .setTitle('Hosting Schedule')
    .setColor(0x34495E)
    .setTimestamp();

  if (pending.length === 0) {
    embed.setDescription('No upcoming game nights scheduled. Use `/update new` to start a rotation.');
  } else {
    const upcomingLines = pending.map((s, index) => {
      const prefix = index === 0 ? '➡️ ' : '• ';
      return `${prefix}**${formatDateBeautiful(s.game_date)}** — Host: ${mentionFor(s)}`;
    });
    embed.addFields(...chunkToFields(`${pending.length} upcoming`, upcomingLines));
  }

  return interaction.reply({ embeds: [embed] });
}

export async function cmdHelp(interaction) {
  const embed = new EmbedBuilder()
    .setTitle('Bot Guide & Commands')
    .setColor(0x34495E)
    .setDescription(
      'A utility bot to schedule and coordinate host rotations for board game nights.'
    )
    .addFields(
      {
        name: 'Everyone',
        value: '• `/schedule` — See who is hosting and when.\n' +
               '• `/player list` — View the roster.\n' +
               '• `/help` — This guide.'
      },
      {
        name: 'Roster — needs Manage Server',
        value: '• `/player add name: <name> user: <@user>` — Add a player.\n' +
               '• `/player link name: <name> user: <@user>` — Link or unlink a Discord account.\n' +
               '• `/player toggle name: <name>` — Active/inactive (inactive players are skipped when randomizing).\n' +
               '• `/player remove name: <name>` — Remove a player and clear their slots.'
      },
      {
        name: 'Rotation — needs Manage Server',
        value: '• `/update new start_date: <date>` — **Replaces** the pending schedule with a fresh shuffle.\n' +
               '• `/update add` — Appends another shuffled rotation to the end.\n' +
               '• `/update done player: <name> status: <completed|skipped>` — Mark a night.\n' +
               '• `/update swap player1: <name> player2: <name>` — Trade two dates.\n' +
               '• `/update edit` — Step through entries to change dates/hosts or delete.\n' +
               '• `/update clear` — Drop all pending games (roster and history are kept).'
      },
      {
        name: 'Admin — needs Administrator',
        value: '• `/admin config` — Set the announcement/notification channels, daily `reminder_time` (HH:MM), and `timezone`.\n' +
               '• `/admin status` — Diagnostics and database status.\n' +
               '• `/admin scan type: <checkin|reminders|claims|all>` — Run the background scanners now.'
      },
      {
        name: '\u200b',
        value: '**The bot also messages you. Here is what each button does.**'
      },
      {
        name: 'Hosting notice — DM, 3 days before your night',
        value: '• **Swap with…** — Pick another upcoming host and trade dates with them. ' +
               'Only the two of you move; every other date holds.\n' +
               '• **I\'m out** — Posts an open call in the channel asking who can take your night. ' +
               'If someone claims it you trade dates with them. If nobody claims it by the day before, ' +
               'the night is called off and the whole rotation slides back one week — you still host next.\n' +
               '• **Remove me** — You leave the rotation entirely. You are marked inactive, your night is ' +
               'deleted, and everyone after you moves *up* a week. Use `/player toggle` to come back.'
      },
      {
        name: 'Host needed — channel post, after someone uses “I\'m out”',
        value: '• **I\'ll host it** — You take that night and the host who bowed out takes your next slot. ' +
               'A straight trade: no other dates move. You have to be on the roster to claim.'
      },
      {
        name: 'RSVP post — channel, 3 days before each night',
        value: '• **I\'m in** / **Maybe** / **I\'m out** — Attendance only. These never change a date or a host. ' +
               'Click again any time to change your answer; the post updates itself.'
      },
      {
        name: 'Host check-in — DM, the morning after your night',
        value: '• **Yes, I hosted** — Marks the night completed. Nothing else changes.\n' +
               '• **Skipped / Rescheduled** — The night did not happen, so it is cancelled rather than ' +
               'handed to the next person. You keep your turn and move to the next slot, and everyone ' +
               'behind you slides back one week. Nobody loses their place in line.'
      },
      {
        name: 'Tip',
        value: 'Player names and dates autocomplete — start typing and pick from the list.'
      }
    )
    .setFooter({ text: 'Board Game Rotation Bot' })
    .setTimestamp();

  return interaction.reply({ embeds: [embed] });
}
