// Integration test: verifies runStoryboardStep / runStoryboard
// captures consecutive A2A envelopes and feeds the prior one to
// `a2a_context_continuity` validations on follow-up steps. Anchors
// the runner-side cross-step plumbing for adcp-client#962.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const { createAdcpServer: _createAdcpServer } = require('../dist/lib/server/create-adcp-server');
const { createA2AAdapter } = require('../dist/lib/server/a2a-adapter');
const { InMemoryStateStore } = require('../dist/lib/server/state-store');
const { runStoryboard } = require('../dist/lib/testing/storyboard/runner');

function createAdcpServer(config) {
  return _createAdcpServer({
    ...config,
    stateStore: config?.stateStore ?? new InMemoryStateStore(),
    validation: { requests: 'off', responses: 'off', ...(config?.validation ?? {}) },
  });
}

async function startConformantA2aFixture(handlers) {
  const adcp = createAdcpServer(handlers);
  const app = express();
  app.use(express.json());
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();
  const cardUrl = `http://127.0.0.1:${port}/a2a`;
  const a2a = createA2AAdapter({
    server: adcp,
    agentCard: {
      name: 'Conformant Seller',
      description: 'A2A SDK auto-echoes contextId',
      url: cardUrl,
      version: '1.0.0',
      provider: { organization: 'Test', url: 'https://test.example' },
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    },
  });
  a2a.mount(app);
  return {
    server,
    url: cardUrl,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

/**
 * Build an Express handler that emits a non-conformant A2A response —
 * the seller stamps a fresh contextId on every send rather than
 * echoing the buyer's. This is the regression the validator catches.
 */
async function startRegressedA2aFixture() {
  const app = express();
  app.use(express.json());
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  let sendCount = 0;

  app.get('/.well-known/agent-card.json', (_req, res) => {
    res.json({
      name: 'Regressed Seller',
      description: 'stamps own contextId, ignores buyer-supplied',
      url: baseUrl,
      version: '1.0.0',
      protocolVersion: '0.3.0',
      defaultInputModes: ['application/json'],
      defaultOutputModes: ['application/json'],
      capabilities: { streaming: false, pushNotifications: false },
      skills: [
        { id: 'get_products', name: 'get_products', description: 'discover', tags: ['adcp'] },
        { id: 'list_creative_formats', name: 'list_creative_formats', description: 'formats', tags: ['adcp'] },
        { id: 'get_adcp_capabilities', name: 'get_adcp_capabilities', description: 'caps', tags: ['adcp'] },
      ],
    });
  });
  app.post('/', (req, res) => {
    const { id, method, params } = req.body ?? {};
    if (method !== 'message/send') {
      res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
      return;
    }
    const skill = params?.message?.parts?.[0]?.data?.skill;
    sendCount += 1;
    const freshContextId = `ctx-stamped-${sendCount}`;
    if (skill === 'get_adcp_capabilities') {
      res.json({
        jsonrpc: '2.0',
        id,
        result: {
          kind: 'task',
          id: `t-caps-${sendCount}`,
          contextId: freshContextId,
          status: { state: 'completed', timestamp: new Date().toISOString() },
          artifacts: [
            {
              artifactId: 'a',
              parts: [{ kind: 'data', data: { adcp_version: '3.0.0', supported_protocols: ['media-buy'], tools: [] } }],
            },
          ],
        },
      });
      return;
    }
    res.json({
      jsonrpc: '2.0',
      id,
      result: {
        kind: 'task',
        id: `t-${sendCount}`,
        contextId: freshContextId,
        status: { state: 'completed', timestamp: new Date().toISOString() },
        artifacts: [
          {
            artifactId: 'a',
            parts: [{ kind: 'data', data: skill === 'get_products' ? { products: [] } : { formats: [] } }],
          },
        ],
      },
    });
  });
  return {
    server,
    url: baseUrl,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

function buildTwoStepStoryboard() {
  return {
    id: 'a2a-context-continuity-smoke',
    version: '1.0.0',
    title: 'A2A context continuity smoke',
    category: 'media_buy_seller',
    summary: 'Two A2A sends; second asserts contextId echo',
    narrative: 'first send mints context; second send must echo it.',
    agent: { interaction_model: 'media_buy_seller', capabilities: [] },
    caller: { role: 'buyer_agent' },
    phases: [
      {
        id: 'establish',
        title: 'establish',
        steps: [
          {
            id: 'first_send',
            title: 'establish session',
            task: 'get_products',
            stateful: false,
            sample_request: { brief: 'first send' },
          },
        ],
      },
      {
        id: 'follow_up',
        title: 'follow_up',
        steps: [
          {
            id: 'second_send',
            title: 'continue session',
            task: 'list_creative_formats',
            stateful: true,
            sample_request: {},
            validations: [
              {
                check: 'a2a_context_continuity',
                description: 'follow-up send echoes the buyer-supplied contextId',
              },
            ],
          },
        ],
      },
    ],
  };
}

const DISABLE_DEFAULT_INVARIANTS = {
  disable: [
    'status.monotonic',
    'idempotency.conflict_no_payload_leak',
    'context.no_secret_echo',
    'governance.denial_blocks_mutation',
  ],
};

describe('a2a_context_continuity (runner integration, #962)', () => {
  it('passes against an SDK-conformant adapter that echoes contextId', async () => {
    const fixture = await startConformantA2aFixture({
      mediaBuy: {
        getProducts: async () => ({ products: [] }),
      },
      creative: {
        listCreativeFormats: async () => ({ formats: [] }),
      },
    });
    try {
      const sb = buildTwoStepStoryboard();
      const result = await runStoryboard(fixture.url, sb, {
        protocol: 'a2a',
        allow_http: true,
        invariants: DISABLE_DEFAULT_INVARIANTS,
      });
      const followUp = result.phases.flatMap(p => p.steps).find(s => s.step_id === 'second_send');
      assert.ok(followUp, 'follow-up step ran');
      const continuityCheck = followUp.validations.find(v => v.check === 'a2a_context_continuity');
      assert.ok(continuityCheck, 'continuity validator ran');
      assert.strictEqual(
        continuityCheck.passed,
        true,
        `conformant adapter must pass continuity: ${JSON.stringify(continuityCheck)}`
      );
      // Did not emit the not-captured / first-step skip observations
      const obs = continuityCheck.observations ?? [];
      assert.ok(
        !obs.some(o => /a2a_envelope_not_captured|first_a2a_step|prior_contextId_absent/.test(o)),
        `conformant pass should not surface skip observations: ${JSON.stringify(obs)}`
      );
    } finally {
      await fixture.close();
    }
  });

  it('fails against a regressed adapter that stamps fresh contextId per send', async () => {
    const fixture = await startRegressedA2aFixture();
    try {
      const sb = buildTwoStepStoryboard();
      const result = await runStoryboard(fixture.url, sb, {
        protocol: 'a2a',
        allow_http: true,
        invariants: DISABLE_DEFAULT_INVARIANTS,
      });
      const followUp = result.phases.flatMap(p => p.steps).find(s => s.step_id === 'second_send');
      assert.ok(followUp, 'follow-up step ran');
      const continuityCheck = followUp.validations.find(v => v.check === 'a2a_context_continuity');
      assert.ok(continuityCheck, 'continuity validator ran');
      assert.strictEqual(continuityCheck.passed, false, 'regressed adapter must fail continuity');
      assert.strictEqual(continuityCheck.json_pointer, '/result/contextId');
      assert.match(continuityCheck.error, /diverged across steps/);
    } finally {
      await fixture.close();
    }
  });
});
