# Cross-cutting rules for every build-*-agent skill

Every `build-*-agent` skill points here. These rules apply regardless of which specialism you're building. The hello-adapter fork targets in `examples/hello_*_adapter_*.ts` wire all of them — read this section once if you're forking, every time if you're building from scratch.

## `idempotency_key` is required on every mutating call

Every mutating tool requires a client-supplied `idempotency_key`. The full list (authoritative — taken from `MUTATING_TASKS` in the SDK):

`create_media_buy`, `update_media_buy`, `sync_accounts`, `sync_creatives`, `sync_audiences`, `sync_catalogs`, `sync_event_sources`, `sync_plans`, `sync_governance`, `provide_performance_feedback`, `acquire_rights`, `activate_signal`, `log_event`, `report_usage`, `report_plan_outcome`, `create_property_list`, `update_property_list`, `delete_property_list`, `create_collection_list`, `update_collection_list`, `delete_collection_list`, `create_content_standards`, `update_content_standards`, `calibrate_content`, `si_initiate_session`, `si_send_message`.

Wire `createIdempotencyStore({ ... })` once and pass it to `createAdcpServerFromPlatform(platform, { idempotency })`. The framework handles replay detection, payload-hash conflict (`IDEMPOTENCY_CONFLICT`), expiry (`IDEMPOTENCY_EXPIRED`), and in-flight parallelism. Don't reimplement in handlers.

Handlers must return the same response when the same key is replayed.

## Resolve-then-authorize — uniform errors for not-found / not-yours

The AdCP spec § error-handling MUSTs **byte-equivalent responses** for "id exists but caller lacks access" vs "id does not exist." Same error code (`REFERENCE_NOT_FOUND` or domain-specific `*_NOT_FOUND`), same message, same headers, same latency. Distinguishing them leaks cross-tenant existence information — an attacker who learns that `mb_0x1234` returns `PERMISSION_DENIED` while `mb_0xabcd` returns `REFERENCE_NOT_FOUND` can enumerate every live id across every tenant you host.

The rule applies to every observable channel: `error.code` / `message` / `field` / `details`, HTTP status, A2A `task.status.state`, MCP `isError`, response headers (`ETag`, `Cache-Control`, rate-limit, CDN tags), webhook/audit dispatch, logs with tenant correlation. Same work on both paths — don't short-circuit on "id format invalid" with a faster path; an attacker will measure latency.

How to get it right:

- Both paths return `REFERENCE_NOT_FOUND` (or the domain-specific `*_NOT_FOUND`). Never `PERMISSION_DENIED` or `FORBIDDEN` on an id lookup.
- Don't echo the probed id in `error.details` — or echo it in both paths identically.
- Route both paths through the same response constructor so headers are set identically.

`adcp fuzz` runs a paired-probe invariant that enforces this automatically. Pass `--auth-token` + `--auth-token-cross-tenant` for full coverage. See [`VALIDATE-YOUR-AGENT.md` § Uniform-error-response invariant](../docs/guides/VALIDATE-YOUR-AGENT.md#uniform-error-response-invariant-paired-probe).

## Authentication is mandatory

An agent that accepts unauthenticated requests is non-compliant — the universal `security_baseline` storyboard fails it. Wire `serve({ authenticate })` with `verifyApiKey`, `verifyBearer`, or `anyOf(...)` from `@adcp/sdk/server` before you claim any specialism.

## Don't break when RFC 9421 Signature headers arrive

Even if you don't claim `signed-requests`, a buyer may send `Signature-Input` / `Signature` headers. Your transport must pass through without rejecting. If you do claim the specialism, verify per the signed-requests delta in your skill.

## `ctx_metadata` is not for credentials

The wire-strip protects buyer responses but **does not** protect server-side log lines, error envelopes, heap dumps, or adopter-generated strings. Re-derive bearers per request from `ctx.authInfo` + your token cache; embed only non-secret upstream IDs in `ctx_metadata`.

Full rationale: [`docs/guides/CTX-METADATA-SAFETY.md`](../docs/guides/CTX-METADATA-SAFETY.md).

## Account resolution: pick a security preset

The hello adapters use simple in-memory `accounts.resolution: 'lookup'` against a known map. Production adopters pick one of the four `AccountStore` presets:

- `createOAuthPassthroughResolver` — buyer-OAuth-passes-through (Shape B)
- `createRosterAccountStore` — pre-loaded roster (Shape C)
- `createDerivedAccountStore` — single-tenant `'derived'` mode (Shape D)
- `createTenantStore` — multi-tenant with built-in isolation gate

`createTenantStore` is the right default for any adopter handling more than one advertiser. It refuses inline `{account_id}` references unless your store explicitly lists them — that's a hard security gate, not a soft warning.

## Webhooks: stable `operation_id` across retries

Async tasks (creative review, IO approval, signal activation, plan outcome reporting) emit completion webhooks. Use `ctx.emitWebhook({ url, payload, operation_id })` — the framework handles RFC 9421 signing, stable `idempotency_key` across retries, backoff, terminal-error handling. Pass `webhooks: { signerKey }` to `createAdcpServerFromPlatform(platform, { webhooks })`.

`operation_id` rules — this is the top at-least-once-delivery bug:

- Stable across retries. `creative_review.${creative_id}` or `report_usage.${report_batch_id}`, **not** a fresh UUID per retry.
- Unique per logical event. Two completions for the same creative_id with different review outcomes are two events with two operation_ids.

## Spec reference

For exact response shapes, error codes, optional fields, and discriminated unions: `docs/llms.txt` (single-fetch full protocol overview) or `schemas/cache/3.0.5/bundled/<protocol>/`. Don't read the generated TypeScript types — they exist for compile-time enforcement, not for teaching you the shape.
