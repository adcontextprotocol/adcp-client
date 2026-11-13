---
'@adcp/sdk': patch
---

Refresh the registry OpenAPI snapshot and generated types: compliance results gain `incomplete_bundle_ids`, the relevant bundles (as `kind:id`) that keep Strict Spec partial because their evidence is incomplete, and the not-offered bundle description now covers agents that do not advertise request signing for `signed_requests`. The change is additive.
