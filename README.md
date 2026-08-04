# Board Game Night Bot

Runs the hosting rotation for a recurring game night. It picks who hosts and
when, posts an RSVP a few days ahead, reminds people the day before, and asks
the host afterwards whether it actually happened.

You run your own copy. Your group's data stays on your own disk.

## Disclaimers

I'm a designer, not a full-time developer, so yes AI helped me build it. This bot was written with the assistance of Claude Opus 5 and 4.8 models. I've done my best to ensure that it's safe and secure for users beyond me and use on my own internal network and Discord server. I understand how it works and is structured. It's not perfect, but it works for us and I hope you find this as useful as we have.

---

## Setup

### 1. Get a bot token

[Discord Developer Portal](https://discord.com/developers/applications) → **New
Application** → **Bot** → **Reset Token** → copy it.

Leave the privileged intents switched off. This bot doesn't need them.

### 2. Create two files in an empty folder

Example copies are present in each folder that you can rename to get started.

`/docker-compose.yml`

```yaml
services:
  game-night-bot:
    image: ghcr.io/jeffwain/game-night-bot:2
    container_name: game-night-bot
    restart: unless-stopped
    environment:
      - DISCORD_TOKEN=${DISCORD_TOKEN:-}
      - TZ=${TZ:-America/Chicago}
    volumes:
      - ./data:/app/data
```

`/data/.env`

```
DISCORD_TOKEN=paste_your_token_here
TZ=America/Chicago
```

### 3. Start it

```bash
docker compose up -d
docker compose logs -f
```

The logs print an invite link. Open it, add the bot to your server, and it
posts a setup card with channel pickers. Click through that and you're
configured. No further files to edit.

### 4. Add your group

```
/player add name: Alice user: @alice
/update new start_date: <pick a date>
```

That's it. The bot takes over from there.

---

## Commands

Discord hides commands from people who lack the permission, and you can remap
any of it per-role under **Server Settings → Integrations → (bot)**.

| **Anyone** | |
|---|---|
| `/schedule` | Who's hosting, and when |
| `/player list` | The roster |
| `/help` | Command guide, in Discord |

| **Manage Server** | |
|---|---|
| `/player add \| remove \| toggle \| link` | Manage the roster. `toggle` benches someone without deleting their history |
| `/update new` | **Replaces** the schedule with a fresh shuffle |
| `/update add` | Appends another shuffle to the end |
| `/update done` | Mark a night completed or skipped |
| `/update swap` | Trade two people's dates |
| `/update edit` | Change a date or host, or delete an entry |
| `/update clear` | Drop pending games; roster and history survive |

| **Administrator** | |
|---|---|
| `/admin setup` | Re-post the setup card |
| `/admin config` | Channels, reminder time, timezone |
| `/admin status` | Uptime, database stats, scan timings |
| `/admin scan` | Run the background scanners now |

Names and dates autocomplete — start typing and pick from the list. Dates also
accept `today`, `tomorrow`, `8/11`, or `2026-08-11`.

---

## What it does on its own

| When | What happens |
|---|---|
| 3 days before | RSVP post in your channel; the host gets a DM with **Swap with…**, **I'm out**, and **Remove me** buttons |
| 1 day before | Any night still without a host is called off; then the attendance summary posts, tallying the RSVPs |
| The next morning | The host is asked whether the night happened |

Scans run hourly, but nothing is sent before your configured reminder time — so
a restart at 2am doesn't wake anybody up.

### What each button does

`/help` lists these in Discord too, so nobody has to guess mid-decision.

| Button | Where | Effect |
|---|---|---|
| **Swap with…** | Host DM | Trade dates with another upcoming host. Only the two of you move. |
| **I'm out** | Host DM | Posts an open call asking who can cover. A claim is a straight date trade with you. Unclaimed by the day before, the night is called off and the whole rotation slides back one interval — you're still up first. |
| **Remove me** | Host DM | You leave the rotation. Marked inactive, your night is deleted, everyone after moves *up*. |
| **I'll host it** | Channel | Take an open night; the host who bowed out inherits your slot. |
| **I'm in / Maybe / I'm out** | Channel | RSVP only. Never moves a date or a host. |
| **Yes, I hosted** | Check-in DM | Marks the night completed. |
| **Skipped / Rescheduled** | Check-in DM | The night is cancelled, not handed off. You keep your turn on the next slot and everyone behind slides back one interval. |

A skipped night is deliberately **not** given to the next person in line — that
quietly cost them their turn. Skipping postpones; the running order never
changes.

If a host has no linked Discord account, or has DMs closed, the bot posts in
your channel instead of failing quietly.

---

## Configuration

Set it from Discord with `/admin config`. Only these come from the environment:

| Variable | Needed | What it does |
|---|---|---|
| `DISCORD_TOKEN` | **yes** | Your bot token |
| `TZ` | recommended | Starting timezone, until you set one in Discord |
| `CHECK_INTERVAL_MS` | no | Scan interval, default 1 hour |
| `WEB_EXPORT_DIR` | no | Turns on the public schedule page |

The timezone you set in Discord wins over `TZ`, and it's the single source for
every date the bot calculates.

---

## Your data

Everything is in `data/db.json`, written atomically so a crash can't corrupt
it. You can edit it by hand while the bot runs; it reloads on the next read.

Backups land in `data/backups/`: **5 rolling** snapshots for fine-grained undo,
plus **7 daily** ones so a week of history survives a busy day. If `db.json`
ever fails to parse, the bot restores from the newest good backup on startup.

---

## Updating

```bash
docker compose pull && docker compose up -d
```

`:2` follows every 2.x release. `:2.0` is patches only. `:2.0.0` never moves.

On Synology, use **Action → Reset** on the project after pulling.

---

## Optional: a public schedule page

Set `WEB_EXPORT_DIR` and mount a web server's document root:

```yaml
    environment:
      - WEB_EXPORT_DIR=/app/web
    volumes:
      - /web/games:/app/web
```

The bot writes `schedule.json` there on every change, and
`web/games/schedule.html` renders it. First names only, no Discord IDs — it's
built to be served publicly.

---

## Development

```bash
npm install
npm test      # database layer + feature regression tests
npm run lint
npm start
```

Run from source instead of the published image:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

Cut a release:

```bash
npm version minor && git push --follow-tags
```

The tag triggers a workflow that re-runs the tests, refuses to publish if the
tag and `package.json` disagree, builds for amd64 and arm64, pushes to GHCR,
and opens a GitHub Release.

| File | What lives there |
|---|---|
| `index.js` | Startup, command registration, scan scheduling |
| `commands/index.js` | The command layer's entry point: dispatch table and permission gate |
| `commands/definitions.js` | The slash-command tree registered with Discord |
| `commands/player.js` | `/player` handlers |
| `commands/rotation.js` | `/update` handlers |
| `commands/admin.js` | `/admin` handlers |
| `commands/general.js` | `/schedule` and `/help` |
| `commands/autocomplete.js` | Autocomplete for player names and dates |
| `commands/respond.js` | The one way a handler reports a problem to the user |
| `scanners.js` | The four background scans, also run by `/admin scan` |
| `interactions.js` | Button, select, and modal route tables and dispatch |
| `scheduleEditor.js` | The `/update edit` step-through views |
| `hostCalls.js` | Offering a night to the channel when a host bows out |
| `rsvp.js` | RSVP tallying and the self-updating RSVP embed |
| `format.js` | Date parsing, embed wording, Discord size limits |
| `announce.js` | Posting an embed to the configured channels |
| `setup.js` | The first-run setup card |
| `database.js` | Persistence, backups, recovery, web export |
| `config.js` / `time.js` | Timezone and reminder resolution |
| `customId.js` | Component IDs, and translation of pre-2.0 ones |

`format.js`, `announce.js`, `rsvp.js`, `scheduleEditor.js`, and `hostCalls.js`
are leaf modules: the command handlers, the scanners, and the interaction
router all draw on them, and none of them imports back. Import them directly
rather than routing through `commands/index.js` — pulling shared helpers
through the command layer is what made the old `commands.js` and `dmCheck.js`
circularly dependent before 2.1.

`npm test` checks that every command has a handler and that no handler is
unreachable, so adding a subcommand without wiring it up fails the build rather
than doing nothing in Discord.

---

## License

MIT — see [LICENSE](LICENSE).
