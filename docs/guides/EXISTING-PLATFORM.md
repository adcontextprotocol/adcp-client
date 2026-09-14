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
| Transport observer | Body preview is bounded to 1 s; async observer flush is bounded to 5 s | Never becomes an unbounded request dependency | Observer rejection is isolated from protocol behavior |

Do not catch every outcome into a string. Switch on `result.status`; use `result.adcpError` for failed results, and catch thrown cancellation/configuration errors separately. Internal transport retries reuse an idempotency key. A new application intent must receive a new key; after an ambiguous timeout, reconcile by the persisted natural key before deciding to retry.

## Reuse scoped capability evidence

An application that already performs a bounded seller preflight can prime the specific client instance instead of triggering another probe:

```ts
const scope = agent.getCapabilityEvidenceScope();
const observed = await tenantScopedCapabilityPreflight(scope, signal);

const reused = agent.primeCapabilities({
  scope,
  capabilities: observed.capabilities,
  toolSchemas: observed.toolSchemas,
  observedAt: observed.observedAt,
  expiresAt: observed.expiresAt,
});
if (!reused) await agent.getCapabilities({ signal }); // rejected evidence cleared older cached state
```

The compiling example's `reuseCapabilityEvidence` method contains this flow without an undefined helper. The scope binds evidence to the normalized endpoint, configured AdCP release, and this immutable client's authorization/transport instance; preserve the seller's normalized `capabilities.servedVersion` when the preflight supplies it. Use one client per authorization context. Expired, malformed, endpoint-mismatched, release-mismatched, or differently scoped evidence is refused, clears older cached state, and leaves discovery cold; `refreshCapabilities()` rotates the scope so older snapshots cannot be reinstalled. Include `toolSchemas` when the preflight observed MCP `tools/list`; compatibility projection augments and uses the same tool evidence. A constructor-level scoped fetch refuses priming, and a per-call `trustedFetchFn` bypasses primed state, because either fetch defines a narrower transport scope.

For durable webhook and reporting flows, continue with [Push notification configuration](./PUSH-NOTIFICATION-CONFIG.md) and the [Reporting ledger](./REPORTING-LEDGER.md).
