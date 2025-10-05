# Task Tracking Implementation Guide

## Overview

This document describes the event-based task tracking system for the AdCP testing framework. The system uses an **append-only event log** pattern where all task execution events are emitted from the library and can be consumed by the testing UI (or any other application).

## Architecture

### 1. Event-Driven Design

**Library Responsibilities:**
- Emit task events (request, response, status changes)
- NO database dependencies
- Consumers subscribe via callbacks

**Testing UI Responsibilities:**
- Subscribe to events
- Store events in-memory per session
- Display event stream to users

### 2. Key Concepts

#### Operation ID
- Client-generated UUID grouping related tasks
- Example: "Sync 5 creatives to 3 agents" = 1 operation ID, 15 tasks

#### Agent Task ID
- Server-assigned task ID (from agent response)
- NULL for synchronous responses
- Primary key for tracking async tasks

#### Event Types
1. **Protocol Request** - HTTP/SSE request sent to agent
2. **Protocol Response** - Response received from agent
3. **Status Update** - Task status changed (submitted→working→completed)

## File Structure

```
src/
├── lib/
│   └── core/
│       └── TaskEventTypes.ts          # Event type definitions
└── server/
    ├── TaskEventStore.ts              # In-memory event store
    ├── session-middleware.ts          # Session management
    └── server.ts                      # Wire up events (TODO)
```

## Event Schema

### Base Event

```typescript
interface BaseTaskEvent {
  operationId: string;      // Client-generated operation group ID
  agentId: string;          // Agent performing the task
  agentTaskId?: string;     // Server's task ID (null for sync)
  taskType: string;         // Tool name (get_products, sync_creatives, etc)
  timestamp: string;        // ISO 8601 timestamp
}
```

### Protocol Request Event

```typescript
interface ProtocolRequestEvent extends BaseTaskEvent {
  eventType: 'protocol_request';
  protocol: 'a2a' | 'mcp';
  method: string;
  payload: {
    params: Record<string, any>;
    headers?: Record<string, string>;
  };
}
```

### Protocol Response Event

```typescript
interface ProtocolResponseEvent extends BaseTaskEvent {
  eventType: 'protocol_response';
  protocol: 'a2a' | 'mcp';
  method: string;
  payload: any;              // Full response
  status: string;            // Response status
}
```

### Status Update Event

```typescript
interface TaskStatusEvent extends BaseTaskEvent {
  eventType: 'status_update';
  status: 'submitted' | 'working' | 'input-required' | 'completed' | 'failed';
  previousStatus?: string;
  result?: any;              // For completed
  error?: string;            // For failed
}
```

### Object Event (Optional)

```typescript
interface ObjectEvent {
  operationId: string;
  agentTaskId?: string;
  objectType: 'product' | 'creative' | 'media_buy' | string;
  objectId?: string;
  targetEntity: string;      // Agent ID or platform
  status: string;
  payload?: any;
  timestamp: string;
}
```

## Implementation Steps

### ✅ Completed

1. Created `TaskEventTypes.ts` with event definitions
2. Created `TaskEventStore.ts` for in-memory storage
3. Created `session-middleware.ts` for session management
4. Added @fastify/cookie dependency
5. Exported event types from library index

### 🚧 TODO: Wire Up Event Emitters

**In `TaskExecutor.ts`:**

```typescript
// Add event emitter config to constructor
constructor(config: {
  // ... existing config
  onTaskEvent?: (event: TaskEvent) => void;
  onObjectEvent?: (event: ObjectEvent) => void;
}) { ... }

// In executeTask(), emit events:

// 1. Before making request
this.config.onTaskEvent?.({
  eventType: 'protocol_request',
  operationId,
  agentId: agent.id,
  taskType: taskName,
  protocol: agent.protocol,
  method: taskName,
  payload: { params, headers },
  timestamp: new Date().toISOString()
});

// 2. After receiving response
this.config.onTaskEvent?.({
  eventType: 'protocol_response',
  operationId,
  agentId: agent.id,
  agentTaskId: response.task_id,
  taskType: taskName,
  protocol: agent.protocol,
  method: taskName,
  payload: response,
  status: response.status,
  timestamp: new Date().toISOString()
});

// 3. On status changes
this.config.onTaskEvent?.({
  eventType: 'status_update',
  operationId,
  agentId: agent.id,
  agentTaskId: response.task_id,
  taskType: taskName,
  status: newStatus,
  previousStatus: oldStatus,
  timestamp: new Date().toISOString()
});
```

### 🚧 TODO: Update Server

**In `server.ts`:**

```typescript
import { createTaskEventStore } from './TaskEventStore';
import { sessionPlugin } from './session-middleware';
import { createOperationId } from '../lib';

// Initialize event store
const eventStore = createTaskEventStore({
  maxSessions: 100,
  sessionTimeoutMs: 60 * 60 * 1000,  // 1 hour
  maxEventsPerSession: 10000
});

// Register session middleware
app.register(sessionPlugin);

// Configure ADCP client with event listeners
const adcpClient = new ADCPMultiAgentClient(configuredAgents, {
  executor: {
    onTaskEvent: (event) => {
      // Get session ID from current request context
      // (This is tricky - need to pass session through)
      const sessionId = getCurrentSessionId();
      eventStore.addEvent(sessionId, event);
    },
    onObjectEvent: (event) => {
      const sessionId = getCurrentSessionId();
      eventStore.addObjectEvent(sessionId, event);
    }
  }
});

// Update executeTaskOnAgent to use operation IDs
async function executeTaskOnAgent(
  agentId: string,
  toolName: string,
  args: any,
  inputHandler?: InputHandler,
  operationId?: string  // NEW: pass operation ID
): Promise<TestResult> {
  const agent = adcpClient.agent(agentId);

  // Use provided operation ID or generate new one
  const opId = operationId || createOperationId();

  const result = await agent.executeTask(toolName, args, inputHandler, {
    contextId: opId  // Pass as contextId for now
  });

  return adaptTaskResultToLegacyFormat(result, agentId);
}
```

### 🚧 TODO: Add Event API Endpoints

```typescript
// Get event stream for session
app.get('/api/events', async (request, reply) => {
  const sessionId = request.sessionId;
  const { operation_id, agent_id, since, limit } = request.query as any;

  const events = eventStore.getEvents(sessionId, {
    operationId: operation_id,
    agentId: agent_id,
    since: since ? new Date(since) : undefined,
    limit: limit ? parseInt(limit) : 100
  });

  return { success: true, data: { events }, timestamp: new Date().toISOString() };
});

// Get operations (grouped view)
app.get('/api/operations', async (request, reply) => {
  const sessionId = request.sessionId;
  const { limit } = request.query as any;

  const operations = eventStore.getOperations(sessionId, {
    limit: limit ? parseInt(limit) : 50
  });

  return { success: true, data: { operations }, timestamp: new Date().toISOString() };
});

// Get single operation details
app.get('/api/operations/:operation_id', async (request, reply) => {
  const sessionId = request.sessionId;
  const { operation_id } = request.params as any;

  const events = eventStore.getEvents(sessionId, {
    operationId: operation_id
  });

  const objectEvents = eventStore.getObjectEvents(sessionId, {
    operationId: operation_id
  });

  return {
    success: true,
    data: {
      operationId: operation_id,
      events,
      objectEvents
    },
    timestamp: new Date().toISOString()
  };
});

// Clear session
app.delete('/api/events', async (request, reply) => {
  const sessionId = request.sessionId;
  eventStore.clearSession(sessionId);
  return { success: true, timestamp: new Date().toISOString() };
});

// Get session stats
app.get('/api/session/info', async (request, reply) => {
  const sessionId = request.sessionId;
  const info = eventStore.getSessionInfo(sessionId);
  return { success: true, data: info, timestamp: new Date().toISOString() };
});
```

### 🚧 TODO: Update UI

**Add event stream panel to `index.html`:**

```html
<div class="task-feed">
  <h3>Task Event Feed</h3>
  <div class="operations-list">
    <!-- List of operations -->
  </div>
  <div class="event-details">
    <!-- Selected operation's event timeline -->
  </div>
</div>

<script>
// Fetch operations on load
async function loadOperations() {
  const response = await fetch('/api/operations?limit=20');
  const { data } = await response.json();
  renderOperations(data.operations);
}

// Show operation details
async function showOperationDetails(operationId) {
  const response = await fetch(`/api/operations/${operationId}`);
  const { data } = await response.json();
  renderEventTimeline(data.events);
}

// Auto-refresh every 5 seconds
setInterval(loadOperations, 5000);
</script>
```

## Example Flows

### Synchronous Request (get_products)

```
Client generates: operation_id = "op_1234"

1. Protocol Request Event
   {
     eventType: "protocol_request",
     operationId: "op_1234",
     agentId: "agent_x",
     taskType: "get_products",
     protocol: "mcp",
     payload: { params: { tactic: "display" } }
   }

2. Protocol Response Event
   {
     eventType: "protocol_response",
     operationId: "op_1234",
     agentId: "agent_x",
     agentTaskId: null,  // Synchronous
     taskType: "get_products",
     status: "completed",
     payload: { products: [...] }
   }

UI shows:
- Operation "op_1234": get_products (completed)
  - 2 events
  - Response: 100ms
```

### Async Multi-Agent Sync

```
Client generates: operation_id = "op_5678"
Syncing to 3 agents...

For each agent:
1. Protocol Request Event (agent_a, agent_b, agent_c)
2. Protocol Response Event (task_id: "task_a1", "task_b1", "task_c1")
3. Status Update Events (submitted → working → completed)

UI shows:
- Operation "op_5678": sync_creatives
  - 3 agents: agent_a, agent_b, agent_c
  - Status: 2 completed, 1 working
  - 9 total events
  - Expandable timeline per agent
```

## Reconciliation (Future Enhancement)

For handling dropped webhooks or timeouts:

```typescript
// Periodic reconciliation job (every 5 minutes)
async function reconcile() {
  // Get operations with pending tasks
  const operations = eventStore.getOperations(sessionId);
  const pending = operations.filter(op =>
    op.status === 'submitted' || op.status === 'working'
  );

  // For each pending operation, call listTasks() on agents
  for (const op of pending) {
    for (const agentId of op.agents) {
      const serverTasks = await agent.listTasks();

      // Compare with our events, emit corrections
      // ...
    }
  }
}
```

## Benefits

1. **No Database Required** - Testing UI works out of the box
2. **Library Independence** - Library doesn't know about persistence
3. **Flexible Storage** - Consumers can persist to Postgres, ClickHouse, etc
4. **Real-time Updates** - Events stream as they happen
5. **Multi-Agent Visibility** - See all operations across agents
6. **Debugging** - Full protocol-level visibility

## Next Steps

1. Wire up event emitters in TaskExecutor
2. Update server to handle session context
3. Add event API endpoints
4. Build UI components for event feed
5. Test with multi-agent async operations
6. Add reconciliation logic (optional)

## Migration to Postgres (Optional)

If testing UI needs persistence:

```typescript
import { createTaskEventStore } from './TaskEventStore';
import { PostgresEventStore } from './PostgresEventStore';  // NEW

const eventStore = process.env.DATABASE_URL
  ? new PostgresEventStore(process.env.DATABASE_URL)
  : createTaskEventStore();  // Fallback to in-memory
```

Same interface, different backend!
