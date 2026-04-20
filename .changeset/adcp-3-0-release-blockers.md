---
'@adcp/client': minor
---

AdCP 3.0 release blockers — SDK-level wiring for conformance-runner integration.

**New subpath exports**

- `@adcp/client/compliance-fixtures` — canonical `COMPLIANCE_FIXTURES` data for every hardcoded ID storyboards reference (`test-product`, `sports_ctv_q2`, `video_30s`, `native_post`, `native_content`, `campaign_hero_video`, `gov_acme_q2_2027`, `mb_acme_q2_2026_auction`, `cpm_guaranteed`, etc.) plus a `seedComplianceFixtures(server)` helper that writes fixtures into the state store under well-known `compliance:*` collections. Closes [#663](https://github.com/adcontextprotocol/adcp-client/issues/663).
- `@adcp/client/schemas` — re-exports every generated Zod request schema plus `TOOL_INPUT_SHAPES` (ready-to-register `inputSchema` map covering non-framework tools like `creative_approval` and `update_rights`) and a `customToolFor(name, description, shape, handler)` helper. Closes [#667](https://github.com/adcontextprotocol/adcp-client/issues/667).

**Server (`@adcp/client/server`)**

- `createExpressAdapter({ mountPath, publicUrl, prm, server })` returns the four pieces an Express-mounted agent needs: `rawBodyVerify` (captures raw bytes for RFC 9421), `protectedResourceMiddleware` (RFC 9728 PRM at the origin root), `getUrl` (mount-aware URL reconstruction for the signature verifier), and `resetHook` (delegates to `server.compliance.reset()`). Closes [#664](https://github.com/adcontextprotocol/adcp-client/issues/664).
- `requireAuthenticatedOrSigned({ signature, fallback, requiredFor, resolveOperation })` bundles presence-gated signature composition with `required_for` enforcement on the no-signature path. `requireSignatureWhenPresent` grew an options parameter that carries the same `requiredFor` + `resolveOperation` semantics. Unsigned requests with no credentials on a `required_for` operation throw `AuthError` whose cause is `RequestSignatureError('request_signature_required')`; valid bearer bypass stays valid. Closes [#665](https://github.com/adcontextprotocol/adcp-client/issues/665).
- `respondUnauthorized({ signatureError })` emits a `WWW-Authenticate: Signature error="<code>"` challenge when the rejection comes from the RFC 9421 verifier. `serve()` auto-detects this via `signatureErrorCodeFromCause(err)` — the signed_requests negative-vector grader reads the error code off the challenge, so previously callers had to override the 401 response by hand.
- `AdcpServer.compliance.reset({ force? })` drops session state and the idempotency cache between storyboards. Refuses to run in production-like deployments unless `force: true` is passed. `IdempotencyStore.clearAll` is now an optional method on the store; `memoryBackend` implements it, production backends leave it undefined. Closes [#666](https://github.com/adcontextprotocol/adcp-client/issues/666).

**Testing (`@adcp/client/testing`)**

- Request-signing grader accepts an `agentCapability` option. When present, vectors whose `verifier_capability` can't coexist with the agent's declared profile (`covers_content_digest` disagreement, vector-asserted `required_for` not in agent's list) auto-skip with `skip_reason: 'capability_profile_mismatch'`. `skipVectors` stays available for operator-driven overrides. Closes [#668](https://github.com/adcontextprotocol/adcp-client/issues/668).
