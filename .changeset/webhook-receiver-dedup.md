---
'@adcp/client': minor
---

Webhook receiver-side deduplication via `AsyncHandlerConfig.webhookDedup`.

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
