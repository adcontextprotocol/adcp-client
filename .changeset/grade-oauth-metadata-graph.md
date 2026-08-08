---
'@adcp/sdk': minor
---

Add the capability-gated OAuth metadata graph grader for the AdCP 3.2 compliance bundle, including bounded per-hop SSRF-safe discovery, exact issuer validation, shared protected-resource normalization, and the upstream deterministic vector corpus. Unknown authored storyboard checks now fail closed instead of producing a false-green not-applicable result.

Behavior changes: unrecognized authored check values now fail validation instead of passing as `not_applicable`, intentionally enforcing #2455's security-grade release-blocker requirement rather than runner-output-contract v2.0's older fail-open forward-compatibility rule. The existing `resource_equals_agent_url` check now uses the shared security-storyboard resource comparison: scheme and host case plus exact default ports are normalized, while paths (including a trailing slash), userinfo, query strings, and fragments remain byte-significant. Agents that previously passed only because those resource components were discarded may now fail that check.
