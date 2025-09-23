# ADCP Async Execution Developer Guide

## Overview

The ADCP TypeScript client library v2.0 introduces a sophisticated async execution model that handles the four distinct patterns defined in PR #78. This guide explains when and how to use each pattern effectively.

## The Four Async Patterns

### 1. Completed Pattern (`status: "completed"`)

**When it happens**: Task finishes immediately with results  
**Client action**: Use the data directly  
**Use cases**: Simple queries, cached data, fast operations

```typescript
import { ADCPMultiAgentClient, createFieldHandler } from '@adcp/client';

const client = ADCPMultiAgentClient.fromConfig();
const agent = client.agent('my-agent');

const result = await agent.getProducts({
  brief: 'Coffee campaign for millennials'
});

if (result.status === 'completed' && result.success) {
  console.log(`Found ${result.data.products.length} products`);
  console.log(`Execution time: ${result.metadata.responseTimeMs}ms`);
  
  // Use the data immediately
  const products = result.data.products;
  return products;
}
```

**Key characteristics**:
- ✅ Immediate response with data
- ✅ No additional polling or waiting required
- ✅ Lowest latency pattern
- ✅ Most common for simple operations

### 2. Working Pattern (`status: "working"`)

**When it happens**: Server is processing, keeps connection open (≤120 seconds)  
**Client action**: Wait for completion via SSE/polling  
**Use cases**: Complex calculations, data processing, model inference

```typescript
const result = await agent.getProducts({
  brief: 'Complex multi-variable campaign optimization'
});

// The TaskExecutor automatically handles working status
if (result.status === 'completed') {
  console.log('Processing completed:', result.data);
} else {
  console.error('Processing failed or timed out:', result.error);
}
```

**Behind the scenes** (handled automatically by TaskExecutor):
```typescript
// Internal implementation - you don't need to write this
async function handleWorkingStatus(agent, taskId) {
  const deadline = Date.now() + 120000; // 120 second limit
  
  while (Date.now() < deadline) {
    const status = await executor.getTaskStatus(agent, taskId);
    
    if (status.status === 'completed') {
      return { success: true, data: status.result };
    }
    
    if (status.status === 'failed') {
      throw new Error(status.error);
    }
    
    await sleep(2000); // Poll every 2 seconds
  }
  
  throw new TaskTimeoutError(taskId, 120000);
}
```

**Key characteristics**:
- ⏳ Automatic polling with 120-second timeout
- 🔌 Keeps connection open (SSE when available)
- 🔄 Client waits automatically
- ⚡ Good for medium-duration tasks (seconds to minutes)

### 3. Submitted Pattern (`status: "submitted"`)

**When it happens**: Long-running tasks that take hours or days  
**Client action**: Use webhooks or manual polling  
**Use cases**: Media buys, campaign creation, large data imports

```typescript
const result = await agent.createMediaBuy({
  name: 'Holiday Campaign 2024',
  budget: { amount: 100000, currency: 'USD' },
  products: selectedProducts
});

if (result.status === 'submitted' && result.submitted) {
  console.log(`Task submitted: ${result.submitted.taskId}`);
  console.log(`Webhook URL: ${result.submitted.webhookUrl}`);
  
  // Option 1: Set up webhook handling (recommended)
  if (result.submitted.webhookUrl) {
    console.log('Set up webhook endpoint to receive completion notification');
    // Your webhook endpoint will receive the completion notification
  }
  
  // Option 2: Poll for completion (for testing/simple cases)
  console.log('Polling for completion every 5 minutes...');
  const final = await result.submitted.waitForCompletion(300000); // 5 minutes
  console.log('Media buy created:', final.data);
  
  // Option 3: Track progress manually
  const status = await result.submitted.track();
  console.log(`Current status: ${status.status} (updated: ${new Date(status.updatedAt)})`);
}
```

**Webhook setup example**:
```typescript
// Express.js webhook endpoint
app.post('/webhooks/adcp/:taskId', (req, res) => {
  const { taskId } = req.params;
  const { status, result, error } = req.body;
  
  if (status === 'completed') {
    console.log(`Task ${taskId} completed:`, result);
    // Update your database, notify users, etc.
  } else if (status === 'failed') {
    console.error(`Task ${taskId} failed:`, error);
    // Handle failure, retry logic, etc.
  }
  
  res.status(200).send('OK');
});
```

**Key characteristics**:
- 📞 Webhook-based notifications (preferred)
- 🕐 Manual polling as fallback
- 📊 Progress tracking via tasks/get endpoint
- 🎯 Designed for hours/days duration
- 💾 Server maintains task state

### 4. Input Required Pattern (`status: "input-required"`)

**When it happens**: Server needs clarification or approval  
**Client action**: Handler MUST provide input  
**Use cases**: Budget approval, targeting refinement, creative approval

```typescript
import { 
  createFieldHandler, 
  createConditionalHandler,
  InputRequiredError 
} from '@adcp/client';

// Simple field-based handler
const simpleHandler = createFieldHandler({
  budget: 75000,
  targeting: ['US', 'CA', 'UK'],
  approval: true
});

// Advanced conditional handler
const smartHandler = createConditionalHandler([
  {
    condition: (ctx) => ctx.inputRequest.field === 'budget',
    handler: (ctx) => {
      // Dynamic budget based on agent
      if (ctx.agent.name.includes('Premium')) return 100000;
      return 50000;
    }
  },
  {
    condition: (ctx) => ctx.inputRequest.field === 'final_approval',
    handler: (ctx) => {
      // Defer expensive approvals to human
      if (ctx.getPreviousResponse('budget') > 75000) {
        return { defer: true, token: `approval-${Date.now()}` };
      }
      return true;
    }
  }
], deferAllHandler); // Fallback: defer everything else

try {
  const result = await agent.getProducts({
    brief: 'Luxury product campaign'
  }, smartHandler);
  
  if (result.status === 'completed') {
    console.log('Products found:', result.data.products);
  } else if (result.status === 'deferred' && result.deferred) {
    console.log(`Deferred for human approval: ${result.deferred.question}`);
    
    // Later, when human provides input...
    const userDecision = await showApprovalDialog(result.deferred.question);
    const final = await result.deferred.resume(userDecision);
    console.log('Final result:', final.data);
  }
  
} catch (error) {
  if (error instanceof InputRequiredError) {
    console.error('Handler missing for required input:', error.message);
    // This means you need to provide a handler for the call
  }
}
```

**Handler patterns**:
```typescript
// Pattern 1: Auto-approve everything
import { autoApproveHandler } from '@adcp/client';
const result = await agent.getProducts(params, autoApproveHandler);

// Pattern 2: Defer everything to human
import { deferAllHandler } from '@adcp/client';
const result = await agent.getProducts(params, deferAllHandler);

// Pattern 3: Field-specific responses
const handler = createFieldHandler({
  budget: 50000,
  targeting: ['US'],
  approval: (ctx) => ctx.attempt === 1 // Only approve first attempt
});

// Pattern 4: Conditional logic
const handler = createConditionalHandler([
  {
    condition: (ctx) => ctx.inputRequest.suggestions?.length > 0,
    handler: createSuggestionHandler(0) // Use first suggestion
  },
  {
    condition: (ctx) => ctx.attempt > 2,
    handler: (ctx) => ctx.abort('Too many attempts')
  }
]);

// Pattern 5: Validation-aware
const handler = createValidatedHandler(75000, deferAllHandler);
```

**Key characteristics**:
- ⚠️ Handler is MANDATORY (throws InputRequiredError if missing)
- 🎯 Handler has full conversation context
- 🔄 Supports multiple clarification rounds
- 👤 Can defer to human via `{ defer: true, token }`
- 🛑 Can abort task via `{ abort: true, reason }`

## Advanced Scenarios

### Multi-Step Conversations

```typescript
async function createCampaignWithApprovals(brief: string) {
  const approvalHandler = createConditionalHandler([
    {
      condition: (ctx) => ctx.inputRequest.field === 'budget',
      handler: async (ctx) => {
        // First check: auto-approve reasonable budgets
        if (ctx.inputRequest.suggestions?.some(s => s <= 50000)) {
          return Math.min(...ctx.inputRequest.suggestions);
        }
        
        // Second check: defer expensive budgets
        return { defer: true, token: `budget-approval-${Date.now()}` };
      }
    },
    {
      condition: (ctx) => ctx.inputRequest.field === 'targeting',
      handler: (ctx) => {
        // Use intelligent defaults based on brief
        if (brief.includes('US')) return ['US'];
        if (brief.includes('global')) return ['US', 'UK', 'CA', 'AU'];
        return ['US', 'CA']; // Safe default
      }
    },
    {
      condition: (ctx) => ctx.inputRequest.field === 'creative_approval',
      handler: (ctx) => {
        // Always defer creative approvals
        return { defer: true, token: `creative-${Date.now()}` };
      }
    }
  ], deferAllHandler);
  
  let result = await agent.getProducts({ brief }, approvalHandler);
  
  // Handle deferred approvals
  while (result.status === 'deferred' && result.deferred) {
    console.log(`Approval needed: ${result.deferred.question}`);
    const approval = await getUserApproval(result.deferred.question);
    result = await result.deferred.resume(approval);
  }
  
  return result;
}
```

### Parallel Multi-Agent with Different Handlers

```typescript
async function compareAgentCapabilities(brief: string) {
  // Different handlers for different agent types
  const premiumHandler = createFieldHandler({
    budget: 100000, // Higher budget for premium agents
    approval: true
  });
  
  const budgetHandler = createFieldHandler({
    budget: 25000,  // Lower budget for budget agents
    approval: (ctx) => ctx.attempt === 1 // Only approve first try
  });
  
  const conditionalHandler = (agentId: string) => 
    createConditionalHandler([
      {
        condition: (ctx) => agentId.includes('premium'),
        handler: premiumHandler
      },
      {
        condition: (ctx) => agentId.includes('budget'),
        handler: budgetHandler
      }
    ], deferAllHandler);
  
  // Execute with agent-specific handlers
  const results = await Promise.all(
    client.getAllAgents().map(async (agentId) => {
      const agent = client.agent(agentId);
      const handler = conditionalHandler(agentId);
      
      try {
        return await agent.getProducts({ brief }, handler);
      } catch (error) {
        return { success: false, agentId, error: error.message };
      }
    })
  );
  
  // Process results by type
  const completed = results.filter(r => r.status === 'completed');
  const submitted = results.filter(r => r.status === 'submitted');
  const deferred = results.filter(r => r.status === 'deferred');
  
  console.log(`${completed.length} completed, ${submitted.length} submitted, ${deferred.length} deferred`);
  
  return { completed, submitted, deferred };
}
```

### Task Tracking and Management

```typescript
import { TaskExecutor } from '@adcp/client';

const executor = new TaskExecutor({
  workingTimeout: 120000,
  enableConversationStorage: true,
  webhookManager: new CustomWebhookManager(),
  deferredStorage: new RedisStorage()
});

async function manageTaskLifecycle() {
  // List all active tasks
  const activeTasks = await executor.listTasks(agent);
  console.log(`Found ${activeTasks.length} active tasks`);
  
  activeTasks.forEach(async (task) => {
    console.log(`Task ${task.taskId}: ${task.status} (${task.taskType})`);
    
    if (task.status === 'working') {
      console.log(`  Working since: ${new Date(task.createdAt)}`);
    } else if (task.status === 'submitted') {
      console.log(`  Submitted for long processing`);
      console.log(`  Webhook: ${task.webhookUrl}`);
    }
  });
  
  // Get specific task details
  const taskId = 'specific-task-id';
  const taskInfo = await executor.getTaskStatus(agent, taskId);
  
  if (taskInfo.status === 'completed') {
    console.log('Task completed:', taskInfo.result);
  } else if (taskInfo.status === 'failed') {
    console.error('Task failed:', taskInfo.error);
  }
}
```

## Best Practices

### 1. Handler Design
- **Start simple**: Use `createFieldHandler` for basic cases
- **Add conditions**: Use `createConditionalHandler` for complex logic
- **Handle failures**: Always provide fallback behavior
- **Test thoroughly**: Test with different conversation flows

### 2. Error Handling
```typescript
import { 
  InputRequiredError,
  TaskTimeoutError,
  MaxClarificationError 
} from '@adcp/client';

async function robustTaskExecution(params, handler) {
  try {
    const result = await agent.getProducts(params, handler);
    return handleSuccess(result);
    
  } catch (error) {
    if (error instanceof InputRequiredError) {
      // Handler was required but not provided
      console.error('Missing handler:', error.message);
      return { error: 'HANDLER_REQUIRED', message: error.message };
      
    } else if (error instanceof TaskTimeoutError) {
      // Working task exceeded 120 seconds
      console.error('Task timeout:', error.message);
      return { error: 'TIMEOUT', suggestion: 'Consider using submitted tasks for long operations' };
      
    } else if (error instanceof MaxClarificationError) {
      // Too many clarification rounds
      console.error('Too many clarifications:', error.message);
      return { error: 'TOO_MANY_CLARIFICATIONS', suggestion: 'Improve handler logic' };
      
    } else {
      // Network, auth, or other errors
      console.error('Unexpected error:', error.message);
      return { error: 'UNKNOWN', message: error.message };
    }
  }
}
```

### 3. Performance Optimization
- **Use completed pattern**: For fast operations
- **Batch operations**: Group related tasks when possible
- **Cache handlers**: Reuse handler instances
- **Monitor timeouts**: Adjust working timeout based on agent performance

### 4. Testing Strategies
```typescript
// Mock different response patterns for testing
async function testAsyncPatterns() {
  const mockAgent = createMockAgent();
  
  // Test completed pattern
  mockAgent.setResponse('completed', { products: [...] });
  const completed = await agent.getProducts(params, handler);
  expect(completed.status).toBe('completed');
  
  // Test working pattern
  mockAgent.setResponse('working', { taskId: 'task-123' });
  const working = await agent.getProducts(params, handler);
  // Verify polling behavior
  
  // Test submitted pattern
  mockAgent.setResponse('submitted', { 
    taskId: 'task-456', 
    webhookUrl: 'https://webhook.example.com/task-456' 
  });
  const submitted = await agent.getProducts(params, handler);
  expect(submitted.status).toBe('submitted');
  expect(submitted.submitted).toBeDefined();
  
  // Test input required pattern
  mockAgent.setResponse('input-required', {
    question: 'What is your budget?',
    field: 'budget'
  });
  const inputRequired = await agent.getProducts(params, handler);
  // Verify handler was called
}
```

### 5. Monitoring and Observability
```typescript
const client = new ADCPMultiAgentClient(agents, {
  debug: true,
  debugCallback: (log) => {
    // Send to your monitoring system
    if (log.level === 'error') {
      monitoring.recordError(log.message, log.context);
    } else {
      monitoring.recordTrace(log.message, log.context);
    }
  }
});

// Monitor task patterns
const result = await agent.getProducts(params, handler, { debug: true });

console.log(`Pattern: ${result.status}`);
console.log(`Duration: ${result.metadata.responseTimeMs}ms`);
console.log(`Clarifications: ${result.metadata.clarificationRounds}`);

if (result.debugLogs) {
  result.debugLogs.forEach(log => {
    console.log(`[${log.type}] ${log.method}:`, log.body);
  });
}
```

This developer guide provides the foundation for effective use of the async execution patterns. Each pattern serves specific use cases and requires different handling strategies. Understanding when and how to use each pattern will help you build robust, efficient ADCP integrations.