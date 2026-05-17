---
---

chore: URL-rot CI guard (#1790) + v6→v7 migration stub (#1494)

Two no-runtime-impact items from the Bucket-B triage sweep:

- `scripts/check-doc-links.ts` + `ci:doc-links` package script. Walks `src/`, `bin/`, `docs/`, `packages/` for `github.com/adcontextprotocol/adcp-client/blob/main/<path>` references and fails CI when any `<path>` doesn't resolve to a file in the repo. Catches doc renames that would silently 404 runtime warnings and JSDoc links.
- `docs/migration-6.x-to-7.x.md` — forward-looking stub for the v6→v7 migration covering `account.mode`-driven upstream URL routing. Marked as STUB so adopters know Phase 2 hasn't shipped; the three migration shapes (resolver method, constructor injection, WeakMap middleware for vendor SDKs that bake URL into the constructor), the `complyTest:` continuity story, and the `account.mode` persistence-across-async-tasks contract are all in place ahead of the SDK code so Phase 2 can't land without the migration guide.

Closes #1790, #1494.
