---
'@adcp/sdk': minor
---

feat(signing): sign and verify webhooks with the request-signing key

Webhooks are signed with the agent's `adcp_use: "request-signing"` key — there
is no separate webhook key purpose. The webhook verifier (step 8) accepts a key
whose `adcp_use` is `"request-signing"`; the deprecated `"webhook-signing"`
value is still accepted for backward compatibility (pending removal — adcontextprotocol/adcp#5555). Any other
purpose (`response-signing`, `governance-signing`, unknown), absent `adcp_use`,
or a missing `verify` key_op is rejected with
`webhook_signature_key_purpose_invalid`. `webhook_mode_mismatch` is unchanged —
it remains reserved for the HMAC-vs-9421 auth-mode selector and is not used for
key-purpose failures. The signer helpers (`signWebhook` / `signWebhookAsync`)
accept the same set, and the webhook emitter may reuse the request-signing
provider/key.

This is safe because cross-protocol confusion is prevented by the RFC 9421
`tag` (`adcp/webhook-signing/v1`, part of the signed base) and mandatory
`content-digest` coverage — not by the key-purpose discriminator. A captured
request signature (`tag=adcp/request-signing/v1`) can never be replayed
against the webhook verifier because step 3 rejects the tag.

Webhook key isolation, when wanted, is a second `request-signing` key under a
distinct `kid` — not a distinct `adcp_use`.

Conformance vectors: positive `008-request-signing-key-reuse` covers a
request-signing key signing a webhook; negative `008-wrong-adcp-use` covers a
`response-signing` key (rejected); the existing `webhook-signing` positive
vectors continue to exercise the deprecated-but-accepted path. Tracks the spec
change in adcontextprotocol/adcp.
