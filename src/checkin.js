// Host check-in after a night: did you host, then what did you play.
//
// The morning-after DM already asks Yes / Skipped. Yes marks the night
// completed and opens a search-and-pick loop; No (or Nothing) posts each
// picked game to BGG with the host plus everyone who RSVP'd I'm in.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags
} from 'discord.js';
import * as db from './database.js';
import * as library from './games.js';
import { cid } from './customId.js';
import { formatDateBeautiful } from './format.js';
import { attendeesForPlay, findPlayable, playPayload, searchPlayables } from './plays.js';
import { logPlays } from './bgg/plays.js';

function pickedList(game) {
  return (game?.logged_plays || []).map(p => p.name).filter(Boolean);
}

export function buildSearchModal(gameId) {
  return new ModalBuilder()
    .setCustomId(cid('checkin', 'query', gameId))
    .setTitle('What did you play?')
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('query')
        .setLabel('Game name')
        .setPlaceholder('Terraforming Mars')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(80)
    ));
}

export function buildPickerMessage(game) {
  const picked = pickedList(game);
  const date = formatDateBeautiful(game.game_date);
  const description = picked.length
    ? `Logged: **${picked.join('**, **')}**.\n\nDid you play anything else?`
    : `Got it — **${date}** is marked completed.\n\nWhat did you play?`;

  const search = new ButtonBuilder()
    .setCustomId(cid('checkin', 'search', game.id))
    .setLabel('Search')
    .setStyle(ButtonStyle.Primary);
  const done = new ButtonBuilder()
    .setCustomId(cid('checkin', 'finish', game.id))
    .setLabel(picked.length ? 'No' : 'Nothing')
    .setStyle(ButtonStyle.Secondary);

  return {
    embeds: [new EmbedBuilder()
      .setTitle('Host Check-in')
      .setColor(0x2ECC71)
      .setDescription(description)
      .setTimestamp()],
    components: [new ActionRowBuilder().addComponents(search, done)]
  };
}

function buildMatchMessage(gameId, query, hits) {
  const select = new StringSelectMenuBuilder()
    .setCustomId(cid('checkin', 'pick', gameId))
    .setPlaceholder('Pick a match')
    .addOptions(hits.map(h => ({
      label: h.label.slice(0, 100),
      value: String(h.id)
    })));

  return {
    embeds: [new EmbedBuilder()
      .setTitle('Host Check-in')
      .setColor(0x34495E)
      .setDescription(`Matches for **${query}**. Pick one.`)
      .setTimestamp()],
    components: [new ActionRowBuilder().addComponents(select)]
  };
}

export function buildFinishedMessage({ game, results, skipped }) {
  const picked = pickedList(game);
  const date = formatDateBeautiful(game.game_date);
  const lines = [`**${date}** is marked completed.`];
  if (picked.length) lines.push(`Played: **${picked.join('**, **')}**.`);
  if (skipped) lines.push(skipped);
  else if (results?.length) {
    const ok = results.filter(r => r.ok).length;
    const fail = results.filter(r => !r.ok);
    if (ok) lines.push(`Posted ${ok === 1 ? '1 play' : `${ok} plays`} to BoardGameGeek.`);
    for (const r of fail) lines.push(`Could not post one play: ${r.error}`);
  }

  return {
    embeds: [new EmbedBuilder()
      .setTitle('Host Check-in')
      .setColor(0x2ECC71)
      .setDescription(lines.join('\n'))
      .setTimestamp()],
    components: []
  };
}

export async function finishLoggedPlays(gameId, { logPlaysFn = logPlays } = {}) {
  const game = db.getSchedule().find(s => s.id === Number(gameId));
  const plays = game?.logged_plays || [];
  if (!plays.length) {
    return { game, results: [], skipped: null };
  }

  const settings = db.getSettings();
  const username = String(settings.bggUsername || '').trim();
  const password = String(process.env.BGG_PASSWORD || '').trim();
  if (!username || !password) {
    return {
      game,
      results: [],
      skipped: 'Need a BGG username in Settings and BGG_PASSWORD in data/.env — saved here, not posted to BoardGameGeek.'
    };
  }

  const players = attendeesForPlay(game, db.getAllPlayers());
  const location = String(settings.displayName || '').trim() || 'Game Night';
  const payloads = plays.map(p => playPayload({
    objectId: p.id,
    playdate: game.game_date,
    location,
    players
  }));
  const results = await logPlaysFn({ username, password }, payloads);
  return { game, results, skipped: null };
}

export async function searchCheckin(interaction, gameId) {
  await interaction.showModal(buildSearchModal(gameId));
}

export async function submitCheckinSearch(interaction, gameId) {
  const query = interaction.fields.getTextInputValue('query').trim();
  const games = library.getGames();
  if (!games.length) {
    await interaction.reply({
      content: 'No game library yet. Sync from the Games tab first.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }
  const hits = searchPlayables(games, query);
  if (!hits.length) {
    await interaction.reply({
      content: `Nothing matching "${query}". Try another search.`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }
  await interaction.update(buildMatchMessage(gameId, query, hits));
}

export async function pickCheckinPlay(interaction, gameId) {
  const item = findPlayable(library.getGames(), interaction.values[0]);
  if (item) db.appendLoggedPlay(gameId, { id: item.id, name: item.name });
  const game = db.getSchedule().find(s => s.id === Number(gameId));
  await interaction.editReply(buildPickerMessage(game));
}

export async function finishCheckin(interaction, gameId) {
  const result = await finishLoggedPlays(gameId);
  await interaction.editReply(buildFinishedMessage(result));
}
