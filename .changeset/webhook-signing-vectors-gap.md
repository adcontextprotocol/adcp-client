---
'@adcp/client': minor
---

Close the webhook-signing conformance gap after adcontextprotocol/adcp#2445 merged canonical test vectors.

**Error enum aligned with merged spec.** The webhook-signature error taxonomy (`security.mdx#webhook-callbacks`) folds every window-level failure into a single `webhook_signature_window_invalid` code — `webhook_signature_expired` isn't in the enum. Drops our stray `_expired` code; adds `webhook_signature_rate_abuse` (per-keyid cap exceeded, step 9a) and `webhook_signature_revocation_stale` (revocation list past grace). Verifier step numbers realigned to the canonical 1–13 + 9a.

**Parser now enforces the single-alphabet rule.** RFC 9421 `Signature` / `Content-Digest` tokens that mix base64url (`[-_]`) with standard-base64 (`[+/=]`) are ambiguous and the spec mandates rejection with `*_header_malformed`. Both verifiers inherit the fix.

**Storyboard error enum** extended in lockstep: `signature_window_invalid` replaces `signature_expired`, plus `signature_rate_abuse`, `signature_revocation_stale`, `signature_alg_not_allowed`, `signature_components_incomplete`, `signature_header_malformed`, `signature_params_incomplete`. Exhaustive mapping catches new verifier codes at compile time.

**Conformance harness.** Vendored the 7 positive + 21 negative vectors from adcontextprotocol/adcp under `test/fixtures/webhook-signing-vectors/` (AdCP tarball hasn't re-released yet; swap to `compliance/cache/...` on the next sync). Every vector runs through `verifyWebhookSignature` — passing vectors verify cleanly, negative vectors throw with byte-matching error codes. State-dependent vectors (replay, revocation, rate-abuse, revocation-stale) install their `test_harness_state` into fresh stores per vector. 2 positive vectors (`004-default-port-stripped`, `005-percent-encoded-path`) are skipped pending an upstream regeneration — their baked signatures contradict the request-signing canonicalization rules the webhook spec inherits.
