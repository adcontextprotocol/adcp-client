---
'@adcp/client': patch
---
Add `webhook_mode_mismatch` and `webhook_target_uri_malformed` to the webhook-signature error taxonomy (adcp#2467). Verifier now splits key-purpose failures into "no purpose declared" (`key_purpose_invalid`) vs "wrong purpose for mode" (`mode_mismatch`), and rejects malformed `@target-uri` components with a dedicated code before signature computation.
