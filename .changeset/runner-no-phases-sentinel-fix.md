---
'@adcp/client': patch
---

**Fix: storyboard runner no longer fails agents on empty-phases storyboards.**

When a storyboard had `phases: []` (e.g., a placeholder or a `requires_scenarios:`-composed storyboard), the runner emitted a synthetic phase with `passed: false` even though its only step was `skipped: true`. This caused agents to appear to fail on that storyboard in the compliance report, producing a confusing `__no_phases__` entry in the output — a string not in the storyboard-schema's documented grading vocabulary.

Changes:
- Synthetic phase `passed` corrected from `false` → `true` (a skipped step is neutral, not a failure).
- Internal sentinel strings `'__no_phases__'` replaced with `'no_phases'` in `step_id` and `phase_id`, consistent with the documented `RunnerSkipReason` vocabulary.
- When `storyboard.requires_scenarios` is populated, the detail message now explains the structural reason (scenario composition) rather than the generic placeholder message.

Fixes #921.
