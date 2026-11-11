# Documentation-only CI trial

This change builds on the owner-only VM runner trial in PR67. Nine previously
unfiltered pull-request workflows ignore changes ONLY when every changed file is
under `docs/**/*.md` or is one of the listed root Markdown guidance files.
Documentation JSON, scripts, test fixtures, application/config files and workflow
files are not ignored. A mixed documentation+code PR still runs the workflows.
Existing more-specific filters for Area B and full-flow are unchanged. Push-to-main
and workflow_dispatch triggers are unchanged.

A skipped workflow generates NO success check. Reviewers must distinguish no run
from passing tests. At implementation time the main branch has no required
status checks; adding required checks later requires a separately designed always-
reporting gate before enabling path skipping. This change does not edit branch
protection or replace full pre-release/full-stack validation. It only skips
unnecessary tests for an exclusively Markdown documentation PR.

Trial: compare an actual Markdown-only PR against a mixed code/Markdown PR using
the VM runner; record checks and time. Automated workflow-filter behavior must be
verified on GitHub, not inferred from YAML parsing alone. AI assisted this trial.
