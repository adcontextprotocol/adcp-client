# Add AdCP to an existing application

This is the thin integration path for an application that already owns authentication, transactions, and durable storage. It adds one public SDK client and one task without replacing those boundaries. The compiling source is [`examples/existing-platform-thin.ts`](../../examples/existing-platform-thin.ts).

## Ownership boundaries

| Concern | Owner | Production note |
| --- | --- | --- |
| MCP/A2A transport, version adaptation, request validation, task status normalization | SDK | Uses the official protocol clients. |
| User authentication, tenant selection, seller-account authorization | Application | Derive these before calling the SDK; never put credentials in `ctx_metadata`. |
| Business transaction and task-handle storage | Application contract | Persist serializable `metadata.taskId`, `metadata.serverTaskId`, status, and any idempotency key before leaving the request. Never serialize continuation closures. |
| Conversation and webhook registration defaults | SDK process memory | Install the documented durable adapters before horizontal scaling or restart-sensitive use. |
| Submitted-task polling and callback verification | Shared | The SDK performs protocol work; the application supplies cancellation, durable recovery, and current authorization before replay. |

The example accepts an already authenticated request context, rechecks tenant/account authorization before starting a submitted-task poll, calls `list_products`, records the initial mixed-status result in the application's transaction, and records terminal settlement after polling. Its store also implements `WebhookRegistrationStore` and idempotent `recordWebhookSettlement`, so verified callbacks can resolve the persisted operation to its tenant, re-authorize, and save completion after a restart. It imports only from `@adcp/sdk`, uses no private `dist/` path, and does not enable the optional schema subpath.

## Migrate targeting adapters without casts

AdCP 3.2 mutation targeting is a command shape, while accepted provider state
and response readback are strict state shapes. The packed, compile-gated
[`targeting-input-existing-platform.ts`](../../examples/targeting-input-existing-platform.ts)
example derives its input types from the public `BuyProductsRequest` and
`ControlMediaBuyRequest` exports and uses only public projection helpers.

| Request state | Adapter action | Accepted/readback state |
| --- | --- | --- |
| Dimension omitted | Create: preserve the product/provider default. Update: make no provider call and retain stored state. | Existing strict value remains; no command is stored. |
| Dimension `null` | Verify that the product and provider support clearing, then send the provider's explicit clear/replacement operation. | The dimension is absent. Never echo `null`. |
| Dimension has a value | Translate and replace the complete provider dimension. | Persist and return the validated value. |

Translate the original request into provider set/clear operations first; do not
drop `null` before the provider executes the clear. On create, start from the
selected product's strict configured/default targeting and call
`applyTargetingInput()` so omitted dimensions are materialized, cleared defaults
are removed, and supplied dimensions replace them. On update, load the prior
strict state and apply the same helper. Commit only that complete strict result.
`resolveTargetingInput()` removes request commands but cannot materialize create
defaults on its own. If the provider succeeds but the local commit fails,
reconcile through the application's existing transaction or outbox boundary.
The outer `control_media_buy` handler must also serialize or CAS the whole
read-provider-save block using the request revision so concurrent patches cannot
lose an accepted dimension. The example's provider seam assumes exact, atomic
application: an adapter whose provider normalizes values should return its
canonical post-mutation readback and persist that instead of the request value.

The example deliberately throws `UnsupportedTargetingClearError` before any
provider call or durable write. Do not cast the request to a strict overlay,
drop `null` keys before the provider has executed the clear, or persist the
request object unchanged. Provider adapters should also reject targeting
dimensions they do not translate instead of silently discarding them.

Configure the callback as an absolute template containing both trusted route macros, for example `https://buyer.example/adcp/webhook/{task_type}/{operation_id}`. Supply a framework adapter that derives the public URL only from server-owned configuration, and mount raw-body parsing on the matching route:

```ts
app.post(
  '/adcp/webhook/:task_type/:operation_id',
  express.raw({ type: 'application/json' }),
  integration.createWebhookHandler({
    getRequestUrl: req => `https://buyer.example${req.originalUrl}`,
  })
);
```

Do not derive the external URL from untrusted `Host` or forwarding headers. The durable registration store proves which callback was registered; the status handler is what commits the verified settlement into application storage.

The submitted continuation's `waitForCompletion` function is deliberately process-local. Persist its identifiers for reconciliation, and use the durable callback registration path for completion after a restart. PostgreSQL and Redis adapters are available when the application store does not implement `WebhookRegistrationStore` directly; see [Push notification configuration](./PUSH-NOTIFICATION-CONFIG.md).

## Cancellation and errors

| Path | Bound | Cancellation outcome | Remote/protocol failure |
| --- | --- | --- | --- |
| Client task | `TaskOptions.timeout` is one absolute task deadline; `signal` is caller cancellation | Throws the abort/timeout error | Returns `TaskResult` with `success: false` and structured `adcpError` |
| `validateAdAgents` | `signal` spans the whole discovery; `timeoutMs` bounds each fetch | Throws the signal's abort reason and starts no later fallback | Returns `valid: false` with discovery errors |
| Submitted wait | `waitForCompletion(interval, signal)` | Stops polling; A2A cancellation is a best-effort protocol courtesy | Returns the latest/terminal `TaskResult` |
| Transport observer | Operational responses return immediately. Only finite declared text bodies at or below 64 KiB are cloned and captured asynchronously, with a 1 s capture ceiling; skipped bodies emit `responseBodyTruncated: true` | Never consumes or delays the operational response stream | Observer rejection is isolated from protocol behavior |

Do not catch every outcome into a string. Switch on `result.status`; use `result.adcpError` for failed results, and catch thrown cancellation/configuration errors separately. Internal transport retries reuse an idempotency key. A new application intent must receive a new key; after an ambiguous timeout, reconcile by the persisted natural key before deciding to retry.

Transport diagnostics never delay delivery of the operational `Response`.
SSE, non-text, missing/invalid-length, and over-limit bodies are not cloned;
their single response event is emitted immediately with
`responseBodyTruncated: true`. A finite declared text body at or below 64 KiB
is cloned synchronously and captured in the background for at most
`BODY_SNIPPET_TIMEOUT_MS` (currently 1 second). Its single response event is
emitted when capture completes or expires, while the original response stream
remains exclusively available to the protocol client. The enclosing task then
waits within `OBSERVER_FLUSH_TIMEOUT_MS` for that event's asynchronous
observer, so short-lived processes do not lose the final audit record. Observer
failures remain isolated. Applications should synchronously enqueue each event into their own
bounded in-memory or durable queue and return promptly; flushing that queue is
an application lifecycle concern.

## Reuse scoped capability evidence

An application factory that already performs a bounded seller preflight can
construct and prime the specific client instance before exposing it for task
dispatch:

```ts
let agent: AgentClient;
try {
  agent = await AgentClient.createWithCapabilityPreflight(
    agentConfig,
    async ({ client, scope }) => ({
      ...(await tenantScopedCapabilityPreflight(client, scope, signal)),
      scope,
    }),
    clientOptions,
  );
} catch (error) {
  if (!(error instanceof CapabilityPreflightError)) throw error;
  agent = new AgentClient(agentConfig, clientOptions);
  await agent.getCapabilities({ signal }); // safe cold-discovery fallback
}
```

The callback receives the exact instance the factory returns. The factory
primes it before any caller can dispatch a task. Refusal throws a typed
`CapabilityPreflightError`: `scoped_transport`, `scope_rotated`, or
`invalid_evidence`. The compiling
`examples/existing-platform-thin.ts` factory demonstrates a cold-discovery
fallback without removing a scoped transport. The scope binds evidence to the normalized
endpoint, configured AdCP release, and this immutable client's
authorization/transport instance; preserve the seller's normalized
`capabilities.servedVersion` when the preflight supplies it. Use one client per
authorization context. Include `toolSchemas` when the preflight observed MCP
`tools/list`; compatibility projection augments and uses the same tool
evidence. A constructor-level scoped fetch refuses priming with
`code: 'scoped_transport'`; keep that fetch and construct normally so
discovery runs within its narrower transport scope. A per-call
`trustedFetchFn` likewise bypasses primed state.

For an already-constructed client, the lower-level
`getCapabilityEvidenceScope()` plus `primeCapabilities()` pair remains
available. Expired, malformed, endpoint-mismatched, release-mismatched, or
differently scoped evidence is refused, clears older cached state, and leaves
discovery cold; `refreshCapabilities()` rotates the scope so older snapshots
cannot be reinstalled.

This is same-instance preflight reuse, not a durable cache identity. The opaque
`scopeKey` is created per client instance and is intentionally not reconstructable
from endpoint, credentials, or version. After a process restart, a snapshot
persisted by the old client is refused by the new client even when its timestamps
are still fresh. Do not attach the new scope to that old observation. Construct
the replacement client first, obtain its scope, and either perform a fresh
tenant-scoped preflight for that scope or let `getCapabilities()` discover cold:

```ts
const replacement = await AgentClient.createWithCapabilityPreflight(
  {
    id: 'seller',
    name: 'Seller',
    agent_uri: sellerUrl,
    protocol: 'mcp',
    auth_token: requestScopedAuthToken,
  },
  async ({ client, scope }) => ({
    ...(await tenantScopedCapabilityPreflight(client, scope, signal)),
    scope,
  }),
  clientOptions,
);
```

An application-owned persisted discovery cache may still accelerate the
application's own preflight logic, but it cannot currently be installed across
SDK client instances. Retain a process-local client when same-instance reuse is
required; otherwise budget for fresh discovery after reconstruction.

For durable webhook and reporting flows, continue with [Push notification configuration](./PUSH-NOTIFICATION-CONFIG.md) and the [Reporting ledger](./REPORTING-LEDGER.md).
