---
'@adcp/sdk': patch
---

Split storyboard runner exclusions from selected-but-skipped steps in compliance summaries.

Runs now report caller-excluded work, such as version gates, explicit request-signing vector filters, live-side-effect opt-outs, and profile exclusions, under `steps_not_selected` / `not_selected_by_reason` instead of inflating `steps_skipped`. Selected steps that could not execute, such as missing tools or missing `comply_test_controller`, remain skipped.

The narrow compliance summary artifact is bumped to schema version 2 and now exposes `not_selected_count`, optional `not_selected` records, `not_selected_by_reason`, and `skipped_by_reason`.
