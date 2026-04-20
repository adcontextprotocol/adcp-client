---
'@adcp/client': minor
---

Rollup 5.2.0 — bundles the work that went into the unpublished 6.0.0. Treat the
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
