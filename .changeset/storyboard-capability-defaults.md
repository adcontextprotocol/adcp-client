---
"@adcp/sdk": patch
---

Apply get_adcp_capabilities schema defaults when evaluating storyboard `equals`/`contains` requires_capability gates. Presence matchers (`present:`) keep absence as the load-bearing signal and do not materialize defaults.
