---
"@adcp/sdk": patch
---

Fix storyboard runner cascade over-applying `prerequisite_failed` to steps independently `not_applicable` or `missing_tool` (adcp-client#1169).

When an upstream stateful step trips the cascade, the runner now evaluates each downstream stateful step's intrinsic skip-eligibility **before** applying the cascade reason. If the agent never advertised the step's tool, the step is classified as `missing_tool` (`passed: true`) rather than `prerequisite_failed` (`passed: false`). This makes the storyboard report honest for agents with reduced specialism surfaces: `missing_tool` means "this agent doesn't claim this surface, by design", while `prerequisite_failed` means "this agent has a real setup bug affecting state that should have materialized."
