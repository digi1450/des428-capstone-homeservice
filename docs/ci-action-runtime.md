# GitHub Actions runtime compatibility

The CI actions now explicitly use Node24 internally:

- actions/checkout@v5
- actions/setup-node@v5
- actions/upload-artifact@v6 (v5 still declares node20)

Verified from the official versioned action.yml files:
https://github.com/actions/checkout/blob/v5/action.yml
https://github.com/actions/setup-node/blob/v5/action.yml
https://github.com/actions/upload-artifact/blob/v6/action.yml

These actions require runner2.327.1 or newer; this repo uses GitHub-hosted
ubuntu-latest. App/test node-version remains22 and existing Docker runtime choices
are unchanged. This is not application Node24 compatibility evidence. setup-node's
automatic package-manager detection cache is disabled explicitly; workflows with
explicit cache:npm retain their existing lockfile-based caches. Artifact selection,
permissions, triggers, commands, job gates and resource acceptance stay unchanged.

The runtime warning and Ubuntu runner-image migration notice are separate. This
change addresses the action runtime; it does not pin/upgrade Ubuntu or disable
warnings through environment overrides. AI assisted. Validate actual action startup,
setup/cache, post-job cleanup and artifact upload in the PR CI before merging.
