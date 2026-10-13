---
'@adcp/sdk': minor
---

Add the opt-in experimental AdCP 3.3 identity rollout: Web Bot Auth requests, relays and signed key directories; origin revocation; trust v1 and demand grants; audited principal binding, restricted open onboarding and relationship notifications; and authoring CLI helpers. Preserve the released 3.2.4 default wire pin and legacy signing behavior. Experimental clients omit injected webhook HMAC credentials only after positive 3.3 signed-webhook negotiation and persist the selected verifier profile. Legacy component parsing now preserves parameters so unsupported parameters fail closed.
