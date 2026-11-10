// Next instrumentation, route and RSC bundles must select the same process-owned runtime.
// Never place per-request users or tokens in these cells; only runtime configuration.
export function processState(name) {
  const key = Symbol.for(`edemand.runtime.${name}`);
  return globalThis[key] ??= { value: null };
}
