---
'@adcp/sdk': patch
---

Honor explicit storyboard `requires_tool` gates before stateful failure cascades in single-agent runs, matching routed execution. Missing prerequisites remain benign skips, including the controller-specific skip reason, while genuine failures continue to fail the storyboard.
