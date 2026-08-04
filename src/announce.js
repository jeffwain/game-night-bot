// Fan an embed out to the configured announcement and notification channels.
//
// Split out of commands.js alongside ./format.js: dmCheck.js calls this from
// four places, and importing it from commands.js was half of the import cycle
// between those two modules.

import * as db from './database.js';

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
