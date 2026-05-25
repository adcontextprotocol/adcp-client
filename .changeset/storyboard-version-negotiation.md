---
'@adcp/sdk': patch
---

fix: make storyboard runner version negotiation explicit

Storyboards now inherit the AdCP version from the selected compliance cache, suppress the exact `adcp_version` marker for 3.0 cache runs, and opt into explicit 3.1 markers only when running 3.1 storyboards. The compliance runner and CLI also expose cache selection so the runner does not infer the spec line solely from the installed package version.
