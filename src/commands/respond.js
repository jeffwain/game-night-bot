// One way to tell the user something went wrong.
//
// Every handler used to hand-roll `interaction.reply({ content: '❌ …', flags:
// MessageFlags.Ephemeral })`, which meant the ❌ prefix, the ephemeral flag,
// and the reply-vs-editReply choice were all decided independently 22 times.
// cmdScan in particular defers first, so a plain reply() there throws
// InteractionAlreadyReplied.

import { MessageFlags } from 'discord.js';

// Report a problem to the user, ephemerally.
//
// Picks editReply when the interaction has already been deferred or answered.
// Note that ephemerality is fixed at defer time and cannot be set on
// editReply, so the flag is only passed on the fresh-reply path -- a deferred
// interaction is already ephemeral if it was deferred that way.
export function replyProblem(interaction, message) {
  const content = `❌ ${message}`;
  if (interaction.deferred || interaction.replied) {
    return interaction.editReply({ content });
  }
  return interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

// Same, for a caught exception. `context` becomes the leading phrase, so the
// user sees "❌ Error running scan: <message>".
export function replyError(interaction, err, context = 'Error') {
  return replyProblem(interaction, `${context}: ${err.message}`);
}
