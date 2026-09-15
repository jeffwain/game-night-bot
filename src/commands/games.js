// /games -- the Games tab, in a channel.
//
// Same library, same scorer, same columns as the control panel: name, our
// average, the group average, BGG's average, who owns a copy, and when it was
// last played. The scorer is imported from the panel's own search.js rather
// than reimplemented, so a result that ranks first in the browser ranks first
// here.

import { EmbedBuilder } from 'discord.js';
import * as db from '../database.js';
import * as library from '../games.js';
import { searchGames } from '../web/public/search.js';

// Discord allows 25 embed fields; ten keeps the message scannable and leaves
// room for the "and N more" footer that tells you to narrow the search.
const MAX_RESULTS = 10;

const rating = value => (value === null || value === undefined ? '—' : Number(value).toFixed(1));

// Not formatDateBeautiful: that one drops the year because the schedule it was
// written for is always within a few weeks. A last-played date is routinely
// years old, and "Sat, 8/1" for a game last played in 2020 reads as this year.
function playDate(iso) {
  const [year, month, day] = String(iso).split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric'
  });
}

// Prefer what we call someone here: a roster name is shorter and more familiar
// than their BGG username. Falls back through the BGG profile to a bare id.
function ownerNames(game, users, players) {
  const owners = game.status?.own || [];
  if (!owners.length) {
    // A CSV import counts owners without naming them; saying "nobody" would be
    // a plain lie.
    return game.owner_count ? `${game.owner_count} (names not in this import)` : 'Nobody';
  }
  return owners.map(id => {
    const user = users.find(u => u.id === id);
    const player = players.find(p => Number(p.bgg_user_id) === id);
    return player?.name || user?.full_name || user?.username || `BGG ${id}`;
  }).join(', ');
}

function describe(game, matchedExpansion, users, players) {
  const lines = [
    `Ours **${rating(game.rating.average)}** · Group **${rating(game.rating.group_average)}** · ` +
    `BGG **${rating(game.rating.bgg_average)}**`,
    `Owned by ${ownerNames(game, users, players)}`,
    game.plays.last_play
      ? `Last played ${playDate(game.plays.last_play)}` +
        (game.plays.total_plays ? ` · ${game.plays.total_plays} plays` : '')
      : 'Never played'
  ];
  // Say why a game surfaced when the query never appeared in its own name.
  if (matchedExpansion) lines.push(`_matched expansion: ${matchedExpansion}_`);
  return lines.join('\n');
}

function titleFor(game) {
  const year = game.published ? ` (${game.published})` : '';
  const tag = game.is_expansion ? ' — expansion' : '';
  const extra = game.expansions?.length ? ` +${game.expansions.length}` : '';
  return `${game.name}${year}${tag}${extra}`;
}

export async function cmdGames(interaction) {
  const query = interaction.options.getString('name');
  // Expansions are off unless asked for: most of the time "do we own X" means
  // the base game, and a third of the library is expansions.
  const includeExpansions = interaction.options.getBoolean('expansions') ?? false;

  const games = library.getGames();
  const embed = new EmbedBuilder().setColor(0x34495E).setTimestamp();

  if (!games.length) {
    embed
      .setTitle('No game library yet')
      .setDescription(
        'Nobody has synced a collection. In the control panel, open **Games** and either sync ' +
        'from Geekgroup or import a saved export.'
      );
    return interaction.reply({ embeds: [embed] });
  }

  const hits = searchGames(games, query, { includeExpansions });

  if (!hits.length) {
    embed
      .setTitle(`Nothing matching "${query}"`)
      .setDescription(
        includeExpansions
          ? 'Expansion names are searched too, and a hit on one shows its base game.'
          : 'Expansions are hidden — add `expansions: True` to search those as well.'
      );
    return interaction.reply({ embeds: [embed] });
  }

  const users = library.getGamesUsers();
  const players = db.getAllPlayers();
  const shown = hits.slice(0, MAX_RESULTS);

  embed
    .setTitle(`${hits.length === 1 ? '1 game' : `${hits.length} games`} matching "${query}"`)
    .addFields(shown.map(hit => ({
      name: titleFor(hit.game),
      value: describe(hit.game, hit.matchedExpansion, users, players)
    })));

  const notes = [];
  if (hits.length > shown.length) notes.push(`Showing the top ${shown.length}. Narrow the search to see the rest.`);
  if (!includeExpansions) notes.push('Expansions hidden — use expansions: True to include them.');
  if (notes.length) embed.setFooter({ text: notes.join(' ') });

  return interaction.reply({ embeds: [embed] });
}
