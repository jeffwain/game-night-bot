# Board Game Night Bot

Runs the hosting rotation for a recurring game night. It picks who hosts and
when, posts an RSVP a few days ahead, reminds people the day before, and asks
the host afterwards whether it actually happened.

The same actions are available from a web control panel on your LAN. You run
your own copy; the group's data stays on your disk.

## Setup

### 1. Get a bot token

[Discord Developer Portal](https://discord.com/developers/applications) → **New
Application** → **Bot** → **Reset Token** → copy it.

Leave the privileged intents off. This bot doesn't need them.

### 2. Create two files

Copy the examples from the repo, or start with these.

`docker-compose.yml`

```yaml
services:
  game-night-bot:
    image: ghcr.io/jeffwain/game-night-bot:2
    container_name: game-night-bot
    restart: unless-stopped
    pull_policy: always
    environment:
      - DISCORD_TOKEN=${DISCORD_TOKEN:-}
      - TZ=${TZ:-America/Chicago}
    ports:
      - "8120:8120"
    volumes:
      - ./data:/app/data
```

`data/.env`

```
DISCORD_TOKEN=paste_your_token_here
TZ=America/Chicago
```

### 3. Start it

```bash
docker compose up -d
docker compose logs -f
```

The logs print an invite link. Add the bot to your server, click through the
setup card, then:

```
/player add name: Alice user: @alice
/update new start_date: <pick a date>
```

That's it.

## Commands

`/help` in Discord is the full guide. Discord hides commands from people who
lack the permission.

| | |
|---|---|
| `/schedule` `/games` `/player list` `/help` | Anyone |
| `/player` `/update` | Manage Server |
| `/admin` | Administrator |

Names and dates autocomplete. Dates also accept `today`, `tomorrow`, or `8/11`.

## On its own

- **3 days before:** RSVP post. The host gets a DM to swap, bow out, or leave the rotation.
- **1 day before:** Unclaimed nights are called off; then the attendance summary posts.
- **The next morning:** The host is asked whether it happened.

Scans run hourly, but nothing is sent before your reminder time.

## Web

`http://<host>:8120/` is the control panel — schedule, players, games, settings.
`http://<host>:8120/public` is a read-only page with first names and dates.

There is no password. The panel only answers private (LAN) addresses. Do not
port-forward `/`. To publish the public page, proxy **`/public` only**.
`WEB_ALLOW_REMOTE=true` turns the address check off — only with your own auth
in front.

## Games

The Games tab and `/games` search what the group owns. Link players to their
BoardGameGeek accounts, put `BGG_APP_TOKEN` in `data/.env`
([register a token](https://boardgamegeek.com/applications)), and press **Sync
from BGG**. Geekgroup import and a file drop are also on that tab.

## Config

Almost everything is `/admin config` or the Settings tab. From the environment:

| Variable | |
|---|---|
| `DISCORD_TOKEN` | Required |
| `TZ` | Starting timezone until you set one in Discord |
| `BGG_APP_TOKEN` | Optional, for collection sync |
| `WEB_PORT` | Default `8120`. `0` disables the panel |
| `WEB_ALLOW_REMOTE` | `true` drops the LAN check. Don't. |

## Data

State lives in `data/db.json`, with rolling and daily backups. The game library
is `data/games.json`. You can edit `db.json` while the bot runs; it reloads on
the next read.

## Updating

```bash
docker compose pull && docker compose up -d
```

`:2` follows every 2.x release. Always pull — Docker will not re-check a tag it
already has. `/admin status` reports the running version.

## Development

```bash
npm install
npm test
npm start          # bot + panel
npm run web        # panel only, no Discord
```

Releases: `npm version patch` (or `minor` / `major`). Preflight, tag, and
publish are wired to that one command.

## License

MIT — see [LICENSE](LICENSE).
