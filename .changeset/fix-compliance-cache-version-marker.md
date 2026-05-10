---
"@adcp/sdk": patch
---

Fix compliance cache staleness: write tracked `compliance/CACHE_VERSION` marker

`compliance/cache/` is gitignored (populated at sync/publish time) so
compliance-only spec bumps — new storyboard YAMLs, fixed `idempotency_key`
strings — never triggered a PR from `schema-sync.yml`. The diff guard only
watched `src/lib/types/`, `src/lib/agents/`, and `package.json`, making it
blind to spec changes that don't touch TypeScript schemas.

Fixes the silent mismatch where `--version` advertised one AdCP version while
`compliance/cache/` contained storyboards from an older release — causing false
positives and false negatives in buyer-side storyboard validation.

Changes:
- `scripts/sync-schemas.ts` now writes `compliance/CACHE_VERSION` (tracked in
  git, one level above the gitignored `compliance/cache/`) after every tarball
  sync; the file contains the `adcp_version` from the tarball's `index.json`.
- `schema-sync.yml` diff guard now includes `compliance/CACHE_VERSION` so
  compliance-only spec bumps trigger an automated PR.
- `ci.yml` gains a post-sync validation step that asserts
  `compliance/CACHE_VERSION` matches `ADCP_VERSION`, catching version drift
  before it reaches npm.
