import {processState} from '../../runtime/process-state.js';
// Explicit preparation for the coordinated provider writer cutover; no env auto-enable.
// This controls only signup wallet and approval notification writes, not all financial/inbox flows.
const selection=processState('modules/providers/event-writes.js');

export function configureProviderEventWrites({ mode } = {}) {
  if (mode !== 'events') throw new TypeError('Provider writer mode must explicitly be events');
  if (selection.value) throw new Error('Provider event writers are already configured');
  selection.value = Object.freeze({ mode });
  return selection.value;
}

export const getProviderEventWrites = () => selection.value;
// Tests or coordinated shutdown only. Do not reset to legacy in response to broker/DB failure.
export const resetProviderEventWrites = () => { selection.value = null; };
