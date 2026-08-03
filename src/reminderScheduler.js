import cron from 'node-cron';
import { resolveReminderConfig } from './config.js';

// Single live cron task. Kept at module scope so we can destroy + recreate it
// when the user changes the reminder time or timezone via /config.
let reminderTask = null;

// (Re)schedule the daily upcoming-reminder cron from current settings.
// Safe to call repeatedly: any existing task is destroyed first.
export function scheduleReminders(client) {
  const { expression, timezone, timeLabel } = resolveReminderConfig();

  if (reminderTask) {
    reminderTask.destroy();
    reminderTask = null;
  }

  reminderTask = cron.schedule(expression, async () => {
    console.log('Running scheduled board game night upcoming reminder scans via cron...');
    try {
      // Imported lazily so this module has no static dependency on dmCheck.js,
      // which imports config.js. Keeps the module graph acyclic.
      const { runUpcomingReminderCheck } = await import('./dmCheck.js');
      await runUpcomingReminderCheck(client);
    } catch (err) {
      console.error('Error running scheduled upcoming reminder check via cron:', err.message);
    }
  }, { timezone });

  console.log(`Daily reminder scheduled for ${timeLabel} (${timezone}) [cron: ${expression}]`);
  return { expression, timezone, timeLabel };
}

// Re-exported so existing imports from './reminderScheduler.js' keep working.
export {
  resolveReminderConfig,
  isReminderWindowOpen,
  parseReminderTime,
  isValidTimezone
} from './config.js';
