---
---

test(capabilities): drift guard for *_TOOLS arrays vs manifest.json — stage 2 of #1192. No library/runtime change. Test-only addition asserting every tool in the hand-curated `*_TOOLS` arrays in `src/lib/utils/capabilities.ts` is a recognized manifest tool. See PR #1298 for the design call against mechanical migration.
