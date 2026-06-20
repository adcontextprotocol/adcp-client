---
'@adcp/sdk': patch
---

Restore `comply()` `timeout_ms` semantics so the budget stops new storyboards from starting instead of aborting the active assessment and reporting reachable agents as unreachable.
