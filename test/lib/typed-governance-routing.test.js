const { afterEach, describe, mock, test } = require('node:test');
const assert = require('node:assert/strict');
const { AgentClient, SingleAgentClient, ProtocolClient } = require('../../dist/lib/index.js');

const seller = { id: 'seller', name: 'Seller', protocol: 'mcp', agent_uri: 'https://seller.example/mcp' };
const configuredAgent = { ...seller, id: 'governance', agent_uri: 'https://governance.example/mcp' };
const explicitAgent = { ...seller, id: 'override', agent_uri: 'https://override.example/mcp' };
const tools = { syncPlans: 'sync_plans', getPlanAuditLogs: 'get_plan_audit_logs' };
const capabilities = discoveredTools => ({
  version: 'v3',
  majorVersions: [3],
  supportedVersions: ['3.2.7'],
  protocols: ['governance'],
  features: {},
  extensions: [],
  discoveredTools,
  _synthetic: false,
});
const paramsFor = method =>
  method === 'syncPlans' ? { plans: [{ plan_id: 'plan-original' }] } : { plan_ids: ['plan-original'] };

function setup(Client, config = {}) {
  const client = new Client(seller, {
    adcpVersion: '3.2.7',
    validateFeatures: false,
    validation: { requests: 'off', responses: 'off' },
    ...config,
  });
  const single = Client === AgentClient ? client.client : client;
  mock.method(single, 'ensureEndpointDiscovered', async () => seller);
  return { client, single };
}

function invoke(client, route, method, params, options, handler) {
  return route === 'generic'
    ? client.executeTask(tools[method], params, handler, options)
    : client[method](params, handler, options);
}

describe('typed governance routing', () => {
  afterEach(() => mock.restoreAll());

  for (const Client of [AgentClient, SingleAgentClient]) {
    for (const route of ['direct', 'generic']) {
      for (const method of Object.keys(tools)) {
        const label = `${Client.name} ${route} ${method}`;
        const tool = tools[method];

        test(`${label} refuses unadvertised seller calls and permits advertised tools`, async () => {
          const { client, single } = setup(Client);
          let advertised = false;
          mock.method(single, 'getCapabilities', async () => capabilities(advertised ? [tool] : []));
          const calls = mock.method(ProtocolClient, 'callTool', async (_agent, name) => {
            assert.equal(name, tool);
            return { structuredContent: { plans: [] }, content: [] };
          });
          const refused = await invoke(client, route, method, paramsFor(method));
          assert.equal(refused.success, false);
          assert.match(refused.error, /No governance agent configured/);
          assert.equal(calls.mock.callCount(), 0);
          advertised = true;
          const accepted = await invoke(client, route, method, paramsFor(method));
          assert.equal(accepted.success, true, accepted.error);
          assert.equal(calls.mock.callCount(), 1);
        });

        test(`${label} includes discovery in the caller's timeout`, async () => {
          const { client, single } = setup(Client);
          let discoverySignal;
          mock.method(single, 'getCapabilities', async options => {
            discoverySignal = options.signal;
            assert.ok(discoverySignal, 'the absolute task deadline must cover discovery');
            return new Promise((_resolve, reject) => {
              discoverySignal.addEventListener('abort', () => reject(discoverySignal.reason), { once: true });
            });
          });
          const calls = mock.method(ProtocolClient, 'callTool', async () => assert.fail('timed out call was sent'));
          await assert.rejects(
            invoke(client, route, method, paramsFor(method), { timeout: 25 }),
            error => error.name === 'TaskTimeoutError'
          );
          assert.equal(discoverySignal.aborted, true);
          assert.equal(calls.mock.callCount(), 0);
        });

        test(`${label} owns request and transport snapshots before discovery yields`, async () => {
          const { client, single } = setup(Client);
          const originalFetch = async () => assert.fail('transport is stubbed');
          const changedFetch = async () => assert.fail('caller substituted transport');
          let enterDiscovery;
          let releaseDiscovery;
          const entered = new Promise(resolve => {
            enterDiscovery = resolve;
          });
          const released = new Promise(resolve => {
            releaseDiscovery = resolve;
          });
          mock.method(single, 'getCapabilities', async options => {
            assert.equal(options.transport.trustedFetchFn, originalFetch);
            assert.equal(options.transport.allowPrivateIp, false);
            enterDiscovery();
            await released;
            return capabilities([tool]);
          });
          const calls = mock.method(ProtocolClient, 'callTool', async (_agent, _tool, params, options) => {
            assert.equal(options.transport.trustedFetchFn, originalFetch);
            assert.equal(options.transport.allowPrivateIp, false);
            assert.equal(method === 'syncPlans' ? params.plans[0].plan_id : params.plan_ids[0], 'plan-original');
            return { structuredContent: { plans: [] }, content: [] };
          });
          const params = paramsFor(method);
          const options = { transport: { trustedFetchFn: originalFetch, allowPrivateIp: false } };
          const pending = invoke(client, route, method, params, options);
          await entered;
          if (method === 'syncPlans') params.plans[0].plan_id = 'caller-mutated';
          else params.plan_ids[0] = 'caller-mutated';
          options.transport.trustedFetchFn = changedFetch;
          options.transport.allowPrivateIp = true;
          releaseDiscovery();
          const result = await pending;
          assert.equal(result.success, true, result.error);
          assert.equal(calls.mock.callCount(), 1);
        });

        test(`${label} honors configured and explicit governance targets and retains input handlers`, async () => {
          const { client, single } = setup(Client, {
            governance: { campaign: { agent: configuredAgent, planId: 'plan-configured' } },
          });
          const handler = async () => ({ approved: true });
          mock.method(single, 'getCapabilities', async () => assert.fail('configured route must not discover seller'));
          const calls = mock.method(single.executor, 'executeTask', async (_agent, name, _params, inputHandler) => {
            assert.equal(name, tool);
            assert.equal(inputHandler, handler);
            return { success: true, status: 'completed', data: { plans: [] } };
          });
          await invoke(client, route, method, paramsFor(method), undefined, handler);
          assert.deepEqual(calls.mock.calls[0].arguments[0], configuredAgent);
          await invoke(client, route, method, paramsFor(method), { agent: explicitAgent }, handler);
          assert.deepEqual(calls.mock.calls[1].arguments[0], explicitAgent);
        });
      }
    }
  }

  test('SingleAgentClient preserves getPlanAuditLogs(params, options)', async () => {
    const { client, single } = setup(SingleAgentClient);
    mock.method(single, 'getCapabilities', async () => capabilities(['get_plan_audit_logs']));
    mock.method(ProtocolClient, 'callTool', async (_agent, tool, _params, options) => {
      assert.equal(tool, 'get_plan_audit_logs');
      assert.equal(options.transport.maxResponseBytes, 654321);
      return { structuredContent: { plans: [] }, content: [] };
    });
    const result = await client.getPlanAuditLogs(
      { plan_ids: ['plan-original'] },
      {
        transport: { maxResponseBytes: 654321 },
      }
    );
    assert.equal(result.success, true, result.error);
  });
});
