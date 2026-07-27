const { describe, test, mock } = require('node:test');
const assert = require('node:assert/strict');

const { SingleAgentClient } = require('../../dist/lib/core/SingleAgentClient.js');
const { TaskExecutor, ProtocolClient } = require('../../dist/lib/index.js');
const { packageRefsForFormatOptions, toCanonicalOnlyResponse } = require('../../dist/lib/v2/projection');

const agentConfig = {
  id: 'legacy-seller',
  name: 'Legacy seller',
  agent_uri: 'https://seller.example/mcp',
  protocol: 'mcp',
};

const legacyUrl = 'https://formats.publisher.example/agent';
const legacyId = 'publisher_image_v7';
const legacyFormat = { agent_url: legacyUrl, id: legacyId };
const pricingOptions = [{ pricing_option_id: 'cpm', pricing_model: 'cpm', currency: 'USD', fixed_price: 5 }];

function legacyProducts() {
  return {
    products: [
      {
        product_id: 'product-1',
        name: 'Legacy product',
        description: 'Custom legacy format',
        format_ids: [legacyFormat],
        pricing_options: pricingOptions,
      },
    ],
    extension: { target_format_ids: [legacyFormat] },
  };
}

function metadata(status, taskId = 'runner-task') {
  return {
    taskId,
    serverTaskId: 'seller-task',
    taskName: 'get_products',
    agent: { id: agentConfig.id, name: agentConfig.name, protocol: agentConfig.protocol },
    responseTimeMs: 1,
    timestamp: '2026-07-24T12:00:00.000Z',
    clarificationRounds: 0,
    status,
  };
}

function completedResult() {
  return {
    success: true,
    status: 'completed',
    data: legacyProducts(),
    metadata: metadata('completed'),
    conversation: [{ id: 'm1', role: 'agent', content: legacyProducts(), timestamp: '2026-07-24T12:00:00Z' }],
    debug_logs: [{ message: `seller returned format_id ${legacyId} from ${legacyUrl}` }],
  };
}

function converter() {
  return {
    format_option_id: 'publisher-image',
    format_kind: 'image',
    params: { width: 300, height: 250 },
  };
}

function makeClient(executeTask, config = {}) {
  const client = new SingleAgentClient(agentConfig, {
    validateFeatures: false,
    validation: { requests: 'off', responses: 'off', rejectProductsWithoutPricingOptions: false },
    ...config,
  });
  client.discoveredEndpoint = agentConfig.agent_uri;
  client.cachedCapabilities = {
    version: 'v3',
    majorVersions: [3],
    protocols: ['media_buy'],
    features: { canonicalCreatives: false },
    extensions: [],
    _synthetic: false,
  };
  client.ensureEndpointDiscovered = async () => agentConfig;
  client.detectServerVersion = async () => 'v3';
  client.validateTaskFeatures = async () => {};
  client.executor.validateRequest = () => {};
  client.executor.executeTask = executeTask;
  return client;
}

function assertCanonical(value) {
  const json = JSON.stringify(value);
  assert.doesNotMatch(json, /format_ids?|v1_format_ref/);
  assert.doesNotMatch(json, /publisher_image_v7|formats\.publisher\.example/);
}

describe('canonical creative asynchronous boundaries', () => {
  test('synchronous completion callbacks receive completed status metadata', async () => {
    let callbackMetadata;
    const client = makeClient(async () => completedResult(), {
      handlers: {
        onGetProductsStatusChange: (_response, metadata) => {
          callbackMetadata = metadata;
        },
      },
    });

    await client.getProducts({ brief: 'custom display' }, undefined, { legacyFormatConverter: converter });

    assert.equal(callbackMetadata.status, 'completed');
    assert.equal(callbackMetadata.task_type, 'get_products');
  });

  test('projects partial, track, wait, conversation, and diagnostics with the per-call converter', async () => {
    const submitted = {
      success: true,
      status: 'submitted',
      data: legacyProducts(),
      metadata: metadata('submitted'),
      conversation: [{ id: 'm1', role: 'agent', content: legacyProducts(), timestamp: '2026-07-24T12:00:00Z' }],
      debug_logs: [{ message: `format_id ${legacyId} from ${legacyUrl}` }],
      submitted: {
        taskId: 'seller-task',
        track: async () => ({
          taskId: 'seller-task',
          taskType: 'get_products',
          status: 'completed',
          createdAt: 1,
          updatedAt: 2,
          result: legacyProducts(),
        }),
        waitForCompletion: async () => completedResult(),
      },
    };
    const client = makeClient(async () => submitted);

    const result = await client.getProducts({ brief: 'custom display' }, undefined, {
      legacyFormatConverter: converter,
    });
    assert.equal(result.data.products[0].format_options[0].format_kind, 'image');
    assert.equal(result.conversation[0].content.products[0].format_options[0].format_kind, 'image');
    assertCanonical(result);

    const tracked = await result.submitted.track();
    assert.equal(tracked.result.products[0].format_options[0].format_kind, 'image');
    assertCanonical(tracked);

    const completed = await result.submitted.waitForCompletion(1);
    assert.equal(completed.data.products[0].format_options[0].format_kind, 'image');
    assertCanonical(completed);
  });

  test('projects deferred resume and sanitizes input-handler context helpers', async () => {
    let observedContext;
    const deferred = {
      success: true,
      status: 'deferred',
      metadata: metadata('deferred'),
      conversation: [{ id: 'm1', role: 'agent', content: legacyProducts(), timestamp: '2026-07-24T12:00:00Z' }],
      deferred: {
        token: 'human-token',
        question: `Approve format_id ${legacyId} from agent_url ${legacyUrl}`,
        resume: async () => completedResult(),
      },
    };
    const client = makeClient(async (_agent, _task, _params, inputHandler) => {
      observedContext = await inputHandler({
        messages: [{ id: 'm1', role: 'agent', content: legacyProducts(), timestamp: '2026-07-24T12:00:00Z' }],
        inputRequest: { question: `Choose ${legacyId}`, extension: { input_format_ids: [legacyFormat] } },
        taskId: 'runner-task',
        agent: { id: agentConfig.id, name: agentConfig.name, protocol: agentConfig.protocol },
        attempt: 1,
        maxAttempts: 3,
        deferToHuman: async () => ({ defer: true, token: 'human-token' }),
        abort: () => {},
        getSummary: () => JSON.stringify(legacyProducts()),
        wasFieldDiscussed: () => false,
        getPreviousResponse: () => legacyProducts(),
      });
      return deferred;
    });

    const result = await client.getProducts(
      { brief: 'custom display' },
      context => {
        assertCanonical(context.messages);
        assertCanonical(context.inputRequest);
        assertCanonical(context.getSummary());
        assertCanonical(context.getPreviousResponse('format'));
        assert.equal(context.messages[0].content.products[0].format_options[0].format_kind, 'image');
        assert.equal(context.getPreviousResponse('format').products[0].format_options[0].format_kind, 'image');
        return context.deferToHuman();
      },
      { legacyFormatConverter: converter }
    );
    assert.deepEqual(observedContext, { defer: true, token: 'human-token' });
    assertCanonical(result);
    assertCanonical(result.deferred.question);

    const resumed = await result.deferred.resume({ approved: true });
    assert.equal(resumed.data.products[0].format_options[0].format_kind, 'image');
    assertCanonical(resumed);
  });

  test('sanitizes stored history and task-event callbacks', async () => {
    const client = makeClient(async () => completedResult());
    client.executor.getConversationHistory = () => [
      { id: 'm1', role: 'agent', content: legacyProducts(), timestamp: '2026-07-24T12:00:00Z' },
    ];
    let taskEventHandler;
    let taskUpdateHandler;
    client.executor.onTaskEvents = (_agentId, callbacks) => {
      taskEventHandler = callbacks;
      return () => {};
    };
    client.executor.onTaskUpdate = (_agentId, callback) => {
      taskUpdateHandler = callback;
      return () => {};
    };

    const result = await client.getProducts({ brief: 'custom display' }, undefined, {
      legacyFormatConverter: converter,
    });
    assertCanonical(client.getConversationHistory(result.metadata.taskId));

    let completedEvent;
    client.onTaskEvents({ onTaskCompleted: task => (completedEvent = task) });
    taskEventHandler.onTaskCompleted({
      taskId: result.metadata.taskId,
      taskType: 'get_products',
      status: 'completed',
      createdAt: 1,
      updatedAt: 2,
      result: legacyProducts(),
    });
    assertCanonical(completedEvent);
    assert.equal(completedEvent.result.products[0].format_options[0].format_kind, 'image');

    const rawTaskInfo = {
      taskId: result.metadata.taskId,
      taskType: 'get_products',
      status: 'completed',
      createdAt: 1,
      updatedAt: 2,
      result: legacyProducts(),
    };
    client.executor.getTaskInfo = async () => rawTaskInfo;
    client.executor.getTaskList = async () => [rawTaskInfo];
    const detailed = await client.getTaskInfo(result.metadata.taskId);
    const listed = await client.listTasks();
    assert.equal(detailed.result.products[0].format_options[0].format_kind, 'image');
    assert.equal(listed[0].result.products[0].format_options[0].format_kind, 'image');
    assertCanonical(detailed);
    assertCanonical(listed);

    let updatedEvent;
    client.onTaskUpdate(task => (updatedEvent = task));
    taskUpdateHandler(rawTaskInfo);
    assert.equal(updatedEvent.result.products[0].format_options[0].format_kind, 'image');
    assertCanonical(updatedEvent);
  });

  test('sanitizes input-required metadata and active-task reflection without removing legitimate agent URLs', async () => {
    const inputRequired = {
      success: true,
      status: 'input-required',
      data: legacyProducts(),
      metadata: {
        ...metadata('input-required'),
        inputRequest: {
          question: `Choose format_id ${legacyId} from agent_url ${legacyUrl}`,
          extension: { target_format_ids: [legacyFormat] },
        },
      },
    };
    const client = makeClient(async () => inputRequired);
    client.executor.getActiveTasks = () => [
      {
        taskId: 'runner-task',
        taskName: 'get_products',
        params: { extension: { format_id: legacyFormat } },
        status: 'input-required',
        messages: [{ role: 'agent', content: legacyProducts() }],
        pendingInput: inputRequired.metadata.inputRequest,
        startTime: 1,
        attempt: 1,
        maxAttempts: 3,
        options: {
          buyer_agent_url: 'https://buyer.example/mcp',
          agent: { id: 'buyer', name: 'Buyer', agent_url: 'https://buyer.example/mcp' },
        },
        agent: { id: agentConfig.id, name: agentConfig.name, protocol: agentConfig.protocol },
      },
    ];

    const result = await client.getProducts({ brief: 'custom display' }, undefined, {
      legacyFormatConverter: converter,
    });
    assertCanonical(result.metadata.inputRequest);

    const active = client.getActiveTasks();
    assertCanonical(active);
    assert.equal(active[0].options.buyer_agent_url, 'https://buyer.example/mcp');
    assert.equal(active[0].options.agent.agent_url, 'https://buyer.example/mcp');
  });

  test('keeps creative conversation continuations canonical with the original per-call converter', async () => {
    let calls = 0;
    const activities = [];
    const transportActivities = [];
    let client;
    client = makeClient(
      async (_agent, taskName) => {
        calls += 1;
        if (taskName === 'continue_conversation') {
          await client.executor.config.onActivity({
            type: 'protocol_response',
            operation_id: 'creative-context',
            agent_id: agentConfig.id,
            task_id: 'creative-context',
            task_type: taskName,
            status: 'completed',
            payload: legacyProducts(),
            timestamp: '2026-07-24T12:00:00.000Z',
          });
          await client.executor.config.onTransportActivity({
            type: 'response_received',
            agentId: agentConfig.id,
            protocol: 'mcp',
            taskType: taskName,
            responseBody: JSON.stringify(legacyProducts()),
            timestamp: '2026-07-24T12:00:00.000Z',
          });
        }
        const result = completedResult();
        result.metadata.contextId = 'creative-context';
        result.metadata.taskName = taskName;
        return result;
      },
      {
        onActivity: activity => activities.push(activity),
        onTransportActivity: activity => transportActivities.push(activity),
      }
    );

    const initial = await client.getProducts({ brief: 'custom display' }, undefined, {
      legacyFormatConverter: converter,
    });
    assert.equal(initial.data.products[0].format_options[0].format_kind, 'image');

    const continued = await client.continueConversation('Show another option', 'creative-context');
    assert.equal(calls, 2);
    assert.equal(continued.data.products[0].format_options[0].format_kind, 'image');
    assert.equal(activities[0].payload.products[0].format_options[0].format_kind, 'image');
    assert.equal(JSON.parse(transportActivities[0].responseBody).products[0].format_options[0].format_kind, 'image');
    assertCanonical(continued);
    assertCanonical(activities);
    assertCanonical(transportActivities);
  });

  test('sanitizes transport diagnostics and verify-only webhook parsing', async () => {
    const transportEvents = [];
    let dispatchedMetadata;
    const client = makeClient(async () => completedResult(), {
      legacyFormatConverter: converter,
      onTransportActivity: event => transportEvents.push(event),
      handlers: {
        onGetProductsStatusChange: (_response, metadata) => {
          dispatchedMetadata = metadata;
        },
      },
    });
    await client.executor.config.onTransportActivity({
      type: 'response_received',
      agentId: agentConfig.id,
      protocol: 'mcp',
      tool: 'get_products',
      taskType: 'get_products',
      method: 'POST',
      url: agentConfig.agent_uri,
      requestHeaders: {},
      requestBody: JSON.stringify({ brief: 'display' }),
      responseBody: JSON.stringify({ result: legacyProducts() }),
      startedAt: '2026-07-24T12:00:00.000Z',
      timestamp: '2026-07-24T12:00:00.001Z',
    });
    assertCanonical(transportEvents);

    const webhookPayload = {
      idempotency_key: 'event-1',
      operation_id: 'runner-task',
      task_id: 'seller-task',
      task_type: 'get_products',
      status: 'completed',
      message: `Completed format_id ${legacyId} from agent_url ${legacyUrl}`,
      timestamp: '2026-07-24T12:00:00.000Z',
      result: legacyProducts(),
    };
    const parsed = await client.verifyAndParseWebhook({
      taskType: 'get_products',
      operationId: 'runner-task',
      payload: webhookPayload,
    });
    assert.equal(parsed.ok, true);
    assert.equal(parsed.result.products[0].format_options[0].format_kind, 'image');
    assert.equal(parsed.envelope.result.products[0].format_options[0].format_kind, 'image');
    assertCanonical(parsed);

    assert.equal(await client.handleWebhook(webhookPayload, 'get_products', 'runner-task'), true);
    assertCanonical(dispatchedMetadata);
  });

  test('bounds creative task associations with LRU eviction and clears explicit conversation state', () => {
    const client = makeClient(async () => completedResult());

    for (let index = 0; index <= 10_000; index += 1) {
      client.rememberCanonicalCreativeTaskAssociation(`association-${index}`, 'get_products', converter);
    }

    assert.equal(client.canonicalCreativeTaskAssociations.size, 10_000);
    assert.equal(client.canonicalCreativeTaskAssociations.has('association-0'), false);
    assert.equal(client.canonicalCreativeTaskAssociations.has('association-10000'), true);

    // Reads touch the LRU position: association-1 survives the next insertion,
    // while the next-coldest association is evicted.
    assert.equal(client.canonicalCreativeTaskAssociation('association-1').taskType, 'get_products');
    client.rememberCanonicalCreativeTaskAssociation('association-10001', 'list_creatives', converter);
    assert.equal(client.canonicalCreativeTaskAssociations.has('association-1'), true);
    assert.equal(client.canonicalCreativeTaskAssociations.has('association-2'), false);
    assert.equal(client.canonicalCreativeTaskAssociations.size, 10_000);

    client.clearConversationHistory('association-1');
    assert.equal(client.canonicalCreativeTaskAssociations.has('association-1'), false);

    for (let index = 0; index <= 10_000; index += 1) {
      client.rememberProductPolicyRequestParams(
        'get_products',
        {
          account: { account_id: `account-${index}` },
          property_list: {
            agent_url: 'https://lists.example/mcp',
            list_id: `policy-${index}`,
            auth_token: `list-token-${index}`,
          },
          push_notification_config: { authentication: { credentials: `webhook-secret-${index}` } },
        },
        {
          success: true,
          status: 'submitted',
          metadata: metadata('submitted', `policy-${index}`),
        }
      );
    }
    assert.equal(client.productPolicyRequestParamsByTask.size, 10_000);
    assert.equal(client.productPolicyRequestParamsByTask.has('policy-0'), false);
    assert.equal(client.productPolicyRequestParamsByTask.has('policy-10000'), true);
    assert.deepEqual(client.productPolicyRequestParamsForKey('policy-2'), {
      account: { account_id: 'account-2' },
      property_list: {
        agent_url: 'https://lists.example/mcp',
        list_id: 'policy-2',
        auth_token: 'list-token-2',
      },
    });
    assert.doesNotMatch(JSON.stringify(client.productPolicyRequestParamsForKey('policy-2')), /webhook-secret/);
    client.rememberProductPolicyRequestParams(
      'get_products',
      { property_list: { agent_url: 'https://lists.example/mcp', list_id: 'policy-10001' } },
      {
        success: true,
        status: 'submitted',
        metadata: metadata('submitted', 'policy-10001'),
      }
    );
    assert.equal(client.productPolicyRequestParamsByTask.has('policy-2'), true);
    assert.equal(client.productPolicyRequestParamsByTask.has('policy-3'), false);
    client.clearConversationHistory('policy-10000');
    assert.equal(client.productPolicyRequestParamsByTask.has('policy-10000'), false);
  });

  test('retains routing snapshots only for package-route tasks', () => {
    const client = makeClient(async () => completedResult());
    const request = {
      account: { account_id: 'acct-routing' },
      packages: [
        {
          package_id: 'pkg-routing',
          product_id: 'product-routing',
          format_option_refs: [{ scope: 'product', format_option_id: 'image-routing' }],
          creatives: [{ assets: { hero: { data: 'must-not-be-retained' } } }],
        },
      ],
      reporting_webhook: { authentication: { credentials: 'must-not-be-retained' } },
    };

    for (const taskType of ['create_media_buy', 'update_media_buy', 'get_media_buys']) {
      client.rememberCanonicalCreativeTaskAssociation(`routing-${taskType}`, taskType, undefined, request);
      const association = client.canonicalCreativeTaskAssociations.get(`routing-${taskType}`);
      assert.deepEqual(association.routingSnapshot, {
        account: { account_id: 'acct-routing' },
        packages: [
          {
            package_id: 'pkg-routing',
            product_id: 'product-routing',
            format_option_refs: [{ scope: 'product', format_option_id: 'image-routing' }],
          },
        ],
      });
      assert.doesNotMatch(JSON.stringify(association), /must-not-be-retained|creatives|reporting_webhook/);
    }

    for (const taskType of [
      'get_products',
      'sync_creatives',
      'list_creatives',
      'get_media_buy_delivery',
      'get_creative_delivery',
    ]) {
      client.rememberCanonicalCreativeTaskAssociation(`no-routing-${taskType}`, taskType, undefined, request);
      assert.strictEqual(
        client.canonicalCreativeTaskAssociations.get(`no-routing-${taskType}`).routingSnapshot,
        undefined
      );
    }

    const refs = Array.from({ length: 500 }, (_, index) => ({
      scope: 'product',
      format_option_id: `large-option-${index}`,
    }));
    client.rememberCanonicalCreativeTaskIds(
      {
        success: true,
        status: 'submitted',
        metadata: {
          ...metadata('submitted', 'routing-operation'),
          contextId: 'routing-context',
          serverTaskId: 'routing-server',
          taskName: 'create_media_buy',
        },
        submitted: { taskId: 'routing-submitted' },
      },
      'create_media_buy',
      undefined,
      {
        account: { account_id: 'acct-shared' },
        packages: [{ product_id: 'large-product', format_option_refs: refs }],
      }
    );
    const shared = client.canonicalCreativeTaskAssociations.get('routing-operation').routingSnapshot;
    for (const key of ['routing-context', 'routing-server', 'routing-submitted']) {
      assert.strictEqual(client.canonicalCreativeTaskAssociations.get(key).routingSnapshot, shared);
    }
  });

  test('compacts submitted TaskExecutor state before returning continuations', async () => {
    const originalCallTool = ProtocolClient.callTool;
    const request = {
      account: { account_id: 'acct-task-state' },
      creatives: [{ assets: { hero: { data: `inline-task-state-${'x'.repeat(128 * 1024)}` } } }],
      reporting_webhook: { authentication: { credentials: 'task-state-webhook-secret' } },
    };
    try {
      ProtocolClient.callTool = mock.fn(async (_agent, taskName) => {
        if (taskName === 'tasks/get' || taskName === 'tasks_get') {
          return {
            task_id: 'seller-task-state',
            task_type: 'create_media_buy',
            protocol: 'media-buy',
            status: 'completed',
            created_at: '2026-07-27T12:00:00.000Z',
            updated_at: '2026-07-27T12:00:01.000Z',
            result: { media_buy_id: 'mb-task-state', packages: [] },
          };
        }
        return { status: 'submitted', task_id: 'seller-task-state' };
      });
      const executor = new TaskExecutor({ validation: { requests: 'off', responses: 'off' } });
      const result = await executor.executeTask(agentConfig, 'create_media_buy', request, undefined, {
        metadata: { credential: 'task-option-secret' },
      });
      const active = executor.getActiveTasks();
      assert.equal(active.length, 1);
      assert.equal(active[0].status, 'submitted');
      assert.equal(active[0].params, undefined);
      assert.deepEqual(active[0].messages, []);
      assert.deepEqual(active[0].options, {});
      assert.doesNotMatch(
        JSON.stringify(active),
        /inline-task-state|task-state-webhook-secret|task-option-secret|reporting_webhook|assets/
      );

      const completed = await result.submitted.waitForCompletion(1);
      assert.equal(completed.status, 'completed');
      assert.equal(executor.getActiveTasks()[0].status, 'completed');
      assert.equal(executor.getActiveTasks()[0].params, undefined);

      ProtocolClient.callTool = mock.fn(async () => ({ status: 'working', task_id: 'seller-working-state' }));
      const workingExecutor = new TaskExecutor({ validation: { requests: 'off', responses: 'off' } });
      const working = await workingExecutor.executeTask(agentConfig, 'create_media_buy', request, undefined, {
        metadata: { credential: 'working-option-secret' },
      });
      assert.equal(working.status, 'working');
      const workingState = workingExecutor.getActiveTasks()[0];
      assert.equal(workingState.status, 'working');
      assert.equal(workingState.params, undefined);
      assert.deepEqual(workingState.messages, []);
      assert.deepEqual(workingState.options, {});
      assert.doesNotMatch(
        JSON.stringify(workingState),
        /inline-task-state|task-state-webhook-secret|working-option-secret|reporting_webhook|assets/
      );

      ProtocolClient.callTool = mock.fn(async (_agent, taskName) => {
        if (taskName === 'tasks/get' || taskName === 'tasks_get') {
          return {
            task_id: 'seller-paused-state',
            task_type: 'create_media_buy',
            protocol: 'media-buy',
            status: 'input-required',
            created_at: '2026-07-27T12:00:00.000Z',
            updated_at: '2026-07-27T12:00:01.000Z',
            result: { question: 'Approve?', field: 'approval' },
          };
        }
        return { status: 'submitted', task_id: 'seller-paused-state' };
      });
      const pausedExecutor = new TaskExecutor({ validation: { requests: 'off', responses: 'off' } });
      const pausedSubmission = await pausedExecutor.executeTask(agentConfig, 'create_media_buy', request);
      const paused = await pausedSubmission.submitted.waitForCompletion(1);
      assert.equal(paused.status, 'input-required');
      assert.equal(pausedExecutor.getActiveTasks()[0].status, 'input-required');
      assert.equal(pausedExecutor.getActiveTasks()[0].params, undefined);

      ProtocolClient.callTool = mock.fn(async () => ({
        status: 'input-required',
        question: 'Approve directly?',
        field: 'approval',
        contextId: 'direct-paused-context',
      }));
      const directPausedExecutor = new TaskExecutor({ validation: { requests: 'off', responses: 'off' } });
      const directPaused = await directPausedExecutor.executeTask(agentConfig, 'create_media_buy', request);
      assert.equal(directPaused.status, 'input-required');
      assert.equal(directPausedExecutor.getActiveTasks()[0].params, undefined);
      assert.deepEqual(directPausedExecutor.getActiveTasks()[0].messages, []);

      const boundedExecutor = new TaskExecutor();
      for (let index = 0; index <= 10_000; index += 1) {
        const taskId = `bounded-paused-${index}`;
        boundedExecutor.activeTasks.set(taskId, {
          taskId,
          taskName: 'create_media_buy',
          params: { secret: `bounded-secret-${index}` },
          status: 'submitted',
          messages: [],
          startTime: index,
          attempt: 0,
          maxAttempts: 3,
          options: {},
          agent: { id: agentConfig.id, name: agentConfig.name, protocol: agentConfig.protocol },
        });
        boundedExecutor.compactIntermediateTaskState(taskId, 'input-required');
      }
      assert.equal(boundedExecutor.activeTasks.size, 10_000);
      assert.equal(boundedExecutor.compactedTaskIds.size, 10_000);
      assert.equal(boundedExecutor.activeTasks.has('bounded-paused-0'), false);
      assert.equal(boundedExecutor.activeTasks.has('bounded-paused-10000'), true);
    } finally {
      ProtocolClient.callTool = originalCallTool;
    }
  });

  test('clears every product-policy alias after terminal continuation delivery', async () => {
    const client = makeClient(async () => completedResult());
    const options = { taskId: 'policy-caller-task', contextId: 'policy-caller-context' };
    const request = {
      account: { account_id: 'policy-account' },
      property_list: {
        agent_url: 'https://lists.example/mcp',
        list_id: 'policy-list',
        auth_token: 'policy-auth-token',
      },
      push_notification_config: { authentication: { credentials: 'policy-webhook-secret' } },
    };
    let result = {
      success: true,
      status: 'submitted',
      metadata: {
        ...metadata('submitted', 'policy-runner-task'),
        contextId: 'policy-result-context',
        serverTaskId: 'policy-server-task',
      },
      submitted: {
        taskId: 'policy-submitted-task',
        track: async () => ({ taskId: 'policy-submitted-task', taskType: 'get_products', status: 'working' }),
        waitForCompletion: async () => ({
          success: false,
          status: 'failed',
          error: 'seller failed',
          metadata: metadata('failed', 'policy-completed-task'),
        }),
      },
    };
    result = client.wrapProductPolicySubmittedContinuation(result, 'get_products', request, options);
    const aliases = [
      'policy-runner-task',
      'policy-result-context',
      'policy-server-task',
      'policy-submitted-task',
      'policy-caller-task',
      'policy-caller-context',
    ];
    for (const key of aliases) assert.equal(client.productPolicyRequestParamsByTask.has(key), true);
    assert.doesNotMatch(JSON.stringify([...client.productPolicyRequestParamsByTask.values()]), /policy-webhook-secret/);

    await result.submitted.waitForCompletion();
    for (const key of aliases) assert.equal(client.productPolicyRequestParamsByTask.has(key), false);
  });

  test('clears deferred request state after terminal resume', async () => {
    const originalCallTool = ProtocolClient.callTool;
    const stored = new Map();
    const storage = {
      get: async key => stored.get(key),
      set: async (key, value) => stored.set(key, value),
      delete: async key => stored.delete(key),
      has: async key => stored.has(key),
    };
    let continuing = false;
    try {
      ProtocolClient.callTool = mock.fn(async (_agent, taskName) => {
        if (taskName === 'continue_task') {
          continuing = true;
          return { status: 'completed', data: { media_buy_id: 'mb-deferred', packages: [] } };
        }
        return {
          status: 'input-required',
          question: 'Approve this media buy?',
          field: 'approval',
          contextId: 'deferred-context',
        };
      });
      const executor = new TaskExecutor({
        deferredStorage: storage,
        validation: { requests: 'off', responses: 'off' },
      });
      const request = {
        creatives: [{ assets: { hero: { data: `deferred-inline-${'x'.repeat(128 * 1024)}` } } }],
        reporting_webhook: { authentication: { credentials: 'deferred-webhook-secret' } },
      };
      const deferred = await executor.executeTask(agentConfig, 'create_media_buy', request, async () => ({
        defer: true,
        token: 'deferred-token',
      }));
      assert.equal(deferred.status, 'deferred');
      assert.equal(stored.has('deferred-token'), true);
      assert.match(JSON.stringify(stored.get('deferred-token')), /deferred-webhook-secret/);

      const resumed = await deferred.deferred.resume('approved');
      assert.equal(continuing, true);
      assert.equal(resumed.status, 'completed');
      assert.equal(stored.has('deferred-token'), false);
      const active = executor.getActiveTasks()[0];
      assert.equal(active.status, 'completed');
      assert.equal(active.params, undefined);
      assert.deepEqual(active.messages, []);
      assert.doesNotMatch(JSON.stringify(active), /deferred-inline|deferred-webhook-secret|reporting_webhook|assets/);

      const rejectingStored = new Map();
      const rejectingStorage = {
        get: async key => rejectingStored.get(key),
        set: async (key, value) => rejectingStored.set(key, value),
        delete: async () => {
          throw new Error('deferred delete failed');
        },
        has: async key => rejectingStored.has(key),
      };
      const rejectingExecutor = new TaskExecutor({
        deferredStorage: rejectingStorage,
        validation: { requests: 'off', responses: 'off' },
      });
      const rejectingDeferred = await rejectingExecutor.executeTask(
        agentConfig,
        'create_media_buy',
        request,
        async () => ({ defer: true, token: 'rejecting-deferred-token' })
      );
      await assert.rejects(rejectingDeferred.deferred.resume('approved'), /deferred delete failed/);
      const rejectingActive = rejectingExecutor.getActiveTasks()[0];
      assert.equal(rejectingActive.status, 'failed');
      assert.equal(rejectingActive.params, undefined);
      assert.deepEqual(rejectingActive.messages, []);
      assert.doesNotMatch(
        JSON.stringify(rejectingActive),
        /deferred-inline|deferred-webhook-secret|reporting_webhook|assets/
      );
    } finally {
      ProtocolClient.callTool = originalCallTool;
    }
  });

  test('retains terminal task associations for post-completion history and task APIs', async () => {
    const client = makeClient(async () => completedResult());
    client.rememberCanonicalCreativeTaskAssociation('operation-terminal', 'get_products', converter);
    client.rememberCanonicalCreativeTaskAssociation('task-terminal', 'get_products', converter);

    const handled = await client.handleWebhook(
      {
        idempotency_key: 'terminal-event',
        operation_id: 'operation-terminal',
        context_id: 'context-live',
        task_id: 'task-terminal',
        task_type: 'get_products',
        status: 'completed',
        timestamp: '2026-07-24T12:00:00.000Z',
        result: legacyProducts(),
      },
      'get_products',
      'operation-terminal'
    );

    assert.equal(handled, false);
    assert.equal(client.canonicalCreativeTaskAssociations.has('operation-terminal'), true);
    assert.equal(client.canonicalCreativeTaskAssociations.has('task-terminal'), true);
    assert.equal(client.canonicalCreativeTaskAssociations.has('context-live'), true);
    assert.equal(
      client.canonicalCreativeTaskAssociation('task-terminal').legacyFormatConverter(legacyFormat).format_kind,
      'image'
    );

    client.executor.getConversationHistory = () => [
      { id: 'm-terminal', role: 'agent', content: legacyProducts(), timestamp: '2026-07-24T12:00:00Z' },
    ];
    client.executor.getTaskInfo = async () => ({
      taskId: 'task-terminal',
      taskType: 'get_products',
      status: 'completed',
      createdAt: 1,
      updatedAt: 2,
      result: legacyProducts(),
    });

    const history = client.getConversationHistory('task-terminal');
    const taskInfo = await client.getTaskInfo('task-terminal');
    assert.equal(history[0].content.products[0].format_options[0].format_kind, 'image');
    assert.equal(taskInfo.result.products[0].format_options[0].format_kind, 'image');
    assertCanonical(history);
    assertCanonical(taskInfo);

    const continued = await client.continueConversation('Refine the completed result', 'context-live');
    assert.equal(continued.data.products[0].format_options[0].format_kind, 'image');
    assertCanonical(continued);
  });

  test('learns a webhook context before activity callbacks can continue it', async () => {
    let client;
    let continuedFromActivity;
    client = makeClient(async () => completedResult(), {
      onActivity: async activity => {
        continuedFromActivity = await client.continueConversation('Refine immediately', activity.context_id);
      },
    });
    client.rememberCanonicalCreativeTaskAssociation('operation-reentrant', 'get_products', converter);
    client.rememberCanonicalCreativeTaskAssociation('task-reentrant', 'get_products', converter);

    await client.handleWebhook(
      {
        idempotency_key: 'reentrant-event',
        operation_id: 'operation-reentrant',
        context_id: 'context-reentrant',
        task_id: 'task-reentrant',
        task_type: 'get_products',
        status: 'completed',
        timestamp: '2026-07-24T12:00:00.000Z',
        result: legacyProducts(),
      },
      'get_products',
      'operation-reentrant'
    );

    assert.equal(continuedFromActivity.data.products[0].format_options[0].format_kind, 'image');
    assertCanonical(continuedFromActivity);
  });

  test('omits raw causes and identity-bearing messages from canonical webhook failures', async () => {
    const client = makeClient(async () => completedResult());
    const invalidJson = await client.verifyAndParseWebhook({
      taskType: 'get_products',
      operationId: 'runner-task',
      body: '{not-json',
    });
    assert.equal(invalidJson.ok, false);
    assert.equal(Object.hasOwn(invalidJson, 'cause'), false);

    const unclassifiedInvalidJson = await client.verifyAndParseWebhook({
      body: `{\"format_id\":\"${legacyId}\",\"agent_url\":\"${legacyUrl}\"`,
    });
    assert.equal(unclassifiedInvalidJson.ok, false);
    assert.equal(Object.hasOwn(unclassifiedInvalidJson, 'cause'), false);
    assert.doesNotMatch(unclassifiedInvalidJson.message, new RegExp(`${legacyId}|legacy\\.example`));

    let toJSONCalls = 0;
    const unknownShape = {
      harmless: true,
      toJSON() {
        toJSONCalls += 1;
        return { format_id: legacyFormat };
      },
    };
    const unsupported = await client.verifyAndParseWebhook({ payload: unknownShape });
    assert.equal(unsupported.ok, false);
    assert.equal(unsupported.code, 'webhook_unsupported_payload');
    assert.equal(Object.hasOwn(unsupported, 'cause'), false);
    assert.equal(toJSONCalls, 0);
    assert.doesNotMatch(unsupported.message, /Received:|format_id|agent_url/);

    const hostileStatus = {
      toJSON() {
        toJSONCalls += 1;
        return `format_id ${legacyId} from agent_url ${legacyUrl}`;
      },
    };
    const invalidStatus = await client.verifyAndParseWebhook({
      payload: {
        idempotency_key: 'hostile-status',
        operation_id: 'hostile-status-operation',
        task_id: 'hostile-status-task',
        task_type: 'get_signals',
        status: hostileStatus,
        timestamp: '2026-07-24T12:00:00.000Z',
        result: {},
      },
    });
    assert.equal(invalidStatus.ok, false);
    assert.equal(invalidStatus.code, 'webhook_envelope_invalid');
    assert.equal(Object.hasOwn(invalidStatus, 'cause'), false);
    assert.equal(toJSONCalls, 0);
    assert.doesNotMatch(invalidStatus.message, new RegExp(`${legacyId}|legacy\\.example`));

    const invalidResult = await client.verifyAndParseWebhook({
      taskType: 'list_creatives',
      operationId: 'runner-task',
      payload: {
        idempotency_key: 'event-invalid-result',
        operation_id: 'runner-task',
        task_id: 'seller-task',
        task_type: 'list_creatives',
        status: 'completed',
        message: `Rejected format_id ${legacyId} from agent_url ${legacyUrl}`,
        timestamp: '2026-07-24T12:00:00.000Z',
        result: {
          creatives: [
            {
              creative_id: 'legacy-custom',
              name: 'Legacy custom',
              format_id: legacyFormat,
              assets: {},
            },
          ],
        },
      },
    });
    assert.equal(invalidResult.ok, false);
    assert.equal(Object.hasOwn(invalidResult, 'cause'), false);
    assertCanonical(invalidResult);

    const payloadRoutedFailure = await client.verifyAndParseWebhook({
      payload: {
        task_type: 'get_products',
        status: 'completed',
        message: `Rejected format_id ${legacyId} from agent_url ${legacyUrl}`,
        result: legacyProducts(),
      },
    });
    assert.equal(payloadRoutedFailure.ok, false);
    assert.equal(Object.hasOwn(payloadRoutedFailure, 'cause'), false);
    assertCanonical(payloadRoutedFailure);

    client.rememberCanonicalCreativeTaskAssociation('known-canonical-operation', 'get_products');
    const mislabeledKnownTask = await client.verifyAndParseWebhook({
      payload: {
        idempotency_key: 'mislabeled-known-task',
        operation_id: 'known-canonical-operation',
        task_id: 'seller-task',
        task_type: 'get_signals',
        status: 'completed',
        timestamp: '2026-07-24T12:00:00.000Z',
        result: legacyProducts(),
      },
    });
    assert.equal(mislabeledKnownTask.ok, false);
    assert.equal(mislabeledKnownTask.code, 'webhook_envelope_invalid');
    assert.equal(Object.hasOwn(mislabeledKnownTask, 'cause'), false);
    assertCanonical(mislabeledKnownTask);

    client.rememberCanonicalCreativeTaskAssociation('known-canonical-operation', 'get_products', converter);
    const validKnownTask = await client.verifyAndParseWebhook({
      taskType: 'unknown',
      payload: {
        idempotency_key: 'valid-known-task',
        operation_id: 'known-canonical-operation',
        task_id: 'seller-task',
        task_type: 'get_products',
        status: 'completed',
        timestamp: '2026-07-24T12:00:00.000Z',
        result: legacyProducts(),
      },
    });
    assert.equal(validKnownTask.ok, true);
    assert.equal(validKnownTask.result.products[0].format_options[0].format_kind, 'image');
    assertCanonical(validKnownTask);
  });

  test('sanitizes failed data, structured errors, and generic media-buy reads', async () => {
    class TypedCreativeError extends Error {
      constructor() {
        super(`Rejected format_id ${legacyId} from agent_url ${legacyUrl}`);
        this.format_id = legacyFormat;
        this.details = { output_format_ids: [legacyFormat] };
        this.buyer_agent_url = 'https://buyer.example/mcp';
      }

      toJSON() {
        return { format_id: legacyFormat, message: this.message };
      }
    }
    const typedError = new TypedCreativeError();
    const reflected = Symbol('reflected');
    typedError[reflected] = { format_id: legacyFormat };
    const failed = {
      success: false,
      status: 'failed',
      data: {
        errors: [{ message: `format_id ${legacyId} from ${legacyUrl}`, details: { format_id: legacyFormat } }],
        extension: { output_format_ids: [legacyFormat] },
      },
      error: `Rejected format_id ${legacyId} from ${legacyUrl}`,
      adcpError: {
        code: 'VALIDATION_ERROR',
        message: `Unknown format_id ${legacyId}`,
        details: { agent_url: legacyUrl, target_format_ids: [legacyFormat] },
      },
      metadata: { ...metadata('failed'), taskName: 'get_media_buys' },
      debug_logs: [{ message: `wire format_id was ${legacyId}` }],
      errorInstance: typedError,
    };
    const client = makeClient(async () => failed);

    const result = await client.executeTask('get_media_buys', { media_buy_ids: ['mb-1'] });
    assert.equal(result.status, 'failed');
    assertCanonical(result);
    assert.equal(result.errorInstance instanceof TypedCreativeError, false);
    assert.equal(result.errorInstance instanceof Error, true);
    assert.equal(Object.hasOwn(result.errorInstance, 'format_id'), false);
    assertCanonical(result.errorInstance.details);
    assertCanonical(result.errorInstance[reflected]);
    assert.equal(result.errorInstance.buyer_agent_url, 'https://buyer.example/mcp');
    assertCanonical(JSON.stringify(result.errorInstance));

    let inheritedReads = 0;
    class PrototypeLeakyError extends Error {
      get format_id() {
        inheritedReads += 1;
        return legacyFormat;
      }

      get details() {
        inheritedReads += 1;
        return { format_id: legacyFormat };
      }
    }
    const inheritedFailure = {
      ...failed,
      errorInstance: new PrototypeLeakyError('legacy failure'),
    };
    const inheritedClient = makeClient(async () => inheritedFailure);
    const inheritedResult = await inheritedClient.executeTask('get_media_buys', { media_buy_ids: ['mb-1'] });
    assert.equal(inheritedReads, 0);
    assert.equal(inheritedResult.errorInstance instanceof PrototypeLeakyError, false);
    assert.equal(inheritedResult.errorInstance instanceof Error, true);
    assert.equal(inheritedResult.errorInstance.format_id, undefined);
    assert.equal(inheritedResult.errorInstance.details, undefined);
  });

  test('never invokes response accessors and rejects cyclic semantic payloads cleanly', async () => {
    let inheritedReads = 0;
    class InheritedResponse {
      constructor() {
        this.media_buys = [];
      }

      get creative_id() {
        inheritedReads += 1;
        return 'inherited-creative';
      }

      get format_id() {
        inheritedReads += 1;
        return legacyFormat;
      }
    }
    const inheritedClient = makeClient(async () => ({
      success: true,
      status: 'completed',
      data: new InheritedResponse(),
      metadata: { ...metadata('completed'), taskName: 'get_media_buys' },
    }));
    const inherited = await inheritedClient.executeTask('get_media_buys', { media_buy_ids: ['mb-1'] });
    assert.equal(inheritedReads, 0);
    assert.equal(inherited.data instanceof InheritedResponse, false);
    assert.equal(inherited.data.creative_id, undefined);
    assert.equal(inherited.data.format_id, undefined);

    let ownGetterReads = 0;
    const accessorPayload = { media_buys: [] };
    Object.defineProperty(accessorPayload, 'creative_id', {
      enumerable: false,
      get() {
        ownGetterReads += 1;
        return 'accessor-creative';
      },
    });
    const accessorClient = makeClient(async () => ({
      success: true,
      status: 'completed',
      data: accessorPayload,
      metadata: { ...metadata('completed'), taskName: 'get_media_buys' },
    }));
    await assert.rejects(
      () => accessorClient.executeTask('get_media_buys', { media_buy_ids: ['mb-1'] }),
      error => error?.code === 'ADCP_CREATIVE_FORMAT_PROJECTION_FAILED' && !(error instanceof RangeError)
    );
    assert.equal(ownGetterReads, 0);

    const cyclicPayload = { media_buys: [] };
    cyclicPayload.self = cyclicPayload;
    const cyclicClient = makeClient(async () => ({
      success: true,
      status: 'completed',
      data: cyclicPayload,
      metadata: { ...metadata('completed'), taskName: 'get_media_buys' },
    }));
    await assert.rejects(
      () => cyclicClient.executeTask('get_media_buys', { media_buy_ids: ['mb-1'] }),
      error => error?.code === 'ADCP_CREATIVE_FORMAT_PROJECTION_FAILED' && !(error instanceof RangeError)
    );
  });

  test('semantically converts legacy creatives in generic media-buy responses', async () => {
    const completed = {
      success: true,
      status: 'completed',
      data: {
        media_buys: [
          {
            media_buy_id: 'mb-legacy-response',
            creatives: [
              {
                creative_id: 'custom-response-creative',
                name: 'Custom response creative',
                format_id: legacyFormat,
                assets: {},
              },
            ],
          },
        ],
      },
      metadata: { ...metadata('completed'), taskName: 'get_media_buys' },
    };
    const client = makeClient(async () => completed);

    const result = await client.getMediaBuys({ media_buy_ids: ['mb-legacy-response'] }, undefined, {
      legacyFormatConverter: converter,
    });
    const creative = result.data.media_buys[0].creatives[0];
    assert.strictEqual(creative.format_kind, 'image');
    assert.strictEqual(creative.format_option_ref.format_option_id, 'publisher-image');
    assertCanonical(result);

    const rejectingClient = makeClient(async () => completed);
    await assert.rejects(
      () => rejectingClient.getMediaBuys({ media_buy_ids: ['mb-legacy-response'] }),
      /legacy creative format has no canonical conversion/
    );
  });

  test('semantically projects protocol and status activity payloads', async () => {
    const activities = [];
    const response = {
      media_buys: [
        {
          media_buy_id: 'mb-activity',
          creatives: [
            {
              creative_id: 'activity-creative',
              name: 'Activity creative',
              format_id: legacyFormat,
              assets: {},
            },
          ],
        },
      ],
    };
    let client;
    client = makeClient(
      async () => {
        for (const type of ['protocol_request', 'protocol_response', 'status_change']) {
          await client.executor.config.onActivity({
            type,
            operation_id: 'runner-task',
            agent_id: agentConfig.id,
            task_id: 'runner-task',
            task_type: 'get_media_buys',
            status: 'completed',
            payload: response,
            timestamp: '2026-07-24T12:00:00.000Z',
          });
        }
        return {
          success: true,
          status: 'completed',
          data: response,
          metadata: { ...metadata('completed'), taskName: 'get_media_buys' },
        };
      },
      { onActivity: activity => activities.push(activity) }
    );

    await client.getMediaBuys({ media_buy_ids: ['mb-activity'] }, undefined, {
      legacyFormatConverter: converter,
    });

    assert.deepEqual(activities[0].payload.params, { media_buy_ids: ['mb-activity'] });
    assert.deepEqual(
      activities.slice(1).map(activity => activity.payload.media_buys[0].creatives[0].format_kind),
      ['image', 'image']
    );
    assertCanonical(activities);
  });

  test('onActivity observes the original canonical custom request across a legacy downgrade', async () => {
    const customLegacyFormat = { agent_url: 'https://seller.example/custom-formats', id: 'homepage_takeover' };
    const inlineAssetPayload = `inline-secret-asset-${'x'.repeat(128 * 1024)}`;
    const webhookCredential = 'terminal-cache-webhook-credential';
    const canonicalProduct = toCanonicalOnlyResponse(
      {
        products: [
          {
            product_id: 'custom-product',
            name: 'Custom product',
            description: 'Custom takeover',
            format_ids: [customLegacyFormat],
          },
        ],
      },
      {
        legacyFormatConverter: () => ({
          format_option_id: 'homepage-takeover',
          format_kind: 'custom',
          format_shape: 'homepage_takeover',
          format_schema: {
            uri: 'https://seller.example/formats/homepage-takeover.json',
            digest: `sha256:${'a'.repeat(64)}`,
          },
          params: {},
        }),
      }
    ).response.products[0];
    const selected = packageRefsForFormatOptions(canonicalProduct, ['homepage-takeover']);
    const activities = [];
    let client;
    client = makeClient(
      async (_agent, taskType, adaptedParams) => {
        await client.executor.config.onActivity({
          type: 'protocol_request',
          operation_id: 'custom-activity',
          agent_id: agentConfig.id,
          task_id: 'custom-activity',
          task_type: taskType,
          status: 'pending',
          payload: { params: adaptedParams },
          timestamp: '2026-07-24T12:00:00.000Z',
        });
        assert.equal(adaptedParams.packages[0].creatives[0].format_id.id, 'homepage_takeover');
        return {
          success: true,
          status: 'completed',
          data: { media_buy_id: 'mb-custom-activity', packages: [] },
          metadata: { ...metadata('completed'), taskName: 'create_media_buy' },
        };
      },
      { onActivity: activity => activities.push(activity) }
    );

    await client.createMediaBuy({
      account: { account_id: 'activity-account' },
      brand: { domain: 'brand.example' },
      start_time: 'asap',
      end_time: '2027-12-31T00:00:00Z',
      idempotency_key: 'custom-activity-idempotency',
      reporting_webhook: {
        url: 'https://buyer.example/reporting',
        authentication: { schemes: ['HMAC-SHA256'], credentials: webhookCredential },
        reporting_frequency: 'daily',
      },
      packages: [
        {
          product_id: 'custom-product',
          budget: 1000,
          pricing_option_id: 'custom-cpm',
          ...selected,
          creatives: [
            {
              creative_id: 'custom-activity-creative',
              name: 'Custom activity creative',
              format_kind: 'custom',
              format_option_ref: selected.format_option_refs[0],
              assets: {
                hero: {
                  asset_type: 'image',
                  url: 'https://cdn.example.com/hero.png',
                  width: 300,
                  height: 250,
                  alt_text: inlineAssetPayload,
                },
              },
            },
          ],
        },
      ],
    });

    assert.ok(activities[0]?.payload?.params, JSON.stringify(activities));
    const observed = activities[0].payload.params.packages[0].creatives[0];
    assert.equal(observed.format_kind, 'custom');
    assert.strictEqual(observed.format_id, undefined);
    assertCanonical(activities);

    for (const key of ['runner-task', 'seller-task']) {
      const association = client.canonicalCreativeTaskAssociations.get(key);
      assert.ok(association, `expected terminal association for ${key}`);
      assert.strictEqual(association.canonicalRequest, undefined);
      assert.deepEqual(association.routingSnapshot, {
        account: { account_id: 'activity-account' },
        packages: [
          {
            product_id: 'custom-product',
            format_option_refs: [{ scope: 'product', format_option_id: 'homepage-takeover' }],
          },
        ],
      });
      const retained = JSON.stringify(association);
      assert.doesNotMatch(retained, /terminal-cache-webhook-credential|inline-secret-asset|reporting_webhook|assets/);
      assert.equal(Object.isFrozen(association.routingSnapshot), true);
      assert.equal(Object.isFrozen(association.routingSnapshot.account), true);
      assert.equal(Object.isFrozen(association.routingSnapshot.packages), true);
      assert.equal(Object.isFrozen(association.routingSnapshot.packages[0]), true);
      assert.equal(Object.isFrozen(association.routingSnapshot.packages[0].format_option_refs), true);
      assert.equal(Object.isFrozen(association.routingSnapshot.packages[0].format_option_refs[0]), true);
    }
  });
});
