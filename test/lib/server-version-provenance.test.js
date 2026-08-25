const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { SingleAgentClient } = require('../../dist/lib/core/SingleAgentClient.js');
const { TaskExecutor } = require('../../dist/lib/core/TaskExecutor.js');
const { ProtocolClient } = require('../../dist/lib/protocols/index.js');

const agent = {
  id: 'versioned-seller',
  name: 'Versioned seller',
  agent_uri: 'https://seller.example/mcp',
  protocol: 'mcp',
};

function metadata(status) {
  return {
    taskId: 'client-task',
    taskName: 'list_authorized_properties',
    agent: { id: agent.id, name: agent.name, protocol: agent.protocol },
    responseTimeMs: 1,
    timestamp: '2026-08-25T00:00:00.000Z',
    clarificationRounds: 0,
    status,
  };
}

function capabilities(version, synthetic) {
  return {
    version,
    majorVersions: [version === 'v2' ? 2 : 3],
    protocols: ['media_buy'],
    features: {},
    extensions: [],
    _synthetic: synthetic,
  };
}

function makeClient(caps, executeTask) {
  const client = new SingleAgentClient(agent, {
    validateFeatures: false,
    validation: { requests: 'off', responses: 'off' },
  });
  client.discoveredEndpoint = agent.agent_uri;
  client.cachedCapabilities = caps;
  client.ensureEndpointDiscovered = async () => agent;
  client.validateRequest = () => {};
  client.executor.validateRequest = () => {};
  client.executor.executeTask = executeTask;
  return client;
}

function assertProvenance(result, version, synthetic) {
  assert.equal(result.metadata.serverVersion, version);
  assert.equal(result.metadata.serverVersionSynthetic, synthetic);
}

describe('seller-version result provenance', () => {
  test('keeps concurrent TaskExecutor provenance task-local', async () => {
    const originalCallTool = ProtocolClient.callTool;
    ProtocolClient.callTool = async currentAgent => {
      await new Promise(resolve => setImmediate(resolve));
      return { status: 'completed', result: { agent_id: currentAgent.id } };
    };
    try {
      const executor = new TaskExecutor({ strictSchemaValidation: false });
      const v2Agent = { ...agent, id: 'seller-v2', name: 'Seller v2' };
      const v3Agent = { ...agent, id: 'seller-v3', name: 'Seller v3' };
      const [v2, v3] = await Promise.all([
        executor.executeTask(v2Agent, 'list_authorized_properties', {}, undefined, {}, 'v2', capabilities('v2', false)),
        executor.executeTask(v3Agent, 'list_authorized_properties', {}, undefined, {}, 'v3', capabilities('v3', true)),
      ]);

      assertProvenance(v2, 'v2', false);
      assertProvenance(v3, 'v3', true);
    } finally {
      ProtocolClient.callTool = originalCallTool;
    }
  });

  test('surfaces declared and synthetic seller generations on terminal results', async () => {
    for (const [version, synthetic, rawResult] of [
      [
        'v2',
        false,
        {
          success: true,
          status: 'completed',
          data: { properties: [] },
          metadata: metadata('completed'),
        },
      ],
      [
        'v3',
        true,
        {
          success: false,
          status: 'failed',
          error: 'seller failed',
          metadata: metadata('failed'),
        },
      ],
    ]) {
      const client = makeClient(capabilities(version, synthetic), async () => structuredClone(rawResult));
      const result = await client.executeTask('list_authorized_properties', {});
      assertProvenance(result, version, synthetic);
    }
  });

  test('retains discovered provenance when execution fails unexpectedly', async () => {
    const client = makeClient(capabilities('v3', false), async () => {
      throw new Error('unexpected transport parser failure');
    });
    const failed = await client.executeTask('list_authorized_properties', {});
    assert.equal(failed.status, 'failed');
    assertProvenance(failed, 'v3', false);
  });

  test('includes provenance on v2 unsupported-feature early results', async () => {
    const client = makeClient(capabilities('v2', false), async () => {
      throw new Error('the unsupported-feature result must not dispatch');
    });

    const result = await client.executeTask('get_products', {
      filters: { required_features: ['content_standards'] },
    });

    assert.equal(result.status, 'completed');
    assert.deepStrictEqual(result.data.products, []);
    assertProvenance(result, 'v2', false);
  });

  test('preserves provenance through submitted and deferred continuations', async () => {
    const completed = () => ({
      success: true,
      status: 'completed',
      data: { properties: [] },
      metadata: metadata('completed'),
    });
    const client = makeClient(capabilities('v2', true), async () => ({
      success: true,
      status: 'submitted',
      metadata: metadata('submitted'),
      submitted: {
        taskId: 'seller-task',
        track: async () => ({ taskId: 'seller-task', taskType: 'list_authorized_properties', status: 'working' }),
        waitForCompletion: async () => ({
          success: true,
          status: 'deferred',
          metadata: metadata('deferred'),
          deferred: {
            token: 'resume-token',
            question: 'Continue?',
            resume: async () => completed(),
          },
        }),
      },
    }));

    const submitted = await client.executeTask('list_authorized_properties', {});
    assertProvenance(submitted, 'v2', true);
    const deferred = await submitted.submitted.waitForCompletion(1);
    assertProvenance(deferred, 'v2', true);
    const resumed = await deferred.deferred.resume({ approved: true });
    assertProvenance(resumed, 'v2', true);
  });

  test('restores provenance from durable client finalization context after restart', async () => {
    const client = makeClient(capabilities('v3', false), async () => {
      throw new Error('not used');
    });
    client.executor.resumeDeferredTaskWithContext = async () => ({
      result: {
        success: true,
        status: 'completed',
        data: { properties: [] },
        metadata: metadata('completed'),
      },
      clientContext: {
        kind: 'single-agent',
        taskType: 'list_authorized_properties',
        canonical: false,
        serverVersion: 'v2',
        serverVersionSynthetic: true,
        productPolicyRequest: {},
      },
    });

    const resumed = await client.resumeDeferredTask('durable-token', { approved: true });
    assertProvenance(resumed, 'v2', true);
  });
});
