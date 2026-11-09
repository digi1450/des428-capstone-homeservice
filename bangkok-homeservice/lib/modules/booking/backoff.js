// Area C — one retry-delay policy for Booking workflow retries (saga steps, activation delivery,
// financial work). Capped exponential backoff with "equal jitter" (50–100% of the capped delay,
// D's #47): concurrent retries spread out, but a delay never collapses to 0, so recovery still
// converges. The workflow key is unchanged across retries. Numbers stay D's policy to tune.
export function retryDelay(attempts, { baseMs, maxMs, random = Math.random }) {
  const capped = Math.min(maxMs, baseMs * 2 ** (attempts - 1));
  return Math.floor(capped * (0.5 + random() * 0.5));
}
