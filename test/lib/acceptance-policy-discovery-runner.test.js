process.env.NODE_ENV = 'test';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

const {
  verifyAcceptancePolicyDiscoveryStep,
} = require('../../dist/lib/testing/storyboard/acceptance-policy-discovery.js');
const { runStoryboard, runStoryboardStep } = require('../../dist/lib/testing/storyboard/runner.js');
const { closeConnections } = require('../../dist/lib/protocols/index.js');
const { ADCP_VERSION } = require('../../dist/lib/version.js');

const STORYBOARD_ID = 'media_buy_seller/acceptance_policy_discovery';
const registryResolver = { resolvePolicy: async () => null };
const registryRef = profile_id => ({
  profile_id,
  policy_id: `policy-${profile_id}`,
  policy_version: '1.0.0',
  policy_digest: `sha256:${'1'.repeat(64)}`,
  profile_version: '1.0.0',
  profile_digest: `sha256:${'2'.repeat(64)}`,
});
const catalog = {
  catalog_version: '1.0.0',
  profiles: [],
  registry_profiles: ['seller-default', 'alpha', 'shared', 'beta', 'missing'].map(registryRef),
};

function capabilityResult() {
  return {
    success: true,
    data: {
      media_buy: {
        acceptance_policy_discovery: {
          catalog_url: 'https://seller.example/acceptance-policy.json',
          catalog_digest: `sha256:${'a'.repeat(64)}`,
          default_profile_ids: ['seller-default'],
        },
      },
    },
  };
}

function productsResult(products) {
  return { success: true, data: { products } };
}

async function startCapabilityAgent(capabilities) {
  const connections = [];
  let productCalls = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url.includes('/.well-known/')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    const mcp = new McpServer({ name: 'acceptance-policy-runner-test', version: '1.0.0' });
    mcp.registerTool('get_adcp_capabilities', {}, async () => ({
      content: [{ type: 'text', text: JSON.stringify(capabilities) }],
      structuredContent: capabilities,
    }));
    mcp.registerTool('get_products', {}, async () => {
      productCalls += 1;
      const response = {
        products: [
          {
            product_id: 'one',
            name: 'Acceptance policy product',
            description: 'A valid product with a registry-backed acceptance profile',
            publisher_properties: [{ publisher_domain: 'example.com', selection_type: 'all' }],
            format_ids: [{ agent_url: 'https://example.com', id: 'display_300x250' }],
            delivery_type: 'guaranteed',
            pricing_options: [{ pricing_option_id: 'cpm', pricing_model: 'cpm', fixed_price: 10, currency: 'USD' }],
            reporting_capabilities: {
              available_reporting_frequencies: ['daily'],
              expected_delay_minutes: 60,
              timezone: 'UTC',
              supports_webhooks: false,
              available_metrics: ['impressions'],
              date_range_support: 'date_range',
            },
            acceptance_policy_profile_ids: ['alpha'],
          },
        ],
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(response) }],
        structuredContent: response,
      };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    connections.push(mcp);
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    get productCalls() {
      return productCalls;
    },
    close: async () => {
      await Promise.all(connections.map(connection => connection.close()));
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

async function reserveLoopbackPort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

describe('acceptance-policy discovery compliance verifier', () => {
  test('ignores every other storyboard', async () => {
    const results = await verifyAcceptancePolicyDiscoveryStep({
      storyboardId: 'media_buy_seller/other',
      stepId: 'get_acceptance_policy_capability',
      taskResult: capabilityResult(),
      state: {},
    });
    assert.deepEqual(results, []);
  });

  test('reports an operator-disabled remote check without calling a resolver or retaining the catalog', async () => {
    const state = { catalog };
    const results = await verifyAcceptancePolicyDiscoveryStep({
      storyboardId: STORYBOARD_ID,
      stepId: 'get_acceptance_policy_capability',
      taskResult: capabilityResult(),
      state,
      dependencies: {
        enabled: false,
        resolveCatalog: async () => {
          throw new Error('must not run');
        },
      },
    });

    assert.equal(state.catalog, undefined);
    assert.equal(results[0].passed, true);
    assert.equal(results[0].severity, 'advisory');
    assert.equal(results[0].not_applicable, true);
    assert.equal(state.registryResolver, undefined);
  });

  test('retains a catalog only after every seller default verifies', async () => {
    const state = {};
    let observedCapability;
    const results = await verifyAcceptancePolicyDiscoveryStep({
      storyboardId: STORYBOARD_ID,
      stepId: 'get_acceptance_policy_capability',
      taskResult: capabilityResult(),
      state,
      adcpVersion: '3.2.0-rc.6',
      dependencies: {
        registryResolver,
        resolveCatalog: async (capability, options) => {
          observedCapability = capability;
          assert.equal(options.registryResolver, undefined);
          assert.equal(options.adcpVersion, '3.2.0-rc.6');
          return {
            ok: true,
            fromCache: false,
            catalog,
            defaultProfiles: [
              {
                source: 'seller',
                resolution: 'resolved',
                profileId: 'seller-default',
                profile: {},
              },
            ],
          };
        },
        resolveProfiles: async (_catalog, profileIds) => ({
          ok: true,
          profiles: profileIds.map(profileId => ({
            source: 'registry',
            resolution: 'resolved',
            profileId,
            profile: {},
            ref: registryRef(profileId),
          })),
        }),
      },
    });

    assert.equal(observedCapability.catalog_url, 'https://seller.example/acceptance-policy.json');
    assert.equal(state.catalog, catalog);
    assert.equal(results.length, 1);
    assert.equal(results[0].passed, true);
    assert.equal(results[0].check, 'acceptance_policy_discovery');
  });

  test('preserves distinct catalog diagnostics without echoing remote content', async () => {
    const state = { catalog };
    const results = await verifyAcceptancePolicyDiscoveryStep({
      storyboardId: STORYBOARD_ID,
      stepId: 'get_acceptance_policy_capability',
      taskResult: capabilityResult(),
      state,
      dependencies: {
        registryResolver,
        resolveCatalog: async () => ({
          ok: false,
          fromCache: false,
          error: {
            code: 'digest_mismatch',
            message: 'Acceptance-policy catalog digest did not match the exact response bytes',
            pointer: '/media_buy/acceptance_policy_discovery/catalog_digest',
          },
        }),
      },
    });

    assert.equal(state.catalog, undefined);
    assert.equal(results[0].passed, false);
    assert.deepEqual(results[0].actual, { code: 'digest_mismatch' });
    assert.equal(JSON.stringify(results).includes('seller.example'), false);
  });

  test('fails closed when a default remains unresolved after catalog verification', async () => {
    const state = {};
    const results = await verifyAcceptancePolicyDiscoveryStep({
      storyboardId: STORYBOARD_ID,
      stepId: 'get_acceptance_policy_capability',
      taskResult: capabilityResult(),
      state,
      dependencies: {
        registryResolver,
        resolveCatalog: async () => ({
          ok: true,
          fromCache: false,
          catalog,
          defaultProfiles: [
            {
              source: 'registry',
              resolution: 'unresolved',
              profileId: 'seller-default',
              ref: {},
            },
          ],
          issues: [
            {
              code: 'registry_policy_digest_mismatch',
              message: 'Registry policy digest did not match its immutable pin',
              pointer: '/registry_profiles/0/policy_digest',
            },
          ],
        }),
      },
    });

    assert.equal(state.catalog, undefined);
    assert.deepEqual(results[0].actual, { code: 'registry_policy_digest_mismatch' });
  });

  test('resolves every unique profile advertised by every returned product', async () => {
    const state = { catalog };
    let selectedIds;
    const results = await verifyAcceptancePolicyDiscoveryStep({
      storyboardId: STORYBOARD_ID,
      stepId: 'get_contextual_products',
      taskResult: productsResult([
        { product_id: 'one', acceptance_policy_profile_ids: ['alpha', 'shared'] },
        { product_id: 'two', acceptance_policy_profile_ids: ['beta', 'shared'] },
        { product_id: 'three' },
      ]),
      state,
      dependencies: {
        registryResolver,
        resolveProfiles: async (_catalog, profileIds, options) => {
          selectedIds = profileIds;
          assert.equal(options.registryResolver, registryResolver);
          return {
            ok: true,
            profiles: profileIds.map(profileId => ({
              source: 'seller',
              resolution: 'resolved',
              profileId,
              profile: {},
            })),
          };
        },
      },
    });

    assert.deepEqual(selectedIds, ['alpha', 'shared', 'beta']);
    assert.equal(results[0].passed, true);
  });

  test('batches every registry-backed product profile without treating resolver limits as seller failures', async () => {
    const profileIds = Array.from({ length: 65 }, (_, index) => `registry-${index}`);
    const batchCatalog = {
      catalog_version: '1.0.0',
      registry_profiles: profileIds.map(registryRef),
    };
    const batches = [];
    const timeouts = [];
    let now = 0;
    const results = await verifyAcceptancePolicyDiscoveryStep({
      storyboardId: STORYBOARD_ID,
      stepId: 'get_contextual_products',
      taskResult: productsResult([{ product_id: 'one', acceptance_policy_profile_ids: profileIds }]),
      state: { catalog: batchCatalog },
      dependencies: {
        registryResolver,
        now: () => now,
        resolveProfiles: async (_catalog, selected, options) => {
          batches.push([...selected]);
          timeouts.push(options.timeoutMs);
          now += 1_000;
          return {
            ok: true,
            profiles: selected.map(profileId => ({
              source: 'registry',
              resolution: 'resolved',
              profileId,
              profile: {},
              ref: registryRef(profileId),
            })),
          };
        },
      },
    });

    assert.deepEqual(
      batches.map(batch => batch.length),
      [32, 32, 1]
    );
    assert.deepEqual(batches.flat(), profileIds);
    assert.deepEqual(timeouts, [5_000, 4_000, 3_000]);
    assert.equal(results[0].passed, true);
  });

  test('batches every registry-backed seller default under one aggregate deadline', async () => {
    const profileIds = Array.from({ length: 65 }, (_, index) => `default-${index}`);
    const batchCatalog = {
      catalog_version: '1.0.0',
      registry_profiles: profileIds.map(registryRef),
    };
    const batches = [];
    const timeouts = [];
    let now = 0;
    const taskResult = capabilityResult();
    taskResult.data.media_buy.acceptance_policy_discovery.default_profile_ids = profileIds;
    const results = await verifyAcceptancePolicyDiscoveryStep({
      storyboardId: STORYBOARD_ID,
      stepId: 'get_acceptance_policy_capability',
      taskResult,
      state: {},
      dependencies: {
        registryResolver,
        now: () => now,
        resolveCatalog: async () => ({
          ok: true,
          fromCache: false,
          catalog: batchCatalog,
          defaultProfiles: [],
        }),
        resolveProfiles: async (_catalog, selected, options) => {
          batches.push([...selected]);
          timeouts.push(options.timeoutMs);
          now += 1_000;
          return {
            ok: true,
            profiles: selected.map(profileId => ({
              source: 'registry',
              resolution: 'resolved',
              profileId,
              profile: {},
              ref: registryRef(profileId),
            })),
          };
        },
      },
    });

    assert.deepEqual(
      batches.map(batch => batch.length),
      [32, 32, 1]
    );
    assert.deepEqual(batches.flat(), profileIds);
    assert.deepEqual(timeouts, [5_000, 4_000, 3_000]);
    assert.equal(results[0].passed, true);
  });

  test('starts no later default or product batch after the aggregate deadline expires', async () => {
    const profileIds = Array.from({ length: 65 }, (_, index) => `deadline-${index}`);
    const batchCatalog = {
      catalog_version: '1.0.0',
      registry_profiles: profileIds.map(registryRef),
    };
    let now = 0;
    let calls = 0;
    const resolveProfiles = async (_catalog, selected) => {
      calls += 1;
      now = 5_000;
      return {
        ok: true,
        profiles: selected.map(profileId => ({
          source: 'registry',
          resolution: 'resolved',
          profileId,
          profile: {},
          ref: registryRef(profileId),
        })),
      };
    };
    const taskResult = capabilityResult();
    taskResult.data.media_buy.acceptance_policy_discovery.default_profile_ids = profileIds;
    const defaults = await verifyAcceptancePolicyDiscoveryStep({
      storyboardId: STORYBOARD_ID,
      stepId: 'get_acceptance_policy_capability',
      taskResult,
      state: {},
      dependencies: {
        registryResolver,
        now: () => now,
        resolveCatalog: async () => ({
          ok: true,
          fromCache: false,
          catalog: batchCatalog,
          defaultProfiles: [],
        }),
        resolveProfiles,
      },
    });
    assert.equal(calls, 1);
    assert.deepEqual(defaults[0].actual, { code: 'registry_timeout', retryable: true });

    now = 0;
    calls = 0;
    const products = await verifyAcceptancePolicyDiscoveryStep({
      storyboardId: STORYBOARD_ID,
      stepId: 'get_contextual_products',
      taskResult: productsResult([{ product_id: 'one', acceptance_policy_profile_ids: profileIds }]),
      state: { catalog: batchCatalog },
      dependencies: {
        registryResolver,
        now: () => now,
        resolveProfiles,
      },
    });
    assert.equal(calls, 1);
    assert.deepEqual(products[0].actual, { code: 'registry_timeout', retryable: true });
  });

  test('reports unresolved product pins as a required failure', async () => {
    const results = await verifyAcceptancePolicyDiscoveryStep({
      storyboardId: STORYBOARD_ID,
      stepId: 'get_contextual_products',
      taskResult: productsResult([{ product_id: 'one', acceptance_policy_profile_ids: ['missing'] }]),
      state: { catalog },
      dependencies: {
        registryResolver,
        resolveProfiles: async () => ({
          ok: true,
          profiles: [{ source: 'catalog', resolution: 'missing', profileId: 'missing' }],
        }),
      },
    });

    assert.equal(results[0].passed, false);
    assert.equal(results[0].severity, 'required');
    assert.deepEqual(results[0].actual, { code: 'unresolved_profile_id' });
  });

  test('carries a verified catalog to the product step but never into a new run state', async () => {
    const state = {};
    const dependencies = {
      registryResolver,
      resolveCatalog: async () => ({
        ok: true,
        fromCache: false,
        catalog,
        defaultProfiles: [],
      }),
      resolveProfiles: async (_catalog, profileIds) =>
        profileIds.includes('seller-default')
          ? {
              ok: true,
              profiles: profileIds.map(profileId => ({
                source: 'registry',
                resolution: 'resolved',
                profileId,
                profile: {},
                ref: registryRef(profileId),
              })),
            }
          : {
              ok: true,
              profiles: [{ source: 'catalog', resolution: 'missing', profileId: 'missing' }],
              issues: [
                {
                  code: 'registry_reference_unresolved',
                  message: 'Registry profile reference did not resolve',
                  pointer: '/registry_profiles/4',
                },
              ],
            },
    };

    const capability = await verifyAcceptancePolicyDiscoveryStep({
      storyboardId: STORYBOARD_ID,
      stepId: 'get_acceptance_policy_capability',
      taskResult: capabilityResult(),
      state,
      dependencies,
    });
    const product = await verifyAcceptancePolicyDiscoveryStep({
      storyboardId: STORYBOARD_ID,
      stepId: 'get_contextual_products',
      taskResult: productsResult([
        { product_id: 'one', acceptance_policy_profile_ids: ['alpha'] },
        { product_id: 'two', acceptance_policy_profile_ids: ['missing'] },
      ]),
      state,
      dependencies,
    });
    const isolated = await verifyAcceptancePolicyDiscoveryStep({
      storyboardId: STORYBOARD_ID,
      stepId: 'get_contextual_products',
      taskResult: productsResult([{ product_id: 'one', acceptance_policy_profile_ids: ['alpha'] }]),
      state: {},
      dependencies,
    });

    assert.equal(capability[0].passed, true);
    assert.deepEqual(product[0].actual, { code: 'registry_reference_unresolved' });
    assert.deepEqual(isolated[0].actual, { code: 'unresolved_profile_id' });
  });

  test('the storyboard runner gates the capability step on safe catalog resolution', async () => {
    const agent = await startCapabilityAgent({
      adcp: { major_versions: [3], supported_versions: ['3.2'] },
      supported_protocols: ['media_buy'],
      media_buy: {
        acceptance_policy_discovery: {
          catalog_url: 'http://127.0.0.1/catalog.json',
          catalog_digest: `sha256:${'b'.repeat(64)}`,
          default_profile_ids: [],
        },
      },
    });
    const storyboard = {
      id: STORYBOARD_ID,
      title: 'Acceptance policy runner integration',
      required_tools: ['get_adcp_capabilities'],
      phases: [
        {
          id: 'discover_catalog',
          title: 'Discover catalog',
          steps: [
            {
              id: 'get_acceptance_policy_capability',
              title: 'Get capability',
              task: 'get_adcp_capabilities',
              stateful: false,
              sample_request: {},
            },
          ],
        },
        {
          id: 'discover_products',
          title: 'Discover products',
          steps: [
            {
              id: 'get_contextual_products',
              title: 'Get contextual products',
              task: 'get_products',
              stateful: false,
              sample_request: {},
            },
          ],
        },
      ],
    };

    try {
      const result = await runStoryboard(agent.url, storyboard, {
        protocol: 'mcp',
        adcpVersion: ADCP_VERSION,
        strictResponseSchemaValidation: false,
      });
      const step = result.phases[0].steps[0];
      const verification = step.validations.find(value => value.check === 'acceptance_policy_discovery');
      assert.equal(step.passed, false);
      assert.equal(verification.passed, false);
      assert.deepEqual(verification.actual, { code: 'unsafe_url' });
      assert.equal(verification.json_pointer, '/media_buy/acceptance_policy_discovery/catalog_url');

      const disabledResult = await runStoryboard(agent.url, storyboard, {
        protocol: 'mcp',
        adcpVersion: ADCP_VERSION,
        strictResponseSchemaValidation: false,
        acceptancePolicyDiscovery: { enabled: false },
      });
      const disabledStep = disabledResult.phases[0].steps[0];
      const disabledVerification = disabledStep.validations.find(
        value => value.check === 'acceptance_policy_discovery'
      );
      assert.equal(disabledStep.passed, true);
      assert.equal(disabledVerification.passed, true);
      assert.equal(disabledVerification.severity, 'advisory');
      assert.equal(disabledVerification.not_applicable, true);

      const callsBeforeStandalone = agent.productCalls;
      const standalone = await runStoryboardStep(agent.url, storyboard, 'get_contextual_products', {
        protocol: 'mcp',
        adcpVersion: ADCP_VERSION,
        strictResponseSchemaValidation: false,
      });
      const standaloneVerification = standalone.validations.find(
        value => value.check === 'acceptance_policy_discovery'
      );
      assert.equal(standalone.step_id, 'get_contextual_products');
      assert.equal(standalone.passed, false);
      assert.deepEqual(standaloneVerification.actual, { code: 'unsafe_url' });
      assert.equal(agent.productCalls, callsBeforeStandalone);

      const skippedStandalone = await runStoryboardStep(agent.url, storyboard, 'get_contextual_products', {
        protocol: 'mcp',
        adcpVersion: ADCP_VERSION,
        strictResponseSchemaValidation: false,
        agentTools: ['get_products'],
      });
      assert.equal(skippedStandalone.passed, true);
      assert.equal(skippedStandalone.skipped, true);
      assert.equal(skippedStandalone.skip_reason, 'missing_tool');
      assert.equal(agent.productCalls, callsBeforeStandalone);

      const resolvedProfileIds = [];
      const standaloneSuccess = await runStoryboardStep(agent.url, storyboard, 'get_contextual_products', {
        protocol: 'mcp',
        adcpVersion: ADCP_VERSION,
        strictResponseSchemaValidation: false,
        _acceptancePolicyDiscoveryDependencies: {
          resolveCatalog: async () => ({
            ok: true,
            fromCache: false,
            catalog,
            defaultProfiles: [],
          }),
          resolveProfiles: async (_catalog, profileIds) => {
            resolvedProfileIds.push(...profileIds);
            return {
              ok: true,
              profiles: profileIds.map(profileId => ({
                source: 'registry',
                resolution: 'resolved',
                profileId,
                profile: {},
                ref: registryRef(profileId),
              })),
            };
          },
        },
      });
      assert.equal(standaloneSuccess.passed, true);
      assert.equal(agent.productCalls, callsBeforeStandalone + 1);
      assert.deepEqual(resolvedProfileIds, ['alpha'], JSON.stringify(standaloneSuccess));

      const webhookPort = await reserveLoopbackPort();
      const controller = new AbortController();
      const cancellation = new Error('cancel standalone catalog verification');
      await assert.rejects(
        runStoryboardStep(agent.url, storyboard, 'get_contextual_products', {
          protocol: 'mcp',
          adcpVersion: ADCP_VERSION,
          strictResponseSchemaValidation: false,
          allow_http: true,
          webhook_receiver: { host: '127.0.0.1', port: webhookPort },
          signal: controller.signal,
          _acceptancePolicyDiscoveryDependencies: {
            resolveCatalog: async () => {
              controller.abort(cancellation);
              controller.signal.throwIfAborted();
            },
          },
        }),
        error => error === cancellation
      );
      const rebound = http.createServer();
      await new Promise(resolve => rebound.listen(webhookPort, '127.0.0.1', resolve));
      await new Promise(resolve => rebound.close(resolve));
    } finally {
      await closeConnections();
      await agent.close();
    }
  });
});
