---
'@adcp/sdk': minor
---

feat(signing): webhook verifier accepts a reused request-signing key

A signer may now reuse its `adcp_use: "request-signing"` key to sign outbound
webhooks instead of minting a dedicated `adcp_use: "webhook-signing"` key. The
webhook verifier (step 8) accepts a key whose `adcp_use` is either
`"webhook-signing"` or `"request-signing"`; any other purpose
(`response-signing`, `governance-signing`, unknown), absent `adcp_use`, or a
missing `verify` key_op is rejected with `webhook_signature_key_purpose_invalid`.
`webhook_mode_mismatch` is unchanged — it remains reserved for the HMAC-vs-9421
auth-mode selector and is not used for key-purpose failures. The signer helpers
(`signWebhook` / `signWebhookAsync`) accept the same set.

This is safe because cross-protocol confusion is prevented by the RFC 9421
`tag` (`adcp/webhook-signing/v1`, part of the signed base) and mandatory
`content-digest` coverage — not by the key-purpose discriminator. A captured
request signature (`tag=adcp/request-signing/v1`) can never be replayed
against the webhook verifier because step 3 rejects the tag.

A dedicated webhook-signing key remains RECOMMENDED for blast-radius isolation
and independent rotation, but is no longer REQUIRED.

Conformance vectors updated: former negative `008-wrong-adcp-use` is now
positive `008-request-signing-key-reuse`; a new negative `008-wrong-adcp-use`
covers a `response-signing` key (still rejected). Tracks the spec change in
adcontextprotocol/adcp.
