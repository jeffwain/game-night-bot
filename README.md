# Board Game Night Bot

Runs the hosting rotation for a recurring game night. It picks who hosts and
when, posts an RSVP a few days ahead, reminds people the day before, and asks
the host afterwards whether it actually happened.

Everything it does from Discord it also does from a web control panel on your
LAN, served by the same container.

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
    ports:
      - "8120:8120"
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
| `/games name: <name>` | Search what the group owns. Fuzzy — `trmis` finds *Terraforming Mars*. Expansions are hidden unless you add `expansions: True` |
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
| `BGG_APP_TOKEN` | no | BoardGameGeek XML API application token (`Authorization: Bearer`). Register at [boardgamegeek.com/applications](https://boardgamegeek.com/applications). Keep it in `data/.env`, never in git |
| `TZ` | recommended | Starting timezone, until you set one in Discord |
| `CHECK_INTERVAL_MS` | no | Scan interval, default 1 hour |
| `WEB_PORT` | no | Control panel + public page port, default `8120`. `0` disables both |
| `WEB_HOST` | no | Bind address inside the container, default `0.0.0.0` |
| `WEB_ALLOW_REMOTE` | no | `true` drops the private-address check. Only with your own auth in front |
| `NODE_ENV` | no | `production` in the shipped image. Anything else re-reads the panel's static files per request, so edits show up on refresh |

The timezone you set in Discord wins over `TZ`, and it's the single source for
every date the bot calculates.

---

## Your data

Everything is in `data/db.json`, written atomically so a crash can't corrupt
it. You can edit it by hand while the bot runs; it reloads on the next read.

Backups land in `data/backups/`: **5 rolling** snapshots for fine-grained undo,
plus **7 daily** ones so a week of history survives a busy day. If `db.json`
ever fails to parse, the bot restores from the newest good backup on startup.

The game library is deliberately **not** in `db.json` — it would multiply the
size of every backup for something no one edits by hand. It lives in
`data/games.json`, and the raw pages each sync fetched are kept verbatim in
`data/bgg-raw/` (newest three runs). That archive is the library's backup:
`games.json` can always be rebuilt from it, and fields the panel does not
surface yet — weight, player counts, playing time — are a re-parse away rather
than another crawl.

---

## Updating

```bash
docker compose pull && docker compose up -d
```

`:2` follows every 2.x release. `:2.0` is patches only. `:2.0.0` never moves.

**The `pull` is not optional.** `:2` is a floating tag, and Docker does not
re-check a tag it already has locally — `docker compose up -d` on its own will
keep running a months-old image and report success while doing it. The compose
file sets `pull_policy: always` so `up` re-resolves the tag on its own, but if
you removed that, `pull` first.

On Synology, the Container Manager project UI does not reliably re-pull either.
Either use **Action → Reset** *after* pulling the image, or run the two commands
above over SSH from the project directory.

To check what is actually running, ask the container rather than the UI:

```bash
docker compose exec game-night-bot node -p "require('/app/package.json').version"
```

That reads the version out of the running image, so it cannot be fooled by a
stale tag or a cached layer. `/admin status` in Discord reports the same number.

---

## The web control panel

`http://<the-host>:8120/` — everything the slash commands do, plus the things
that are awkward in a chat box.

| Tab | What you can do |
|---|---|
| **Upcoming** | Change any date or host straight from the row; everything else is behind **Edit** |
| **History** | Record whether each past night was played or called off, see who replied, and write notes |
| **Players** | Rename, link a Discord ID and a BoardGameGeek account, bench someone, add or remove |
| **Games** | Browse and search what the group collectively owns, and sync it from BoardGameGeek |
| **Settings** | Name the group, set the reminder time, timezone and channels — saving reschedules the cron immediately, no restart |

**Edit** on any night opens one dialog holding the rarer and riskier things:
notes, replies, the outcome, the "already sent" flags, calling the night off,
and deleting it. Rows stay readable whether you have five nights or fifty.

A fresh install opens on a short setup checklist rather than empty tables, and
anything that cannot work yet — randomize with nobody in the rotation, add a
night with no players — is disabled with the reason next to it.

**Naming it.** Set a display name under Settings and it replaces "Game Night"
in the panel, the browser tab and the public page. Every install is somebody
else's group; nothing is hardcoded to mine.

**Randomizing** is preview-first: pick a start date and interval, hit
*Randomize*, and you get a proposed rotation you can reroll, re-date, reassign
or drop rows from. Nothing is written until you press *Add to schedule* or
*Replace all upcoming*. Replace only clears **pending** nights — history is
never rewritten by a reroll. The shuffle itself is `rotation.js`, shared with
`/update new` and `/update add`, so both surfaces lay out rotations identically.

Every edit goes through the same `database.js` functions the slash commands
use, so the two stay in step. An open tab re-reads every 30 seconds, so a change
made in Discord shows up without a refresh.

### The game library

The **Games** tab lists what the group owns between them, with each title's
average rating from your own members, the wider Geekgroup average, BGG's global
average, who owns a copy, and when it was last played. The search box is fuzzy —
`trmis` finds *Terraforming Mars* — and it searches expansion names too, showing
the base game when one of its expansions matches.

Collections can come from **BoardGameGeek's XML API** (recommended once you have
an application token) or from **[Geekgroup](https://geekgroup.app)**.

**Sync from BGG.** Put `BGG_APP_TOKEN` in `data/.env` — register an application
at [boardgamegeek.com/applications](https://boardgamegeek.com/applications), then
create a token. Link each player to their BGG account on the Players tab, then
press **Sync from BGG**. Requests go to `boardgamegeek.com/xmlapi2` (not `www`)
with `Authorization: Bearer`. The token never leaves the server and is not
stored in `db.json`. You will not get Geekgroup's group-average or last-played
columns this way; you will get who owns what, our ratings, and expansions folded
under their base game.

**Setting up a Geekgroup sync.** On geekgroup.app, open your group's collection with the
browser's network tab recording. Right-click the `collection.json` request →
**Copy → Copy as cURL**, and paste the whole thing into *Settings → Board game
collection → Captured request*. Press **Save request**, then **Test**.

It has to be the entire request, not just a URL. The collection endpoint is an
undocumented `POST` whose multi-kilobyte JSON body carries the group and its
filters, and whose sign-in rides on session cookies alongside an `Authorization`
header. Nothing short of the real request reproduces it.

The failure mode is the reason for the **Test** button. Ask that endpoint for a
collection it does not think you are entitled to and it does not return a 401 —
it returns **200 with a large public group** (at the time of writing, a group
called *Klatch*: 15,832 games across 214 pages). A sync that "worked" and filled
your library with ten thousand strangers' games is worse than one that failed,
so the sync checks the page count and stops. Test tells you which collection came
back before you commit to a crawl.

The capture contains live session credentials. It is stored in `db.json` and
never sent back to the browser — the panel only reports the method, host, header
*names* and body size, so you can confirm what it saved without it being readable
from a screen. Sessions expire; when Test starts reporting a public group again,
copy a fresh request from a logged-in tab.

**Linking people.** Sync once so the panel learns who is in the group, then pick
each person's BGG account from the dropdown on their row in **Players**. That
link is what turns a column of numeric BGG ids into names, and what scopes the
"our average" column to your group rather than to everyone who shares the
Geekgroup.

**Importing instead.** Drop a file into `data/bgg-import/` and import it from the
Games tab, no network and no token needed. Two formats work:

| File | What you get |
|---|---|
| `.json` — a saved collection API response | Everything: who owns what by name, per-member ratings, last-played dates, expansions folded into their base game |
| `.csv` — Geekgroup's collection export | The whole collection in one file, plus weight, player counts and playing time — but ownership only as a **count**, no per-member ratings, no last-played date, and expansions as flat rows |

The CSV is the quickest way to get the full library browsable; the JSON is what
the per-person columns need. The Games tab says which one built the library, and
the "Owned by" column shows a count rather than pretending nobody owns a game.

**From Discord.** `/games name: <name>` searches the same library and reports the
same columns — your average, the group average, BGG's, who owns a copy, and when
it was last played. Expansions are hidden unless you pass `expansions: True`,
though a base game found *through* one of its expansions still shows up and says
which expansion matched. The panel and the bot import the same scorer
(`src/web/public/search.js`), so a result that ranks first in one ranks first in
the other.

**Rebuild** re-reads whatever the last import or sync archived, without
refetching — run it after linking somebody to a BGG account, since that changes
whose ratings count as yours.

### Access

**There is no password.** The panel answers requests coming from private
network addresses only — `10.x`, `172.16–31.x`, `192.168.x`, loopback and IPv6
unique/link-local. Anything else gets a 403, including the `/api` routes.

That is the intended deployment: a box on your LAN. It also means a stray
port-forward doesn't hand a stranger write access to your schedule.

Two things to know:

- **`WEB_ALLOW_REMOTE=true` turns the address check off.** Only set it if you
  have put real authentication in front of the panel yourself — a VPN, or a
  reverse proxy that requires a login. Without one, anyone who can reach the
  port can rewrite your entire schedule.
- **The check is on the socket's peer address.** If you proxy the panel, the
  peer is the proxy, not the browser — so a reverse proxy on your LAN will
  satisfy the check on behalf of whoever is behind it. Proxy `/public`, never
  `/`.

Bind the published port to one interface (`- "192.168.1.10:8120:8120"`) if the
host also faces the internet. `WEB_PORT=0` turns the panel and the public page
off entirely.

---

## The public schedule page

`http://<the-host>:8120/public` is a read-only page with first names, dates and
status, and nothing else — no Discord IDs, no RSVPs, no notes. It's backed by
`/public/schedule.json`, which is the same shape the old file export wrote.

To publish it, point a reverse proxy at **`/public`** — not at `/`:

```
example.com/games   ->   http://<the-host>:8120/public
```

The page fetches its data with a relative URL, and the server answers the
snapshot at any path ending in `/schedule.json`, so it works whether or not
your proxy rewrites the path prefix.

> **Upgrading from 2.1.x:** `WEB_EXPORT_DIR` is gone, along with the
> `web/games/` static files. The bot no longer writes `schedule.json` to a
> mounted document root — it serves the page itself. Remove the
> `WEB_EXPORT_DIR` environment variable and the `/app/web` volume mount from
> your compose file, publish port 8120, and add the proxy rule above. **Until
> you do, an existing public page will go stale** — nothing overwrites the
> `schedule.json` already sitting in that document root.

---

## Development

```bash
npm install
npm test      # database, feature regressions, rotation, web panel, release guards
npm run lint
npm start     # the bot, plus the panel
npm run web   # ONLY the panel, no Discord connection — for working on the UI
```

`npm run web` serves the panel against `./data` with no gateway connection, so
the header reads "Bot offline" and nothing is announced. Outside
`NODE_ENV=production` the static files are re-read per request, so editing
`app.css` and refreshing is enough — no restart. Point it somewhere harmless
with `DB_DIR=./data-scratch npm run web`, since edits there write for real.

Run from source instead of the published image:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

---

## Releasing

One command. Nothing else.

```bash
npm version patch     # or minor, or major
```

That is the whole process, and it is deliberately not two steps. `npm version`
bumps `package.json` **and** `package-lock.json`, commits both, and creates an
annotated tag **on that commit** — so the tag and the version can never name
different things. The `postversion` hook pushes the commit and the tag together.

Before it bumps anything, `preversion` runs `release-preflight.js`, then lint
and the full test suite. Preflight refuses to release when:

| it stops you | because |
|---|---|
| you're not on `main` | the tag would land on history nobody else has |
| the tree is dirty | unrelated edits ride along into the release |
| `package.json` and `package-lock.json` disagree | `npm ci` fails outright, so the build dies at the install step |
| `main` is behind `origin` | you'd tag a commit that isn't the tip of the branch |
| a tag for the current version exists on a different commit | the previous release never completed — fix that first rather than burying it |

Then the tag push triggers the release workflow, which re-runs the tests,
re-checks that tag, `package.json` and lockfile all agree, builds for amd64 and
arm64, pushes to GHCR, and opens a GitHub Release. On success the `X.Y.Z`,
`X.Y` and `X` image tags all move, so anything following a floating tag picks it
up on the next `docker compose pull`.

### When a tag is wrong

```bash
npm run release:doctor
```

It walks every `vX.Y.Z` tag, reads the `package.json` at the commit each one
points at, and prints the exact commands to fix any that disagree — naming the
commit to move the tag to. It also flags a version that was bumped but never
tagged, which publishes nothing at all, because the workflow only fires on tag
pushes.

This is worth understanding once, because the failure is quiet. A tag whose
commit carries a different version is rejected by the workflow every single
time; the release simply never happens, and bumping again on top leaves the
dead tag behind. `v2.2.1` was stranded exactly this way: tagged on a commit
whose `package.json` still said `2.1.1`, fixed in a later commit that nothing
pointed at.

`npm run release:check` runs preflight on its own, any time, without bumping.

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
| `database.js` | Persistence, backups, recovery |
| `rotation.js` | Rotation layout and cadence, shared by `/update` and the panel |
| `config.js` / `time.js` | Timezone and reminder resolution |
| `customId.js` | Component IDs, and translation of pre-2.0 ones |
| `web/server.js` | The HTTP server, routing and the private-address gate |
| `web/api.js` | The JSON API, a thin layer over `database.js` |
| `web/public/` | The panel (`admin.html` + `app.css` + `app.js`) and the public page |

The panel has **no dependencies and no build step** — `node:http`, one HTML
file, one stylesheet, one script. Measured against the bot running alone, it
adds about **12 MB** resident at idle and settles around **27 MB** under
sustained use, flat rather than creeping.

If you are curious why "flat" is called out: `Intl.DateTimeFormat` pins roughly
27 KB of ICU data per instance, outside the JS heap where nothing reports it.
Building one per request read as a 60 MB climb over a few thousand page loads
with `heapUsed` sitting perfectly still. `time.js` caches them per timezone, and
`npm test` counts constructions so it cannot come back.

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
