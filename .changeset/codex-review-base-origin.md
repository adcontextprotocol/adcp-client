---
'@adcp/sdk': patch
---

chore(scripts): `codex-review.sh --base <branch>` now resolves to `origin/<branch>` after a fetch

Tooling-only. Fixes a footgun caught while reviewing #1866: `--base main` was reading the local `main` branch, not `origin/main`. Stale local `main` (the default state on most dev machines) produced a fabricated diff that included every commit between the user's last `git pull` and HEAD — codex returned a review about Redis backends from PRs that had already merged, with no signal to the reviewer that the diff was wrong.

The script now resolves `--base <local-branch>` to `refs/remotes/origin/<branch>` after `git fetch origin <branch>`. Pass an already-qualified ref (`origin/main`, a SHA, a tag) to bypass resolution; pass `--no-fetch` to skip the fetch entirely. Stderr prints the resolved form so callers can confirm: `codex-review: --base main → origin/main`.

`scripts/` is not in `package.json` `files`, so this isn't published. Patch-bump because the changeset CI gate requires a non-empty changeset on every PR. Closes #1871.
