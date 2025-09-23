# ADCP Async Execution API Reference

## Overview

This document provides comprehensive API reference for the ADCP TypeScript client library's async execution model introduced in PR #78. It covers all types, interfaces, classes, and methods available for implementing handler-controlled async patterns.

## Table of Contents

1. [Core Types](#core-types)
2. [Task Execution](#task-execution)
3. [Handler Types](#handler-types)
4. [Async Patterns](#async-patterns)
5. [Error Types](#error-types)
6. [Utility Functions](#utility-functions)
7. [Configuration](#configuration)

---

## Core Types

### Message

Represents a single message in a conversation with an agent.

```typescript
interface Message {
  /** Unique identifier for this message */
  id: string;
  /** Role of the message sender */
  role: 'user' | 'agent' | 'system';
  /** Message content - can be structured or text */
  content: any;
  /** Timestamp when message was created */
  timestamp: string;
  /** Optional metadata about the message */
  metadata?: {
    /** Tool/task name if this message is tool-related */
    toolName?: string;
    /** Message type (request, response, clarification, etc.) */
    type?: string;
    /** Additional context data */
    [key: string]: any;
  };
}
```

**Usage:**
```typescript
const message: Message = {
  id: 'msg-123',
  role: 'user',
  content: { tool: 'getProducts', params: { brief: 'Campaign brief' } },
  timestamp: '2024-01-01T12:00:00Z',
  metadata: { toolName: 'getProducts', type: 'request' }
};
```

### InputRequest

Request for input from the agent when clarification is needed.

```typescript
interface InputRequest {
  /** Human-readable question or prompt */
  question: string;
  /** Specific field being requested (if applicable) */
  field?: string;
  /** Expected type of response */
  expectedType?: 'string' | 'number' | 'boolean' | 'object' | 'array';
  /** Suggested values or options */
  suggestions?: any[];
  /** Whether this input is required */
  required?: boolean;
  /** Validation rules for the input */
  validation?: {
    min?: number;
    max?: number;
    pattern?: string;
    enum?: any[];
  };
  /** Additional context about why this input is needed */
  context?: string;
}
```

**Usage:**
```typescript
const inputRequest: InputRequest = {
  question: 'What is your budget for this campaign?',
  field: 'budget',
  expectedType: 'number',
  suggestions: [25000, 50000, 100000],
  required: true,
  validation: { min: 1000, max: 1000000 },
  context: 'Budget is needed to find appropriate advertising products'
};
```

### ConversationContext

Complete conversation context provided to input handlers.

```typescript
interface ConversationContext {
  /** Full conversation history for this task */
  messages: Message[];
  /** Current input request from the agent */
  inputRequest: InputRequest;
  /** Unique task identifier */
  taskId: string;
  /** Agent configuration */
  agent: {
    id: string;
    name: string;
    protocol: 'mcp' | 'a2a';
  };
  /** Current clarification attempt number (1-based) */
  attempt: number;
  /** Maximum allowed clarification attempts */
  maxAttempts: number;
  
  /** Helper method to defer task to human */
  deferToHuman(): Promise<{ defer: true; token: string }>;
  
  /** Helper method to abort the task */
  abort(reason?: string): never;
  
  /** Get conversation summary for context */
  getSummary(): string;
  
  /** Check if a field was previously discussed */
  wasFieldDiscussed(field: string): boolean;
  
  /** Get previous response for a field */
  getPreviousResponse(field: string): any;
}
```

**Usage:**
```typescript
const handler: InputHandler = async (context: ConversationContext) => {
  console.log(`Question: ${context.inputRequest.question}`);
  console.log(`Attempt: ${context.attempt}/${context.maxAttempts}`);
  console.log(`Agent: ${context.agent.name}`);
  
  if (context.attempt > 2) {
    return context.deferToHuman();
  }
  
  if (context.inputRequest.field === 'budget') {
    return 50000;
  }
  
  return context.abort('Unsupported field');
};
```

---

## Task Execution

### TaskExecutor

Core task execution engine that handles the conversation loop with agents.

```typescript
class TaskExecutor {
  constructor(config?: {
    /** Default timeout for 'working' status (max 120s per PR #78) */
    workingTimeout?: number;
    /** Default max clarification attempts */
    defaultMaxClarifications?: number;
    /** Enable conversation storage */
    enableConversationStorage?: boolean;
    /** Webhook manager for submitted tasks */
    webhookManager?: WebhookManager;
    /** Storage for deferred task state */
    deferredStorage?: Storage<DeferredTaskState>;
  });

  /** Execute a task with an agent using PR #78 async patterns */
  executeTask<T = any>(
    agent: AgentConfig,
    taskName: string,
    params: any,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<T>>;

  /** List all active tasks for an agent */
  listTasks(agent: AgentConfig): Promise<TaskInfo[]>;

  /** Get status of a specific task */
  getTaskStatus(agent: AgentConfig, taskId: string): Promise<TaskInfo>;

  /** Poll task until completion */
  pollTaskCompletion<T>(
    agent: AgentConfig,
    taskId: string, 
    pollInterval?: number
  ): Promise<TaskResult<T>>;

  /** Resume a deferred task */
  resumeDeferredTask<T>(token: string, input: any): Promise<TaskResult<T>>;

  /** Get conversation history for a task */
  getConversationHistory(taskId: string): Message[] | undefined;

  /** Clear conversation history for a task */
  clearConversationHistory(taskId: string): void;

  /** Get all active tasks */
  getActiveTasks(): TaskState[];
}
```

**Usage:**
```typescript
const executor = new TaskExecutor({
  workingTimeout: 120000,
  enableConversationStorage: true
});

const result = await executor.executeTask(
  agent,
  'getProducts',
  { brief: 'Campaign brief' },
  handler,
  { timeout: 30000 }
);
```

### TaskOptions

Configuration options for task execution.

```typescript
interface TaskOptions {
  /** Timeout for entire task (ms) */
  timeout?: number;
  /** Maximum clarification rounds before failing */
  maxClarifications?: number;
  /** Context ID to continue existing conversation */
  contextId?: string;
  /** Enable debug logging for this task */
  debug?: boolean;
  /** Additional metadata to include */
  metadata?: Record<string, any>;
}
```

### TaskResult

Result of a task execution with different status types.

```typescript
interface TaskResult<T = any> {
  /** Whether the task completed successfully */
  success: boolean;
  /** Task execution status */
  status: 'completed' | 'deferred' | 'submitted';
  /** Task result data (if successful) */
  data?: T;
  /** Error message (if failed) */
  error?: string;
  /** Deferred continuation (client needs time for input) */
  deferred?: DeferredContinuation<T>;
  /** Submitted continuation (server needs time for processing) */
  submitted?: SubmittedContinuation<T>;
  /** Task execution metadata */
  metadata: {
    taskId: string;
    taskName: string;
    agent: {
      id: string;
      name: string;
      protocol: 'mcp' | 'a2a';
    };
    /** Total execution time in milliseconds */
    responseTimeMs: number;
    /** ISO timestamp of completion */
    timestamp: string;
    /** Number of clarification rounds */
    clarificationRounds: number;
    /** Final status */
    status: TaskStatus;
  };
  /** Full conversation history */
  conversation?: Message[];
  /** Debug logs (if debug enabled) */
  debugLogs?: any[];
}
```

**Usage:**
```typescript
const result = await agent.getProducts(params, handler);

if (result.success && result.status === 'completed') {
  console.log('Products:', result.data.products);
  console.log('Execution time:', result.metadata.responseTimeMs);
} else if (result.status === 'deferred' && result.deferred) {
  const userInput = await getUserInput(result.deferred.question);
  const final = await result.deferred.resume(userInput);
} else if (result.status === 'submitted' && result.submitted) {
  const final = await result.submitted.waitForCompletion();
}
```

### TaskInfo

Task tracking information from tasks/get endpoint.

```typescript
interface TaskInfo {
  /** Task ID */
  taskId: string;
  /** Current status */
  status: string;
  /** Task type/name */
  taskType: string;
  /** Creation timestamp */
  createdAt: number;
  /** Last update timestamp */
  updatedAt: number;
  /** Task result (if completed) */
  result?: any;
  /** Error message (if failed) */
  error?: string;
  /** Webhook URL (if applicable) */
  webhookUrl?: string;
}
```

---

## Handler Types

### InputHandler

Function signature for input handlers.

```typescript
type InputHandler = (context: ConversationContext) => InputHandlerResponse;
```

### InputHandlerResponse

Different types of responses an input handler can provide.

```typescript
type InputHandlerResponse = 
  | any                              // Direct answer
  | Promise<any>                     // Async answer  
  | { defer: true; token: string }   // Defer to human
  | { abort: true; reason?: string } // Abort task
  | never;                           // For control flow (abort() helper)
```

**Usage:**
```typescript
// Direct response
const simpleHandler: InputHandler = (context) => {
  if (context.inputRequest.field === 'budget') return 50000;
  return true;
};

// Async response
const asyncHandler: InputHandler = async (context) => {
  const data = await fetchExternalData();
  return data.recommendation;
};

// Defer response
const deferHandler: InputHandler = (context) => {
  if (context.inputRequest.field === 'approval') {
    return { defer: true, token: `approval-${Date.now()}` };
  }
  return true;
};

// Abort response
const abortHandler: InputHandler = (context) => {
  if (context.attempt > 3) {
    return { abort: true, reason: 'Too many attempts' };
  }
  return true;
};
```

### Pre-built Handlers

#### autoApproveHandler

```typescript
const autoApproveHandler: InputHandler;
```

Always returns `true` for any input request.

**Usage:**
```typescript
const result = await agent.getProducts(params, autoApproveHandler);
```

#### deferAllHandler

```typescript
const deferAllHandler: InputHandler;
```

Always defers to human for every input request.

**Usage:**
```typescript
const result = await agent.getProducts(params, deferAllHandler);
if (result.status === 'deferred') {
  // Handle human approval workflow
}
```

### Handler Factory Functions

#### createFieldHandler

```typescript
function createFieldHandler(
  fieldMap: FieldHandlerConfig,
  defaultResponse?: any | InputHandler
): InputHandler;

interface FieldHandlerConfig {
  [fieldName: string]: any | ((context: ConversationContext) => any);
}
```

Create a field-specific handler that provides different responses based on the field being requested.

**Usage:**
```typescript
const handler = createFieldHandler({
  budget: 50000,
  targeting: ['US', 'CA'],
  approval: (context) => context.attempt === 1,
  creative_format: 'video'
}, deferAllHandler); // Default for unmapped fields
```

#### createConditionalHandler

```typescript
function createConditionalHandler(
  conditions: Array<{
    condition: (context: ConversationContext) => boolean;
    handler: InputHandler;
  }>,
  defaultHandler?: InputHandler
): InputHandler;
```

Create a conditional handler that applies different logic based on context conditions.

**Usage:**
```typescript
const handler = createConditionalHandler([
  {
    condition: (ctx) => ctx.inputRequest.field === 'budget',
    handler: (ctx) => ctx.agent.name.includes('Premium') ? 100000 : 50000
  },
  {
    condition: (ctx) => ctx.attempt > 2,
    handler: (ctx) => ctx.deferToHuman()
  }
], autoApproveHandler);
```

#### createRetryHandler

```typescript
function createRetryHandler(
  responses: any[],
  defaultResponse?: any | InputHandler
): InputHandler;
```

Create a retry handler that provides different responses based on attempt number.

**Usage:**
```typescript
const handler = createRetryHandler([
  100000,  // First attempt
  75000,   // Second attempt
  50000    // Third attempt
], deferAllHandler);
```

#### createSuggestionHandler

```typescript
function createSuggestionHandler(
  suggestionIndex?: number,
  fallbackHandler?: InputHandler
): InputHandler;
```

Create a suggestion-based handler that uses agent suggestions when available.

**Usage:**
```typescript
const handler = createSuggestionHandler(0, deferAllHandler); // Use first suggestion
const lastHandler = createSuggestionHandler(-1, deferAllHandler); // Use last suggestion
```

#### createValidatedHandler

```typescript
function createValidatedHandler(
  value: any,
  fallbackHandler?: InputHandler
): InputHandler;
```

Create a validation-aware handler that respects input validation rules.

**Usage:**
```typescript
const handler = createValidatedHandler(75000, deferAllHandler);
// Will check validation rules before returning the value
```

#### combineHandlers

```typescript
function combineHandlers(
  handlers: InputHandler[],
  defaultHandler?: InputHandler
): InputHandler;
```

Combine multiple handlers with fallback logic.

**Usage:**
```typescript
const handler = combineHandlers([
  createFieldHandler({ budget: 50000 }),
  createSuggestionHandler(0),
  autoApproveHandler
], deferAllHandler);
```

---

## Async Patterns

### DeferredContinuation

Continuation for deferred client tasks (client needs time).

```typescript
interface DeferredContinuation<T> {
  /** Token for resuming the task */
  token: string;
  /** Question that triggered the deferral */
  question?: string;
  /** Resume the task with user input */
  resume: (input: any) => Promise<TaskResult<T>>;
}
```

**Usage:**
```typescript
const result = await agent.getProducts(params, handler);

if (result.status === 'deferred' && result.deferred) {
  console.log(`Deferred: ${result.deferred.question}`);
  
  // Later, when human provides input
  const userInput = await getUserApproval();
  const final = await result.deferred.resume(userInput);
}
```

### SubmittedContinuation

Continuation for submitted server tasks (server needs time).

```typescript
interface SubmittedContinuation<T> {
  /** Task ID for tracking */
  taskId: string;
  /** Webhook URL where server will notify completion */
  webhookUrl?: string;
  /** Get current task status */
  track: () => Promise<TaskInfo>;
  /** Wait for completion with polling */
  waitForCompletion: (pollInterval?: number) => Promise<TaskResult<T>>;
}
```

**Usage:**
```typescript
const result = await agent.createMediaBuy(params, handler);

if (result.status === 'submitted' && result.submitted) {
  console.log(`Task submitted: ${result.submitted.taskId}`);
  
  // Option 1: Webhook handling
  if (result.submitted.webhookUrl) {
    setupWebhookHandler(result.submitted.webhookUrl);
  }
  
  // Option 2: Polling
  const final = await result.submitted.waitForCompletion(30000); // Poll every 30s
  
  // Option 3: Manual tracking
  const status = await result.submitted.track();
  console.log('Current status:', status.status);
}
```

### ADCP Status Constants

```typescript
const ADCP_STATUS = {
  SUBMITTED: 'submitted',        // Long-running (hours/days) - webhook required
  WORKING: 'working',            // Processing (<120s) - keep connection open  
  INPUT_REQUIRED: 'input-required', // Needs user input via handler
  COMPLETED: 'completed',        // Task completed successfully
  FAILED: 'failed',             // Task failed
  CANCELED: 'canceled',         // Task was canceled
  REJECTED: 'rejected',         // Task was rejected
  AUTH_REQUIRED: 'auth-required', // Authentication required
  UNKNOWN: 'unknown'            // Unknown status
} as const;

type ADCPStatus = typeof ADCP_STATUS[keyof typeof ADCP_STATUS];
```

---

## Error Types

### InputRequiredError

Thrown when server requires input but no handler is provided.

```typescript
class InputRequiredError extends Error {
  constructor(question: string);
}
```

**Usage:**
```typescript
try {
  const result = await agent.getProducts(params); // No handler provided
} catch (error) {
  if (error instanceof InputRequiredError) {
    console.log('Missing handler for:', error.message);
  }
}
```

### TaskTimeoutError

Thrown when a task exceeds the working timeout (120 seconds).

```typescript
class TaskTimeoutError extends Error {
  constructor(taskId: string, timeout: number);
}
```

**Usage:**
```typescript
try {
  const result = await agent.complexAnalysis(params, handler);
} catch (error) {
  if (error instanceof TaskTimeoutError) {
    console.log('Task timed out - consider using submitted pattern');
  }
}
```

### MaxClarificationError

Thrown when a task exceeds maximum clarification attempts.

```typescript
class MaxClarificationError extends Error {
  constructor(taskId: string, maxAttempts: number);
}
```

**Usage:**
```typescript
try {
  const result = await agent.getProducts(params, handler);
} catch (error) {
  if (error instanceof MaxClarificationError) {
    console.log('Too many clarifications - improve handler logic');
  }
}
```

### DeferredTaskError

Thrown when a task is deferred (normal flow for deferred tasks).

```typescript
class DeferredTaskError extends Error {
  constructor(public token: string);
}
```

**Usage:**
```typescript
try {
  // This would be internal library usage
  const result = await internalTaskExecution();
} catch (error) {
  if (error instanceof DeferredTaskError) {
    console.log('Task deferred with token:', error.token);
  }
}
```

---

## Utility Functions

### Type Guards

#### isDeferResponse

```typescript
function isDeferResponse(response: any): response is { defer: true; token: string };
```

Check if a response is a defer response.

#### isAbortResponse

```typescript
function isAbortResponse(response: any): response is { abort: true; reason?: string };
```

Check if a response is an abort response.

### Response Handling

#### normalizeHandlerResponse

```typescript
async function normalizeHandlerResponse(
  response: InputHandlerResponse,
  context: ConversationContext
): Promise<any>;
```

Utility to normalize handler responses.

---

## Configuration

### AgentConfig

Configuration for individual agents.

```typescript
interface AgentConfig {
  /** Unique agent identifier */
  id: string;
  /** Human-readable agent name */
  name: string;
  /** Agent endpoint URL */
  agent_uri: string;
  /** Protocol type */
  protocol: 'mcp' | 'a2a';
  /** Whether authentication is required */
  requiresAuth?: boolean;
  /** Environment variable containing auth token */
  auth_token_env?: string;
}
```

### ConversationConfig

Configuration for conversation management.

```typescript
interface ConversationConfig {
  /** Maximum messages to keep in history */
  maxHistorySize?: number;
  /** Whether to persist conversations */
  persistConversations?: boolean;
  /** Timeout for 'working' status (max 120s per PR #78) */
  workingTimeout?: number;
  /** Default max clarifications */
  defaultMaxClarifications?: number;
}
```

### Storage Interfaces

#### Storage

Generic storage interface for persistence.

```typescript
interface Storage<T> {
  get(key: string): Promise<T | undefined>;
  set(key: string, value: T, ttl?: number): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
  clear(): Promise<void>;
}
```

#### WebhookManager

Interface for webhook management in submitted tasks.

```typescript
interface WebhookManager {
  generateUrl(taskId: string): string;
  registerWebhook(agent: AgentConfig, taskId: string, webhookUrl: string): Promise<void>;
  processWebhook(token: string, body: any): Promise<void>;
}
```

---

## Usage Examples

### Complete Task Execution Example

```typescript
import { 
  ADCPMultiAgentClient,
  TaskExecutor,
  createFieldHandler,
  createConditionalHandler,
  InputRequiredError,
  TaskTimeoutError
} from '@adcp/client';

// Setup
const client = ADCPMultiAgentClient.fromConfig();
const executor = new TaskExecutor({
  workingTimeout: 120000,
  enableConversationStorage: true
});

// Create sophisticated handler
const handler = createConditionalHandler([
  {
    condition: (ctx) => ctx.inputRequest.field === 'budget',
    handler: createFieldHandler({
      budget: (ctx) => ctx.agent.name.includes('Premium') ? 100000 : 50000
    })
  },
  {
    condition: (ctx) => ctx.attempt > 2,
    handler: (ctx) => ctx.deferToHuman()
  }
], autoApproveHandler);

// Execute task with full error handling
async function executeTaskWithHandling() {
  try {
    const result = await executor.executeTask(
      agent,
      'getProducts',
      { brief: 'Campaign brief' },
      handler,
      { timeout: 30000, debug: true }
    );

    switch (result.status) {
      case 'completed':
        console.log('Products:', result.data.products);
        break;
        
      case 'deferred':
        const userInput = await getUserInput(result.deferred.question);
        const final = await result.deferred.resume(userInput);
        console.log('Final result:', final.data);
        break;
        
      case 'submitted':
        const completed = await result.submitted.waitForCompletion(60000);
        console.log('Submitted task completed:', completed.data);
        break;
    }

  } catch (error) {
    if (error instanceof InputRequiredError) {
      console.error('Handler required:', error.message);
    } else if (error instanceof TaskTimeoutError) {
      console.error('Task timeout:', error.message);
    } else {
      console.error('Unexpected error:', error.message);
    }
  }
}
```

This API reference provides complete documentation for implementing robust ADCP async execution patterns with proper error handling, type safety, and production-ready features.