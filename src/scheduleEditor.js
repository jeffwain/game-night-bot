// The /update edit step-through editor: pick an entry, then change its date,
// change its host, or delete it. Every action re-renders the same ephemeral
// message.
//
// View builders only -- the button and select handlers that call them live in
// ./interactions.js.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder
} from 'discord.js';
import * as db from './database.js';
import {
  formatDateBeautiful,
  mentionFor,
  chunkToFields,
  truncationNote,
  SELECT_MENU_LIMIT
} from './format.js';
import { cid } from './customId.js';
import { addDaysIso } from './time.js';

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
    return `**${i + 1}.** ${formatDateBeautiful(s.game_date)} — ${mentionFor(s)}`;
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
export function buildEntryFocusMessage(gameId) {
  const game = db.getSchedule().find(s => s.id === Number(gameId));

  const embed = new EmbedBuilder()
    .setTitle('Edit Entry')
    .setColor(0x34495E)
    .setTimestamp();

  if (!game || game.status !== 'pending') {
    embed.setDescription('That entry is no longer available. Press **Back** to return to the list.');
    return { embeds: [embed], components: [buildBackRow()] };
  }

  embed.setDescription(`**${formatDateBeautiful(game.game_date)}** — ${mentionFor(game)}\n\nChange the date, change the host, or delete this entry.`);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(cid('edit', 'datemenu', gameId)).setLabel('Change date').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(cid('edit', 'host', gameId)).setLabel('Change host').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(cid('edit', 'delete', gameId)).setLabel('Delete').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(cid('edit', 'back')).setLabel('Back').setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row] };
}

export function buildBackRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(cid('edit', 'back')).setLabel('Back').setStyle(ButtonStyle.Secondary)
  );
}

// The change-date view: quick-pick buttons for 2 days before / 4 days after
// the entry's current date, plus a Custom-date modal fallback.
export function buildDateMenuMessage(gameId) {
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
