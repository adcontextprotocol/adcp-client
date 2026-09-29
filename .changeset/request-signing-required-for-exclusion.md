---
'@adcp/sdk': patch
---

Storyboard runner: a negative request-signing vector whose `verifier_capability.required_for` names an operation the agent does not declare in its own `request_signing.required_for` now skips `capability_profile_mismatch` instead of failing — the third advertisement axis after content-digest policy and `protocol_methods_required_for`. A 3.x shadow-posture agent (`supported: true`, `required_for: []`) was failing `negative/001-no-signature-header` on every run although the grader's `capabilityMismatch()` already knew to skip it; the storyboard dispatch never fed it the agent's `required_for`. The new `declaredRequiredFor()` reader is fail-closed like `declaredProtocolMethodCoverage()` (absent or malformed declarations grade the vector), and `gradeOneVector` accepts the same narrow `agentRequiredFor` option. Agents declaring `required_for: ["create_media_buy"]` are unchanged.
