#!/usr/bin/env node

/**
 * PR #78 Async Patterns Demo
 *
 * Demonstrates the new handler-controlled async execution patterns
 * that align with ADCP spec PR #78
 */

import {
  ADCPMultiAgentClient,
  ADCP_STATUS,
  autoApproveHandler,
  deferAllHandler,
  createFieldHandler,
  InputRequiredError,
  type TaskResult,
  type DeferredContinuation,
  type SubmittedContinuation,
} from '../src/lib/index';

async function main() {
  console.log('🚀 PR #78 Async Patterns Demo\n');

  // Example 1: Immediate completion (status: completed)
  console.log('📋 Example 1: Immediate Task Completion');
  console.log('─'.repeat(50));

  const client = ADCPMultiAgentClient.simple('https://demo.example.com', {
    agentId: 'demo-agent',
    agentName: 'Demo Agent',
    protocol: 'mcp',
  });

  // Simulate immediate completion
  console.log('• Calling getProducts with auto-approve handler...');
  try {
    // This would complete immediately if server returns status: 'completed'
    const result = await simulateTaskResult('completed', {
      products: ['Product A', 'Product B', 'Product C'],
    });

    console.log('✅ Task completed immediately!');
    console.log(`   Status: ${result.status}`);
    console.log(`   Products: ${JSON.stringify(result.data?.products || [])}`);
  } catch (error) {
    console.log(`ℹ️  Note: ${error.message} (expected in demo)`);
  }

  console.log('\n📋 Example 2: Working Status (keep connection open)');
  console.log('─'.repeat(50));

  // Simulate server processing (status: working)
  console.log('• Server is processing (working status)...');
  console.log('• Client keeps connection open for up to 120 seconds');
  try {
    const result = await simulateWorkingTask();
    console.log('✅ Task completed after server processing!');
    console.log(`   Status: ${result.status}`);
  } catch (error) {
    console.log(`ℹ️  Note: ${error.message} (expected in demo)`);
  }

  console.log('\n📋 Example 3: Input Required with Handler');
  console.log('─'.repeat(50));

  // Handler provides input immediately
  const fieldHandler = createFieldHandler({
    budget: 50000,
    targeting: ['US', 'CA'],
    approval: true,
  });

  console.log('• Server needs input, handler provides it...');
  try {
    const result = await simulateInputRequired(fieldHandler);
    console.log('✅ Handler provided input, task continued!');
    console.log(`   Status: ${result.status}`);
  } catch (error) {
    console.log(`ℹ️  Note: ${error.message} (expected in demo)`);
  }

  console.log('\n📋 Example 4: Input Required without Handler (ERROR)');
  console.log('─'.repeat(50));

  console.log('• Server needs input, but no handler provided...');
  try {
    const result = await simulateInputRequired(); // No handler
    console.log('❌ This should not happen');
  } catch (error) {
    if (error instanceof InputRequiredError) {
      console.log('✅ Correctly threw InputRequiredError!');
      console.log(`   Error: ${error.message}`);
    } else {
      console.log(`ℹ️  Note: ${error.message} (expected in demo)`);
    }
  }

  console.log('\n📋 Example 5: Client Deferral (Human-in-the-Loop)');
  console.log('─'.repeat(50));

  // Handler chooses to defer for human approval
  const humanApprovalHandler = (context: any) => {
    if (context.inputRequest.field === 'final_approval') {
      console.log('• Handler choosing to defer for human approval...');
      return { defer: true, token: `approval-${Date.now()}` };
    }
    return 'auto-approved';
  };

  try {
    const result = await simulateClientDeferral(humanApprovalHandler);

    if (result.status === 'deferred' && result.deferred) {
      console.log('✅ Task successfully deferred!');
      console.log(`   Token: ${result.deferred.token}`);
      console.log(`   Question: ${result.deferred.question}`);

      // Later, when human provides input...
      console.log('• Human provides approval, resuming task...');
      const finalResult = await result.deferred.resume('APPROVED');
      console.log('✅ Task resumed and completed!');
      console.log(`   Final status: ${finalResult.status}`);
    }
  } catch (error) {
    console.log(`ℹ️  Note: ${error.message} (expected in demo)`);
  }

  console.log('\n📋 Example 6: Server Async (Submitted Status)');
  console.log('─'.repeat(50));

  // Server says task will take hours/days
  console.log('• Server submitting long-running task...');
  try {
    const result = await simulateSubmittedTask();

    if (result.status === 'submitted' && result.submitted) {
      console.log('✅ Task submitted for async processing!');
      console.log(`   Task ID: ${result.submitted.taskId}`);
      console.log(`   Webhook: ${result.submitted.webhookUrl || 'not provided'}`);

      // User can track progress
      console.log('• Tracking task progress...');
      const status = await result.submitted.track();
      console.log(`   Current status: ${status.status}`);

      // Or wait for completion (with polling)
      console.log('• Waiting for completion (polling every 30s)...');
      // In real usage: const final = await result.submitted.waitForCompletion(30000);
      console.log('   (Would poll until completed)');
    }
  } catch (error) {
    console.log(`ℹ️  Note: ${error.message} (expected in demo)`);
  }

  console.log('\n🎯 Key Takeaways:');
  console.log('─'.repeat(50));
  console.log('• ✅ Working status: Client keeps connection open (≤120s)');
  console.log('• ✅ Input-required: Handler is MANDATORY');
  console.log('• ✅ Client deferral: Handler returns { defer: true, token }');
  console.log('• ✅ Server async: Returns { status: "submitted", submitted: { ... } }');
  console.log('• ✅ Completed: Returns { success: true, data: ... }');
  console.log('• ✅ No complex config needed - handler controls the flow!');

  console.log('\n🎉 Demo Complete!');
}

// Demo helper functions (simulate different response patterns)

async function simulateTaskResult(status: string, data: any): Promise<TaskResult<any>> {
  // In real usage, this would be a real agent call
  throw new Error('Demo simulation - would call real agent');
}

async function simulateWorkingTask(): Promise<TaskResult<any>> {
  throw new Error('Demo simulation - would poll tasks/get endpoint');
}

async function simulateInputRequired(handler?: any): Promise<TaskResult<any>> {
  if (!handler) {
    throw new InputRequiredError('What is your budget for this campaign?');
  }
  throw new Error('Demo simulation - would call handler and continue');
}

async function simulateClientDeferral(handler: any): Promise<TaskResult<any>> {
  // Simulate the handler being called and choosing to defer
  const mockContext = {
    inputRequest: {
      field: 'final_approval',
      question: 'Do you approve this $50,000 media buy?',
    },
  };

  const response = handler(mockContext);

  if (response.defer) {
    return {
      success: false,
      status: 'deferred',
      deferred: {
        token: response.token,
        question: mockContext.inputRequest.question,
        resume: async (input: any) => {
          console.log(`   Resumed with input: ${input}`);
          return {
            success: true,
            status: 'completed',
            data: { approved: input === 'APPROVED' },
          };
        },
      },
    };
  }

  throw new Error('Demo simulation - handler did not defer');
}

async function simulateSubmittedTask(): Promise<TaskResult<any>> {
  return {
    success: false,
    status: 'submitted',
    submitted: {
      taskId: `task-${Date.now()}`,
      webhookUrl: 'https://yourapp.com/webhooks/adcp/xyz123',
      track: async () => ({
        taskId: `task-${Date.now()}`,
        status: 'working',
        taskType: 'create_media_buy',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
      waitForCompletion: async (pollInterval = 60000) => {
        console.log(`   Polling every ${pollInterval}ms...`);
        return {
          success: true,
          status: 'completed',
          data: { mediaBuyId: 'mb-12345' },
        };
      },
    },
  };
}

if (require.main === module) {
  main().catch(console.error);
}
