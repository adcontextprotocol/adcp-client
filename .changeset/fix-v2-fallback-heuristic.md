---
"@adcp/sdk": patch
---

fix(testing): don't downgrade v3 agents to v2 when get_adcp_capabilities returns non-success

When a v3 agent's capabilities call failed (e.g. due to a wire-shape validation error), the storyboard runner was setting `profile.adcp_version = 'v2'`, which triggered v2.5 schema lookups that don't ship, cascading every subsequent storyboard step into "AdCP schema data for version v2.5 not found" failures. The non-success and null-result branches in `testCapabilityDiscovery` now leave `adcp_version` unset — downstream graders already treat `undefined` and a genuine v2 agent identically for advisory purposes, while avoiding the v2.5 schema-lookup cascade.
