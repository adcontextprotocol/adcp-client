---
'@adcp/sdk': patch
---

Request-signing grading now honors a vector's `applies_when` condition (adcp#8064). The storyboard probe evaluates it against the agent's discovered `get_adcp_capabilities`, so vector 027 skips as `capability_profile_mismatch` when `webhook_signing.legacy_hmac_fallback` is false or absent instead of failing (#3410). `gradeOneVector` and `gradeRequestSigning` accept `agentCapabilities` for the same check. Supported form: a dotted capability path compared with `==` or `!=` to a JSON scalar; any other expression, or a run without capabilities, still grades the vector.
