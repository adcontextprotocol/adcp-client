# Push Notification Config

Push notification config tells the AdCP agent where to send async task status updates via webhook. It is automatically injected by the client at the transport layer — you do not set it per-request.

## How It Works

When you configure a `webhookUrlTemplate`, every outgoing tool call (`create_media_buy`, `update_media_buy`, `sync_creatives`, etc.) can include a `push_notification_config`. The URL is generated per operation. Omitting `webhookSecret` selects the current RFC 9421 signature profile; setting it explicitly selects legacy HMAC-SHA256.

## Client Setup

```typescript
const client = new AdCPClient({
  webhookUrlTemplate: 'https://your-app.com/adcp/webhook/{task_type}/{agent_id}/{operation_id}',
});
```

## Wire Payload

The default RFC 9421 registration has no `authentication` block:

```json
{
  "push_notification_config": {
    "url": "https://your-app.com/adcp/webhook/create_media_buy/agent_123/cd51e063-2b79-4a6d-afac-ed7789c3a443"
  }
}
```

Setting `webhookSecret` opts into the legacy shape:

```json
{
  "push_notification_config": {
    "url": "https://your-app.com/adcp/webhook/create_media_buy/agent_123/cd51e063-2b79-4a6d-afac-ed7789c3a443",
    "authentication": {
      "schemes": ["HMAC-SHA256"],
      "credentials": "your-hmac-secret-min-32-characters-here"
    }
  }
}
```

## `create_media_buy` — Full Example

`create_media_buy` also includes a separate `reporting_webhook` for ongoing delivery metrics. These are independent:

```json
{
  "name": "create_media_buy",
  "arguments": {
    "buyer_ref": "mb_abc123",
    "start_time": "2026-03-01T00:00:00Z",
    "end_time": "2026-04-01T00:00:00Z",
    "brand_manifest": {
      "url": "https://example.com",
      "name": "Example Brand"
    },
    "packages": [...],
    "reporting_webhook": {
      "url": "https://your-app.com/adcp/webhook/media_buy_delivery/agent_123/delivery_report_agent_123_2026-03",
      "authentication": {
        "schemes": ["HMAC-SHA256"],
        "credentials": "your-hmac-secret-min-32-characters-here"
      },
      "reporting_frequency": "daily",
      "requested_metrics": ["impressions", "spend", "clicks"]
    },
    "push_notification_config": {
      "url": "https://your-app.com/adcp/webhook/create_media_buy/agent_123/cd51e063-2b79-4a6d-afac-ed7789c3a443",
      "authentication": {
        "schemes": ["HMAC-SHA256"],
        "credentials": "your-hmac-secret-min-32-characters-here"
      }
    }
  }
}
```

## `sync_creatives` — Full Example

```json
{
  "name": "sync_creatives",
  "arguments": {
    "creatives": [...],
    "push_notification_config": {
      "url": "https://your-app.com/adcp/webhook/sync_creatives/agent_123/f3a9b2c1-1234-5678-abcd-ef0123456789",
      "authentication": {
        "schemes": ["HMAC-SHA256"],
        "credentials": "your-hmac-secret-min-32-characters-here"
      }
    }
  }
}
```

## `reporting_webhook` vs `push_notification_config`

| | `push_notification_config` | `reporting_webhook` |
|---|---|---|
| Purpose | Task status updates (submitted, complete, failed) | Ongoing campaign delivery metrics |
| Operations | All async operations | `create_media_buy` only |
| Frequency | Per task lifecycle event | Hourly / daily / monthly |
| Set by | Client auto-injects | Client auto-injects |

## Authentication

### RFC 9421 (default)

`SingleAgentClient` records the exact callback URL, seller, protocol, task, and selected authentication mode before dispatch. `verifyAndParseWebhook` then resolves the registered seller's keys through its capabilities → `brand.json` → `agents[].jwks_uri` chain and verifies the RFC 9421 signature, content digest, signature window, revocation, and nonce replay protection.

The receiver must supply exact raw bytes, the trusted route operation ID, HTTP method, and the externally visible absolute URL. Do not derive the public URL from untrusted `Host` or `X-Forwarded-*` headers. Behind a trusted reverse proxy, construct it from server-owned configuration:

```typescript
app.post(
  '/adcp/webhook/:task_type/:agent_id/:operation_id',
  express.raw({ type: 'application/json' }),
  client.createWebhookHandler({
    getRequestUrl: req => `https://your-app.com${req.originalUrl}`,
  }),
);
```

The default registration and replay stores are process-local. Production receivers that can restart or run multiple replicas must inject a shared durable `webhookRegistrationStore` and `webhookVerification.replayStore`; registration writes must be atomic create-or-identical, and replay insertion must be atomic across replicas. Retain registrations for at least the seller retry horizon (seven days by default).

For deterministic tests or infrastructure-managed keys, set `webhookVerification.jwks`. Otherwise seller key discovery is automatic and uses an unauthenticated official protocol client for the capabilities step, so credentials configured for one endpoint are never transplanted to the registered callback origin. Sellers whose capability discovery requires authentication should provide an origin-bound `webhookVerification.fetchCapabilities(agentUrl, protocol)` callback or inject `webhookVerification.jwks` directly.

### Legacy HMAC-SHA256

When `webhookSecret` is configured, the legacy webhook authentication path uses `HMAC-SHA256`. The agent signs `${timestamp}.${raw_body_bytes}` with the shared secret and sends:

- `x-adcp-signature: sha256=<hex digest>`
- `x-adcp-timestamp: <unix seconds>`

HMAC registration provenance never stores the credential or a secret-derived fingerprint. The configured global `webhookSecret` remains the verification key, preserving the established behavior across process restarts and replicas. If the optional registration store is unavailable, HMAC dispatch and verification continue; RFC 9421 dispatch fails closed because seller-pinned provenance is required for safe verification.

Capture the raw request body before JSON parsing and verify it with the SDK helper:

```typescript
import { verifyWebhookRequest } from '@adcp/sdk/webhooks';

app.post('/adcp/webhook/:task_type/:agent_id/:operation_id', async (req, res) => {
  const check = verifyWebhookRequest({
    rawBody: req.rawBody,
    headers: req.headers,
    globalSecret: process.env.WEBHOOK_SECRET,
  });

  if (!check.ok) {
    return res.status(401).json({ error: check.reason });
  }

  const handled = await client
    .agent(req.params.agent_id)
    .handleWebhook(req.body, req.params.task_type, req.params.operation_id, check.signature, check.timestamp, req.rawBody);

  res.status(200).json({ received: handled });
});
```

`verifyWebhookRequest` normalizes header casing, rejects missing or ambiguous signature headers, enforces a 300s timestamp freshness window by default, and compares signatures in constant time. It does not maintain a replay cache; use `webhookDedup` below to drop duplicate webhook events by `idempotency_key`.

The mode recorded at registration is authoritative. The receiver never tries RFC 9421 and falls back to HMAC (or vice versa), and mixed-mode headers fail with `webhook_mode_mismatch`.

`reporting_webhook` and artifact callbacks are separate registrations. The automatic provenance described above covers task-status `push_notification_config`; existing reporting webhook HMAC verification remains recordless for compatibility.

## Deduplication

AdCP webhooks use at-least-once delivery — publishers retry until they see a 2xx response, so the same event can arrive more than once. Every MCP webhook payload carries a required `idempotency_key` the publisher keeps stable across retries; receivers dedupe by it.

Wire the client's `webhookDedup` on the `AsyncHandler` to get this for free:

```typescript
import { AdCPClient } from '@adcp/sdk';
import { memoryBackend } from '@adcp/sdk/server';

const client = new AdCPClient(agents, {
  webhookUrlTemplate: 'https://your-app.com/adcp/webhook/{task_type}/{agent_id}/{operation_id}',
  webhookSecret: process.env.WEBHOOK_SECRET,
  handlers: {
    webhookDedup: { backend: memoryBackend(), ttlSeconds: 86_400 }, // 24h
    onCreateMediaBuyStatusChange: async (result, metadata) => {
      // First delivery for this idempotency_key runs here; retries are dropped.
    },
  },
});
```

Scope is per-agent so keys from different senders never collide. Swap `memoryBackend()` for `pgBackend(...)` when running multiple replicas — the same backend can be shared with the request-side idempotency store, the scoped key is namespaced under a reserved `adcp\u001fwebhook\u001fv1\u001f…` prefix so there is no collision risk.

### Activity stream emits both events

On a duplicate the typed handler (e.g. `onCreateMediaBuyStatusChange`) is NOT called, but the `onActivity` stream DOES fire — once as `webhook_received` for the first delivery and once as `webhook_duplicate` for each retry. If you wire side effects into `onActivity`, branch on `activity.type` so metrics and logs don't double-count:

```typescript
onActivity: (activity) => {
  if (activity.type === 'webhook_duplicate') {
    metrics.increment('webhook.duplicate', { agent: activity.agent_id });
    return;
  }
  if (activity.type === 'webhook_received') {
    metrics.increment('webhook.received', { agent: activity.agent_id });
  }
},
```

The `webhook_duplicate` event intentionally omits `payload` (the original `webhook_received` already carries it) but includes `idempotency_key` on both events for correlation.

### Migrating from ad-hoc dedup

If you previously tracked processed webhooks by `(task_id, status, timestamp)`, replace that with `webhookDedup`. The tuple is fragile — two status transitions sharing a millisecond collide, and governance/artifact webhooks have no `task_id` to key on. `idempotency_key` is the canonical dedup field per AdCP 3.0. Running both layers in parallel is a silent footgun: the ad-hoc tuple can drop events that the key-based layer would have dispatched correctly.

### A2A and missing keys

A2A webhooks do not carry `idempotency_key` — the field is an MCP envelope addition. With `webhookDedup` configured, A2A deliveries dispatch without dedup and no warning is logged (the absence is expected). MCP senders that omit the field, or emit a value that fails the spec regex `^[A-Za-z0-9_.:-]{16,255}$`, fall back to dispatch-without-dedup and log a `console.warn` so you notice non-conforming publishers.
