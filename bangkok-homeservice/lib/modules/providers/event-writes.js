// Explicit preparation for the coordinated provider writer cutover; no env auto-enable.
// This controls only signup wallet and approval notification writes, not all financial/inbox flows.
let runtime = null;

export function configureProviderEventWrites({ mode } = {}) {
  if (mode !== 'events') throw new TypeError('Provider writer mode must explicitly be events');
  if (runtime) throw new Error('Provider event writers are already configured');
  runtime = Object.freeze({ mode });
  return runtime;
}

export const getProviderEventWrites = () => runtime;
// Tests or coordinated shutdown only. Do not reset to legacy in response to broker/DB failure.
export const resetProviderEventWrites = () => { runtime = null; };
