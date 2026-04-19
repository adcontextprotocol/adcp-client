# Push Notification Config

Push notification config tells the AdCP agent where to send async task status updates via webhook. It is automatically injected by the client at the transport layer — you do not set it per-request.

## How It Works

When you configure a `webhookUrlTemplate` and `webhookSecret` on the client, every outgoing tool call (`create_media_buy`, `update_media_buy`, `sync_creatives`, etc.) will include a `push_notification_config` in the wire payload. The URL is generated per-operation so each task has its own unique webhook endpoint.

## Client Setup

```typescript
const client = new AdCPClient({
  webhookUrlTemplate: 'https://your-app.com/adcp/webhook/{task_type}/{agent_id}/{operation_id}',
  webhookSecret: 'your-hmac-secret-min-32-characters-here',
});
```

## Wire Payload

All async operations produce the same `push_notification_config` shape on the wire:

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

The client always uses `HMAC-SHA256`. The agent signs webhook payloads with the shared secret so you can verify delivery on receipt.

```typescript
import { createHmac } from 'crypto';

function verifyWebhook(payload: string, signature: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(payload).digest('hex');
  return expected === signature;
}
```

## Deduplication

AdCP webhooks use at-least-once delivery — publishers retry until they see a 2xx response, so the same event can arrive more than once. Every MCP webhook payload carries a required `idempotency_key` the publisher keeps stable across retries; receivers dedupe by it.

Wire the client's `webhookDedup` on the `AsyncHandler` to get this for free:

```typescript
import { AdCPClient } from '@adcp/client';
import { memoryBackend } from '@adcp/client/server';

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
