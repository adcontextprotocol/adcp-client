---
'@adcp/client': patch
---

Register vector 027 (`webhook-registration-authentication-unsigned`) as a passthrough mutation in the request-signing builder. The fixture carries its adversarial shape in the vector itself (unsigned bearer-auth request with `push_notification_config.authentication` in the body) — no programmatic mutation needed, just preserve fixture bytes through `applyTransport`.

This unblocks CI after the upstream compliance cache added vector 027. The verifier rule it exercises (`#webhook-security` — MUST require 9421 when authentication is present in a webhook registration body) is not yet implemented; vector 027 is added to the unimplemented-verifier skip lists alongside 021–026 until the rule lands.
