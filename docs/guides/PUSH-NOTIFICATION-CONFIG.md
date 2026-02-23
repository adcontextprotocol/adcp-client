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
