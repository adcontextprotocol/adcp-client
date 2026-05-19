---
'@adcp/sdk': patch
---

chore(scripts): add `npm run review:codex` — codex-based second-opinion review tool for safety-critical PRs

Tooling-only. No library or CLI behavior changes. Adds `scripts/codex-review.sh` + persona prompts at `scripts/codex-review-prompts/` and documents the dual-stack review pattern at `docs/development/REVIEW-STACKS.md`. Patch-bump because the changeset CI gate requires a non-empty changeset on every PR; the script is dev-only and isn't bundled into the published package (`scripts/` is not in `package.json` `files`).
