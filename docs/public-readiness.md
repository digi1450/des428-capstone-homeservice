# Public repository readiness checklist (DES428)

This repository contains an academic capstone and synthetic/demo data. This checklist is a preparation record, **not authorization to switch repository visibility**.

## Completed in this preparation branch

- [x] Use `ubuntu-latest` directly in all 11 GitHub Actions workflows (15 `runs-on` entries). No VM fallback or `HOMESERVICE_VM_CI` routing in these workflow files.
- [x] Keep unfinished legacy manifest PR #65 separate.
- [x] Close the obsolete documentation-only CI experiment PR #68 without merging.
- [x] Keep all implementation tests, steps, and workflow event/paths filters unchanged.

## Required checks before changing visibility

- [ ] **Merge this cleanup PR to `main`** after reviewing changes. The current `main` still supports VM routing until then.
- [ ] In **Settings > Actions > Runners**, verify the repository has no registered `homeservice-ubuntu-vm` self-hosted runner. GitHub connector's exposed endpoint cannot confirm the current registration list.
- [ ] In the Ubuntu VM, verify `systemctl --user is-active homeservice-actions-runner.service` returns `inactive` (or `unknown`), and `systemctl --user is-enabled homeservice-actions-runner.service` returns `disabled` (or `not-found`). Stop/disable the service if needed; ensure runner registration has been removed from GitHub. Previous GitHub job logs prove this runner executed tasks, not that it remains connected.
- [ ] Delete or set the repository variable `HOMESERVICE_VM_CI` to `false`; it becomes unused after this PR merges.
- [ ] Inspect **all branches, commit history, PR discussions, GitHub Actions logs and artifacts** for real secrets, deploy credentials, personal infrastructure details or production data; currently only targeted file searches and example logs/artifacts metadata have been reviewed. Do not interpret a clean working tree as proof that historical secrets are absent.
- [ ] Check whether demo credentials in README/seed fixtures are used by any reachable non-demo deployment. Rotate them if reused.
- [ ] Confirm the team's rights to publish the inherited monolith/source code, and agree on a license if intended. GitHub visibility is not a license grant.
- [ ] Review **Settings > Actions > General** and **Settings > Branches / Rulesets** to limit PR workflow permissions; consider `permissions: contents: read`, read-only PR token defaults, explicit approvals for outside contributors, restricted artifact retention and trusted third-party Actions. Never allow untrusted PR code to run on personal VM runners.
- [ ] Review README wording, which currently describes this as a private course repository.
- [ ] Confirm hosted CI runs on `ubuntu-latest` for a trusted PR after credit quota permits; `main` push checks should not be bypassed if queued. Re-review all checks after visibility is public.
- [ ] Change visibility to **Public** only after explicit owner approval.

## Visibility and historical exposure

Making a private GitHub repository public can expose past branches, commits, PRs, issue discussions, and Actions execution data. Removing secrets from only the current default branch is not sufficient. In cases of genuine secret exposure, revoke/rotate the secret first; then consider history rewriting and GitHub's support/documentation as appropriate. Closing a PR does not erase its discussions or code history.

## Runner rollback note

The historical instructions in `docs/owner-vm-ci-handoff.md` describe a temporary VM routing experiment and are retained as archival history. The permanent hosted-runner path is `ubuntu-latest`.
