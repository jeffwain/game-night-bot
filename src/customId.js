// Interaction component IDs (buttons, select menus, modals).
//
// The old scheme was prefix matching:  customId.startsWith('edit_date_')
// That is order-dependent -- 'edit_date_modal_5' also starts with
// 'edit_date_' -- so reordering the checks silently misroutes a click instead
// of failing loudly. Every ID now uses an explicit, exactly-matched shape:
//
//     <namespace>:<action>[:arg...]
//
// Discord caps custom IDs at 100 characters.

export const SEPARATOR = ':';
const MAX_LENGTH = 100;

// Build a custom ID. Throws rather than letting Discord reject the component
// at send time, where the failure is much harder to trace back to a cause.
export function cid(namespace, action, ...args) {
  const id = [namespace, action, ...args].join(SEPARATOR);
  if (id.length > MAX_LENGTH) {
    throw new Error(`Custom ID exceeds ${MAX_LENGTH} characters: ${id}`);
  }
  return id;
}

// Messages posted before this upgrade still carry the old underscore IDs.
// Without translation, every RSVP button already sitting in a channel and
// every host DM in someone's inbox would go dead the moment the bot restarts.
//
// Sorted longest-prefix-first at module load, so correctness does not depend
// on the order these are written in -- which was the original problem.
const LEGACY_REWRITES = [
  ['edit_select_entry', () => cid('edit', 'selectentry')],
  ['edit_back', () => cid('edit', 'back')],
  ['edit_host_select_', (rest) => cid('edit', 'hostselect', rest)],
  ['edit_date_modal_', (rest) => cid('edit', 'datesubmit', rest)],
  ['edit_datemenu_', (rest) => cid('edit', 'datemenu', rest)],
  ['edit_setdate_', (rest) => {
    const i = rest.indexOf('_');
    return cid('edit', 'setdate', rest.slice(0, i), rest.slice(i + 1));
  }],
  ['edit_delete_', (rest) => cid('edit', 'delete', rest)],
  ['edit_entry_', (rest) => cid('edit', 'entry', rest)],
  ['edit_date_', (rest) => cid('edit', 'datemodal', rest)],
  ['edit_host_', (rest) => cid('edit', 'host', rest)],
  ['rsvp_going_', (rest) => cid('rsvp', 'going', rest)],
  ['rsvp_tentative_', (rest) => cid('rsvp', 'tentative', rest)],
  ['rsvp_out_', (rest) => cid('rsvp', 'out', rest)],
  ['confirm_host_yes_', (rest) => cid('checkin', 'yes', rest)],
  ['confirm_host_skip_', (rest) => cid('checkin', 'skip', rest)],
  ['host_action_swap_', (rest) => cid('host', 'swap', rest)],
  ['host_action_out_', (rest) => cid('host', 'out', rest)],
  ['host_action_remove_', (rest) => cid('host', 'remove', rest)],
  ['host_select_swap_', (rest) => cid('host', 'swapselect', rest)]
].sort((a, b) => b[0].length - a[0].length);

export function translateLegacy(rawId) {
  if (rawId.includes(SEPARATOR)) return rawId; // already the new format
  for (const [prefix, rewrite] of LEGACY_REWRITES) {
    if (rawId === prefix) return rewrite('');
    if (rawId.startsWith(prefix)) return rewrite(rawId.slice(prefix.length));
  }
  return rawId;
}

// Parse a custom ID into an exact-match routing key plus its arguments.
export function parseCid(rawId) {
  const [namespace, action, ...args] = translateLegacy(rawId).split(SEPARATOR);
  return { namespace, action, args, key: `${namespace}${SEPARATOR}${action}` };
}
