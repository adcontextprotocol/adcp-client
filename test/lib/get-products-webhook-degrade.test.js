/**
 * get_products / get_signals discovery-webhook degradation for pre-3.1 sellers.
 *
 * Discovery-task push notifications (`push_notification_config`) are an AdCP
 * 3.1 feature. When the client is pinned below 3.1, an AUTO-injected discovery
 * webhook (from `webhookUrlTemplate`) must degrade to polling, suppressed so
 * no `push_notification_config` reaches the wire, rather than throwing. A
 * 3.1+ pin still gets the webhook. An EXPLICIT `push_notification_config`
 * passed by the caller while hard-pinned <3.1 is misuse and still throws.
 */

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { ProtocolClient, SingleAgentClient } = require('../../dist/lib/index.js');
const { ProtocolFeatureUnsupportedError } = require('../../dist/lib/errors/index.js');

const originalCallTool = ProtocolClient.callTool;

const agent = { id: 'agent_1', name: 'Agent 1', protocol: 'mcp', agent_uri: 'https://agent.example/mcp/' };
const TEMPLATE = 'https://buyer.example/webhook/{task_type}/{agent_id}/{operation_id}';

function makeClient(adcpVersion) {
  const client = new SingleAgentClient(agent, {
    adcpVersion,
    webhookUrlTemplate: TEMPLATE,
    validateFeatures: false,
    validation: { requests: 'off', responses: 'off' },
  });
  client.ensureEndpointDiscovered = async () => agent;
  client.detectServerVersion = async () => 'v3';
  // Inject caps so getCapabilities() short-circuits (no live fetch) and the
  // get_products early-feature check treats the seller as v3.
  client.cachedCapabilities = { version: 'v3', majorVersions: [3], supportedVersions: ['3.0'], _synthetic: false };
  return client;
}

describe('get_products discovery-webhook degradation (pre-3.1)', () => {
  afterEach(() => {
    ProtocolClient.callTool = originalCallTool;
  });

  it('suppresses the auto-injected webhook for a 3.0-pinned client (no throw, no push_notification_config)', async () => {
    const calls = [];
    ProtocolClient.callTool = async (_agent, _taskName, _params, options) => {
      calls.push(options);
      return { status: 'completed', products: [] };
    };

    const client = makeClient('3.0');
    const result = await client.getProducts({ brief: 'sneakers' });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].webhookUrl, undefined);
    // A drift entry is surfaced rather than silently dropping the webhook.
    const driftLog = (result.debug_logs ?? []).find(l => l.type === 'pre31_webhook_degraded');
    assert.ok(driftLog, 'expected a pre31_webhook_degraded debug log');
    assert.equal(driftLog.taskName, 'get_products');
  });

  it('still sends the webhook for a 3.1-pinned client', async () => {
    const calls = [];
    ProtocolClient.callTool = async (_agent, _taskName, _params, options) => {
      calls.push(options);
      return { status: 'completed', products: [] };
    };

    const client = makeClient('3.1.0-rc.14');
    await client.getProducts({ brief: 'sneakers' });

    assert.equal(calls.length, 1);
    assert.match(calls[0].webhookUrl, /^https:\/\/buyer\.example\/webhook\/get_products\/agent_1\//);
  });

  it('throws on an EXPLICIT push_notification_config while hard-pinned <3.1', async () => {
    ProtocolClient.callTool = async () => ({ status: 'completed', products: [] });

    const client = makeClient('3.0');
    await assert.rejects(
      () =>
        client.getProducts({
          brief: 'sneakers',
          push_notification_config: {
            url: 'https://buyer.example/explicit',
            authentication: { schemes: ['HMAC-SHA256'], credentials: 'x'.repeat(32) },
          },
        }),
      ProtocolFeatureUnsupportedError
    );
  });
});
