---
'@adcp/sdk': patch
---

fix(testing): matrix harness `runGrader` accepts `overall_status: partial` when zero steps/tracks failed

Closes adcontextprotocol/adcp-client#1209.

Pre-fix, `scripts/manual-testing/agent-skill-storyboard.ts` `runGrader` treated `overall_status === 'partial'` as failure, even when the storyboard runner reported `steps_failed: 0` and `tracks_failed: 0`. This produced false negatives when the runner classified a track as "silent" (no specialism-level criteria definitively scored) — every assertion passed but the harness flagged the pair as failed.

Surfaced empirically by the matrix v2 run on adcontextprotocol/adcp-client#1207. Both creative-template pairs (`build-creative-agent × creative_template`, `build-decisioning-creative-template × creative_template`) ran cleanly: Claude built valid agents, all 6 storyboard steps passed, mocks worked correctly. Harness reported 0/3 because `overall_status` wasn't literally `"passing"`.

Fix: pass when `overall_status === 'passing'` OR when `overall_status === 'partial'` AND `steps_failed === 0` AND `tracks_failed === 0`. Logs a one-line note when the partial-but-clean path triggers so the rationale isn't silent.

This is a dev/test surface fix only — no impact on published runtime code. The matrix harness lives in `scripts/manual-testing/` and is invoked via `npm run compliance:skill-matrix`; adopters' storyboard pipelines use `bin/adcp.js storyboard run` directly and aren't affected.
