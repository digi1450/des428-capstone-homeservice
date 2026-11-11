# Booking legacy bindings and runtime references

Adds a new additive upgrade AFTER both E trace-context steps. Exact old-schema
fingerprints remain supported; unknown/partial schemas still stop. Two owner-local
tables store minimal bindings and a captured manifest/checkpoint; offline import
writes checkpoint state bound, never approved. Schema upgrades, binding writes
and dry-run rollback share one SQLite transaction. Identical replay compares all
rows/checkpoint; changed target retained rows, saga/work/dedupe/attention or partial
binding sets reject without repair. Preflight captures original retained source
rows privately, eliminating target comparison against mutable reread artifacts.

Offline command (Node with monolith dependencies and Python3 installed):
node tools/data-migration/booking-bindings-cli.mjs /absolute/frozen-target.sqlite \
  /absolute/approved-snapshot --expected-manifest-sha256 <independently-approved-digest>
Default dry-run; explicit --apply is a separately reviewed frozen-owner phase.
CLI errors are generic. It cannot approve the checkpoint or inspect another owner
DB with Booking credentials. Step2 must verify Payments and Booking phase receipts,
operator authority and frozen target consistency before approving state.

Runtime uses legacy references ONLY from the local binding joined with an approved
checkpoint and matching immutable Booking owner/amount context, with no saga.
Bound/half-applied/missing/conflicting contexts never show payment ready. Existing
payment view/detail/simulation and durable financial callbacks use the shared
readiness/reference seam; neither callers nor HTTP can create/adopt bindings.
Completion/cancellation snapshots preserve the original approved reference across
recovery. Current flags stay closed; no production approval command is added here.

Local Linux Node20 full monolith303/303 passed, including exact historical upgrade
fixtures, source preservation/dry-run/replay/conflict, and bound-vs-approved runtime
readiness. Test-only approval is direct synthetic fixture setup, not operator auth
or a real two-owner checkpoint. Cross-service acceptance follows in PR3. AI assisted.
