import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import * as db from './database.js';
import { today } from './config.js';
import fs from 'fs';

// App version, read from package.json so /status reflects the actual build.
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));

// Define the Slash Command structures
export const commands = [
  // =====================================================================
  // PUBLIC - no permission gate
  // =====================================================================

  new SlashCommandBuilder()
    .setName('schedule')
    .setDescription('Show the upcoming rotation schedule'),

  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show the commands and setup guide'),

  // =====================================================================
  // /player - the roster.
  // `list` is public; the four mutating subcommands are checked in-handler,
  // because Discord gates whole commands and cannot gate a subcommand.
  // =====================================================================

  new SlashCommandBuilder()
    .setName('player')
    .setDescription('Manage board game night players')
    .addSubcommand(sub =>
      sub
        .setName('add')
        .setDescription('Add a player to the roster')
        .addStringOption(opt =>
          opt.setName('name').setDescription('Player name').setRequired(true)
        )
        .addUserOption(opt =>
          opt.setName('user').setDescription('Discord user to link (optional)').setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('remove')
        .setDescription('Remove a player from the roster and clear their scheduled slots')
        .addStringOption(opt =>
          opt.setName('name').setDescription('Player name').setRequired(true).setAutocomplete(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('toggle')
        .setDescription('Toggle player active status (inactive players are excluded from randomization)')
        .addStringOption(opt =>
          opt.setName('name').setDescription('Player name').setRequired(true).setAutocomplete(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('link')
        .setDescription('Link or unlink a player\'s Discord account')
        .addStringOption(opt =>
          opt.setName('name').setDescription('Player name').setRequired(true).setAutocomplete(true)
        )
        .addUserOption(opt =>
          opt.setName('user').setDescription('Discord user to link (leave empty to unlink)').setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('list')
        .setDescription('List all players')
    ),

  // =====================================================================
  // /update - everything that mutates the rotation.
  //
  // Gated once here rather than on six separate commands, so a subcommand
  // added later inherits the gate instead of needing to remember it. Note
  // that `new` (destructive) and `add` (additive) are now distinct verbs;
  // they used to be one command where the destructive path was the DEFAULT
  // value of an optional `mode` argument.
  // =====================================================================

  new SlashCommandBuilder()
    .setName('update')
    .setDescription('Change the game night rotation')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub =>
      sub
        .setName('new')
        .setDescription('Replace the pending schedule with a fresh random rotation')
        .addStringOption(opt =>
          opt.setName('start_date')
            .setDescription('Date of the first game night')
            .setRequired(true)
            .setAutocomplete(true)
        )
        .addIntegerOption(opt =>
          opt.setName('interval_days')
            .setDescription('Days between game nights (default: 7)')
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('add')
        .setDescription('Append another random rotation to the end of the schedule')
        .addStringOption(opt =>
          opt.setName('start_date')
            .setDescription('First new game night (default: one interval after the last)')
            .setRequired(false)
            .setAutocomplete(true)
        )
        .addIntegerOption(opt =>
          opt.setName('interval_days')
            .setDescription('Days between game nights (default: 7)')
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('done')
        .setDescription('Mark a game night as completed or skipped')
        .addStringOption(opt =>
          opt.setName('player')
            .setDescription('Host name (defaults to the next scheduled host)')
            .setRequired(false)
            .setAutocomplete(true)
        )
        .addStringOption(opt =>
          opt.setName('status')
            .setDescription('New status (default: completed)')
            .addChoices(
              { name: 'Completed — the night happened', value: 'completed' },
              { name: 'Skipped — call it off and push the rotation back', value: 'skipped' }
            )
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('swap')
        .setDescription('Swap the next scheduled dates of two players')
        .addStringOption(opt =>
          opt.setName('player1').setDescription('First player').setRequired(true).setAutocomplete(true)
        )
        .addStringOption(opt =>
          opt.setName('player2').setDescription('Second player').setRequired(true).setAutocomplete(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('edit')
        .setDescription('Step through the schedule to change dates, change hosts, or delete entries')
    )
    .addSubcommand(sub =>
      sub
        .setName('clear')
        .setDescription('Clear all upcoming pending games (roster and history are kept)')
    ),

  // =====================================================================
  // /admin - diagnostics and setup.
  // =====================================================================

  new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Diagnostics and bot configuration')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub =>
      sub
        .setName('setup')
        .setDescription('Post the interactive setup card again')
    )
    .addSubcommand(sub =>
      sub
        .setName('status')
        .setDescription('Show system diagnostics and database status')
    )
    .addSubcommand(sub =>
      sub
        .setName('scan')
        .setDescription('Manually run the background scanners that normally fire on a timer')
        .addStringOption(opt =>
          opt.setName('type')
            .setDescription('Which scan to run (default: all)')
            .addChoices(
              { name: 'Host check-ins (past-due nights)', value: 'checkin' },
              { name: 'Upcoming reminders & attendance summaries', value: 'reminders' },
              { name: 'Unclaimed open nights (past the claim deadline)', value: 'claims' },
              { name: 'Everything', value: 'all' }
            )
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('config')
        .setDescription('Set the announcement/notification channels and daily reminder time')
        .addChannelOption(opt =>
          opt.setName('announcements')
            .setDescription('Channel for RSVPs and schedule updates')
            .setRequired(false)
        )
        .addChannelOption(opt =>
          opt.setName('notifications')
            .setDescription('Channel for plain-text game reminders')
            .setRequired(false)
        )
        .addStringOption(opt =>
          opt.setName('reminder_time')
            .setDescription('Daily reminder time, 24h HH:MM (e.g. 10:00)')
            .setRequired(false)
        )
        .addStringOption(opt =>
          opt.setName('timezone')
            .setDescription('IANA timezone for reminders (e.g. America/Chicago)')
            .setRequired(false)
        )
    ),
].map(cmd => cmd.toJSON());

// Helper to format Date string beautifully (e.g., "Tue 6/2")
export function formatDateBeautiful(dateStr) {
  try {
    const [year, month, day] = dateStr.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    const options = { weekday: 'short', month: 'numeric', day: 'numeric' };
    return date.toLocaleDateString('en-US', options); // E.g., "Tue, 6/2"
  } catch {
    return dateStr;
  }
}

export function formatSwapAnnouncement(entry1, entry2) {
  const p1Mention = entry1.playerDiscordId ? `<@${entry1.playerDiscordId}>` : `**${entry1.playerName}**`;
  const p2Mention = entry2.playerDiscordId ? `<@${entry2.playerDiscordId}>` : `**${entry2.playerName}**`;
  const date1 = formatDateBeautiful(entry1.game_date);
  const date2 = formatDateBeautiful(entry2.game_date);
  return `${p1Mention} and ${p2Mention} swapped dates. ${p2Mention} hosts **${date1}**; ${p1Mention} hosts **${date2}**.`;
}

// "a week" reads better than "7 days", but the rotation interval is measured
// from the actual schedule and is not always 7.
export function intervalLabel(days) {
  if (days === 7) return 'a week';
  if (days === 14) return 'two weeks';
  return `${days} days`;
}

function mentionFor(entry) {
  return entry.playerDiscordId ? `<@${entry.playerDiscordId}>` : `**${entry.playerName}**`;
}

// Shared wording for every path that cancels a night and slides the rotation.
// `reason` is a full sentence explaining why the night is off.
export function buildPostponeEmbed(result, reason) {
  const host = mentionFor(result.skipped);
  const tail = result.shiftedCount > 0
    ? ` Everyone after moves back ${intervalLabel(result.intervalDays)} too — see \`/schedule\`.`
    : '';

  return new EmbedBuilder()
    .setTitle('Game night postponed')
    .setColor(0xF39C12)
    .setDescription(
      `${reason} Nobody loses their turn: ${host} still hosts next, now on ` +
      `**${formatDateBeautiful(result.rescheduled.game_date)}**.${tail}`
    )
    .setTimestamp();
}

export function formatClaimAnnouncement(result) {
  const claimer = mentionFor(result.claimed);
  const original = mentionFor(result.handedOff);
  return `${claimer} is taking **${formatDateBeautiful(result.claimed.game_date)}**. ` +
         `${original} moves to **${formatDateBeautiful(result.handedOff.game_date)}**.`;
}

export function formatGameNightOutcome(hostMention, gameDate, status) {
  const date = formatDateBeautiful(gameDate);
  if (status === 'completed') {
    return `${hostMention} hosted game night on **${date}**.`;
  }
  return `No game night on **${date}** — ${hostMention} skipped or rescheduled.`;
}

// Helper to robustly parse and normalize various date input formats into YYYY-MM-DD
export function parseAndNormalizeDate(inputStr) {
  if (!inputStr) return null;
  let normalized = inputStr.trim().replace(/\//g, '-');
  
  // Resolved in the bot's configured timezone, not the container's.
  if (normalized.toLowerCase() === 'today') return today(0);
  if (normalized.toLowerCase() === 'tomorrow') return today(1);

  // Try YYYY-MM-DD or YYYY-M-D
  let match = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) {
    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    const day = parseInt(match[3], 10);
    const date = new Date(year, month - 1, day);
    if (!isNaN(date.getTime()) && date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // Try MM-DD-YYYY or M-D-YYYY
  match = normalized.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (match) {
    const month = parseInt(match[1], 10);
    const day = parseInt(match[2], 10);
    const year = parseInt(match[3], 10);
    const date = new Date(year, month - 1, day);
    if (!isNaN(date.getTime()) && date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // Try M-D / MM-DD with no year (e.g. "8/11") — default to the current year.
  // Without this the fallback hands "8/11" to new Date(), which fills in a
  // bogus default year (V8 uses 2001).
  match = normalized.match(/^(\d{1,2})-(\d{1,2})$/);
  if (match) {
    const month = parseInt(match[1], 10);
    const day = parseInt(match[2], 10);
    const todayIso = today(0);
    let year = Number(todayIso.slice(0, 4));
    const date = new Date(year, month - 1, day);
    if (!isNaN(date.getTime()) && date.getMonth() === month - 1 && date.getDate() === day) {
      // Roll forward: if that month/day already passed this year, assume next year.
      const candidateIso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      if (candidateIso < todayIso) {
        year += 1;
        const rolled = new Date(year, month - 1, day);
        if (isNaN(rolled.getTime()) || rolled.getMonth() !== month - 1 || rolled.getDate() !== day) {
          return null;
        }
      }
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // If the input LOOKS like one of the numeric shapes above but failed
  // validation, it is simply not a real date -- stop here. Falling through to
  // `new Date()` would silently roll it over, so "2026-02-30" became March 1st
  // and got scheduled without complaint.
  const numericShapes = [
    /^\d{4}-\d{1,2}-\d{1,2}$/,
    /^\d{1,2}-\d{1,2}-\d{4}$/,
    /^\d{1,2}-\d{1,2}$/
  ];
  if (numericShapes.some(re => re.test(normalized))) return null;

  // Fallback for written-out forms like "August 11, 2026".
  const genericDate = new Date(inputStr);
  if (!isNaN(genericDate.getTime())) {
    const year = genericDate.getFullYear();
    const month = String(genericDate.getMonth() + 1).padStart(2, '0');
    const day = String(genericDate.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  return null;
}

// -------------------------------------------------------------
// EMBED SIZE LIMITS
//
// Discord rejects an embed field whose value exceeds 1024 characters, and
// allows at most 25 fields. A rotation line runs ~47 characters, so a single
// field held roughly 22 players before the API started erroring -- invisible
// with a group of four, immediate for a group of thirty.
// -------------------------------------------------------------

export const FIELD_VALUE_LIMIT = 1024;
export const MAX_FIELDS = 25;
export const SELECT_MENU_LIMIT = 25;

export function chunkToFields(name, lines, emptyText = 'None.') {
  if (lines.length === 0) return [{ name, value: emptyText }];

  const safe = lines.map(l =>
    l.length > FIELD_VALUE_LIMIT ? `${l.slice(0, FIELD_VALUE_LIMIT - 1)}…` : l
  );

  const fields = [];
  let buffer = [];
  let length = 0;

  const flush = () => {
    if (buffer.length === 0) return;
    fields.push({
      name: fields.length === 0 ? name : `${name} (continued)`,
      value: buffer.join('\n')
    });
    buffer = [];
    length = 0;
  };

  for (const line of safe) {
    if (length + line.length + 1 > FIELD_VALUE_LIMIT) flush();
    buffer.push(line);
    length += line.length + 1;
  }
  flush();

  if (fields.length > MAX_FIELDS) {
    const kept = fields.slice(0, MAX_FIELDS - 1);
    const dropped = fields.length - kept.length;
    kept.push({
      name: `${name} (truncated)`,
      value: `…and ${dropped} more section(s).`
    });
    return kept;
  }
  return fields;
}

// Select menus hard-cap at 25 options. Say so rather than silently dropping
// entries off the end of the list.
export function truncationNote(total, shown = SELECT_MENU_LIMIT) {
  return total > shown ? `\n\n*Showing the first ${shown} of ${total}.*` : '';
}

// -------------------------------------------------------------
// PERMISSIONS
// -------------------------------------------------------------

// Discord gates whole commands, not subcommands, so /player (which mixes a
// public `list` with roster-mutating subcommands) is checked here instead.
// Server owners can remap every gate per-role under
// Server Settings -> Integrations -> <bot>; we only set sensible defaults.
export function hasManageGuild(interaction) {
  if (!interaction.inGuild()) return false;
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
}

const PERMISSION_DENIED =
  'You need the **Manage Server** permission to change the roster. Use `/player list` to view it.';

// -------------------------------------------------------------
// AUTOCOMPLETE
// -------------------------------------------------------------

function matches(haystack, needle) {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

// Players holding a pending slot, soonest first, one entry per player.
function pendingHosts() {
  const seen = new Set();
  return db.getSchedule()
    .filter(s => s.status === 'pending')
    .sort((a, b) => a.game_date.localeCompare(b.game_date))
    .filter(s => {
      if (seen.has(s.playerName)) return false;
      seen.add(s.playerName);
      return true;
    });
}

export async function handleAutocomplete(interaction) {
  const { commandName } = interaction;
  const focused = interaction.options.getFocused(true);
  const typed = (focused.value || '').trim();

  try {
    // Roster commands suggest every player, flagging inactive ones.
    if (commandName === 'player') {
      const choices = db.getAllPlayers()
        .filter(p => matches(p.name, typed))
        .map(p => ({ name: p.is_active ? p.name : `${p.name} (inactive)`, value: p.name }));
      return interaction.respond(choices.slice(0, 25));
    }

    // Schedule commands only suggest players who actually hold a pending
    // slot, annotated with the date -- which is the disambiguator the old
    // free-text arguments never gave you.
    if (commandName === 'update' && focused.name === 'start_date') {
      const choices = [];
      for (let i = 0; i < 28 && choices.length < 25; i++) {
        const iso = today(i);
        const label = i === 0
          ? `Today - ${formatDateBeautiful(iso)}`
          : i === 1
            ? `Tomorrow - ${formatDateBeautiful(iso)}`
            : formatDateBeautiful(iso);
        if (!typed || matches(label, typed) || iso.includes(typed)) {
          choices.push({ name: label, value: iso });
        }
      }
      return interaction.respond(choices);
    }

    // /update swap (player1/player2) and /update done (player).
    if (commandName === 'update') {
      const choices = pendingHosts()
        .filter(s => matches(s.playerName, typed))
        .map(s => ({
          name: `${s.playerName} - ${formatDateBeautiful(s.game_date)}`,
          value: s.playerName
        }));
      return interaction.respond(choices.slice(0, 25));
    }

    return interaction.respond([]);
  } catch (err) {
    console.error('Autocomplete error:', err.message);
    try {
      await interaction.respond([]);
    } catch {
      // Interaction already expired; nothing useful left to do.
    }
  }
}

// -------------------------------------------------------------
// COMMAND INTERACTION HANDLER
// -------------------------------------------------------------
// Group commands dispatch on "<command>:<subcommand>"; flat commands on the
// command name alone. One canonical string keeps the branch conditions below
// readable regardless of how deeply an action is nested in the command tree.
const GROUPED_COMMANDS = new Set(['player', 'update', 'admin']);

export function resolveAction(interaction) {
  const { commandName } = interaction;
  if (!GROUPED_COMMANDS.has(commandName)) return commandName;
  return `${commandName}:${interaction.options.getSubcommand()}`;
}

// -------------------------------------------------------------
// COMMAND HANDLERS
//
// One function per action. Each receives the interaction plus its resolved
// options and action key, so no handler depends on where its action happens
// to sit in the command tree.
// -------------------------------------------------------------

async function cmdPlayerAdd(interaction, options) {
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
  return interaction.reply({ content: `❌ Error: ${err.message}`, flags: MessageFlags.Ephemeral });
}
}

async function cmdPlayerRemove(interaction, options) {
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
  return interaction.reply({ content: `❌ Error: ${err.message}`, flags: MessageFlags.Ephemeral });
}
}

async function cmdPlayerToggle(interaction, options) {
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
  return interaction.reply({ content: `❌ Error: ${err.message}`, flags: MessageFlags.Ephemeral });
}
}

async function cmdPlayerLink(interaction, options) {
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
  return interaction.reply({ content: `❌ Error: ${err.message}`, flags: MessageFlags.Ephemeral });
}
}

async function cmdPlayerList(interaction) {
const players = db.getAllPlayers();

if (players.length === 0) {
  return interaction.reply({ content: 'No players found. Add players using `/player add`.', flags: MessageFlags.Ephemeral });
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

async function cmdRotationGenerate(interaction, options, action) {
// `new` replaces the pending schedule; `add` appends to it.
const mode = action === 'update:add' ? 'append' : 'new';
const startDateStr = options.getString('start_date');
const intervalDays = options.getInteger('interval_days') || 7;

let targetStartDate;

if (mode === 'new') {
  if (!startDateStr) {
    return interaction.reply({ 
      content: '❌ A starting date is required to generate a new schedule.', 
      flags: MessageFlags.Ephemeral 
    });
  }
  targetStartDate = parseAndNormalizeDate(startDateStr);
  if (!targetStartDate) {
    return interaction.reply({ 
      content: '❌ Invalid date format. Use YYYY-MM-DD or MM/DD/YYYY.', 
      flags: MessageFlags.Ephemeral 
    });
  }
} else {
  // mode === 'append'
  if (startDateStr) {
    targetStartDate = parseAndNormalizeDate(startDateStr);
    if (!targetStartDate) {
      return interaction.reply({ 
        content: '❌ Invalid date format. Use YYYY-MM-DD or MM/DD/YYYY.', 
        flags: MessageFlags.Ephemeral 
      });
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
  return interaction.reply({ content: '❌ Invalid date value.', flags: MessageFlags.Ephemeral });
}

const activePlayers = db.getActivePlayers();
if (activePlayers.length === 0) {
  return interaction.reply({ content: '❌ Error: No active players found.', flags: MessageFlags.Ephemeral });
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

  const scheduleLines = resultSchedule.map((s, index) => {
    const mention = s.playerDiscordId ? `<@${s.playerDiscordId}>` : `**${s.playerName}**`;
    return `**${index + 1}.** ${formatDateBeautiful(s.game_date)} — Host: ${mention}`;
  });

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
  return interaction.reply({ content: `❌ Error: ${err.message}`, flags: MessageFlags.Ephemeral });
}
}

async function cmdSchedule(interaction) {
const allSchedule = db.getSchedule();

const pending = allSchedule.filter(s => s.status === 'pending').sort((a, b) => a.game_date.localeCompare(b.game_date));

const embed = new EmbedBuilder()
  .setTitle('Hosting Schedule')
  .setColor(0x34495E)
  .setTimestamp();

if (pending.length === 0) {
  embed.setDescription('No upcoming game nights scheduled. Use `/update new` to start a rotation.');
} else {
  const upcomingLines = pending.map((s, index) => {
    const mention = s.playerDiscordId ? `<@${s.playerDiscordId}>` : `**${s.playerName}**`;
    const prefix = index === 0 ? '➡️ ' : '• ';
    return `${prefix}**${formatDateBeautiful(s.game_date)}** — Host: ${mention}`;
  });
  embed.addFields(...chunkToFields(`${pending.length} upcoming`, upcomingLines));
}

return interaction.reply({ embeds: [embed] });
}

async function cmdMarkPlayed(interaction, options) {
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
      return interaction.reply({ content: `❌ Player "${targetPlayerName}" not found.`, flags: MessageFlags.Ephemeral });
    }
    target = db.getSchedule()
      .filter(s => s.status === 'pending' && s.player_id === player.id)
      .sort((a, b) => a.game_date.localeCompare(b.game_date))[0];
    if (!target) {
      return interaction.reply({ content: `❌ No pending game night found for ${player.name}.`, flags: MessageFlags.Ephemeral });
    }
  } else {
    target = db.getSchedule()
      .filter(s => s.status === 'pending')
      .sort((a, b) => a.game_date.localeCompare(b.game_date))[0];
    if (!target) {
      return interaction.reply({ content: `❌ No pending scheduled games found to mark as ${status}.`, flags: MessageFlags.Ephemeral });
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

  const hostMention = playedGame.playerDiscordId ? `<@${playedGame.playerDiscordId}>` : `**${playedGame.playerName}**`;
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
  return interaction.reply({ content: `❌ Error: ${err.message}`, flags: MessageFlags.Ephemeral });
}
}

async function cmdSwap(interaction, options) {
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
  return interaction.reply({ content: `❌ Error: ${err.message}`, flags: MessageFlags.Ephemeral });
}
}

async function cmdSetup(interaction) {
  const { buildSetupMessage } = await import('./setup.js');
  return interaction.reply(buildSetupMessage());
}

async function cmdStatus(interaction) {
try {
  const { lastDmCheckTime } = await import('./dmCheck.js');
  const { resolveReminderConfig } = await import('./reminderScheduler.js');
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
  return interaction.reply({ content: `❌ Error fetching system status: ${err.message}`, flags: MessageFlags.Ephemeral });
}
}

async function cmdHelp(interaction) {
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

async function cmdScan(interaction, options) {
await interaction.deferReply({ flags: MessageFlags.Ephemeral });
const type = options.getString('type') || 'all';

try {
  const { runDmCheck, runUpcomingReminderCheck, runAttendanceSummaryCheck, runUnclaimedGameCheck } =
    await import('./dmCheck.js');

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
  return interaction.editReply({ content: `❌ Error running scan: ${err.message}` });
}
}

async function cmdEditSchedule(interaction) {
const { buildScheduleEditorMessage } = await import('./dmCheck.js');
return interaction.reply({ ...buildScheduleEditorMessage(), flags: MessageFlags.Ephemeral });
}

async function cmdClearSchedule(interaction) {
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
  return interaction.reply({ content: `❌ Error clearing schedule: ${err.message}`, flags: MessageFlags.Ephemeral });
}
}

async function cmdConfig(interaction, options) {
{
  const announcements = options.getChannel('announcements');
  const notifications = options.getChannel('notifications');
  const reminderTimeRaw = options.getString('reminder_time');
  const timezoneRaw = options.getString('timezone');

  if (!announcements && !notifications && !reminderTimeRaw && !timezoneRaw) {
    return interaction.reply({
      content: '❌ Provide at least one value to update (`announcements`, `notifications`, `reminder_time`, and/or `timezone`).',
      flags: MessageFlags.Ephemeral
    });
  }

  const { parseReminderTime, isValidTimezone, scheduleReminders } = await import('./reminderScheduler.js');

  // Validate before persisting anything.
  let normalizedReminderTime = null;
  if (reminderTimeRaw) {
    const parsed = parseReminderTime(reminderTimeRaw);
    if (!parsed) {
      return interaction.reply({
        content: '❌ Invalid `reminder_time`. Use 24-hour `HH:MM` (e.g. `10:00` or `18:30`).',
        flags: MessageFlags.Ephemeral
      });
    }
    normalizedReminderTime = `${String(parsed.hour).padStart(2, '0')}:${String(parsed.minute).padStart(2, '0')}`;
  }

  let normalizedTimezone = null;
  if (timezoneRaw) {
    if (!isValidTimezone(timezoneRaw.trim())) {
      return interaction.reply({
        content: '❌ Invalid `timezone`. Use an IANA name like `America/Chicago` or `Europe/London`.',
        flags: MessageFlags.Ephemeral
      });
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
    return interaction.reply({ content: `❌ Error: ${err.message}`, flags: MessageFlags.Ephemeral });
  }
}
}

// -------------------------------------------------------------
// DISPATCH
// -------------------------------------------------------------

const commandHandlers = new Map([
  ['player:add',    cmdPlayerAdd],
  ['player:remove', cmdPlayerRemove],
  ['player:toggle', cmdPlayerToggle],
  ['player:link',   cmdPlayerLink],
  ['player:list',   cmdPlayerList],
  ['update:new',    cmdRotationGenerate],
  ['update:add',    cmdRotationGenerate],
  ['schedule',      cmdSchedule],
  ['update:done',   cmdMarkPlayed],
  ['update:swap',   cmdSwap],
  ['admin:setup',   cmdSetup],
  ['admin:status',  cmdStatus],
  ['help',          cmdHelp],
  ['admin:scan',    cmdScan],
  ['update:edit',   cmdEditSchedule],
  ['update:clear',  cmdClearSchedule],
  ['admin:config',  cmdConfig],
]);

// /player cannot be gated at the Discord level: `list` must stay public and
// Discord gates whole commands, not subcommands. Every other destructive
// action is gated by setDefaultMemberPermissions on the command itself.
const REQUIRES_MANAGE_GUILD = new Set([
  'player:add',
  'player:remove',
  'player:toggle',
  'player:link'
]);

export async function handleCommand(interaction) {
  const action = resolveAction(interaction);
  const handler = commandHandlers.get(action);

  if (!handler) {
    console.warn(`Unrouted command: "${action}"`);
    return interaction.reply({ content: 'That command is not available.', flags: MessageFlags.Ephemeral });
  }

  if (REQUIRES_MANAGE_GUILD.has(action) && !hasManageGuild(interaction)) {
    return interaction.reply({ content: PERMISSION_DENIED, flags: MessageFlags.Ephemeral });
  }

  return handler(interaction, interaction.options, action);
}

// Exposed so tests can assert every declared action has a handler.
export const __commandRoutes = commandHandlers;


// Helper to announce changes to the public channel (e.g. channel ID from .env)
export async function announceToPublicChannel(client, embed) {
  const settings = db.getSettings();
  const channelId = settings.announcementsChannel;
  const notifChannelId = settings.notificationsChannel;

  if (channelId) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (channel && channel.isTextBased()) {
        await channel.send({ embeds: [embed] });
      }
    } catch (err) {
      console.error('Failed to send announcement to public channel:', err.message);
    }
  }

  if (notifChannelId && notifChannelId !== channelId) {
    try {
      const channel = await client.channels.fetch(notifChannelId);
      if (channel && channel.isTextBased()) {
        await channel.send({ embeds: [embed] });
      }
    } catch (err) {
      console.error('Failed to send announcement to notifications channel:', err.message);
    }
  }
}
