---
'@adcp/client': patch
---

Regenerate TypeScript types against latest upstream AdCP schemas.

Purely additive — surfaces new optional capability fields already present in the `adcontextprotocol/adcp` protocol bundle but not yet reflected in the generated types:

- `GetAdCPCapabilitiesResponse.webhook_signing` — RFC 9421 outbound-webhook signing profile (`supported`, `profile`, `algorithms`, `legacy_hmac_fallback`).
- `GetAdCPCapabilitiesResponse.identity` — operator identity posture (`per_principal_key_isolation`, `key_origins`, `compromise_notification`).
- `IdempotencySupported.account_id_is_opaque` — seller-side HKDF-blinded `account_id` flag.
- `governance` capability `aggregation_window_days` — fragmentation-defense aggregation window declaration.
- Misc downstream `targeting_overlay` and related field additions.

No library behavior changes. Unblocks CI on `main` (generated-files sync check was failing against the newer upstream bundle).
