# Temporary owner-only Ubuntu CI

11 November2026. Lead authorized a temporary owner-only trial before any team-wide
switch. Workflow routing uses BOTH github.actor == digi1450 AND repository
variable HOMESERVICE_VM_CI == true. Others and the disabled/unset case retain
ubuntu-latest. Actor is the authenticated GitHub account, not the physical user or
branch name. No branch protections, visibility or collaborator rights change.

The repository-scoped runner homeservice-ubuntu-vm uses labels self-hosted,Linux,
ARM64,homeservice-ci. Only one runner is registered, so jobs queue one at a time.
Ubuntu24.04ARM64 in Parallels has4CPU/~8GiBRAM; DockerEngine29.1.3, Compose5.7.0,
Buildx0.38.2, Node22.23.4/npm10.9.9, Python3.12.3 and Git2.43.0 are available.
Downloads were verified with published SHA256. No sudo password was requested.
User-level installation avoids changing the system Docker package or apt config.

A user systemd service homeservice-actions-runner.service starts with the user
session and survives SSH disconnect. Linger is disabled: boot Ubuntu and log in
before expecting jobs. To stop it in Ubuntu:
`systemctl --user stop homeservice-actions-runner.service`.
To return all accounts to hosted routing, set HOMESERVICE_VM_CI=false or delete
that variable; previously queued jobs keep their original runner selection.

Runner credentials stay private on the VM, never in repository files. Only trusted
team PRs should execute on this dedicated VM. Workspaces/caches are persistent;
tests continue to use fresh project names/tmpfs and owned cleanup. Do not run
manual tests concurrently with queued jobs on its Docker daemon. No runner token
or personal Mac credentials are stored in this document.

This is a routing trial, not proof that GitHub billing restrictions allow
self-hosted dispatch or all workflows pass on ARM64. Observe actual jobs/checks
before claiming success. Hosted jobs for teammates can still be blocked by the
repository owner's account billing. Do not disable required checks to disguise
that failure. Team-wide migration remains conditional on trial results.
