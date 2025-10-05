# Task Tracking - Usage Examples

## Quick Start

### 1. Simple Synchronous Operation

```typescript
import { ADCPMultiAgentClient } from '@adcp/client';

const client = new ADCPMultiAgentClient(agents);

// Simple request/response
const response = await client.agent('agent_x').getProducts({ brief: 'Coffee brands' });

console.log(response.products);  // Array of products
```

### 2. With Activity Logging

```typescript
import { ADCPMultiAgentClient, createOperationId } from '@adcp/client';

const client = new ADCPMultiAgentClient(agents, {
  onActivity: (activity) => {
    console.log(`[${activity.operation_id}] ${activity.type}: ${activity.task_type}`);

    // Save to database
    db.logActivity(activity);

    // Update UI
    io.emit('activity', activity);
  }
});

// Use it - activities are automatically logged
const response = await client.agent('agent_x').getProducts({ brief: 'Coffee brands' });
```

### 3. Async Operations with Webhooks

```typescript
import {
  ADCPMultiAgentClient,
  createOperationId,
  createAsyncHandler
} from '@adcp/client';

// Setup async handler
const asyncHandler = createAsyncHandler({
  onSyncCreativesComplete: (response, metadata) => {
    console.log(`✅ Creatives synced for operation ${metadata.operation_id}`);

    response.creatives.forEach(creative => {
      db.updateCreative(creative.id, {
        status: creative.status,
        synced_at: metadata.timestamp
      });
    });
  },

  onTaskFailed: (metadata, error) => {
    console.error(`❌ Task failed: ${error}`);
    db.markFailed(metadata.task_id, error);
  }
});

// Setup webhook endpoint
app.post('/webhook/:agent_id?', async (req, res) => {
  await asyncHandler.handleWebhook(req.body, req.params.agent_id);
  res.json({ received: true });
});

// Make async request
const operationId = createOperationId();
const response = await client.agent('agent_y').syncCreatives(
  { creatives: [...] },
  {
    operation_id: operationId,
    webhook_url: 'https://myapp.com/webhook/agent_y'
  }
);

if (response.status === 'submitted') {
  console.log(`Task ${response.task_id} is pending, will complete via webhook`);
}
```

### 4. Multi-Agent Operations

```typescript
import { createOperationId } from '@adcp/client';

const operationId = createOperationId();

// Sync to 3 agents
const responses = await Promise.all([
  client.agent('agent_a').syncCreatives(
    { creatives: [...] },
    { operation_id: operationId, webhook_url: 'https://myapp.com/webhook/agent_a' }
  ),
  client.agent('agent_b').syncCreatives(
    { creatives: [...] },
    { operation_id: operationId, webhook_url: 'https://myapp.com/webhook/agent_b' }
  ),
  client.agent('agent_c').syncCreatives(
    { creatives: [...] },
    { operation_id: operationId, webhook_url: 'https://myapp.com/webhook/agent_c' }
  )
]);

// Check results
const pending = responses.filter(r => r.status === 'submitted').length;
const completed = responses.filter(r => r.status === 'completed').length;

console.log(`Operation ${operationId}: ${completed} completed, ${pending} pending`);

// Query activities for entire operation
const activities = db.query('SELECT * FROM activities WHERE operation_id = ?', [operationId]);
```

### 5. Complete Example with Database

```typescript
import {
  ADCPMultiAgentClient,
  createOperationId,
  createAsyncHandler
} from '@adcp/client';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL);

// Setup client with activity logging
const client = new ADCPMultiAgentClient(agents, {
  onActivity: async (activity) => {
    await sql`
      INSERT INTO activities (
        type, operation_id, agent_id, context_id, task_id, task_type, payload, timestamp
      ) VALUES (
        ${activity.type},
        ${activity.operation_id},
        ${activity.agent_id},
        ${activity.context_id || null},
        ${activity.task_id || null},
        ${activity.task_type},
        ${JSON.stringify(activity.payload)},
        ${activity.timestamp}
      )
    `;
  }
});

// Setup async handler
const asyncHandler = createAsyncHandler({
  onSyncCreativesComplete: async (response, metadata) => {
    for (const creative of response.creatives) {
      await sql`
        UPDATE creatives
        SET status = ${creative.status}, synced_at = NOW()
        WHERE id = ${creative.id}
      `;
    }
  },

  onCreateMediaBuyComplete: async (response, metadata) => {
    await sql`
      INSERT INTO media_buys (id, operation_id, agent_id, media_buy_id, data)
      VALUES (
        gen_random_uuid(),
        ${metadata.operation_id},
        ${metadata.agent_id},
        ${response.media_buy_id},
        ${JSON.stringify(response)}
      )
    `;
  },

  onActivity: async (activity) => {
    await sql`
      INSERT INTO activities (...)
      VALUES (...)
    `;
  }
});

// Webhook endpoint
app.post('/webhook/:agent_id?', async (req, res) => {
  await asyncHandler.handleWebhook(req.body, req.params.agent_id);
  res.json({ received: true });
});

// Use it
async function syncCreativesToAgents(creatives, agentIds) {
  const operationId = createOperationId();

  const responses = await Promise.all(
    agentIds.map(agentId =>
      client.agent(agentId).syncCreatives(
        { creatives },
        {
          operation_id: operationId,
          webhook_url: `https://myapp.com/webhook/${agentId}`
        }
      )
    )
  );

  return { operation_id: operationId, responses };
}
```

## Database Schema

```sql
-- Activities table (append-only log)
CREATE TABLE activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  context_id TEXT,
  task_id TEXT,
  task_type TEXT NOT NULL,
  status TEXT,
  payload JSONB,
  timestamp TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_activities_operation ON activities(operation_id, timestamp);
CREATE INDEX idx_activities_agent ON activities(agent_id, timestamp);

-- Your business tables
CREATE TABLE creatives (
  id TEXT PRIMARY KEY,
  status TEXT,
  synced_at TIMESTAMPTZ,
  data JSONB
);

CREATE TABLE media_buys (
  id UUID PRIMARY KEY,
  operation_id TEXT,
  agent_id TEXT,
  media_buy_id TEXT,
  data JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

## Querying Activities

```typescript
// Get all activities for an operation
const activities = await sql`
  SELECT * FROM activities
  WHERE operation_id = ${operationId}
  ORDER BY timestamp ASC
`;

// Get current status of operation (last write wins)
const currentStatus = await sql`
  SELECT DISTINCT ON (agent_id) *
  FROM activities
  WHERE operation_id = ${operationId}
    AND type = 'status_change'
  ORDER BY agent_id, timestamp DESC
`;

// Get operations with pending tasks
const pending = await sql`
  WITH latest_status AS (
    SELECT DISTINCT ON (operation_id, agent_id) *
    FROM activities
    WHERE type IN ('status_change', 'webhook_received')
    ORDER BY operation_id, agent_id, timestamp DESC
  )
  SELECT operation_id, COUNT(*) as pending_count
  FROM latest_status
  WHERE status IN ('submitted', 'working')
  GROUP BY operation_id
`;
```

## Testing UI Integration

```typescript
// In your server
import { createTaskEventStore } from './TaskEventStore';
import { sessionPlugin } from './session-middleware';

const eventStore = createTaskEventStore();

// Register session middleware
app.register(sessionPlugin);

// Setup client with session-aware activity logging
const client = new ADCPMultiAgentClient(agents, {
  onActivity: (activity) => {
    // Get session from request context
    const sessionId = getCurrentSessionId();
    eventStore.addEvent(sessionId, activity);
  }
});

// API endpoint for UI
app.get('/api/operations/:operation_id', (req, res) => {
  const events = eventStore.getEvents(req.sessionId, {
    operationId: req.params.operation_id
  });

  res.json({ events });
});
```

## Benefits

✅ **Simple** - Request/response for sync, webhook handlers for async
✅ **Type-safe** - Each handler gets correct response type
✅ **Consistent** - Same update logic whether sync or async
✅ **Observable** - Optional activity logging for debugging/UI
✅ **Flexible** - Choose which handlers you need
