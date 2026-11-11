# Markdown-only pull-request CI fast path

12 November2026. This adopts only the path-filter patch from closed trial PR68
on current main after PR79. PR69 was a temporary probe and is not product work.
No VM/self-hosted runner setup or historical runner configuration is restored.

Nine previously unfiltered pull-request workflows now use the same `paths-ignore`:

- `docs/**/*.md`
- `README.md`
- `AGENTS.md`
- `OWNERS.md`
- `CONTRIBUTING.md`

A workflow is skipped only when every changed file matches these patterns.
Changes to source, workflow YAML, Compose, JSON/contracts/fixtures, scripts,
lockfiles or any other unlisted file continue to trigger those nine workflows,
even when the PR also edits documentation. Markdown outside this allowlist
(for example `services/README.md`) conservatively still triggers them.
Existing Area B, full-flow and legacy-v1.1 positive path filters are unchanged.
The existing push-to-main and manual triggers are also unchanged: this saves
PR test work, not every post-merge run. No jobs, assertions, runners, timeouts,
permissions or test workloads are modified.

A skipped workflow produces no success check. Do not describe absent tests as
passed. At this review, main has no required status checks and no active ruleset;
branch protection was read, not changed. If required checks are added later,
review this design and use an always-reporting gate before requiring a job that
path filters can suppress. Full release/integration acceptance is still necessary.

[GitHub's documented path-filter semantics](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onpushpull_requestpull_request_targetpathspaths-ignore)
include both the all-files skip rule and the pending-required-check caveat.

## Validation boundary

The original PR68/69 trial recorded a GitHub Markdown-only probe with no workflow
runs/checks; that is historical evidence, not a fresh run of this revision.
For this revision, structural validation compares all12 workflows with current
main: only nine `pull_request.paths-ignore` entries change, and all jobs and other
events remain identical. Representative docs-only and mixed/unlisted-file cases
are checked locally; actual mixed workflow-change CI is checked on the new PR
before merge. Local parsing is not a GitHub event-execution test.
