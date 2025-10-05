# Task Tracking Pattern - Final Design

## Core Philosophy

### 1. Synchronous by Default
Operations should feel like normal async/await - they complete or fail, never "pending":

```typescript
// Simple case - just works
const result = await client.agent('x').getProducts({ brief: '...' });
console.log(result.products);  // Array of products

// With clarifications - still synchronous
const result = await client.agent('x').getProducts(
  { brief: '...' },
  async (question) => {
    // Auto-answer if possible
    if (canAutoAnswer(question)) {
      return autoAnswer(question);
    }
    // Or prompt human (blocks until answer)
    return await promptHuman(question);
  }
);
```

### 2. Event Emitters for Observability
Events let you **watch** what's happening - for logging, UI updates, database recording.
They do NOT change control flow.

```typescript
const client = new ADCPMultiAgentClient(agents, {
  onProtocolRequest: (event) => {
    // Log request
    console.log('Sending:', event.method, event.payload);
    eventStore.add(event);
  },
  onProtocolResponse: (event) => {
    // Log response
    console.log('Received:', event.status, event.payload);
    eventStore.add(event);
  },
  onStatusChange: (event) => {
    // Update UI
    updateUI(event.operationId, event.agentId, event.status);
    eventStore.add(event);
  }
});

// Your code doesn't change - still synchronous
const result = await client.agent('x').getProducts({...});
// But events were emitted for observability
```

### 3. Webhooks for True Async
When operations can't complete synchronously (human approval, long-running), use webhooks:

```typescript
// No clarification handler = webhook mode
const result = await client.agent('y').syncCreatives(
  { creatives: [...] },
  null,  // No handler
  {
    operation_id: 'op_123',
    webhook_url: 'https://myapp.com/webhook'
  }
);

// Returns immediately
console.log(result.status);  // 'pending'
console.log(result.operation_id);  // 'op_123'

// Later: webhook receives completion
app.post('/webhook', (req, res) => {
  const { operation_id, agent_id, status, result } = req.body;

  if (status === 'completed') {
    console.log('Sync completed!', result);
  }

  res.json({ received: true });
});
```

## The Three Identifiers

### 1. `operation_id` (Yours)
- Client-generated ID grouping related work
- Example: "Sync 5 creatives to 3 agents" = 1 operation
- Key for querying your event store

### 2. `context_id` (Server's)
- Server creates this on first response
- Represents conversation with one agent
- You store it for reconciliation

### 3. `task_id` (Server's)
- Server creates this for async operations
- You store it for webhook correlation
- May not exist for synchronous responses

## Clarification Handler Pattern

The clarification handler is your agent's "assistant" - it tries to answer questions automatically:

```typescript
async function smartClarificationHandler(question: InputRequest): Promise<any> {
  console.log('Agent asks:', question.question);

  // Pattern 1: Auto-answer based on context
  if (question.field === 'budget' && question.expectedType === 'number') {
    return { budget: 10000 };  // Use default
  }

  // Pattern 2: Prompt human (still synchronous)
  if (question.required) {
    return await promptHuman(question.question);
  }

  // Pattern 3: Defer to webhook (becomes async)
  if (needsManagerApproval(question)) {
    throw new DeferToWebhookError();  // Exits sync flow
  }

  // Pattern 4: Abort
  throw new Error('Cannot answer this question');
}

// Use it
const result = await client.agent('x').getProducts(
  { brief: '...' },
  smartClarificationHandler
);
```

## Multi-Agent Operations

```typescript
const operationId = createOperationId();

// Start 3 sync operations
const results = await Promise.all([
  client.agent('agent_a').syncCreatives({...}, handler, { operation_id: operationId }),
  client.agent('agent_b').syncCreatives({...}, handler, { operation_id: operationId }),
  client.agent('agent_c').syncCreatives({...}, handler, { operation_id: operationId })
]);

// Check results
results.forEach((result, i) => {
  if (result.status === 'completed') {
    console.log(`Agent ${i} completed:`, result.data);
  } else if (result.status === 'pending') {
    console.log(`Agent ${i} is async, will complete via webhook`);
  }
});

// Query events for entire operation
const events = eventStore.getEvents(sessionId, { operationId });
console.log(`Operation had ${events.length} events`);
```

## Event Schema

### Protocol Request Event
```typescript
{
  eventType: 'protocol_request',
  operationId: 'op_123',
  agentId: 'agent_x',
  taskType: 'get_products',
  protocol: 'mcp',
  method: 'get_products',
  payload: { params: {...}, headers: {...} },
  timestamp: '2025-01-15T10:30:00Z'
}
```

### Protocol Response Event
```typescript
{
  eventType: 'protocol_response',
  operationId: 'op_123',
  agentId: 'agent_x',
  contextId: 'ctx_abc',  // Server provided
  taskId: null,          // Sync response
  taskType: 'get_products',
  protocol: 'mcp',
  status: 'completed',
  payload: { products: [...] },
  timestamp: '2025-01-15T10:30:01Z'
}
```

### Status Change Event
```typescript
{
  operationId: 'op_123',
  agentId: 'agent_x',
  contextId: 'ctx_abc',
  taskId: 'task_456',    // If async
  taskType: 'sync_creatives',
  status: 'completed',
  result: { synced: 5 },
  timestamp: '2025-01-15T10:35:00Z'
}
```

## Server Identifier Tracking

```typescript
import { ServerIdentifierMapper } from '@adcp/client';

const idMapper = new ServerIdentifierMapper();

// When you get server IDs from response, register them
function handleStatusChange(event: TaskStatusUpdateEvent) {
  if (event.contextId || event.taskId) {
    idMapper.register(event.operationId, event.agentId, event.contextId, event.taskId);
  }

  // Store event
  eventStore.add(event);
}

// When webhook arrives, look up your IDs
app.post('/webhook', (req, res) => {
  const { context_id, task_id, status, result } = req.body;

  // Look up operation+agent
  const key = idMapper.lookupByContext(context_id) ||
              idMapper.lookupByTask(task_id);

  if (key) {
    handleStatusChange({
      operationId: key.operationId,
      agentId: key.agentId,
      contextId: context_id,
      taskId: task_id,
      taskType: 'sync_creatives',
      status,
      result,
      timestamp: new Date().toISOString()
    });
  }

  res.json({ received: true });
});
```

## Testing UI Integration

```typescript
// Setup
const eventStore = createTaskEventStore();
const idMapper = new ServerIdentifierMapper();

const client = new ADCPMultiAgentClient(agents, {
  onProtocolRequest: (event) => {
    eventStore.addEvent(request.sessionId, event);
  },
  onProtocolResponse: (event) => {
    eventStore.addEvent(request.sessionId, event);
  },
  onStatusChange: (event) => {
    // Register server IDs
    if (event.contextId || event.taskId) {
      idMapper.register(event.operationId, event.agentId, event.contextId, event.taskId);
    }
    // Store event
    eventStore.addEvent(request.sessionId, event);
  }
});

// API endpoint for getting events
app.get('/api/operations/:operation_id', (req, res) => {
  const events = eventStore.getEvents(req.sessionId, {
    operationId: req.params.operation_id
  });

  res.json({ events });
});

// UI displays events as timeline
```

## Proposed AdCP Spec Change

**Add `operation_id` to request/response:**

```typescript
// Request
{
  "tool": "get_products",
  "parameters": { "brief": "..." },
  "operation_id": "op_123",  // NEW: Client correlation ID
  "context_id": "ctx_abc"    // Existing: Conversation continuation
}

// Response (and webhooks)
{
  "operation_id": "op_123",  // NEW: Echo back
  "context_id": "ctx_def",
  "task_id": "task_456",
  "status": "completed",
  "result": {...}
}
```

**Benefits:**
- No need for ServerIdentifierMapper
- Servers echo operation_id back
- Webhooks include it automatically
- Standard correlation mechanism

## Summary

**✅ DO:**
- Use synchronous operations by default
- Provide clarification handlers for questions
- Use event emitters for observability (logging, UI, database)
- Use webhooks for true async operations
- Track operation_id + agent_id as your primary key

**❌ DON'T:**
- Use event emitters for control flow
- Expect async callbacks during synchronous execution
- Assume operations are async by default

**Remember:**
- Operations complete synchronously unless they can't
- Event emitters let you watch, not control
- Webhooks are for when things take time
