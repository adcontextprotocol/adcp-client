# ADCP Async Execution Migration Guide

## Overview

This guide helps you migrate from the old synchronous ADCP client patterns to the new handler-controlled async execution model introduced in PR #78. The new model provides better control over long-running tasks, clearer error handling, and proper support for human-in-the-loop workflows.

## Key Changes in PR #78

### 1. Handler-Controlled Flow
**Old**: Complex configuration objects and timeout management  
**New**: Input handlers are mandatory for server input requests

```typescript
// ❌ Old Pattern
const result = await client.agent('my-agent').getProducts({
  brief: 'Coffee campaign'
}, {
  maxClarifications: 3,
  autoApprove: true,
  timeout: 120000
});

// ✅ New Pattern
import { createFieldHandler } from '@adcp/client';

const handler = createFieldHandler({
  budget: 50000,
  targeting: ['US', 'CA'],
  approval: true
});

const result = await client.agent('my-agent').getProducts({
  brief: 'Coffee campaign'
}, handler);
```

### 2. Clear Async Patterns
**Old**: Unclear status handling and timeout management  
**New**: Four distinct patterns with clear semantics

| Pattern | Status | Description | Client Action |
|---------|--------|-------------|---------------|
| **Completed** | `completed` | Task finished immediately | Use `result.data` |
| **Working** | `working` | Server processing (≤120s) | Keep connection open |
| **Submitted** | `submitted` | Long-running (hours/days) | Use webhook/polling |
| **Input Required** | `input-required` | Handler mandatory | Handler provides input |

### 3. Type-Safe Continuations
**Old**: Manual polling and state management  
**New**: Structured continuation objects

```typescript
// ❌ Old Pattern - Manual polling
let status = 'working';
while (status === 'working') {
  await sleep(5000);
  const check = await client.checkStatus(taskId);
  status = check.status;
}

// ✅ New Pattern - Structured continuations
const result = await agent.getProducts(params, handler);

if (result.status === 'submitted' && result.submitted) {
  // Long-running task - use webhook or polling
  const final = await result.submitted.waitForCompletion(30000);
} else if (result.status === 'deferred' && result.deferred) {
  // Client deferred - resume when ready
  const final = await result.deferred.resume(userInput);
}
```

## Migration Steps

### Step 1: Update Import Statements

```typescript
// ❌ Old Imports
import { AdCPClient, InputHandler } from '@adcp/client';

// ✅ New Imports
import { 
  ADCPMultiAgentClient,
  createFieldHandler,
  createConditionalHandler,
  InputRequiredError,
  type TaskResult,
  type DeferredContinuation,
  type SubmittedContinuation
} from '@adcp/client';
```

### Step 2: Replace Configuration Objects with Handlers

#### Simple Auto-Approval
```typescript
// ❌ Old Pattern
const result = await agent.getProducts(params, {
  autoApprove: true,
  maxClarifications: 5
});

// ✅ New Pattern
import { autoApproveHandler } from '@adcp/client';

const result = await agent.getProducts(params, autoApproveHandler);
```

#### Field-Specific Responses
```typescript
// ❌ Old Pattern
const result = await agent.getProducts(params, {
  fieldDefaults: {
    budget: 50000,
    targeting: ['US', 'CA']
  },
  maxClarifications: 3
});

// ✅ New Pattern
const handler = createFieldHandler({
  budget: 50000,
  targeting: ['US', 'CA']
});

const result = await agent.getProducts(params, handler);
```

#### Conditional Logic
```typescript
// ❌ Old Pattern
const result = await agent.getProducts(params, {
  approvalLogic: (context) => {
    if (context.attempt > 2) return false;
    if (context.agent.name.includes('Premium')) return true;
    return context.budget < 100000;
  }
});

// ✅ New Pattern
const handler = createConditionalHandler([
  {
    condition: (ctx) => ctx.attempt > 2,
    handler: (ctx) => ctx.abort('Too many attempts')
  },
  {
    condition: (ctx) => ctx.agent.name.includes('Premium'),
    handler: autoApproveHandler
  },
  {
    condition: (ctx) => ctx.wasFieldDiscussed('budget'),
    handler: (ctx) => ctx.getPreviousResponse('budget') < 100000
  }
], deferAllHandler);

const result = await agent.getProducts(params, handler);
```

### Step 3: Handle New Response Types

#### Working Status (Server Processing)
```typescript
// ❌ Old Pattern - No clear distinction
const result = await agent.getProducts(params, handler);
// Hope it completes or times out

// ✅ New Pattern - Clear handling
const result = await agent.getProducts(params, handler);

if (result.status === 'completed') {
  console.log('Task completed:', result.data);
} else {
  console.error('Task did not complete:', result.error);
}
```

#### Submitted Status (Long-Running Tasks)
```typescript
// ❌ Old Pattern - Manual task tracking
const taskId = await agent.submitTask(params);
// Manual polling logic...

// ✅ New Pattern - Structured submission
const result = await agent.getProducts(params, handler);

if (result.status === 'submitted' && result.submitted) {
  console.log(`Task submitted: ${result.submitted.taskId}`);
  
  // Option 1: Use webhook (recommended)
  console.log(`Webhook URL: ${result.submitted.webhookUrl}`);
  
  // Option 2: Poll for completion
  const final = await result.submitted.waitForCompletion(60000); // Poll every 60s
  console.log('Task completed:', final.data);
  
  // Option 3: Track status manually
  const status = await result.submitted.track();
  console.log('Current status:', status.status);
}
```

#### Deferred Status (Client Needs Time)
```typescript
// ❌ Old Pattern - No clean deferral mechanism
// Would typically throw errors or timeout

// ✅ New Pattern - Clean deferral and resumption
const humanApprovalHandler = (context) => {
  if (context.inputRequest.field === 'final_approval') {
    // Defer for human approval
    return { defer: true, token: `approval-${Date.now()}` };
  }
  return 'auto-approved';
};

const result = await agent.getProducts(params, humanApprovalHandler);

if (result.status === 'deferred' && result.deferred) {
  console.log(`Deferred with token: ${result.deferred.token}`);
  console.log(`Question: ${result.deferred.question}`);
  
  // Later, when human provides input...
  const userInput = await getUserApproval(); // Your UI logic
  const final = await result.deferred.resume(userInput);
  console.log('Resumed and completed:', final.data);
}
```

### Step 4: Update Error Handling

```typescript
// ❌ Old Pattern - Generic error handling
try {
  const result = await agent.getProducts(params, options);
} catch (error) {
  console.error('Task failed:', error.message);
}

// ✅ New Pattern - Specific error types
import { 
  InputRequiredError,
  TaskTimeoutError,
  MaxClarificationError,
  DeferredTaskError
} from '@adcp/client';

try {
  const result = await agent.getProducts(params, handler);
  
  if (result.success) {
    console.log('Products:', result.data.products);
  } else {
    console.error('Task failed:', result.error);
  }
  
} catch (error) {
  if (error instanceof InputRequiredError) {
    console.error('Handler required but not provided:', error.message);
    // Add a handler to your call
  } else if (error instanceof TaskTimeoutError) {
    console.error('Task timed out:', error.message);
    // Consider using submitted tasks for long-running operations
  } else if (error instanceof MaxClarificationError) {
    console.error('Too many clarifications:', error.message);
    // Improve your handler logic
  } else if (error instanceof DeferredTaskError) {
    console.log('Task deferred with token:', error.token);
    // Normal flow for deferred tasks
  } else {
    console.error('Unexpected error:', error.message);
  }
}
```

### Step 5: Update Task Tracking

```typescript
// ❌ Old Pattern - Manual task ID management
const taskId = await agent.startTask(params);
const status = await agent.getTaskStatus(taskId);

// ✅ New Pattern - Built-in task tracking
import { TaskExecutor } from '@adcp/client';

const executor = new TaskExecutor({
  workingTimeout: 120000,
  enableConversationStorage: true
});

// List all tasks
const tasks = await executor.listTasks(agent);
console.log(`Found ${tasks.length} active tasks`);

// Get specific task
const taskInfo = await executor.getTaskStatus(agent, taskId);
console.log(`Task ${taskInfo.taskId} is ${taskInfo.status}`);
```

## Common Migration Patterns

### 1. Auto-Approval with Fallback

```typescript
// ❌ Old Pattern
const result = await agent.getProducts(params, {
  autoApprove: true,
  fallbackToHuman: true,
  maxAttempts: 2
});

// ✅ New Pattern
const handler = combineHandlers([
  autoApproveHandler,
  createRetryHandler([true, false]), // Approve first, deny second
  deferAllHandler // Final fallback to human
]);

const result = await agent.getProducts(params, handler);
```

### 2. Budget-Based Conditional Approval

```typescript
// ❌ Old Pattern
const result = await agent.getProducts(params, {
  approvalLogic: (ctx) => ctx.budget && ctx.budget < 50000
});

// ✅ New Pattern
const handler = createConditionalHandler([
  {
    condition: (ctx) => ctx.inputRequest.field === 'budget',
    handler: (ctx) => 45000 // Auto-provide budget
  },
  {
    condition: (ctx) => ctx.inputRequest.field === 'approval',
    handler: (ctx) => {
      const budget = ctx.getPreviousResponse('budget');
      return budget < 50000; // Approve if budget is reasonable
    }
  }
], deferAllHandler);

const result = await agent.getProducts(params, handler);
```

### 3. Multi-Agent with Consistent Handling

```typescript
// ❌ Old Pattern
const results = await Promise.all([
  agent1.getProducts(params, options),
  agent2.getProducts(params, options),
  agent3.getProducts(params, options)
]);

// ✅ New Pattern
const handler = createFieldHandler({
  budget: 75000,
  targeting: ['US', 'CA', 'UK'],
  approval: true
});

const results = await client.allAgents().getProducts(params, handler);

// Handle different result types
results.forEach((result, index) => {
  if (result.success) {
    console.log(`Agent ${index + 1}: ${result.data.products.length} products`);
  } else if (result.status === 'submitted') {
    console.log(`Agent ${index + 1}: Submitted for long processing`);
  } else if (result.status === 'deferred') {
    console.log(`Agent ${index + 1}: Deferred for human input`);
  } else {
    console.error(`Agent ${index + 1}: Failed - ${result.error}`);
  }
});
```

## Breaking Changes Summary

### Removed Features
- ❌ Configuration objects for input handling
- ❌ `autoApprove` and `maxClarifications` options
- ❌ Implicit timeout and retry logic
- ❌ Manual task polling without structured continuations

### New Requirements
- ✅ Input handlers are mandatory for `input-required` status
- ✅ Explicit handling of `working`, `submitted`, and `deferred` statuses
- ✅ Use structured continuation objects for async operations
- ✅ Handle specific error types for better debugging

### Behavioral Changes
- **Working tasks**: Now have a strict 120-second limit with keep-alive connections
- **Submitted tasks**: Require webhook setup or explicit polling
- **Input handling**: Must be provided via handlers, no default behavior
- **Task tracking**: Built into continuation objects, no manual ID management

## Migration Checklist

- [ ] Replace configuration objects with input handlers
- [ ] Update import statements to use new types
- [ ] Handle new response status types (`working`, `submitted`, `deferred`)
- [ ] Update error handling for specific error types
- [ ] Test handler logic with different scenarios
- [ ] Update task tracking to use continuation objects
- [ ] Add webhook handling for submitted tasks (if applicable)
- [ ] Test timeout and retry scenarios
- [ ] Update documentation and examples
- [ ] Train team on new patterns

## Gradual Migration Strategy

### Phase 1: Add Handlers (Backward Compatible)
Start by adding handlers to existing calls without changing response handling:

```typescript
// Add handler but keep old response handling
const handler = createFieldHandler({ budget: 50000 });
const result = await agent.getProducts(params, handler);
// Continue with existing success/error logic
```

### Phase 2: Update Response Handling
Gradually update code to handle new response types:

```typescript
const result = await agent.getProducts(params, handler);

if (result.status === 'completed' && result.success) {
  // New pattern
  return result.data;
} else if (result.status === 'submitted') {
  // Handle submitted tasks
  return await result.submitted.waitForCompletion();
}
// Keep old error handling for now
```

### Phase 3: Full Migration
Complete the migration by updating error handling and removing deprecated patterns:

```typescript
// Full new pattern implementation
try {
  const result = await agent.getProducts(params, handler);
  return handleAsyncResult(result);
} catch (error) {
  return handleAsyncError(error);
}
```

This gradual approach allows you to migrate incrementally while maintaining system stability.