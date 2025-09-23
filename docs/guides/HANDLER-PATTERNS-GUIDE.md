# ADCP Handler Patterns and Best Practices

## Overview

Input handlers are the core mechanism for controlling how your ADCP client responds to agent clarification requests. This guide covers proven patterns, best practices, and advanced techniques for building robust, maintainable handlers.

## Handler Fundamentals

### Basic Handler Anatomy

```typescript
import type { InputHandler, ConversationContext } from '@adcp/client';

const myHandler: InputHandler = async (context: ConversationContext) => {
  // 1. Analyze the context
  const { inputRequest, messages, agent, attempt } = context;
  
  // 2. Decide how to respond
  if (inputRequest.field === 'budget') {
    return 50000;
  }
  
  // 3. Fallback behavior
  return context.deferToHuman();
};
```

### Context Object Deep Dive

The `ConversationContext` provides rich information for decision-making:

```typescript
interface ConversationContext {
  // Current request details
  inputRequest: {
    question: string;           // "What is your budget for this campaign?"
    field?: string;             // "budget"
    expectedType?: string;      // "number"
    suggestions?: any[];        // [25000, 50000, 100000]
    required?: boolean;         // true
    validation?: object;        // { min: 1000, max: 1000000 }
    context?: string;          // Additional explanation
  };
  
  // Conversation state
  messages: Message[];          // Full conversation history
  taskId: string;              // Unique task identifier
  agent: AgentInfo;            // Agent details
  attempt: number;             // Current clarification attempt (1-based)
  maxAttempts: number;         // Maximum allowed attempts
  
  // Helper methods
  deferToHuman(): Promise<{ defer: true; token: string }>;
  abort(reason?: string): never;
  getSummary(): string;
  wasFieldDiscussed(field: string): boolean;
  getPreviousResponse(field: string): any;
}
```

## Pre-Built Handlers

### 1. Auto-Approve Handler
Always returns `true` for any input request:

```typescript
import { autoApproveHandler } from '@adcp/client';

// Usage
const result = await agent.getProducts(params, autoApproveHandler);
```

**Best for**: Testing, development, trusted agents

### 2. Defer All Handler
Always defers to human for every input request:

```typescript
import { deferAllHandler } from '@adcp/client';

// Usage
const result = await agent.getProducts(params, deferAllHandler);

if (result.status === 'deferred') {
  // Handle human approval workflow
  const userInput = await getUserInput(result.deferred.question);
  const final = await result.deferred.resume(userInput);
}
```

**Best for**: High-stakes operations, compliance requirements

## Built-In Handler Factories

### 1. Field Handler (`createFieldHandler`)

Maps specific fields to responses:

```typescript
import { createFieldHandler } from '@adcp/client';

// Simple field mapping
const handler = createFieldHandler({
  budget: 75000,
  targeting: ['US', 'CA', 'UK'],
  approval: true,
  creative_format: 'video'
});

// Dynamic field responses
const dynamicHandler = createFieldHandler({
  budget: (context) => {
    // Budget based on agent type
    if (context.agent.name.includes('Premium')) return 100000;
    if (context.agent.name.includes('Budget')) return 25000;
    return 50000;
  },
  
  approval: (context) => {
    // Only approve on first attempt
    return context.attempt === 1;
  },
  
  targeting: (context) => {
    // Use suggestions if available
    if (context.inputRequest.suggestions?.length > 0) {
      return context.inputRequest.suggestions[0];
    }
    return ['US']; // Safe default
  }
});
```

### 2. Conditional Handler (`createConditionalHandler`)

Applies different logic based on context conditions:

```typescript
import { createConditionalHandler, autoApproveHandler, deferAllHandler } from '@adcp/client';

const smartHandler = createConditionalHandler([
  {
    // High-budget decisions require human approval
    condition: (ctx) => ctx.inputRequest.field === 'budget' && 
                       ctx.inputRequest.suggestions?.some(s => s > 100000),
    handler: deferAllHandler
  },
  {
    // Auto-approve trusted agents
    condition: (ctx) => ctx.agent.name.includes('Trusted'),
    handler: autoApproveHandler
  },
  {
    // Use first suggestion when available
    condition: (ctx) => ctx.inputRequest.suggestions?.length > 0,
    handler: createSuggestionHandler(0)
  },
  {
    // Defer after too many attempts
    condition: (ctx) => ctx.attempt > 2,
    handler: (ctx) => ctx.deferToHuman()
  }
], deferAllHandler); // Final fallback
```

### 3. Retry Handler (`createRetryHandler`)

Different responses for different attempt numbers:

```typescript
import { createRetryHandler } from '@adcp/client';

const retryHandler = createRetryHandler([
  100000,  // First attempt: generous budget
  75000,   // Second attempt: moderate budget
  50000,   // Third attempt: conservative budget
  (ctx) => ctx.abort('Too many budget negotiations')  // Fourth attempt: abort
]);
```

### 4. Suggestion Handler (`createSuggestionHandler`)

Uses agent-provided suggestions:

```typescript
import { createSuggestionHandler } from '@adcp/client';

// Use first suggestion
const firstSuggestion = createSuggestionHandler(0, deferAllHandler);

// Use last suggestion
const lastSuggestion = createSuggestionHandler(-1, deferAllHandler);

// Use middle suggestion for balance
const balancedHandler = createSuggestionHandler(
  (suggestions) => Math.floor(suggestions.length / 2),
  deferAllHandler
);
```

### 5. Validated Handler (`createValidatedHandler`)

Respects validation rules:

```typescript
import { createValidatedHandler } from '@adcp/client';

const validatedHandler = createValidatedHandler(
  75000, // Value to provide
  deferAllHandler // Fallback if validation fails
);

// The handler will check:
// - enum validation (if value is in allowed list)
// - min/max validation (for numbers)
// - pattern validation (for strings)
```

## Advanced Handler Patterns

### 1. Business Logic Handler

Implements complex business rules:

```typescript
function createBusinessLogicHandler(userProfile: UserProfile) {
  return createConditionalHandler([
    {
      condition: (ctx) => ctx.inputRequest.field === 'budget',
      handler: (ctx) => {
        // Budget based on user tier and campaign type
        const baseBudget = userProfile.tier === 'enterprise' ? 100000 : 50000;
        const campaignMultiplier = ctx.messages.some(m => 
          m.content?.brief?.includes('holiday')) ? 1.5 : 1.0;
        
        return Math.floor(baseBudget * campaignMultiplier);
      }
    },
    {
      condition: (ctx) => ctx.inputRequest.field === 'targeting',
      handler: (ctx) => {
        // Targeting based on user's allowed regions
        const allowedRegions = userProfile.regions || ['US'];
        const suggestions = ctx.inputRequest.suggestions || [];
        
        // Filter suggestions to allowed regions
        const validTargeting = suggestions.filter(region => 
          allowedRegions.includes(region));
        
        return validTargeting.length > 0 ? validTargeting : allowedRegions;
      }
    },
    {
      condition: (ctx) => ctx.inputRequest.field === 'approval',
      handler: (ctx) => {
        // Auto-approve within user's authority
        const budget = ctx.getPreviousResponse('budget') || 0;
        const userLimit = userProfile.approvalLimit || 25000;
        
        if (budget <= userLimit) {
          return true;
        }
        
        // Defer expensive approvals
        return ctx.deferToHuman();
      }
    }
  ], deferAllHandler);
}

// Usage
const userHandler = createBusinessLogicHandler(currentUser);
const result = await agent.getProducts(params, userHandler);
```

### 2. Conversation-Aware Handler

Uses conversation history for intelligent responses:

```typescript
function createConversationAwareHandler() {
  return async (context: ConversationContext) => {
    const { inputRequest, messages, wasFieldDiscussed, getPreviousResponse } = context;
    
    if (inputRequest.field === 'budget') {
      // Check if budget was already discussed
      if (wasFieldDiscussed('budget')) {
        const previousBudget = getPreviousResponse('budget');
        
        // Increase budget if agent is asking again (implies it was too low)
        return Math.floor(previousBudget * 1.2);
      }
      
      // Initial budget based on campaign brief
      const brief = messages.find(m => m.content?.brief)?.content?.brief || '';
      
      if (brief.includes('premium') || brief.includes('luxury')) {
        return 100000;
      } else if (brief.includes('startup') || brief.includes('budget')) {
        return 25000;
      }
      
      return 50000; // Default
    }
    
    if (inputRequest.field === 'creative_format') {
      // Suggest format based on mentioned products
      const hasVideo = messages.some(m => 
        JSON.stringify(m.content).includes('video'));
      
      return hasVideo ? 'video' : 'display';
    }
    
    return context.deferToHuman();
  };
}
```

### 3. Multi-Agent Coordinated Handler

Coordinates responses across multiple agents:

```typescript
class MultiAgentCoordinator {
  private sharedState = new Map<string, any>();
  
  createCoordinatedHandler(agentId: string) {
    return async (context: ConversationContext) => {
      const stateKey = `${agentId}-${context.inputRequest.field}`;
      
      if (context.inputRequest.field === 'budget') {
        // Ensure total budget across agents doesn't exceed limit
        const totalBudget = Array.from(this.sharedState.values())
          .filter(v => typeof v === 'number')
          .reduce((sum, budget) => sum + budget, 0);
        
        const maxTotalBudget = 200000;
        const remainingBudget = maxTotalBudget - totalBudget;
        const suggestedBudget = Math.min(50000, remainingBudget);
        
        if (suggestedBudget <= 0) {
          return context.abort('Total budget limit exceeded');
        }
        
        this.sharedState.set(stateKey, suggestedBudget);
        return suggestedBudget;
      }
      
      if (context.inputRequest.field === 'targeting') {
        // Avoid overlapping targeting between agents
        const usedTargeting = Array.from(this.sharedState.values())
          .filter(v => Array.isArray(v))
          .flat();
        
        const availableRegions = ['US', 'CA', 'UK', 'AU', 'DE', 'FR']
          .filter(region => !usedTargeting.includes(region));
        
        if (availableRegions.length === 0) {
          return context.abort('No available targeting regions');
        }
        
        const selectedRegions = availableRegions.slice(0, 2);
        this.sharedState.set(stateKey, selectedRegions);
        return selectedRegions;
      }
      
      return context.deferToHuman();
    };
  }
}

// Usage
const coordinator = new MultiAgentCoordinator();

const results = await Promise.all([
  client.agent('agent1').getProducts(params, coordinator.createCoordinatedHandler('agent1')),
  client.agent('agent2').getProducts(params, coordinator.createCoordinatedHandler('agent2')),
  client.agent('agent3').getProducts(params, coordinator.createCoordinatedHandler('agent3'))
]);
```

### 4. A/B Testing Handler

Systematically tests different responses:

```typescript
class ABTestingHandler {
  private testConfig: Map<string, any[]>;
  private results: Map<string, any[]>;
  
  constructor(testConfig: Record<string, any[]>) {
    this.testConfig = new Map(Object.entries(testConfig));
    this.results = new Map();
  }
  
  createTestHandler(testGroup: string) {
    return async (context: ConversationContext) => {
      const field = context.inputRequest.field;
      const testValues = this.testConfig.get(field);
      
      if (!testValues) {
        return context.deferToHuman();
      }
      
      // Use consistent hash to assign test variant
      const hash = this.hashString(`${testGroup}-${field}`);
      const variantIndex = hash % testValues.length;
      const selectedValue = testValues[variantIndex];
      
      // Track the test
      const testKey = `${field}-${variantIndex}`;
      if (!this.results.has(testKey)) {
        this.results.set(testKey, []);
      }
      
      console.log(`A/B Test: ${field} = ${selectedValue} (variant ${variantIndex})`);
      
      return selectedValue;
    };
  }
  
  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }
  
  getTestResults() {
    return Object.fromEntries(this.results);
  }
}

// Usage
const abTester = new ABTestingHandler({
  budget: [25000, 50000, 75000, 100000],
  targeting: [['US'], ['US', 'CA'], ['US', 'CA', 'UK']]
});

const testHandler = abTester.createTestHandler('campaign-2024-q1');
const result = await agent.getProducts(params, testHandler);
```

## Error Handling in Handlers

### 1. Graceful Degradation

```typescript
function createRobustHandler(primaryStrategy: InputHandler, fallbackStrategy: InputHandler) {
  return async (context: ConversationContext) => {
    try {
      const result = await primaryStrategy(context);
      
      // Validate the result
      if (context.inputRequest.validation) {
        const isValid = validateResponse(result, context.inputRequest.validation);
        if (!isValid) {
          console.warn('Primary strategy produced invalid response, using fallback');
          return await fallbackStrategy(context);
        }
      }
      
      return result;
    } catch (error) {
      console.error('Primary strategy failed:', error.message);
      return await fallbackStrategy(context);
    }
  };
}

function validateResponse(value: any, validation: any): boolean {
  if (validation.enum && !validation.enum.includes(value)) {
    return false;
  }
  
  if (typeof value === 'number') {
    if (validation.min !== undefined && value < validation.min) return false;
    if (validation.max !== undefined && value > validation.max) return false;
  }
  
  if (typeof value === 'string' && validation.pattern) {
    const regex = new RegExp(validation.pattern);
    if (!regex.test(value)) return false;
  }
  
  return true;
}
```

### 2. Timeout and Circuit Breaker

```typescript
function createTimeoutHandler(handler: InputHandler, timeoutMs: number = 5000) {
  return async (context: ConversationContext) => {
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Handler timeout')), timeoutMs);
    });
    
    try {
      return await Promise.race([
        handler(context),
        timeoutPromise
      ]);
    } catch (error) {
      console.error('Handler timed out or failed:', error.message);
      return context.deferToHuman();
    }
  };
}

class CircuitBreakerHandler {
  private failures = 0;
  private lastFailure = 0;
  private readonly maxFailures = 3;
  private readonly resetTimeout = 60000; // 1 minute
  
  constructor(private handler: InputHandler) {}
  
  async handle(context: ConversationContext) {
    // Check if circuit is open
    if (this.failures >= this.maxFailures) {
      const timeSinceLastFailure = Date.now() - this.lastFailure;
      if (timeSinceLastFailure < this.resetTimeout) {
        console.warn('Circuit breaker open, deferring to human');
        return context.deferToHuman();
      } else {
        // Reset circuit breaker
        this.failures = 0;
      }
    }
    
    try {
      const result = await this.handler(context);
      this.failures = 0; // Reset on success
      return result;
    } catch (error) {
      this.failures++;
      this.lastFailure = Date.now();
      console.error(`Handler failed (${this.failures}/${this.maxFailures}):`, error.message);
      return context.deferToHuman();
    }
  }
}
```

## Testing Handler Patterns

### 1. Unit Testing Handlers

```typescript
import { describe, it, expect } from '@jest/globals';

describe('BusinessLogicHandler', () => {
  const enterpriseUser = { tier: 'enterprise', regions: ['US', 'UK'], approvalLimit: 100000 };
  const basicUser = { tier: 'basic', regions: ['US'], approvalLimit: 25000 };
  
  it('should provide higher budget for enterprise users', async () => {
    const handler = createBusinessLogicHandler(enterpriseUser);
    
    const context = createMockContext({
      inputRequest: { field: 'budget', question: 'What is your budget?' },
      messages: [{ content: { brief: 'Holiday campaign' } }]
    });
    
    const result = await handler(context);
    expect(result).toBe(150000); // 100000 * 1.5 for holiday campaign
  });
  
  it('should defer expensive approvals for basic users', async () => {
    const handler = createBusinessLogicHandler(basicUser);
    
    const context = createMockContext({
      inputRequest: { field: 'approval', question: 'Approve this campaign?' },
      getPreviousResponse: jest.fn().mockReturnValue(50000), // Budget exceeds user limit
      deferToHuman: jest.fn().mockResolvedValue({ defer: true, token: 'test-token' })
    });
    
    const result = await handler(context);
    expect(context.deferToHuman).toHaveBeenCalled();
  });
});

function createMockContext(overrides: Partial<ConversationContext>): ConversationContext {
  return {
    inputRequest: { question: 'Test question' },
    messages: [],
    taskId: 'test-task',
    agent: { id: 'test-agent', name: 'Test Agent', protocol: 'mcp' },
    attempt: 1,
    maxAttempts: 3,
    deferToHuman: jest.fn(),
    abort: jest.fn(),
    getSummary: jest.fn().mockReturnValue('Test summary'),
    wasFieldDiscussed: jest.fn().mockReturnValue(false),
    getPreviousResponse: jest.fn().mockReturnValue(undefined),
    ...overrides
  };
}
```

### 2. Integration Testing

```typescript
describe('Handler Integration Tests', () => {
  it('should handle complete conversation flow', async () => {
    const conversationLog: any[] = [];
    
    const handler = createFieldHandler({
      budget: (ctx) => {
        conversationLog.push({ field: 'budget', attempt: ctx.attempt });
        return ctx.attempt === 1 ? 100000 : 50000; // Reduce budget on retry
      },
      targeting: ['US', 'CA'],
      approval: true
    });
    
    // Mock agent that asks for clarifications
    const mockAgent = new MockAgent([
      { status: 'input-required', field: 'budget', question: 'Budget?' },
      { status: 'input-required', field: 'targeting', question: 'Targeting?' },
      { status: 'input-required', field: 'approval', question: 'Approve?' },
      { status: 'completed', data: { products: ['Product A'] } }
    ]);
    
    const result = await mockAgent.getProducts({ brief: 'Test' }, handler);
    
    expect(result.status).toBe('completed');
    expect(result.data.products).toEqual(['Product A']);
    expect(conversationLog).toHaveLength(1); // Budget was asked once
  });
});
```

## Best Practices Summary

### 1. Handler Design Principles
- **Single Responsibility**: Each handler should have one clear purpose
- **Fail Safe**: Always provide fallback behavior
- **Context Aware**: Use conversation history to make better decisions
- **Validatable**: Respect validation rules and constraints
- **Testable**: Design handlers to be easily unit tested

### 2. Performance Considerations
- **Cache Expensive Operations**: Don't repeat expensive calculations
- **Timeout Protection**: Prevent hanging handlers
- **Circuit Breaker**: Protect against cascading failures
- **Async Friendly**: Use async/await properly

### 3. Security and Compliance
- **Input Validation**: Always validate user inputs
- **Authorization Checks**: Verify user permissions
- **Audit Logging**: Log important decisions
- **Data Privacy**: Don't log sensitive information

### 4. Maintenance
- **Version Handlers**: Track handler versions for debugging
- **Monitor Performance**: Track handler response times
- **A/B Testing**: Systematically test handler improvements
- **Documentation**: Document business logic and edge cases

This comprehensive guide provides the foundation for building sophisticated, maintainable handler patterns that can handle complex business requirements while remaining robust and testable.