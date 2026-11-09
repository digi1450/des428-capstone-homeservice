# D — retry, fault fixtures and stale-read bid race

9 November 2026. PR #47 retains D's conditional bid insert, equal-jitter backoff
and three HTTP fault scenarios; A's integration follow-up merges main normally
and adds a deterministic two-connection regression. No schema, auth or live mode
is changed. D remains accountable for the area's final integrated evidence.

## What is implemented and tested

- `bidding/repository.js:insertBid` inserts only if the job is still open in the
  same SQLite statement. This closes the gap after `placeBid`'s earlier SELECT.
- `booking/saga.js:recordFailure` adds half-to-full exponential-backoff jitter,
  capped by the existing maximum. Stable keys, persisted saga state, attempts,
  compensation decisions and C's activation recovery remain unchanged. This is
  jitter in the existing saga scheduler, not another nested HTTP retry loop.
- `booking-saga-http.test.js` uses the actual client/adapter/saga against an
  explicitly simulated HTTP Payments server backed by a Map. It covers a lost
  reply, a reply delayed past the deadline and a temporary HTTP 500, retaining
  the original booking/key/intent. It is not a real PG/service/Keycloak fault run.
- The older Promise.all route race test is retained as API behavior coverage;
  it alone does not force an interleaving between synchronous SQLite statements.
- `bid-stale-read.test.js` creates a disposable FILE database using normal startup,
  then a test-only worker opens a second actual SQLite connection. The parent
  reads open, waits while the worker accepts through the actual Bidding service
  and commits, then resumes the stale `placeBid` call. The conditional INSERT must
  reject with 409, leaving one order/accepted winner and no pending late bid.
  Only the test wraps a read statement to control the schedule; production gains
  no yield or test hook. No file database reset is used.

## Observed regression evidence

The new two-connection test fails against the original unconditional INSERT
(`Missing expected exception`: a late bid is inserted). It passes with D's
conditional INSERT. This is controlled stale-read evidence, not a timing-only
Promise.all assertion. With main integrated, the monolith suite passed **218 tests**, no failures/skips, Node 20. CI separately checks the latest pushed head.

The worker and parent close their own connections and remove only their temporary
fixture directory. No useful SQLite file, app stack, token or runtime setting is
used. The integration change preserves the original D commits; no force push.

## Remaining coordination

A owns HTTP transports, C durable command/work/recovery and D the agreed fault/
retry behavior. Preserve saved keys on retry, distinguish unknown outcomes from
safe failure and avoid nested client/saga retry amplification. Validate final
retry budgets/backoff and fault recovery with real A/C services and B credentials.
E supplies final processes/observability/evidence. New financial commands, pending
cancellation, payout/refund/settlement races and restart behavior still require
integrated D/C acceptance; these fixtures do not complete the full Area D rubric.
