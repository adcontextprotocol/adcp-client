---
'@adcp/sdk': patch
---

test(signing): backfill negative-step coverage on response + webhook verifier tests (#1834)

Code review on #1832 flagged that the verifier test suites ship without negative tests for several documented steps. Adding them keeps the test surface aligned with the verifier's documented behavior:

- **Step 2** `*_signature_params_incomplete` — missing `created` / `expires` / `nonce` / `keyid` / `alg` / `tag` (6 tests per verifier).
- **Step 4** `*_signature_alg_not_allowed` — non-allowlisted alg (e.g. `hs256`).
- **Step 7** kid mismatch — JWKS resolver returns a JWK whose `kid` disagrees with the requested keyid (a misbehaving resolver tripwire).
- **Step 9** `*_signature_revocation_stale` — `RequestSignatureError('request_signature_revocation_stale')` thrown by the revocation store re-maps to the per-verifier taxonomy.
- **Step 9a + 13** `*_signature_rate_abuse` — both the `isCapHit` pre-check phase AND the commit-phase `rate_abuse` return.
- **Step 13** commit-phase `*_signature_replayed` — separate from the pre-check (step 12) which the existing happy-path test already covers via repeat-calls.

Also strengthens `agentUrlForKeyid` to assert the resolver was called with the resolved kid as argument (catches a bug where result attribution might pass the wrong identifier).

20 new tests on the response verifier, 12 on the webhook verifier. No behavior change — purely test coverage backfill.
