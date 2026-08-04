// Component routing: every button, select menu, and modal the bot sends.
//
// Buttons, select menus, and modals dispatch from exact-match route tables
// keyed by "<namespace>:<action>". Adding an interaction means adding a row.
// It no longer means appending another startsWith() branch whose correctness
// depends on where in the chain it happens to land.

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
  formatSwapAnnouncement,
  formatClaimAnnouncement,
  buildPostponeEmbed,
  intervalLabel,
  truncationNote,
  parseAndNormalizeDate,
  mentionFor
} from './format.js';
import { announceToPublicChannel } from './announce.js';
import { cid, parseCid } from './customId.js';
import { setupButtonRoutes, setupSelectRoutes, setupModalRoutes } from './setup.js';
import { buildRsvpEmbed } from './rsvp.js';
import {
  buildScheduleEditorMessage,
  buildEntryFocusMessage,
  buildDateMenuMessage,
  buildBackRow
} from './scheduleEditor.js';
import { postClaimCall } from './hostCalls.js';

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

  const hostMention = mentionFor(game);
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
