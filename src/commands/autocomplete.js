// Autocomplete suggestions for slash-command options.
//
// Discord gives us 3 seconds and caps every response at 25 choices, so every
// path here is synchronous reads off the in-memory db plus a slice(0, 25).

import * as db from '../database.js';
import { today } from '../config.js';
import { formatDateBeautiful } from '../format.js';

const CHOICE_LIMIT = 25;

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
      return interaction.respond(choices.slice(0, CHOICE_LIMIT));
    }

    // Schedule commands only suggest players who actually hold a pending
    // slot, annotated with the date -- which is the disambiguator the old
    // free-text arguments never gave you.
    if (commandName === 'update' && focused.name === 'start_date') {
      const choices = [];
      for (let i = 0; i < 28 && choices.length < CHOICE_LIMIT; i++) {
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
      return interaction.respond(choices.slice(0, CHOICE_LIMIT));
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
