// The command layer's public entry point: the slash-command tree, the
// action-key -> handler routing, and the one permission gate Discord cannot
// express for us.
//
// Handlers live in the sibling modules grouped by command (./player.js,
// ./rotation.js, ./admin.js, ./general.js). Nothing in here should contain
// command logic -- if a branch is growing here, it belongs in a handler.
//
// Note this module deliberately does NOT re-export the helpers in
// ../format.js and ../announce.js. Import those directly. Routing everything
// through one door is how the old commands.js ended up circularly dependent
// with dmCheck.js.

import { PermissionFlagsBits, MessageFlags } from 'discord.js';

import {
  cmdPlayerAdd,
  cmdPlayerRemove,
  cmdPlayerToggle,
  cmdPlayerLink,
  cmdPlayerList
} from './player.js';
import {
  cmdRotationGenerate,
  cmdMarkPlayed,
  cmdSwap,
  cmdEditSchedule,
  cmdClearSchedule
} from './rotation.js';
import { cmdSetup, cmdStatus, cmdScan, cmdConfig } from './admin.js';
import { cmdSchedule, cmdHelp } from './general.js';

// Re-exported so callers need only one import for the whole command layer.
export { commands } from './definitions.js';
export { handleAutocomplete } from './autocomplete.js';

// -------------------------------------------------------------
// ACTION RESOLUTION
//
// Group commands dispatch on "<command>:<subcommand>"; flat commands on the
// command name alone. One canonical string keeps the table below readable
// regardless of how deeply an action sits in the command tree.
// -------------------------------------------------------------

const GROUPED_COMMANDS = new Set(['player', 'update', 'admin']);

export function resolveAction(interaction) {
  const { commandName } = interaction;
  if (!GROUPED_COMMANDS.has(commandName)) return commandName;
  return `${commandName}:${interaction.options.getSubcommand()}`;
}

// -------------------------------------------------------------
// DISPATCH TABLE
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

// -------------------------------------------------------------
// PERMISSIONS
//
// Discord gates whole commands, not subcommands, so /player (which mixes a
// public `list` with roster-mutating subcommands) is checked here instead.
// Every other destructive action is gated by setDefaultMemberPermissions on
// the command itself in ./definitions.js. Server owners can remap every gate
// per-role under Server Settings -> Integrations -> <bot>; we only set
// sensible defaults.
// -------------------------------------------------------------

function hasManageGuild(interaction) {
  if (!interaction.inGuild()) return false;
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
}

const PERMISSION_DENIED =
  'You need the **Manage Server** permission to change the roster. Use `/player list` to view it.';

const REQUIRES_MANAGE_GUILD = new Set([
  'player:add',
  'player:remove',
  'player:toggle',
  'player:link'
]);

// -------------------------------------------------------------
// ENTRY POINT
// -------------------------------------------------------------

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
