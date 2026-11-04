# Repository guidance

## Project and scope

This private DES428 team project migrates the supplied Bangkok Homeservice monolith into two business services. Do not expand the task into splitting every context or rewriting the product.

- Read `README.md` for setup, `CONTRIBUTING.md` for Git/review workflow, `OWNERS.md` for A–E accountability, and `docs/team-plan.md` for the proposed boundaries and dependencies.
- The supplied Next.js/SQLite monolith is in `bangkok-homeservice/` and still uses `edemand` internally. Do not rename its internals merely to match the project title.
- Proposed extractions are Notifications and Payments & Wallet, using Express and separately owned PostgreSQL or MySQL databases. These are plans until implemented and verified; inspect current code before making claims.
- Use the course stack described in the team plan. Keep unrelated capabilities in the monolith and avoid unrelated dependency upgrades, formatting sweeps or infrastructure additions.

## Team coordination and boundaries

- A owns extraction/routing across both services; B security; C consistency; D resilience; E observability/delivery. Consult the named owners in `OWNERS.md` when changing their interfaces. Ownership does not prohibit collaborative edits.
- Agree on HTTP routes, payloads/errors, events, token/user mapping and idempotency rules with affected consumers before changing them. Update contracts and callers together.
- Preserve existing user-facing paths, response shapes and access behavior unless the assigned migration task explicitly changes them.
- Each extracted service owns its database. The monolith must stop directly reading/writing migrated tables; services must not use cross-service SQL or a shared database connection as a shortcut.
- Inspect Next.js Server Component reads as well as API handlers: pages can call the service layer directly.
- Keep Booking and Bidding together initially to preserve slot-hold invariants. The current notification relay also updates Catalog/Provider ratings; retain each aggregate write with its data owner when extracting notifications.
- Follow existing JavaScript ESM conventions. In the monolith, keep validation/auth in HTTP handling, business logic in services, and SQL in repositories. Do not copy this SQLite implementation into new services without adapting transactions and constraints to their databases.

## Commands and validation

Run these from the repository root for the original monolith:

```sh
docker compose -f bangkok-homeservice/docker-compose.yml config --quiet
docker compose -f bangkok-homeservice/docker-compose.yml up -d --wait edemand
docker compose -f bangkok-homeservice/docker-compose.yml run --rm test
```

- The test service uses an isolated in-memory database. Run the inherited suite for changes affecting monolith business behavior or integration, plus relevant service/contract tests as those are implemented.
- For API/event changes, verify producer/consumer integration; a single service's unit tests do not establish end-to-end correctness.
- For documentation-only changes, check commands, referenced paths and `git diff --check`; do not rerun application tests without a relevant reason.
- Report actual commands/results and checks not run. Do not invent lint/CI scripts or claim the final root full-stack Compose command exists before it does.
- The original app reseeds its container database on process startup. Do not reset/delete useful data or stop unrelated projects as part of routine checks.

## Git and review

- Inspect `git status` and the current branch first. Preserve others' changes and use a task branch from current `main`; do not force-push, rewrite others' history or resolve conflicts by discarding their work.
- Stage only reviewed files for the task. Keep commits and PRs small; document interface changes, validation and remaining limitations.
- Follow `CONTRIBUTING.md`: collaborator PRs into `main` require at least one approving review from someone with write access other than the PR author. `.github/CODEOWNERS` suggests a review contact but does not make their approval mandatory. `OWNERS.md` describes academic responsibilities, not GitHub access control.
- The repository owner has explicitly enabled admin bypass, but that is not standing authorization for an agent to use it. A request to commit/push does not authorize merging a PR, bypassing review or pushing directly to `main`; do those only when explicitly requested for the task.
- Do not change repository visibility, branch protection or collaborator access without user direction. Keep this repository private.

## Data and evidence

- Keep real secrets in environment variables, never commits, logs or PR bodies. Do not commit `.env`, tokens, live databases, `node_modules`, `.next` or other generated runtime/build data. Examples must contain placeholders rather than real credentials.
- `docs/baseline/2026-11-04/` records the original 61-test run and smoke checks. It is historical evidence, not proof that later changes or migration requirements pass. Do not rewrite old observations to imply a new run.
- Only claim timings, effects, traces, concurrency behavior and test outcomes observed in actual runs. Do not introduce an unsafe race or authorization flaw merely to claim an inherited defect was fixed.
- Team members must understand their implementations and produce their own architecture-defence reasoning from evidence. Track real contributions in `OWNERS.md` and disclose AI assistance in the final dossier as required by the assignment.
