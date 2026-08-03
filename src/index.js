import { Client, GatewayIntentBits, Partials, REST, Routes, MessageFlags } from 'discord.js';
import dotenv from 'dotenv';
import fs from 'fs';
import { commands, handleCommand } from './commands.js';
import {
  runDmCheck,
  handleButtonInteraction,
  runAttendanceSummaryCheck,
  runUnclaimedGameCheck
} from './dmCheck.js';
import { scheduleReminders, isReminderWindowOpen } from './reminderScheduler.js';
import { getDbStats, exportWebSnapshot, getSettings } from './database.js';

// 1. DYNAMIC DOTENV LOADING
if (fs.existsSync('/app/data')) {
  process.env.DB_DIR = '/app/data';
}

// docker-compose substitutes `${DISCORD_TOKEN:-}` to an EMPTY STRING when the
// variable isn't set, and dotenv refuses to overwrite a key that already
// exists. Without this, an empty passthrough from compose would permanently
// shadow a perfectly good data/.env file. Treat empty as absent.
for (const key of [
  'DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID', 'DISCORD_CHANNEL_ID',
  'NOTIFICATIONS_CHANNEL_ID', 'CHECK_INTERVAL_MS', 'WEB_EXPORT_DIR', 'TZ'
]) {
  if (process.env[key] === '') delete process.env[key];
}

// Search order: Docker volume, then data/.env relative to cwd (bare `npm start`),
// then a plain .env at the repo root. dotenv won't overwrite keys already set,
// so earlier entries win.
const envCandidates = ['/app/data/.env', 'data/.env', '.env'];
const loaded = envCandidates.filter((p) => fs.existsSync(p));
for (const p of loaded) dotenv.config({ path: p });
console.log(
  loaded.length
    ? `Loaded environment variables from: ${loaded.join(', ')}`
    : 'No .env file found; using ambient environment variables only'
);

// DISCORD_TOKEN is the only required variable. The application ID is read off
// the logged-in client, and guilds are discovered from the gateway, so a new
// self-hoster no longer has to dig up IDs in Developer Mode.
const token = process.env.DISCORD_TOKEN;
const channelId = getSettings().announcementsChannel;
const checkIntervalMs = Number(process.env.CHECK_INTERVAL_MS) || 3600000; // Default: 1 hour

if (!token) {
  console.error('\n❌ ERROR: DISCORD_TOKEN is not set.');
  console.error('   Set it either way:');
  console.error('     • a .env file next to docker-compose.yml   -> DISCORD_TOKEN=...');
  console.error('     • or data/.env inside the mounted volume   -> DISCORD_TOKEN=...');
  console.error('   Get a token at https://discord.com/developers/applications -> Bot -> Reset Token\n');
  process.exit(1);
}

// 2. DISCORD CLIENT INITIALIZATION
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel, Partials.Message]
});

// 3. REGISTER SLASH COMMANDS
const rest = new REST({ version: '10' }).setToken(token);

// Guild-scoped registration updates instantly (global takes up to an hour),
// so we register to every guild the bot is currently in.
async function registerCommandsForGuild(guild) {
  try {
    await rest.put(
      Routes.applicationGuildCommands(client.application.id, guild.id),
      { body: commands }
    );
    console.log(`   • Registered ${commands.length} commands in "${guild.name}" (${guild.id})`);
  } catch (error) {
    console.error(`   • Failed to register commands in "${guild.name}":`, error.message);
  }
}

async function registerSlashCommands() {
  const guilds = [...client.guilds.cache.values()];

  if (guilds.length === 0) {
    console.warn('\n⚠️  The bot is not in any server yet. Invite it with:');
    console.warn(`   ${inviteUrl()}\n`);
    return;
  }

  console.log(`Registering slash commands across ${guilds.length} server(s)...`);
  for (const guild of guilds) {
    await registerCommandsForGuild(guild);
  }
}

// Exactly the permissions the bot uses, nothing more:
// View Channels + Send Messages + Embed Links + Read Message History +
// Use Application Commands. Asking for less makes the invite prompt an easier
// yes for someone installing this in a server you don't control.
const INVITE_PERMISSIONS = '2147568640';

function inviteUrl() {
  const params = new URLSearchParams({
    client_id: client.application.id,
    scope: 'bot applications.commands',
    permissions: INVITE_PERMISSIONS
  });
  return `https://discord.com/api/oauth2/authorize?${params}`;
}

// 4. CLIENT EVENTS
client.once('ready', async () => {
  console.log(`\n🤖 Bot is online as: ${client.user.tag}`);
  console.log(`🆔 Application ID: ${client.application.id}`);
  console.log(`📢 Announcements Channel: ${channelId || 'None (Announcements disabled)'}`);

  const tz = process.env.TZ;
  const containerLocalTime = new Date().toLocaleString();
  if (!tz) {
    console.warn(`\n⚠️ WARNING: The TZ (Timezone) environment variable is not set.`);
    console.warn(`   The container is running in UTC. Current container time: ${containerLocalTime}`);
    console.warn(`   To prevent Direct Messages or game notifications at unexpected hours,`);
    console.warn(`   please set the 'TZ' environment variable (e.g., 'America/Chicago') in Container Manager.\n`);
  } else {
    console.log(`🌍 Timezone: ${tz}`);
    console.log(`   Container Local Time: ${containerLocalTime}\n`);
  }

  try {
    const stats = getDbStats();
    console.log(`📂 Database Loaded Successfully:`);
    console.log(`   • Path: ${stats.dbPath}`);
    console.log(`   • Total Players: ${stats.totalPlayers} (${stats.activePlayers} Active)`);
    console.log(`   • Total Scheduled Games: ${stats.totalGames}`);
    console.log(`     - Pending: ${stats.pendingGames}`);
    console.log(`     - Completed: ${stats.completedGames}`);
    console.log(`     - Skipped/Rescheduled: ${stats.skippedGames}`);
    console.log(`   • Backups: ${stats.backupCount} / 12 (5 rolling + 7 daily) (Last: ${stats.latestBackupTime ? stats.latestBackupTime.toLocaleString() : 'Never'})\n`);
  } catch (err) {
    console.error('❌ Failed to retrieve database statistics:', err.message);
  }

  // Export a fresh public schedule snapshot so the web viewer reflects current state on every boot.
  exportWebSnapshot();

  await registerSlashCommands();

  // Scans on startup — gated to the reminder window so a restart before
  // reminderTime (e.g. a midnight redeploy) doesn't fire posts/DMs early.
  if (isReminderWindowOpen()) {
    console.log('Running initial board game night check-in scans...');
    try {
      await runDmCheck(client);
    } catch (err) {
      console.error('❌ Error running initial DM check:', err.message);
    }

    // Ahead of the summary: a night nobody claimed gets called off here, and
    // the summary must not announce a host who already bowed out.
    console.log('Sweeping open host calls past their claim deadline...');
    try {
      await runUnclaimedGameCheck(client);
    } catch (err) {
      console.error('❌ Error running initial unclaimed-night check:', err.message);
    }

    console.log('Running initial board game night attendance summary scans...');
    try {
      await runAttendanceSummaryCheck(client);
    } catch (err) {
      console.error('❌ Error running initial attendance summary check:', err.message);
    }
  } else {
    console.log('Reminder window not open yet — deferring startup scans until the configured reminder time.');
  }

  // Setup the daily upcoming-reminder cron from configurable settings
  // (reminderTime + timezone in db.json, editable live via /config).
  scheduleReminders(client);

  // Periodic intervals. The scans still run hourly for promptness, but
  // user-facing posts/DMs are gated to the reminder window so nothing
  // lands at midnight when game dates roll over.
  console.log(`Setting up background interval. Checks will run every ${checkIntervalMs / 1000} seconds.`);
  setInterval(async () => {
    if (!isReminderWindowOpen()) {
      console.log('Reminder window closed — skipping scan posts this tick.');
      return;
    }

    console.log('Running scheduled board game night check-in scans...');
    try {
      await runDmCheck(client);
    } catch (err) {
      console.error('❌ Error running scheduled DM check:', err.message);
    }

    console.log('Sweeping open host calls past their claim deadline...');
    try {
      await runUnclaimedGameCheck(client);
    } catch (err) {
      console.error('❌ Error running scheduled unclaimed-night check:', err.message);
    }

    console.log('Running scheduled board game night attendance summary scans...');
    try {
      await runAttendanceSummaryCheck(client);
    } catch (err) {
      console.error('❌ Error running scheduled attendance summary check:', err.message);
    }
  }, checkIntervalMs);
});

// Newly invited servers get their commands immediately, so nobody has to
// restart the container after adding the bot.
client.on('guildCreate', async (guild) => {
  console.log(`Joined new server: "${guild.name}" (${guild.id})`);
  await registerCommandsForGuild(guild);

  // Post the setup card so a brand-new install is configured by clicking
  // rather than by reading documentation.
  try {
    const { buildSetupMessage, findWelcomeChannel } = await import('./setup.js');
    const channel = findWelcomeChannel(guild);
    if (channel) {
      await channel.send(buildSetupMessage());
      console.log(`   • Posted the setup card in #${channel.name}`);
    } else {
      console.warn('   • No channel the bot can post in; run /admin setup once it has access.');
    }
  } catch (err) {
    console.error('   • Failed to post the setup card:', err.message);
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      const { handleAutocomplete } = await import('./commands.js');
      await handleAutocomplete(interaction);
    } else if (interaction.isChatInputCommand()) {
      await handleCommand(interaction);
    } else if (interaction.isButton()) {
      await handleButtonInteraction(interaction);
    } else if (interaction.isAnySelectMenu()) {
      const { handleSelectInteraction } = await import('./dmCheck.js');
      await handleSelectInteraction(interaction);
    } else if (interaction.isModalSubmit()) {
      const { handleModalSubmit } = await import('./dmCheck.js');
      await handleModalSubmit(interaction);
    }
  } catch (err) {
    console.error('Interaction error occurred:', err);
    // Autocomplete interactions have no reply()/deferred state to inspect.
    if (interaction.isAutocomplete()) return;
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ An internal error occurred while processing this request.', flags: MessageFlags.Ephemeral });
    }
  }
});

function shutdown(signal) {
  console.log(`\nReceived ${signal}. Gracefully shutting down Discord Bot...`);
  client.destroy();
  console.log('Discord Client destroyed. Goodbye!');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ UNHANDLED REJECTION AT:', promise, 'REASON:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('❌ UNCAUGHT EXCEPTION THROWN:', error);
  // Do NOT keep running. Node's state is undefined after this, and a process
  // that stays alive but broken never trips Docker's `restart: unless-stopped`
  // -- so the bot looks healthy while silently sending nothing.
  console.error('Exiting so the container restart policy can recover.');
  process.exit(1);
});

client.login(token);
