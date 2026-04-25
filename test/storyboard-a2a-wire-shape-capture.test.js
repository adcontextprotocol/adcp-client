// Integration test: verifies runStoryboardStep captures the A2A wire shape
// emitted by createA2AAdapter and feeds it to a2a_submitted_artifact
// validations. Anchors the runner-side half of issue #904.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const { createAdcpServer: _createAdcpServer } = require('../dist/lib/server/create-adcp-server');
const { createA2AAdapter } = require('../dist/lib/server/a2a-adapter');
const { InMemoryStateStore } = require('../dist/lib/server/state-store');
const { runStoryboardStep } = require('../dist/lib/testing/storyboard/runner');

function createAdcpServer(config) {
  // Sparse handler fixtures — opt out of strict validation for tests.
  return _createAdcpServer({
    ...config,
    stateStore: config?.stateStore ?? new InMemoryStateStore(),
    validation: { requests: 'off', responses: 'off', ...(config?.validation ?? {}) },
  });
}

function agentCardFor(url) {
  return {
    name: 'Async Test Seller',
    description: 'Async create_media_buy fixture for issue #904',
    url,
    version: '1.0.0',
    provider: { organization: 'Test', url: 'https://test.example' },
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
  };
}

async function startA2aFixture(handlers) {
  const adcp = createAdcpServer(handlers);
  const app = express();
  app.use(express.json());
  // Bind to port 0 first so the agent card URL can advertise the
  // actual listening port — A2A SDK clients use the card's `url` to
  // build their JSON-RPC endpoint.
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();
  // Card URL must include the basePath the adapter mounts at so the
  // A2A SDK client (which posts to `card.url` for `message/send`)
  // hits the JSON-RPC handler. `mount(app)` derives basePath from
  // the URL pathname; we keep `/a2a` to match the adapter's default.
  const cardUrl = `http://127.0.0.1:${port}/a2a`;
  const a2a = createA2AAdapter({
    server: adcp,
    agentCard: agentCardFor(cardUrl),
  });
  a2a.mount(app);
  return {
    server,
    url: cardUrl,
    close: () =>
      new Promise(resolve => {
        server.close(resolve);
      }),
  };
}

function buildStoryboard(stepValidations) {
  // Minimal storyboard shape — runner only requires id + phases + steps
  // for runStoryboardStep to dispatch a single step. agent / caller /
  // narrative blocks are validated by parseStoryboard, not the runner.
  return {
    id: 'a2a-wire-shape-smoke',
    version: '1.0.0',
    title: 'A2A wire-shape capture smoke',
    category: 'media_buy_seller',
    summary: 'A2A submitted-arm wire-shape regression guard',
    narrative: 'Drives create_media_buy and asserts the A2A submitted envelope shape.',
    agent: { interaction_model: 'media_buy_seller', capabilities: [] },
    caller: { role: 'buyer_agent' },
    phases: [
      {
        id: 'create',
        title: 'create',
        steps: [
          {
            id: 'create_media_buy_async',
            title: 'create_media_buy returns submitted',
            task: 'create_media_buy',
            stateful: true,
            sample_request: {
              brand: { brand_id: 'b1' },
              account: { account_id: 'a1' },
              start_time: '2026-05-01T00:00:00Z',
              end_time: '2026-07-31T23:59:59Z',
              packages: [{ product_id: 'p1', budget: 1000, pricing_option_id: 'cpm_standard' }],
            },
            validations: stepValidations,
          },
        ],
      },
    ],
  };
}

describe('runStoryboardStep: A2A wire-shape capture (issue #904)', () => {
  it('a2a_submitted_artifact passes against the conformant adapter shape', async () => {
    const fixture = await startA2aFixture({
      mediaBuy: {
        createMediaBuy: async () => ({
          status: 'submitted',
          task_id: 'tk_async_1',
          message: 'Queued for IO signature',
        }),
      },
    });
    try {
      const storyboard = buildStoryboard([
        {
          check: 'a2a_submitted_artifact',
          description: 'A2A submitted arm matches adcp-client#899 wire shape',
        },
        {
          check: 'field_value',
          path: 'status',
          value: 'submitted',
          description: 'AdCP payload still carries status: submitted',
        },
      ]);
      const result = await runStoryboardStep(fixture.url, storyboard, 'create_media_buy_async', {
        protocol: 'a2a',
        allow_http: true,
        // Disable cross-step assertions — they require a specialism context
        // the smoke test doesn't set up.
        invariants: {
          disable: [
            'status.monotonic',
            'idempotency.conflict_no_payload_leak',
            'context.no_secret_echo',
            'governance.denial_blocks_mutation',
          ],
        },
      });
      assert.ok(result, 'step result returned');
      const a2aCheck = result.validations.find(v => v.check === 'a2a_submitted_artifact');
      assert.ok(a2aCheck, `a2a_submitted_artifact validation ran (skip=${result.skip_reason} error=${result.error})`);
      assert.strictEqual(a2aCheck.passed, true, `validation should pass: ${JSON.stringify(a2aCheck)}`);
      // The check should not log a "not_captured" observation — capture must have fired.
      assert.ok(
        !(a2aCheck.observations ?? []).some(o => /a2a_envelope_not_captured/.test(o)),
        'capture wire-up must fire on A2A protocol runs'
      );
    } finally {
      await fixture.close();
    }
  });

  it('redacts secret-shaped fields in the captured envelope (security guard)', async () => {
    // The runner runs `redactSecrets` over the captured envelope
    // before populating ValidationContext.a2aEnvelope. Anchor that
    // posture: a seller fixture that returns a payload containing
    // secret-shaped keys must NOT surface those raw values into the
    // validation result's `actual.failures[].actual` field, which
    // lands in persisted compliance reports.
    const fixture = await startA2aFixture({
      mediaBuy: {
        createMediaBuy: async () => ({
          status: 'wrong', // force a wire-shape failure so the validator emits failure records
          task_id: 'tk_async_redact_test',
          api_key: 'sk_live_PLAINTEXT_SECRET_VALUE',
          client_secret: 'cs_PLAINTEXT_SECRET_VALUE',
          access_token: 'at_PLAINTEXT_SECRET_VALUE',
        }),
      },
    });
    try {
      const storyboard = buildStoryboard([
        {
          check: 'a2a_submitted_artifact',
          description: 'wire shape',
        },
      ]);
      const result = await runStoryboardStep(fixture.url, storyboard, 'create_media_buy_async', {
        protocol: 'a2a',
        allow_http: true,
        invariants: {
          disable: [
            'status.monotonic',
            'idempotency.conflict_no_payload_leak',
            'context.no_secret_echo',
            'governance.denial_blocks_mutation',
          ],
        },
      });
      const a2aCheck = result.validations.find(v => v.check === 'a2a_submitted_artifact');
      assert.ok(a2aCheck, 'check ran');
      assert.strictEqual(a2aCheck.passed, false, 'wire-shape failure expected (status === "wrong")');
      const serialized = JSON.stringify(result);
      // None of the raw secret-shaped values may surface anywhere in
      // the persisted validation result.
      assert.doesNotMatch(serialized, /sk_live_PLAINTEXT/, 'api_key value must be redacted before reaching the report');
      assert.doesNotMatch(serialized, /cs_PLAINTEXT/, 'client_secret value must be redacted');
      assert.doesNotMatch(serialized, /at_PLAINTEXT/, 'access_token value must be redacted');
    } finally {
      await fixture.close();
    }
  });

  it('a2a_submitted_artifact fails when the adapter is bypassed and the seller emits the pre-#899 shape', async () => {
    // Simulate a regressed adapter by mounting a custom Express handler
    // that ignores the SDK and emits `Task.state: 'submitted'` with
    // `adcp_task_id` inside `data` — the exact regression class issue
    // #904 calls out.
    const app = express();
    app.use(express.json());
    let port;
    const server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    app.get('/.well-known/agent-card.json', (_req, res) => {
      res.json({
        name: 'Regressed Seller',
        description: 'Pre-#899 wire shape',
        url: baseUrl,
        version: '1.0.0',
        protocolVersion: '0.3.0',
        defaultInputModes: ['application/json'],
        defaultOutputModes: ['application/json'],
        capabilities: { streaming: false, pushNotifications: false },
        skills: [{ id: 'create_media_buy', name: 'create_media_buy', description: 'create', tags: ['adcp'] }],
      });
    });
    app.post('/', (req, res) => {
      const { id, method } = req.body ?? {};
      if (method !== 'message/send') {
        res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
        return;
      }
      res.json({
        jsonrpc: '2.0',
        id,
        result: {
          kind: 'task',
          id: 'a2a-task-uuid',
          contextId: 'ctx-1',
          // Regression: terminal 'submitted' state per pre-#899 wire
          status: { state: 'submitted', timestamp: new Date().toISOString() },
          history: [],
          artifacts: [
            {
              artifactId: 'art-uuid',
              name: 'submitted',
              parts: [
                {
                  kind: 'data',
                  // Regression: adcp_task_id leaked into payload
                  data: { status: 'submitted', task_id: 'tk_async_1', adcp_task_id: 'tk_async_1' },
                },
              ],
              // Regression: no metadata field
            },
          ],
        },
      });
    });

    try {
      const storyboard = buildStoryboard([
        {
          check: 'a2a_submitted_artifact',
          description: 'Catches pre-#899 wire-shape regression',
        },
      ]);
      const result = await runStoryboardStep(baseUrl, storyboard, 'create_media_buy_async', {
        protocol: 'a2a',
        allow_http: true,
        invariants: {
          disable: [
            'status.monotonic',
            'idempotency.conflict_no_payload_leak',
            'context.no_secret_echo',
            'governance.denial_blocks_mutation',
          ],
        },
      });
      const a2aCheck = result.validations.find(v => v.check === 'a2a_submitted_artifact');
      assert.ok(a2aCheck, 'a2a_submitted_artifact validation ran');
      assert.strictEqual(a2aCheck.passed, false, 'regression must be caught');
      const pointers = (a2aCheck.actual?.failures ?? []).map(f => f.pointer);
      assert.ok(pointers.includes('/result/status/state'), 'flags Task.state regression');
      assert.ok(pointers.includes('/result/artifacts/0/metadata/adcp_task_id'), 'flags missing artifact.metadata');
      assert.ok(
        pointers.includes('/result/artifacts/0/parts/0/data/adcp_task_id'),
        'flags adcp_task_id leak into data'
      );
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});
