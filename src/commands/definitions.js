// The slash-command tree, as registered with Discord.
//
// Declaration only -- no handler logic lives here. testFeatures.js walks this
// array to derive every invocable action and asserts each one has a handler in
// ../commands/index.js, so adding a subcommand here without wiring it up fails
// the build rather than silently doing nothing in Discord.

import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';

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
