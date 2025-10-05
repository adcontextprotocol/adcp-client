# Webhook Pattern - Unified URL Format

## Overview

All webhooks (task completions AND notifications) use a single, consistent URL pattern with operation_id encoded in the path.

## URL Format

```
/webhook/{task_type}/{agent_id}/{operation_id}
```

**Why this pattern?**
1. **Type-safe**: URL declares expected response type
2. **Self-documenting**: Everything you need is in the URL
3. **No mapping required**: No need to track context_id → operation_id
4. **Single endpoint**: One webhook route handles everything

## Automatic Webhook URL Generation with Macros

Configure a URL template with macro substitution to match your routing structure:

```typescript
const client = new ADCPMultiAgentClient(agents, {
  webhookBaseUrl: 'https://myapp.com',
  webhookUrlTemplate: '{base_url}/webhook/{task_type}/{agent_id}/{operation_id}',
  handlers: { /* ... */ }
});

// Automatic URL generation with macro substitution
const operationId = createOperationId();
const agent = client.agent('agent_x');

const webhookUrl = agent.getWebhookUrl('sync_creatives', operationId);
// Returns: "https://myapp.com/webhook/sync_creatives/agent_x/op_123"
```

### Available Macros

- `{base_url}` - Base URL (from `webhookBaseUrl`)
- `{agent_id}` - Agent ID
- `{task_type}` - Task type (e.g., `sync_creatives`, `media_buy_delivery`)
- `{operation_id}` - Operation ID

### Template Examples

**Path-based routing** (default):
```typescript
webhookUrlTemplate: '{base_url}/webhook/{task_type}/{agent_id}/{operation_id}'
// Result: https://myapp.com/webhook/sync_creatives/agent_x/op_123
```

**Query string routing**:
```typescript
webhookUrlTemplate: '{base_url}/webhook?agent={agent_id}&op={operation_id}&type={task_type}'
// Result: https://myapp.com/webhook?agent=agent_x&op=op_123&type=sync_creatives
```

**Custom path**:
```typescript
webhookUrlTemplate: '{base_url}/api/v1/adcp/callbacks/{agent_id}?operation={operation_id}'
// Result: https://myapp.com/api/v1/adcp/callbacks/agent_x?operation=op_123
```

**Namespace to avoid conflicts**:
```typescript
webhookUrlTemplate: '{base_url}/adcp-webhooks/{agent_id}/{task_type}/{operation_id}'
// Result: https://myapp.com/adcp-webhooks/agent_x/sync_creatives/op_123
```

## Task Completion Webhooks

### 1. Client makes async request

```typescript
import { createOperationId } from '@adcp/client';

const operationId = createOperationId();
const agent = client.agent('agent_x');

// Generate webhook URL automatically
const webhookUrl = agent.getWebhookUrl('sync_creatives', operationId);

const result = await agent.syncCreatives(
  { creatives: [...] },
  null, // No input handler = webhook mode
  {
    contextId: operationId,
    webhookUrl
  }
);

console.log(result.status); // 'submitted'
```

### 2. Agent posts to webhook URL

```
POST https://myapp.com/webhook/sync_creatives/agent_x/op_123

{
  "status": "completed",
  "result": {
    "summary": { "total_processed": 5 },
    "results": [...]
  }
}
```

### 3. Single webhook endpoint handles it

```typescript
app.post('/webhook/:task_type/:agent_id/:operation_id', async (req, res) => {
  const { task_type, agent_id, operation_id } = req.params;

  // Inject URL parameters into payload
  const payload = {
    ...req.body,
    task_type,
    operation_id
  };

  // Route to agent client
  const agent = client.agent(agent_id);
  await agent.handleWebhook(payload, req.headers['x-adcp-signature']);

  res.json({ received: true });
});
```

### 4. Type-safe handler receives it

```typescript
const client = new ADCPMultiAgentClient(agents, {
  handlers: {
    onSyncCreativesComplete: (response, metadata) => {
      console.log('Synced:', response.summary?.total_processed);
      console.log('Operation:', metadata.operation_id);
      db.updateCreatives(response.results);
    }
  }
});
```

## Notification Webhooks (PR #81)

Agent-initiated notifications use the **same URL pattern** as task completions.

**Mental Model**: Think of notifications as **status updates** for an ongoing operation: *"Get final delivery report from agent X for month Y"*

- `notification_type: 'scheduled'` → like `status: 'working'` (progress update)
- `notification_type: 'final'` → like `status: 'completed'` (final report)
- `notification_type: 'delayed'` → like `status: 'working'` (still waiting)

### Key Differences from Regular Tasks:
- **task_type**: Always `media_buy_delivery`
- **operation_id**: Lazily generated from agent + month when notification arrives (e.g., `delivery_report_agent123_2025-10`)
- **Payload**: Contains `notification_type` field instead of `status`

### Agent sends notification

```
POST https://myapp.com/webhook/media_buy_delivery/agent_x/delivery_report_seat123_2025-10

{
  "notification_type": "scheduled",
  "sequence_number": 3,
  "next_expected_at": "2025-10-05T15:00:00Z",
  "reporting_period": {
    "start": "2025-10-01T00:00:00Z",
    "end": "2025-10-05T10:00:00Z"
  },
  "currency": "USD",
  "media_buy_deliveries": [
    {
      "media_buy_id": "mb_123",
      "impressions": 50000,
      "clicks": 250,
      "spend": 1250.00
    }
  ]
}
```

### Same webhook endpoint handles it

The webhook endpoint automatically detects notifications by checking:
1. `task_type === 'media_buy_delivery'`
2. Presence of `notification_type` field

```typescript
// Same endpoint - no special handling needed!
app.post('/webhook/:task_type/:agent_id/:operation_id', async (req, res) => {
  const { task_type, agent_id, operation_id } = req.params;

  const payload = {
    ...req.body,
    task_type,
    operation_id
  };

  // AsyncHandler automatically routes to notification handler
  await client.agent(agent_id).handleWebhook(payload, req.headers['x-adcp-signature']);

  res.json({ received: true });
});
```

### Notification handler receives it

```typescript
const client = new ADCPMultiAgentClient(agents, {
  handlers: {
    onMediaBuyDeliveryNotification: (notification, metadata) => {
      console.log(`Report ${metadata.sequence_number}: ${metadata.notification_type}`);
      console.log(`Period: ${notification.reporting_period?.start} - ${notification.reporting_period?.end}`);
      console.log(`Deliveries: ${notification.media_buy_deliveries?.length}`);

      // Save as status update for this operation
      // All notifications for same agent + month share the same operation_id
      db.saveDeliveryUpdate(metadata.operation_id, notification);

      // If final report, mark operation complete
      if (metadata.notification_type === 'final') {
        db.markOperationComplete(metadata.operation_id);
      }
    }
  }
});
```

## Lazy Operation ID Generation

The `operation_id` is **lazily generated** when notifications arrive - no pre-registration needed!

```
Format: delivery_report_{agent_id}_{YYYY-MM}

Examples:
- delivery_report_agent_x_2025-10  (Agent X, October 2025)
- delivery_report_agent_y_2025-10  (Agent Y, October 2025)
- delivery_report_agent_x_2025-11  (Agent X, November 2025)
```

**How it works:**
1. Agent sends notification with reporting period
2. Webhook URL includes lazily-generated operation_id (hashed from agent + month)
3. All intermediate reports for same agent + month → same operation_id
4. Final report (`notification_type: 'final'`) marks operation complete
5. **No separate table needed** - just hash agent + month when notification arrives!

**Benefits:**
- No pre-registration required
- Reports automatically grouped by period
- Simple hash function, no database lookup
- Treat notifications like status updates for an operation

## Complete Example

```typescript
import { ADCPMultiAgentClient, createOperationId } from '@adcp/client';

// Configure once with webhook base URL
const client = new ADCPMultiAgentClient(agents, {
  webhookBaseUrl: 'https://myapp.com',
  webhookSecret: process.env.WEBHOOK_SECRET,

  handlers: {
    // Task completion handlers
    onSyncCreativesComplete: (response, metadata) => {
      db.updateCreatives(metadata.operation_id, response.results);
    },

    onCreateMediaBuyComplete: (response, metadata) => {
      db.saveMediaBuy(metadata.operation_id, response);
    },

    // Notification handler
    onMediaBuyDeliveryNotification: (notification, metadata) => {
      // operation_id groups reports by seat + month
      db.saveDeliveryReport(metadata.operation_id, notification);
    },

    onTaskFailed: (metadata, error) => {
      db.markFailed(metadata.operation_id, error);
    }
  }
});

// Make async request with automatic webhook URL
const operationId = createOperationId();
const agent = client.agent('agent_x');

const result = await agent.syncCreatives(
  { creatives: [...] },
  null,
  {
    contextId: operationId,
    // Generate webhook URL automatically
    webhookUrl: agent.getWebhookUrl('sync_creatives', operationId)
  }
);

// Single webhook endpoint handles everything
app.post('/webhook/:task_type/:agent_id/:operation_id', async (req, res) => {
  const { task_type, agent_id, operation_id } = req.params;
  const signature = req.headers['x-adcp-signature'];

  const payload = {
    ...req.body,
    task_type,
    operation_id
  };

  // Handles both task completions and notifications
  await client.agent(agent_id).handleWebhook(payload, signature);

  res.json({ received: true });
});
```

## Benefits

1. **Single webhook setup**: One endpoint, one configuration
2. **Automatic URL generation**: No manual URL construction
3. **Type-safe**: URL declares expected response type
4. **Clean grouping**: Notifications grouped by seat + month
5. **No mapping**: Operation ID in URL, no tracking needed
6. **Security**: HMAC-SHA256 signature verification
7. **Multi-tenant ready**: Seat-based segmentation built-in

## Database Schema

**Simple unified table** - no special handling needed for notifications!

```sql
-- Single webhook events table
CREATE TABLE webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id TEXT NOT NULL,        -- Groups related events
  agent_id TEXT NOT NULL,
  task_type TEXT NOT NULL,           -- 'sync_creatives', 'media_buy_delivery', etc.
  status TEXT,                       -- For tasks: 'submitted', 'working', 'completed', etc.
  notification_type TEXT,            -- For notifications: 'scheduled', 'final', 'delayed'
  sequence_number INTEGER,           -- For notifications: report sequence
  payload JSONB NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_events_operation ON webhook_events(operation_id);
CREATE INDEX idx_events_agent ON webhook_events(agent_id);
CREATE INDEX idx_events_task_type ON webhook_events(task_type);
CREATE INDEX idx_events_timestamp ON webhook_events(timestamp DESC);

-- Query all events for a regular task operation
SELECT * FROM webhook_events
WHERE operation_id = 'op_123'
ORDER BY timestamp;

-- Query all delivery notifications for agent + month (status updates!)
SELECT * FROM webhook_events
WHERE operation_id = 'delivery_report_agent_x_2025-10'
ORDER BY sequence_number;

-- Get final report for a month
SELECT * FROM webhook_events
WHERE operation_id = 'delivery_report_agent_x_2025-10'
AND notification_type = 'final';

-- Track delivery report progress (like tracking task status)
SELECT
  operation_id,
  COUNT(*) as report_count,
  MAX(sequence_number) as latest_sequence,
  MAX(CASE WHEN notification_type = 'final' THEN timestamp END) as completed_at
FROM webhook_events
WHERE task_type = 'media_buy_delivery'
AND operation_id LIKE 'delivery_report_agent_x_%'
GROUP BY operation_id
ORDER BY operation_id DESC;
```

**Key insight**: Notifications are just webhooks! No separate table needed - they naturally fit into the same event log as task completions.

## Security

All webhooks support HMAC-SHA256 signature verification:

```typescript
const client = new ADCPMultiAgentClient(agents, {
  webhookSecret: process.env.WEBHOOK_SECRET
});

// Signatures verified automatically on handleWebhook()
// Returns 401 if signature invalid
```

## Migration from Separate Notification Endpoint

**Old pattern** (DEPRECATED):
```
/webhook/{task_type}/{agent_id}/{operation_id}     (task completions)
/webhook/notification/{agent_id}                   (notifications)
```

**New pattern** (CURRENT):
```
/webhook/{task_type}/{agent_id}/{operation_id}     (everything)
```

To migrate:
1. Remove old `/webhook/notification/:agent_id` endpoint
2. Generate notification URLs using `getWebhookUrl('media_buy_delivery', operationId)`
3. Operation ID auto-generated from seat + month for notifications
