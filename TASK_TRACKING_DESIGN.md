# Task Tracking Design - Final

## Overview

Simple, clean pattern:
1. **Request/Response** - Synchronous by default, returns what happened
2. **Structured Async Handler** - Type-safe callbacks for AdCP tool completions
3. **Activity Logging** - Optional observer for all protocol activity

## 1. Synchronous Request/Response

```typescript
// Make request, get response
const response = await client.agent('x').getProducts({ brief: '...' });

// Handle based on status
switch (response.status) {
  case 'completed':
    console.log('Got products:', response.data.products);
    db.saveProducts(response.data.products);
    break;

  case 'input_required':
    const answer = await promptHuman(response.question);
    const final = await client.continueConversation(response.context_id, answer);
    break;

  case 'submitted':
    console.log('Task', response.task_id, 'will complete async via webhook');
    break;
}
```

## 2. Structured Async Handler

Type-safe callbacks for webhook responses:

```typescript
import { createAsyncHandler } from '@adcp/client';

const asyncHandler = createAsyncHandler({
  // Typed handler for creative sync
  onSyncCreativesComplete: (response: SyncCreativesResponse, metadata) => {
    console.log(`Operation ${metadata.operation_id} completed`);

    response.creatives.forEach(creative => {
      db.updateCreativeStatus(creative.id, creative.status);
    });
  },

  // Typed handler for media buy creation
  onCreateMediaBuyComplete: (response: CreateMediaBuyResponse, metadata) => {
    db.saveMediaBuy({
      operation_id: metadata.operation_id,
      media_buy_id: response.media_buy_id,
      agent_id: metadata.agent_id
    });
  },

  // ... handlers for all AdCP tools

  // Optional: log all activities
  onActivity: (activity) => {
    db.logActivity(activity);
  }
});

// Single webhook endpoint
app.post('/webhook', (req, res) => {
  asyncHandler.handleWebhook(req.body);
  res.json({ received: true });
});
```

## 3. Activity Logging (Optional)

For observability - logs every protocol interaction:

```typescript
const client = new ADCPMultiAgentClient(agents, {
  onActivity: (activity) => {
    // Log everything: requests, responses, status changes
    db.logActivity(activity);

    // Update UI
    io.emit('activity', activity);
  }
});
```

## Complete Example

```typescript
import {
  ADCPMultiAgentClient,
  createAsyncHandler,
  createOperationId
} from '@adcp/client';

// Setup client with activity logging
const client = new ADCPMultiAgentClient(agents, {
  onActivity: (activity) => {
    postgres.insert('activities', activity);
    io.emit('activity', activity);
  }
});

// Setup async handler for webhooks
const asyncHandler = createAsyncHandler({
  onSyncCreativesComplete: (response, metadata) => {
    response.creatives.forEach(creative => {
      db.updateCreative(creative.id, {
        status: creative.status,
        agent_id: metadata.agent_id,
        synced_at: metadata.timestamp
      });
    });
  },

  onCreateMediaBuyComplete: (response, metadata) => {
    db.saveMediaBuy(response);
  },

  onTaskFailed: (metadata, error) => {
    db.markTaskFailed(metadata.task_id, error);
    notifyUser(metadata.operation_id, `Task failed: ${error}`);
  },

  onActivity: (activity) => {
    postgres.insert('activities', activity);
  }
});

// Synchronous operation
async function getProducts(brief: string) {
  const response = await client.agent('agent_x').getProducts({ brief });

  if (response.status === 'completed') {
    return response.data.products;
  }

  throw new Error('Failed to get products');
}

// Multi-agent async operation
async function syncCreativesToAgents(creatives: Creative[], agentIds: string[]) {
  const operationId = createOperationId();

  const responses = await Promise.all(
    agentIds.map(agentId =>
      client.agent(agentId).syncCreatives(
        { creatives },
        { operation_id: operationId, webhook_url: 'https://myapp.com/webhook' }
      )
    )
  );

  return {
    operation_id: operationId,
    pending: responses.filter(r => r.status === 'submitted').length,
    completed: responses.filter(r => r.status === 'completed').length
  };
}

// Webhook endpoint
app.post('/webhook', (req, res) => {
  asyncHandler.handleWebhook(req.body);
  res.json({ received: true });
});
```

## Handler Types

```typescript
interface AsyncHandlerConfig {
  // AdCP tool completion handlers
  onGetProductsComplete?: (response: GetProductsResponse, metadata: WebhookMetadata) => void;
  onListCreativeFormatsComplete?: (response: ListCreativeFormatsResponse, metadata: WebhookMetadata) => void;
  onCreateMediaBuyComplete?: (response: CreateMediaBuyResponse, metadata: WebhookMetadata) => void;
  onUpdateMediaBuyComplete?: (response: UpdateMediaBuyResponse, metadata: WebhookMetadata) => void;
  onSyncCreativesComplete?: (response: SyncCreativesResponse, metadata: WebhookMetadata) => void;
  onListCreativesComplete?: (response: ListCreativesResponse, metadata: WebhookMetadata) => void;
  onGetMediaBuyDeliveryComplete?: (response: GetMediaBuyDeliveryResponse, metadata: WebhookMetadata) => void;
  onListAuthorizedPropertiesComplete?: (response: ListAuthorizedPropertiesResponse, metadata: WebhookMetadata) => void;
  onProvidePerformanceFeedbackComplete?: (response: ProvidePerformanceFeedbackResponse, metadata: WebhookMetadata) => void;
  onGetSignalsComplete?: (response: GetSignalsResponse, metadata: WebhookMetadata) => void;
  onActivateSignalComplete?: (response: ActivateSignalResponse, metadata: WebhookMetadata) => void;

  // Status handlers
  onTaskSubmitted?: (metadata: WebhookMetadata) => void;
  onTaskWorking?: (metadata: WebhookMetadata, message?: string) => void;
  onTaskFailed?: (metadata: WebhookMetadata, error: string) => void;

  // Fallback
  onTaskComplete?: (response: any, metadata: WebhookMetadata) => void;

  // Activity logging
  onActivity?: (activity: Activity) => void;
}

interface WebhookMetadata {
  operation_id: string;
  context_id: string;
  task_id: string;
  agent_id: string;
  task_type: string;
  timestamp: string;
}

interface Activity {
  type: 'protocol_request' | 'protocol_response' | 'status_change' | 'webhook_received';
  operation_id: string;
  agent_id: string;
  context_id?: string;
  task_id?: string;
  task_type: string;
  timestamp: string;
  payload?: any;
}
```

## Database Schema

```sql
-- Activities table (append-only event log)
CREATE TABLE activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  context_id TEXT,
  task_id TEXT,
  task_type TEXT NOT NULL,
  payload JSONB,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_activities_operation ON activities(operation_id, timestamp);
CREATE INDEX idx_activities_agent ON activities(agent_id, timestamp);
CREATE INDEX idx_activities_task ON activities(task_id) WHERE task_id IS NOT NULL;

-- Business data tables (your domain models)
CREATE TABLE creatives (
  id TEXT PRIMARY KEY,
  agent_id TEXT,
  status TEXT,
  synced_at TIMESTAMPTZ,
  data JSONB
);

CREATE TABLE media_buys (
  id TEXT PRIMARY KEY,
  operation_id TEXT,
  agent_id TEXT,
  media_buy_id TEXT,
  budget DECIMAL,
  created_at TIMESTAMPTZ
);
```

## Benefits

1. **Simple** - Request/response for sync, webhook handlers for async
2. **Type-safe** - Each handler gets correct response type
3. **Consistent** - Same update logic whether sync or async
4. **Observable** - Optional activity logging for debugging/UI
5. **Flexible** - Choose which handlers you need

## Proposed AdCP Spec Addition

Add `operation_id` to spec:

```json
// Request
{
  "tool": "sync_creatives",
  "parameters": { "creatives": [...] },
  "operation_id": "op_123",
  "webhook_url": "https://myapp.com/webhook"
}

// Response & Webhook
{
  "operation_id": "op_123",
  "context_id": "ctx_abc",
  "task_id": "task_456",
  "status": "completed",
  "result": {...}
}
```

Benefits:
- Standard correlation mechanism
- No need to track mappings
- Servers echo it back automatically
