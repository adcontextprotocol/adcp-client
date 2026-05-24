---
'@adcp/sdk': patch
---

fix: restore 3.1.0-beta.3 CI compatibility across conformance, request signing, and storyboard validation

Aligns conformance sample generation and response validation with the latest schemas, carries `protocol_methods_required_for` through the request-signing verifier/server test harness, and updates storyboard/codegen drift guards for the current compliance cache.
