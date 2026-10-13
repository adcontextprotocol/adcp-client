---
'@adcp/sdk': minor
---

Add experimental, opt-in AdCP 3.3 agent identity (#3233). The wire pin stays AdCP 3.2 and the RFC 9421 profile is unchanged.

- **Web Bot Auth verification**: `verifyWebBotAuthRequest`, `usesWebBotAuth` profile selection, and `createExpressVerifier({ webBotAuth })` / `createAdcpServer({ signedRequests: { webBotAuth } })`. Signers are identified by the covered `Signature-Agent` origin, keys come from `WebBotAuthKeyDirectoryResolver` keyed by `(origin, thumbprint)` with signed-directory validation, nonces are claimed per origin, relays must cover earlier signatures, and failures answer `400`, `403` with `Accept-Signature`, or `429` instead of `request_signature_*` codes.
- **Origin revocation**: `OriginRevocationChecker` verifies `governance-revocations.json` JWS lists at the origin, retains every revocation (bounded), keeps the most severe RFC 5280 `revocation_details` entry, measures staleness against the signed `next_update`, and fails only spend-committing operations closed when status is unavailable. `signRevocationList` and `adcp signing revocation-list` publish the list.
- **Binding and authority**: a verified, unbound origin is identity-established: it proceeds as an anonymous caller (or with an attached identity but no credential on `unboundFor` operations), and the `BuyerAgentRegistry` `onIdentityEstablished` hook receives it. `OriginBindings` and `TrustRecordEvaluator.bind` bind one principal per origin, require explicit approval to bind onto an RFC 9421 principal, re-evaluate the operator's trust record, and refuse an RFC 9421 downgrade for a bound origin.
- **Trust records and grants**: `TrustRecordEvaluator` (derived eTLD+1 record, pinned PSL, SSRF rules, 2 MiB cap, strict parse, one `authoritative_location` hop, polling-bounded cache, fail closed), `validateTrustRecord`, `TrustGrantEvaluator`, and `createTrustGrantGate` for `accounts.trustGrants`, which returns `PERMISSION_DENIED` with `grant_absent` before any `sync_accounts` upsert.
- **Signing and publishing**: `request_signing.profile: 'web-bot-auth'` (requires the seller to advertise the profile; never downgrades), `signWebBotAuthRequest`, `signKeyDirectory`, `keyDirectoryNeedsRenewal`, and the CLI `adcp signing generate-key --profile web-bot-auth`, `key-directory`, `verify-directory`, and `trust-json validate`. `verify-vector` also runs WBA vectors.
- **Types**: draft types for trust.json v1, onboarding posture, principal relationships, the new `principal.changed` reasons, `grant_absent`, and `revocation_details`, pinned to upstream draft commits.
- **Client**: `validation.experimentalAgentIdentity` accepts the draft `get_principal` `relationship`.
- RFC 9421-only signing and verifier configuration emit a one-time `DeprecationWarning`; the profile keeps working through 3.x.
- `tldts` is pinned exactly (7.4.11) so the PSL snapshot that derives trust-record operators is the same for every install.
