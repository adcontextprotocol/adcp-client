const { test } = require('node:test');
const assert = require('node:assert/strict');

const { SingleAgentClient, TaskExecutor, MemoryStorage } = require('../../dist/lib/index.js');
const { ProtocolClient } = require('../../dist/lib/protocols/index.js');

const agent = {
  id: 'durable-resume-agent',
  name: 'Durable resume agent',
  agent_uri: 'https://seller.example/.well-known/agent-card.json',
  protocol: 'a2a',
};

test('MemoryStorage rejects non-positive atomic continuation TTLs', async () => {
  const storage = new MemoryStorage({ autoCleanup: false });
  try {
    await assert.rejects(storage.putIfAbsent('invalid-put', { continuationVersion: 'v1' }, 0), /positive finite/);
    await storage.set('replace', { continuationVersion: 'v1' });
    await assert.rejects(
      storage.replaceIfVersion('replace', 'v1', { continuationVersion: 'v2' }, -1),
      /positive finite/
    );
  } finally {
    storage.destroy();
  }
});

test('SingleAgentClient resolves the canonical A2A endpoint before resuming after restart', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  let calls = 0;
  ProtocolClient.callTool = async (resolvedAgent, taskName, params, options) => {
    calls += 1;
    if (calls === 1) {
      return {
        result: {
          kind: 'task',
          id: 'seller-durable-task',
          contextId: 'seller-durable-context',
          status: {
            state: 'input-required',
            message: {
              kind: 'message',
              messageId: 'seller-question',
              role: 'agent',
              parts: [{ kind: 'data', data: { question: 'Approve?', field: 'approval' } }],
            },
          },
          artifacts: [],
        },
      };
    }
    assert.equal(resolvedAgent.agent_uri, 'https://seller.example/a2a');
    assert.equal(taskName, 'create_media_buy');
    assert.deepEqual(params, { input: { approved: true } });
    assert.deepEqual(options.session, {
      contextId: 'seller-durable-context',
      taskId: 'seller-durable-task',
    });
    return { status: 'completed', data: { approved: true } };
  };

  try {
    const first = new SingleAgentClient(agent, {
      deferredStorage: storage,
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
    });
    const paused = await first.executor.executeTask(
      agent,
      'create_media_buy',
      {
        idempotency_key: 'single-agent-durable-pause-key',
        account: { account_id: 'account-1' },
      },
      async () => ({
        defer: true,
        token: 'single-agent-durable-token',
      }),
      { skipIdempotencyAutoInject: true, skipAccountValidation: true }
    );
    assert.equal(paused.status, 'deferred', paused.error);

    const restarted = new SingleAgentClient(agent, {
      deferredStorage: storage,
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
    });
    let canonicalResolutions = 0;
    restarted.ensureCanonicalUrlResolved = async () => {
      canonicalResolutions += 1;
      return { ...agent, agent_uri: 'https://seller.example/a2a' };
    };
    const resumed = await restarted.resumeDeferredTask(paused.deferred.token, { approved: true });
    assert.equal(resumed.status, 'completed');
    assert.equal(calls, 2);
    assert.equal(canonicalResolutions, 1);
  } finally {
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

test('SingleAgentClient discovers the current MCP endpoint before resuming persisted state', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = 'mcp-discovered-durable-token';
  const now = Date.now();
  const mcpAgent = {
    id: 'mcp-durable-resume-agent',
    name: 'MCP durable resume agent',
    agent_uri: 'https://seller.example',
    protocol: 'mcp',
  };
  await storage.putIfAbsent(
    token,
    {
      continuationVersion: 'mcp-discovered-version',
      taskId: 'client-correlation-id',
      contextId: 'seller-context-id',
      a2aTaskId: 'seller-task-id',
      serverVersion: 'v3',
      agentId: mcpAgent.id,
      taskName: 'create_media_buy',
      params: { idempotency_key: 'durable-mcp-resume-key' },
      messages: [],
      createdAt: now,
      expiresAt: now + 60_000,
    },
    60
  );

  let discoveryCalls = 0;
  ProtocolClient.callTool = async () => {
    assert.fail('MCP persisted pauses must fail before continuation dispatch');
  };

  try {
    const restarted = new SingleAgentClient(mcpAgent, {
      deferredStorage: storage,
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
    });
    restarted.ensureEndpointDiscovered = async () => {
      discoveryCalls += 1;
      return { ...mcpAgent, agent_uri: 'https://seller.example/oauth/mcp' };
    };
    await assert.rejects(
      restarted.resumeDeferredTask(token, { approved: true }),
      /can only resume an exact A2A seller task/
    );
    assert.equal(discoveryCalls, 1);
    assert.equal(await storage.has(token), true);
  } finally {
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

test('restart resume preserves v2 wire identity and re-enters canonical policy and handler finalization', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  const v2Agent = {
    id: 'v2-canonical-resume-agent',
    name: 'V2 canonical resume agent',
    agent_uri: 'https://seller.example/.well-known/agent-card.json',
    protocol: 'a2a',
  };
  const canonicalAgent = { ...v2Agent, agent_uri: 'https://seller.example/a2a' };
  const legacyDisplayRef = {
    agent_url: 'https://formats.seller.example/mcp',
    id: 'seller_display_300x250',
  };
  const projectionCatalog = (formatOptionId, publisherDomain) => ({
    source: 'configured',
    publisher_domain: publisherDomain,
    formats: [
      {
        format_kind: 'display_tag',
        format_option_id: formatOptionId,
        params: { width: 300, height: 250 },
        v1_format_ref: [legacyDisplayRef],
      },
    ],
  });
  const statusResults = [];
  let calls = 0;
  ProtocolClient.callTool = async (_resolvedAgent, taskName, params, options) => {
    calls += 1;
    assert.equal(taskName, 'get_products');
    assert.equal(options.serverVersion, 'v2');
    if (calls === 1) {
      return {
        result: {
          kind: 'task',
          id: 'seller-v2-task',
          contextId: 'seller-v2-context',
          status: {
            state: 'input-required',
            message: {
              kind: 'message',
              messageId: 'seller-v2-question',
              role: 'agent',
              parts: [{ kind: 'data', data: { question: 'Approve catalog?', field: 'approval' } }],
            },
          },
          artifacts: [],
        },
      };
    }
    assert.deepEqual(params, { input: { approved: true } });
    return {
      result: {
        kind: 'task',
        id: 'seller-v2-task',
        contextId: 'seller-v2-context',
        status: { state: 'completed' },
        artifacts: [
          {
            artifactId: 'get-products-result',
            parts: [
              {
                kind: 'data',
                data: {
                  success: true,
                  products: [
                    {
                      product_id: 'kept-product',
                      name: 'Kept product',
                      description: 'Has a transactable price',
                      publisher_properties: [{ publisher_domain: 'seller.example', selection_type: 'all' }],
                      format_ids: [legacyDisplayRef],
                      delivery_type: 'guaranteed',
                      delivery_measurement: { provider: 'first-party' },
                      pricing_options: [
                        {
                          pricing_option_id: 'po-cpm',
                          pricing_model: 'cpm',
                          rate: 5,
                          currency: 'USD',
                          is_fixed: true,
                        },
                      ],
                      reporting_capabilities: {
                        available_reporting_frequencies: ['daily'],
                        expected_delay_minutes: 60,
                        timezone: 'UTC',
                        supports_webhooks: false,
                        available_metrics: ['impressions'],
                        date_range_support: 'date_range',
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    };
  };

  const config = {
    deferredStorage: storage,
    validateFeatures: false,
    validation: { requests: 'off', responses: 'strict', rejectProductsWithoutPricingOptions: true },
    handlers: {
      onGetProductsStatusChange: data => statusResults.push(data),
    },
    projectionCatalogs: [projectionCatalog('configured-display', 'configured.example')],
  };

  try {
    const first = new SingleAgentClient(v2Agent, config);
    first.ensureEndpointDiscovered = async () => canonicalAgent;
    first.detectServerVersion = async () => 'v2';
    first.getEarlyResultForUnsupportedFeatures = async () => null;
    const perCallProjectionCatalogs = [projectionCatalog('per-call-display', 'per-call.example')];
    const paused = await first.getProducts(
      {
        buying_mode: 'brief',
        brief: 'Find display inventory',
        account: { account_id: 'account-1' },
      },
      async () => ({
        defer: true,
        token: 'v2-canonical-resume-token',
      }),
      { projectionCatalogs: perCallProjectionCatalogs }
    );
    assert.equal(paused.status, 'deferred');
    assert.equal(statusResults.length, 0);
    perCallProjectionCatalogs[0].publisher_domain = 'mutated-after-dispatch.example';
    const persisted = await storage.get(paused.deferred.token);
    assert.equal(persisted.clientContext.projectionCatalogs[0].publisher_domain, 'per-call.example');

    const restarted = new SingleAgentClient(v2Agent, config);
    restarted.ensureCanonicalUrlResolved = async () => canonicalAgent;
    const resumed = await restarted.resumeDeferredTask(paused.deferred.token, { approved: true });

    assert.equal(resumed.status, 'completed');
    assert.ok(Array.isArray(resumed.data?.products), JSON.stringify(resumed));
    assert.equal(resumed.data.products.length, 1);
    assert.equal(resumed.data.products[0].product_id, 'kept-product');
    assert.equal(resumed.data.products[0].format_ids, undefined);
    assert.equal(resumed.data.products[0].format_options[0].format_kind, 'display_tag');
    assert.equal(resumed.data.products[0].format_options[0].format_option_id, 'per-call-display');
    assert.equal(resumed.data.products[0].format_options[0].publisher_domain, 'per-call.example');
    assert.equal(statusResults.length, 1);
    assert.equal(statusResults[0].products[0].format_ids, undefined);

    const selectedOption = resumed.data.products[0].format_options[0];
    let capturedPurchase;
    restarted.getCapabilities = async () => ({ features: { canonicalCreatives: false } });
    restarted.executeAndHandle = async (_taskName, _handlerName, wireParams) => {
      capturedPurchase = wireParams;
      return { success: true, status: 'completed', data: { media_buy_id: 'mb-after-resume', packages: [] } };
    };
    await restarted.createMediaBuy({
      account: { account_id: 'account-1' },
      brand: { domain: 'buyer.example' },
      start_time: 'asap',
      end_time: '2027-12-31T00:00:00Z',
      packages: [
        {
          buyer_ref: 'pkg-after-resume',
          product_id: resumed.data.products[0].product_id,
          pricing_option_id: 'po-cpm',
          budget: 1000,
          format_option_refs: [
            {
              scope: selectedOption.publisher_domain ? 'publisher' : 'product',
              ...(selectedOption.publisher_domain && { publisher_domain: selectedOption.publisher_domain }),
              format_option_id: selectedOption.format_option_id,
            },
          ],
        },
      ],
    });
    assert.equal(capturedPurchase.packages[0].format_option_refs, undefined);
    assert.deepEqual(capturedPurchase.packages[0].format_ids, [legacyDisplayRef]);
  } finally {
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

test('durable clients reject non-serializable per-call projection converters before dispatch', async () => {
  const storage = new MemoryStorage({ autoCleanup: false });
  try {
    const client = new SingleAgentClient(agent, {
      deferredStorage: storage,
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
    });
    await assert.rejects(
      client.getProducts({ buying_mode: 'brief', brief: 'Find display inventory' }, undefined, {
        legacyFormatConverter: () => undefined,
      }),
      /cannot be used with durable deferredStorage/
    );
  } finally {
    storage.destroy();
  }
});

test('durable clients reject authenticated property-list verification before seller dispatch', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  let protocolCalls = 0;
  ProtocolClient.callTool = async () => {
    protocolCalls += 1;
    assert.fail('unsupported durable property-list credentials must fail before seller dispatch');
  };
  try {
    const client = new SingleAgentClient(agent, {
      deferredStorage: storage,
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
    });
    await assert.rejects(
      client.getProducts({
        buying_mode: 'brief',
        brief: 'Find private inventory',
        property_list: {
          agent_url: 'https://property-lists.example/mcp',
          list_id: 'private-list',
          auth_token: 'private-list-secret',
        },
      }),
      error => {
        assert.match(error.message, /cannot persist property_list\.auth_token/);
        assert.doesNotMatch(error.message, /private-list-secret/);
        return true;
      }
    );
    assert.equal(protocolCalls, 0);
  } finally {
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

test('durable property-list requests own nested input before asynchronous preflight', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  let releasePreflight;
  let preflightStarted;
  const preflightGate = new Promise(resolve => {
    releasePreflight = resolve;
  });
  const preflightEntered = new Promise(resolve => {
    preflightStarted = resolve;
  });
  const originalTrustedFetch = async () => new Response();
  ProtocolClient.callTool = async (_resolvedAgent, taskName, params, options) => {
    assert.equal(taskName, 'get_products');
    assert.equal(params.property_list.auth_token, undefined);
    assert.equal(options.transport.allowPrivateIp, false);
    assert.equal(options.transport.maxResponseBytes, 2048);
    assert.equal(options.transport.trustedFetchFn, originalTrustedFetch);
    return {
      result: {
        kind: 'task',
        id: 'nested-request-snapshot-task',
        contextId: 'nested-request-snapshot-context',
        status: {
          state: 'input-required',
          message: {
            kind: 'message',
            messageId: 'nested-request-snapshot-question',
            role: 'agent',
            parts: [{ kind: 'data', data: { question: 'Approve?', field: 'approval' } }],
          },
        },
        artifacts: [],
      },
    };
  };
  try {
    const client = new SingleAgentClient(agent, {
      deferredStorage: storage,
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
    });
    client.validateTaskFeatures = async () => {
      preflightStarted();
      await preflightGate;
    };
    client.getEarlyResultForUnsupportedFeatures = async () => null;
    client.ensureEndpointDiscovered = async () => agent;
    client.detectServerVersion = async () => 'v3';
    const request = {
      buying_mode: 'brief',
      brief: 'Find inventory',
      property_list: {
        agent_url: 'https://property-lists.example/mcp',
        list_id: 'public-list',
      },
    };
    const taskOptions = {
      transport: {
        allowPrivateIp: false,
        maxResponseBytes: 2048,
        trustedFetchFn: originalTrustedFetch,
      },
    };
    const pending = client.getProducts(
      request,
      async () => ({
        defer: true,
        token: 'nested-request-snapshot-token',
      }),
      taskOptions
    );
    await preflightEntered;
    request.property_list.auth_token = 'late-caller-secret';
    taskOptions.transport.allowPrivateIp = true;
    taskOptions.transport.maxResponseBytes = 999999;
    taskOptions.transport.trustedFetchFn = async () => new Response('mutated');
    releasePreflight();
    const paused = await pending;
    assert.equal(paused.status, 'deferred');
    assert.doesNotMatch(JSON.stringify(await storage.get(paused.deferred.token)), /late-caller-secret/);
  } finally {
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

test('resumed v2 submitted continuations keep v2 polling semantics', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = 'v2-resumed-submitted-token';
  const now = Date.now();
  await storage.putIfAbsent(
    token,
    {
      continuationVersion: 'v2-submitted-version',
      taskId: 'client-v2-submitted-correlation',
      contextId: 'seller-v2-submitted-context',
      a2aTaskId: 'seller-v2-submitted-a2a-task',
      serverVersion: 'v2',
      agentId: agent.id,
      taskName: 'get_products',
      params: { buying_mode: 'brief', brief: 'Display' },
      messages: [],
      clientContext: {
        kind: 'single-agent',
        taskType: 'get_products',
        handlerName: 'onGetProductsStatusChange',
        canonical: true,
        productPolicyRequest: { account: { account_id: 'account-submitted' } },
      },
      createdAt: now,
      expiresAt: now + 60_000,
    },
    60
  );
  let calls = 0;
  ProtocolClient.callTool = async (_resolvedAgent, taskName, _params, options) => {
    calls += 1;
    assert.equal(options.serverVersion, 'v2');
    if (calls === 1) {
      assert.equal(taskName, 'get_products');
      return { status: 'submitted', task_id: 'seller-v2-work-handle' };
    }
    assert.equal(taskName, 'tasks/get');
    return {
      task_id: 'seller-v2-work-handle',
      task_type: 'get_products',
      status: 'completed',
      result: {
        success: true,
        products: [
          {
            product_id: 'submitted-product',
            name: 'Submitted product',
            description: 'Legacy product completed through polling',
            format_ids: [{ agent_url: 'https://creative.adcontextprotocol.org/', id: 'display_300x250_image' }],
            pricing_options: [
              { pricing_option_id: 'submitted-price', pricing_model: 'cpm', currency: 'USD', fixed_price: 5 },
            ],
          },
        ],
      },
      created_at: now,
      updated_at: now,
    };
  };

  try {
    const restarted = new SingleAgentClient(agent, {
      deferredStorage: storage,
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
    });
    restarted.ensureCanonicalUrlResolved = async () => ({ ...agent, agent_uri: 'https://seller.example/a2a' });
    const submitted = await restarted.resumeDeferredTask(token, { approved: true });
    assert.equal(submitted.status, 'submitted');
    const completed = await submitted.submitted.waitForCompletion(0);
    assert.equal(completed.status, 'completed');
    const selected = completed.data.products[0].format_options[0];
    let capturedPurchase;
    restarted.getCapabilities = async () => ({ features: { canonicalCreatives: false } });
    restarted.executeAndHandle = async (_taskName, _handlerName, wireParams) => {
      capturedPurchase = wireParams;
      return { success: true, status: 'completed', data: { media_buy_id: 'submitted-follow-on', packages: [] } };
    };
    await restarted.createMediaBuy({
      account: { account_id: 'account-submitted' },
      brand: { domain: 'buyer.example' },
      start_time: 'asap',
      end_time: '2027-12-31T00:00:00Z',
      packages: [
        {
          product_id: 'submitted-product',
          pricing_option_id: 'submitted-price',
          budget: 1000,
          format_option_refs: [
            {
              scope: selected.publisher_domain ? 'publisher' : 'product',
              ...(selected.publisher_domain && { publisher_domain: selected.publisher_domain }),
              format_option_id: selected.format_option_id,
            },
          ],
        },
      ],
    });
    assert.equal(capturedPurchase.packages[0].format_option_refs, undefined);
    assert.deepEqual(capturedPurchase.packages[0].format_ids, [
      { agent_url: 'https://creative.adcontextprotocol.org/', id: 'display_300x250_image' },
    ]);
    assert.equal(calls, 2);
  } finally {
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

test('canonical mutation snapshots projection catalogs before capability preflight awaits', async () => {
  const storage = new MemoryStorage({ autoCleanup: false });
  const legacyRef = { agent_url: 'https://formats.example/mcp', id: 'legacy-display' };
  const catalogs = [
    {
      source: 'configured',
      publisher_domain: 'before-await.example',
      formats: [
        {
          format_kind: 'display',
          format_option_id: 'before-await-option',
          params: { width: 300, height: 250 },
          v1_format_ref: [legacyRef],
        },
      ],
    },
  ];
  let releaseCapabilities;
  let capabilityStarted;
  const capabilitiesStarted = new Promise(resolve => {
    capabilityStarted = resolve;
  });
  const capabilityGate = new Promise(resolve => {
    releaseCapabilities = resolve;
  });

  try {
    const client = new SingleAgentClient(agent, {
      deferredStorage: storage,
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
    });
    client.getCapabilities = async () => {
      capabilityStarted();
      await capabilityGate;
      return { features: { canonicalCreatives: true } };
    };
    let capturedConverter;
    let capturedCatalogs;
    let capturedWireParams;
    let capturedCanonicalRequest;
    client.executeAndHandle = async (
      _task,
      _handler,
      wireParams,
      _input,
      _options,
      _transform,
      converter,
      canonicalRequest,
      projectionCatalogs
    ) => {
      capturedConverter = converter;
      capturedCatalogs = projectionCatalogs;
      capturedWireParams = wireParams;
      capturedCanonicalRequest = canonicalRequest;
      return { success: true, status: 'completed', data: { media_buy_id: 'snapshot-buy', packages: [] } };
    };

    const request = {
      account: { account_id: 'account-1' },
      brand: { domain: 'buyer.example' },
      start_time: 'asap',
      end_time: '2027-12-31T00:00:00Z',
      packages: [
        {
          product_id: 'product-1',
          pricing_option_id: 'price-1',
          budget: 1000,
          format_option_refs: [
            {
              scope: 'publisher',
              publisher_domain: 'before-await.example',
              format_option_id: 'before-await-option',
            },
          ],
        },
      ],
    };
    const pending = client.createMediaBuy(request, undefined, { projectionCatalogs: catalogs });
    await capabilitiesStarted;
    catalogs[0].publisher_domain = 'mutated-during-await.example';
    catalogs[0].formats[0].format_option_id = 'mutated-during-await-option';
    request.packages[0].budget = 999999;
    request.packages[0].format_option_refs[0].format_option_id = 'mutated-commercial-option';
    releaseCapabilities();
    await pending;

    assert.equal(capturedCatalogs[0].publisher_domain, 'before-await.example');
    assert.equal(capturedCatalogs[0].formats[0].format_option_id, 'before-await-option');
    assert.equal(capturedConverter({ formatId: legacyRef })?.format_option_id, 'before-await-option');
    assert.equal(capturedWireParams.packages[0].budget, 1000);
    assert.equal(capturedWireParams.packages[0].format_option_refs[0].format_option_id, 'before-await-option');
    assert.equal(capturedCanonicalRequest.packages[0].budget, 1000);
    assert.equal(capturedCanonicalRequest.packages[0].format_option_refs[0].format_option_id, 'before-await-option');
  } finally {
    storage.destroy();
  }
});

test('sync creatives snapshots nested selector options at its public boundary', async () => {
  const client = new SingleAgentClient(agent, {
    validateFeatures: false,
    validation: { requests: 'off', responses: 'off' },
  });
  let capturedParams;
  let capturedOptions;
  let releaseBoundary;
  let boundaryStarted;
  const boundaryGate = new Promise(resolve => {
    releaseBoundary = resolve;
  });
  const boundaryEntered = new Promise(resolve => {
    boundaryStarted = resolve;
  });
  client.syncCreativesWithinDeadline = async (params, _inputHandler, options) => {
    boundaryStarted();
    await boundaryGate;
    capturedParams = params;
    capturedOptions = options;
    return { success: true, status: 'completed', data: { creatives: [] } };
  };
  const request = {
    account: { account_id: 'account-1' },
    idempotency_key: 'sync-snapshot-key',
    creatives: [{ creative_id: 'creative-1', name: 'Creative 1', assets: {} }],
    assignments: [{ creative_id: 'creative-1', package_id: 'package-before-await' }],
  };
  const originalTrustedFetch = async () => new Response();
  const options = {
    transport: {
      maxResponseBytes: 1024,
      requestTimeoutMs: 5000,
      allowPrivateIp: false,
      trustedFetchFn: originalTrustedFetch,
    },
    creativeFormatProjection: {
      selectorContainers: [{ package_id: 'package-before-await' }],
    },
  };
  const pending = client.syncCreatives(request, undefined, options);
  await boundaryEntered;
  request.assignments[0].package_id = 'package-mutated-during-await';
  options.creativeFormatProjection.selectorContainers[0].package_id = 'selector-mutated-during-await';
  options.transport.maxResponseBytes = 999999;
  options.transport.requestTimeoutMs = 1;
  options.transport.allowPrivateIp = true;
  options.transport.trustedFetchFn = async () => new Response('mutated');
  releaseBoundary();
  await pending;
  assert.equal(capturedParams.assignments[0].package_id, 'package-before-await');
  assert.equal(capturedOptions.creativeFormatProjection.selectorContainers[0].package_id, 'package-before-await');
  assert.equal(capturedOptions.transport.maxResponseBytes, 1024);
  assert.equal(capturedOptions.transport.requestTimeoutMs, 5000);
  assert.equal(capturedOptions.transport.allowPrivateIp, false);
  assert.equal(capturedOptions.transport.trustedFetchFn, originalTrustedFetch);
});

test('restart resume routes a committed terminal result through durable settlement exactly once', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = 'committed-restart-settlement-token';
  const now = Date.now();
  await storage.putIfAbsent(
    token,
    {
      continuationVersion: 'committed-restart-version',
      taskId: 'committed-operation-id',
      contextId: 'committed-context-id',
      a2aTaskId: 'committed-a2a-task-id',
      serverVersion: 'v3',
      agentId: agent.id,
      taskName: 'create_media_buy',
      params: { idempotency_key: 'committed-restart-key' },
      messages: [],
      clientContext: {
        kind: 'single-agent',
        taskType: 'create_media_buy',
        handlerName: 'onCreateMediaBuyStatusChange',
        canonical: false,
        productPolicyRequest: {},
      },
      settlementOperationId: 'committed-operation-id',
      settlementServerTaskId: 'committed-seller-work-id',
      createdAt: now,
      expiresAt: now + 60_000,
    },
    60
  );
  ProtocolClient.callTool = async () => ({
    status: 'completed',
    task_id: 'committed-seller-work-id',
    media_buy_id: 'committed-restart-buy',
    packages: [],
  });
  let settlementCalls = 0;
  let completionHandlerCalls = 0;
  let storeCompleted = false;

  try {
    const restarted = new SingleAgentClient(agent, {
      deferredStorage: storage,
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
      handlers: {
        onCreateMediaBuyStatusChange: () => {
          completionHandlerCalls += 1;
        },
      },
    });
    restarted.ensureCanonicalUrlResolved = async () => ({ ...agent, agent_uri: 'https://seller.example/a2a' });
    restarted.registerDurableSettlementRecovery(async (operationId, observation) => {
      settlementCalls += 1;
      assert.equal(operationId, 'committed-operation-id');
      assert.equal(observation.serverTaskId, 'committed-seller-work-id');
      assert.equal(observation.taskType, 'create_media_buy');
      assert.equal(observation.status, 'completed');
      storeCompleted = true;
      return { settled: true, status: 'completed', result: observation.result };
    });

    const completed = await restarted.resumeDeferredTask(token, { approved: true });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.data.media_buy_id, 'committed-restart-buy');
    assert.equal(storeCompleted, true);
    assert.equal(settlementCalls, 1);
    assert.equal(completionHandlerCalls, 1);
    const replay = await restarted.resumeDeferredTask(token, { approved: true });
    assert.equal(replay.status, 'completed');
    assert.equal(replay.data.media_buy_id, 'committed-restart-buy');
    assert.equal(settlementCalls, 1);
    assert.equal(completionHandlerCalls, 1);
  } finally {
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

test('low-level committed resume refuses before seller dispatch and retains the token', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = 'low-level-committed-token';
  const now = Date.now();
  await storage.putIfAbsent(
    token,
    {
      continuationVersion: 'low-level-version',
      taskId: 'low-level-operation',
      a2aTaskId: 'low-level-a2a-task',
      serverVersion: 'v3',
      agentId: agent.id,
      taskName: 'create_media_buy',
      params: {},
      messages: [],
      settlementOperationId: 'low-level-operation',
      settlementServerTaskId: 'low-level-seller-task',
      createdAt: now,
      expiresAt: now + 60_000,
    },
    60
  );
  let protocolCalls = 0;
  ProtocolClient.callTool = async () => {
    protocolCalls += 1;
    return { status: 'completed' };
  };

  try {
    const executor = new TaskExecutor({
      deferredStorage: storage,
      resolveDeferredAgent: async () => agent,
      validation: { requests: 'off', responses: 'off' },
    });
    await assert.rejects(executor.resumeDeferredTask(token, { approved: true }), /settlement recovery is unavailable/);
    assert.equal(protocolCalls, 0);
    assert.equal(await storage.has(token), true);
  } finally {
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

test('owning client without a recoverer refuses committed resume before dispatch', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = 'missing-recoverer-token';
  const now = Date.now();
  await storage.putIfAbsent(
    token,
    {
      continuationVersion: 'missing-recoverer-version',
      taskId: 'missing-recoverer-operation',
      a2aTaskId: 'missing-recoverer-a2a-task',
      serverVersion: 'v3',
      agentId: agent.id,
      taskName: 'create_media_buy',
      params: {},
      messages: [],
      settlementOperationId: 'missing-recoverer-operation',
      settlementServerTaskId: 'missing-recoverer-seller-task',
      createdAt: now,
      expiresAt: now + 60_000,
    },
    60
  );
  let protocolCalls = 0;
  ProtocolClient.callTool = async () => {
    protocolCalls += 1;
    return { status: 'completed' };
  };

  try {
    const client = new SingleAgentClient(agent, {
      deferredStorage: storage,
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
    });
    await assert.rejects(client.resumeDeferredTask(token, { approved: true }), /settlement recovery is unavailable/);
    assert.equal(protocolCalls, 0);
    assert.equal(await storage.has(token), true);
  } finally {
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

test('failed committed recovery retains the terminal observation and retries without seller redispatch', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = 'retryable-terminal-settlement-token';
  const operationId = 'retryable-terminal-operation';
  const now = Date.now();
  await storage.putIfAbsent(
    token,
    {
      continuationVersion: 'retryable-terminal-version',
      taskId: operationId,
      a2aTaskId: 'retryable-terminal-a2a-task',
      serverVersion: 'v3',
      agentId: agent.id,
      taskName: 'create_media_buy',
      params: {},
      messages: [],
      settlementOperationId: operationId,
      settlementServerTaskId: 'retryable-terminal-seller-task',
      createdAt: now,
      expiresAt: now + 60_000,
    },
    60
  );
  let protocolCalls = 0;
  ProtocolClient.callTool = async () => {
    protocolCalls += 1;
    return {
      status: 'completed',
      task_id: 'retryable-terminal-seller-task',
      media_buy_id: 'retryable-terminal-buy',
      packages: [],
      credentials: { private_key: 'seller-terminal-private-key' },
    };
  };

  try {
    const client = new SingleAgentClient(agent, {
      deferredStorage: storage,
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
    });
    client.ensureCanonicalUrlResolved = async () => ({ ...agent, agent_uri: 'https://seller.example/a2a' });
    client.executor.activeTasks.set(operationId, {
      id: operationId,
      status: 'input-required',
      taskName: 'create_media_buy',
      agent,
      params: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const observedStatuses = [];
    client.executor.onTaskUpdate(agent.id, task => observedStatuses.push(task.status));
    client.registerDurableSettlementRecovery(async () => undefined);

    await assert.rejects(
      client.resumeDeferredTask(token, { auth_token: 'resume-input-secret' }),
      /settlement recovery was unavailable/
    );
    assert.equal(protocolCalls, 1);
    assert.equal(await storage.has(token), true);
    const firstCheckpoint = await storage.get(token);
    assert.ok(firstCheckpoint.settlementTerminalResult);
    assert.doesNotMatch(JSON.stringify(firstCheckpoint), /resume-input-secret|seller-terminal-private-key/);
    assert.match(JSON.stringify(firstCheckpoint), /\[redacted\]/);
    assert.equal(observedStatuses.includes('completed'), false);

    let releaseRecovery;
    let recoveryStarted;
    const recoveryGate = new Promise(resolve => {
      releaseRecovery = resolve;
    });
    const recoveryEntered = new Promise(resolve => {
      recoveryStarted = resolve;
    });
    client.registerDurableSettlementRecovery(async (_recoveredOperationId, observation) => {
      recoveryStarted();
      await recoveryGate;
      return {
        settled: true,
        status: 'completed',
        result: observation.result,
      };
    });
    const pendingCompletion = client.resumeDeferredTask(token, { approved: true });
    await recoveryEntered;
    const checkpoint = await storage.get(token);
    assert.equal(
      await storage.putIfAbsent(
        token,
        {
          ...checkpoint,
          continuationVersion: 'unrelated-reused-token-version',
          taskId: 'unrelated-new-task',
          settlementTerminalResult: undefined,
        },
        60
      ),
      false
    );
    releaseRecovery();
    const completed = await pendingCompletion;
    assert.equal(completed.status, 'completed');
    assert.equal(completed.data.media_buy_id, 'retryable-terminal-buy');
    assert.equal(protocolCalls, 1);
    assert.equal(await storage.has(token), true);
    assert.equal(observedStatuses.includes('completed'), true);
  } finally {
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

test('failed completion handler retains the checkpoint and retries finalization without seller redispatch', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = 'retryable-finalizer-token';
  const operationId = 'retryable-finalizer-operation';
  const now = Date.now();
  await storage.putIfAbsent(
    token,
    {
      continuationVersion: 'retryable-finalizer-version',
      taskId: operationId,
      a2aTaskId: 'retryable-finalizer-a2a-task',
      serverVersion: 'v3',
      agentId: agent.id,
      taskName: 'create_media_buy',
      params: {},
      messages: [],
      clientContext: {
        kind: 'single-agent',
        taskType: 'create_media_buy',
        handlerName: 'onCreateMediaBuyStatusChange',
        canonical: false,
        productPolicyRequest: {},
      },
      settlementOperationId: operationId,
      settlementServerTaskId: 'retryable-finalizer-seller-task',
      createdAt: now,
      expiresAt: now + 60_000,
    },
    60
  );
  let protocolCalls = 0;
  let handlerCalls = 0;
  ProtocolClient.callTool = async () => {
    protocolCalls += 1;
    return {
      status: 'completed',
      task_id: 'retryable-finalizer-seller-task',
      media_buy_id: 'retryable-finalizer-buy',
      packages: [],
    };
  };

  try {
    const client = new SingleAgentClient(agent, {
      deferredStorage: storage,
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
      deferredTaskTtlSeconds: 1,
      handlers: {
        onCreateMediaBuyStatusChange: async () => {
          handlerCalls += 1;
          if (handlerCalls === 1) {
            await new Promise(resolve => setTimeout(resolve, 1_200));
            throw new Error('temporary completion publication failure');
          }
        },
      },
    });
    client.ensureCanonicalUrlResolved = async () => ({ ...agent, agent_uri: 'https://seller.example/a2a' });
    client.registerDurableSettlementRecovery(async (_recoveredOperationId, observation) => ({
      settled: true,
      status: 'completed',
      result: observation.result,
    }));

    await assert.rejects(
      client.resumeDeferredTask(token, { approved: true }),
      /temporary completion publication failure/
    );
    assert.equal(protocolCalls, 1);
    assert.equal(await storage.has(token), true);

    const completed = await client.resumeDeferredTask(token, { approved: true });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.data.media_buy_id, 'retryable-finalizer-buy');
    assert.equal(protocolCalls, 1);
    assert.equal(handlerCalls, 2);
  } finally {
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

test('an active terminal checkpoint lease excludes concurrent clients', async () => {
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = 'concurrent-finalizer-token';
  const operationId = 'concurrent-finalizer-operation';
  const now = Date.now();
  await storage.putIfAbsent(
    token,
    {
      continuationVersion: 'concurrent-finalizer-version',
      continuationClaimed: true,
      taskId: operationId,
      a2aTaskId: 'concurrent-finalizer-a2a-task',
      serverVersion: 'v3',
      agentId: agent.id,
      taskName: 'create_media_buy',
      params: {},
      messages: [],
      clientContext: {
        kind: 'single-agent',
        taskType: 'create_media_buy',
        handlerName: 'onCreateMediaBuyStatusChange',
        canonical: false,
        productPolicyRequest: {},
      },
      settlementOperationId: operationId,
      settlementServerTaskId: 'concurrent-finalizer-seller-task',
      settlementTerminalResult: {
        success: true,
        status: 'completed',
        data: {
          task_id: 'concurrent-finalizer-seller-task',
          media_buy_id: 'concurrent-finalizer-buy',
          packages: [],
        },
        metadata: {
          taskId: operationId,
          taskName: 'create_media_buy',
          agent: { id: agent.id, name: agent.name, protocol: agent.protocol },
          responseTimeMs: 1,
          timestamp: new Date().toISOString(),
          clarificationRounds: 0,
          status: 'completed',
        },
        conversation: [],
        debug_logs: [],
      },
      createdAt: now,
      expiresAt: now + 60_000,
    },
    60
  );

  let recoveryCalls = 0;
  let handlerCalls = 0;
  let releaseRecovery;
  let markRecoveryStarted;
  const recoveryGate = new Promise(resolve => {
    releaseRecovery = resolve;
  });
  const recoveryStarted = new Promise(resolve => {
    markRecoveryStarted = resolve;
  });
  const config = {
    deferredStorage: storage,
    validateFeatures: false,
    validation: { requests: 'off', responses: 'off' },
    handlers: {
      onCreateMediaBuyStatusChange: async () => {
        handlerCalls += 1;
      },
    },
  };
  const firstClient = new SingleAgentClient(agent, config);
  const secondClient = new SingleAgentClient(agent, config);
  const recover = async (_recoveredOperationId, observation) => {
    recoveryCalls += 1;
    markRecoveryStarted();
    await recoveryGate;
    return {
      settled: true,
      status: 'completed',
      result: observation.result,
    };
  };
  firstClient.registerDurableSettlementRecovery(recover);
  secondClient.registerDurableSettlementRecovery(recover);

  try {
    const first = firstClient.resumeDeferredTask(token, { approved: true });
    await recoveryStarted;
    await assert.rejects(
      secondClient.resumeDeferredTask(token, { approved: true }),
      /finalization is already in progress|claimed by another replica/
    );
    assert.equal(recoveryCalls, 1);
    assert.equal(handlerCalls, 0);

    releaseRecovery();
    const completed = await first;
    assert.equal(completed.status, 'completed');
    assert.equal(handlerCalls, 1);

    const replay = await secondClient.resumeDeferredTask(token, { approved: true });
    assert.equal(replay.status, 'completed');
    assert.equal(replay.data.media_buy_id, 'concurrent-finalizer-buy');
    assert.equal(recoveryCalls, 1);
    assert.equal(handlerCalls, 1);
  } finally {
    storage.destroy();
  }
});

test('terminal checkpoint receives a fresh recovery horizon when seller continuation crosses token expiry', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = 'cross-expiry-terminal-token';
  const operationId = 'cross-expiry-operation';
  const now = Date.now();
  const originalExpiry = now + 50;
  await storage.putIfAbsent(
    token,
    {
      continuationVersion: 'cross-expiry-version',
      taskId: operationId,
      a2aTaskId: 'cross-expiry-a2a-task',
      serverVersion: 'v3',
      agentId: agent.id,
      taskName: 'create_media_buy',
      params: {},
      messages: [],
      settlementOperationId: operationId,
      settlementServerTaskId: 'cross-expiry-seller-task',
      createdAt: now,
      expiresAt: originalExpiry,
    },
    1
  );
  let protocolCalls = 0;
  ProtocolClient.callTool = async () => {
    protocolCalls += 1;
    await new Promise(resolve => setTimeout(resolve, 1_200));
    return {
      status: 'completed',
      task_id: 'cross-expiry-seller-task',
      media_buy_id: 'cross-expiry-buy',
      packages: [],
    };
  };

  try {
    const client = new SingleAgentClient(agent, {
      deferredStorage: storage,
      deferredTaskTtlSeconds: 1,
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
    });
    client.ensureCanonicalUrlResolved = async () => ({ ...agent, agent_uri: 'https://seller.example/a2a' });
    client.registerDurableSettlementRecovery(async (_recoveredOperationId, observation) => ({
      settled: true,
      status: 'completed',
      result: observation.result,
    }));

    const completed = await client.resumeDeferredTask(token, { approved: true });
    assert.equal(completed.status, 'completed');
    assert.equal(protocolCalls, 1);
    const checkpoint = await storage.get(token);
    assert.ok(checkpoint.settlementTerminalResult);
    assert.ok(checkpoint.expiresAt > originalExpiry + 50_000);
  } finally {
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});

test('ordinary deferred cleanup stays generation-fenced when seller work crosses token expiry', async () => {
  const originalCallTool = ProtocolClient.callTool;
  const storage = new MemoryStorage({ autoCleanup: false });
  const token = 'cross-expiry-ordinary-token';
  const now = Date.now();
  await storage.putIfAbsent(
    token,
    {
      continuationVersion: 'cross-expiry-ordinary-version',
      taskId: 'cross-expiry-ordinary-operation',
      a2aTaskId: 'cross-expiry-ordinary-a2a-task',
      serverVersion: 'v3',
      agentId: agent.id,
      taskName: 'approval_task',
      params: {},
      messages: [],
      createdAt: now,
      expiresAt: now + 50,
    },
    1
  );
  let protocolCalls = 0;
  ProtocolClient.callTool = async () => {
    protocolCalls += 1;
    await new Promise(resolve => setTimeout(resolve, 1_200));
    return { status: 'completed', data: { approved: true } };
  };

  try {
    const executor = new TaskExecutor({
      deferredStorage: storage,
      deferredTaskTtlSeconds: 1,
      resolveDeferredAgent: async () => ({ ...agent, agent_uri: 'https://seller.example/a2a' }),
      validation: { requests: 'off', responses: 'off' },
    });
    const completed = await executor.resumeDeferredTask(token, { approved: true });
    assert.equal(completed.status, 'completed');
    assert.equal(protocolCalls, 1);
    assert.equal(await storage.has(token), false);
  } finally {
    ProtocolClient.callTool = originalCallTool;
    storage.destroy();
  }
});
