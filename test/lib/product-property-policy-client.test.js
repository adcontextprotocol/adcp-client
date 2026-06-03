const { describe, test, mock, afterEach } = require('node:test');
const assert = require('node:assert');

const { AdCPClient } = require('../../dist/lib/index.js');
const { ProtocolClient } = require('../../dist/lib/protocols');

const originalCallTool = ProtocolClient.callTool;

afterEach(() => {
  ProtocolClient.callTool = originalCallTool;
});

function makeProduct(product_id, publisher_domain, overrides = {}) {
  return {
    product_id,
    name: product_id,
    publisher_properties: [{ selection_type: 'all', publisher_domain }],
    ...overrides,
  };
}

function makeClient(config = {}) {
  const agent = {
    id: 'seller',
    name: 'Seller',
    agent_uri: 'https://seller.example/mcp',
    protocol: 'mcp',
  };
  const client = new AdCPClient([agent], {
    validateFeatures: false,
    validation: {
      responses: 'off',
      ...config.validation,
    },
    ...(config.handlers ? { handlers: config.handlers } : {}),
    ...(config.onActivity ? { onActivity: config.onActivity } : {}),
  });
  const agentClient = client.agent('seller');
  const inner = agentClient.client;
  inner.discoveredEndpoint = agent.agent_uri;
  inner.cachedCapabilities = {
    version: 'v3',
    majorVersions: [3],
    protocols: ['media_buy'],
    features: {
      inlineCreativeManagement: false,
      conversionTracking: false,
      audienceTargeting: false,
      propertyListFiltering: false,
      contentStandards: false,
    },
    extensions: [],
    _synthetic: false,
  };
  return agentClient;
}

function stubGetProducts(products) {
  ProtocolClient.callTool = mock.fn(async (_agent, taskName) => {
    assert.strictEqual(taskName, 'get_products');
    return {
      status: 'completed',
      products,
      cache_scope: 'public',
    };
  });
}

describe('client product property policy enforcement', () => {
  test('filters excluded domains before caller and handler receive get_products', async () => {
    const handlerCalls = [];
    stubGetProducts([makeProduct('safe', 'example.com'), makeProduct('blocked', 'www.ladbible.com')]);

    const agent = makeClient({
      validation: {
        productPropertyPolicy: {
          excludedDomains: ['ladbible.com'],
        },
      },
      handlers: {
        onGetProductsStatusChange: response => handlerCalls.push(response),
      },
    });

    const result = await agent.getProducts({ brief: 'sports' }, undefined, { project: false });

    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(
      result.data.products.map(p => p.product_id),
      ['safe']
    );
    assert.deepStrictEqual(
      handlerCalls[0].products.map(p => p.product_id),
      ['safe']
    );
    assert.strictEqual(result.metadata.productPropertyPolicy.rejected_count, 1);
    assert.strictEqual(
      result.metadata.productPropertyPolicy.diagnostics[0].matched_excluded_domain,
      'ladbible.com'
    );
    assert.strictEqual(result.data.filter_diagnostics, undefined);
    assert.ok(result.debug_logs.some(entry => entry.type === 'product_property_policy'));
  });

  test('reject_response mode fails get_products and suppresses completion handler', async () => {
    const handlerCalls = [];
    stubGetProducts([makeProduct('safe', 'example.com'), makeProduct('blocked', 'www.ladbible.com')]);

    const agent = makeClient({
      validation: {
        productPropertyPolicy: {
          excludedDomains: ['ladbible.com'],
          mode: 'reject_response',
        },
      },
      handlers: {
        onGetProductsStatusChange: response => handlerCalls.push(response),
      },
    });

    const result = await agent.getProducts({ brief: 'sports' }, undefined, { project: false });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.error, 'Property list not adhered to');
    assert.deepStrictEqual(result.data.products.map(p => p.product_id), ['safe', 'blocked']);
    assert.strictEqual(result.metadata.productPropertyPolicy.rejected_count, 1);
    assert.deepStrictEqual(handlerCalls, []);
  });

  test('filters generic executeTask get_products results before caller receives them', async () => {
    stubGetProducts([makeProduct('safe', 'example.com'), makeProduct('blocked', 'www.ladbible.com')]);

    const agent = makeClient({
      validation: {
        productPropertyPolicy: {
          excludedDomains: ['ladbible.com'],
        },
      },
    });

    const result = await agent.executeTask('get_products', { brief: 'sports' }, undefined, { project: false });

    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(
      result.data.products.map(p => p.product_id),
      ['safe']
    );
    assert.strictEqual(result.metadata.productPropertyPolicy.rejected_count, 1);
  });

  test('uses get_products property_list ref to reject products outside the resolved list', async () => {
    const handlerCalls = [];
    const listCalls = [];
    stubGetProducts([makeProduct('safe', 'www.example.com'), makeProduct('blocked', 'www.ladbible.com')]);

    const agent = makeClient({
      validation: {
        productPropertyPolicy: {
          mode: 'reject_response',
          propertyListResolveOptions: {
            callTool: async (agentUrl, toolName, args, authToken) => {
              listCalls.push({ agentUrl, toolName, args, authToken });
              return {
                list: { list_id: 'cope_allowed_properties', name: 'Cope allowed properties' },
                identifiers: [{ type: 'domain', value: 'example.com' }],
                cache_valid_until: '2026-06-02T12:05:00.000Z',
              };
            },
          },
        },
      },
      handlers: {
        onGetProductsStatusChange: response => handlerCalls.push(response),
      },
    });

    const result = await agent.getProducts(
      {
        brief: 'sports',
        property_list: {
          agent_url: 'https://lists.example/mcp',
          list_id: 'cope_allowed_properties',
          auth_token: 'list-token',
        },
      },
      undefined,
      { project: false }
    );

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.error, 'Property list not adhered to');
    assert.deepStrictEqual(result.data.products.map(p => p.product_id), ['safe', 'blocked']);
    assert.strictEqual(result.metadata.productPropertyPolicy.request_property_list.list_id, 'cope_allowed_properties');
    assert.strictEqual(result.metadata.productPropertyPolicy.request_property_list.identifier_count, 1);
    assert.strictEqual(result.metadata.productPropertyPolicy.diagnostics[0].code, 'outside_property_list');
    assert.strictEqual(result.metadata.productPropertyPolicy.diagnostics[0].normalized_domain, 'www.ladbible.com');
    assert.deepStrictEqual(handlerCalls, []);
    assert.deepStrictEqual(listCalls, [
      {
        agentUrl: 'https://lists.example/mcp',
        toolName: 'get_property_list',
        args: {
          list_id: 'cope_allowed_properties',
          resolve: true,
          pagination: { max_results: 1000 },
        },
        authToken: 'list-token',
      },
    ]);
  });

  test('fails closed when request property_list uses unsupported non-domain identifiers', async () => {
    stubGetProducts([makeProduct('app_product', 'www.example.com')]);

    const agent = makeClient({
      validation: {
        productPropertyPolicy: {
          mode: 'reject_response',
          propertyListResolveOptions: {
            callTool: async () => ({
              list: { list_id: 'app_allowlist', name: 'App allowlist' },
              identifiers: [{ type: 'ios_bundle', value: 'com.example.app' }],
              cache_valid_until: '2026-06-02T12:05:00.000Z',
            }),
          },
        },
      },
    });

    const result = await agent.getProducts(
      {
        brief: 'apps',
        property_list: {
          agent_url: 'https://lists.example/mcp',
          list_id: 'app_allowlist',
        },
      },
      undefined,
      { project: false }
    );

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.status, 'failed');
    assert.deepStrictEqual(result.data.products.map(p => p.product_id), ['app_product']);
    assert.strictEqual(
      result.metadata.productPropertyPolicy.request_property_list.resolution_error,
      'property_list_unsupported_identifier_types'
    );
  });

  test('filters completed get_products webhooks using the original request property_list', async () => {
    const handlerCalls = [];
    const listCalls = [];

    ProtocolClient.callTool = mock.fn(async (_agent, taskName) => {
      assert.strictEqual(taskName, 'get_products');
      return {
        status: 'submitted',
        task_id: 'seller-task-1',
      };
    });

    const agent = makeClient({
      validation: {
        productPropertyPolicy: {
          propertyListResolveOptions: {
            callTool: async (agentUrl, toolName, args, authToken) => {
              listCalls.push({ agentUrl, toolName, args, authToken });
              return {
                list: { list_id: 'cope_allowed_properties', name: 'Cope allowed properties' },
                identifiers: [{ type: 'domain', value: 'example.com' }],
                cache_valid_until: '2026-06-02T12:05:00.000Z',
              };
            },
          },
        },
      },
      handlers: {
        onGetProductsStatusChange: (response, metadata) => handlerCalls.push({ response, metadata }),
      },
    });

    const submitted = await agent.getProducts(
      {
        brief: 'sports',
        property_list: {
          agent_url: 'https://lists.example/mcp',
          list_id: 'cope_allowed_properties',
          auth_token: 'list-token',
        },
      },
      undefined,
      { project: false }
    );

    assert.strictEqual(submitted.status, 'submitted');
    const handled = await agent.handleWebhook(
      {
        idempotency_key: 'webhook-event-1',
        operation_id: submitted.metadata.taskId,
        task_id: 'seller-task-1',
        task_type: 'get_products',
        status: 'completed',
        timestamp: '2026-06-02T12:00:00.000Z',
        result: {
          products: [makeProduct('safe', 'www.example.com'), makeProduct('blocked', 'www.ladbible.com')],
          cache_scope: 'public',
        },
      },
      'get_products',
      submitted.metadata.taskId
    );

    assert.strictEqual(handled, true);
    assert.strictEqual(handlerCalls.length, 1);
    assert.deepStrictEqual(
      handlerCalls[0].response.products.map(p => p.product_id),
      ['safe']
    );
    assert.strictEqual(handlerCalls[0].metadata.productPropertyPolicy.rejected_count, 1);
    assert.deepStrictEqual(
      handlerCalls[0].metadata.rawHTTPPayload.result.products.map(p => p.product_id),
      ['safe', 'blocked']
    );
    assert.strictEqual(handlerCalls[0].metadata.productPropertyPolicy.request_property_list.list_id, 'cope_allowed_properties');
    assert.deepStrictEqual(listCalls, [
      {
        agentUrl: 'https://lists.example/mcp',
        toolName: 'get_property_list',
        args: {
          list_id: 'cope_allowed_properties',
          resolve: true,
          pagination: { max_results: 1000 },
        },
        authToken: 'list-token',
      },
    ]);
  });

  test('filters submitted get_products polling continuations before caller receives products', async () => {
    let pollCalls = 0;

    ProtocolClient.callTool = mock.fn(async (_agent, taskName) => {
      if (taskName === 'tasks_get' || taskName === 'tasks/get') {
        pollCalls += 1;
        return {
          task_id: 'seller-task-1',
          task_type: 'get_products',
          protocol: 'media-buy',
          status: 'completed',
          created_at: '2026-06-02T12:00:00.000Z',
          updated_at: '2026-06-02T12:00:01.000Z',
          result: {
            products: [makeProduct('safe', 'www.example.com'), makeProduct('blocked', 'www.ladbible.com')],
            cache_scope: 'public',
          },
        };
      }
      assert.strictEqual(taskName, 'get_products');
      return {
        status: 'submitted',
        task_id: 'seller-task-1',
      };
    });

    const agent = makeClient({
      validation: {
        productPropertyPolicy: {
          excludedDomains: ['ladbible.com'],
        },
      },
    });

    const submitted = await agent.getProducts({ brief: 'sports' }, undefined, { project: false });
    assert.strictEqual(submitted.status, 'submitted');

    const tracked = await submitted.submitted.track();
    assert.strictEqual(tracked.status, 'completed');
    assert.deepStrictEqual(
      tracked.result.products.map(p => p.product_id),
      ['safe']
    );

    const completed = await submitted.submitted.waitForCompletion(1);
    assert.strictEqual(completed.success, true);
    assert.deepStrictEqual(
      completed.data.products.map(p => p.product_id),
      ['safe']
    );
    assert.strictEqual(completed.metadata.productPropertyPolicy.rejected_count, 1);
    assert.strictEqual(pollCalls, 2);
  });

  test('rejects submitted get_products polling completions in reject_response mode', async () => {
    ProtocolClient.callTool = mock.fn(async (_agent, taskName) => {
      if (taskName === 'tasks_get' || taskName === 'tasks/get') {
        return {
          task_id: 'seller-task-1',
          task_type: 'get_products',
          protocol: 'media-buy',
          status: 'completed',
          created_at: '2026-06-02T12:00:00.000Z',
          updated_at: '2026-06-02T12:00:01.000Z',
          result: {
            products: [makeProduct('safe', 'www.example.com'), makeProduct('blocked', 'www.ladbible.com')],
            cache_scope: 'public',
          },
        };
      }
      assert.strictEqual(taskName, 'get_products');
      return {
        status: 'submitted',
        task_id: 'seller-task-1',
      };
    });

    const agent = makeClient({
      validation: {
        productPropertyPolicy: {
          excludedDomains: ['ladbible.com'],
          mode: 'reject_response',
        },
      },
    });

    const submitted = await agent.getProducts({ brief: 'sports' }, undefined, { project: false });
    const tracked = await submitted.submitted.track();
    assert.strictEqual(tracked.status, 'failed');
    assert.deepStrictEqual(
      tracked.result.products.map(p => p.product_id),
      ['safe', 'blocked']
    );

    const completed = await submitted.submitted.waitForCompletion(1);
    assert.strictEqual(completed.success, false);
    assert.strictEqual(completed.status, 'failed');
    assert.strictEqual(completed.error, 'Property list not adhered to');
    assert.deepStrictEqual(
      completed.data.products.map(p => p.product_id),
      ['safe', 'blocked']
    );
  });

  test('filters fast get_products webhooks using executor request params before initial response returns', async () => {
    const handlerCalls = [];
    let capturedOperationId;
    let releaseInitialResponse;
    const callToolStarted = new Promise(resolve => {
      ProtocolClient.callTool = mock.fn(async (_agent, taskName) => {
        assert.strictEqual(taskName, 'get_products');
        resolve();
        return new Promise(resolveInitial => {
          releaseInitialResponse = () => resolveInitial({ status: 'submitted', task_id: 'seller-task-1' });
        });
      });
    });

    const agent = makeClient({
      onActivity: activity => {
        if (activity.type === 'protocol_request' && activity.task_type === 'get_products') {
          capturedOperationId = activity.operation_id;
        }
      },
      validation: {
        productPropertyPolicy: {
          propertyListResolveOptions: {
            callTool: async () => ({
              list: { list_id: 'cope_allowed_properties', name: 'Cope allowed properties' },
              identifiers: [{ type: 'domain', value: 'example.com' }],
              cache_valid_until: '2026-06-02T12:05:00.000Z',
            }),
          },
        },
      },
      handlers: {
        onGetProductsStatusChange: (response, metadata) => handlerCalls.push({ response, metadata }),
      },
    });

    const submittedPromise = agent.getProducts(
      {
        brief: 'sports',
        property_list: {
          agent_url: 'https://lists.example/mcp',
          list_id: 'cope_allowed_properties',
        },
      },
      undefined,
      { project: false }
    );
    await callToolStarted;
    assert.ok(capturedOperationId, 'protocol_request activity should expose the webhook operation id');

    const handled = await agent.handleWebhook(
      {
        idempotency_key: 'webhook-event-fast',
        operation_id: capturedOperationId,
        task_id: 'seller-task-1',
        task_type: 'get_products',
        status: 'completed',
        timestamp: '2026-06-02T12:00:00.000Z',
        result: {
          products: [makeProduct('safe', 'www.example.com'), makeProduct('blocked', 'www.ladbible.com')],
          cache_scope: 'public',
        },
      },
      'get_products',
      capturedOperationId
    );

    assert.strictEqual(handled, true);
    assert.deepStrictEqual(
      handlerCalls[0].response.products.map(p => p.product_id),
      ['safe']
    );
    assert.strictEqual(handlerCalls[0].metadata.productPropertyPolicy.request_property_list.list_id, 'cope_allowed_properties');

    releaseInitialResponse();
    const submitted = await submittedPromise;
    assert.strictEqual(submitted.status, 'submitted');
  });

  test('sanitizes property_list resolution failures in metadata and debug logs', async () => {
    stubGetProducts([makeProduct('safe', 'www.example.com')]);

    const agent = makeClient({
      validation: {
        productPropertyPolicy: {
          mode: 'reject_response',
          propertyListResolveOptions: {
            callTool: async () => {
              throw new Error('remote payload with secret token');
            },
          },
        },
      },
    });

    const result = await agent.getProducts(
      {
        brief: 'sports',
        property_list: {
          agent_url: 'https://user:pass@lists.example/mcp?token=secret',
          list_id: 'cope_allowed_properties',
        },
      },
      undefined,
      { project: false }
    );

    assert.strictEqual(result.success, false);
    assert.strictEqual(
      result.metadata.productPropertyPolicy.request_property_list.resolution_error,
      'list_agent_url_malformed'
    );
    assert.strictEqual(result.metadata.productPropertyPolicy.request_property_list.agent_url, 'https://lists.example/mcp');
    const policyLog = result.debug_logs.find(entry => entry.type === 'product_property_policy');
    assert.strictEqual(policyLog.request_property_list.resolution_error, 'list_agent_url_malformed');
  });
});
