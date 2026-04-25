---
'@adcp/client': patch
---

**Fix `version.ts` drift on release.** Changesets bumps `package.json` for the Release PR but doesn't know about `src/lib/version.ts`, so every release left the in-repo `version.ts` stale (e.g., `package.json: 5.17.0` while `version.ts: 5.16.0`). The npm tarball was always correct because `build:lib` runs `sync-version` on the CI runner — but the git tree drifted.

Fix: chain `npm run sync-version` after `changeset version` so the Release PR includes the synced `version.ts`. When merged, both files stay in lockstep.

No runtime behavior change. The published package's `LIBRARY_VERSION` was already correct via the build-time sync; this just keeps the git source-of-truth honest.
