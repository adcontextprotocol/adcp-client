---
'@adcp/sdk': patch
---

Retain storyboards with authored root capability predicates when capability-driven
single-agent selection finds none of their required tools. The runner evaluates those predicates
using the selected agent's validated discovery before tool and runtime requirements,
so unrelated protocols receive the existing applicability skip and claimants retain
missing required evidence. Keep legacy ungated selection, explicit-ID execution,
routed-topology selection, routing failures and version-scoped bundle grading unchanged.
