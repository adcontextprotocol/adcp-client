# Changelog

## 6.0.0

### Major Changes

- 9e9e407: Verifier API v3 + HTTPS-fetching JWKS / revocation stores. Closes #583
  (items 1 and 2) and closes #584.

  ## Breaking changes

  **`verifyRequestSignature` return shape** — now a discriminated union:

  ```ts
  type VerifyResult =
    | { status: 'verified'; keyid: string; agent_url?: string; verified_at: number }
    | { status: 'unsigned'; verified_at: number };
  ```

  Pre-3.x returned a `VerifiedSigner` with `keyid: ''` as a sentinel when the
  request was unsigned on an operation not in `required_for`. Consumers that
  branched on `result.keyid === ''` must now branch on `result.status`.

  `createExpressVerifier` updates `req.verifiedSigner` accordingly — the field
  is set only when `status === 'verified'`. Handlers that read
  `req.verifiedSigner !== undefined` continue to work (they were incorrect on
  the old `keyid: ''` sentinel path, which we've now eliminated).

  **`VerifyRequestOptions.operation` is now optional.** Passing it remains
  the correct behavior for middleware-driven verification; when omitted, the
  verifier treats the operation as "not in any `required_for`" and returns an
  unsigned result. Use this for always-verify mode where the application
  layer rejects the unsigned case itself.

  **`ExpressMiddlewareOptions.resolveOperation` may now return `undefined`.**
  Previously typed `(req) => string`. Callers that want to accept unsigned
  requests for specific paths (health checks, discovery) can return
  `undefined` to bypass `required_for` enforcement without losing verifier
  coverage on signed paths.

  ## New
  - **`HttpsJwksResolver(url, options)`** — fetches a JWKS from an HTTPS URL
    and caches it in memory. Key-unknown triggers a lazy refetch (honoring a
    30s minimum cooldown), so a counterparty rotating its keys is picked up
    without a process restart. Respects `ETag` (`If-None-Match`) and
    `Cache-Control: max-age`. Runs through `ssrfSafeFetch` so IMDS / private
    networks are refused.
  - **`HttpsRevocationStore(url, options)`** — caches a `RevocationSnapshot`
    in memory and refreshes when `now > next_update`. Fails closed with
    `request_signature_revocation_stale` when the snapshot is past
    `next_update + graceSeconds` (default 300s). SSRF-guarded.
  - **`request_signature_revocation_stale`** added to
    `RequestSignatureErrorCode`, with `failedStep: 9`. Middleware returns
    it as a 401 the same as any other verifier error.

  ## Migration

  ```ts
  // Before (2.x):
  if (verified.keyid) {
    // signed
  }

  // After (3.x):
  if (result.status === 'verified') {
    // signed — result.keyid is non-empty
  }
  ```

### Minor Changes

- d9613f6: Follow upstream AdCP rename of `domain` → `protocol` through the compliance cache, generated types, and storyboard runner.

  **Compliance cache layout**
  - `compliance/cache/{version}/domains/` → `compliance/cache/{version}/protocols/` (upstream currently ships both during transition; the runner now reads `protocols/`).
  - `index.json` field `domains` → `protocols`.
  - Specialism entries expose `protocol` (parent) instead of `domain`.

  **Public API**
  - `PROTOCOL_TO_DOMAIN` → `PROTOCOL_TO_PATH`.
  - `PROTOCOLS_WITHOUT_BASELINE` removed. Upstream no longer lists `compliance_testing` under `supported_protocols`; it's declared via the top-level `compliance_testing` capability block. Agents still shipping the old enum value are handled silently inside `resolveStoryboardsForCapabilities`. If you imported `PROTOCOLS_WITHOUT_BASELINE`, delete the reference.
  - `ComplianceIndexDomain` → `ComplianceIndexProtocol`.
  - `BundleKind` value `'domain'` → `'protocol'`.
  - `ComplianceIndex.domains` → `ComplianceIndex.protocols`.

  **Generated types (from upstream schemas)**
  - `AdCPDomain` → `AdCPProtocol`.
  - `TasksGetResponse.domain` → `protocol`; `TasksListRequest.filters.{domain,domains}` → `{protocol,protocols}`; `MCPWebhookPayload.domain` → `protocol`.
  - `GetAdCPCapabilitiesResponse.supported_protocols` no longer includes `'compliance_testing'`; presence of the top-level `compliance_testing` block declares the capability and `scenarios` is required within it.

  **Security baseline storyboard (partial support)**

  Upstream added a universal `security_baseline` storyboard whose steps target runner-internal tasks (`protected_resource_metadata`, `oauth_auth_server_metadata`, `assert_contribution`) and `$test_kit.*` substitution placeholders. The runner does not yet implement those execution paths. Steps targeting them are skipped with `skip_reason: 'missing_test_harness'` (overall storyboard reports `overall_passed: false` with zero passed steps). Full implementation — well-known metadata fetches, SSRF guardrails, accumulated-flag assertions, test-kit substitution — is tracked as a follow-up.

  **Other**
  - `adcp storyboard list` groups now labelled "Protocols" instead of "Domains".
  - `docs/llms.txt` Flow summaries omit runner-internal tasks so LLM consumers don't mistake them for tools agents must expose.

- c2a549d: Governance: remove non-spec `'escalated'` status to align with AdCP v3.

  AdCP v3 governance has three terminal `check_governance` statuses: `'approved' | 'denied' | 'conditions'`. `CheckGovernanceResponseSchema` already validates to this set, but the SDK core carried `'escalated'` as a fourth status from a pre-v3 model. Spec-compliant governance agents cannot emit it, so the code path was dead under validation and misrepresented the protocol to consumers branching on `govResult.status`.

  Human review is modelled in v3 as a workflow on `denied` (governance agent denies with a critical-severity finding that says human review is required; the buyer resolves review off-protocol and calls `check_governance` again with the human's approval), not as a fourth terminal status.

  Changes:
  - `GovernanceCheckResult.status` narrows to `'approved' | 'denied' | 'conditions'`.
  - `TaskStatus` drops `'governance-escalated'`; failing governance checks surface as `'governance-denied'`.
  - `TaskResultFailure.status` narrows to `'failed' | 'governance-denied'`.
  - `GovernanceMiddleware` drops the `'escalated'` branch in `checkProposed`.
  - `TaskExecutor.buildGovernanceResult` signature no longer takes a status parameter.
  - Test-scenario validator for `check_governance` rejects `'escalated'` as an unexpected status.

  Migration: if you branch on `result.status === 'governance-escalated'` or `govResult.status === 'escalated'`, fold those branches into the `'governance-denied'` / `'denied'` paths. Inspect `governance.findings` for human-review signals if you need to distinguish the reason.

  Fixes #589.

- 6034b50: Governance: migrate test fixtures off `budget.authority_level`; add Annex III helpers and a client-side invariant validator.

  AdCP removed `budget.authority_level` in favor of two orthogonal fields:
  - `budget.reallocation_threshold: number ≥ 0` / `budget.reallocation_unlimited: true` — budget reallocation autonomy (mutually exclusive).
  - `plan.human_review_required: boolean` — mandatory human review for decisions affecting data subjects under GDPR Art 22 / EU AI Act Annex III.

  Changes:
  - Remove every `authority_level` reference from `src/lib/testing/` and `test/lib/` fixtures. Mapping: `agent_full → reallocation_unlimited: true`; `agent_limited → keep reallocation_threshold` (drop authority_level); `human_required → plan.human_review_required: true`.
  - New `@adcp/client` exports from `src/lib/governance/`:
    - `buildHumanReviewPlan(input)` — stamps `human_review_required: true` on a plan. The caller remains responsible for declaring the reason via `policy_categories` / `policy_ids`.
    - `buildHumanOverride({ reason, approver, approvedAt? })` — builds the artifact required to downgrade `human_review_required: true → false` on re-sync. Validates reason ≥20 chars after trim, approver is an email, no control characters in either (audit-log safety), and `approvedAt` parses as ISO 8601.
    - `validateGovernancePlan(plan)` — client-side check for two invariants that `datamodel-code-generator`-style codegen drops from `if/then`: budget threshold XOR unlimited, and regulated `policy_categories` (`fair_housing`, `fair_lending`, `fair_employment`, `pharmaceutical_advertising`) or Annex III `policy_ids` requiring `human_review_required: true`. Governance agents resolve synonyms and custom policies server-side and remain authoritative.
    - `REGULATED_HUMAN_REVIEW_CATEGORIES`, `ANNEX_III_POLICY_IDS` constants.
  - `skills/build-governance-agent/SKILL.md` `check_governance` decision logic updated to document `reallocation_threshold` / `reallocation_unlimited`, auto-flipping `human_review_required`, `data_subject_contestation` findings, `human_override` artifacts, and the audit-mode-no-downgrade rule.
  - `docs/guides/GOVERNANCE-MIGRATION.md` documents the `authority_level` → `reallocation_threshold` / `reallocation_unlimited` / `human_review_required` mapping.

  Fixes #576.

- d666e51: Idempotency support for AdCP v3 mutating requests. Implements [adcp-client#568](https://github.com/adcontextprotocol/adcp-client/issues/568) (client ergonomics) and [adcp-client#569](https://github.com/adcontextprotocol/adcp-client/issues/569) (server middleware) for the required-key changes in [adcp#2315](https://github.com/adcontextprotocol/adcp/pull/2315).

  ## What "just works" for existing callers

  `npm update @adcp/client` is the full integration for most buyer-side apps:
  - Client methods for mutating tools (`createMediaBuy`, `updateMediaBuy`, `activateSignal`, etc.) auto-generate a UUID v4 `idempotency_key` when the caller doesn't supply one. TypeScript input types were loosened to accept callers without a key — the method types for mutating tools now wrap their request with `MutatingRequestInput<T>`.
  - Internal retries inside the SDK reuse the same key (re-generating defeats retry safety).
  - `result.metadata.idempotency_key` surfaces the key that was sent, so callers can log it or persist it alongside the resource they created.
  - `result.metadata.replayed` surfaces whether the seller returned a cached response for a prior retry.

  ## Things downstream users MUST actually do

  Three cases require action:
  1. **If your agent emits side effects on response** — notifications, LLM memory writes, downstream tool calls, UI toasts — you MUST check `result.metadata.replayed` before acting. A cached replay returning `replayed: true` means the side effects already fired on the original call; re-emitting is the exact bug this field exists to prevent.
  2. **If you catch errors broadly**, new typed errors exist:
     - `IdempotencyConflictError` — same key used earlier with a different canonical payload. Mint a fresh UUID v4 and retry. This is the signal that an agent re-planned with a different intent, not a retry.
     - `IdempotencyExpiredError` — key is past the seller's replay window. If you know the prior call succeeded, look up the resource by natural key (e.g., `get_media_buys` by `context.internal_campaign_id`) before retrying. If you don't know, a fresh key is safe.
  3. **If you BYOK** — persist `idempotency_key` to your own DB across process restarts — you own the replay-window boundary. Compare the key's age against `adcp.idempotency.replay_ttl_seconds` from `get_adcp_capabilities`. Past the window, fall back to natural-key lookup.

  ## Server-side middleware (`@adcp/client/server`)

  New: `createIdempotencyStore({ backend, ttlSeconds })`. Pass the store to `createAdcpServer` and the framework handles:
  - `INVALID_REQUEST` rejection when `idempotency_key` is missing or doesn't match the spec pattern `^[A-Za-z0-9_.:-]{16,255}$` (defense-in-depth against low-entropy keys and scope-injection via `\u0000` in the key)
  - Replay cache with RFC 8785 JCS canonicalization of the payload hash (excludes `idempotency_key`, `context` _when it's the echo-back object shape — string-typed `context` on SI tools stays in the hash_, `governance_context`, and `push_notification_config.authentication.credentials`)
  - `IDEMPOTENCY_CONFLICT` on same-key-different-payload (no payload/field/hash leak in the error body — spec-compliant read-oracle defense)
  - `IDEMPOTENCY_EXPIRED` past TTL with ±60s clock-skew tolerance
  - Concurrent-retry protection via atomic `putIfAbsent` claim step — parallel requests with the same fresh key see `SERVICE_UNAVAILABLE` with `retry_after: 1` rather than all racing to execute side effects
  - `replayed: true` injection on the envelope for cached replays (cache stores the _formatted_ envelope so non-deterministic wrap fields like `confirmed_at` are pinned; clones on every read so envelope stamps don't leak into the cache)
  - Per-principal scoping via `resolveSessionKey` or explicit `resolveIdempotencyPrincipal(ctx, params, toolName)`
  - **Per-session scoping for `si_send_message`** — the request `session_id` enters the scope tuple so the same key across two sessions doesn't cross-replay
  - Only successful responses are cached (errors, `status: 'failed'`, and `status: 'canceled'` responses re-execute on retry — handler errors release the in-flight claim so a retry can re-execute rather than replay a transient failure)
  - Auto-declares `adcp.idempotency.replay_ttl_seconds` on `get_adcp_capabilities` (REQUIRED per spec — clients MUST NOT assume a default)
  - Server-creation guardrail: logs an error when mutating handlers are registered without an idempotency store (v3 non-compliance — buyer retries will double-book). Suppressed by explicitly setting `capabilities.idempotency.replay_ttl_seconds` in your config.

  `ttlSeconds` must be between 3600 (1h) and 604800 (7d) per spec. Out-of-range values throw at `createIdempotencyStore` construction — silent clamping would hide operator misconfiguration (e.g., `60` meaning "one minute" becoming `3600` and misleading buyers about retry safety).

  Backends:
  - `memoryBackend()` — in-process Map, for tests and single-process training agents. Deep-clones on read and write so middleware mutations (envelope stamps, echo-back context) don't leak back into the cache.
  - `pgBackend(pool, { tableName? })` — Postgres. Identifiers centrally quoted via `quoteIdent` for defense-in-depth. Includes `getIdempotencyMigration()` for DDL and `cleanupExpiredIdempotency(pool)` for periodic reclaim.

  ## Public API additions

  ```ts
  // Client
  import {
    IdempotencyConflictError,
    IdempotencyExpiredError,
    generateIdempotencyKey,
    isMutatingTask,
    isValidIdempotencyKey,
    canonicalize,
    canonicalJsonSha256,
    closeMCPConnections, // now re-exported from the root — previously only via ./protocols
    type MutatingRequestInput,
  } from '@adcp/client';

  // Server
  import {
    createIdempotencyStore,
    memoryBackend,
    pgBackend,
    hashPayload,
    getIdempotencyMigration,
    cleanupExpiredIdempotency,
    type IdempotencyStore,
    type IdempotencyBackend,
  } from '@adcp/client/server';
  ```

  ## Not breaking, despite the field becoming required in the spec

  TypeScript request interfaces in `@adcp/client` mark `idempotency_key` as required (tracking the upstream schema), but the public client methods accept input without it and inject a key before sending. So existing call sites that omit `idempotency_key` continue to compile and run correctly. If you have code that constructs `CreateMediaBuyRequest` objects directly and sends them through raw MCP/A2A clients (bypassing `SingleAgentClient` / `AgentClient` / `ADCPMultiAgentClient`), add an `idempotency_key` — or route through the SDK methods, which handle it.

- 7a31d75: Complete the remaining client-side idempotency gaps from [#568](https://github.com/adcontextprotocol/adcp-client/issues/568) left open after PR #590.

  ## What changed

  ### Typed error instances on `TaskResult` for idempotency failures

  `result.errorInstance` is populated with a typed `ADCPError` subclass when the seller's error code has a dedicated class — currently `IdempotencyConflictError` and `IdempotencyExpiredError`. Callers can now write:

  ```ts
  const result = await client.createMediaBuy({...});
  if (result.errorInstance instanceof IdempotencyConflictError) {
    // Mint a fresh UUID v4 and retry
  }
  ```

  The SDK pulls the sent `idempotency_key` from tracked task state when constructing the error — the server intentionally omits the key from error bodies (it's a read-oracle), so the transport-layer caller is the authoritative source. A new `adcpErrorToTypedError(adcpError, key)` helper is exported for callers who already have an `AdcpErrorInfo` in hand and want to type-narrow it themselves.

  ### `getIdempotencyReplayTtlSeconds()` with fail-closed behaviour

  New method on `SingleAgentClient` / `AgentClient` that reads `adcp.idempotency.replay_ttl_seconds` from cached capabilities. Returns `undefined` on v2 sellers (pre-idempotency-envelope), the declared number on compliant v3 sellers, and **throws** when a v3 seller omits the declaration. No silent 24h default — the spec makes the declaration REQUIRED, and silently defaulting would mislead retry-sensitive flows.

  `AdcpCapabilities` now carries an `idempotency?: { replayTtlSeconds }` field populated from the v3 capabilities response. `parseCapabilitiesResponse` treats `0`, negative, or non-numeric values as "not declared" rather than coercing them.

  ### `useIdempotencyKey(key)` BYOK helper

  Validates against `IDEMPOTENCY_KEY_PATTERN` (`^[A-Za-z0-9_.:-]{16,255}$`) up front and returns a `{ idempotency_key }` fragment to spread into mutating params. Catches persisted-key drift before the round-trip:

  ```ts
  const key = await db.getOrCreateIdempotencyKey(campaign.id);
  await client.createMediaBuy({ ...params, ...useIdempotencyKey(key) });
  ```

  ### Key logging hygiene

  Idempotency keys are a retry-pattern oracle within their TTL, so the SDK no longer writes full keys to debug logs by default. MCP and A2A debug logs now show the first 8 characters of any `idempotency_key` followed by `…`. Set `ADCP_LOG_IDEMPOTENCY_KEYS=1` to opt into full logging for local debugging. New `redactIdempotencyKey(key)` helper is exported for applications that emit their own logs.

  ## Public API additions

  ```ts
  import {
    adcpErrorToTypedError,
    useIdempotencyKey,
    redactIdempotencyKey,
    type IdempotencyCapabilities,
  } from '@adcp/client';

  // On SingleAgentClient / AgentClient:
  const ttl = await client.getIdempotencyReplayTtlSeconds(); // throws on non-compliant v3
  ```

  ## Not a breaking change

  `TaskResult.errorInstance` is additive — existing code that switches on `adcpError.code` still works untouched. The new `getIdempotencyReplayTtlSeconds()` method only throws when callers explicitly ask for it against a non-compliant seller.

- f29780a: Storyboard runner: `--multi-instance` mode to catch horizontal-scaling persistence bugs.

  A seller deployed behind a load balancer with in-memory state passes every storyboard against a single URL but breaks in production when a follow-up step lands on a different machine. Single-URL runs never exercise this. `runStoryboard` now accepts an array of agent URLs and round-robins steps across them — writes on instance A must be visible on instance B or the read fails, and the runner attributes the failure with an instance→step map and a `write on [#A] → read on [#B] → NOT_FOUND` signature line matching the canonical horizontal-scaling bug.

  CLI:

  ```
  npx @adcp/client storyboard run \
    --url https://a.your-agent.example/mcp/ \
    --url https://b.your-agent.example/mcp/ \
    account_and_audience \
    --auth $TOKEN
  ```

  - Repeated `--url` engages multi-instance mode (minimum 2). Positional agent is disallowed in this mode — single-URL runs still use the positional shorthand.
  - JSON output gains `agent_urls[]` and `multi_instance_strategy` on the result, and `agent_url` + `agent_index` on each step.
  - `--dry-run` prints the per-step instance assignment plan.
  - Full capability-driven assessment (no storyboard ID) is not yet multi-instance aware; use a specific storyboard or bundle ID.

  Error output mirrors the canonical failure example in the protocol docs (`create on replica [#1] … succeeded. read on replica [#2] … failed with NOT_FOUND. → Brand-scoped state is not shared across replicas.`) so developers pattern-match the page they'll click through to. Deep-links to [Verifying cross-instance state](https://adcontextprotocol.org/docs/building/validate-your-agent#verifying-cross-instance-state).

  See `docs/guides/MULTI-INSTANCE-TESTING.md` for the full contract, including why the test asserts `(brand, account)`-keyed state, when false failures can occur, and how this fits alongside verify-by-architecture and verify-by-own-testing approaches.

  Implements the client-side half of the cross-instance persistence requirement introduced in [adcontextprotocol/adcp#2363](https://github.com/adcontextprotocol/adcp/pull/2363). Closes [adcontextprotocol/adcp#2267](https://github.com/adcontextprotocol/adcp/issues/2267).

- 7745a6f: Zero-config OAuth: auto-discovery on 401 + actionable `NeedsAuthorizationError`.

  Closes the remaining item from #563. Calling an OAuth-gated MCP agent without saved credentials used to bubble up a generic 401 or `UnauthorizedError`. Now the library automatically walks RFC 9728 protected-resource metadata + RFC 8414 authorization-server metadata from the server's `WWW-Authenticate` challenge and throws a structured `NeedsAuthorizationError` with everything a caller needs to recover — no re-probing required.

  **New exports**
  - `NeedsAuthorizationError` — thrown automatically by `ProtocolClient.callTool` / `ADCPMultiAgentClient` when an MCP agent returns a 401 Bearer challenge and no saved tokens can satisfy it. Carries `agentUrl`, `resource`, `resourceMetadataUrl`, `authorizationServer`, `authorizationEndpoint`, `tokenEndpoint`, `registrationEndpoint`, `scopesSupported`, and the parsed challenge.
  - `discoverAuthorizationRequirements(agentUrl, options?)` — programmatic access to the same walk. Returns `null` if the agent responds 200 without auth or 401 without a Bearer challenge.
  - `createFileOAuthStorage({ configPath, agentKey? })` — file-backed `OAuthConfigStorage` against the `adcp` CLI's agents.json format. Atomic writes via write-then-rename; preserves non-OAuth fields on save. `agentKey` override keys all writes under a fixed alias regardless of `agent.id` (CLI pattern).
  - `bindAgentStorage(agent, storage)` / `getAgentStorage(agent)` — per-agent `WeakMap` binding that threads an `OAuthConfigStorage` through `ProtocolClient.callTool` without changing its signature.

  **Behavior changes**
  - `ProtocolClient.callTool` now catches 401-shaped errors from both the OAuth-token path and the plain-bearer path and, if the agent returns a Bearer challenge, throws `NeedsAuthorizationError` instead of the generic error. Non-401 errors propagate unchanged.
  - When `agent.oauth_tokens` is present and storage has been bound via `bindAgentStorage`, the non-interactive OAuth provider now receives the storage so refreshed tokens persist to disk.
  - `adcp <alias> <tool>` automatically binds file-backed storage for saved OAuth aliases and prints an actionable prompt when authorization is required.

  **Not breaking**

  Existing callers that construct their own OAuth providers keep working. Existing bearer-only agents keep working. The only visible change on the error path is a more informative error class where `UnauthorizedError` would have propagated before.

- 198542f: OAuth DX: `adcp diagnose-auth` + introspection utilities.

  Debugging an OAuth misconfiguration against an MCP agent previously took hours of manual wire-level probing. These utilities collapse that into a single command with ranked hypotheses — and expose the underlying primitives so consumers can introspect the handshake themselves.

  **New CLI**
  - `adcp diagnose-auth <alias|url>` — end-to-end diagnostic that probes RFC 9728 protected-resource metadata, RFC 8414 authorization-server metadata, decodes the saved access token, optionally attempts a refresh with a `resource` indicator (RFC 8707), and calls `tools/list` + a tool on the agent. Emits ranked hypotheses (H1 resource-URL mismatch, H2 refresh grant ignores `resource`, H4 401 without `WWW-Authenticate`, H5 token-audience mismatch, H6 agent accepts token but doesn't validate audience).
  - `--json` for structured output, `--skip-refresh` / `--skip-tool-call` for read-only runs, `--tool NAME` to override the probe tool.

  **New library exports (from `@adcp/client` and `@adcp/client/auth`)**
  - `runAuthDiagnosis(agent, options)` — programmatic access to the diagnosis runner; returns `AuthDiagnosisReport` with per-step HTTP captures and ranked hypotheses.
  - `parseWWWAuthenticate(header)` — parse an RFC 9110 / RFC 6750 challenge and surface `realm`, `error`, `error_description`, `scope`, and the RFC 9728 `resource_metadata` URL.
  - `decodeAccessTokenClaims(token)` — unsigned JWT claim decoder for diagnostics. Returns `{ header, claims, signature }` or `null` for opaque tokens. Does not verify the signature.
  - `validateTokenAudience(token, expectedResource)` — checks whether the `aud` claim matches an expected resource URL with URL normalization. Returns `{ ok, reason, actualAudience }`.
  - `InvalidTokenError`, `InsufficientScopeError` — re-exported from `@modelcontextprotocol/sdk/server/auth/errors.js` so consumers can discriminate 401 causes with `instanceof` rather than string-matching error messages.

  **Bugfix**
  - `ssrfSafeFetch` now handles undici's `lookup` callback correctly when it's called with `{ all: true }` (undici's default on Node 22+ for HTTPS targets). The previous scalar-only callback path caused "Invalid IP address: undefined" errors on every external HTTPS probe.

- 6c84ea3: Thread OAuth tokens through the storyboard runner + `ADCPMultiAgentClient`.

  Storyboards and other `ADCPMultiAgentClient`-based flows were bearer-only — saved OAuth tokens never reached the MCP transport, so OAuth-gated agents always failed with `Authentication required` and couldn't refresh on 401.

  **New**
  - `NonInteractiveFlowHandler` — an OAuth flow handler that lets the MCP SDK use and refresh saved tokens but refuses to open a browser. Throws an actionable error (`adcp --save-auth <alias> --oauth`) if a full authorization flow is attempted.
  - `createNonInteractiveOAuthProvider(agent, { agentHint? })` — factory that builds an `MCPOAuthProvider` backed by the handler above. Use this in storyboard runs, scheduled jobs, and CI.
  - `TestOptions.auth` gained a third variant: `{ type: 'oauth', tokens, client? }`. Pass saved OAuth tokens here and the test client builds the refresh-capable OAuth provider automatically.

  **CLI**
  - `adcp storyboard run <alias>` now picks up `oauth_tokens` from saved aliases and routes them through the OAuth provider, so the SDK can refresh on 401 instead of failing immediately.
  - `resolveAgent` returns `oauthTokens` alongside `authToken` for command handlers that want the raw tokens.

  **Runtime**
  - `ProtocolClient.callTool` detects `agent.oauth_tokens` and routes MCP calls through `callMCPToolWithOAuth` with the non-interactive provider. Plain-bearer agents keep the cached-connection fast path.
  - `SingleAgentClient.getAgentInfo()` — the hand-rolled MCP connection now routes through `connectMCP`, so both bearer and OAuth aliases work.

  **Compatibility**

  No breaking changes. Agents without `oauth_tokens` keep the existing bearer path. Existing `auth_token` and `auth.type: 'bearer'` call sites are unchanged.

- 99ab36d: Follow upstream AdCP 3.0 account migration (adcontextprotocol/adcp#2336) across
  storyboard runner, generated types, and property-list adapter.

  **Storyboard runner — property-list builders removed.** The hardcoded request
  builders for `create_property_list`, `get_property_list`, `update_property_list`,
  `list_property_lists`, `delete_property_list`, and `validate_property_delivery`
  injected a top-level `brand:` field that is no longer part of those request
  schemas (replaced by `account`). The client stripped `brand` against any agent
  built to current spec, session keying collapsed, and every post-create step in
  the `property-lists` storyboard failed with `NOT_FOUND`. The builders are
  removed so the runner falls through to each step's `sample_request` (spec-correct
  `account` primitive), matching how `collection_list` tools have always worked.
  Fixes [#577](https://github.com/adcontextprotocol/adcp-client/issues/577).

  **Generated types regenerated** from upstream `latest.tgz` to pick up the
  account migration, new `signed-requests` specialism, and `request_signing`
  capability field on `GetAdCPCapabilitiesResponse`.

  **Public API**
  - `BudgetAuthorityLevel` type is removed — upstream no longer defines it.
  - `DelegationAuthority` is re-exported from `./types/core.generated` (moved
    upstream; the re-export path is the only change for consumers).

  **Property-list adapter (`@adcp/client/server`)**
  - `PropertyListAdapter.listLists` now filters by the `account` primitive instead
    of the removed `principal` field. Both `account_id` and `brand+operator`
    shapes are matched.

- c19ecce: Request-signing grader — MCP transport mode (closes #612).

  The conformance grader shipped in #600 targets raw-HTTP AdCP endpoints
  (`/adcp/create_media_buy`), matching the spec vectors' URL shape. MCP
  agents expose a single JSON-RPC endpoint with the operation named in the
  body — different URL shape, different framing. This change adds a
  transport-aware grading mode so the same grader works against both.

  **New `GradeOptions.transport: 'raw' | 'mcp'`** (default `'raw'`).

  In `'mcp'` mode, for every vector:
  - The URL becomes `baseUrl` as-is (no path-join) — MCP agents have one
    endpoint; the operation is in the body, not the path.
  - The body is wrapped in a JSON-RPC `tools/call` envelope:
    ```json
    { "jsonrpc": "2.0", "id": N, "method": "tools/call",
      "params": { "name": "<operation>", "arguments": <vector.body> } }
    ```
    `operation` is extracted from the vector URL's last path segment
    (`/adcp/create_media_buy` → `create_media_buy`).
  - `Accept: application/json, text/event-stream` is added so MCP Streamable
    HTTP servers don't 406 the probe. Not a signed component, so adding it
    doesn't affect signatures.

  The signature covers the envelope body (including `content-digest` when
  the verifier capability requires it). The verifier's `resolveOperation`
  reads the JSON-RPC `params.name`; this pattern is already the canonical
  one for MCP-hosted verifiers.

  **CLI flag `--transport <mode>`** on `adcp grade request-signing`.
  Validated against `raw | mcp`; any other value exits 2 with a clear
  error.

  **New test agent `test-agents/seller-agent-signed-mcp.ts`** — uses
  `createAdcpServer` (with `request_signing` + `specialisms` advertised via
  the #600 framework wiring) + `serve({ preTransport })` (the pre-MCP
  middleware hook from #600). The verifier fires before MCP dispatch; valid
  requests flow into `createMediaBuy` / etc., invalid requests get 401 +
  WWW-Authenticate.

  **End-to-end test** at `test/request-signing-grader-mcp.test.js` —
  spawns the MCP agent on a dedicated port, grades it in MCP mode, asserts
  25/25 non-profile vectors pass + structural invariants on the envelope
  shape (method, params.name, URL = baseUrl, Accept header present).

  Raw-HTTP grading (default) is unchanged. Canonicalization-edge vectors
  (005–008) bake their edges into the vector URL path/query — MCP mode
  folds them into plain POSTs against the MCP endpoint, which is a
  documented trade-off, not a regression. Operators who want those edges
  tested should use `--transport raw` against a per-operation agent.

  Dependency graph is now complete for the live-agent smoke test tracked
  at adcontextprotocol/adcp#2368: with #600 (grader) + this PR
  (MCP-aware) + #2368 (test-agent deploys the verifier + advertises the
  specialism), `adcp grade request-signing https://test-agent.adcontextprotocol.org/mcp --transport mcp`
  produces a meaningful conformance grade.

- d116a07: Request-signing conformance grader — review fixes.

  Addresses findings from the six-agent expert review of PR #600. Behavioral
  changes:

  **Correctness**
  - Skipped vectors now report as `skipped: true` through the storyboard
    runner instead of being scored as failures (previously `probe-dispatch.ts`
    set `HttpProbeResult.error` on skip, which the runner's `fetchOk` check
    treated as failed). Requires a new `HttpProbeResult.skipped` flag and
    `executeProbeStep` branch that bypasses validations for skipped probes.
  - Synthesis failure now surfaces as a failing `synthesis_error` phase in
    the storyboard rather than a silent empty-phase fallback — CI pipelines
    would have seen green for an infrastructural bug.
  - Vector 010 (`content-digest-mismatch`) now tests the intended invariant:
    the signer commits a wrong `Content-Digest` value (zero-byte digest) in
    the signature base, and the verifier's step-11 recompute fails. Previous
    mutation (append space to body post-sign) exercised a different bug
    class (body-tampered-in-transit) and would mask lying-signer detection
    in verifiers that recompute digest from the received body.
  - Vector 009 (`key-purpose-invalid`) now honors the vector's pinned
    `jwks_ref` (`test-gov-2026`) directly instead of inferring a non-request-
    signing key from the keyset.

  **Safety (live side effects)**
  - Vectors 016 (`replay_window`) and 020 (`rate_abuse`) now auto-skip
    against non-sandbox endpoints unless the operator passes
    `allowLiveSideEffects: true`. The contract YAML's `endpoint_scope:
sandbox` declaration satisfies the gate when present. Prevents
    accidental live `create_media_buy` creation or replay-cache flooding
    against production agents.
  - `GradeReport.endpoint_scope_warning` → renamed to `live_endpoint_warning`
    and inverted to be `true` when the endpoint is NOT declared sandbox
    (the dangerous case). Prior semantics were misleading: the field read
    as "sandbox is bad."

  **WWW-Authenticate parser hardening**
  - `extractSignatureErrorCode` now constrains returned codes to the
    `[a-z0-9_]+` alphabet, rejecting malformed / adversarial values from
    untrusted agent headers. Downstream diagnostic strings and LLM-consumption
    paths are safe from smuggled content.
  - `splitChallenges` now tracks quote state so adversarial `error="foo,
Bar baz"` doesn't spuriously split mid-value.

  **DX / ergonomics**
  - New CLI: `adcp grade request-signing <agent-url>` with
    `--skip-rate-abuse`, `--rate-abuse-cap`, `--only`, `--skip`,
    `--allow-live-side-effects`, `--allow-http`, `--json`. Human-readable
    table output by default; exit code 0 on pass, 1 on fail, 2 on
    configuration error.
  - `GradeReport` now carries `passed_count` / `failed_count` /
    `skipped_count` at the top level — no more client-side `reduce()` to
    enumerate.
  - `GradeOptions.onlyVectors: string[]` filters to a subset of vector IDs
    (all others auto-skip) — simplifies isolated regression tests and
    replaces the three hand-maintained 19-entry skip arrays in the test
    suite.
  - Barrel (`index.ts`) is now grouped as "Public API" / "Storyboard-runner
    hooks" / "Advanced harness building blocks" with a top-level module
    JSDoc and usage snippet.
  - `BuildOptions.baseUrl` now prefixes the agent's mount path to the
    vector path, so agents served at `/v1/adcp/*` (not `/adcp/*`) receive
    requests at the right path.

  **Hygiene**
  - `ContractId` (`replay_window | revocation | rate_abuse`) is now a single
    source of truth in `types.ts` (was duplicated across three files).
  - `AdcpJsonWebKey.d` is now an explicit optional field with JSDoc
    explaining its role instead of flowing through the index signature.
  - `loadRequestSigningVectors` memoizes per-cacheDir. Previously every
    `gradeOneVector` call re-parsed 28 JSON fixtures + keys.json + YAML
    test-kit (compliance cache is immutable during a process lifetime).
  - New test util `test/utils/reference-verifier.js` extracts the
    `startReferenceVerifier` + `makeExpressShim` pattern that previously
    appeared verbatim in three test files.
  - Dispatch wire-up test: `runStoryboardStep` with a synthesized
    `request_signing_probe` step now has a dedicated test so someone
    removing the task from `PROBE_TASKS` or flipping the dispatch condition
    in `runner.ts` gets caught by CI.

- d116a07: Request-signing conformance grader — Slice 1: vector loader + adversarial builder.

  Internal module at `src/lib/testing/storyboard/request-signing/` that consumes the
  RFC 9421 conformance vectors and test keypairs shipped in
  `compliance/cache/{version}/test-vectors/request-signing/`. Walks the positive/
  and negative/ directories, parses each fixture into typed `PositiveVector` /
  `NegativeVector` values (including the `requires_contract` field for stateful
  vectors 016/017/020 once upstream adcp#2353 lands in `latest.tgz`), and loads
  `keys.json` with the private scalars needed for dynamic re-signing.

  Adversarial builder registers one mutation per negative vector (20 total). Each
  mutation starts from a freshly-signed baseline via `src/lib/signing/signer.ts`
  and applies the single documented mutation — wrong tag, expired window,
  missing covered component, content-digest mismatch, malformed Signature-Input,
  etc. — so the grader can send real requests to a live verifier rather than
  replaying stale `reference_now` signatures. Stateful vectors (016 replay, 017
  revoked, 020 rate-abuse) produce a single well-formed request; the storyboard
  runner will orchestrate repeat/flood/revoked-keyid behavior around them per
  the signed-requests-runner test-kit contract (coming in Slice 2).

  Not yet public API — consumed by the in-progress storyboard runner phase.

- d116a07: Request-signing conformance grader — Slice 2: standalone grader orchestrator
  and end-to-end smoke test against the reference verifier.

  New module surface under `src/lib/testing/storyboard/request-signing/`:
  - **Test-kit loader** (`test-kit.ts`): parses the signed-requests-runner harness
    contract YAML shipped by adcp#2353. Typed access to the runner's signing
    keyids, replay-window contract, revocation contract, and rate-abuse contract
    (with production-cap vs grading-cap fields kept separate per the spec).
  - **HTTP probe** (`probe.ts`): sends a `SignedHttpRequest` to the agent and
    captures status + `WWW-Authenticate` error code. Reuses the SSRF guards
    from `storyboard/probes.ts` (DNS pin, private-IP block, IMDS always-block,
    64 KiB body cap, 10 s timeout, `redirect: 'manual'`).
  - **Grader orchestrator** (`grader.ts`): `gradeRequestSigning(agentUrl, options)`
    runs all 28 conformance vectors in black-box mode. Handles the stateful
    contracts natively — vector 016 uses the replay-window repeat-request
    behavior, 017 uses the pre-revoked keyid, 020 fills the per-keyid cap then
    probes cap+1 — and emits per-vector diagnostics keyed to the spec error
    codes. `skipRateAbuse`, `rateAbuseCap`, and `skipVectors` options let
    operators tune to their agent's configuration.
  - **Base-URL retargeting** in the builder: the vectors target
    `seller.example.com`, but real agents live elsewhere. `BuildOptions.baseUrl`
    swaps the origin into the agent's URL before signing so signatures match
    the URL the grader actually POSTs to.

  Integration test at `test/request-signing-grader-e2e.test.js` stands up a
  reference verifier (the #587 Express middleware) on localhost and grades
  against it. Covers the capability-either profile on 17 non-stateful negatives
  - replay/revocation + 8 positives, plus dedicated tests for the
    content-digest `required`/`forbidden` capability profiles and the rate-abuse
    contract with matched caps. Verifies the full loader → builder → probe →
    grader pipeline catches the step-ordering guarantees of the checklist (9/9a
    before 10, 12 before 13) and the WWW-Authenticate byte-for-byte match.

  Storyboard-runner integration (synthesizing per-vector steps into the YAML
  runner's phase structure) is deferred to Slice 3 so it can land as a
  focused change touching `runner.ts` / `probes.ts` / `compliance.ts`.

  Not yet a CLI entry point — consume via `loadRequestSigningVectors` /
  `gradeRequestSigning` from
  `@adcp/client/testing/storyboard/request-signing` (internal module path).

- d116a07: Request-signing conformance grader — Slice 3: storyboard-runner integration.

  The signed-requests specialism YAML declares `positive_vectors` and
  `negative_vectors` phases whose steps are synthesized at runtime from the
  test-vector fixtures (the spec deliberately avoids duplicating fixture data
  in YAML). This change wires those synthesized steps into the storyboard
  runner so `get_adcp_capabilities` → run-storyboard pipelines grade an agent's
  RFC 9421 verifier as part of a normal compliance run.

  Changes:
  - **Synthesizer** (`storyboard/request-signing/synthesize.ts`): expands
    `positive_vectors` / `negative_vectors` phases with one
    `request_signing_probe` step per vector on disk. Step IDs follow a
    `positive-<vector>` / `negative-<vector>` convention that the dispatch
    helper decodes. `skipVectors` option filters at synthesis time.
  - **Compliance loader** hooks synthesis into `loadBundleStoryboards` so
    callers (runner, CLI tools, reporting) see a fully populated storyboard.
    Falls back to the unsynthesized form with a warning if the compliance
    cache is missing vectors.
  - **Loader** (`storyboard/loader.ts`) now tolerates phases with no `steps:`
    key — the signed-requests YAML is the first specialism to ship such
    phases.
  - **Probe dispatch** (`storyboard/request-signing/probe-dispatch.ts`): new
    `request_signing_probe` entry in `PROBE_TASKS`. The dispatcher decodes
    the step ID, runs the grader's per-vector logic
    (`gradeOneVector`), and maps the `VectorGradeResult` to an
    `HttpProbeResult`-shaped return so the existing validation pipeline
    (`http_status`, `http_status_in`) works unchanged.
  - **StoryboardRunOptions** gains a `request_signing?` block —
    `skipRateAbuse`, `rateAbuseCap`, `skipVectors` — so operators can tune
    the grader without forking the runner.

  Integration tests at `test/request-signing-runner-integration.test.js`:
  verify synthesis produces the right step count/IDs, exercise the probe
  dispatch against a reference verifier (positive accept, negative reject
  with matching WWW-Authenticate, skip-rate-abuse, skip-vectors, unknown
  step ID, capability-profile mismatch surfaces as a probe error).

  With this slice, `compliance/specialisms/signed-requests/index.yaml` runs
  end-to-end through the existing storyboard runner — no specialism-specific
  entry point required.

- d116a07: Request-signing grader — Slice 4: signed test agent + framework wiring for
  `request_signing` / `specialisms` capability advertisement.

  **Framework — `AdcpCapabilitiesConfig`**

  `createAdcpServer({ capabilities: { … } })` now accepts two fields previously
  unreachable from the framework:
  - `request_signing` — the RFC 9421 verifier capability block
    (`supported`, `covers_content_digest`, `required_for`, `warn_for`,
    `supported_for`). Emitted verbatim in `get_adcp_capabilities.request_signing`.
  - `specialisms` — specialism claim list (e.g. `['signed-requests']`).
    Each entry maps to a compliance bundle under
    `/compliance/{version}/specialisms/{id}/`; the AAO runner resolves and
    executes the matching storyboards.

  Without these, agents wanting to declare signed-requests support had to
  fork the capability-assembly path. Now it's one-liner capability config.

  **Framework — `serve.preTransport` hook**

  `serve(createAgent, { preTransport })` accepts a pre-MCP-transport middleware
  that runs after path-matching and before the MCP transport is connected. The
  request body is buffered into `req.rawBody` before the hook fires so
  signature verifiers can hash it. The transport receives the parsed JSON body
  via `transport.handleRequest(req, res, parsedBody)` so the already-consumed
  stream doesn't race.

  Intended for transport-layer concerns — RFC 9421 signature verification
  being the primary use case. Returning `true` signals the middleware handled
  the response (e.g. a 401 with `WWW-Authenticate`); returning `false`
  continues into MCP dispatch.

  **Test agent — `test-agents/seller-agent-signed.ts`**

  Minimal HTTP server pre-configured per the `signed-requests-runner`
  test-kit contract:
  - JWKS contains `test-ed25519-2026`, `test-es256-2026`, `test-gov-2026`,
    `test-revoked-2026` (from `compliance/cache/latest/test-vectors/
request-signing/keys.json`).
  - Revocation list pre-includes `test-revoked-2026`.
  - Per-keyid replay cap = 100 (matches contract's
    `grading_target_per_keyid_cap_requests`).
  - `required_for: ['create_media_buy']` — vector 001 surfaces
    `request_signature_required`.

  Exposes `/get_adcp_capabilities` (unsigned, declares `supported: true` +
  `specialisms: ['signed-requests']`) and accepts signed requests on any
  other path, routing the operation name from the last path segment.

  Run `PORT=3100 node test-agents/dist/seller-agent-signed.js` and grade it
  with `node bin/adcp.js grade request-signing http://127.0.0.1:3100
--allow-http --skip-rate-abuse`. Current results against this agent:
  **25/25 graded vectors pass, 3 skipped** (capability-profile + rate-abuse
  opt-out). Validates the full grader → signer → verifier path end-to-end.

  Note: the test agent is not an MCP agent — vectors target raw-HTTP AdCP
  paths, and the RFC 9421 verifier is a transport-layer concern. An
  MCP-aware grader (JSON-RPC envelope wrapping + single-endpoint routing)
  is a separate scope; follow-up ticket to be filed.

- 9fd1ba1: RFC 9421 request-signing profile (AdCP 3.0 optional). Adds `@adcp/client/signing`
  with signer, verifier, Express-shaped middleware, pluggable JWKS/replay/revocation
  stores, and typed error taxonomy (`RequestSignatureError`). Passes all 28 spec
  conformance vectors shipped in `compliance/cache/latest/test-vectors/request-signing/`
  (one positive vector currently skipped pending upstream adcp#2335 tarball
  republish — test auto-unskips when `npm run sync-schemas` pulls the fixed
  vector). Verifier uses the received `Signature-Input` substring verbatim when
  rebuilding the signature base, so peers emitting params in any legal RFC 8941
  order remain byte-identical. Replay TTL floored at one max-window + skew so
  short-validity signers can't escape the replay horizon. Content-Digest parses
  as an RFC 9530 dictionary (accepts `sha-256` alongside other algorithms).
  JWKS-returns-wrong-kid and Content-Length-without-rawBody both reject as typed
  errors. New CLI: `adcp signing generate-key` (suppresses private JWK from
  stdout when `--private-out` is set) and `adcp signing verify-vector`.
- f22d5dc: Auto-apply RFC 9421 request signing to outbound MCP and A2A calls inside
  `ProtocolClient` / `AdCPClient`. Follow-up to the signing primitives shipped
  previously: the library now wires the signer into `StreamableHTTPClientTransport`
  and the A2A `fetchImpl` automatically when an `AgentConfig.request_signing`
  block is present.

  Behavior:
  - On first outbound call for an agent with `request_signing`, the client
    fetches `get_adcp_capabilities` (unsigned — the discovery op is exempt) and
    caches the seller's `request_signing` capability per-agent with a 300s TTL.
  - Subsequent calls consult the cache to decide per-operation whether to
    sign — precedence matches the spec: buyer `always_sign` > seller
    `required_for` > seller `warn_for` (shadow-mode telemetry) > seller
    `supported_for` (buyer opted in via `sign_supported`).
  - Content-digest coverage honors the seller's `covers_content_digest` policy
    (`required` / `forbidden` / `either`) per-request.
  - Transport connection caches disambiguate by a per-key fingerprint (hash of
    `kid` + private scalar) so two tenants that misconfigure the same `kid`
    but hold distinct private keys cannot collide on a shared cached
    transport and sign each other's traffic.
  - `get_adcp_capabilities` and MCP/A2A protocol-layer RPCs (`initialize`,
    `tools/list`, A2A card discovery) always pass through unsigned.
  - OAuth-gated agents with signing: `callMCPToolWithOAuth` threads the
    signing context through to the transport fetch, so OAuth flows don't
    silently drop signatures.
  - Priming failures fail open with a 60s negative cache: a transient seller
    discovery outage doesn't wedge every subsequent call. `always_sign` ops
    still get signed with sensible content-digest defaults; ops the seller
    might have listed in `required_for` reach the wire unsigned and are
    rejected visibly with `request_signature_required`, which retries re-prime.
  - Concurrent cold-cache fans-out share one `get_adcp_capabilities` fetch
    via an in-flight pending-map stored on the `CapabilityCache` instance
    itself — so two tenants with separate `CapabilityCache` instances get
    independent in-flight tables, and embedders who construct their own
    cache don't race against the default cache.
  - `AgentSigningContext.invalidate()` evicts this context's capability
    entry so callers don't have to rebuild the cache key from the agent's
    identifying fields when they want to force a re-prime.
  - Signing-reserved headers (`Signature`, `Signature-Input`, `Content-Digest`)
    supplied by a caller's `customHeaders` are scrubbed before the signer
    runs — a misconfigured header cannot silently break or bypass the RFC
    9421 signature output.
  - `extractAdcpOperation` throws on unsupported body shapes (Blob, FormData,
    ReadableStream) rather than silently passing the request unsigned — the
    seller's `required_for` contract is not broken by SDK body-format drift.

  New field on `AgentConfig`: `request_signing?: AgentRequestSigningConfig`
  (kid, alg, `AdcpPrivateJsonWebKey` with required `d`, agent_url, optional
  `always_sign[]` and `sign_supported`).

  New sub-barrels:
  - `@adcp/client/signing/client` — signer, canonicalization, fetch wrapper,
    capability cache, and the auto-wiring helpers a buyer building an
    AdCPClient needs.
  - `@adcp/client/signing/server` — verifier pipeline, Express-shaped
    middleware, JWKS / replay / revocation stores, error taxonomy.

  The existing `@adcp/client/signing` barrel continues to export the union of
  both sub-barrels, so existing consumers keep working. New code should
  import from whichever half matches its role — coding agents reading a file
  cold only need to hold one side of the taxonomy.

  New exports on `@adcp/client/signing/client`: `CapabilityCache`,
  `buildCapabilityCacheKey`, `defaultCapabilityCache`,
  `buildAgentSigningContext`, `buildAgentSigningFetch`,
  `ensureCapabilityLoaded`, `extractAdcpOperation`, `shouldSignOperation`,
  `resolveCoverContentDigest`, `toSignerKey`, `CAPABILITY_OP`,
  `CoverContentDigestPredicate`. `AgentSigningContext` gains an
  `invalidate()` method. `CachedCapability` gains an optional `staleAt`
  deadline for negative-cache entries.

  `createSigningFetch` now accepts `coverContentDigest` as either `boolean`
  or `(url, init) => boolean` so the seller policy can be resolved per
  request without rebuilding the wrapper.

- 9f79f72: Conform the storyboard runner and `comply()` output to the universal
  runner-output contract (adcontextprotocol/adcp PR #2364 / issue #2352).
  Failure results are now actionable: the implementor can self-diagnose
  a validation failure from the runner output alone, without re-running
  the step by hand.

  **New on every `ValidationResult`:**
  - `json_pointer` — RFC 6901 pointer to the failing field
  - `expected` / `actual` — machine-readable values (schema `$id`,
    allowed enums, observed value, etc.)
  - `schema_id` / `schema_url` — set on `response_schema` checks so the
    implementor can re-validate locally against the same artifact
  - `request` / `response` — exact bytes the runner sent and observed,
    attached on failure (not echoed on passing checks)
  - For `response_schema` failures, `actual` is now an AJV-shaped
    `{ instance_path, schema_path, keyword, message }[]` instead of a
    flat message string.

  **New on every `StoryboardStepResult`:**
  - `extraction: { path: "structured_content" | "text_fallback" | "error" | "none" }`
    — records which MCP extraction path produced the parsed response so
    runner extraction bugs are separable from agent bugs. The response
    unwrapper and raw MCP probe stamp the provenance as a non-enumerable
    `_extraction_path` tag on the unwrapped `AdCPResponse`; the runner reads
    it via `readExtractionPath()` and surfaces it here. All four values are
    emitted in practice (previously `text_fallback` was unreachable).
  - `request` / `response_record` — the full transport-level exchange
    (omitted for synthetic / skipped steps).
  - `storyboard_id` — each step is self-describing.
  - `skip: { reason, detail }` — structured skip result with
    human-readable explanation (agent tools, prerequisite step id, etc.).

  **Spec-aligned skip reasons.** The narrow
  `"not_testable" | "dependency_failed" | "missing_test_harness" | "missing_tool"`
  enum is replaced by the six contract reasons:

  | Reason                    | When it fires                                              |
  | ------------------------- | ---------------------------------------------------------- |
  | `not_applicable`          | Agent did not declare the protocol / specialism            |
  | `no_phases`               | Storyboard is a placeholder with no executable phases      |
  | `prerequisite_failed`     | Prior step or context variable did not produce a value     |
  | `missing_tool`            | Agent did not advertise a required tool                    |
  | `missing_test_controller` | Deterministic-testing phase needs `comply_test_controller` |
  | `unsatisfied_contract`    | A test-kit harness contract is out of scope                |

  **Top-level summary gains:**
  - `total_steps`, `steps_passed`, `steps_failed`, `steps_skipped`
  - `schemas_used: Array<{ schema_id, schema_url }>` — deduplicated list
    of schemas applied across the run so implementors can re-validate
    locally.

  **`ComplianceFailure` carries the first failed validation's
  machine-readable detail** (`json_pointer`, `expected`, `actual`,
  `schema_id`, `schema_url`) under a `validation` field, and the terminal
  formatter now renders `At:` / `Expected:` / `Actual:` / `Schema:` for
  each failure instead of the single generic line
  `"Check agent capabilities"`.

  **Security hardening.** Request and response payloads echoed on failed
  validations run through a recursive redactor that replaces values at
  keys matching `/^(authorization|credentials?|token|api[_-]?key|…)$/i`
  with `'[redacted]'`. Response headers are allowlisted — only
  `content-type`, `content-length`, `content-encoding`,
  `www-authenticate`, `location`, `retry-after`, `x-request-id`,
  `x-correlation-id` pass through; `set-cookie`, `authorization`,
  `x-internal-*`, `x-amz-*` etc. are dropped so a hostile agent cannot
  bait the runner into publishing internal state in a shared compliance
  report. Agent-controlled `error` / `validation.actual` strings in the
  terminal formatter output are wrapped in the existing
  `fenceAgentText()` nonce so downstream LLM summarizers can't be
  hijacked by hostile error messages.

  **Migration.** The changes are additive on `ValidationResult` /
  `StepResult` / `ComplianceFailure`. The skip-reason enum is a
  breaking rename. Call sites that pattern-match on the old values
  (`"not_testable"`, `"dependency_failed"`, `"missing_test_harness"`)
  need to migrate to the spec-aligned names above. The bundled CLI
  (`bin/adcp.js`) is updated in-tree; the only user-visible surface
  that still needs a migration is third-party automation that reads
  `StoryboardStepResult.skip_reason` from the `--json` output.

- 5ff25b0: Round-2 runner enhancements for the `universal/security.yaml` conformance baseline (adcp-client#565).

  > **Upgrade note** — this release tightens one test-kit invariant (`test_kit.auth.probe_task` is now required whenever `test_kit.auth` is declared, with an allowlist) and tightens its TypeScript type accordingly. Callers that relied on the 5.0.x implicit default must add `probe_task: list_creatives` to preserve the prior behavior. See the "Breaking" section below.

  Picks up the outstanding runner-side asks flagged during expert review of the storyboard. The directives and validation checks from the first round already shipped in 5.0.x; this release closes the remaining gaps before the storyboard can drive conformance against real v3.x agents.

  **Version-gated storyboard execution**

  Storyboards can now declare the AdCP version that introduced them via a new optional `introduced_in: "<major.minor>"` field. When an agent's `get_adcp_capabilities.adcp.major_versions` does not include the storyboard's major, the runner skips it with `skip_reason: 'not_applicable'` instead of running and retroactively failing. A v3.0 agent tested against a v3.1-introduced storyboard now surfaces a distinct "not applicable" row in compliance reports rather than a silent pass or a misleading fail.

  `resolveStoryboardsForCapabilities()` now returns `{ storyboards, not_applicable, bundles }` — callers that previously destructured only `{ storyboards }` continue to work. The new `AgentCapabilities.major_versions` input drives the gate; when omitted (v2 agents, failed-discovery profiles) every storyboard runs as before.

  **`test_kit.auth.probe_task` is now required with an allowlist**

  The kit field that tells the runner which authenticated read-only task to probe for unauth / invalid-key rejections no longer silently defaults to `list_creatives`. A kit that declares `test_kit.auth` without a `probe_task` now fails at load with a `TestKitValidationError`. `probe_task` must be one of `list_creatives`, `get_media_buy_delivery`, `list_authorized_properties`, `get_signals`, `list_si_sessions` — auth-required, read-only AdCP tasks that accept an empty request body so auth failures fire before schema validation.

  This is the issue-565 round-2 "Option A" call: explicit declaration blocks the silent-regression hazard where every signals-only / SI-only / retail-only agent would fail the storyboard for kit-config reasons, not agent reasons, on the day the storyboard shipped. `validateTestKit()` is exported from `@adcp/client/testing` so upstream YAML loaders can reject malformed kits at file-load time.

  **Probe-task error disambiguation (400 / 422 vs 401 / 403)**

  When a probe step expects an auth rejection (`http_status_in: [401, 403]`) and the agent instead returns 400 or 422 with a JSON-RPC invalid-params / schema-validation body, the runner now reports a targeted kit-config error: "agent's schema validator rejected the probe before the auth layer ran; fix `test_kit.auth.probe_task`." This is the safety net behind the allowlist: even if a non-allowlisted task slipped through, the diagnostic points at kit config, not a nonexistent agent auth bug.

  **Breaking (narrow)**

  Two compile-time / runtime behaviors change for callers that use `TestOptions.test_kit.auth`:
  - The TypeScript type of `probe_task` is now required (`probe_task: string`, not `probe_task?: string`). TypeScript users get a compile error the first time they build against 5.1.0.
  - At runtime, `comply()` / `runStoryboard()` / `runStoryboardStep()` throw `TestKitValidationError` when `test_kit.auth` is declared without `probe_task`, or with a value outside the allowlist. No default is substituted.

  Kits that don't declare a `test_kit.auth` block are unaffected. To migrate: set `probe_task: list_creatives` if you previously relied on the implicit default, or pick the allowlisted task that matches your agent's surface (`get_media_buy_delivery`, `list_authorized_properties`, `get_signals`, `list_si_sessions`).

- 6862d8c: Storyboard runner support for the `universal/security.yaml` conformance baseline.

  Ships the runner work tracked in adcp-client#565. The upstream storyboard (adcontextprotocol/adcp#2298) uses three new directives and four new validation checks that this release implements.

  **New step directives**
  - `auth: 'none'` — strip transport credentials for that step only. Required for the unauthenticated probe.
  - `auth: { type: 'api_key', value? | from_test_kit? | value_strategy? }` — literal Bearer override, pull from the test kit, or generate a per-run random bogus key (`random_invalid`).
  - `auth: { type: 'oauth_bearer', value? | value_strategy: 'random_invalid_jwt' }` — send an arbitrary Bearer value or a per-run random JWT-shaped token (valid base64url-encoded JSON header/payload + random signature) so well-implemented validators fail at signature verification.
  - `task: "$test_kit.<path>"` + `task_default: '<task>'` — resolve the step's task from test-kit data, falling back to the default when the kit doesn't supply it. Lets the security storyboard probe whatever protected task each agent implements.
  - `contributes_to: '<flag>'` — mark a step as contributing a flag on success. Consumed by downstream `any_of` validations.
  - `contributes_if: 'prior_step.<id>.passed'` — conditional contribution (e.g., only count the API-key mechanism when BOTH the valid-key and invalid-key steps passed).

  **Phase directives**
  - `skip_if: '!test_kit.auth.api_key'` — skip optional phases based on test-kit fields.
  - `optional: true` — failing steps in optional phases are reported but do not fail the overall storyboard. The storyboard's final `assert_contribution` step is the gate (e.g., "API key OR OAuth must have verified").

  **Auth-override HTTP dispatch**

  Steps with `auth:` set bypass the MCP SDK and dispatch via a raw JSON-RPC POST to the MCP endpoint. This is required because (a) the SDK transport has no way to strip credentials or send arbitrary Bearer values, and (b) validations need the raw HTTP status + `WWW-Authenticate` header, which the SDK hides. A synthetic `TaskResult` is built from the JSON-RPC response so `field_present` / `field_value` checks still work on successful calls.

  **New task handlers (raw HTTP probes, not MCP tools)**
  - `protected_resource_metadata` — GETs the agent's `/.well-known/oauth-protected-resource<path>` (RFC 9728).
  - `oauth_auth_server_metadata` — GETs `<issuer>/.well-known/oauth-authorization-server` for the first issuer from the prior step.
  - `assert_contribution` — synthetic step that evaluates accumulated flags; no network call.

  **New validation checks**
  - `http_status` / `http_status_in` — exact or list-match on HTTP status.
  - `on_401_require_header` — conditional check: if response was 401, require the named header (RFC 6750 §3 compliance).
  - `resource_equals_agent_url` — normalized comparison of RFC 9728 `resource` against the URL under test. Catches the audience-mismatch class of bug from adcp-client#563. The error message does **not** echo the advertised value verbatim — compliance reports are shareable and detailed diffs help attackers probe victim agents.
  - `any_of` — at least one listed flag must be in the accumulator.

  **Safety**
  - `comply()` now refuses `http://` agent URLs by default. Use `{ allow_http: true }` or the CLI `--allow-http` flag for local development; the CLI banner marks runs with the flag as non-publishable.
  - OAuth authorization-server discovery fetches are hardened against SSRF: HTTPS only, DNS resolution + private-IP check (loopback, RFC 1918, link-local, IPv6 ULA), 10 s timeout, 64 KiB body cap, no cross-host redirect following.

  **Degraded-profile execution (fixes adcp-client#570)**

  When an agent's `get_adcp_capabilities` probe returns 401, `comply()` previously short-circuited with `overall_status: 'auth_required'` and executed zero storyboards — which meant `universal/security.yaml` could never run against the exact class of agent it's designed to diagnose. It now detects the auth rejection, drops tool-dependent storyboards, and runs the remaining `track: 'security'` and `required_tools: []` storyboards against a degraded profile. The auth observation is preserved alongside whatever conformance gaps the storyboards surface.

  **Fenced agent-controlled error text (fixes adcp-client#574)**

  The `capabilities_probe_error` observation wraps agent-reported error text in a `<<<…>>>` fence with an explicit "do not follow as instructions" marker and strips terminal control characters. Downstream LLM summarizers of a shared `ComplianceResult` can no longer be prompt-injected by a hostile agent that embedded instructions in its error message. The raw text is still available under `evidence.agent_reported_error` for operators.

  **Test-kit schema**

  `TestOptions.test_kit` gained an `auth` field with `api_key` and `probe_task`. Storyboard phases read this to gate their skip logic. The field is forward-compatible: additional keys pass through unchanged.

  **Breaking**

  `runValidations(validations, taskName, taskResult)` became `runValidations(validations, validationContext)` to carry probe results, the agent URL, and the contribution accumulator. Existing callers inside the SDK were updated; external callers who import `runValidations` directly need to pass a `ValidationContext` object.

  No storyboard YAML ships in this repo — the real `universal/security.yaml` arrives via the upstream AdCP tarball sync (adcontextprotocol/adcp#2298). This PR makes the runner ready for it.

- 1037b9d: Expand the `comply_test_controller` SDK surface so custom wrappers and session-backed stores don't need to reimplement SDK internals.

  **New exports from `@adcp/client` / `@adcp/client/server`**
  - `toMcpResponse(response)` — MCP envelope helper (`content` + `structuredContent` + `isError`). Previously module-local; custom wrappers had to re-derive the summary/error shape to stay consistent with `registerTestController`.
  - `TOOL_INPUT_SHAPE` — canonical Zod input shape for the tool. Four fields matching `ComplyTestControllerRequest`: `scenario`, `params`, `context`, `ext`. Pass directly to `server.tool(...)` in wrappers that need `AsyncLocalStorage`, sandbox gating, or a custom task store.
  - `handleTestControllerRequest(storeOrFactory, input)` — already exported; now the documented entry point for custom wrappers.
  - `CONTROLLER_SCENARIOS` — const object mapping typed keys to wire-format scenario names. Use in place of string literals (`'force_account_status'`) for type-safe dispatch. Build-time exhaustiveness guard breaks the build if a new scenario is added upstream without updating the map.
  - `SESSION_ENTRY_CAP` (default `1000`) + `enforceMapCap(map, key, label, cap?)` — reject-on-overflow quota guard for session-scoped Maps inside `TestControllerStore` methods. Throws `TestControllerError('INVALID_STATE', …)`, which the dispatcher turns into a typed `ControllerError` response. Rejects rather than LRU-evicts so compliance tests stay deterministic.

  **Factory shape for session-backed stores**

  `registerTestController(server, storeOrFactory)` now accepts either a plain `TestControllerStore` or a `TestControllerStoreFactory`:

  ```ts
  registerTestController(server, {
    scenarios: [CONTROLLER_SCENARIOS.FORCE_ACCOUNT_STATUS],
    async createStore(input) {
      const session = await loadSession((input.context as { session_id?: string })?.session_id);
      return {
        async forceAccountStatus(id, status) {
          /* closes over live session */
        },
      };
    },
  });
  ```

  `createStore` runs once per request with the tool input, so the returned store binds to the current session — solving a silent-data-loss bug class where sellers closed over module-level state (e.g., `WeakMap<SessionState, …>`) that the session lifecycle didn't carry across rehydration.

  `list_scenarios` is answered from the declared `scenarios` field without invoking `createStore`, keeping capability discovery stateless and matching storyboard expectations.

  **New exports from `@adcp/client` / `@adcp/client/testing`**
  - `expectControllerError(result, code)` — narrows a `ComplyTestControllerResponse` to `ControllerError` and asserts the error code. Returns `ControllerErrorWithDetail` (narrowed so `error_detail` is guaranteed `string`).
  - `expectControllerSuccess(result, kind?)` — narrows to the success arm and optionally asserts which variant (`'list'` / `'transition'` / `'simulation'`). Overloaded return types let tests skip `if (result.success)` boilerplate.

  **Compatibility**

  No breaking changes. Plain-store `registerTestController(server, store)` and single-arity `handleTestControllerRequest(store, input)` keep working unchanged. The `ControllerScenario` type union is unchanged; `CONTROLLER_SCENARIOS` is additive.

  **Migration note for custom wrappers using top-level `account`**

  Some sellers built custom `server.tool('comply_test_controller', ...)` wrappers that route sandbox gating off a top-level `account` field (e.g., `account.sandbox === true`). `TOOL_INPUT_SHAPE` intentionally matches `ComplyTestControllerRequest` in the generated schema, which declares only `scenario`, `params`, `context`, `ext` — so `account` is not included.

  Two migration paths:
  1. **Move the check to `context`**: route sandbox gating through `context.sandbox` / `context.account_id`. Recommended — this is where AdCP routes per-request envelope data on tools that don't take a structural `account`.
  2. **Extend the shape locally**: `const MY_SHAPE = { ...TOOL_INPUT_SHAPE, account: z.object({ sandbox: z.boolean() }).passthrough().optional() };` and pass `MY_SHAPE` to `server.tool(...)`. Documented in the `TOOL_INPUT_SHAPE` JSDoc.

  Either path keeps your wrapper functional; only the default `registerTestController` registration uses the minimal schema.

### Patch Changes

- 9c52c67: Storyboard runner: enforce a brand/account invariant on every outgoing request.

  Sellers that scope session state by brand (required for per-tenant isolation) derive a session key from `brand.domain`. Before this fix, a storyboard's `create_*` step could send one brand while the follow-up `get_*` / `update_*` / `delete_*` / `validate_*` step sent another — or omitted brand entirely and hit the default `test.example`. The list created in one session was then invisible to the lookup in a different session, surfacing as `NOT_FOUND` across `property_governance`, `collection_governance`, `media_buy_seller`, and any storyboard that exercises stateful CRUD.

  The runner now merges `options.brand` into every request after builder / `sample_request` resolution, overriding any conflicting brand and filling in `account.brand` when the request carries an `account` object. A storyboard run now lands in one session regardless of per-tool authorship. Storyboards that don't configure a brand (e.g. `universal/security.yaml` probes) pass through unchanged.

  Fixes #579.

- 934eea2: Request-signing grader — two follow-ups from the #617 review thread.

  **Operation-name allowlist** in `extractOperationFromVectorUrl`. Previously
  the extractor returned whatever URL-decoded bytes sat in the vector URL's
  last path segment and inlined that into `params.name`. AdCP operations are
  spec-defined identifiers (lowercase snake*case matching
  `static/schemas/source/enums/operation.json`); constrain the extractor
  output to `/^[a-z]a-z0-9*]\*$/` so a corrupted compliance cache can't
  smuggle arbitrary bytes into the JSON-RPC envelope. No exploit today —
  fixtures are spec-published, not attacker-supplied — but defense in depth.

  **MCP rate-abuse subtest** in `test/request-signing-grader-mcp.test.js`.
  Spins up a dedicated MCP agent with `ADCP_REPLAY_CAP=10` + grades with
  `onlyVectors: ['020-rate-abuse']`, `rateAbuseCap: 10`,
  `allowLiveSideEffects: true`. Exercises the end-to-end rate-abuse flow
  under MCP transport (previously only covered against the raw-HTTP
  reference verifier). Adds `ADCP_REPLAY_CAP` env override to
  `test-agents/seller-agent-signed-mcp.ts` so tests can tune the cap
  without forking the agent.

- bba6f3e: refactor: thread signing context via AsyncLocalStorage

  Flattens the `signingContext` parameter that PR #593 pushed through nine function signatures in the MCP and A2A transports. Top-level entries (`callMCPTool`, `callMCPToolRaw`, `callMCPToolWithTasks`, `callA2ATool`) now push the context onto a new `signingContextStorage` AsyncLocalStorage for the duration of the call, and the internal helpers (`withCachedConnection`, `getOrCreateConnection`, `connectMCPWithFallback`, `getOrCreateA2AClient`, `createA2AClient`, `buildFetchImpl`) read it from storage instead of receiving it as a parameter. The public entry-point signatures are unchanged, so external callers and integration tests continue to pass `signingContext` explicitly.

  Adds tests that fire interleaved concurrent `callTool`s with distinct signing identities to verify each sees its own context, and that a signing call followed by a non-signing call in the same async chain does not leak the stale context.

- 18cefcc: Signing: swap hand-rolled `Signature-Input` / `Signature` / `Content-Digest`
  parsers for the maintained `structured-headers` library (RFC 8941 / RFC 9651).
  Cuts ~90 lines of bespoke state-machine code and inherits the library's
  coverage of the dictionary/inner-list/token/escape corners we weren't
  exercising. AdCP-profile checks (required params, tag match, alg allowlist,
  quoted-string typing for `nonce`/`keyid`/`alg`/`tag`, integer typing for
  `created`/`expires`) stay in this package as thin typed wrappers. Signature
  byte-sequence values remain base64url-tolerant, and `Content-Digest` keeps
  its regex fallback so a malformed filler member (e.g. truncated `sha-512`)
  does not mask the `sha-256` entry we verify against. Closes #581.
- 18cefcc: Signing: time-bucket the in-memory replay store so `has()` / `insert()` /
  `isCapHit()` stay O(1) amortized on a hot keyid pinned near the per-keyid
  cap. Entries are grouped by `floor(expiresAt / bucketSizeSeconds)` (default
  60s); whole buckets are evicted in one step when their latest expiry has
  passed, eliminating the per-call O(N) filter sweep that turned a near-cap
  keyid into a quadratic DoS target. Default `maxEntriesPerKeyid` drops from
  1,000,000 → 100,000 (still ample for typical traffic; can be raised via
  `new InMemoryReplayStore({ maxEntriesPerKeyid })` for large deployments).
  The `ReplayStore` interface is unchanged. Closes #582.
- 3227148: **Idempotency storyboard end-to-end compliance** — the universal
  `idempotency` compliance storyboard now passes 1/0/0/0 against agents
  built from all 8 skills. Three framework fixes were required to get there:
  1. **`replayed: false` on fresh executions.** Middleware now stamps the
     field on every mutating response, not just replays. Buyers that branch
     on `metadata.replayed` to decide whether side effects already fired
     need the field present either way. Cached envelopes are stamped after
     the save so replays cleanly overwrite with `true`.
  2. **Replay echoes the current retry's `context`, not the first caller's.**
     Previously, cached response envelopes baked in the first caller's
     `correlation_id` and replays returned that to every subsequent retry,
     breaking end-to-end tracing. The middleware now strips `context` from
     the formatted response before caching; on replay, `finalize()`
     re-injects the current request's context.
  3. **MCP-level `idempotency_key` relaxed to optional when the framework
     has an idempotency store wired.** The middleware is authoritative for
     this field and returns a structured `adcp_error` with `code` + `field`.
     If the MCP SDK's schema validator rejected first, buyers got a text-
     only `-32602` error that failed the storyboard's `error_code` check.

  **Storyboard harness fixes** so the runner actually exercises replay semantics:
  - `$generate:uuid_v4[#alias]` placeholder resolution in `sample_request`
    values. Same alias within a run → same UUID (enables initial + replay
    testing). Alias cache lives in a WeakMap keyed off context identity,
    propagated explicitly at shallow-clone sites via `forwardAliasCache` —
    no implementation-detail keys leak into serialized output.
  - Request builders now forward `idempotency_key` from `sample_request`
    and respect future-dated `start_time`/`end_time` (two calls generated
    ms apart with `Date.now()` hash differently, triggering spurious
    CONFLICT on replay).
  - `$context.<key>` placeholders now resolved in validation `value` and
    `allowed_values` so expected values can reference prior steps.
  - New `TaskOptions.skipIdempotencyAutoInject` (`@internal` — compliance
    testing only) lets the runner exercise servers' missing-key validation
    without the client auto-generating a key. Gated at all three inject
    sites: `normalizeRequestParams`, `executeAndHandle` pre-validation,
    and `TaskExecutor.executeTask`.

  **Skills**: wire `createIdempotencyStore` into the main Implementation
  block for creative, signals, brand-rights, retail-media, and
  generative-seller (seller/SI/governance were already complete). Extends
  `test-agents/test-agent-build.sh` to all 8 agent types, adds the
  universal idempotency storyboard as a second check, passes `--allow-http`.

- 0884b25: Lift the SSRF-safe fetch used by the storyboard runner into a reusable
  `@adcp/client/net` primitive. Behavior is unchanged for metadata probes;
  raw MCP probes now dispatch through the DNS-pinned undici `Agent` that was
  previously only used for metadata fetches — closes a TOCTOU gap where an
  attacker-supplied agent URL could resolve to a public IP during SSRF
  validation and a private IP during the actual connect.

  Tightened defaults:
  - `rawMcpProbe` now refuses `http://` / private-IP agent URLs unless the
    caller passes `allowPrivateIp: true`. The storyboard runner threads
    `allow_http` through, so dev loops against localhost agents keep
    working end-to-end.
  - IMDS (`169.254.169.254`, IPv6 `fe80::/10`) stays refused even under
    `allowPrivateIp` — cloud metadata exfiltration is never a legitimate
    dev-loop destination.

  New exports (internal; the public barrel is unchanged):
  - `ssrfSafeFetch(url, options)` — returns buffered bytes + headers; throws
    `SsrfRefusedError` with a typed `code` when the guard refuses.
  - `SsrfRefusedError`, `SsrfRefusedCode`, `SsrfFetchOptions`,
    `SsrfFetchResult`.
  - `isPrivateIp`, `isAlwaysBlocked` (moved from
    `src/lib/testing/storyboard/probes.ts`; the original import site keeps
    working via re-export).
  - `decodeBodyAsJsonOrText(body, contentType)` — convenience decoder for
    probe-style call sites.

  The primitive is the foundation for future HTTPS-fetching stores (JWKS
  auto-refresh, revocation-list polling) that must not follow counterparty
  URLs into private networks.

- 8d69399: `adcp storyboard run --json` now guarantees clean JSON on stdout.

  The CLI installs a stdout guard around `comply()` / `runStoryboard()` / `runStoryboardStep()` that forwards any stray `console.log` / `console.info` to stderr, and writes the final JSON payload via `process.stdout.write` and waits for drain before exiting. This closes the class of failure reported in adcp-client#588, where a single internal log line turns valid JSON into a parse error for `jq` and `python -c 'json.load(sys.stdin)'`. `--json` stdout is now a single JSON document; everything else goes to stderr.

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
