const { test } = require('node:test');
const assert = require('node:assert/strict');

const { AgentClient, SingleAgentClient } = require('../../dist/lib/index.js');

test('AgentClient rejects projection-only products_available from native request_proposals', async () => {
  const agent = new AgentClient(
    {
      id: 'native-compact-seller',
      name: 'Native compact seller',
      agent_uri: 'https://seller.example/mcp',
      protocol: 'mcp',
    },
    { validateFeatures: false }
  );
  agent.client.executeTask = async () => ({
    success: true,
    status: 'completed',
    data: {
      outcome: 'products_available',
      products: [{ product_id: 'p1' }],
      purchase_continuation: { kind: 'listed_purchase', product_ids: ['p1'] },
    },
    metadata: {
      taskId: 'proposal-task',
      taskName: 'request_proposals',
      agent: { id: 'native-compact-seller', name: 'Native compact seller', protocol: 'mcp' },
      responseTimeMs: 1,
      timestamp: new Date().toISOString(),
      clarificationRounds: 0,
      status: 'completed',
    },
  });

  await assert.rejects(
    agent.requestProposals({
      idempotency_key: 'native-proposals-guard-0001',
      account: { account_id: 'account-1' },
      brand: { domain: 'example.com' },
      brief: 'Native proposals only',
    }),
    /projection-only products_available/
  );
  await assert.rejects(
    agent.executeTask('request_proposals', {
      idempotency_key: 'native-proposals-generic-guard-0001',
      account: { account_id: 'account-1' },
      brand: { domain: 'example.com' },
      brief: 'Native proposals through generic dispatch',
    }),
    /projection-only products_available/
  );
});

function projectionOnlyCompletion(status = 'completed') {
  return {
    success: true,
    status,
    data: {
      outcome: 'products_available',
      products: [{ product_id: 'p1' }],
      purchase_continuation: { kind: 'listed_purchase', product_ids: ['p1'] },
    },
    metadata: {
      taskId: 'proposal-task',
      taskName: 'request_proposals',
      agent: { id: 'native-compact-seller', name: 'Native compact seller', protocol: 'mcp' },
      responseTimeMs: 1,
      timestamp: new Date().toISOString(),
      clarificationRounds: 0,
      status,
    },
  };
}

function nativeAgent() {
  return new AgentClient(
    {
      id: 'native-compact-seller',
      name: 'Native compact seller',
      agent_uri: 'https://seller.example/mcp',
      protocol: 'mcp',
    },
    { validateFeatures: false }
  );
}

const request = {
  idempotency_key: 'native-proposals-guard-async-0001',
  account: { account_id: 'account-1' },
  brand: { domain: 'example.com' },
  brief: 'Native proposals only',
};

test('AgentClient rejects projection-only products_available from submitted request_proposals completions', async () => {
  const agent = nativeAgent();
  agent.client.executeTask = async () => ({
    success: true,
    status: 'submitted',
    metadata: { ...projectionOnlyCompletion('submitted').metadata, status: 'submitted' },
    submitted: {
      taskId: 'seller-proposal-task',
      track: async () => ({
        taskId: 'seller-proposal-task',
        status: 'completed',
        taskType: 'request_proposals',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        result: projectionOnlyCompletion().data,
      }),
      waitForCompletion: async () => projectionOnlyCompletion(),
    },
  });

  const pending = await agent.requestProposals(request);
  await assert.rejects(pending.submitted.track(), /projection-only products_available/);
  await assert.rejects(pending.submitted.waitForCompletion(0), /projection-only products_available/);
});

test('AgentClient rejects projection-only products_available from deferred request_proposals completions', async () => {
  const agent = nativeAgent();
  agent.client.executeTask = async () => ({
    success: true,
    status: 'deferred',
    metadata: { ...projectionOnlyCompletion('deferred').metadata, status: 'deferred' },
    deferred: {
      token: 'resume-proposal-task',
      resume: async () => projectionOnlyCompletion(),
    },
  });

  const deferred = await agent.requestProposals(request);
  await assert.rejects(deferred.deferred.resume({ approved: true }), /projection-only products_available/);
});

function projectionOnlyTask() {
  return {
    taskId: 'seller-proposal-task',
    status: 'completed',
    taskType: 'request_proposals',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    result: projectionOnlyCompletion().data,
  };
}

test('AgentClient rejects projection-only request_proposals task reads and events', async () => {
  const agent = nativeAgent();
  agent.client.listTasks = async () => [projectionOnlyTask()];
  agent.client.getTaskInfo = async () => projectionOnlyTask();

  await assert.rejects(agent.listTasks(), /projection-only products_available/);
  await assert.rejects(agent.getTaskInfo('seller-proposal-task'), /projection-only products_available/);
  agent.client.getActiveTasks = () => [
    { ...projectionOnlyTask(), taskName: 'request_proposals', agent: { id: agent.agent.id } },
  ];
  assert.throws(() => agent.getActiveTasks(), /projection-only products_available/);

  let updateListener;
  agent.client.onTaskUpdate = listener => {
    updateListener = listener;
    return () => {};
  };
  agent.onTaskUpdate(() => assert.fail('projection-only update reached caller'));
  assert.throws(() => updateListener(projectionOnlyTask()), /projection-only products_available/);

  let eventListeners;
  agent.client.onTaskEvents = listeners => {
    eventListeners = listeners;
    return () => {};
  };
  agent.onTaskEvents({ onTaskCompleted: () => assert.fail('projection-only event reached caller') });
  assert.throws(() => eventListeners.onTaskCompleted(projectionOnlyTask()), /projection-only products_available/);
});

test('AgentClient rejects projection-only request_proposals webhook completions before handlers', async () => {
  let handlerCalled = false;
  let externalStatusObserved = false;
  const agent = new AgentClient(
    {
      id: 'native-compact-seller',
      name: 'Native compact seller',
      agent_uri: 'https://seller.example/mcp',
      protocol: 'mcp',
    },
    {
      allowUnauthenticatedWebhooks: true,
      validateFeatures: false,
      handlers: { onTaskStatusChange: () => (handlerCalled = true) },
    }
  );
  agent.client.executor.observeExternalTaskStatus = () => {
    externalStatusObserved = true;
  };
  const payload = {
    idempotency_key: 'proposal-webhook-event-0001',
    operation_id: 'proposal-operation',
    task_id: 'seller-proposal-task',
    task_type: 'request_proposals',
    status: 'completed',
    timestamp: '2026-08-21T12:00:00.000Z',
    result: projectionOnlyCompletion().data,
  };

  await assert.rejects(
    agent.handleWebhook(payload, 'request_proposals', 'proposal-operation'),
    /projection-only products_available/
  );
  assert.equal(handlerCalled, false);
  assert.equal(externalStatusObserved, false);
});

test('SingleAgentClient generic execution and task lists enforce the native request_proposals guard', async () => {
  const client = new SingleAgentClient(
    {
      id: 'native-compact-seller',
      name: 'Native compact seller',
      agent_uri: 'https://seller.example/mcp',
      protocol: 'mcp',
    },
    { validateFeatures: false }
  );
  client.executeTaskUnprojected = async () => projectionOnlyCompletion();
  await assert.rejects(client.executeTask('request_proposals', request), /projection-only products_available/);

  client.executor.getTaskList = async () => [projectionOnlyTask()];
  await assert.rejects(client.listTasks(), /projection-only products_available/);

  client.executor.getActiveTasks = () => [
    { ...projectionOnlyTask(), taskName: 'request_proposals', agent: { id: 'native-compact-seller' } },
  ];
  assert.throws(() => client.getActiveTasks(), /projection-only products_available/);
});
