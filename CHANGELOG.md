# Changelog

## 5.7.0

### Minor Changes

- 7d33a92: AdCP 3.0 release blockers — SDK-level wiring for conformance-runner integration.

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

- 5b2ebb3: v3 audit follow-ups — tightened per expert review:

  **Build pipeline**
  - `build:lib` now runs `sync-version` before `tsc` so `src/lib/version.ts` can't drift from `package.json` across changeset-driven bumps. `sync-version` now validates both version strings against `/^[0-9A-Za-z.\-+]+$/` to prevent template injection into the generated TS file.

  **sync_creatives validator**
  - New `SyncCreativesItemSchema`, `SyncCreativesSuccessStrictSchema`, and `SyncCreativesResponseStrictSchema` exports. The strict schema enforces: required `creative_id` + `action`; spec's conditional that `status` MUST be absent when `action ∈ {failed, deleted}`; `preview_url` limited to `http(s):` URLs; ISO-8601 `expires_at`; `assignment_errors` key regex. Wired into `TOOL_RESPONSE_SCHEMAS` so pipeline-level strict validation catches per-item drift for `sync_creatives` responses automatically.

  **V3 guard**
  - New `VersionUnsupportedError` with typed `reason` ('version' | 'idempotency' | 'synthetic'). Agent URL stays on the instance property but is omitted from the default message to prevent leakage into shared log sinks.
  - `client.requireV3()` now corroborates the v3 claim: requires `majorVersions.includes(3)`, `adcp.idempotency.replayTtlSeconds` present, and rejects synthetic capabilities. Closes the "lying seller" bypass path.
  - New `allowV2` config option on `SingleAgentClientConfig` — per-client bypass; `ADCP_ALLOW_V2=1` env fallback only applies when `allowV2` is `undefined`. Enables safe use in multi-tenant deployments.
  - `requireV3ForMutations: true` opt-in gates mutating calls before dispatch.

## 5.6.0

### Minor Changes

- 0891b98: Add `multi-pass` multi-instance strategy for storyboard runner (#607)

  Opt-in via `--multi-instance-strategy multi-pass` (CLI) or
  `multi_instance_strategy: 'multi-pass'` (library). Runs the storyboard once
  per replica, each pass starting the round-robin dispatcher at a different
  replica. Ensures each step is exercised against a different replica across
  passes — surfacing bugs isolated to one replica (stale config, divergent
  version, local-cache miss) that single-pass round-robin can't distinguish
  from a success. Default stays `round-robin` to keep CI time predictable.

  `StoryboardResult` gains `passes?: StoryboardPassResult[]` with per-pass
  detail. Top-level `passed_count` / `failed_count` / `skipped_count` and
  `overall_passed` aggregate across passes; top-level `phases` remains the
  first pass for backward compatibility.

  Known limitation: for N=2, offset-shift preserves pair parity, so a
  write→read pair whose dispatch indices differ by an even amount lands
  same-replica in every pass (the canonical property_lists case:
  write at step 0, read at step 2, distance 2). Dependency-aware
  dispatch reading `context_inputs` (tracked as #607 option 2) is the
  recommended path for testing cross-replica state at N=2.

- 63b6de7: Add `requireSignatureWhenPresent(signatureAuth, fallbackAuth)` — presence-gated composition for RFC 9421 signatures (#659)

  `anyOf(verifyApiKey, verifySignatureAsAuthenticator)` has either-or
  semantics: a request with a valid bearer and a present-but-invalid
  signature is accepted because `anyOf` catches the sig adapter's
  `AuthError` and falls through. That's wrong for the `signed-requests`
  specialism, whose conformance vectors include negatives like
  `request_signature_revoked` and `request_signature_window_invalid`
  that must reject even when a bearer is also supplied.

  `requireSignatureWhenPresent` encodes the spec-compliant contract:

  | RFC 9421 signature header present? | Outcome                                                                                                 |
  | ---------------------------------- | ------------------------------------------------------------------------------------------------------- |
  | yes                                | signature authenticator runs; principal / `AuthError` / `null→AuthError` is final — fallback never runs |
  | no                                 | fallback runs verbatim                                                                                  |

  Presence is detected from either `Signature-Input` OR `Signature` — a
  request with only one of the pair is malformed but still signed intent
  and MUST NOT silently fall through to bearer. The existing
  `verifySignatureAsAuthenticator` adapter now recognizes the same pair
  (previously it required `Signature-Input`; a solo `Signature` header
  incorrectly fell through).

  The composed authenticator propagates `AUTH_NEEDS_RAW_BODY` when either
  branch needs it, so `serve()` still buffers `req.rawBody` ahead of
  authentication.

  **Composition guard**: the returned authenticator is tagged
  `AUTH_PRESENCE_GATED`; `anyOf` throws at wire-up time when any child
  carries the tag, because wrapping would re-open the bypass the gate
  exists to prevent. Invert the order instead:
  `requireSignatureWhenPresent(sig, anyOf(bearer, apiKey))`.

  ```ts
  import {
    serve,
    anyOf,
    verifyApiKey,
    verifyBearer,
    verifySignatureAsAuthenticator,
    requireSignatureWhenPresent,
  } from '@adcp/client/server';

  serve(createAgent, {
    authenticate: requireSignatureWhenPresent(
      verifySignatureAsAuthenticator({ jwks, replayStore, revocationStore, capability, resolveOperation }),
      anyOf(verifyApiKey({ keys }), verifyBearer({ jwksUri, issuer, audience }))
    ),
  });
  ```

  New public exports: `requireSignatureWhenPresent`, `AUTH_PRESENCE_GATED`,
  `tagAuthenticatorPresenceGated`, `isAuthenticatorPresenceGated`.

## 5.5.0

### Minor Changes

- c3eb9a1: feat(server): bearer-or-signature composition (#655) + capability overrides (#654)

  Two additions for downstream agents that claim the `signed-requests` specialism
  and/or need to surface per-domain capability fields the framework doesn't
  auto-derive.

  **`verifySignatureAsAuthenticator` (#655).** New adapter that turns
  `verifyRequestSignature` into an `Authenticator` composable with
  `anyOf(verifyApiKey(...), verifySignatureAsAuthenticator(...))`. Lets a single
  endpoint accept either bearer credentials OR a valid RFC 9421 signature —
  previously, mounting the Express-shaped verifier downstream of a bearer gate
  caused signed-but-unauthed requests to fail 401 before the verifier ran.

  ```ts
  import { serve, verifyApiKey, anyOf, verifySignatureAsAuthenticator } from '@adcp/client/server';

  serve(createAgent, {
    authenticate: anyOf(
      verifyApiKey({ keys: { sk_live_abc: { principal: 'acct_42' } } }),
      verifySignatureAsAuthenticator({
        jwks,
        replayStore,
        revocationStore,
        capability: { supported: true, required_for: [], covers_content_digest: 'either' },
        resolveOperation: req => {
          try {
            const body = JSON.parse(req.rawBody ?? '');
            if (body.method === 'tools/call') return body.params?.name;
          } catch {}
          return undefined;
        },
      })
    ),
  });
  ```

  `serve()` now buffers `req.rawBody` before authentication when any wired
  authenticator carries the `AUTH_NEEDS_RAW_BODY` tag (the signature adapter
  sets it; `anyOf` propagates it). Bearer-only and JWT-only configurations are
  unaffected — buffering stays deferred until preTransport runs.

  **`capabilities.overrides` (#654).** New per-domain merge field on
  `AdcpCapabilitiesConfig`. Deep-merges on top of the framework's auto-derived
  `get_adcp_capabilities` response so agents can surface fields like
  `media_buy.execution.targeting.*`, `media_buy.audience_targeting`,
  `media_buy.content_standards.supported_channels`, or
  `compliance_testing.scenarios` without reaching for `getSdkServer()` to
  replace the tool.

  ```ts
  createAdcpServer({
    name: 'My Seller',
    version: '1.0.0',
    mediaBuy: {
      /* handlers */
    },
    capabilities: {
      features: { audienceTargeting: true },
      overrides: {
        media_buy: {
          execution: { targeting: { geo_countries: true, language: true } },
          audience_targeting: {
            supported_identifier_types: ['hashed_email'],
            minimum_audience_size: 500,
          },
        },
        compliance_testing: { scenarios: ['force_media_buy_status'] },
      },
    },
  });
  ```

  Nested objects merge; arrays and primitives replace; `null` on a top-level
  override removes the auto-derived block. Top-level fields the framework owns
  (`adcp`, `supported_protocols`, `specialisms`, `extensions_supported`) stay
  managed by their dedicated config fields.

  New exports from `@adcp/client/server`:
  `verifySignatureAsAuthenticator`, `VerifySignatureAsAuthenticatorOptions`,
  `AUTH_NEEDS_RAW_BODY`, `tagAuthenticatorNeedsRawBody`,
  `authenticatorNeedsRawBody`, `AdcpCapabilitiesOverrides`.

## 5.4.0

### Minor Changes

- e6abfdd: Ship five downstream-ergonomics fixes surfaced while porting a training agent onto 5.3. One public-type change (breaking for pre-release consumers only — the type never reached a stable release), four additive.

  **BREAKING (pre-release only) — `createAdcpServer()` returns `AdcpServer` instead of SDK `McpServer`.** Re-exporting the SDK's `McpServer` type forced consumers through a specific module resolution path. A TypeScript ESM consumer importing `@adcp/client` (CJS) and separately importing `@modelcontextprotocol/sdk` (ESM) got two structurally-identical but distinct `McpServer` types — the SDK's private `_serverInfo` field breaks assignment compatibility between them. Owning the type on our side eliminates the hazard for every consumer. `AdcpServer` exposes `connect`, `close`, and the new `dispatchTestRequest`. Tool registration continues to flow through `createAdcpServer`'s domain-grouped handler config. For seller extensions outside `AdcpToolMap`, pass a `customTools` map in the same config — no `getSdkServer()` escape hatch required. `serve()` accepts both `AdcpServer` and raw `McpServer` (for `createTaskCapableServer` users). See `docs/migration-5.3-to-5.4.md` for the verbatim diffs.

  **`AdcpServer.dispatchTestRequest({ method, params })`** — encapsulated test-only dispatch so downstream harnesses stop writing `(server as any)._requestHandlers.get(...)`. The `'tools/call'` overload returns a typed `CallToolResult`; the generic fallback returns `unknown`.

  **`McpToolResponse.structuredContent` is now optional.** Error responses no longer need to fabricate an empty `structuredContent` to satisfy the type. All built-in success builders still populate it.

  **`SingleAgentClient.validateRequest` drops `schema.strict()`.** The storyboard runner's `applyBrandInvariant` injects top-level `brand`/`account` onto every outgoing request for run-scoped tenancy. Tools whose schema declares neither (`list_creative_formats`, `get_signals`, `activate_signal`, `sync_creatives`) had strict() rejecting the injection client-side BEFORE `adaptRequestForServerVersion` could strip by schema. Non-strict parse lets the injection flow to the adapter. Required-field and shape violations still reject. Typo detection on unknown top-level keys now happens server-side.

  **Storyboard runner `request_signing.transport: 'raw' | 'mcp'`.** Plumbs the existing grader option through the storyboard runner so MCP-only agents can pass the `signed-requests` specialism's vectors — each vector body is wrapped in a JSON-RPC `tools/call` envelope and posted to the `/mcp` mount instead of per-operation HTTP endpoints. Matches the `adcp grade request-signing --transport mcp` CLI flag.

## 5.3.0

### Minor Changes

- b6eb1ff: `createAdcpServer` auto-wires the RFC 9421 verifier when the seller declares the `signed-requests` specialism and provides `signedRequests: { jwks, replayStore, revocationStore }`. Startup-fails when `signedRequests` is configured without the specialism claim; logs a loud error when the specialism is claimed without a `signedRequests` config (to avoid breaking legacy manual `serve({ preTransport })` wiring). Closes the footgun where claiming the specialism didn't enforce it.
- 65d851a: Add `experimental_features` support on capabilities (adcp-client#627).

  `AdcpCapabilities` now carries an `experimentalFeatures?: string[]` field populated from the AdCP 3.0 GA `experimental_features` envelope on `get_adcp_capabilities` responses. New helper `supportsExperimentalFeature(caps, id)` lets consumers gate reliance on `x-status: experimental` surfaces (`brand.rights_lifecycle`, `governance.campaign`, `trusted_match.core`, etc.) on an explicit seller opt-in. `resolveFeature` handles the `experimental:<id>` namespace so `require()`/`supports()` flows work the same way they do for `ext:<name>` extensions.

  The `custom` vendor-pricing variant and the `per_unit` catchup from AdCP 3.0 GA were already picked up in the previous types regeneration — no type-surface changes ship with this release.

- b6eb1ff: Add fluent `result.match({...})` method on `TaskResult`. Mirrors the free-function `match(result, handlers)` so autocomplete on `result.` surfaces the handler-dispatch helper alongside the other accessors. Method is attached non-enumerably by the client when a result leaves `executeTask`/`pollTaskCompletion`/`resumeDeferredTask`, so `JSON.stringify(result)` and `{...result}` are unaffected. For hand-constructed results (test fixtures, custom middleware), call the exported `attachMatch(result)` helper or keep using the free function.
- b6eb1ff: Add `match(result, handlers)` — exhaustive, compile-time-checked handler for the `TaskResult` discriminated union. Replaces manual `if (result.status === ...)` narrowing at response sites. Optional `_` catchall makes handlers optional.

### Patch Changes

- 7d50ecf: Fix `applyBrandInvariant` scoping for tools whose schema declares `account` but not top-level `brand` (e.g. `get_media_buys`, `get_media_buy_delivery`, `list_creatives`). The helper was only injecting top-level `brand` and merging into an existing `account`; when the request-builder produced no `account`, `adaptRequestForServerVersion` would strip the unrecognized top-level `brand` and the run-scoped brand was lost on the wire. Now the helper constructs an `account` (via `resolveAccount(options)`) when the request omits one, so session scoping survives for every schema shape. Non-object `account` values (`null`, arrays) are still passed through unchanged. (adcp-client#643)
- b8edc63: Storyboard `error_code` validation now reads the spec-canonical `data.errors[0].code` envelope (per `core/error.json`), falling back to legacy locations (`adcp_error.code`, `error_code`, `code`, `error.code`) and the regex on `taskResult.error`. Previously, spec-conformant agents returning `{ errors: [...], context }` had their code extracted via regex instead of typed field access.
- cca6c57: Fix `ProtocolResponseParser.getStatus()` misclassifying spec-compliant AdCP v3 domain envelopes as MCP task-status envelopes. Four `ADCP_STATUS` literals (`completed`, `canceled`, `failed`, `rejected`) collide with domain status enums like `MediaBuyStatus` / `CreativeStatus`. Previously, a seller returning `cancel_media_buy` with `{ structuredContent: { status: "canceled", media_buy: {...}, adcp_version: "3.0.0" } }` got routed through `TaskExecutor`'s terminal-failure branch — the client returned `{ success: false, data: undefined, error: "Task canceled" }` on a successful cancellation.

  The parser now disambiguates using an envelope-shape check: exclusive task-lifecycle literals (`submitted`, `working`, `input-required`, `auth-required`) are trusted from `structuredContent.status` unconditionally; shared literals are only treated as task status when the envelope carries no keys outside the `ProtocolEnvelope` allowlist. Otherwise the response falls through to the `COMPLETED` fallback so Zod validators parse the domain payload. Unblocks the `media_buy_state_machine` storyboard on `cancel_buy` / `resume_canceled_buy`. Reported and root-caused by @fgranata in adcp-client#646.

- b6eb1ff: Extend `skills/build-seller-agent/SKILL.md` with a worked GDPR Art 22 / EU AI Act Annex III example — shows `plan.human_review_required` threaded through `createAdcpServer.mediaBuy.createMediaBuy` with `buildHumanOverride` on approval. No code changes.
- b6eb1ff: Flag the webhook HMAC-SHA256 authentication path as SDK-deprecated. Emits a one-time `console.warn` on first use per process; suppress with `ADCP_SUPPRESS_HMAC_WARNING=1`. `@deprecated` JSDoc tag added to `WebhookAuthentication.hmac_sha256`. HMAC remains in the AdCP spec as a legacy fallback for buyers that registered `push_notification_config.authentication.credentials`, so the SDK keeps supporting it — no hard removal date. Migrate to RFC 9421 webhook signatures when your counterparties are ready (see `docs/migration-4.30-to-5.2.md#webhook-hmac-legacy-deprecation`).
- 65d851a: Auto-inject `idempotency_key` on mutating storyboard requests and untyped `executeTask` calls (adcp-client#625).

  The storyboard runner now mints a UUID v4 `idempotency_key` on any mutating step whose `sample_request` omits one — matching how a real buyer operates, so compliance storyboards exercise handler logic rather than short-circuiting on the server's required-field check. Auto-injection applies to `expect_error` steps too, so scenarios that expect specific failures (GOVERNANCE_DENIED, UNAUTHORIZED, brand_mismatch, etc.) reach the error path they named instead of hitting INVALID_REQUEST first. Storyboards that intentionally test the server's missing-key rejection opt out with the new `step.omit_idempotency_key: true` flag.

  The underlying `normalizeRequestParams` helper now derives its mutating-task set from the Zod request schemas (`MUTATING_TASKS` in `utils/idempotency`) rather than a hand-maintained list. The Zod-derived set adds auto-injection for `acquire_rights`, `update_media_buy`, `si_initiate_session`, `si_send_message`, `build_creative`, and the property / collection / content-standards writes — all of which the spec declares as mutating but the hand-maintained list was missing. Any caller using `client.executeTask(<mutating-task>, params)` — typed or untyped — now receives the same auto-injected key the typed methods already minted via `executeAndHandle`.

- b6eb1ff: Add `docs/guides/idempotency-crash-recovery.md` — worked buyer-side recipe for crash-recovery using `IdempotencyConflictError` + `IdempotencyExpiredError` + natural-key lookup + `metadata.replayed`. No code changes.
- 4fd7091: Regenerate TypeScript types for the new `governance-aware-seller` specialism in `AdCPSpecialism`. Pure regeneration from upstream schemas — no code changes.
- 24131aa: Scope replay store by (keyid, @target-uri) instead of keyid alone (adcp#2460). A captured signature on one endpoint can no longer be replayed against another. Pass a `scope` argument to `ReplayStore.has/insert/isCapHit` — existing custom implementations must update their signatures.
- 8455c8e: Fix `adcp storyboard run <agent> --file <path.yaml>` erroring out with "Cannot combine a storyboard ID with --file". The CLI parser was not stripping `--file` and its value from the positional-argument list, so the file path collided with the storyboard-ID slot (adcp-client#637). `--file=<path>` (equals form) is now parsed too.
- 24131aa: Emit a one-time `console.warn` when a client receives v2 capabilities — v2 is unsupported as of AdCP 3.0 GA (2026-04-20, adcp#2220). Suppress with `ADCP_ALLOW_V2=1` env var or `adcp --allow-v2` on the CLI. Functional behavior unchanged — v2 paths still execute, just loud about it.
- 24131aa: Add `webhook_mode_mismatch` and `webhook_target_uri_malformed` to the webhook-signature error taxonomy (adcp#2467). Verifier now splits key-purpose failures into "no purpose declared" (`key_purpose_invalid`) vs "wrong purpose for mode" (`mode_mismatch`), and rejects malformed `@target-uri` components with a dedicated code before signature computation.

## 5.2.0

### Minor Changes

- 9c2d5cc: `BrandJsonJwksResolver` — discover a sender's webhook-signing keys from their `brand.json`.

  Receiver-side ergonomic: instead of pre-configuring a `jwks_uri` per counterparty, point the verifier at the sender's `brand.json` and the resolver walks `agents[]`, extracts the right `jwks_uri`, and delegates caching to `HttpsJwksResolver`. Delivers the `brand.json → JWKS auto-resolver` piece of the #631 follow-up list.

  **New**
  - `BrandJsonJwksResolver` — implements `JwksResolver`, pluggable into `verifyWebhookSignature.jwks` (or `verifyRequestSignature.jwks`).
  - `BrandJsonResolverError` + `BrandJsonResolverErrorCode` — typed error surface (`invalid_url`, `invalid_house`, `redirect_loop`, `redirect_depth_exceeded`, `fetch_failed`, `invalid_body`, `schema_invalid`, `agent_not_found`, `agent_ambiguous`, `jwks_origin_mismatch`). Verifier callers can fold transient failures into `webhook_signature_key_unknown` without parsing error message strings.
  - `BrandAgentType`, `BrandJsonJwksResolverOptions` — selector types (agent type plus optional `agentId` / `brandId`).

  **Behavior**
  - Follows `authoritative_location` and `house` redirect variants up to `maxRedirects` hops (default 3); loops and depth-exceeded chains are rejected explicitly.
  - Structurally validates every redirect target (scheme, no userinfo, no fragments smuggled into loop detection) before dispatch; the `house` string variant is gated on a bare-hostname regex so an attacker-supplied brand.json can't inject userinfo or paths via the `https://${house}/…` interpolation.
  - Honors the spec fallback: when `jwks_uri` is absent on the selected agent, defaults to `/.well-known/jwks.json` on the origin of the agent's `url` — **but only when that origin matches the final brand.json origin**. Cross-origin fallback is rejected with `jwks_origin_mismatch`; publishers hosting their agent on a different origin must declare an explicit `jwks_uri`.
  - Brand.json cache tracks `ETag` + `Cache-Control: max-age` (capped by `maxAgeSeconds`, default 1h). Unknown `kid` cascades: the inner JWKS refreshes first; if still unknown and the brand.json cooldown has elapsed, brand.json re-resolves to pick up a rotated `jwks_uri`.
  - Ambiguous selectors (multiple agents of the same type, no `agentId`) throw `agent_ambiguous` with a clear error listing the candidate ids.
  - All fetches go through `ssrfSafeFetch`, so an attacker-supplied brand.json or JWKS URL can't resolve to the receiver's private network or IMDS.

  **Example**

  ```typescript
  import {
    BrandJsonJwksResolver,
    verifyWebhookSignature,
    InMemoryReplayStore,
    InMemoryRevocationStore,
  } from '@adcp/client/signing';

  const jwks = new BrandJsonJwksResolver('https://publisher.example/.well-known/brand.json', {
    agentType: 'sales',
  });

  await verifyWebhookSignature(request, {
    jwks,
    replayStore: new InMemoryReplayStore(),
    revocationStore: new InMemoryRevocationStore(),
  });
  ```

- e557245: Request-signing verifier: tighten RFC 9421 conformance against new spec
  vectors (#2323) and adcp#2468.
  - `@target-uri` canonicalization now decodes percent-encoded unreserved
    bytes (RFC 3986 §6.2.2.2) so `%7E` and `~` produce a byte-identical
    signature base.
  - Verifier rejects at step 1 when a signed request carries duplicate
    Signature-Input dictionary keys, multi-valued Content-Type or
    Content-Digest headers covered by the signature, a non-ASCII
    authority (U-label), or userinfo on the `@authority` component.
  - Step 8 binds sig-params `alg` to the resolved JWK's `alg`: a missing
    JWK `alg`, an alg mismatch, or inconsistent kty/crv per RFC 8037
    (EdDSA↔OKP) / RFC 7518 (ES256↔EC/P-256) all fail with
    `request_signature_key_purpose_invalid`.
  - Compliance test-vector loader accepts `jwks_override` as an
    alternative to `jwks_ref`; the grader routes `jwks_override` vectors
    through the library verifier directly since a live HTTP probe can't
    mutate a target agent's JWKS per-vector.

- fd49ecc: Rollup 5.2.0 — bundles the work that went into the unpublished 6.0.0. Treat the
  heads-up section below as "breaking" if you're upgrading directly from 5.1.0.

  ## ⚠️ 5.1.0 → 5.2.0 — treat as MAJOR

  This rollup is labeled `minor` because 5.1.0 had negligible adoption and the jump from 4.x is the intended upgrade path. If you are on 5.1.0, **treat this as a major upgrade** — the following source-level breaks require code changes:
  - `VerifyResult` is now a discriminated union (`status: 'verified' | 'unsigned'`); branching on `result.keyid === ''` no longer works.
  - `TaskStatus` narrowed — `'governance-escalated'` removed; fold into `'governance-denied'` and inspect `governance.findings`.
  - `domain` → `protocol` rename threaded through public types, compliance cache paths, and `TasksGetResponse` / `TasksListRequest.filters` / `MCPWebhookPayload`.
  - `BudgetAuthorityLevel` type removed; migrate to `budget.reallocation_threshold` / `budget.reallocation_unlimited` and `plan.human_review_required`.

  See the "Heads-up if tracking 5.1.0 → 5.2.0" section below for full migration detail.

  ## Heads-up if tracking 5.1.0 → 5.2.0

  ### Verifier API v3 (closes #583 items 1 and 2, #584)

  `verifyRequestSignature` return shape is now a discriminated union:

  ```ts
  type VerifyResult =
    | { status: 'verified'; keyid: string; agent_url?: string; verified_at: number }
    | { status: 'unsigned'; verified_at: number };
  ```

  Pre-5.2 returned a `VerifiedSigner` with `keyid: ''` as a sentinel when the
  request was unsigned on an operation not in `required_for`. Consumers that
  branched on `result.keyid === ''` must now branch on `result.status`.

  `createExpressVerifier` updates `req.verifiedSigner` accordingly — the field is
  set only when `status === 'verified'`.

  `VerifyRequestOptions.operation` is now optional. Omitting it treats the
  operation as "not in any `required_for`" and returns an unsigned result.

  `ExpressMiddlewareOptions.resolveOperation` may now return `undefined` — bypass
  `required_for` enforcement without losing verifier coverage on signed paths.

  ### Governance status narrowing

  `GovernanceCheckResult.status` narrows to `'approved' | 'denied' | 'conditions'`.
  `TaskStatus` drops `'governance-escalated'`. `TaskResultFailure.status` narrows
  to `'failed' | 'governance-denied'`. If you branch on
  `result.status === 'governance-escalated'`, fold into `'governance-denied'` and
  inspect `governance.findings` for human-review signals.

  ### Governance `budget.authority_level` removed

  AdCP dropped `budget.authority_level` in favor of:
  - `budget.reallocation_threshold: number ≥ 0` / `budget.reallocation_unlimited: true` (mutually exclusive)
  - `plan.human_review_required: boolean` for GDPR Art 22 / EU AI Act Annex III

  Mapping: `agent_full → reallocation_unlimited: true`; `agent_limited → keep
reallocation_threshold`; `human_required → plan.human_review_required: true`.

  ### Compliance cache rename: `domain` → `protocol`

  `compliance/cache/{version}/domains/` → `.../protocols/`.
  `PROTOCOL_TO_DOMAIN` → `PROTOCOL_TO_PATH`. `ComplianceIndexDomain` →
  `ComplianceIndexProtocol`. `BundleKind` value `'domain'` → `'protocol'`.
  `AdCPDomain` → `AdCPProtocol`. `TasksGetResponse.domain` → `protocol`;
  `TasksListRequest.filters.{domain,domains}` → `{protocol,protocols}`;
  `MCPWebhookPayload.domain` → `protocol`. `PROTOCOLS_WITHOUT_BASELINE` removed.

  ### Generated-types cleanup (#621)

  Typeless JSON Schema nodes (e.g. `check_governance.conditions[].required_value`)
  now compile to `unknown` / `z.unknown()` instead of being narrowed to
  `Record<string, unknown>`. Spec-correct scalar responses from compliant agents
  no longer fail validation. Multi-pass dedup removes ~7000 lines from
  `core.generated.ts`.

  ### Property-list account migration

  AdCP 3.0 account migration absorbed. `BudgetAuthorityLevel` type removed.
  `DelegationAuthority` now re-exported from `./types/core.generated`.
  `PropertyListAdapter.listLists` filters by `account` primitive (not removed
  `principal`).

  ## Additions

  ### Idempotency for v3 mutating requests (#568, #569; upstream adcp#2315)
  - Client methods for mutating tools auto-generate UUID v4 `idempotency_key` when
    the caller omits one. Internal retries reuse the same key.
  - `result.metadata.idempotency_key` surfaces the sent key.
  - `result.metadata.replayed` surfaces whether the seller returned a cached
    response. Side-effect-emitting agents MUST check this before re-firing.
  - Typed errors: `IdempotencyConflictError` (mint fresh key), `IdempotencyExpiredError` (look up by natural key).
  - `result.errorInstance` carries a typed `ADCPError` subclass when available.
  - New `getIdempotencyReplayTtlSeconds()` on `SingleAgentClient` / `AgentClient`.
    Throws on v3 sellers that omit the REQUIRED declaration — no silent default.
  - `useIdempotencyKey(key)` BYOK helper validates format up-front.
  - Idempotency keys redacted in debug logs by default (`ADCP_LOG_IDEMPOTENCY_KEYS=1` to opt in).
    `redactIdempotencyKey(key)` exported.

  ### Server-side middleware (`@adcp/client/server`)
  - `createIdempotencyStore({ backend, ttlSeconds })` — RFC 8785 JCS payload
    canonicalization, atomic `putIfAbsent` claim step, auto-declares
    `adcp.idempotency.replay_ttl_seconds`, rejects low-entropy keys, excludes
    the echo-back `context` from the hash but keeps string-typed `context` on SI
    tools.
  - Backends: `memoryBackend()`, `pgBackend(pool, { tableName? })`.
  - `getIdempotencyMigration()` DDL + `cleanupExpiredIdempotency(pool)` periodic
    reclaim.
  - Guardrail: logs error when mutating handlers are registered without an
    idempotency store.

  ### OAuth zero-config + diagnostics
  - `NeedsAuthorizationError` — thrown automatically on 401 Bearer challenge;
    carries `agentUrl`, `resource`, `resourceMetadataUrl`, `authorizationServer`,
    `authorizationEndpoint`, `tokenEndpoint`, `registrationEndpoint`,
    `scopesSupported`, parsed challenge.
  - `discoverAuthorizationRequirements(agentUrl, options?)` — RFC 9728 +
    RFC 8414 walk.
  - `createFileOAuthStorage({ configPath, agentKey? })` — atomic writes against
    the CLI's agents.json.
  - `bindAgentStorage` / `getAgentStorage` — per-agent WeakMap storage binding.
  - OAuth tokens now thread through `ADCPMultiAgentClient` and the storyboard
    runner (previously bearer-only). `NonInteractiveFlowHandler` +
    `createNonInteractiveOAuthProvider(agent, { agentHint? })`.
  - `TestOptions.auth` accepts `{ type: 'oauth', tokens, client? }`.
  - CLI `adcp diagnose-auth <alias|url>` — end-to-end OAuth diagnostic with ranked
    hypotheses. `runAuthDiagnosis`, `parseWWWAuthenticate`,
    `decodeAccessTokenClaims`, `validateTokenAudience`, `InvalidTokenError`,
    `InsufficientScopeError` exported.

  ### Signing — HTTPS stores + structured headers + replay buckets
  - `HttpsJwksResolver(url, options)` — HTTPS-fetching JWKS with `ETag`,
    `Cache-Control`, lazy refetch on key-unknown, SSRF-guarded.
  - `HttpsRevocationStore(url, options)` — cached `RevocationSnapshot`, fails
    closed past `next_update + graceSeconds` with
    `request_signature_revocation_stale`.
  - Parser swap to `structured-headers` library (RFC 8941 / RFC 9651) — profile
    checks (required params, tag, alg allowlist, typing) stay as typed wrappers.
  - Time-bucket replay store — O(1) amortized `has`/`insert`/`isCapHit` on hot
    keyids. Default `maxEntriesPerKeyid` 1M → 100k.
  - `ssrfSafeFetch` — primitive blocking IMDS / private networks.

  ### Request-signing grader — MCP mode + review fixes
  - `GradeOptions.transport: 'raw' | 'mcp'` (default `'raw'`). MCP mode wraps
    vectors in `tools/call` envelopes and extracts `operation` from the vector
    URL's last path segment.
  - CLI: `adcp grade request-signing <agent-url>` with `--transport`,
    `--skip-rate-abuse`, `--rate-abuse-cap`, `--only`, `--skip`,
    `--allow-live-side-effects`, `--allow-http`, `--json`.
  - `GradeReport` exposes `passed_count` / `failed_count` / `skipped_count`.
  - Safety: vectors 016 (`replay_window`) and 020 (`rate_abuse`) auto-skip
    against non-sandbox endpoints unless `allowLiveSideEffects: true`.
  - `live_endpoint_warning` replaces misleading `endpoint_scope_warning`.
  - Skipped vectors report as `skipped: true` (not scored as failures).
  - Hardened `extractSignatureErrorCode` (alphabet-constrained),
    `splitChallenges` (quote-state tracked).
  - New test-agent `test-agents/seller-agent-signed-mcp.ts`.

  ### Storyboard runner — multi-instance mode
  - `runStoryboard` accepts an array of agent URLs. Steps round-robin across
    replicas so writes on one instance must be visible on another. Canonical
    `write on [#A] → read on [#B] → NOT_FOUND` failure signature.
  - CLI: repeated `--url` engages multi-instance mode (minimum 2). JSON output
    gains `agent_urls[]`, `multi_instance_strategy`, per-step `agent_url` +
    `agent_index`. `--dry-run` prints the assignment plan.
  - Guide: `docs/guides/MULTI-INSTANCE-TESTING.md`. Implements client-side half
    of adcp#2363; closes adcp#2267.

  ### Governance helpers
  - `buildHumanReviewPlan(input)` — stamps `human_review_required: true`.
  - `buildHumanOverride({ reason, approver, approvedAt? })` — builds the artifact
    for downgrading `human_review_required: true → false` on re-sync. Validates
    reason ≥20 chars, approver is an email, no control chars, ISO 8601 dates.
  - `validateGovernancePlan(plan)` — client-side XOR + Annex III invariant check
    that codegen drops from `if/then`.
  - Constants: `REGULATED_HUMAN_REVIEW_CATEGORIES`, `ANNEX_III_POLICY_IDS`.

  ### Idempotency storyboard end-to-end
  - Middleware stamps `metadata.replayed: false` on every mutating response (not
    just replays).
  - Replay echoes the current retry's `context` (middleware strips `context`
    before caching; re-injects on replay).
  - MCP-level `idempotency_key` relaxed to optional when the framework has an
    idempotency store wired — middleware returns structured `adcp_error`.
  - Harness: `$generate:uuid_v4[#alias]` placeholder, forwarded
    `idempotency_key`, `$context.<key>` in validation `value` / `allowed_values`,
    `TaskOptions.skipIdempotencyAutoInject` for compliance runs.

  ## Fixes
  - Governance E2E — removed stale `plan.campaigns` assertion; approve test now
    picks a `fixed_price` pricing option (was `[0]`, which broke on agents that
    ordered auction options first). Closes #613.
  - Property-list storyboard — brand-injection builders removed so runner falls
    through to spec-correct `account` primitive. Closes #577.
  - Governance: dropped non-spec `'escalated'` status. Closes #589.
  - Protocol rename `domain` → `protocol` threaded end-to-end.
  - Request-signing grader vector 010 (`content-digest-mismatch`) now tests
    lying-signer detection, vector 009 (`key-purpose-invalid`) honors pinned
    `jwks_ref`.

  ## Public API additions (overview)

  ```ts
  // Client
  import {
    IdempotencyConflictError,
    IdempotencyExpiredError,
    NeedsAuthorizationError,
    generateIdempotencyKey,
    isMutatingTask,
    isValidIdempotencyKey,
    canonicalize,
    canonicalJsonSha256,
    closeMCPConnections,
    adcpErrorToTypedError,
    useIdempotencyKey,
    redactIdempotencyKey,
    discoverAuthorizationRequirements,
    createFileOAuthStorage,
    bindAgentStorage,
    getAgentStorage,
    createNonInteractiveOAuthProvider,
    runAuthDiagnosis,
    parseWWWAuthenticate,
    decodeAccessTokenClaims,
    validateTokenAudience,
    InvalidTokenError,
    InsufficientScopeError,
    buildHumanReviewPlan,
    buildHumanOverride,
    validateGovernancePlan,
    REGULATED_HUMAN_REVIEW_CATEGORIES,
    ANNEX_III_POLICY_IDS,
    type MutatingRequestInput,
    type IdempotencyCapabilities,
  } from '@adcp/client';

  // Server
  import {
    createIdempotencyStore,
    memoryBackend,
    pgBackend,
    hashPayload,
    getIdempotencyMigration,
    cleanupExpiredIdempotency,
    HttpsJwksResolver,
    HttpsRevocationStore,
    type IdempotencyStore,
    type IdempotencyBackend,
  } from '@adcp/client/server';
  ```

- 7e5d228: Server-side authentication middleware: API key, OAuth JWT, or both.

  AdCP agents MUST authenticate incoming requests (per the `security_baseline` storyboard in the universal track). This release adds first-class middleware so sellers can wire auth in ~5 lines.

  **New**
  - `verifyApiKey({ keys? | verify? })` — static or dynamic API-key authenticator.
  - `verifyBearer({ jwksUri, issuer, audience, requiredScopes? })` — OAuth 2.0 JWT validation via `jose` + JWKS. Strict audience enforcement catches the "resource URL mismatch" class of bug. Defaults to an asymmetric-only algorithm allowlist (RS*/ES*/PS\*/EdDSA) to block algorithm-confusion attacks, and extracts scopes from both `scope` (string) and `scp` (string | array) claims.
  - `anyOf(a, b, ...)` — combinator for accepting API key OR OAuth. Wraps rejections in a sanitized `AuthError` so probing attackers can't learn expected-audience or token-shape details from error responses.
  - `respondUnauthorized(req, res, opts)` — RFC 6750-compliant 401/403 with `WWW-Authenticate: Bearer`. `realm` defaults to `"mcp"` (stable) instead of the attacker-controlled `Host` header.
  - `AuthError` — exported error class with a sanitized `publicMessage`; the underlying implementation error is preserved as `cause` for server-side logging.
  - `ServeOptions.authenticate` — plug any authenticator into `serve()`; no request reaches the MCP transport without passing.
  - `ServeOptions.publicUrl` — canonical https:// URL of the MCP endpoint. Required when `protectedResource` is configured. The RFC 9728 `resource` field, the RFC 6750 `resource_metadata` URL on 401 challenges, and the JWT audience all come from this — closes a Host-header phishing vector where a server would otherwise advertise whatever host a caller sent.
  - `ServeOptions.protectedResource` — advertise OAuth 2.0 protected-resource metadata (RFC 9728) at `/.well-known/oauth-protected-resource<mountPath>`.
  - MCP `AuthInfo` propagation — `serve()` sets `req.auth` from the auth principal (token, clientId, scopes, expiresAt, extra) so MCP tool handlers receive it via `extra.authInfo`. `createAdcpServer` handlers see it on `ctx.authInfo`.

  **Skills**
  - `build-seller-agent/SKILL.md` gains a full "Protecting your agent" section with API key, OAuth, and both-at-once examples, plus a conformance checklist.
  - Short "Protecting your agent" section added to every other `build-*-agent` skill (signals, creative, retail-media, governance, si, brand-rights, generative-seller) so every agent-builder walks past the auth prompt on their way to validation.

  **Dependency**
  - Promoted `jose` from transitive to direct (it was already in the tree via `@modelcontextprotocol/sdk`).

- 2756df6: Storyboard runner: outbound-webhook conformance grading (adcontextprotocol/adcp#2426, matching the spec shape from adcontextprotocol/adcp#2431).

  **Storyboard runtime:**
  - `runStoryboard` / `runStoryboardStep` accept a `webhook_receiver` option that binds an ephemeral HTTP listener (loopback-mock mode default; `proxy_url` mode accepts an operator-supplied public base). The receiver mints per-step URLs under `/step/<step_id>/<operation_id>` and exposes `{{runner.webhook_base}}` / `{{runner.webhook_url:<step_id>}}` substitutions so storyboards inject them into `push_notification_config.url`. Downstream filters pick up the same operation_id via `{{prior_step.<step_id>.operation_id}}`.
  - Three new pseudo-tasks (step `task` values, not validation checks):
    - **`expect_webhook`** — asserts a matching delivery arrived carrying a well-formed `idempotency_key` (pattern `^[A-Za-z0-9_.:-]{16,255}$`). Optional `expect_max_deliveries_per_logical_event` caps distinct logical events in the window — catches publishers that re-execute on replay under a fresh key.
    - **`expect_webhook_retry_keys_stable`** — configures the receiver to reject the first N deliveries with a configurable 5xx, then asserts every observed delivery carries the byte-identical `idempotency_key`. Fails with `insufficient_retries`, `idempotency_key_rotated`, or `idempotency_key_format_changed`.
    - **`expect_webhook_signature_valid`** — delegates to the new RFC 9421 webhook verifier. Grades `not_applicable` when `webhook_signing` is not configured on runStoryboard options.
  - `requires_contract` on any webhook-assertion step grades `not_applicable` when the contract id is not listed in `options.contracts` — lets cross-cutting storyboards (e.g. idempotency) reference webhook assertions without forcing every runner to host a receiver.

  **RFC 9421 webhook signing:**
  - `verifyWebhookSignature` in `@adcp/client/signing/server` — 14-step verifier checklist per `docs/building/implementation/security.mdx#verifier-checklist-for-webhooks`. Tag `adcp/webhook-signing/v1`, mandatory covered components `@method`, `@target-uri`, `@authority`, `content-type`, `content-digest`, key purpose `adcp_use: "webhook-signing"`. Throws `WebhookSignatureError` with a specific `webhook_signature_*` code.
  - `signWebhook` in `@adcp/client/signing/client` — companion signer for publishers emitting conformant webhooks.
  - `WEBHOOK_SIGNING_TAG` and `WEBHOOK_MANDATORY_COMPONENTS` constants exported from both sub-barrels.

  **Test coverage:** 25 new tests across `test/lib/storyboard-webhook-receiver.test.js` and `test/lib/storyboard-webhook-signature.test.js` covering per-step routing, retry-replay policy, runner-variable substitution, every expect_webhook\* error code, and a full E2E flow with a signing publisher.

- b4709ad: Regenerated types from latest AdCP schemas. Adds `idempotency_key` (required, string) to webhook payloads — `MCPWebhookPayload`, `ArtifactWebhookPayload`, `CollectionListChangedWebhook`, `PropertyListChangedWebhook` — and renames `RevocationNotification.notification_id` → `idempotency_key`.

  Upstream migrated these surfaces to a single canonical dedup field. Receivers must dedupe by `idempotency_key` scoped to the authenticated sender identity. Publishers populating `RevocationNotification.notification_id` must rename the field.

- 6ec01c6: Regenerated types from latest AdCP schemas.
  - `CreateMediaBuyResponse` union gains `CreateMediaBuySubmitted` — async task envelope with `status: 'submitted'` and `task_id`, returned when a media buy cannot be confirmed synchronously (IO signing, governance review, batched processing). The `media_buy_id` and `packages` land on the completion artifact, not this envelope.
  - `PushNotificationConfig.authentication` is now optional and deprecated. Omitting it opts in to the RFC 9421 webhook profile (the default in 4.0); Bearer and HMAC-SHA256 remain for legacy compatibility only.
  - `RightUse` adds `ai_generated_image`.

  Consumers of `CreateMediaBuyResponse` that exhaustively discriminate on the union must handle the new `'submitted'` branch.

- 078b52c: Publisher-side webhook emission — the symmetric counterpart to PR #629's receiver-side dedup.

  **New `createWebhookEmitter`** in `@adcp/client/server`. One `emit(url, payload, operation_id)` call and the emitter handles:
  - RFC 9421 signing with a fresh nonce per attempt (adcp#2423).
  - Stable `idempotency_key` per `operation_id` reused across retries (adcp#2417) — regenerating on retry is the highest-impact at-least-once-delivery bug the runner-side conformance suite catches.
  - JSON serialized once with compact separators (`,` / `:`, no spaces) and posted byte-identically — the signature-base input and the wire body come from the same bytes, preventing the Python `json.dumps` default-spacing trap pinned by adcp#2478.
  - Retry with exponential backoff + jitter on 5xx / 429. Terminal on 4xx and on 401 responses carrying `WWW-Authenticate: Signature error="webhook_signature_*"` (retrying a signature failure produces identical bytes and identical rejection).
  - Pluggable `WebhookIdempotencyKeyStore` (default in-memory) — swap in a durable backend for multi-replica publishers.
  - HMAC-SHA256 / Bearer fallback modes for legacy buyers that registered `push_notification_config.authentication.credentials`. HMAC path uses the same compact-separators pinning.

  **`createAdcpServer` integration.** New `webhooks?: { signerKey, retries?, idempotencyKeyStore?, ... }` config option. When set, `ctx.emitWebhook` is populated on every handler's context — completion handlers post signed webhooks without constructing the signer, fetching, or tracking idempotency themselves:

  ```ts
  createAdcpServer({
    name,
    version,
    webhooks: { signerKey: { keyid, alg: 'ed25519', privateKey: jwk } },
    mediaBuy: {
      createMediaBuy: async (params, ctx) => {
        const media_buy_id = await persist(params);
        await ctx.emitWebhook({
          url: params.push_notification_config.url,
          payload: { task: { task_id, status: 'completed', result: { media_buy_id } } },
          operation_id: `create_media_buy.${media_buy_id}`,
        });
        return { media_buy_id, packages: [] };
      },
    },
  });
  ```

  **Full-stack E2E test.** `test/lib/webhook-emitter-server-e2e.test.js`: `createAdcpServer` with a real handler → `ctx.emitWebhook` → real HTTP POST → receiver captures → `verifyWebhookSignature` accepts. No mocks on the signer or verifier path. Closes the "we haven't spun up an actual server and watched the full stack verify" gap flagged during PR #631 review.

  **Exports** from `@adcp/client/server`:
  - `createWebhookEmitter`, `memoryWebhookKeyStore`
  - Types: `WebhookEmitter`, `WebhookEmitterOptions`, `WebhookEmitParams`, `WebhookEmitResult`, `WebhookEmitAttempt`, `WebhookEmitAttemptResult`, `WebhookIdempotencyKeyStore`, `WebhookRetryOptions`, `WebhookAuthentication`
  - `HandlerContext.emitWebhook` — new optional field, populated when `webhooks` config is set.

- 7b76326: Webhook receiver-side deduplication via `AsyncHandlerConfig.webhookDedup`.

  AdCP webhooks use at-least-once delivery — publishers retry until they see a 2xx, so the same event can arrive more than once. The spec now requires an `idempotency_key` on every MCP, governance, artifact, and revocation webhook payload so receivers have a canonical dedup field. This release plumbs that key through the client pipeline and ships a drop-in dedup layer for the MCP envelope path.

  **New**
  - `AsyncHandlerConfig.webhookDedup?: { backend: IdempotencyBackend; ttlSeconds?: number }` — drop duplicate deliveries with a single config. Reuses `IdempotencyBackend` from `@adcp/client/server`, so the same `memoryBackend()` or `pgBackend(...)` used for request-side idempotency can back webhook dedup. Defaults to 24h retention.
  - `WebhookMetadata.idempotency_key?: string` — extracted from the MCP envelope and passed to every `onXxxStatusChange` handler so application code can log, trace, or build its own dedup on top.
  - `WebhookMetadata.protocol?: 'mcp' | 'a2a'` — transport that delivered the webhook; useful for handler code that branches on protocol (A2A lacks `idempotency_key`).
  - `Activity` union gains `'webhook_duplicate'` — surfaced via `onActivity` when a repeat key is dropped. The typed handler is NOT called for duplicates.
  - `Activity.idempotency_key?: string` — surfaced on both `webhook_received` and `webhook_duplicate` for correlation.

  **Type changes (strict-TS callers may need to update)**
  - The `Activity.type` union gains `'webhook_duplicate'`. TypeScript users doing exhaustive `switch (activity.type)` with a `never`-check will see a new missing-case error. Treat `webhook_duplicate` the same as `webhook_received` in `onActivity` logging, or branch on `activity.type` to suppress side effects for duplicates.

  **Behavior**
  - Scope is per-agent under a reserved prefix (`adcp\u001fwebhook\u001fv1\u001f{agent_id}\u001f{idempotency_key}`) — keys from different senders are independent, and the prefix guarantees no collision with request-side idempotency entries when sharing a backend.
  - `putIfAbsent` closes the concurrent-retry race: when two retries race on the same fresh key, exactly one wins the claim and dispatches; the rest surface as `webhook_duplicate`.
  - MCP payloads missing or violating the `idempotency_key` format (`^[A-Za-z0-9_.:-]{16,255}$`) dispatch without dedup and log a `console.warn` with the spec pattern and a docs pointer. A2A payloads (which do not carry the field) dispatch silently — the absence is expected and unactionable.
  - Handler exceptions inside the dispatched handler are caught and logged as today; the dedup claim is intentionally NOT released on handler error. This preserves at-most-once handler execution: the publisher sees 2xx once (because `handleWebhook` returns normally) and won't retry, so releasing the claim would only matter on a future unrelated retry of the same key, which is never expected.

  **Schema sync**
  - `MCPWebhookPayload`, `CollectionListChangedWebhook`, `PropertyListChangedWebhook`, `ArtifactWebhookPayload`, and `RevocationNotification` now include `idempotency_key` as a required field (picked up from AdCP `latest`).

  **Example**

  ```typescript
  import { AdCPClient } from '@adcp/client';
  import { memoryBackend } from '@adcp/client/server';

  const client = new AdCPClient(agents, {
    webhookUrlTemplate: 'https://your-app.com/adcp/webhook/{task_type}/{agent_id}/{operation_id}',
    webhookSecret: process.env.WEBHOOK_SECRET,
    handlers: {
      webhookDedup: { backend: memoryBackend() },
      onCreateMediaBuyStatusChange: async (result, metadata) => {
        // First delivery runs here; publisher retries are dropped.
      },
    },
  });
  ```

  Governance list-change / artifact / brand-rights revocation webhooks are not yet routed through `AsyncHandler`; dedup for those payload types is a follow-up.

- 2756df6: Close the webhook-signing conformance gap after adcontextprotocol/adcp#2445 merged canonical test vectors.

  **Error enum aligned with merged spec.** The webhook-signature error taxonomy (`security.mdx#webhook-callbacks`) folds every window-level failure into a single `webhook_signature_window_invalid` code — `webhook_signature_expired` isn't in the enum. Drops our stray `_expired` code; adds `webhook_signature_rate_abuse` (per-keyid cap exceeded, step 9a) and `webhook_signature_revocation_stale` (revocation list past grace). Verifier step numbers realigned to the canonical 1–13 + 9a.

  **Parser now enforces the single-alphabet rule.** RFC 9421 `Signature` / `Content-Digest` tokens that mix base64url (`[-_]`) with standard-base64 (`[+/=]`) are ambiguous and the spec mandates rejection with `*_header_malformed`. Both verifiers inherit the fix.

  **Storyboard error enum** extended in lockstep: `signature_window_invalid` replaces `signature_expired`, plus `signature_rate_abuse`, `signature_revocation_stale`, `signature_alg_not_allowed`, `signature_components_incomplete`, `signature_header_malformed`, `signature_params_incomplete`. Exhaustive mapping catches new verifier codes at compile time.

  **Conformance harness.** Vendored the 7 positive + 21 negative vectors from adcontextprotocol/adcp under `test/fixtures/webhook-signing-vectors/` (AdCP tarball hasn't re-released yet; swap to `compliance/cache/...` on the next sync). Every vector runs through `verifyWebhookSignature` — passing vectors verify cleanly, negative vectors throw with byte-matching error codes. State-dependent vectors (replay, revocation, rate-abuse, revocation-stale) install their `test_harness_state` into fresh stores per vector. 2 positive vectors (`004-default-port-stripped`, `005-percent-encoded-path`) are skipped pending an upstream regeneration — their baked signatures contradict the request-signing canonicalization rules the webhook spec inherits.

### Patch Changes

- c94935b: `build-seller-agent` SKILL.md — document two more Common Mistakes surfaced by real seller-agent builds: (1) placing the IO-signing `setup` URL at the top level of a media buy response instead of nesting it under `account.setup` (response builders now reject this at runtime), and (2) bypassing response builders and forgetting `valid_actions` — `mediaBuyResponse` and `updateMediaBuyResponse` auto-populate it from `status`; `get_media_buys` callers should use `validActionsForStatus()` per buy.
- 3c293ae: Skill docs: specialism coverage tables, composition guide, AdCP 3.0 GA alignment.

  Every `build-*-agent/SKILL.md` now maps specialism IDs to concrete per-specialism deltas, with archetype splits where the contracts diverge (creative: ad-server / template / generative). Root `CLAUDE.md` gets the inverse specialism → skill index.

  Seller skill picks up:
  - Protocol-Wide Requirements: `idempotency_key` via `createIdempotencyStore`, mandatory auth pointer, signature-header transparency.
  - Composing OAuth + signing + idempotency: real `serve({ authenticate, preTransport })` wiring, `verifyBearer` from `@adcp/client/server`, low-level `verifyRequestSignature` (preTransport-shaped; not `createExpressVerifier` which is Express-shaped), `resolveIdempotencyPrincipal` threading from `ctx.authInfo.clientId` + multi-tenant composition.
  - Per-specialism sections for `sales-guaranteed` (A2A task envelope for IO approval), `sales-non-guaranteed` (bid_price + update_media_buy), `sales-broadcast-tv`, `sales-social`, `sales-proposal-mode`, `audience-sync`, `signed-requests`.

  Governance skill: Plan shape updated to `budget.reallocation_threshold` / `reallocation_unlimited` + `human_review_required` (no more `authority_level`), `content_standards.policies[]` as structured array with per-entry `enforcement`, `validate_content_delivery.artifact.assets` as array, `property-lists` / `collection-lists` (new) / `content-standards` specialism sections. Governance status enum is approved | denied | conditions — approved-with-conditions is `status: 'conditions'`, not an approved + conditions array.

  Signals skill: async platform-activation pattern, value-type constraints, deployed_at.

  Brand-rights skill: schema-accurate `logos[].background` (dark-bg/light-bg/transparent-bg), `tone.voice` nesting, `terms` with required pricing_option_id/amount/currency/uses, `rights_constraint` with required `rights_agent`, `approval_webhook` credentials minLength 32, `available_uses` using spec-valid enum values.

  Retail-media skill: scope note (catalog-driven ≠ retail-only).

  Validated via five rounds of fresh-builder tests against the skills + one end-to-end test with the storyboard runner. Median build confidence climbed from 3/5 (round 1) to 4-5/5 (round 5). End-to-end runs surfaced three upstream spec/runner bugs now tracked in adcontextprotocol/adcp#2418, adcontextprotocol/adcp#2420, and adcontextprotocol/adcp-client#625.

- 5d81fe9: Generator: typeless JSON Schema properties now emit `unknown` instead of `Record<string, unknown>`.

  JSON Schema properties declared with only a `description` (no `type`, `$ref`, combinator, enum, or structural keyword) are defined by the spec to accept any JSON value — scalar or object. `json-schema-to-typescript` defaults these to `{ [k: string]: unknown }`, which downstream Zod generation then narrowed to `z.record(z.string(), z.unknown())`. That schema rejected scalar values the spec legitimately allows, e.g. a number returned for `check_governance` `conditions[].required_value`.

  `enforceStrictSchema` in `scripts/generate-types.ts` now annotates schema nodes whose keys are all metadata-only (`description`, `title`, `$comment`, `examples`, `default`, `deprecated`, `readOnly`, `writeOnly`, `$id`, `$anchor`, `$schema`) with `tsType: 'unknown'` before handing them to `json-schema-to-typescript`, so the emitted TS is `unknown` and the Zod mirror is `z.unknown()`. Validation-only keywords like `required` (common in `anyOf` branches on request schemas) are not metadata, so constraints still compose. The recursion now also reaches `patternProperties`, schema-valued `additionalProperties`, `not`, `if`/`then`/`else`, `contains`, `propertyNames`, `unevaluatedItems`/`unevaluatedProperties`, and schema-valued `dependencies`/`dependentSchemas`.

  Side fix: `removeNumberedTypeDuplicates` now iterates passes (up to 10) until no further collapses occur. Nested numbered references (e.g. `CatalogFieldMapping2` references `ExtensionObject32`) previously caused the outer duplicate to fail body comparison and stay in the output; they now collapse once the inner reference resolves on an earlier pass.

  Regenerated affected types in `src/lib/types/*.generated.ts`. Notable corrections:
  - `CheckGovernanceResponse.conditions[].required_value`: `Record<string, unknown>` → `unknown`.
  - `CatalogFieldMapping.value` / `.default`: `Record<string, unknown>` → `unknown`.
  - `Response.data`: `Record<string, unknown>` → `unknown`.

  If you narrowed one of these fields with `as Record<string, unknown>`, replace with a value-shape assertion appropriate to the spec.

## 5.1.0

### Minor Changes

- 50c809a: Pull storyboards from the AdCP compliance tarball instead of bundling them.

  Released as a minor bump: 5.0 was intentionally shipped incomplete while the
  upstream compliance tarball + cosign signing work landed (adcontextprotocol/adcp#2273).
  5.0 has not seen meaningful adoption, so the removals below are treated as finishing
  the 5.x surface rather than a 6.0 breaking release.

  `npm run sync-schemas` fetches `/protocol/{version}.tgz` from adcontextprotocol.org,
  verifies its sha256 sidecar, and extracts both `schemas/` and `compliance/` into
  `schemas/cache/{version}/` and `compliance/cache/{version}/`. Per-file schema sync is kept
  as a fallback. The compliance cache ships with the published npm package — no network
  call required for first use.

  When a pinned version ships cosign sidecars (`.sig` / `.crt`, per
  adcontextprotocol/adcp#2273), `sync-schemas` verifies them against the upstream
  release workflow's Sigstore identity. `latest.tgz` is intentionally unsigned and skipped.
  Missing sidecars or a missing `cosign` binary fall back to checksum-only trust with a
  clear log line; a present-but-failed verification is a hard error.

  Storyboard selection is driven by the agent's `get_adcp_capabilities` response:
  `supported_protocols` resolves to domain baselines and `specialisms` resolves to
  specialism bundles. The runner fails closed when:
  - an agent declares a specialism whose bundle isn't in the local cache (stale cache — re-sync);
  - an agent declares a specialism whose parent domain isn't in `supported_protocols`.
    Unknown `supported_protocols` entries (new spec version, typo) log a warning and are skipped.

  `discoverAgentProfile` now calls `get_adcp_capabilities` to populate
  `profile.supported_protocols` + `profile.specialisms`. A probe failure is surfaced
  as `profile.capabilities_probe_error` and a top-level error-severity observation,
  rather than silently downgrading the assessment.

  **Breaking changes**:
  - The `storyboards/` directory is no longer shipped in the npm package. Consumers
    relying on direct file paths must read from `/compliance/{version}/` on
    adcontextprotocol.org or the `compliance/cache/` tree after running sync.
  - `ComplyOptions.platform_type` is removed. Callers that still pass it get a
    runtime error pointing to this changeset. Capability-driven selection replaces
    platform-type curated lists. Pass `storyboards: [id]` for explicit/targeted runs;
    bundle ids (e.g., `sales-guaranteed`) expand to every storyboard in the bundle.
  - `ComplianceResult.platform_coherence` and `ComplianceResult.expected_tracks` are
    removed along with the `expected` track status.
  - `ComplianceSummary.tracks_expected` is removed.
  - Removed exports: `PlatformType`, `SalesPlatformType`, `CreativeAgentType`,
    `SponsoredIntelligenceType`, `AINativePlatformType`, `PlatformProfile`,
    `PlatformCoherenceResult`, `CoherenceFinding`, `InventoryModel`, `PricingModel`,
    `getPlatformProfile`, `getAllPlatformTypes`, `getPlatformTypesWithLabels`,
    `PLATFORM_STORYBOARDS`, `getStoryboardIdsForPlatform`, `extractScenariosFromStoryboard`,
    `filterToKnownScenarios`, `loadBundledStoryboards`, `loadBundledScenarios`,
    `getStoryboardById`, `getScenarioById`, `getStoryboardsForPlatformType`,
    `getComplianceStoryboards`, `getApplicableComplianceStoryboards`, `listStoryboards`.
  - CLI: `adcp storyboard list --platform-type` and
    `adcp storyboard run --platform-type` / `--list-platform-types` are removed.
    Added `adcp storyboard run <agent> --file <path.yaml>` for ad-hoc spec-evolution runs.

  New exports on `@adcp/client/testing`: `resolveStoryboardsForCapabilities`,
  `resolveBundleOrStoryboard`, `findBundleById`, `listBundles`, `loadBundleStoryboards`,
  `listAllComplianceStoryboards`, `getComplianceStoryboardById`, `loadComplianceIndex`,
  `getComplianceCacheDir`.

- 6953c35: Optimistic concurrency primitives on `AdcpStateStore`.

  **New**
  - `putIfMatch(collection, id, data, expectedVersion)` — atomic compare-and-swap. Returns `{ok: true, version}` on success, `{ok: false, currentVersion}` on conflict. `expectedVersion: null` means insert-only.
  - `getWithVersion(collection, id)` — read a document with its row version.
  - `patchWithRetry(store, collection, id, updateFn, options?)` — get → compute → putIfMatch → retry loop for read-modify-write updates. Throws `PatchConflictError` after `maxAttempts` (default 5).
  - Both built-in stores (`InMemoryStateStore`, `PostgresStateStore`) track a monotonically increasing `version` per row. Every `put`/`patch`/`putIfMatch` bumps it.
  - Sessioned stores (`createSessionedStore` / `store.scoped(key)`) proxy the new methods through so scoped views get CAS for free.

  **Postgres migration**
  - `getAdcpStateMigration()` adds `version INTEGER NOT NULL DEFAULT 1` via `ADD COLUMN IF NOT EXISTS`. Existing rows start at version 1. No data rewrite.

  **Docs**
  - `docs/guides/CONCURRENCY.md` gains a section covering `patchWithRetry`, `putIfMatch`, and when to reach for each.

  No breaking changes. Both new methods are optional on the `AdcpStateStore` interface; custom stores that don't implement them keep working.

- 835e633: SessionStore ergonomics + state-store validation (batch 1 of upstream feedback).

  **New**
  - `store.scoped(sessionKey)` on built-in stores + `scopedStore(store, key)` helper that works on any `AdcpStateStore` (falls back to `createSessionedStore` when a custom store doesn't implement the method). Returns a session-isolated view that auto-prefixes ids and filters `list()` by `_session_key`. `::` is reserved as the scope separator and is rejected in session keys and ids so scopes can't collide.
  - `HandlerContext.sessionKey` + `resolveSessionKey` hook on `createAdcpServer`. Sellers derive the scoping key once; handlers read `ctx.sessionKey` instead of re-parsing params.
  - `StateError` with typed codes (`INVALID_COLLECTION`, `INVALID_ID`, `PAYLOAD_TOO_LARGE`, …), built-in charset/length validation on every store operation, configurable `maxDocumentBytes` (5 MB default) on `InMemoryStateStore` and `PostgresStateStore`.
  - `structuredSerialize` / `structuredDeserialize` helpers so handlers can round-trip `Map`, `Set`, and `Date` through the state store without writing per-type converters. Envelope tag is namespaced as `__adcpType` and the deserializer validates payload shape, so caller data that happens to use the same field is passed through unchanged.

  **Docs**
  - `docs/guides/CONCURRENCY.md` — explicit last-writer-wins vs per-row isolation model, the read-modify-write race on whole-session blobs, and why per-entity rows are safer.
  - `docs/guides/TASKRESULT-5-MIGRATION.md` — the four migration patterns for the 5.0 discriminated-union `TaskResult` (success check, error extraction, status narrowing, intermediate states).

  No breaking changes. `scoped` on `AdcpStateStore` is an optional method; custom store implementations that don't define it keep working.

### Patch Changes

- 97f8c8f: Regenerate AdCP schemas and registry from upstream. Pulls in sponsored-intelligence / sales specialism and related domain enums into the generated type exports. Mechanical regen — no handwritten code changes.
- 4e0c482: Response builders now throw a descriptive error when `setup` is placed at the top level of a media buy response. The IO-signing setup URL belongs inside `account.setup` (a field on `Account`), not on the media buy itself. This was a silent trap because `DomainHandler` accepts `Record<string, unknown>` so the strict type wasn't catching it. Affects `mediaBuyResponse`, `updateMediaBuyResponse`, and `getMediaBuysResponse`.

## 5.0.0

### Major Changes

- fc33966: BREAKING: TaskResult is now a discriminated union. Failed tasks use status:'failed' instead of 'completed'. MCP isError responses preserve structured data (adcp_error, context, ext) instead of throwing. Adds adcpError, correlationId, retryAfterMs convenience accessors and isRetryable()/getRetryDelay() utilities.

### Minor Changes

- 5a3c835: Brand rights as a first-class server domain, plus creative-asset record shape alignment

  **Brand rights first-class domain.** `createAdcpServer({ brandRights: {...} })` now accepts a domain group for the three schema-backed tools: `get_brand_identity`, `get_rights`, and `acquire_rights`. No more manual `server.tool()` registration, no bespoke `taskToolResponse` wrapping — context echo, account resolution, and `brand` protocol declaration in `get_adcp_capabilities` all work out of the box.

  `update_rights` and `creative_approval` are intentionally **not** part of the domain group. The AdCP spec has no published JSON schemas for either — `creative_approval` is modeled as a webhook (POST to `approval_webhook` returned from `acquire_rights`), and `update_rights` is only described in prose. Adding permissive passthrough schemas just to satisfy a storyboard would be building to the test. They will be added when upstream schemas land (tracked in https://github.com/adcontextprotocol/adcp).

  **Request-builder honors `sample_request` for `build_creative` and `sync_creatives`.** Hand-authored sample payloads are preserved end-to-end, so storyboards can exercise slot-specific briefs, format-scoped uploads, and multi-format requests without the builder overwriting them. Matches the behavior already present for `update_media_buy`, `create_media_buy`, `sync_plans`, and `calibrate_content`.

  **Creative asset record shape.** All storyboard `sample_request.creatives[].assets` payloads now match the generated `CreativeAssetSchema`, which declares `assets` as `z.record(asset_id, asset)`. Agents validating requests against the generated Zod schemas will no longer reject storyboard payloads that previously used the array-of-asset-objects form. Fixes `creative_lifecycle`, `creative_template`, `creative_generative`, `creative_sales_agent`, `social_platform`, `media_buy_seller`, `media_buy_proposal_mode`, `media_buy_guaranteed_approval`, `deterministic_testing`, and `brand_rights`.

  **Protocol gaps surfaced** (tracked for upstream AdCP spec work):
  - `update_rights` and `creative_approval` lack published JSON schemas — the latter is spec'd as a webhook, so the gap is request/response schemas for either transport
  - `error_compliance` storyboard is media-buy-scoped (requires `get_products`) — needs capability-aware dispatch to cover creative, signals, brand-rights, and governance agents

  **Skill updates.**
  - `build-brand-rights-agent/SKILL.md` rewritten around the new domain group and against the actual `schemas/cache/latest/brand/*.json` shapes (`names` as locale-keyed objects, `logos` with `orientation`/`background`/`variant`, `pricing_options` with `model`/`price`/`uses`, `acquire_rights` status discriminated union). Creative-approval flow is documented as an outbound webhook POST; `update_rights` is documented as a regular HTTP endpoint until schemas land.

- f44c8c9: Add context passthrough testing, format_id reconciliation, and identifier roundtrip validations across all storyboards. Client SDK now preserves context and ext through field stripping via ADCP_ENVELOPE_FIELDS. Runner merges context/ext from sample_request into request builder output.
- 8ad72f4: Added `createAdcpServer` — declarative server builder with domain-grouped handlers, automatic account resolution, response builder wiring, tool annotations, and auto-generated capabilities. Added `checkGovernance` and `governanceDeniedError` composable helpers for governance checks in financial handlers.
- ed52beb: Add `validation.filterInvalidProducts` client option to filter out invalid products from get_products responses instead of rejecting the entire response when some products fail schema validation
- 337fbeb: Fix broken code examples in build-seller-agent skill and improve createAdcpServer DX. Skill fixes: tsc command, creative state transitions, simulateDelivery params, confirmed_at, storyboard table, capabilities casing, channels type inference. Framework fixes: make account optional in registered MCP input schemas for handler-level validation; accept Record<string, unknown> from DomainHandler return types so plain object literals compile without exact type matching. Add compile-time test for all skill file typescript examples.
- 8376f90: Add NetworkConsistencyChecker for validating managed publisher network deployments. Detects orphaned pointers, stale pointers, missing pointers, schema errors, and unreachable agent endpoints. Available as both a library import and CLI command (`adcp check-network`).
- 316565c: Add media buy response builders that eliminate common implementation traps: validActionsForStatus() maps status to valid actions, mediaBuyResponse() auto-defaults revision/confirmed_at/valid_actions, cancelMediaBuyResponse() requires cancellation metadata. Sync schemas from latest AdCP.
- d99b118: Add composable scenario library for seller storyboard certification. Scenarios are small, focused behavior tests (governance outcomes, product refinement, proposal finalize) that specialization storyboards declare via `requires_scenarios`. The compliance engine resolves and runs them alongside the main storyboard, enabling modular certification without duplicating test logic across seller types.
- 5a3c835: Add storyboards, scenarios, and SDK helpers covering AdCP 3.0 primitives
  - New `collection_governance` storyboard for collection list CRUD, webhook delivery, and targeting via `CollectionListReference`
  - New `media_buy_seller/measurement_terms_rejected` scenario exercising the `TERMS_REJECTED` round-trip: buyer proposes unworkable terms, seller rejects, buyer retries with seller-compatible terms
  - New `media_buy_seller/governance_denied_recovery` scenario verifying the buyer can correct a denied buy and retry within plan limits
  - New `media_buy_seller/pending_creatives_to_start` scenario validating the `pending_creatives → pending_start` transition after `sync_creatives`
  - New `media_buy_seller/inventory_list_targeting` scenario exercising `property_list` + `collection_list` targeting on both `create_media_buy` AND `update_media_buy` (catches create/update parity regressions) and verifying persistence via `get_media_buys`
  - New `media_buy_seller/inventory_list_no_match` scenario covering the case where referenced lists resolve to zero matching inventory — seller must return a zero-forecast product or an informative error, not crash
  - New `signal_marketplace/governance_denied` and `brand_rights/governance_denied` scenarios covering governance across signal activation and rights licensing purchase types
  - Extended `error_compliance` with a `version_negotiation` phase that validates `VERSION_UNSUPPORTED` on an unsupported `adcp_major_version` and acceptance of a supported one
  - New `media_buy_seller/invalid_transitions` scenario with hard `error_code` assertions for `MEDIA_BUY_NOT_FOUND`, `PACKAGE_NOT_FOUND`, and `NOT_CANCELLABLE` (state-machine hardening)
  - Hardened existing `error_compliance` probes (`negative_budget`, `reversed_dates_error`, `nonexistent_product`) from soft `field_present: errors` to specific `error_code` assertions via `allowed_values`
  - `check: error_code` validations now accept `allowed_values` in addition to `value`, so scenarios can assert one-of for semantically overlapping codes (e.g. `VALIDATION_ERROR` vs `INVALID_REQUEST`)
  - Wired new scenarios into parent storyboards via `requires_scenarios`
  - Extended `fictional-entities.yaml` with a `collections` section (outdoor, automotive, and food programming) so storyboards have canonical test data for `collection_list` targeting
  - Extended `test-kits/acme-outdoor.yaml` with an `inventory_targets` section providing matching and non-matching `PropertyListReference` / `CollectionListReference` fixtures
  - Added `resolvePropertyList` / `resolveCollectionList` / `matchesPropertyList` / `matchesCollectionList` helpers to `@adcp/client/server` so seller handlers can filter inventory against buyer-supplied list references in one line

- 7116ee7: Type brand_json with Zod schema matching the AdCP brand.json spec. SandboxBrand.brand_json is now typed as BrandJson instead of Record<string, unknown>, and sandbox data is validated at load time. Brand entries use spec-compliant field names (id, names) instead of the previous brand_id/name.
- 48c0501: Close schema pipeline gap: generate TypeScript types and Zod schemas for all missing JSON schemas, add TOOL_REQUEST_SCHEMAS and TOOL_RESPONSE_SCHEMAS exports

### Patch Changes

- 1395e20: Add behavioral compliance validations to brand rights, property governance, and content standards storyboards
  - Brand rights: verify resolved identity data (brand_id match, names present), reject invalid brand IDs, validate creative approval decisions, test expired campaign and nonexistent grant enforcement
  - Property governance: assert compliant/non-compliant delivery verdicts, add enforcement phase with authorized and unauthorized publisher tests, fix context propagation for property_list_id
  - Content standards: assert calibration verdict, add must-rule violation test, add policy version change test with re-calibration, strengthen delivery validation with summary and results checks

- 09a0c3e: Fix storyboard sample_requests and request-builder fallbacks to match AdCP schemas for brand_rights and property_governance
- a8159c9: Enable `--protocol a2a` for storyboard testing. Connection cleanup is now protocol-aware, A2A clients are cached to avoid re-fetching the agent card on every tool call, and the compliance-testing auto-augment log now goes to stderr so it doesn't corrupt `--json` output.
- 5a3c835: Preserve `adcp_major_version` through per-tool field filtering and handle synchronous error responses from MCP Tasks servers. Version-negotiation probes (e.g. intentionally unsupported major versions) now reach sellers intact, and `VERSION_UNSUPPORTED` errors returned synchronously by MCP servers are surfaced to callers rather than being masked by a Tasks SDK validation error.

## 4.30.2

### Patch Changes

- 86d2e3d: Fix ext field being incorrectly stripped from v2 server requests. ext is a protocol-level extension field valid in all AdCP versions and should always be preserved.
- 1a0a863: Fix crash when servers return explicit null for optional array fields (creative_assignments, creative_ids, products) on media buy packages
- 52570f3: Fix brand field being silently stripped when a v3 server is misdetected as v2. The v2 adapter renames brand → brand_manifest, but the schema filter then drops brand_manifest when the tool schema declares brand. Added adapter alias reconciliation so brand_manifest maps back to brand when the schema expects it. Improved version detection logging to surface why get_adcp_capabilities failures cause v2 fallback.

## 4.30.1

### Patch Changes

- b143658: Fix schema-based field stripping to apply for all server versions, not just v3. Fields like idempotency_key and ext that are not declared in the remote server's tool schema are now stripped before sending, preventing validation errors on servers that don't accept them.

## 4.30.0

### Minor Changes

- c3dd940: Add full brand identity blocks (logos, colors, fonts, tone) and creative assets to all test kit YAMLs. New test kits for Bistro Oranje, Summit Foods, and Osei Natural. Enables loading all sandbox brands from @adcp/client instead of hardcoding them.

## 4.29.0

### Minor Changes

- 01ee05b: Add compliance status APIs for buyer integration
  - Added `getAgentCompliance()`, `getAgentStoryboardStatus()`, `getAgentStoryboardStatusBulk()` to RegistryClient
  - Added `lookupOperator()` and `lookupPublisher()` to RegistryClient with typed responses
  - RegistrySync now processes `agent.compliance_changed` feed events and emits typed `compliance_changed` events
  - `AgentSearchResult` includes optional `compliance_summary` field
  - `findAgents()` accepts `compliance_status` filter
  - Exported new types: `AgentCompliance`, `AgentComplianceDetail`, `StoryboardStatus`, `OperatorLookupResult`, `PublisherLookupResult`, `ComplianceChangedPayload`
  - Registry schema sync adds new agent types: `brand`, `rights`, `measurement`, `buying` (additive, non-breaking)

## 4.28.1

### Patch Changes

- 655384f: Fix getCapabilities() silently falling back to synthetic v2 for v3 agents. Make publisher_domains optional in GetAdCPCapabilitiesResponse schema so agents that omit it (e.g. OpenAds) pass validation. Replace bare catch {} with diagnostic logging and re-throw for auth/timeout errors.

## 4.28.0

### Minor Changes

- 43efdc8: Remove dry_run as a protocol concept in favor of sandbox
  - Removed X-Dry-Run HTTP header from test client
  - Removed dry_run from TestOptions, TestResult, SuiteResult, StoryboardResult, ComplianceResult
  - Made sandbox: true the default for all test runs (comply, testAgent, testAllScenarios)
  - Changed CLI --dry-run to preview mode (shows steps without executing, opt-in)
  - Replaced --no-dry-run flag with --dry-run (default is now to execute)

- 02cdc70: Add sandbox entity system for storyboard testing and fix documentation gaps
  - Fix sync_creatives examples in generative seller SKILL.md (status→action, errors as objects)
  - Fix channels enum in TYPE-SUMMARY.md (20 real MediaChannel values, not 8)
  - Add PricingOption variant details to TYPE-SUMMARY.md (CPV parameters)
  - Add fictional-entities.yaml defining all 14 companies from the AdCP character bible
  - Add getSandboxEntities() / getSandboxBrand() / isSandboxDomain() exports from testing module
  - Add sandbox boolean to registry OpenAPI spec (ResolvedBrand, BrandRegistryItem, saveBrand)
  - Migrate all fictional entity domains to IANA-reserved .example TLD
  - Add --sandbox flag to save-brand CLI command

- ce4932a: Sync storyboards from adcp 3.0: broadcast TV seller, generative updates, governance and status fixes
  - Add media_buy_broadcast_seller storyboard (linear TV with Ad-ID, measurement windows, C7 reconciliation)
  - Update creative_generative and media_buy_generative_seller storyboards
  - Fix governance storyboards: status→decision field, binding structure, domain→.com
  - Fix media buy storyboards: status lifecycle (pending_activation→pending_creatives/pending_start)
  - Fix path references (media_buys→media_buy_deliveries, field_value additions)
  - Fix signal storyboards: validation and path corrections

### Patch Changes

- bcf2651: Fix adcp_major_version breaking v2 seller tool calls
  - Stop injecting adcp_major_version into tool args for v2 sellers (strict Pydantic schemas reject it)
  - Make ProtocolClient version-aware via serverVersion parameter
  - Strip adcp_major_version in all v2 request adapters as belt-and-suspenders

## 4.27.0

### Minor Changes

- 9bb0a66: Deprecate `adcp comply` CLI command in favor of `adcp storyboard run`. Running `adcp storyboard run <agent>` without a storyboard ID now runs all matching storyboards (the same behavior as `adcp comply`). The `comply` command still works but prints a deprecation warning and will be removed in v5.

### Patch Changes

- eed5456: Add context extractors for list_creatives, sync_catalogs, sync_audiences, and sync_event_sources so storyboards can use $context references instead of hardcoded IDs

## 4.26.2

### Patch Changes

- 49c0466: Add check_governance and report_plan_outcome context extractors to storyboard runner

## 4.26.1

### Patch Changes

- 6e1eb2d: fix: get_signals builder passes through signal_ids from sample_request, activate_signal removes hardcoded platform destination fallback

## 4.26.0

### Minor Changes

- 51068e1: Improve comply runner signal-to-noise ratio against real agents
  - Skip storyboard steps when agent doesn't implement the tool (new `missing_tool` skip reason)
  - Detect unresolved `$context` placeholders and skip with `dependency_failed` instead of sending invalid requests
  - Catch "Unknown tool" errors from agents and convert to skips
  - Add rate limit retry with exponential backoff and jitter (3 retries, 2s/4s/8s base)
  - Fix `sync_creatives` request builder to send creatives for all discovered formats, not just the first (#482)
  - Fix `mapStepToTestStep` to preserve runner's skip semantics (skips no longer counted as failures)
  - Fix `extractErrorData` to handle nested JSON in error messages
  - Truncate agent error messages to 2000 chars to prevent report bloat

- 24d9c97: Storyboard infrastructure and skill validation for all 16 remaining storyboards
  - Fix response-unwrapper `_message` stripping for union schema validation (Zod v4 compatibility)
  - Fix `expect_error` handling for `schema_validation` reversed_dates step
  - Add `requires_tool` to governance storyboard steps that need seller tools
  - Add request builders for governance, content standards, brand rights, SI tools
  - Add context extractors for `create_content_standards`, `get_rights`, `acquire_rights`
  - Register missing response schemas: `create_content_standards`, `update_content_standards`, `validate_property_delivery`
  - Add task-map entries: `check_governance`, `create_content_standards`, `update_content_standards`, `get_account_financials`, `log_event`
  - Fix campaign governance YAML sample_requests to match current schemas
  - Fix content standards YAML sample_requests (scope, artifact, records fields)
  - Sync PLATFORM_STORYBOARDS with storyboard platform_types declarations
  - New test: storyboard-completeness.test.js (structural validation for all bundled storyboards)
  - New skills: build-governance-agent, build-si-agent, build-brand-rights-agent
  - Updated skills: build-seller-agent (error responses), build-creative-agent (asset shapes)

### Patch Changes

- 8ed8fe9: fix: comply runner sends account.sandbox: true in test controller requests

  comply_test_controller request builder now injects account with sandbox: true so the training agent does not return FORBIDDEN during deterministic testing

## 4.25.0

### Minor Changes

- 5d5b2ec: Fix SSE transport fallback, schema validation, and compliance testing detection
  - Track successful StreamableHTTP connections and skip SSE fallback on reconnection (prevents 405 errors on POST-only servers)
  - Improve union schema error messages with field-level detail instead of generic "Invalid input"
  - Consolidate ResponseValidator to use canonical TOOL_RESPONSE_SCHEMAS map
  - Auto-augment declared capabilities when comply_test_controller is present but compliance_testing protocol is not declared
  - Fix brand_rights storyboard sample_requests to match protocol schemas (brand_id, rights_id, context flow)
  - Add brand rights response schemas for schema drift checking
  - Add --timeout flag to `adcp comply` CLI (default 120s) so storyboard runs have a budget

- 7de4434: Add 13 typed response builders for server-side AdCP tools, add `@adcp/client/server` subpath export, and add setup instructions to all build skills

### Patch Changes

- 8acb2d0: Fix normalizeFormatsResponse to handle raw array responses from creative agents, and distinguish missing test harness from not-testable skip reasons in storyboard runner
- 71e2de3: Fix storyboard field name drift: governance `decision`→`status`, creative `results`→`creatives`, audit log `entries`→`plans[0].entries`, setup path nesting. Fix context extractors for build_creative, sync_creatives, activate_signal, create_property_list. Deprecate `CommittedCheckRequest.mediaBuyId` (removed from protocol). Add schema drift detection test.

## 4.24.0

### Minor Changes

- daea974: Add brand rights protocol test scenarios (brand_identity, brand_rights_flow, creative_approval) and brand compliance track
- 3e79195: Added PostgresTaskStore for distributed MCP servers. Replaces InMemoryTaskStore when running multiple server instances behind a load balancer, storing tasks in a shared PostgreSQL table. Includes MCP_TASKS_MIGRATION SQL constant and cleanupExpiredTasks() utility.
- 14206aa: Comply CLI DX improvements: failures array, expected text, storyboard filtering, SKILL.md
  - `ComplianceResult.failures[]` — flat array of failed steps with storyboard_id, step_id, expected text, error, and fix_command for targeted re-running
  - `adcp comply --storyboards media_buy_seller,error_compliance` — run specific storyboards (validated against bundled set)
  - "How to Fix" section in human-readable comply output with expected responses and debug commands
  - `adcp storyboard show` now displays narratives and expected responses (was titles-only)
  - `adcp storyboard list` now includes `track` field in JSON output
  - `adcp storyboard step --context @file.json` — read context from file (no shell escaping)
  - Updated SKILL.md with comply/storyboard workflow, routing, and filtering options
  - Top-level help clarifies comply vs storyboard vs test relationship
  - `ComplianceResult.storyboards_executed` (optional) lists which storyboard IDs were executed
  - Scenario names in track results changed from bare `phase_id` to `storyboard_id/phase_id`

- 41e9f9e: Added registerTestController(server, store) and TestControllerStore for server-side comply_test_controller implementation. Sellers can add deterministic compliance testing support with one function call instead of implementing the tool from scratch. Also adds skip_reason field to StoryboardStepResult to distinguish "not testable" (agent lacks tool) from "dependency failed" (prior step failed).

### Patch Changes

- 69a6dde: Add build-seller-agent skill (`skills/build-seller-agent/SKILL.md`) that guides coding agents through domain decisions and implementation of a seller MCP server
- c56645a: Fix storyboard request builder gaps found during real-agent validation: always include pricing_option_id in create_media_buy, add measurement_period to provide_performance_feedback, add 6 missing request builders, register 7 missing response schemas

## 4.23.0

### Minor Changes

- 6dc5ad0: Storyboard-driven compliance routing: comply() now resolves storyboards directly instead of routing through tracks. Added `storyboards` option, `PLATFORM_STORYBOARDS` mapping, `extractScenariosFromStoryboard()`, and `filterToKnownScenarios()`. Tracks are now a reporting layer derived from storyboard results.

## 4.22.1

### Patch Changes

- 744c829: serve() now creates a shared task store and passes it to the agent factory via ServeContext, fixing MCP Tasks protocol (tasks/get) failures over stateless HTTP where each request previously got its own empty task store.

## 4.22.0

### Minor Changes

- ee1753d: Send adcp_major_version on every request per adcontextprotocol/adcp#1959. Sellers can validate the declared version against their supported range and return VERSION_UNSUPPORTED on mismatch.
- 68da21e: Add `serve()` helper for zero-boilerplate agent HTTP servers, fix examples to use npm-consumer import paths, and ship docs/llms.txt + BUILD-AN-AGENT.md in the npm package for agent discoverability.
- ea93508: Migrate comply() to storyboard-driven testing. The compliance engine now runs storyboard YAMLs instead of hand-written scenario functions. Adds YAML format extensions (expect_error, requires_tool, context_outputs/context_inputs, error_code validation) and 10 new compliance storyboards covering governance, SI, brand rights, state machines, error compliance, schema validation, behavioral analysis, audiences, and deterministic testing. Deprecates SCENARIO_REQUIREMENTS, DEFAULT_SCENARIOS, and testAllScenarios() in favor of storyboard execution.
- ea93508: Add storyboard-driven testing module with CLI support. Storyboards are YAML-defined test workflows that map directly to SingleAgentClient methods, enabling step-by-step agent testing. Includes 12 bundled storyboards from the AdCP spec, a stateless per-step CLI (`adcp storyboard step`) designed for LLM consumption, and platform type tags for backwards compatibility with the existing compliance system.
- e5002a4: Add `userAgent` config to `PropertyCrawlerConfig` and `TestOptions`, threaded through to all outbound HTTP requests via both MCP and A2A transports. Wire the existing but unused `SingleAgentClientConfig.userAgent` field into protocol headers. Export `PropertyCrawlerConfig` type from public API.

### Patch Changes

- 913fadd: Add generated agent documentation (llms.txt, TYPE-SUMMARY.md) and update SKILL.md with all 24 test scenarios
- cc07055: Fix skipped-step counting in storyboard runner and add tool_discovery diagnostic observations to comply(). Steps skipped due to requires_tool are now correctly counted as skipped instead of passed, and comply() emits observations showing discovered tools and expected-vs-actual tools when tracks are skipped.

## 4.21.0

### Minor Changes

- bb491ed: Sync schemas and types for AdCP 3.0.0-rc.3

### Patch Changes

- 21b2053: fix: eliminate comply tester false positive observations
  - Add `observation_data` field to `TestStepResult` to separate structured data (for observations) from display-only `response_preview`, eliminating false positives from snapshot-only `get_media_buys` previews
  - Handle nested `media_buy` response envelope when extracting `canceled_by`, `canceled_at`, and `revision` from cancel step
  - Suppress schema validation console noise via existing `logSchemaViolations` config instead of monkey-patching console

## 4.20.0

### Minor Changes

- 3bff582: Add RegistrySync for in-memory registry replica with agent/authorization indexes, event feed polling, and zero-latency lookups. Add `lookupDomains()` for concurrent domain→agent resolution. Parallelize `lookupPropertiesAll()` with configurable concurrency. Align registry sync types with live server.

## 4.19.0

### Minor Changes

- d0dc6b5: Add dedicated `reporting_flow` scenario for precise reporting compliance evaluation. The reporting track now uses `reporting_flow` (which requires `get_media_buy_delivery`) instead of piggybacking on `full_sales_flow`.

## 4.18.2

### Patch Changes

- e3cb1c3: fix: stop early-exiting product discovery for v2 servers when request contains property_list or required_features filters that are already stripped by the v2 adapter

## 4.18.1

### Patch Changes

- 60bc7b2: Add unknown flag detection to `comply` command with "did you mean?" suggestions, and remove 5 unused dependencies (better-sqlite3, @types/better-sqlite3, @apidevtools/json-schema-ref-parser, json-schema-to-ts, markdown-it)
- 64a4bdb: Fix A2A capability detection using `skill.id` instead of `skill.name` for tool mapping, so `buildSyntheticCapabilities` correctly identifies protocols like `media_buy` from A2A agent cards

## 4.18.0

### Minor Changes

- c93b30b: Add `overall_status`, `tested_tracks`, `skipped_tracks`, and `expected_tracks` to ComplianceResult; accept `platform_type` as string with internal validation

## 4.17.0

### Minor Changes

- c6a167e: Add `linear_tv_platform` platform type for agents transacting linear TV inventory. Includes CPP and CPM pricing, reserved inventory model, and broadcast-specific creative workflow (ISCI codes via sync_creatives).

  Add `get_media_buy_delivery` as an expected tool for all sales platform profiles. Every platform with a reporting track should support delivery data — this was previously only expected on DSP and generative DSP profiles.

  Add behavioral characteristics (`inventory_model`, `pricing_models`) to all platform profiles. Add `cpc` pricing model for search and retail media platforms. Add `cpp` pricing model for linear TV.

  Remove deprecated `FormatCategory` type, `CreativeFormatType` type, `findByType()` from `CreativeAgentClient`, and `findFormatsByType()` from `ADCPMultiAgentClient`. These were deprecated in favor of filtering by format assets directly.

## 4.16.2

### Patch Changes

- beb7ece: fix: strip buyer_ref before strict validation in validateRequest() to preserve backward compatibility with pre-4.15 servers

## 4.16.1

### Patch Changes

- f34a58d: fix: add buyer_ref backward compatibility shim for pre-4.15 servers on create_media_buy and update_media_buy

## 4.16.0

### Minor Changes

- 4c4bf89: Add comply_test_controller support for deterministic lifecycle compliance testing. When a seller exposes the optional `comply_test_controller` tool in sandbox mode, comply walks full state machines by forcing seller-side transitions instead of just observing. Includes 7 new scenarios: creative state machine, media buy state machine, account state machine, SI session state machine, delivery simulation, budget simulation, and controller self-validation.
- a965023: Add `timeout_ms` and `signal` options to `comply()` for timeout and cancellation support. `timeout_ms` stops new scenarios from starting when exceeded. `signal` accepts an `AbortSignal` for external cancellation (e.g., graceful shutdown). Both options compose — either can trigger abort.

### Patch Changes

- 502b1ae: Fix CodeQL code scanning alerts: eliminate ReDoS in webhook agent ID inference, sanitize error logging to prevent sensitive data exposure, and harden GitHub Actions workflow permissions
- c1a9abf: Improve schema validation error messages for union response schemas (create_media_buy, activate_signal, build_creative, etc.). Previously, validation failures on these tools produced the unhelpful `(root): Invalid input`. Now reports the specific missing or invalid fields from the closest-matching schema variant (e.g., `media_buy_id: expected string, received undefined`). Also fixes TaskExecutor.extractResponseData() to retry unwrapping without schema validation when the initial call fails.

## 4.15.0

### Minor Changes

- 656e5f2: Add audience governance schemas, match breakdown, and compliance testing.

  **Schemas**: audience-selector (signal ref or description discriminated union), audience-constraints (include/exclude), restricted-attribute (GDPR Article 9 enum), match-id-type (hashed PII + universal IDs). Synced from AdCP PR #1593.

  **Breaking upstream changes**: `buyer_ref` removed from create/update_media_buy, `buyer_campaign_ref` removed from check_governance/report_plan_outcome, `governance_context` changed from structured object to opaque string token. GovernanceMiddleware, GovernanceAdapter, and TaskExecutor updated accordingly.

  **Compliance**: sync_audiences response schema registered for validation. Campaign governance scenarios added to comply() governance track. sync_plans now exercises policy_categories, audience constraints, and restricted_attributes. Delivery monitoring includes audience_distribution indices. Signals flow reports governance metadata availability.

- fef68a7: Add governance_context round-trip verification to comply() with stub governance agent for active seller testing
- 83ecdcc: Support MCP Tasks protocol for async tool calls

  When connected to MCP servers that declare `capabilities.tasks.requests.tools.call`, the client now uses MCP Tasks protocol methods (`tasks/get`, `tasks/result`, `tasks/cancel`, `tasks/list`) instead of custom AdCP tool calls for async lifecycle management. This removes the LLM from the polling path and aligns with the MCP specification (2025-11-25 experimental).

  Client-side: `ProtocolClient.callTool()` transparently uses `callToolStream()` when the server supports tasks, falling back to standard `callTool` otherwise. `TaskExecutor.getTaskStatus()` and `listTasks()` use protocol-level methods when available.

  Server-side: New helpers for publishers to add MCP Tasks support — `createTaskCapableServer()`, `registerAdcpTaskTool()`, `taskToolResponse()`, plus re-exports of `InMemoryTaskStore`, `TaskStore`, and `isTerminal` from the MCP SDK.

- 8ea9139: Support order lifecycle management from AdCP spec.
  - Cancellation fields on media buys and packages (`canceled`, `canceled_at`, `canceled_by`, `cancellation_reason`)
  - `confirmed_at` timestamp on create and get responses
  - `revision` for optimistic concurrency on create, get, and update
  - `valid_actions` on responses so agents know permitted operations per state
  - `include_history` parameter and revision history on `get_media_buys`
  - Per-package `creative_deadline` for mixed-channel orders
  - 6 new error codes: `INVALID_STATE`, `NOT_CANCELLABLE`, `MEDIA_BUY_NOT_FOUND`, `PACKAGE_NOT_FOUND`, `VALIDATION_ERROR`, `BUDGET_EXCEEDED`
  - `CanceledBy` enum type (`buyer` | `seller`)
  - Updated governance middleware for upstream schema changes (`governance_context` now opaque string, `buyer_campaign_ref` removed from governance requests)

## 4.14.0

### Minor Changes

- 9338bb4: Add state machine compliance scenarios to comply framework: media_buy_lifecycle (pause/resume/cancel transitions), terminal_state_enforcement (reject updates to canceled buys), and package_lifecycle (package-level pause/resume independent of media buy status). Includes valid_actions and pause/resume observations.

### Patch Changes

- a7f4585: Fix CLI to use saved OAuth tokens automatically instead of requiring --auth flag on every request
- 2fff9d6: Fix comply() response validation: validate required fields and enum values against Zod schemas (#371, #372), fix signals_flow sending brief instead of signal_spec (#373)

## 4.13.0

### Minor Changes

- fc34114: Add getPlatformTypesWithLabels() for platform type discovery with labels. Fix buildStaticInlineCreative missing required creative_id. Fix activateSignal to use spec field names (signal_agent_segment_id, destinations) with backward-compat normalizer shims.
- 8e30a66: Re-export commonly needed nested types (PackageUpdate, Package, Destination, SignalFilters, PricingOption, PriceGuidance, Episode, ShowSelector) from main entry point. Add typesVersions to package.json so subpath imports work under moduleResolution: node. Fix ./types subpath to include runtime entries for Zod schema imports.
- 8205a86: Fix schema .shape compatibility and add server-side helpers
  - Fix 9 broken Zod request schemas that had .and() intersections breaking MCP SDK server.tool() registration
  - Add typed response builders (capabilitiesResponse, productsResponse, mediaBuyResponse, deliveryResponse)
  - Add adcpError() helper for L3-compliant structured error responses
  - Add error extraction utilities for client-side error classification
  - Add error compliance test scenario for comply

### Patch Changes

- daac3ca: Fix generated Zod schemas breaking MCP SDK JSON Schema conversion

  Remove `z.undefined()` from generated union types (e.g., `z.union([z.boolean(), z.undefined()])` → `z.boolean()`) since `z.undefined()` has no JSON Schema representation and causes `toJSONSchema()` to throw. Also strip redundant `.and(z.record(...))` intersections that create `ZodIntersection` types losing `.shape` access needed by MCP SDK for tool registration.

- 2e87c5a: Fix MCP connection exhaustion during comply/test runs by reusing cached connections instead of creating a new TCP connection per tool call. Adds auth-aware cache keying, LRU eviction, and transport-error-only retry logic.
- fc5b158: Remove as-any casts from core library code for improved type safety
- 0d2a781: Enable `noUncheckedIndexedAccess` in TypeScript config for safer array/record access

## 4.12.0

### Minor Changes

- c9d32f1: Support both /.well-known/agent.json (current A2A spec) and /.well-known/agent-card.json (legacy) for agent card discovery

### Patch Changes

- 9bc632c: Fix `audienceManagement` capability flag never being detected. The Zod schema and wire format define the feature flag as `audience_targeting`, but `parseCapabilitiesResponse` was reading `audience_management`. Renamed the internal `MediaBuyFeatures` property to match schema naming and updated `TASK_FEATURE_MAP` so `sync_audiences` correctly requires the flag.
- 9bc632c: Fix `get_products` responses with non-array `products` field crashing downstream consumers. Added Zod schema validation for `get_products` responses in the response unwrapper and updated `normalizeGetProductsResponse` to convert malformed responses to AdCP error responses instead of silently passing through.
- 9fce3ec: Replace `any` types with `unknown` and concrete types at protocol boundaries, error classes, logger, and internal client casts

## 4.11.0

### Minor Changes

- 40bd0b7: Add platform-type-aware compliance testing. Users can declare what they're building (e.g., `--platform-type social_platform`) and comply will validate coherence, show expected-but-missing tracks, and provide actionable build guidance. Remove convince assessment from SDK.

### Patch Changes

- ccdee67: Fix test harness `create_media_buy` scenarios failing with `account: Invalid input`

  The `buildCreateMediaBuyRequest` helper was not including the required `account` field,
  causing client-side Zod validation to reject the request before it reached the agent.
  - Add `account: resolveAccount(options)` to `buildCreateMediaBuyRequest`
  - Add backwards-compatible `account` inference in `normalizeRequestParams` so callers
    that pre-date the required `account` field keep working (derived from `brand`)

- c8604f4: Fix OAuth protected resource validation for servers behind reverse proxies or DNS aliases. The MCP SDK's default same-origin check rejected servers that advertise a canonical resource URL different from the connection URL. The client now accepts cross-origin resource URLs while enforcing HTTPS.

## 4.10.0

### Minor Changes

- 6c60e35: Add `comply` and `convince` assessment flows to the testing surface and CLI.
  - add compliance track reporting via `adcp comply`
  - add AI-assisted merchandising assessment via `adcp convince`
  - export the new compliance helpers from `@adcp/client/testing`

## 4.9.0

### Minor Changes

- 6950b52: Add OpenTelemetry tracing support for observability
  - Added `@opentelemetry/api` as an optional peer dependency
  - New `withSpan()` utility wraps async operations in OTel spans
  - Instrumented `ProtocolClient.callTool()`, `callMCPTool()`, `callA2ATool()`, and `connectMCPWithFallback()`
  - Trace context headers (`traceparent`) automatically injected into tool call requests (excludes discovery endpoints to avoid leaking trace IDs to untrusted servers)
  - All tracing is no-op when `@opentelemetry/api` is not installed
  - Exported utilities: `getTracer`, `isTracingEnabled`, `injectTraceHeaders`, `withSpan`, `addSpanAttributes`, `recordSpanException`

  When consumers use an OTel-compatible observability system (Sentry, Datadog, etc.), spans from this library automatically appear as children of the consuming application's traces.

- 4d9d03c: Fix creative protocol testing issues and add creative_lifecycle scenario
  - Fix preview_creative test calls to use current schema (request_type: 'single' + creative_manifest)
  - Remove incorrect media_buy gate on sync_creatives (now dual-domain with creative protocol)
  - Fix cross-validation false positives from shared tools (list_creative_formats, list_creatives, sync_creatives)
  - Respect min_spend_per_package when building test media buy requests
  - Add creative_lifecycle scenario: format validation, bulk sync, snapshot testing, build/preview

- d855c7e: Add governance SDK support: GovernanceMiddleware for buyer-side transaction validation, governance adapter, governance test scenarios, and capabilities discovery for governance protocol detection. TaskExecutor now intercepts tool calls to check governance before execution, auto-applies conditions, and reports outcomes.

  **Schema refresh (breaking):**
  - Removed `stats.hosted` from `listBrands` response — consumers reading this field will get a compile error
  - New enum members: `MediaChannel: 'ai_media'`, `TaskType: 'get_brand_identity' | 'get_rights' | 'acquire_rights'`, `AdCPDomain: 'brand'` — may break exhaustive switch/assertNever patterns
  - `limit`/`offset` parameters in `listPolicies`, `getBrandHistory`, `getPropertyHistory`, `getPolicyHistory` typed as `string` (upstream registry.yaml issue)

## 4.8.0

### Minor Changes

- 561df2e: Add creative library protocol support. `list_creatives` now available in both media-buy and creative domains for agents that host creative libraries. `build_creative` gains library retrieval mode via `creative_id`, `library_id`, and `macro_values` fields. New `CreativeVariable` type for DCO variable definitions. `CreativeFilters` extended with `format_ids`, `format_types`, `has_variables`, `has_served`, and `concept_ids`. `has_creative_library`, `supports_generation`, and `supports_transformation` capability flags added. `CreativeAgentClient` gains `listCreatives()` method.

### Patch Changes

- 1f35004: Emit expected/found/missing tool diffs on capability_discovery cross-validation failure, and surface step-level failure details in formatSuiteResults output
- a94a8db: Remove testing UI server and Fly.io deployment. The testing framework is now available via the CLI (`npx @adcp/client`) and Addie. Removes `dotenv` from dependencies (was only used by the server).
- 28d53e6: Extract sandbox account resolution into testable resolveAccountForAudiences function. Add step details for sandbox discovery fallback paths. Add 11 unit tests covering all sandbox resolution branches.

## 4.7.2

### Patch Changes

- 7970f11: Update sandbox account descriptions to clarify behavior by account model. Implicit accounts declare sandbox via sync_accounts with sandbox: true. Explicit accounts discover pre-existing sandbox test accounts via list_accounts. Testing framework now tries explicit sandbox discovery before falling back to natural key.
- d7bc11e: Fix executeTask() to run version adaptation and response normalization, matching the pipeline used by typed methods like getProducts(). Previously, v3-only fields like buying_mode were sent to v2 agents, causing rejection errors.

## 4.7.1

### Patch Changes

- bb0669c: Fix webhook HMAC signature verification to use raw HTTP body bytes instead of re-serialized JSON. `verifyWebhookSignature()` now accepts a raw body string (preferred) or parsed object (backward compat). This fixes cross-language interop where different JSON serializers produce different byte representations.

## 4.7.0

### Minor Changes

- 254a80f: Add sandbox support to AccountCapabilities and testing scenarios. Sellers declaring `account.sandbox: true` in capabilities are now parsed and exposed via `supportsSandbox()`. Test scenarios support `sandbox: true` option to use the natural key (brand + operator + sandbox) without provisioning. Audience sync scenario updated to use `AccountReference` instead of deprecated bare `account_id`.

## 4.6.0

### Minor Changes

- c614f3d: Fix AdCP errors (plural) envelope detection in TaskExecutor, add step-level failure details to formatSuiteResults, and add feature capability validation API (supports/require)

## 4.5.2

### Patch Changes

- fcf2da6: Preserve brand_manifest through request normalization so agents that require it receive it. The normalizer now derives brand from brand_manifest without deleting it.
- d1c85f3: fix: add SSE transport fallback to MCP endpoint discovery

  discoverMCPEndpoint() was only probing candidate URLs with StreamableHTTPClientTransport. Agents that exclusively support the older SSE transport were rejected at the discovery gate, even though callMCPTool() would have handled them correctly. The testEndpoint() helper now mirrors the StreamableHTTP → SSE fallback already present in the tool-call path, so SSE-only agents pass discovery and reach the tool call successfully.

## 4.5.1

### Patch Changes

- dbfff62: Improve type discoverability for platform implementors with naming convention guide in export comments
- 610a4e7: fix: make v3-required by_package fields optional for v2.x agent backward compatibility

  Real-world agents implementing v2.5/v2.6 of the AdCP spec were failing schema validation because v3 added new required fields (pricing_model, rate, currency, breakdown item IDs, total_budget, approval_status) that older agents don't send. Added a BACKWARD_COMPAT_OPTIONAL_FIELDS mechanism to generate-types.ts that removes specified fields from required arrays before TypeScript/Zod generation, without touching the canonical JSON schemas.

## 4.5.0

### Minor Changes

- 128fc8b: Add v3 protocol testing scenarios: property_list_filters, si_handoff, schema_compliance
  - `property_list_filters`: Tests all 4 property list filter types (garm_categories, mfa_thresholds, custom_tags, feature_requirements) with round-trip validation via get_property_list resolve:true
  - `si_handoff`: Tests ACP handoff flow — initiates session, sends purchase-intent message, terminates with `reason: 'handoff_transaction'`, validates acp_handoff structure
  - `schema_compliance`: GET-only validation of v3 field correctness: channel enum values (hard fail on invalid), pricing field names (fixed_price, floor_price placement), format assets structure
  - Adds UI element schema validation to `si_session_lifecycle`: validates all 8 element types (text, link, image, product_card, carousel, action_button, app_handoff, integration_actions) and type-specific required fields
  - Fixes `si_terminate_session` using invalid `reason: 'user_ended'` — corrected to `'user_exit'`

### Patch Changes

- c717bca: Fix MCP discovery probe and A2A canonical URL fetch dropping agent.headers

  Custom headers (e.g. Basic auth) set on an agent config were forwarded to
  callMCPTool correctly but were missing from the initial MCP endpoint discovery
  probe and the A2A canonical URL fetch. Both paths now include agent.headers in
  the same merge order used by the protocol layer: custom headers first, then
  auth_token auth headers on top.

## 4.4.0

### Minor Changes

- 5606dce: Generated Zod object schemas now use `.passthrough()` so unknown fields from agent responses are preserved instead of stripped. Consumers who receive catalog items or other objects with platform-specific extra fields no longer lose those fields after validation.

## 4.3.0

### Minor Changes

- a98c764: Support HTTP Basic auth in testing SDK and fix MCP SSE fallback auth forwarding
  - `TestOptions.auth.type` now accepts `'basic'` in addition to `'bearer'`
  - Basic auth routes the pre-encoded token to `agentConfig.headers` as `Authorization: Basic <token>` instead of `agentConfig.auth_token`, preventing the library from double-wrapping it as Bearer
  - MCP SSE transport fallback now forwards the `Authorization` header via `?auth=` URL param (same workaround already used for `auth_token`), so Basic auth works on agents that only support the older SSE transport
  - Header name lookup for SSE fallback is now case-insensitive
  - A2A debug log now redacts the `Authorization` header value regardless of whether `auth_token` is set (previously only redacted when `auth_token` was present)

### Patch Changes

- 2ea16e3: Fix package.json license field to Apache-2.0 (matching LICENSE file), refine plugin.json description and keywords, correct scenario count from 19 to 20 in SKILL.md.

## 4.2.0

### Minor Changes

- 0f28aa7: Add Claude Code plugin with `/adcp` skill for calling agents, running compliance tests, and querying the registry directly from Claude Code. Includes `.claude-plugin/plugin.json` manifest for marketplace distribution.

## 4.1.0

### Minor Changes

- 5d0c1d2: Sync upstream AdCP v3 schema changes

  **Breaking changes:**
  - `PackageRequest.optimization_goal` (scalar) renamed to `optimization_goals` (array). The seller now optimizes toward goals in priority order. Update all `create_media_buy` callers to pass an array inside each package.
  - `PackageRequest.catalog` (scalar) renamed to `catalogs` (array). Each catalog should have a distinct type. The v2 downgrade adapter uses `catalogs[0]`; multi-catalog support requires v3 servers.
  - `Measurement` type renamed to `OutcomeMeasurement` on `Product.outcome_measurement`.
  - `SyncAccountsRequest` restructured: `house` account type removed; `brand` and `operator` (both required) replace the old free-form structure; billing enum values changed.
  - `SyncAccountsResponse`: `account_id` removed; `parent_account_id` replaced by `account_scope` enum.
  - `ActivateSignalRequest`: `deployments` renamed to `destinations`; new optional `action: 'activate' | 'deactivate'` field added (defaults to `'activate'`).
  - `GetProductsRequest`: `feedback`, `product_ids`, and `proposal_id` fields removed; `refine` buying mode added.
  - `AudienceMember.external_id` is now a required field (was absent). All `sync_audiences` callers must supply a stable buyer-assigned ID per member.
  - `'external_id'` removed from `UIDType` union. Use the top-level `AudienceMember.external_id` field instead.
  - `FrequencyCap.suppress_minutes` is now optional (was required). The type now supports two independent capping modes: recency gate (`suppress_minutes`) and volumetric cap (`max_impressions` + `per` + `window`). At least one must be set.
  - `MediaBuyStatus` now includes `'rejected'` as a terminal state.

  **New features:**
  - `reach` added as an `OptimizationGoal` kind with `reach_unit` and `target_frequency` fields
  - Keyword targeting via `TargetingOverlay.keyword_targets` and `negative_keywords` (search/retail media)
  - Keyword management on `UpdateMediaBuyRequest`: `keyword_targets_add/remove`, `negative_keywords_add/remove`
  - `by_keyword` delivery breakdown in `GetMediaBuyDeliveryResponse`
  - Signal pricing restructured into typed `CpmPricing | PercentOfMediaPricing | FlatFeePricing` models
  - `GetSignalsRequest` updated: `deliver_to` replaced by top-level `destinations?` and `countries?`
  - `ActivateSignalRequest` gains `account_id` and `buyer_campaign_ref`
  - `SignalFilters.max_percent` for filtering percent-of-media signals
  - `buying_mode: 'refine'` for iterative product selection workflows
  - `supports_keyword_breakdown` added to `ReportingCapabilities`
  - Keyword targeting capability flags (`keyword_targets`, `negative_keywords`) in `GetAdCPCapabilitiesResponse`
  - New exports: `OptimizationGoal`, `ReachUnit`, `TargetingOverlay`, `OutcomeMeasurement`, `SignalPricingOption`, `SignalPricing`, `CpmPricing`, `PercentOfMediaPricing`, `FlatFeePricing`
  - New exports: `CreativeBrief`, `CreativeManifest`, `BuildCreativeRequest`, `BuildCreativeResponse`, `PreviewCreativeRequest`, `PreviewCreativeResponse`, `GetMediaBuysRequest`, `GetMediaBuysResponse`
  - New exports: `ImageAsset`, `VideoAsset`, `AudioAsset`, `TextAsset`, `URLAsset`, `HTMLAsset`, `BriefAsset`, `ReferenceAsset`, `EventCustomData`
  - New exports: `Duration`, `DeviceType`, `DigitalSourceType`, `FrequencyCap`, `GeographicBreakdownSupport`
  - New exports: `StandardErrorCode`, `ErrorRecovery`, `TaskErrorDetail`, `STANDARD_ERROR_CODES`, `isStandardErrorCode`, `getErrorRecovery` — standard error code vocabulary for programmatic agent recovery

  **Migration guide: account_id → AccountReference**

  All account-scoped tools now use `account: AccountReference` (a typed discriminated union) instead of the bare `account_id: string`. The `AccountReference` type is exported from `@adcp/client`.

  ```typescript
  // Before
  { account_id: 'acct_123', media_buy_ids: [...] }

  // After
  { account: { account_id: 'acct_123' }, media_buy_ids: [...] }
  ```

  `AccountReference` is a union: `{ account_id: string } | { brand: BrandReference; operator: string }`. Use `account_id` after receiving a seller-assigned ID from `sync_accounts` or `list_accounts`.

  **Automatic backward-compat conversions:**

  The client library auto-converts these deprecated fields with a one-time console warning:

  | Legacy field                       | Converted to                 | Scope                            |
  | ---------------------------------- | ---------------------------- | -------------------------------- |
  | `account_id: string`               | `account: { account_id }`    | All tools                        |
  | `campaign_ref`                     | `buyer_campaign_ref`         | All tools                        |
  | `deployments`                      | `destinations`               | activate_signal                  |
  | `deliver_to`                       | `destinations`               | get_signals                      |
  | `PackageRequest.optimization_goal` | `optimization_goals: [goal]` | create/update_media_buy packages |
  | `PackageRequest.catalog`           | `catalogs: [catalog]`        | create/update_media_buy packages |

  Additionally, the following conversions from earlier releases continue to apply:

  | Legacy field                        | Converted to        | Scope                          |
  | ----------------------------------- | ------------------- | ------------------------------ |
  | `brand_manifest` (string or object) | `brand: { domain }` | get_products, create_media_buy |
  | `product_selectors`                 | `catalog`           | get_products                   |

  These shims ease migration but will be removed in a future major version. Update your code to use the new field names.

## 4.0.2

### Patch Changes

- 2867b24: fix: strip undeclared fields from get_products for partial v3 agents

  Agents that declare `get_adcp_capabilities` (detected as v3) but whose `get_products` inputSchema omits some v3 fields (e.g. `brand`, `buying_mode`) would receive those fields and reject them with a Pydantic `unexpected_keyword_argument` error.

  The client now filters request params to only the fields declared in the agent's cached inputSchema for any v3 tool call. This replaces the previous per-field approach (`toolDeclaresField`) with a general schema-based filter that handles all undeclared fields automatically.

- be452e6: Add v2/v3 adapter for sync_creatives requests

  Introduces `adaptSyncCreativesRequestForV2` which strips the v3-only `account` field and `catalogs` array from each creative, and converts the v3 `status` enum (`'approved'` / `'rejected'`) to the v2 `approved` boolean before sending to v2 servers.

## 4.0.1

### Patch Changes

- 7c6e168: Fix v2/v3 backwards compatibility for create_media_buy, update_media_buy, and get_products

  **Inbound normalization (pre-strict-validation)**
  - `brand_manifest` passed to `create_media_buy` is now converted to `brand` (BrandReference) and stripped before Zod strict validation fires, matching the existing `get_products` pattern. Previously these requests failed with "Request validation failed: Unrecognized key: brand_manifest".
  - `update_media_buy` is no longer incorrectly included in the `brand_manifest` normalization block — neither the v2 nor v3 update schema has a `brand` field.

  **Outbound adaptation (v3 client → v2 server)**
  - `adaptCreateMediaBuyRequestForV2` now converts `brand: { domain }` → `brand_manifest: 'https://<domain>'` before sending to v2 servers. Previously `brand` passed through unchanged and v2 servers rejected it as an unrecognised field.
  - `adaptCreateMediaBuyRequestForV2` now preserves `brand` in the output when it cannot be converted (no `domain` present), consistent with `adaptGetProductsRequestForV2`.
  - `adaptCreateMediaBuyRequestForV2` now throws a clear error when `proposal_id` is present with no packages — proposal mode is v3-only and v2 servers require an explicit `packages` array.
  - `adaptGetProductsRequestForV2` now correctly strips the `account` field (was erroneously deleting `account_id`, a field that doesn't exist at the top level).
  - `adaptPackageRequestForV2` now strips `catalog` from package items — it is a v3-only field not present in the v2 package schema. Applies to both `create_media_buy` and `update_media_buy` packages.
  - Brand manifest URL format aligned: both `get_products` and `create_media_buy` now use the bare domain URL (`https://<domain>`) when converting `brand` → `brand_manifest` for v2 servers.

- 9863b82: Fix get_products failing with "Unexpected keyword argument: buying_mode" on partial v3 agents

  When calling `get_products`, the client infers and adds `buying_mode` to requests for backwards compatibility. For agents detected as v3 (have `get_adcp_capabilities`) but with an incomplete `get_products` implementation that doesn't declare `buying_mode` in its tool schema, this caused a pydantic validation error and the entire call to fail.

  The fix caches tool `inputSchema` data (already fetched via `listTools` during capability detection) and uses it in `adaptRequestForServerVersion` to strip `buying_mode` from `get_products` requests when the agent's schema doesn't declare the field. Fails open — if no schema is cached, the field is sent unchanged.

  This is targeted to `get_products` + `buying_mode` at the existing version-adaptation layer, rather than blanket schema filtering at the protocol layer.

## 4.0.0

### Major Changes

- 6bf2960: Sync upstream schema changes (breaking):
  - `OptimizationGoal` redesigned as discriminated union with `metric` (seller-tracked delivery metrics: clicks, views, etc.) and `event` (advertiser-tracked conversions with multiple event sources) kinds; both support `target` and `priority`
  - `Package.optimization_goal` renamed to `optimization_goals` (array)
  - `Product.conversion_tracking.supported_optimization_strategies` renamed to `supported_targets` with updated values: `target_cost_per|target_threshold_rate|target_per_ad_spend` → `cost_per|per_ad_spend|maximize_value`
  - `account_id?: string` replaced by `account: AccountReference` (required) on `CreateMediaBuyRequest`, `GetMediaBuysRequest`, `SyncCreativesRequest`, `SyncEventSourcesRequest`, `SyncAudiencesRequest`, `SyncCatalogsRequest`, and `GetAccountFinancialsRequest`; `AccountReference` is a `oneOf` supporting `{ account_id }` or `{ brand, operator }` natural key. `GetProductsRequest` gains an optional `account?: AccountReference` field.
  - `Account.house` and `Account.brand_id` removed; replaced by `Account.brand?: BrandReference`
  - `billing` enum: `'brand'` value removed
  - `MediaBuy.campaign_ref` renamed to `buyer_campaign_ref`
  - `Signal.pricing` replaced by `Signal.pricing_options: PricingOption[]`
  - `LogEventRequest` usage records: `operator_id` field removed; `pricing_option_id` field added for billing verification; `kind` field removed
  - `PostalCodeSystem`: added `ch_plz` (Swiss) and `at_plz` (Austrian) postal code systems

  New additions:
  - `OptimizationGoal` metric kind: added `engagements`, `follows`, `saves`, `profile_visits` metrics and optional `view_duration_seconds` for `completed_views` threshold
  - `OptimizationGoal` event kind: added `maximize_value` target kind
  - `Product.metric_optimization` capability object (`supported_metrics`, `supported_view_durations`, `supported_targets`)
  - `Product.max_optimization_goals` field
  - `DeliveryMetrics`: added `engagements`, `follows`, `saves`, `profile_visits` fields
  - `GetAdCPCapabilitiesResponse.conversion_tracking.multi_source_event_dedup` capability flag
  - `get_account_financials` tool with request/response types
  - `BrandID`, `BrandReference`, `AccountReference` types

### Minor Changes

- 9628b8e: Expose account management capabilities from get_adcp_capabilities response

  The `AdcpCapabilities` type now includes an `account` field (type `AccountCapabilities`) populated when the seller declares account management settings in their capabilities response. Fields include:
  - `requireOperatorAuth` — whether per-operator authentication is required
  - `authorizationEndpoint` — OAuth endpoint for operator auth
  - `supportedBilling` — billing models the seller supports
  - `defaultBilling` — default billing when omitted from sync_accounts
  - `requiredForProducts` — whether an account is required before calling get_products

## 3.25.1

### Patch Changes

- fca1a4b: Fix v2 brand_manifest URL: use base domain instead of /.well-known/brand.json path, which may not exist on advertiser domains and caused "brand_manifest must provide brand information" errors from v2 servers like Magnite.

## 3.25.0

### Minor Changes

- 9cb2cf5: feat: adapt get_products requests for v2 servers
  - Add `adaptGetProductsRequestForV2` to convert v3 request fields to v2 equivalents:
    - `brand` (BrandReference) → `brand_manifest` (string URL)
    - `catalog` → `promoted_offerings` (type='offering') or `promoted_offerings.product_selectors` (type='product')
    - v3 channel names mapped to v2 equivalents (olv/ctv → video, streaming_audio → audio, retail_media → retail)
    - Strip v3-only fields: `buying_mode`, `buyer_campaign_ref`, `property_list`, `account_id`, `pagination`
    - Strip v3-only filter fields: `required_features`, `required_axe_integrations`, `required_geo_targeting`, `signal_targeting`, `regions`, `metros`
  - Add `normalizeProductChannels` to expand v2 channel names to v3 on response products (video → [olv, ctv], audio → streaming_audio, native → display, retail → retail_media)
  - Wire `get_products` into `adaptRequestForServerVersion` switch in `SingleAgentClient`
  - Normalize `brand_manifest` and `product_selectors` in `normalizeRequestParams` before Zod validation for backwards compatibility
  - Strip v3-only package fields (`optimization_goal`) and top-level fields (`account_id`, `proposal_id`, `total_budget`, `artifact_webhook`, `reporting_webhook`) when adapting `create_media_buy`/`update_media_buy` for v2 servers

## 3.24.0

### Minor Changes

- 081dc21: Add `findCompany()` to RegistryClient for resolving colloquial brand names to canonical forms via `GET /api/brands/find`
- b3a03f8: Infer buying_mode from brief presence on get_products for backwards compatibility

## 3.23.0

### Minor Changes

- 7143b35: Add `headers` field to `AgentConfig` for per-agent custom HTTP headers

  Enables sending additional HTTP headers (API keys, org IDs, etc.) alongside the standard bearer token on every request to a specific agent. Auth headers always take precedence over custom headers.

## 3.22.0

### Minor Changes

- 3842fcd: Wrap new AdCP capabilities: buying_mode on GetProductsRequest, CatalogFieldMapping, CatalogFieldBinding, Overlay types. Add checkPropertyList and getPropertyCheckReport to RegistryClient. Registry OpenAPI spec now synced automatically via sync-schemas.

## 3.21.0

### Minor Changes

- 6128d21: Sync AdCP schemas and implement get_media_buys tool
  - Add `get_media_buys` request validation via `GetMediaBuysRequestSchema`
  - Add `GetMediaBuysRequest` / `GetMediaBuysResponse` types and Zod schemas (generated)
  - Add `getMediaBuys()` method to `Agent` and `AgentCollection`
  - Add `get_creative_features` types and agent methods
  - Rename `campaign_ref` to `buyer_campaign_ref` across create/update media buy
  - Add `max_bid` boolean to CPM/VCPM/CPC/CPCV/CPV pricing options

## 3.20.0

### Minor Changes

- 55e6294: Add test suite orchestrator to `@adcp/client/testing`

  New exports:
  - `testAllScenarios(agentUrl, options)` — discovers agent capabilities and runs all applicable scenarios, returning a `SuiteResult`
  - `getApplicableScenarios(tools, filter?)` — returns which scenarios are applicable for a given tool list
  - `SCENARIO_REQUIREMENTS` — maps each scenario to its required tools
  - `DEFAULT_SCENARIOS` — the canonical set of scenarios the orchestrator runs
  - `formatSuiteResults(suite)` — markdown formatter for suite results
  - `formatSuiteResultsJSON(suite)` — JSON formatter for suite results
  - `SuiteResult` type — aggregated result across all scenarios
  - `OrchestratorOptions` type — `TestOptions` extended with optional `scenarios` filter

## 3.19.0

### Minor Changes

- 4718fa0: Sync AdCP catalog schemas: add `sync_catalogs` task, `Catalog` core type, and new catalog-related enums (`CatalogType`, `CatalogAction`, `CatalogItemStatus`). The `GetProductsRequest` now accepts a `catalog` field for product selection. Deprecated `PromotedProducts` and `PromotedOfferings` types are retained in the backwards-compatibility layer with a `promotedProductsToCatalog()` migration helper.

## 3.18.0

### Minor Changes

- c8eef79: Sync upstream AdCP schema: sandbox mode support and creative format filters
  - Added `sandbox?: boolean` to `Account`, `MediaBuyFeatures`, and all task response types (`GetProductsResponse`, `CreateMediaBuySuccess`, `UpdateMediaBuySuccess`, `SyncCreativesSuccess`, `ListCreativesResponse`, `ListCreativeFormatsResponse`, `GetMediaBuyDeliveryResponse`, `ProvidePerformanceFeedbackSuccess`, `SyncEventSourcesSuccess`, `LogEventSuccess`, `SyncAudiencesSuccess`, `BuildCreativeSuccess`, `ActivateSignalSuccess`, `GetSignalsResponse`)
  - Added `sandbox?: boolean` filter to `ListAccountsRequest` and `SyncAccountsRequest`
  - Added `output_format_ids` and `input_format_ids` filter fields to `ListCreativeFormatsRequest`
  - Added `input_format_ids` to `Format`

## 3.17.0

### Minor Changes

- 4292c77: Add sync_audiences tool support and BrandReference migration
  - Added `testSyncAudiences()` scenario for testing first-party CRM audience management
  - Added `audienceManagement` feature detection in capabilities
  - Added `sync_audiences` to supported tool list
  - Migrated from `BrandManifest` to `BrandReference` (upstream schema change)
  - Backwards-compatible: `BrandManifest`, `BrandManifestReference`, and `brandManifestToBrandReference()` re-exported from `compat.ts` with deprecation notice
  - Updated `TestOptions` to accept `brand?: { domain: string; brand_id?: string }` and `audience_account_id?: string`

## 3.16.0

### Minor Changes

- 03d47c6: Add full AdCP Registry client with 28 SDK methods and 17 CLI commands

  Generates TypeScript types from the registry OpenAPI spec using openapi-typescript. Expands RegistryClient with methods for brand/property listing, agent discovery, authorization validation, search, and adagents tooling. Adds corresponding CLI commands including list-brands, list-properties, search, agents, publishers, stats, validate, lookup, discover, and check-auth.

### Patch Changes

- 253c86b: Fix: retry StreamableHTTP on session errors instead of falling back to SSE. When a server returns 404 "Session not found", the client now retries with a fresh StreamableHTTP connection rather than incorrectly falling back to SSE transport.

## 3.15.0

### Minor Changes

- 1fb8afc: Sync upstream AdCP schema changes: add CreativeBrief type to BuildCreativeRequest, replace estimated_exposures with forecast on Product, remove proposal_id from GetProductsRequest. Track ADCP_VERSION 'latest' for schema sync.

## 3.14.1

### Patch Changes

- 45b1229: Upgrade @fastify/cors and @fastify/static for Fastify 5 compatibility, fixing production server crash loop
- d22c3b2: Fix OAuth discovery to use RFC 8414 path-aware resolution, trying `{origin}/.well-known/oauth-authorization-server{path}` before falling back to root

## 3.14.0

### Minor Changes

- 094a10b: Add brand and property registry lookup methods via RegistryClient

## 3.13.0

### Minor Changes

- cc02dc8: Sync AdCP schema to 3.0.0-beta.3 with daypart targeting, delivery forecasting, demographic systems, and optional account_id

## 3.12.0

### Minor Changes

- 0d89757: Update to latest AdCP schema with new features:

  **Breaking type changes:**
  - **BrandManifest tone**: Changed from `string` to object with `voice`, `attributes`, `dos`, `donts`
  - **Format.type**: Now optional (`FormatCategory` deprecated in favor of assets array)

  **Targeting & Signals:**
  - **TargetingOverlay**: Added `age_restriction`, `device_platform`, and `language` fields
  - **BrandManifest logos**: Added structured fields (`orientation`, `background`, `variant`)
  - **Data Provider Signals**: New `DataProviderSignalSelector` and `SignalTargeting` types
  - **get_signals**: Now supports `signal_ids` for exact lookups in addition to `signal_spec`

  **Conversion Tracking:**
  - New `EventType` and `ActionSource` enums
  - `Package.optimization_goal` for target ROAS/CPA with attribution windows
  - `Product.conversion_tracking` for conversion-optimized delivery
  - New `sync_event_sources` and `log_event` tools (with Agent class methods)
  - Delivery metrics: `conversion_value`, `roas`, `cost_per_acquisition`, event type breakdowns

  **Creative:**
  - `UniversalMacro` typed enum for creative tracking macro placeholders
  - `BaseIndividualAsset` / `BaseGroupAsset` extracted as named interfaces

  **Pagination:**
  - Standardized `PaginationRequest` / `PaginationResponse` types across all list endpoints
  - New `paginate()` utility to auto-collect all items across pages
  - New `paginatePages()` async generator for progressive page-by-page loading
  - Deprecated legacy `PaginationOptions` (offset/limit pattern)

  **Product Discovery & Pricing:**
  - `PromotedProducts` interface for product selector queries
  - `CPAPricingOption` for cost-per-acquisition pricing model
  - `isCPAPricing()` helper to detect CPA pricing options
  - Geo exclusion fields (`geo_countries_exclude`, `geo_regions_exclude`, etc.)

  **Capabilities:**
  - `EVENT_TRACKING_TOOLS` constant for conversion tracking tool detection
  - `conversionTracking` feature flag in `MediaBuyFeatures`
  - Added `age_restriction`, `device_platform`, `language` feature flags

  **Exports:**
  - All new types exported from main barrel: `PromotedProducts`, `CPAPricingOption`, `EventType`, `ActionSource`, `SyncEventSourcesRequest/Response`, `LogEventRequest/Response`
  - `isCPAPricing` utility exported alongside existing pricing helpers

## 3.11.2

### Patch Changes

- bbdb92a: Add OAuth support to CLI test command
  - Add `--oauth` flag to test command for OAuth-protected MCP agents
  - Send both `Authorization: Bearer` and `x-adcp-auth` headers in MCP requests (standard OAuth header + legacy AdCP for backwards compatibility)
  - Add token expiry check before running tests with saved OAuth tokens

## 3.11.1

### Patch Changes

- 6ec7e3e: Extract shared `is401Error` helper for centralized 401 authentication error detection

## 3.11.0

### Minor Changes

- cdcf3a7: Add `@adcp/client/auth` export path for OAuth and authentication utilities

## 3.10.0

### Minor Changes

- d7f6ce7: Add OAuth discovery utilities for checking if MCP servers support OAuth authentication.

  New exports:
  - `discoverOAuthMetadata(agentUrl)` - Fetches OAuth Authorization Server Metadata from `/.well-known/oauth-authorization-server`
  - `supportsOAuth(agentUrl)` - Simple boolean check if server supports OAuth
  - `supportsDynamicRegistration(agentUrl)` - Check if server supports dynamic client registration
  - `OAuthMetadata` type - RFC 8414 Authorization Server Metadata structure
  - `DiscoveryOptions` type - Options for discovery requests (timeout, custom fetch)

### Patch Changes

- d7f6ce7: Export Account domain types from main entry point
  - `Account` - billing account interface
  - `ListAccountsRequest` - request params for listing accounts
  - `ListAccountsResponse` - response payload with accounts array

  The types existed in tools.generated.ts but weren't explicitly exported from @adcp/client.

## 3.9.0

### Minor Changes

- 1e919b7: ### Breaking Changes

  **TaskExecutor behavior changes for async statuses:**
  - **`working` status**: Now returns immediately as a successful result (`success: true`, `status: 'working'`) instead of polling until completion or timeout. Callers should use the returned `taskId` to poll for completion or set up webhooks.
  - **`input-required` status**: Now returns as a successful paused state (`success: true`, `status: 'input-required'`) instead of throwing `InputRequiredError` when no handler is provided. Access the input request via `result.metadata.inputRequest`.

  **Migration:**

  ```typescript
  // Before: catching InputRequiredError
  try {
    const result = await executor.executeTask(agent, task, params);
  } catch (error) {
    if (error instanceof InputRequiredError) {
      // Handle input request
    }
  }

  // After: checking result status
  const result = await executor.executeTask(agent, task, params);
  if (result.status === 'input-required') {
    const { question, field } = result.metadata.inputRequest;
    // Handle input request
  }
  ```

  **Conversation context changes:**
  - `wasFieldDiscussed(field)`: Now returns `true` only if the agent explicitly requested that field via an `input-required` response (previously checked if any message contained the field).
  - `getPreviousResponse(field)`: Now returns the user's response to a specific field request (previously returned any message content containing the field).

  ### New Features
  - Added v3 protocol testing scenarios:
    - `capability_discovery` - Test `get_adcp_capabilities` and verify v3 protocol support
    - `governance_property_lists` - Test property list CRUD operations
    - `governance_content_standards` - Test content standards listing and calibration
    - `si_session_lifecycle` - Test full SI session: initiate → messages → terminate
    - `si_availability` - Quick check for SI offering availability
  - Exported `ProtocolClient` and related functions from main library for testing purposes

- 38ba6a6: Add OAuth support for MCP servers
  - New OAuth module in `src/lib/auth/oauth/` with pluggable flow handlers
  - `MCPOAuthProvider` implements MCP SDK's `OAuthClientProvider` interface
  - `CLIFlowHandler` for browser-based OAuth with local callback server
  - OAuth tokens stored directly in AgentConfig alongside static auth tokens
  - CLI flags: `--oauth` for OAuth auth, `--clear-oauth` to clear tokens
  - `--save-auth <alias> <url> --oauth` to save agents with OAuth
  - Auto-detection of OAuth requirement when MCP servers return UnauthorizedError
  - Helper functions: `hasValidOAuthTokens`, `clearOAuthTokens`, `getEffectiveAuthToken`
  - Security fix: use spawn instead of exec for browser open to prevent command injection

## 3.8.1

### Patch Changes

- 7365296: Fix schema validation for v2 pricing options in get_products responses

  When servers return v2-style pricing options (rate, is_fixed, price_guidance.floor), schema validation now normalizes them to v3 format (fixed_price, floor_price) before validation. This ensures v2 server responses pass validation against v3 schemas.

## 3.8.0

### Minor Changes

- d3869a1: Add ADCP v3.0 compatibility while preserving v2.5/v2.6 backward compatibility

  **New Features:**
  - Capability detection via `get_adcp_capabilities` tool or synthetic detection from tool list
  - v3 request/response adaptation for pricing fields (fixed_price, floor_price)
  - Authoritative location redirect handling with loop detection and HTTPS validation
  - Server-side adapter interfaces (ContentStandardsAdapter, PropertyListAdapter, ProposalManager, SISessionManager)
  - New domains: governance, sponsored-intelligence, protocol

  **Adapters:**
  - Pricing adapter: normalizes v2 (rate, is_fixed) to v3 (fixed_price, floor_price)
  - Creative adapter: handles v2/v3 creative assignment field differences
  - Format renders adapter: normalizes format render structures
  - Preview normalizer: handles v2/v3 preview response differences

  **Breaking Change Handling:**
  - All v2 responses automatically normalized to v3 API
  - Clients always see v3 field names regardless of server version
  - v2 servers receive adapted requests with v2 field names

### Patch Changes

- d3869a1: Fix multi-agent partial failure handling using Promise.allSettled

## 3.7.1

### Patch Changes

- 3a60592: Fix JavaScript syntax error in testing UI and update hono for security
  - **UI Fix**: Resolved syntax error in `index.html` dimension parsing logic that caused `toggleAddAgent` and other functions to be undefined. The invalid `} else { } else if {` structure was corrected to proper nested conditionals.
  - **Security**: Updated `hono` from 4.11.3 to 4.11.4 to fix high-severity JWT algorithm confusion vulnerabilities (GHSA-3vhc-576x-3qv4, GHSA-f67f-6cw9-8mq4).

## 3.7.0

### Minor Changes

- 302089a: Add AdCP v2.6 support with backward compatibility for Format schema changes
  - New `assets` field in Format schema (replaces deprecated `assets_required`)
  - Added format-assets utilities: `getFormatAssets()`, `getRequiredAssets()`, `getOptionalAssets()`, etc.
  - Updated testing framework to use new utilities
  - Added URL input option for image/video assets in testing UI
  - Added 21 unit tests for format-assets utilities

## 3.6.0

### Minor Changes

- 2749985: Add `test` subcommand to CLI for running agent test scenarios

  New CLI command enables testing AdCP agents directly from the command line:

  ```bash
  # List available test scenarios
  npx @adcp/client test --list-scenarios

  # Run discovery tests against the built-in test agent
  npx @adcp/client test test

  # Run a specific scenario
  npx @adcp/client test test full_sales_flow

  # Test your own agent
  npx @adcp/client test https://my-agent.com discovery --auth $TOKEN

  # JSON output for CI pipelines
  npx @adcp/client test test discovery --json
  ```

  Available scenarios include: health_check, discovery, create_media_buy, full_sales_flow,
  error_handling, validation, pricing_edge_cases, and more.

  The command exits with code 0 on success, 3 on test failure, making it suitable for CI pipelines.

## 3.5.2

### Patch Changes

- fb041b6: Fix validation error when agents return empty publisher_domains array

  The JSON Schema defines `minItems: 1` for publisher_domains, which caused validation to fail when agents returned empty arrays. This is a common scenario when an agent isn't authorized for any publishers yet.

  The fix relaxes the generated TypeScript types and Zod schemas to accept empty arrays by:
  - Removing `minItems` constraints during TypeScript type generation
  - Converting tuple patterns (`z.tuple([]).rest()`) to arrays (`z.array()`) in Zod schema generation

  This change improves interoperability with real-world agents that may return empty arrays for optional array fields.

## 3.5.1

### Patch Changes

- 15244b1: fix(testing): Use publisher_domains instead of legacy authorized_properties in discovery tests

## 3.5.0

### Minor Changes

- 6d5d050: Add comprehensive E2E agent testing framework with support for discovery, media buy creation, creative sync, and behavioral analysis scenarios.
- 9b34827: Simplify authentication configuration by removing `requiresAuth` and `auth_token_env` fields.

  **Breaking Changes:**
  - `AgentConfig.requiresAuth` has been removed - if `auth_token` is provided, it will be used
  - `AgentConfig.auth_token_env` has been removed - use `auth_token` directly with the token value

  **Migration:**

  ```typescript
  // Before
  const config = {
    id: 'my-agent',
    agent_uri: 'https://agent.example.com',
    protocol: 'mcp',
    requiresAuth: true,
    auth_token_env: 'MY_TOKEN_ENV_VAR', // or auth_token: 'direct-token'
  };

  // After
  const config = {
    id: 'my-agent',
    agent_uri: 'https://agent.example.com',
    protocol: 'mcp',
    auth_token: process.env.MY_TOKEN_ENV_VAR, // or 'direct-token'
  };
  ```

  The simplified model: if `auth_token` is provided, it's sent with requests. If not provided, no authentication is sent.

### Patch Changes

- e602659: Regenerate TypeScript types to match AdCP v2.5.1 schemas

## 3.4.0

### Minor Changes

- 0494341: Updates webhook handler to better support mcp and a2a payloads. Adds typed payloads; Makes reporting webhook configurable;

### Patch Changes

- a639f2c: Fix skipping .data generation when status is submitted
- b1ad29d: feat: URL canonicalization and agent comparison

  **Auto-detect A2A protocol for .well-known/agent-card.json URLs**

  When users provide a `.well-known/agent-card.json` URL (e.g., `https://example.com/.well-known/agent-card.json`), the library now correctly detects this as an A2A agent card discovery URL and switches to the A2A protocol.

  **Canonical URL resolution**

  Added methods to resolve and compare agents by their canonical base URL:
  - `getCanonicalUrl()` - Synchronously returns the canonical base URL (computed from configured URL)
  - `resolveCanonicalUrl()` - Async method that fetches the agent card (A2A) or discovers endpoint (MCP) to get the authoritative canonical URL
  - `isSameAgent(other)` - Compare two agents by canonical URL
  - `isSameAgentResolved(other)` - Async comparison that resolves canonical URLs first
  - `getResolvedAgent()` - Get agent config with canonical URL resolved

  Canonical URL computation:
  - For A2A: Uses the `url` field from the agent card, or strips `/.well-known/agent-card.json`
  - For MCP: Strips `/mcp` or `/mcp/` suffix from discovered endpoint

  This enables comparing agents regardless of how they were configured:

  ```typescript
  // These all resolve to the same canonical URL: https://example.com
  agent1.agent_uri = 'https://example.com';
  agent2.agent_uri = 'https://example.com/mcp';
  agent3.agent_uri = 'https://example.com/.well-known/agent-card.json';

  client.agent('agent1').isSameAgent(client.agent('agent2')); // true
  ```

  Fixes #175

## 3.3.3

### Patch Changes

- fbc29ae: Fix CLI --auth flag to use literal token values directly

  The CLI was incorrectly setting `auth_token_env` (environment variable name) instead of `auth_token` (direct value) when the user provided `--auth TOKEN`. This caused authentication to fail with "Environment variable not found" warnings because the auth module tried to look up the literal token as an environment variable name.

- 53d7cec: Remove spurious index signature types from generated validation schemas

  The `json-schema-to-typescript` library was incorrectly generating index signature types (e.g., `{ [k: string]: unknown }`) for schemas with `oneOf` and `additionalProperties: false`. This caused validation to allow arbitrary extra fields on requests like `update_media_buy` and `provide_performance_feedback`.

  Changes:
  - Added `removeIndexSignatureTypes()` function to post-process generated types
  - Added `update_media_buy` and `list_creatives` schemas to the validation map
  - Added tests for request validation with extra fields

## 3.3.2

### Patch Changes

- 27693b2: Fixed CLI bug where agentConfig was not wrapped in array for AdCPClient constructor

## 3.3.1

### Patch Changes

- ec50aae: Fix Zod schema validation to accept null values for all optional fields. Updated the schema generator to apply `.nullish()` globally to all optional schema fields, allowing both `null` and `undefined` values where TypeScript types permit.

## 3.3.0

### Minor Changes

- a322f4c: fix: treat working/input-required as valid intermediate states and extract A2A webhook payloads
  - `working` status now returns immediately with `status: 'working'` instead of polling and timing out
  - `input-required` status returns valid result instead of throwing `InputRequiredError` when no handler provided
  - Made `success=true` consistent for all intermediate states (working, submitted, input-required, deferred)
  - Added `taskType` parameter to `handleWebhook` for all client classes (SingleAgentClient, AgentClient, ADCPMultiAgentClient)
  - `handleWebhook` now extracts ADCP response from raw A2A task payloads (artifacts[0].parts[].data where kind === 'data')
  - Handlers now receive unwrapped ADCP responses instead of raw A2A protocol structure

## 3.2.1

### Patch Changes

- 918a91a: Fixed ProtocolResponseParser to correctly detect input-required status in A2A JSON-RPC wrapped responses. The parser now checks response.result.status.state for A2A responses before falling back to other status locations, preventing "Schema validation failed" errors when agents return input-required status.

## 3.2.0

### Minor Changes

- 8b05170: Clean up SDK public API and improve response handling

  IMPROVEMENTS:
  1. Agent class methods now return raw AdCP responses matching schemas exactly
  2. Removed internal implementation details from public API exports
  3. Added response utilities: unwrapProtocolResponse, isAdcpError, isAdcpSuccess

  ## What Changed

  **Low-level Agent class** now returns raw AdCP responses matching the protocol specification:
  - Success responses have required fields per schema (packages, media_buy_id, buyer_ref)
  - Error responses follow discriminated union: `{ errors: [{ code, message }] }`
  - Errors returned as values, not thrown as exceptions

  **High-level clients unchanged** - ADCPMultiAgentClient, AgentClient, and SingleAgentClient still return `TaskResult<T>` with status-based patterns. No migration needed for standard usage.

  ## API Export Cleanup

  Removed internal utilities that were never meant for public use:
  - Low-level protocol clients (ProtocolClient, callA2ATool, callMCPTool)
  - Internal utilities (CircuitBreaker, getCircuitBreaker, generateUUID)
  - Duplicate exports (NewAgentCollection)

  Public API now includes only user-facing features:
  - All Zod schemas (for runtime validation, forms)
  - Auth utilities (getAuthToken, createAdCPHeaders, etc.)
  - Validation utilities (validateAgentUrl, validateAdCPResponse)
  - Response utilities (unwrapProtocolResponse, isAdcpError, isAdcpSuccess)

  ## Migration Guide (Only if using low-level Agent class directly)

  **Most users don't need to migrate** - if you're using ADCPMultiAgentClient, AgentClient, or SingleAgentClient, no changes needed.

  ### If using Agent class directly:

  ```javascript
  // Before:
  const agent = new Agent(config, client);
  const result = await agent.createMediaBuy({...});
  if (result.success) {
    console.log(result.data.media_buy_id);
  }

  // After:
  const agent = new Agent(config, client);
  const result = await agent.createMediaBuy({...});
  if (result.errors) {
    console.error('Failed:', result.errors);
  } else {
    console.log(result.media_buy_id, result.buyer_ref);
  }
  ```

  ### Removed Internal Exports

  If you were importing `ProtocolClient`, `CircuitBreaker`, or other internal utilities, use the public Agent class instead.

### Patch Changes

- b2b7c8b: Fixed A2A webhook configuration placement to match A2A SDK specification.

  **Bug Fix: A2A Webhook Configuration Placement**

  The A2A protocol requires webhook configuration to be placed in the top-level `configuration` object, not in skill parameters.

  **Correct format per A2A SDK:**

  ```javascript
  {
    message: { messageId, role, kind, parts: [...] },
    configuration: {
      pushNotificationConfig: { url, headers }
    }
  }
  ```

  **Previous incorrect format:**

  ```javascript
  {
    message: {
      parts: [
        {
          data: {
            skill: 'toolName',
            parameters: {
              pushNotificationConfig: { url, headers }, // WRONG - not a skill parameter
            },
          },
        },
      ];
    }
  }
  ```

  **Changes:**
  - Moved `pushNotificationConfig` from skill parameters to `params.configuration` in A2A protocol handler
  - MCP protocol correctly continues to use `push_notification_config` in tool arguments (per MCP spec)
  - Uses generated `PushNotificationConfig` type from AdCP schema for type safety
  - Fixed A2A artifact validation to check `artifactId` field per @a2a-js/sdk Artifact interface

  **Documentation:**
  - Added AGENTS.md section clarifying `push_notification_config` (async task status) vs `reporting_webhook` (reporting metrics)
  - Both use PushNotificationConfig schema but have different purposes and placement requirements

- 8b05170: Fix CLI tool missing dependency file in published package. The adcp command now works correctly when installed via npx.

## 3.1.0

### Minor Changes

- discriminated-unions-fix: Add discriminated union support and fix missing AdCP tools. Re-synced AdCP schemas to include all 13 tools (was only generating 4). Added support for discriminated unions in type definitions.
- slow-kings-boil: Fixed critical validation bug where sync_creatives, create_media_buy, build_creative, and get_products requests were not being validated. Request validation now uses strict mode to reject unknown top-level fields.

### Patch Changes

- 1763342270: Added explicit auth_token field and fixed auth_token_env to properly support environment variable lookup. AgentConfig now supports two authentication methods: auth_token (direct value) and auth_token_env (environment variable name).
- d064ad36: Fixed A2A protocol to use 'parameters' field instead of 'input' per AdCP specification.
- make-reporting-webhook-configurable: Make reporting_webhook configurable.

## 3.0.3

### Patch Changes

- a4cc9da: Fix CLI tool missing dependency file in published package. The adcp command now works correctly when installed via npx.

## 3.0.2

### Patch Changes

- 579849e: add support for application level context management

## 3.0.1

### Patch Changes

- c24cd21: Fix CLI tool missing dependency file in published package. The adcp command now works correctly when installed via npx.
- c24cd21: Fixed MCP and A2A protocol authentication issues. MCP endpoints now receive required Accept headers, and CLI properly sets requiresAuth flag for authenticated agents.

## 3.0.0

### Major Changes

- 5c1d32e: Simplified API surface - removed deprecated exports and renamed primary client to `AdCPClient`.

  ## Breaking Changes

  **Removed:**
  - `AdCPClient` (deprecated wrapper with confusing lowercase 'd')
  - `createAdCPClient()`, `createAdCPClientFromEnv()` factory functions
  - `createADCPClient()`, `createADCPMultiAgentClient()` factory functions
  - `SingleAgentClient` and `AgentClient` exports from `/advanced` (use `client.agent(id)` instead)

  **Moved to `/advanced`:**
  - Protocol-level clients: `ProtocolClient`, `callMCPTool`, `callA2ATool`, `createMCPClient`, `createA2AClient`

  **Renamed:**
  - `ADCPMultiAgentClient` → `AdCPClient` (primary export, proper AdCP capitalization)

  ## New API

  ```typescript
  import { AdCPClient } from '@adcp/client';

  const client = new AdCPClient([agentConfig]);
  const client = AdCPClient.fromEnv();
  ```

  Works for single or multiple agents. See `MIGRATION-v3.md` for migration guide.

### Minor Changes

- bd57dd1: Added test helpers for easy testing and self-documenting examples. New exports include `testAgent` (pre-configured MCP test agent), `testAgentA2A` (pre-configured A2A test agent), `testAgentNoAuth` / `testAgentNoAuthA2A` (unauthenticated variants for demonstrating auth requirements), `testAgentClient` (multi-agent client with both protocols), `createTestAgent()` helper function, and `creativeAgent` (pre-configured MCP creative agent). Test helpers are available via `@adcp/client/testing` subpath export and provide instant access to AdCP's public test agent and official creative agent with no configuration required.

  Also added built-in CLI aliases (`test`, `test-a2a`, `test-no-auth`, `test-a2a-no-auth`, `creative`) for zero-config command-line access to test and creative agents.

### Patch Changes

- bd57dd1: Fixed authentication bug where tokens shorter than 20 characters were incorrectly treated as environment variable names. The `auth_token_env` field now always contains the actual token value. For environment variable expansion, use shell substitution (e.g., `--auth $MY_TOKEN`).

## 2.7.2

### Patch Changes

- 523e490: Fix CLI tool missing dependency file in published package. The adcp command now works correctly when installed via npx.
- a73d530: Fix MCP authentication bug where x-adcp-auth header was not being sent to servers. The client now properly includes authentication headers in all MCP requests using the SDK's requestInit.headers option instead of a custom fetch function. This fixes authentication failures with MCP servers that require the x-adcp-auth header.
- 35eab77: Fixed ADCP schema validation for framework-wrapped responses. When agent frameworks like ADK wrap tool responses in the A2A FunctionResponse format `{ id, name, response: {...} }`, the client now correctly extracts the nested data before validation instead of validating the wrapper object. This fixes "formats: Required" validation errors when calling ADK-based agents.
- bae7d59: Added EditorConfig and Prettier configuration files to enforce consistent code style across editors. Updated git hooks to support longer commit messages and improved commit-msg hook to work across different Node.js environments. Fixed localStorage issue in demo agent site that was erasing custom agents on page load.

## 2.7.1

### Patch Changes

- ea72f62: call onActivity function within all tool request/response

## 2.6.1

### Patch Changes

- 1027d34: Fix CLI tool missing dependency file in published package. The adcp command now works correctly when installed via npx.

## 2.5.7

### Patch Changes

- 48add90: PropertyCrawler: Add browser headers and graceful degradation for missing properties array

  **Fixes:**
  1. **Browser-Like Headers**: PropertyCrawler now sends standard browser headers when fetching `.well-known/adagents.json` files:
     - User-Agent: Standard Chrome browser string (required by CDNs like Akamai)
     - Accept, Accept-Language, Accept-Encoding: Browser-standard values
     - From: Crawler identification per RFC 9110 (includes library version)

     This resolves 403 Forbidden errors from publishers with CDN bot protection (e.g., AccuWeather, Weather.com).

  2. **Graceful Degradation**: When a publisher has a valid `adagents.json` file with `authorized_agents` but no `properties` array, PropertyCrawler now:
     - Infers a default property based on the domain
     - Returns the property as discoverable
     - Includes a warning message to guide publishers to add explicit properties
     - Adds warnings array to `CrawlResult` interface

  This enables property discovery even when publishers have completed only partial AdCP setup, improving real-world compatibility.

  **Real-World Impact:**
  - AccuWeather: Now successfully crawled (was failing with 403)
  - Weather.com: Now returns inferred property (was returning nothing)
  - Result: Properties discoverable from partial implementations

  **Breaking Changes:** None - API remains backward compatible. The `CrawlResult.warnings` field is new but optional.

  Fixes #107

## 2.5.6

### Patch Changes

- 470151b: Fixed timeout handling tests to match TaskExecutor behavior. Tests now correctly expect error results instead of thrown exceptions when timeouts occur.
- 934e89f: Fixed Zod schema generation failures and made generation errors fatal. Previously, `ts-to-zod` was failing to generate 19 schemas (including `GetProductsRequestSchema` and `GetProductsResponseSchema`) due to cross-file dependency issues. Now all 82 schemas generate successfully and failures exit with error code 1 to catch issues early.
- 79423e3: Add configurable log levels to PropertyCrawler to reduce noise from expected failures. The PropertyCrawler now accepts a `logLevel` option ('error' | 'warn' | 'info' | 'debug' | 'silent') that controls logging verbosity. Expected failures (404s, HTML responses, missing .well-known/adagents.json files) are now logged at debug level instead of error/warn level, while unexpected failures remain at error level. This prevents log pollution when domains don't have adagents.json files, which is a common and expected scenario.

## 2.5.5

### Patch Changes

- d02ed3c: Fix MCP endpoint discovery Accept header handling and send both auth headers

  The `discoverMCPEndpoint()` and `getAgentInfo()` methods had issues with header handling:
  1. **Lost Accept headers**: Didn't preserve the MCP SDK's required `Accept: application/json, text/event-stream` header
  2. **Missing Authorization header**: Only sent `x-adcp-auth` but some servers expect both headers

  Changes:
  - Updated `discoverMCPEndpoint()` to use the same header-preserving pattern as `callMCPTool()`
  - Updated `getAgentInfo()` to properly handle Headers objects without losing SDK defaults
  - Both methods now correctly extract and merge headers from Headers objects, arrays, and plain objects
  - Now sends **both** `Authorization: Bearer <token>` and `x-adcp-auth: <token>` for maximum compatibility
  - Added TypeScript type annotations for Headers.forEach callbacks

  Impact:
  - MCP endpoint discovery now works correctly with FastMCP SSE servers
  - Authentication works with servers expecting either `Authorization` or `x-adcp-auth` headers
  - Accept headers are properly preserved (fixes "406 Not Acceptable" errors)

## 2.5.4

### Patch Changes

- 3061375: Fixed MCP Accept header handling for Headers objects

  The customFetch function in mcp.ts was incorrectly handling Headers objects by using object spread syntax (`{...init.headers}`), which returns an empty object for Headers instances. This caused the MCP SDK's required `Accept: application/json, text/event-stream` header to be lost.

  **Changes:**
  - Fixed Headers object extraction to use `forEach()` instead of object spread
  - Fixed plain object extraction to use `for...in` loop with `hasOwnProperty` check
  - Added comprehensive tests for Headers object handling and Accept header preservation

  **Bug Timeline:**
  - Bug introduced in v2.3.2 (commit 086be48)
  - Exposed between v2.5.0 and v2.5.1 when SDK started passing Headers objects
  - Fixed in this release

  **Impact:**
  - MCP protocol requests now correctly include the required Accept header
  - MCP servers will no longer reject requests due to missing Accept header

- 4a3e04a: Upgraded @modelcontextprotocol/sdk to 1.20.2

  Updated the MCP SDK dependency from 1.19.1 to 1.20.2 to get the latest bug fixes and improvements.

## 2.5.3

### Patch Changes

- 3061375: Fixed MCP Accept header handling for Headers objects

  The customFetch function in mcp.ts was incorrectly handling Headers objects by using object spread syntax (`{...init.headers}`), which returns an empty object for Headers instances. This caused the MCP SDK's required `Accept: application/json, text/event-stream` header to be lost.

  **Changes:**
  - Fixed Headers object extraction to use `forEach()` instead of object spread
  - Fixed plain object extraction to use `for...in` loop with `hasOwnProperty` check
  - Added comprehensive tests for Headers object handling and Accept header preservation

  **Bug Timeline:**
  - Bug introduced in v2.3.2 (commit 086be48)
  - Exposed between v2.5.0 and v2.5.1 when SDK started passing Headers objects
  - Fixed in this release

  **Impact:**
  - MCP protocol requests now correctly include the required Accept header
  - MCP servers will no longer reject requests due to missing Accept header

- 4a3e04a: Upgraded @modelcontextprotocol/sdk to 1.20.2

  Updated the MCP SDK dependency from 1.19.1 to 1.20.2 to get the latest bug fixes and improvements.

## 2.5.2

### Patch Changes

- cc82c4d: Fixed A2A protocol discovery endpoint and Accept headers
  - Changed discovery endpoint from incorrect `/.well-known/a2a-server` to correct `/.well-known/agent-card.json` per A2A spec
  - Updated Accept header from `application/json` to `application/json, */*` for better compatibility with various server implementations
  - Updated protocol detection test to correctly expect A2A detection for test-agent.adcontextprotocol.org

## 2.5.1

### Patch Changes

- 799dc4a: Optimize pre-push git hook for faster development workflow
  - Reduced pre-push hook execution time from 5+ minutes to ~2-5 seconds
  - Now only runs essential fast checks: TypeScript typecheck + library build
  - Removed slow operations: schema sync, full test suite
  - Full validation (tests, schemas) still runs in GitHub Actions CI
  - Makes git push much faster while catching TypeScript and build errors early

- b257d06: Improved debug logging and error messages for MCP protocol errors
  - CLI now displays debug logs, conversation history, and full metadata when --debug flag is used
  - MCP error responses (`isError: true`) now extract and display the actual error message from `content[].text`
  - Previously showed "Unknown error", now shows detailed error like "Error calling tool 'list_authorized_properties': name 'get_testing_context' is not defined"
  - Makes troubleshooting agent-side errors much easier for developers

- 24a5ed7: UI formatting and error logging improvements
  - Fixed media buy packages to include format_ids array (was causing Pydantic validation errors)
  - Added error-level logging for failed media buy operations (create, update, get_delivery)
  - Fixed format objects display in products table (was showing [object Object])
  - Added runtime schema validation infrastructure with Zod
  - Added request validation to AdCPClient (fail fast on invalid requests)
  - Added configurable validation modes (strict/non-strict) via environment variables
  - Preserved trailing slashes in MCP endpoint discovery
  - Improved error display in UI debug panel with proper formatting
  - Added structured logger utility to replace console statements
  - **BREAKING**: Aligned budget handling with AdCP spec - MediaBuy.budget (object) is now MediaBuy.total_budget (number)
  - **BREAKING**: Removed budget field from CreateMediaBuyRequest (calculated from packages per spec)

## 2.5.0

### Minor Changes

- 739ed7a: Add protocol auto-detection to CLI tool - users can now omit the protocol argument and the CLI will automatically detect whether an endpoint uses MCP or A2A via discovery and URL pattern heuristics
- 739ed7a: Add agent alias support to CLI tool - save agent configurations with short aliases for quick access. Users can now save agents with `--save-auth <alias> <url>` and call them with just `adcp <alias> <tool> <payload>`. Config stored in ~/.adcp/config.json with secure file permissions.

### Patch Changes

- 739ed7a: Fix pre-push hook to skip slow tests by setting CI=true, matching GitHub Actions behavior and preventing unnecessary test timeouts during git push
- 8f9270c: Fix webhook HMAC verification by propagating X-ADCP-Timestamp header through AgentClient.handleWebhook() and server route. Update update_media_buy tool signature to remove push_notification_config (matches create_media_buy). Add auto-injection of reporting_webhook in createMediaBuy when webhookUrlTemplate is configured.

# 2.4.2

- Update `update_media_buy` tool signature to match `create_media_buy` - remove `push_notification_config` from request
- Fix webhook HMAC verification by propagating `X-ADCP-Timestamp` through `AgentClient.handleWebhook` and server route

  Previously, the server only forwarded `X-ADCP-Signature` to the client verifier. The timestamp required by the HMAC scheme (message = `{timestamp}.{json_payload}`) was not passed through, causing verification to fail when `webhookSecret` was enabled. This change:
  - Updates `AgentClient.handleWebhook(payload, signature, timestamp)` to accept and forward the timestamp.
  - Updates the webhook route to extract `X-ADCP-Timestamp` and pass it into `handleWebhook`.
  - Allows `AdCPClient.handleWebhook` to successfully validate signatures using both headers.

## 2.4.1

### Patch Changes

- 9f18fa1: Fix CLI tool missing dependency file in published package. The adcp command now works correctly when installed via npx.

## 2.4.0

### Minor Changes

- 5030c85: Add CLI tool and MCP endpoint auto-discovery
  - Add command-line tool (`bin/adcp.js`) for testing AdCP agents
  - Add automatic MCP endpoint discovery (tests provided path, then tries adding /mcp)
  - Add `getAgentInfo()` method for discovering agent capabilities
  - CLI supports tool discovery, execution, authentication, and async webhook handling

## 2.3.2

### Patch Changes

- 3f8460b: Fix conditional fetch logic for auth headers to prevent sporadic authentication failures when making parallel requests

## 2.3.1

### Patch Changes

- 87bb6d2: Fix A2A Authorization header being overwritten by SDK headers. The custom fetchImpl now spreads SDK headers first, then applies auth headers to ensure they take precedence.
- a8cbaf7: Fix creative sync validation errors by correcting format field name and structure

  Multiple locations in the codebase were incorrectly using `format` instead of `format_id` when creating creative assets for sync_creatives calls. This caused the AdCP agent to reject creatives with validation errors: "Input should be a valid dictionary or instance of FormatId".

  **Fixed locations:**
  - `src/public/index.html:8611` - Creative upload form
  - `src/public/index.html:5137` - Sample creative generation
  - `scripts/manual-testing/full-wonderstruck-test.ts:284` - Test script (also fixed to use proper FormatID object structure)

  All creatives are now properly formatted according to the AdCP specification with the correct `format_id` field containing a FormatID object with `agent_url` and `id` properties.

## 2.3.0

### Minor Changes

- 329ce6e: Add Zod schema exports for runtime validation with automatic generation

  This release adds Zod schema exports alongside existing TypeScript types, enabling runtime validation of AdCP data structures. All core schemas, request schemas, and response schemas are now available as Zod schemas.

  **New exports:**
  - Core schemas: `MediaBuySchema`, `ProductSchema`, `CreativeAssetSchema`, `TargetingSchema`
  - Request schemas: `GetProductsRequestSchema`, `CreateMediaBuyRequestSchema`, `SyncCreativesRequestSchema`, etc.
  - Response schemas: `GetProductsResponseSchema`, `CreateMediaBuyResponseSchema`, `SyncCreativesResponseSchema`, etc.

  **Features:**
  - Runtime validation with detailed error messages
  - Type inference from schemas
  - Integration with React Hook Form, Formik, etc.
  - OpenAPI generation support via zod-to-openapi
  - **Automatic generation**: Zod schemas now generated automatically when running `npm run generate-types`
  - **CI integration**: Pre-push hooks and CI checks ensure schemas stay in sync

  **Automatic workflow:**

  ```bash
  # Sync latest AdCP schemas and generate all types (TypeScript + Zod)
  npm run sync-schemas && npm run generate-types
  ```

  **Usage:**

  ```typescript
  import { MediaBuySchema } from '@adcp/client';

  const result = MediaBuySchema.safeParse(data);
  if (result.success) {
    console.log('Valid!', result.data);
  }
  ```

  **Documentation:**
  - `docs/ZOD-SCHEMAS.md` - Complete usage guide with NPM distribution details
  - `docs/VALIDATION_WORKFLOW.md` - CI integration (existing)
  - `examples/zod-validation-example.ts` - Working examples

### Patch Changes

- 244f639: Sync with AdCP v2.1.0 schema updates for build_creative and preview_creative
  - Add support for creative namespace in schema sync script
  - Generate TypeScript types for build_creative and preview_creative tools
  - Update creative testing UI to handle new schema structure:
    - Support output_format_ids array (was output_format_id singular)
    - Handle new preview response with previews[].renders[] structure
    - Display multiple renders with dimensions and roles for companion ads

  Schema changes from v2.0.0:
  - Formats now have renders array with role and structured dimensions
  - Preview responses: outputs → renders, output_id → render_id, output_role → role
  - Removed format_id and hints fields from preview renders

## 2.1.0

### Minor Changes

- 1b28db9: Add creative agent testing UI and improve error detection
  - Add creative testing UI with full lifecycle workflow (list formats → select → build/preview)
  - Fix FormatID structure to send full {agent_url, id} object per AdCP spec
  - Improve error detection to check for data.error field in agent responses
  - Update to AdCP v2.0.0 schemas with structural asset typing
  - Add FormatID type safety to server endpoints
  - Support promoted_offerings asset type with BrandManifestReference

## 2.0.2

### Patch Changes

- cf846da: Improve type safety and use structured data from schemas
  - Replace custom types with generated schema types (Format, Product, etc)
  - Remove all 'as any' type casts for better type safety
  - Remove 30+ lines of workaround code for non-standard responses
  - Export key schema types for public API (Format, Product, PackageRequest, CreativeAsset, CreativePolicy)
  - Client now expects servers to return proper structured responses per AdCP spec

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.2](https://github.com/adcontextprotocol/adcp-client/compare/v0.4.1...v0.4.2) (2025-10-09)

### Features

- add protocol-level webhook configuration support ([#38](https://github.com/adcontextprotocol/adcp-client/issues/38)) ([89bec3e](https://github.com/adcontextprotocol/adcp-client/commit/89bec3e695b94e551366022be4ea0ccc0b84ff2a))

## [0.4.1](https://github.com/adcontextprotocol/adcp-client/compare/v0.4.0...v0.4.1) (2025-10-08)

### Features

- add event store visibility and persist completed tasks ([#35](https://github.com/adcontextprotocol/adcp-client/issues/35)) ([5470662](https://github.com/adcontextprotocol/adcp-client/commit/5470662983ca4b1df3562e2224436e067c145b35))

### Bug Fixes

- distinguish task completion from operation success ([#34](https://github.com/adcontextprotocol/adcp-client/issues/34)) ([34b8d88](https://github.com/adcontextprotocol/adcp-client/commit/34b8d889745d96f60e00d7f5da45ae19fa253a18))

## [0.4.0] - 2025-10-05

### Changed

#### **BREAKING CHANGE: Handler Naming Convention**

- **All async handlers renamed** from `onXXXComplete` to `onXXXStatusChange` to better reflect their behavior
- Handlers now receive ALL status changes (completed, failed, needs_input, working, submitted), not just completions
- `WebhookMetadata` interface extended with `status` and `error` fields for status inspection

**Affected Handlers:**

- `onGetProductsComplete` → `onGetProductsStatusChange`
- `onListCreativeFormatsComplete` → `onListCreativeFormatsStatusChange`
- `onCreateMediaBuyComplete` → `onCreateMediaBuyStatusChange`
- `onUpdateMediaBuyComplete` → `onUpdateMediaBuyStatusChange`
- `onSubmitMediaBuyComplete` → `onSubmitMediaBuyStatusChange`
- `onCancelMediaBuyComplete` → `onCancelMediaBuyStatusChange`
- `onManageCreativeAssetsComplete` → `onManageCreativeAssetsStatusChange`
- `onSyncCreativesComplete` → `onSyncCreativesStatusChange`
- `onListCreativesComplete` → `onListCreativesStatusChange`
- `onGetMediaBuyComplete` → `onGetMediaBuyStatusChange`
- `onListMediaBuysComplete` → `onListMediaBuysStatusChange`
- `onTaskComplete` → `onTaskStatusChange` (fallback handler)

#### **BREAKING CHANGE: Removed Separate Status Handlers**

- Removed `onTaskSubmitted`, `onTaskWorking`, and `onTaskFailed` handlers
- All status changes now route through the typed handlers (e.g., `onGetProductsStatusChange`)
- Use `metadata.status` to check status type within your handlers

### Added

- **Status field** in `WebhookMetadata` interface to identify the current task status
- **Error field** in `WebhookMetadata` interface for failed task error messages
- **Comprehensive test suite** for async handler status changes (12 tests covering all status types)
- **In-memory event storage** in example server for debugging and observability
- **Events API endpoints** (`/api/events` and `/api/events/:operationId`) for querying stored events

### Migration Guide

**Before (v0.3.0):**

```typescript
const client = new ADCPMultiAgentClient(agents, {
  handlers: {
    onGetProductsComplete: (response, metadata) => {
      console.log('Products received:', response.products);
    },
    onTaskFailed: (metadata, error) => {
      console.error('Task failed:', error);
    },
  },
});
```

**After (v0.4.0):**

```typescript
const client = new ADCPMultiAgentClient(agents, {
  handlers: {
    onGetProductsStatusChange: (response, metadata) => {
      // Check status to handle different cases
      if (metadata.status === 'completed') {
        console.log('Products received:', response.products);
      } else if (metadata.status === 'failed') {
        console.error('Task failed:', metadata.error);
      } else if (metadata.status === 'needs_input') {
        console.log('Clarification needed:', response.message);
      }
    },
  },
});
```

**Why this change?**

- Handlers were already receiving all status changes, but the `Complete` suffix was misleading
- Separate status handlers (`onTaskFailed`, etc.) were redundant with typed handlers
- New naming is more honest about behavior and simplifies the API surface
- `metadata.status` provides clear, type-safe status inspection

## [0.3.0](https://github.com/adcontextprotocol/adcp-client/compare/v0.2.4...v0.3.0) (2025-10-04)

### Features

- fix A2A artifact extraction and add protocol response validation ([#28](https://github.com/adcontextprotocol/adcp-client/issues/28)) ([c4fe2d9](https://github.com/adcontextprotocol/adcp-client/commit/c4fe2d99cfc929f4aa083f95baeb64d3f211bef1))

## [0.2.3] - 2025-09-25

### Fixed

- **A2A Protocol Compliance** - Fixed message format to use `kind: "message"` and `input` instead of deprecated `parameters` field
- **Package-Lock Version Sync** - Resolved version mismatch between package.json (0.2.3) and package-lock.json (0.2.2)
- **MCP Product Extraction** - Fixed product extraction logic for proper display in testing UI

### Security

- **Authentication Token Management** - Removed all hardcoded authentication tokens from source code
- **Environment Variable Security** - Added support for `auth_token_env` to reference environment variables instead of hardcoded values
- **HITL Testing Security** - Created secure HITL setup with `.env.hitl.template` and git-ignored `.env.hitl` file
- **GitGuardian Compliance** - Achieved full compliance with security scanning requirements

### Added

- **Node.js Version Specification** - Added `.nvmrc` file specifying Node.js 20 requirement
- **HITL Setup Documentation** - Created comprehensive `docs/development/hitl-testing.md` with security-first configuration guide
- **Comprehensive Protocol Testing** - Added protocol compliance, schema validation, and integration contract tests
- **Security Documentation** - Enhanced README.md with security best practices and environment variable usage
- **CI Validation** - Added server configuration tests to prevent deployment issues

### Changed

- **Testing Strategy** - Implemented comprehensive protocol testing strategy documented in `docs/development/protocol-testing.md`
- **Documentation Updates** - Updated README.md to reflect v0.2.3 changes, security improvements, and Node.js requirements

### Development

- **Test Organization** - Restructured test suite with protocol-specific test categories
- **Mock Strategy** - Improved mocking strategy to test at SDK integration level instead of HTTP level
- **Error Reporting** - Enhanced error messages and debugging information for protocol issues

## [1.0.0] - 2025-09-20

### Added

#### Core Library Features

- **AdCPClient class** - Main client for interacting with AdCP agents
- **Unified protocol support** - Single API for both MCP and A2A protocols
- **ConfigurationManager** - Environment-based agent configuration loading
- **Type-safe APIs** - Comprehensive TypeScript type definitions
- **Protocol-specific clients** - `createMCPClient()` and `createA2AClient()` factory functions

#### Authentication & Security

- **Built-in authentication** - Bearer token and API key support
- **URL validation** - SSRF attack prevention with security checks
- **Token management** - Environment variable and direct token support
- **Secure defaults** - Production-safe configuration out of the box

#### Reliability & Performance

- **Circuit breaker pattern** - Automatic fault tolerance for failing agents
- **Concurrent request management** - Configurable batching with `MAX_CONCURRENT` limits
- **Timeout handling** - Request timeout with configurable `REQUEST_TIMEOUT`
- **Retry logic** - Built into circuit breaker implementation
- **Debug logging** - Comprehensive request/response logging

#### Tool Support

- **get_products** - Retrieve advertising products with brief and promoted offering
- **list_creative_formats** - Get supported creative formats
- **create_media_buy** - Create media buys from selected products
- **manage_creative_assets** - Upload, update, and manage creative assets
- **sync_creatives** - Bulk synchronization of creative assets
- **list_creatives** - Query and filter creative assets
- **Standard formats** - Built-in creative format definitions

#### Developer Experience

- **Comprehensive documentation** - JSDoc comments for all public APIs
- **Usage examples** - Multiple example files showing different patterns
- **Error handling** - Detailed error messages with actionable information
- **TypeScript IntelliSense** - Full type support with auto-completion

#### Testing Framework

- **Interactive web UI** - Point-and-click testing interface at http://localhost:3000
- **REST API** - Programmatic testing endpoints for CI/CD integration
- **Multi-agent testing** - Parallel execution across multiple agents
- **Performance metrics** - Response time analysis and success rates
- **Debug mode** - Request/response inspection with protocol-level details

#### Package & Distribution

- **Dual-purpose package** - Library + testing framework in one package
- **NPM-ready configuration** - Proper exports, types, and file inclusion
- **CommonJS & ESM support** - Compatible with all Node.js module systems
- **Minimal dependencies** - Only essential protocol SDKs as peer dependencies

### Technical Implementation

#### Architecture

- **Modular design** - Separated concerns in `src/lib/` for library code
- **Protocol abstraction** - Unified interface hiding MCP/A2A differences
- **Clean API surface** - Intuitive methods with consistent naming
- **Extensible design** - Easy to add new protocols and tools

#### Dependencies

- **@a2a-js/sdk** ^0.3.4 - Official A2A protocol client
- **@modelcontextprotocol/sdk** ^1.17.5 - Official MCP protocol client
- **TypeScript** ^5.3.0 - Full type safety and modern JavaScript features
- **Node.js** >=18.0.0 - Modern Node.js runtime support

#### Build System

- **TypeScript compilation** - Separate library and server builds
- **Source maps** - Full debugging support in development
- **Declaration files** - Complete `.d.ts` files for TypeScript users
- **Tree-shaking ready** - ESM exports for optimal bundle sizes

### Documentation

#### Files Added

- **README.md** - Comprehensive library documentation with examples
- **examples/basic-mcp.ts** - Simple MCP client usage
- **examples/basic-a2a.ts** - A2A client with multi-agent testing
- **examples/env-config.ts** - Environment-based configuration
- **API.md** - Detailed API reference (planned)
- **CONTRIBUTING.md** - Development guidelines (planned)
- **SECURITY.md** - Security policy and reporting (planned)

#### Examples & Tutorials

- **Quick start guide** - Get running in under 5 minutes
- **Multi-agent patterns** - Concurrent testing strategies
- **Error handling** - Comprehensive error management examples
- **Authentication setup** - Token configuration and security best practices

### Breaking Changes

This is the initial release, so no breaking changes from previous versions.

### Migration Guide

#### From Raw Protocol SDKs

If you were previously using `@a2a-js/sdk` or `@modelcontextprotocol/sdk` directly:

```typescript
// Before (raw MCP SDK)
import { Client as MCPClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = new MCPClient({
  name: 'My App',
  version: '1.0.0',
});

const transport = new StreamableHTTPClientTransport(new URL(agentUrl));
await client.connect(transport);
const result = await client.callTool({ name: 'get_products', arguments: args });

// After (@adcp/client)
import { createMCPClient } from '@adcp/client';

const client = createMCPClient(agentUrl, authToken);
const result = await client.callTool('get_products', args);
```

#### From Testing Framework Only

If you were using this as a testing framework only:

```typescript
// Before (server-side functions)
import { testSingleAgent } from './protocols';

const result = await testSingleAgent(agentId, brief, offering, toolName);

// After (library client)
import { AdCPClient } from '@adcp/client';

const client = new AdCPClient(agents);
const result = await client.callTool(agentId, toolName, {
  brief,
  promoted_offering: offering,
});
```

### Known Issues

- Repository and homepage URLs in package.json need to be updated for actual publication
- GitHub Actions CI/CD workflow not yet implemented
- Bundle size optimization not yet implemented
- Some server-only dependencies still included in main dependencies

### Upcoming Features (Next Release)

- Request/response interceptors for custom processing
- Connection pooling for improved performance
- Response caching with configurable TTL
- Plugin system for extending functionality
- Metrics and telemetry hooks
- Advanced retry strategies with backoff
- Request deduplication
- GraphQL-style query composition

---

**Note**: This changelog follows the [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) format. Each version documents:

- **Added** for new features
- **Changed** for changes in existing functionality
- **Deprecated** for soon-to-be removed features
- **Removed** for now removed features
- **Fixed** for any bug fixes
- **Security** for vulnerability fixes
