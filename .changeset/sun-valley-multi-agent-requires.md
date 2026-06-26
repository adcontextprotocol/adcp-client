---
'@adcp/sdk': minor
---

Add a known storyboard `multi_agent` runtime requirement. Storyboards that already authored this previously unknown requirement now run when `default_agent` plus step-level `agent:` overrides resolve to at least two distinct entries in `options.agents`; otherwise they continue to skip with `requirement_unmet`.
