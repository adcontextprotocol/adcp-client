---
'@adcp/client': minor
---

SDK ergonomics fixes addressing feedback on 5.15.0.

**Root re-exports.** The `Success` / `Error` / `Submitted` arms of every `*Response` discriminated union now export from the `@adcp/client` root (previously only the full `*Response` unions did). `AdcpServer` handler returns no longer need `as any` to narrow off the union. Covered arms include `SyncCreativesSuccess`, `SyncAudiencesSuccess`, `CreateMediaBuy{Success,Error,Submitted}`, `UpdateMediaBuy{Success,Error}`, `BuildCreative{Success,MultiSuccess,Error}`, `ActivateSignal{Success,Error}`, `ProvidePerformanceFeedback{Success,Error}`, `SyncEventSources{Success,Error}`, `LogEvent{Success,Error}`, `SyncAccounts{Success,Error}`, `SyncGovernance{Success,Error}`, `UpdateContentStandards{Success,Error}`, `SyncAudiences{Success,Error}`, and `SyncCreatives{Success,Error,Submitted}`.

**Idempotency store dual-export.** `createIdempotencyStore`, `memoryBackend`, `pgBackend`, `getIdempotencyMigration`, `IDEMPOTENCY_MIGRATION`, `cleanupExpiredIdempotency`, `hashPayload`, plus `IdempotencyStore` / `IdempotencyStoreConfig` / `IdempotencyBackend` / `IdempotencyCacheEntry` / `IdempotencyCheckResult` / `MemoryBackendOptions` / `PgBackendOptions` now re-export from the `@adcp/client` root (previously only `@adcp/client/server`), matching the dual-export treatment of `createAdcpServer`.

**Widened handler return types + response-union narrowing.** `DomainHandler<K>` now accepts `Promise<AdcpToolMap[K]['result'] | AdcpToolMap[K]['response'] | McpToolResponse>`. Adapter-style handlers that return `Result<CreateMediaBuyResponse, ...>` where `CreateMediaBuyResponse = Success | Error | Submitted` type-check without `as any`. The dispatcher narrows at runtime:

- `status === 'submitted' && typeof task_id === 'string'` → Submitted envelope. Framework wraps without the Success-builder defaults (`revision`, `confirmed_at`, `valid_actions`) so async-task shapes round-trip correctly.
- `errors: Error[]` with no Success-arm fields → Error arm. Framework wraps as `{ isError: true, structuredContent: { errors: [...] } }`, preserving the typed-union shape the spec defines.
- Otherwise → Success arm, response builder applies as before.

`AdcpToolMap` entries gained a `response` field (full union) alongside the existing `result` (narrow Success). Handlers and response builders continue to type-check against `result`; callers that want the permissive shape reach for `response`.

**`extractResult(toolCallResult)` helper.** New lightweight companion to `unwrapProtocolResponse` — prefers `structuredContent`, falls back to JSON-parsing `content[0].text`, returns `undefined` otherwise. Use it on the client side of `mcpClient.callTool(...)` instead of writing the extraction by hand. `unwrapProtocolResponse` remains available when you also want schema validation and extraction-path provenance.

**`VALIDATION_ERROR.issues` surfaced at top level.** Strict-mode validation errors now expose `adcp_error.issues` (RFC 6901 pointer list) at the top level of the envelope so operators see it on the first render. The same list is still mirrored at `adcp_error.details.issues` for buyers that index into `details` per AdCP spec convention — existing `details.issues` readers continue to work, no migration required. `adcp_error.details` also gains the `{ tool, side }` metadata. `schemaPath` gating is unchanged: stripped when `exposeErrorDetails` is off; request-side and response-side now thread the same `exposeSchemaPath` policy (previously request-side stripped schemaPath even in dev).

Handlers that return a tool's *Error arm with spec-violating items (missing `code` or `message`) get a dev-log warning at dispatch — the envelope still ships unchanged, matching the handler's intent, but drift is surfaced in logs.
