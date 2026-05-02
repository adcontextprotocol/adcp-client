---
'@adcp/sdk': patch
---

fix(harness): convert matrix harness `runGrader` from `spawnSync` to async `spawn`

The matrix harness (`scripts/manual-testing/agent-skill-storyboard.ts`) is dev-only and not shipped in the npm package. Tagging this `patch` to satisfy the changeset gate; no published code changes.

Background: the harness boots the mock upstream HTTP server in the same Node process. `spawnSync` blocked the event loop while the grader child waited on agent responses → in-process upstream couldn't tick → agent's upstream calls hung → 120s timeout. Same-process deadlock that #1241 didn't catch (its stdin-close fix was correct but only addressed half the failure path).

Fix: async `spawn` + Promise on whichever of `'error'` or `'close'` fires first. Event loop stays live, upstream serves alongside the grader. Verified: signal_marketplace verify-mode log went from 22 lines (timeout) to 632 lines (full grader JSON) at 1.5s wall.

Resolves the residual hang from #1237.
