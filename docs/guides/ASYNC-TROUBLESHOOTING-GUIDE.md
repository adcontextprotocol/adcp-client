# ADCP Async Execution Troubleshooting Guide

## Overview

This guide helps you diagnose and resolve common issues when working with the ADCP async execution model. It covers debugging techniques, common error patterns, performance optimization, and monitoring strategies.

## Table of Contents

1. [Quick Diagnostic Checklist](#quick-diagnostic-checklist)
2. [Common Error Patterns](#common-error-patterns)
3. [Handler Debugging](#handler-debugging)
4. [Async Pattern Issues](#async-pattern-issues)
5. [Performance Problems](#performance-problems)
6. [Network and Protocol Issues](#network-and-protocol-issues)
7. [Monitoring and Observability](#monitoring-and-observability)
8. [Production Debugging](#production-debugging)

---

## Quick Diagnostic Checklist

When encountering issues, start with this checklist:

### ✅ Basic Validation
```typescript
// 1. Verify client configuration
const client = ADCPMultiAgentClient.fromConfig();
console.log('Available agents:', client.getAvailableAgents());

// 2. Test agent connectivity
const agent = client.agent('your-agent-id');
try {
  const health = await agent.healthCheck(); // If available
  console.log('Agent health:', health);
} catch (error) {
  console.error('Agent unreachable:', error.message);
}

// 3. Verify handler is provided for input-required scenarios
const handler = createFieldHandler({ budget: 50000 });
const result = await agent.getProducts(params, handler);
```

### ✅ Error Type Identification
```typescript
import { 
  InputRequiredError,
  TaskTimeoutError,
  MaxClarificationError,
  DeferredTaskError
} from '@adcp/client';

try {
  const result = await agent.getProducts(params, handler);
} catch (error) {
  console.log('Error type:', error.constructor.name);
  console.log('Error message:', error.message);
  
  if (error instanceof InputRequiredError) {
    console.log('❌ Missing handler for input-required status');
  } else if (error instanceof TaskTimeoutError) {
    console.log('⏰ Task exceeded working timeout (120s)');
  } else if (error instanceof MaxClarificationError) {
    console.log('🔄 Too many clarification rounds');
  }
}
```

### ✅ Response Status Validation
```typescript
const result = await agent.getProducts(params, handler);

console.log('Response status:', result.status);
console.log('Success flag:', result.success);
console.log('Metadata:', result.metadata);

if (!result.success) {
  console.log('Error details:', result.error);
  console.log('Debug logs:', result.debugLogs);
}
```

---

## Common Error Patterns

### 1. Input Required Without Handler

**Symptom**: `InputRequiredError: Server requires input but no handler provided`

```typescript
// ❌ Problem: No handler provided
const result = await agent.getProducts(params); // Missing handler

// ✅ Solution: Always provide handler for agent interactions
const handler = createFieldHandler({
  budget: 50000,
  approval: true
});
const result = await agent.getProducts(params, handler);
```

**Debug Steps**:
1. Check if the agent commonly asks for clarifications
2. Enable debug logging to see what input is being requested
3. Create a comprehensive handler that covers expected fields

```typescript
// Debug the input request
const debugHandler = async (context) => {
  console.log('Input requested:', context.inputRequest);
  console.log('Agent:', context.agent.name);
  console.log('Attempt:', context.attempt);
  console.log('Previous responses:', context.messages);
  
  // Defer to see what was requested
  return context.deferToHuman();
};

const result = await agent.getProducts(params, debugHandler);
if (result.status === 'deferred') {
  console.log('Deferred question:', result.deferred.question);
}
```

### 2. Task Timeout Errors

**Symptom**: `TaskTimeoutError: Task task-123 timed out after 120000ms`

```typescript
// ❌ Problem: Task takes longer than 120 seconds
const result = await agent.complexAnalysis(params, handler);
// Throws TaskTimeoutError

// ✅ Solution 1: Check if task returns 'submitted' status
const result = await agent.complexAnalysis(params, handler);

if (result.status === 'submitted' && result.submitted) {
  console.log('Long-running task submitted');
  
  // Use webhook or polling
  const final = await result.submitted.waitForCompletion(60000);
  console.log('Task completed:', final.data);
}

// ✅ Solution 2: Adjust working timeout (if appropriate)
const executor = new TaskExecutor({
  workingTimeout: 180000 // 3 minutes instead of 2
});
```

**Debug Steps**:
1. Check agent documentation for expected response times
2. Monitor actual task duration vs timeout
3. Consider if task should use 'submitted' pattern instead

```typescript
// Monitor task timing
const startTime = Date.now();
try {
  const result = await agent.getProducts(params, handler);
  console.log(`Task completed in ${Date.now() - startTime}ms`);
} catch (error) {
  if (error instanceof TaskTimeoutError) {
    console.log(`Task timed out after ${Date.now() - startTime}ms`);
    console.log('Consider using submitted tasks for this operation');
  }
}
```

### 3. Handler Logical Errors

**Symptom**: Handlers not behaving as expected, infinite loops, or wrong responses

```typescript
// ❌ Problem: Handler with logical error
const buggyHandler = createFieldHandler({
  budget: (context) => {
    // Bug: Always returns the same value regardless of context
    return 50000;
  },
  approval: (context) => {
    // Bug: Never approves, creating infinite loop
    return false;
  }
});

// ✅ Solution: Add context-aware logic and limits
const smartHandler = createFieldHandler({
  budget: (context) => {
    // Scale budget based on agent and attempt
    const baseBudget = 50000;
    const agentMultiplier = context.agent.name.includes('Premium') ? 1.5 : 1.0;
    const attemptPenalty = Math.pow(0.9, context.attempt - 1); // Reduce on retries
    
    return Math.floor(baseBudget * agentMultiplier * attemptPenalty);
  },
  approval: (context) => {
    // Approve first two attempts, then defer
    if (context.attempt <= 2) return true;
    return context.deferToHuman();
  }
});
```

**Debug Steps**:
1. Add logging to handlers to trace execution
2. Test handlers with different context scenarios
3. Set maximum attempt limits

```typescript
// Debug handler execution
const debugHandler = createFieldHandler({
  budget: (context) => {
    console.log(`Budget request - Attempt ${context.attempt}/${context.maxAttempts}`);
    console.log('Agent:', context.agent.name);
    console.log('Previous budget:', context.getPreviousResponse('budget'));
    
    const budget = calculateBudget(context);
    console.log('Returning budget:', budget);
    return budget;
  }
});

// Add attempt limits to prevent infinite loops
const safeHandler = createConditionalHandler([
  {
    condition: (ctx) => ctx.attempt > 3,
    handler: (ctx) => ctx.abort('Too many attempts')
  },
  // ... other conditions
], deferAllHandler);
```

### 4. Deferred Task Management Issues

**Symptom**: Lost deferred tokens, inability to resume tasks

```typescript
// ❌ Problem: Not properly handling deferred continuations
const result = await agent.getProducts(params, handler);
if (result.status === 'deferred') {
  // Token is lost when variable goes out of scope
  const token = result.deferred.token;
}

// Later...
// No way to resume the task!

// ✅ Solution: Proper deferred task storage and management
class DeferredTaskManager {
  private deferredTasks = new Map<string, any>();
  
  async handleDeferredTask(result: TaskResult) {
    if (result.status === 'deferred' && result.deferred) {
      const taskInfo = {
        token: result.deferred.token,
        question: result.deferred.question,
        resume: result.deferred.resume,
        createdAt: new Date(),
        metadata: result.metadata
      };
      
      this.deferredTasks.set(result.deferred.token, taskInfo);
      
      // Notify human/system about pending approval
      await this.notifyPendingApproval(taskInfo);
      
      return taskInfo;
    }
  }
  
  async resumeTask(token: string, userInput: any) {
    const taskInfo = this.deferredTasks.get(token);
    if (!taskInfo) {
      throw new Error(`Deferred task not found: ${token}`);
    }
    
    try {
      const result = await taskInfo.resume(userInput);
      this.deferredTasks.delete(token); // Clean up
      return result;
    } catch (error) {
      console.error('Failed to resume task:', error);
      throw error;
    }
  }
  
  getPendingTasks() {
    return Array.from(this.deferredTasks.values());
  }
}
```

---

## Handler Debugging

### 1. Handler Execution Tracing

```typescript
// Create a wrapper that logs all handler calls
function createTracingHandler(baseHandler: InputHandler, name: string): InputHandler {
  return async (context) => {
    console.log(`🔍 Handler ${name} called:`);
    console.log('  Question:', context.inputRequest.question);
    console.log('  Field:', context.inputRequest.field);
    console.log('  Attempt:', context.attempt);
    console.log('  Agent:', context.agent.name);
    
    const startTime = Date.now();
    
    try {
      const result = await baseHandler(context);
      const duration = Date.now() - startTime;
      
      console.log(`✅ Handler ${name} completed in ${duration}ms:`);
      console.log('  Result:', result);
      
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      
      console.log(`❌ Handler ${name} failed after ${duration}ms:`);
      console.log('  Error:', error.message);
      
      throw error;
    }
  };
}

// Usage
const originalHandler = createFieldHandler({ budget: 50000 });
const tracingHandler = createTracingHandler(originalHandler, 'BudgetHandler');

const result = await agent.getProducts(params, tracingHandler);
```

### 2. Context Validation

```typescript
// Validate handler context for common issues
function validateHandlerContext(context: ConversationContext): string[] {
  const issues = [];
  
  if (!context.inputRequest.question) {
    issues.push('Missing question in input request');
  }
  
  if (context.attempt > context.maxAttempts) {
    issues.push(`Attempt ${context.attempt} exceeds max ${context.maxAttempts}`);
  }
  
  if (!context.agent.id || !context.agent.name) {
    issues.push('Invalid agent information');
  }
  
  if (context.messages.length === 0) {
    issues.push('No conversation history available');
  }
  
  return issues;
}

// Use in handler
const validatingHandler = async (context: ConversationContext) => {
  const issues = validateHandlerContext(context);
  if (issues.length > 0) {
    console.warn('Handler context issues:', issues);
  }
  
  // Continue with handler logic...
  return yourHandlerLogic(context);
};
```

### 3. Handler Performance Monitoring

```typescript
class HandlerPerformanceMonitor {
  private metrics = new Map<string, {
    calls: number;
    totalTime: number;
    errors: number;
    avgTime: number;
  }>();
  
  wrap(handler: InputHandler, name: string): InputHandler {
    return async (context) => {
      const startTime = Date.now();
      
      try {
        const result = await handler(context);
        this.recordSuccess(name, Date.now() - startTime);
        return result;
      } catch (error) {
        this.recordError(name, Date.now() - startTime);
        throw error;
      }
    };
  }
  
  private recordSuccess(name: string, duration: number) {
    const metric = this.metrics.get(name) || { calls: 0, totalTime: 0, errors: 0, avgTime: 0 };
    metric.calls++;
    metric.totalTime += duration;
    metric.avgTime = metric.totalTime / metric.calls;
    this.metrics.set(name, metric);
  }
  
  private recordError(name: string, duration: number) {
    const metric = this.metrics.get(name) || { calls: 0, totalTime: 0, errors: 0, avgTime: 0 };
    metric.calls++;
    metric.errors++;
    metric.totalTime += duration;
    metric.avgTime = metric.totalTime / metric.calls;
    this.metrics.set(name, metric);
  }
  
  getMetrics() {
    return Object.fromEntries(this.metrics);
  }
  
  getSlowHandlers(thresholdMs: number = 1000) {
    return Array.from(this.metrics.entries())
      .filter(([_, metric]) => metric.avgTime > thresholdMs)
      .map(([name, metric]) => ({ name, avgTime: metric.avgTime }));
  }
}

// Usage
const monitor = new HandlerPerformanceMonitor();
const monitoredHandler = monitor.wrap(yourHandler, 'MainHandler');

// Later, check performance
console.log('Handler metrics:', monitor.getMetrics());
console.log('Slow handlers:', monitor.getSlowHandlers(500));
```

---

## Async Pattern Issues

### 1. Working Status Problems

**Issue**: Tasks stuck in 'working' status or unexpected timeouts

```typescript
// Debug working status handling
const debugWorkingStatus = async () => {
  const executor = new TaskExecutor({
    workingTimeout: 120000,
    enableConversationStorage: true
  });
  
  try {
    const result = await agent.getProducts(params, handler);
    
    if (result.status === 'completed') {
      console.log('✅ Task completed immediately');
    } else {
      console.log('❌ Expected working status but got:', result.status);
      console.log('Check if agent properly implements working status');
    }
    
  } catch (error) {
    if (error instanceof TaskTimeoutError) {
      console.log('⏰ Working timeout - check if agent should use submitted status');
      
      // Check task status manually
      const taskInfo = await executor.getTaskStatus(agent, 'task-id');
      console.log('Actual task status:', taskInfo.status);
    }
  }
};
```

**Solutions**:
- Verify agent implements proper status reporting
- Check network connectivity during long operations
- Consider if task should use 'submitted' pattern instead
- Monitor actual vs expected execution times

### 2. Submitted Status Problems

**Issue**: Webhook not received, polling failures, lost task tracking

```typescript
// Debug submitted status handling
class SubmittedTaskDebugger {
  async debugSubmittedTask(result: TaskResult) {
    if (result.status !== 'submitted' || !result.submitted) {
      console.log('❌ Expected submitted status');
      return;
    }
    
    console.log('📝 Submitted task details:');
    console.log('  Task ID:', result.submitted.taskId);
    console.log('  Webhook URL:', result.submitted.webhookUrl);
    
    // Test webhook endpoint if provided
    if (result.submitted.webhookUrl) {
      await this.testWebhookEndpoint(result.submitted.webhookUrl);
    }
    
    // Test polling mechanism
    await this.testPolling(result.submitted);
  }
  
  private async testWebhookEndpoint(webhookUrl: string) {
    try {
      // Test if webhook endpoint is reachable
      const response = await fetch(webhookUrl, { method: 'HEAD' });
      console.log('✅ Webhook endpoint reachable:', response.status);
    } catch (error) {
      console.log('❌ Webhook endpoint unreachable:', error.message);
      console.log('💡 Ensure webhook URL is publicly accessible');
    }
  }
  
  private async testPolling(submitted: SubmittedContinuation<any>) {
    try {
      console.log('🔄 Testing polling mechanism...');
      
      const status = await submitted.track();
      console.log('✅ Polling works. Current status:', status.status);
      
      if (status.status === 'working') {
        console.log('💡 Task is still processing. This is normal for submitted tasks.');
      }
      
    } catch (error) {
      console.log('❌ Polling failed:', error.message);
      console.log('💡 Check agent tasks/get endpoint implementation');
    }
  }
}

// Usage
const debugger = new SubmittedTaskDebugger();
const result = await agent.createMediaBuy(params, handler);
await debugger.debugSubmittedTask(result);
```

### 3. Status Transition Issues

**Issue**: Unexpected status changes or invalid transitions

```typescript
// Monitor status transitions
class StatusTransitionMonitor {
  private transitions = new Map<string, string[]>();
  
  recordTransition(taskId: string, fromStatus: string, toStatus: string) {
    const key = `${taskId}`;
    const history = this.transitions.get(key) || [];
    history.push(`${fromStatus} -> ${toStatus} (${new Date().toISOString()})`);
    this.transitions.set(key, history);
    
    // Check for invalid transitions
    this.validateTransition(fromStatus, toStatus);
  }
  
  private validateTransition(from: string, to: string) {
    const validTransitions = {
      'working': ['completed', 'failed', 'input-required'],
      'input-required': ['working', 'completed', 'failed'],
      'submitted': ['working', 'completed', 'failed'],
      'completed': [], // Terminal state
      'failed': [], // Terminal state
    };
    
    const allowed = validTransitions[from] || [];
    if (!allowed.includes(to)) {
      console.warn(`❌ Invalid status transition: ${from} -> ${to}`);
    }
  }
  
  getTransitionHistory(taskId: string) {
    return this.transitions.get(taskId) || [];
  }
}
```

---

## Performance Problems

### 1. Slow Handler Execution

```typescript
// Optimize handler performance
class OptimizedHandlerFactory {
  // Cache expensive computations
  private computationCache = new Map<string, any>();
  
  createCachedHandler(expensiveComputation: Function): InputHandler {
    return async (context) => {
      const cacheKey = this.generateCacheKey(context);
      
      if (this.computationCache.has(cacheKey)) {
        console.log('🚀 Using cached result');
        return this.computationCache.get(cacheKey);
      }
      
      const startTime = Date.now();
      const result = await expensiveComputation(context);
      const duration = Date.now() - startTime;
      
      console.log(`💾 Computed result in ${duration}ms, caching...`);
      this.computationCache.set(cacheKey, result);
      
      return result;
    };
  }
  
  private generateCacheKey(context: ConversationContext): string {
    return `${context.agent.id}-${context.inputRequest.field}-${context.attempt}`;
  }
  
  // Async timeout wrapper
  createTimeoutHandler(handler: InputHandler, timeoutMs: number): InputHandler {
    return async (context) => {
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Handler timeout')), timeoutMs)
      );
      
      try {
        return await Promise.race([handler(context), timeoutPromise]);
      } catch (error) {
        console.warn('Handler timed out, using fallback');
        return context.deferToHuman();
      }
    };
  }
}
```

### 2. Memory Leaks in Long-Running Applications

```typescript
// Prevent memory leaks in conversation storage
class MemoryEfficientTaskExecutor extends TaskExecutor {
  private readonly maxConversationAge = 24 * 60 * 60 * 1000; // 24 hours
  private readonly maxConversationCount = 1000;
  
  constructor(config: any) {
    super(config);
    
    // Periodic cleanup
    setInterval(() => this.cleanup(), 60 * 60 * 1000); // Every hour
  }
  
  private cleanup() {
    const now = Date.now();
    const conversations = this.getConversationStorage();
    
    if (!conversations) return;
    
    let cleaned = 0;
    
    // Remove old conversations
    for (const [taskId, messages] of conversations.entries()) {
      const lastMessage = messages[messages.length - 1];
      const age = now - new Date(lastMessage.timestamp).getTime();
      
      if (age > this.maxConversationAge) {
        conversations.delete(taskId);
        cleaned++;
      }
    }
    
    // Remove excess conversations (keep most recent)
    if (conversations.size > this.maxConversationCount) {
      const entries = Array.from(conversations.entries());
      entries.sort((a, b) => {
        const aTime = new Date(a[1][a[1].length - 1].timestamp).getTime();
        const bTime = new Date(b[1][b[1].length - 1].timestamp).getTime();
        return aTime - bTime; // Oldest first
      });
      
      const toRemove = entries.slice(0, entries.length - this.maxConversationCount);
      toRemove.forEach(([taskId]) => {
        conversations.delete(taskId);
        cleaned++;
      });
    }
    
    if (cleaned > 0) {
      console.log(`🧹 Cleaned up ${cleaned} old conversations`);
    }
  }
  
  private getConversationStorage() {
    return this.conversationStorage;
  }
}
```

---

## Network and Protocol Issues

### 1. Connection Problems

```typescript
// Comprehensive connection testing
class ConnectionDiagnostics {
  async diagnoseAgent(agent: any): Promise<{
    reachable: boolean;
    protocol: string;
    latency?: number;
    errors: string[];
  }> {
    const errors = [];
    let reachable = false;
    let latency: number | undefined;
    let protocol = 'unknown';
    
    try {
      // Test basic connectivity
      const startTime = Date.now();
      const response = await this.testBasicConnectivity(agent);
      latency = Date.now() - startTime;
      reachable = true;
      protocol = response.protocol;
      
    } catch (error) {
      errors.push(`Connection failed: ${error.message}`);
    }
    
    // Test authentication if required
    if (reachable && agent.requiresAuth) {
      try {
        await this.testAuthentication(agent);
      } catch (error) {
        errors.push(`Authentication failed: ${error.message}`);
      }
    }
    
    // Test specific endpoints
    if (reachable) {
      await this.testCommonEndpoints(agent, errors);
    }
    
    return { reachable, protocol, latency, errors };
  }
  
  private async testBasicConnectivity(agent: any) {
    // Implementation depends on agent configuration
    // This is a simplified example
    const response = await fetch(agent.agent_uri, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    return { protocol: agent.protocol };
  }
  
  private async testAuthentication(agent: any) {
    // Test auth endpoint if available
    // Implementation varies by agent
  }
  
  private async testCommonEndpoints(agent: any, errors: string[]) {
    const testEndpoints = [
      { name: 'getProducts', method: 'getProducts' },
      { name: 'listCreativeFormats', method: 'listCreativeFormats' }
    ];
    
    for (const endpoint of testEndpoints) {
      try {
        // Simple test call with minimal parameters
        await agent[endpoint.method]({ test: true });
      } catch (error) {
        if (!error.message.includes('test')) {
          errors.push(`${endpoint.name} endpoint failed: ${error.message}`);
        }
      }
    }
  }
}

// Usage
const diagnostics = new ConnectionDiagnostics();
const agentDiagnosis = await diagnostics.diagnoseAgent(agent);

if (!agentDiagnosis.reachable) {
  console.log('❌ Agent unreachable');
  agentDiagnosis.errors.forEach(error => console.log(`  ${error}`));
} else {
  console.log('✅ Agent reachable');
  console.log(`  Protocol: ${agentDiagnosis.protocol}`);
  console.log(`  Latency: ${agentDiagnosis.latency}ms`);
  
  if (agentDiagnosis.errors.length > 0) {
    console.log('⚠️  Issues found:');
    agentDiagnosis.errors.forEach(error => console.log(`  ${error}`));
  }
}
```

### 2. Protocol-Specific Issues

```typescript
// Debug MCP vs A2A protocol differences
class ProtocolDebugger {
  async debugProtocolDifferences(client: ADCPMultiAgentClient) {
    const agents = client.getAllAgents();
    
    for (const agentConfig of agents) {
      console.log(`\n🔍 Testing ${agentConfig.name} (${agentConfig.protocol})`);
      
      const agent = client.agent(agentConfig.id);
      
      try {
        const result = await agent.getProducts({ 
          brief: 'Test products',
          test_mode: true 
        }, autoApproveHandler);
        
        console.log(`✅ ${agentConfig.protocol} protocol working`);
        console.log(`  Response time: ${result.metadata.responseTimeMs}ms`);
        console.log(`  Status: ${result.status}`);
        
      } catch (error) {
        console.log(`❌ ${agentConfig.protocol} protocol failed:`);
        console.log(`  Error: ${error.message}`);
        
        // Protocol-specific debugging
        if (agentConfig.protocol === 'mcp') {
          await this.debugMCPIssues(agent, error);
        } else if (agentConfig.protocol === 'a2a') {
          await this.debugA2AIssues(agent, error);
        }
      }
    }
  }
  
  private async debugMCPIssues(agent: any, error: Error) {
    console.log('🔧 MCP-specific debugging:');
    
    if (error.message.includes('401') || error.message.includes('auth')) {
      console.log('  💡 Check x-adcp-auth header configuration');
      console.log('  💡 Verify MCP authentication setup');
    }
    
    if (error.message.includes('initialize')) {
      console.log('  💡 MCP initialization failed');
      console.log('  💡 Check if agent supports MCP handshake');
    }
    
    if (error.message.includes('SSE') || error.message.includes('stream')) {
      console.log('  💡 SSE streaming issue detected');
      console.log('  💡 Check if agent supports Server-Sent Events');
    }
  }
  
  private async debugA2AIssues(agent: any, error: Error) {
    console.log('🔧 A2A-specific debugging:');
    
    if (error.message.includes('404')) {
      console.log('  💡 Check A2A endpoint routing');
      console.log('  💡 Verify agent supports A2A protocol paths');
    }
    
    if (error.message.includes('websocket') || error.message.includes('WS')) {
      console.log('  💡 WebSocket connection issue');
      console.log('  💡 Check if agent supports A2A WebSocket communication');
    }
  }
}
```

---

## Monitoring and Observability

### 1. Comprehensive Logging Setup

```typescript
// Production-ready logging system
class ADCPLogger {
  private logger: any; // Your logging library (Winston, Pino, etc.)
  
  logTaskStart(taskId: string, agent: any, params: any) {
    this.logger.info('Task started', {
      taskId,
      agent: { id: agent.id, name: agent.name, protocol: agent.protocol },
      params: this.sanitizeParams(params),
      timestamp: new Date().toISOString()
    });
  }
  
  logTaskComplete(taskId: string, result: TaskResult) {
    this.logger.info('Task completed', {
      taskId,
      status: result.status,
      success: result.success,
      responseTime: result.metadata.responseTimeMs,
      clarificationRounds: result.metadata.clarificationRounds,
      timestamp: new Date().toISOString()
    });
  }
  
  logHandlerCall(context: ConversationContext, handlerName: string) {
    this.logger.debug('Handler called', {
      taskId: context.taskId,
      handlerName,
      field: context.inputRequest.field,
      attempt: context.attempt,
      question: context.inputRequest.question,
      timestamp: new Date().toISOString()
    });
  }
  
  logAsyncPatternUsage(pattern: string, details: any) {
    this.logger.info('Async pattern used', {
      pattern,
      ...details,
      timestamp: new Date().toISOString()
    });
  }
  
  private sanitizeParams(params: any) {
    // Remove sensitive data from logs
    const sanitized = { ...params };
    delete sanitized.auth_token;
    delete sanitized.api_key;
    return sanitized;
  }
}

// Metrics collection
class ADCPMetrics {
  private metrics = {
    taskCounts: new Map<string, number>(),
    avgResponseTimes: new Map<string, number[]>(),
    errorCounts: new Map<string, number>(),
    patternUsage: new Map<string, number>()
  };
  
  recordTask(status: string, responseTime: number, pattern: string) {
    // Count by status
    this.metrics.taskCounts.set(status, (this.metrics.taskCounts.get(status) || 0) + 1);
    
    // Track response times
    const times = this.metrics.avgResponseTimes.get(status) || [];
    times.push(responseTime);
    this.metrics.avgResponseTimes.set(status, times);
    
    // Pattern usage
    this.metrics.patternUsage.set(pattern, (this.metrics.patternUsage.get(pattern) || 0) + 1);
  }
  
  recordError(errorType: string) {
    this.metrics.errorCounts.set(errorType, (this.metrics.errorCounts.get(errorType) || 0) + 1);
  }
  
  getReport() {
    return {
      taskCounts: Object.fromEntries(this.metrics.taskCounts),
      avgResponseTimes: Object.fromEntries(
        Array.from(this.metrics.avgResponseTimes.entries()).map(([status, times]) => [
          status,
          times.reduce((sum, time) => sum + time, 0) / times.length
        ])
      ),
      errorCounts: Object.fromEntries(this.metrics.errorCounts),
      patternUsage: Object.fromEntries(this.metrics.patternUsage)
    };
  }
}
```

### 2. Health Monitoring Dashboard

```typescript
// Health monitoring for production systems
class ADCPHealthMonitor {
  private healthChecks: Map<string, HealthCheck> = new Map();
  
  registerAgent(agentId: string, agent: any) {
    this.healthChecks.set(agentId, new HealthCheck(agentId, agent));
  }
  
  async runHealthChecks(): Promise<HealthReport> {
    const results = new Map<string, any>();
    
    for (const [agentId, healthCheck] of this.healthChecks) {
      try {
        const result = await healthCheck.check();
        results.set(agentId, result);
      } catch (error) {
        results.set(agentId, {
          healthy: false,
          error: error.message,
          timestamp: new Date().toISOString()
        });
      }
    }
    
    return new HealthReport(results);
  }
  
  startPeriodicChecks(intervalMs: number = 60000) {
    setInterval(async () => {
      const report = await this.runHealthChecks();
      
      if (!report.allHealthy()) {
        console.warn('❌ Health check failures detected');
        report.getUnhealthyAgents().forEach(({ agentId, status }) => {
          console.warn(`  ${agentId}: ${status.error}`);
        });
      }
    }, intervalMs);
  }
}

class HealthCheck {
  constructor(private agentId: string, private agent: any) {}
  
  async check() {
    const startTime = Date.now();
    
    // Basic connectivity
    const connectivityResult = await this.checkConnectivity();
    
    // Response time
    const responseTime = Date.now() - startTime;
    
    // Protocol compliance
    const protocolResult = await this.checkProtocolCompliance();
    
    return {
      healthy: connectivityResult.healthy && protocolResult.healthy,
      responseTime,
      connectivity: connectivityResult,
      protocol: protocolResult,
      timestamp: new Date().toISOString()
    };
  }
  
  private async checkConnectivity() {
    try {
      // Simple ping-like test
      const result = await this.agent.getProducts({ 
        brief: 'Health check',
        test_mode: true 
      }, autoApproveHandler);
      
      return { healthy: true, details: 'Agent responsive' };
    } catch (error) {
      return { healthy: false, error: error.message };
    }
  }
  
  private async checkProtocolCompliance() {
    // Check if agent follows ADCP spec
    // This is simplified - real implementation would be more comprehensive
    return { healthy: true, details: 'Protocol compliance not fully implemented' };
  }
}

class HealthReport {
  constructor(private results: Map<string, any>) {}
  
  allHealthy(): boolean {
    return Array.from(this.results.values()).every(result => result.healthy);
  }
  
  getUnhealthyAgents() {
    return Array.from(this.results.entries())
      .filter(([_, status]) => !status.healthy)
      .map(([agentId, status]) => ({ agentId, status }));
  }
  
  getAverageResponseTime(): number {
    const times = Array.from(this.results.values())
      .filter(r => r.responseTime)
      .map(r => r.responseTime);
    
    return times.length > 0 ? times.reduce((sum, time) => sum + time, 0) / times.length : 0;
  }
  
  toJSON() {
    return {
      overall: this.allHealthy(),
      agents: Object.fromEntries(this.results),
      summary: {
        totalAgents: this.results.size,
        healthyAgents: Array.from(this.results.values()).filter(r => r.healthy).length,
        averageResponseTime: this.getAverageResponseTime()
      }
    };
  }
}
```

---

## Production Debugging

### 1. Debug Information Collection

```typescript
// Comprehensive debug information collector
class DebugInfoCollector {
  async collectDebugInfo(taskId?: string): Promise<DebugReport> {
    const info = {
      timestamp: new Date().toISOString(),
      environment: this.getEnvironmentInfo(),
      configuration: this.getConfigurationInfo(),
      agentStatus: await this.getAgentStatus(),
      recentErrors: this.getRecentErrors(),
      performanceMetrics: this.getPerformanceMetrics(),
      taskDetails: taskId ? await this.getTaskDetails(taskId) : null
    };
    
    return new DebugReport(info);
  }
  
  private getEnvironmentInfo() {
    return {
      nodeVersion: process.version,
      platform: process.platform,
      memory: process.memoryUsage(),
      uptime: process.uptime(),
      libraryVersion: this.getLibraryVersion()
    };
  }
  
  private getConfigurationInfo() {
    // Sanitized configuration (no secrets)
    return {
      agentCount: this.client.getAllAgents().length,
      protocols: this.client.getAllAgents().map(a => a.protocol),
      timeouts: this.getTimeoutConfiguration(),
      storageEnabled: this.isStorageEnabled()
    };
  }
  
  private async getAgentStatus() {
    const agents = this.client.getAllAgents();
    const statuses = await Promise.allSettled(
      agents.map(async (agent) => ({
        id: agent.id,
        name: agent.name,
        protocol: agent.protocol,
        reachable: await this.testAgentReachability(agent)
      }))
    );
    
    return statuses.map(result => 
      result.status === 'fulfilled' ? result.value : { error: result.reason }
    );
  }
}

class DebugReport {
  constructor(private info: any) {}
  
  toString(): string {
    return `
=== ADCP Debug Report ===
Generated: ${this.info.timestamp}

Environment:
  Node.js: ${this.info.environment.nodeVersion}
  Platform: ${this.info.environment.platform}
  Memory: ${Math.round(this.info.environment.memory.heapUsed / 1024 / 1024)}MB
  Uptime: ${Math.round(this.info.environment.uptime)}s

Configuration:
  Agents: ${this.info.configuration.agentCount}
  Protocols: ${this.info.configuration.protocols.join(', ')}

Agent Status:
${this.info.agentStatus.map((status: any) => 
  `  ${status.name || 'Unknown'}: ${status.reachable ? '✅' : '❌'}`
).join('\n')}

Recent Errors:
${this.info.recentErrors?.slice(0, 5).map((error: any) => 
  `  ${error.timestamp}: ${error.message}`
).join('\n') || '  None'}

${this.info.taskDetails ? `
Task Details (${this.info.taskDetails.taskId}):
  Status: ${this.info.taskDetails.status}
  Duration: ${this.info.taskDetails.duration}ms
  Attempts: ${this.info.taskDetails.attempts}
` : ''}
===========================
    `;
  }
  
  toJSON() {
    return this.info;
  }
  
  saveToFile(filename: string) {
    const fs = require('fs');
    fs.writeFileSync(filename, this.toString());
    console.log(`Debug report saved to ${filename}`);
  }
}
```

### 2. Error Recovery Strategies

```typescript
// Automatic error recovery system
class ErrorRecoveryManager {
  private retryStrategies = new Map<string, RetryStrategy>();
  
  constructor() {
    // Configure retry strategies for different error types
    this.retryStrategies.set('NetworkError', new ExponentialBackoffRetry(3, 1000));
    this.retryStrategies.set('TaskTimeoutError', new ReducedTimeoutRetry(2));
    this.retryStrategies.set('InputRequiredError', new HandlerAdjustmentRetry(1));
  }
  
  async executeWithRecovery<T>(
    operation: () => Promise<T>,
    errorContext: string
  ): Promise<T> {
    let lastError: Error;
    
    for (const [errorType, strategy] of this.retryStrategies) {
      try {
        return await strategy.execute(operation);
      } catch (error) {
        lastError = error;
        
        if (error.constructor.name === errorType) {
          console.log(`🔄 Applying ${errorType} recovery strategy...`);
          continue;
        }
      }
    }
    
    // All recovery strategies failed
    console.error(`❌ All recovery strategies failed for ${errorContext}`);
    throw lastError;
  }
}

interface RetryStrategy {
  execute<T>(operation: () => Promise<T>): Promise<T>;
}

class ExponentialBackoffRetry implements RetryStrategy {
  constructor(private maxRetries: number, private baseDelay: number) {}
  
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: Error;
    
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        
        if (attempt < this.maxRetries - 1) {
          const delay = this.baseDelay * Math.pow(2, attempt);
          console.log(`⏳ Retrying in ${delay}ms (attempt ${attempt + 1}/${this.maxRetries})`);
          await this.sleep(delay);
        }
      }
    }
    
    throw lastError;
  }
  
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

class ReducedTimeoutRetry implements RetryStrategy {
  constructor(private maxRetries: number) {}
  
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    // This would modify the operation to use reduced timeouts
    // Implementation depends on how the operation is structured
    throw new Error('ReducedTimeoutRetry not implemented');
  }
}

class HandlerAdjustmentRetry implements RetryStrategy {
  constructor(private maxRetries: number) {}
  
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    // This would modify the handler to be more permissive
    // Implementation depends on the specific operation
    throw new Error('HandlerAdjustmentRetry not implemented');
  }
}
```

This troubleshooting guide provides comprehensive tools and techniques for diagnosing and resolving issues with the ADCP async execution model. Use these patterns and tools to build robust, debuggable ADCP integrations that can handle the complexity of real-world advertising scenarios.