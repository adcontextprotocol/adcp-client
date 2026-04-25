// Pulls the upstream `create_media_buy_async_submitted` storyboard from
// adcontextprotocol/adcp#3083 and runs each phase against a fixture A2A
// adapter. Augments the create_media_buy step with the new
// `a2a_submitted_artifact` check so we can confirm:
//
//   1. The upstream YAML parses cleanly with parseStoryboard.
//   2. The runner's A2A wire-shape capture fires on each step.
//   3. The new check passes against a conformant adapter and fails
//      against a hand-rolled regressed adapter (pre-#899 shape).
//
// This is the end-to-end story that closes the runner-half of issue
// #904: scenario YAML + conformant adapter = green; scenario YAML +
// regressed adapter = red.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { createAdcpServer: _createAdcpServer } = require('../dist/lib/server/create-adcp-server');
const { createA2AAdapter } = require('../dist/lib/server/a2a-adapter');
const { InMemoryStateStore } = require('../dist/lib/server/state-store');
const { parseStoryboard } = require('../dist/lib/testing/storyboard/loader');
const { runStoryboardStep } = require('../dist/lib/testing/storyboard/runner');

// Snapshot of the upstream scenario YAML from adcontextprotocol/adcp#3083.
// Refresh from the head of that PR / its merged successor when the
// upstream YAML changes; the fixture is intentionally a copy (not a
// fetch) so this test runs deterministically in CI without network.
const SCENARIO_YAML_PATH = path.join(__dirname, 'fixtures', 'create_media_buy_async_submitted.yaml');

function createAdcpServer(config) {
  return _createAdcpServer({
    ...config,
    stateStore: config?.stateStore ?? new InMemoryStateStore(),
    validation: { requests: 'off', responses: 'off', ...(config?.validation ?? {}) },
  });
}

function fixtureAvailable() {
  return fs.existsSync(SCENARIO_YAML_PATH);
}

function loadScenario() {
  const yamlText = fs.readFileSync(SCENARIO_YAML_PATH, 'utf-8');
  return parseStoryboard(yamlText);
}

/**
 * Inject the A2A wire-shape assertion into the create_media_buy step.
 * The upstream YAML defers this to issue #904 (this PR); we splice it
 * in at runtime so the run exercises the full assertion set.
 */
function withA2aWireShapeCheck(storyboard) {
  for (const phase of storyboard.phases) {
    for (const step of phase.steps) {
      if (step.id === 'create_media_buy') {
        step.validations = [
          ...(step.validations ?? []),
          {
            check: 'a2a_submitted_artifact',
            description: 'A2A submitted arm matches adcp-client#899 wire shape',
          },
        ];
      }
    }
  }
  return storyboard;
}

const DISABLE_DEFAULT_INVARIANTS = {
  disable: [
    'status.monotonic',
    'idempotency.conflict_no_payload_leak',
    'context.no_secret_echo',
    'governance.denial_blocks_mutation',
  ],
};

/**
 * Stateful seller fixture: tracks the active media-buy lifecycle so the
 * scenario's three phases (get_products → submitted → confirm_active)
 * each see consistent state. The submitted-arm responder caches a
 * task_id and flips a flag that get_media_buys reads to surface an
 * active buy after the (synthetic) controller transition.
 */
function buildSellerHandlers({ adcpTaskId = 'tk_async_seller_1' } = {}) {
  const state = {
    submitted: false,
    completed: false,
    mediaBuyId: 'mb_async_seller_1',
  };
  return {
    state,
    handlers: {
      mediaBuy: {
        getProducts: async () => ({
          products: [
            {
              product_id: 'display_async_q2',
              name: 'Display async fixture',
              description: 'Display 300x250 — async submission flow',
              delivery_type: 'guaranteed',
              channels: ['display'],
              format_ids: [{ agent_url: 'http://127.0.0.1:0', id: 'display_300x250' }],
              pricing_options: [
                {
                  pricing_option_id: 'cpm_standard',
                  pricing_model: 'cpm',
                  currency: 'USD',
                  fixed_price: 10.0,
                },
              ],
            },
          ],
        }),
        createMediaBuy: async () => {
          state.submitted = true;
          // Auto-complete on the SAME call so the next step sees the
          // active buy without needing a controller transition. A real
          // seller would defer this to IO signing; the fixture short-
          // circuits it because the runner-side check fires off the
          // submitted response, not the eventual completion.
          state.completed = true;
          return {
            status: 'submitted',
            task_id: adcpTaskId,
            message: 'Queued for IO signature (test fixture auto-completes immediately)',
          };
        },
        getMediaBuys: async () => {
          if (!state.completed) {
            return { media_buys: [] };
          }
          return {
            media_buys: [
              {
                media_buy_id: state.mediaBuyId,
                status: 'active',
                packages: [
                  {
                    package_id: 'pkg_async_1',
                    product_id: 'display_async_q2',
                  },
                ],
              },
            ],
          };
        },
      },
    },
  };
}

async function startA2aFixture({ handlers, basePath = '/a2a' }) {
  const adcp = createAdcpServer(handlers);
  const app = express();
  app.use(express.json());
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();
  const cardUrl = `http://127.0.0.1:${port}${basePath}`;
  const a2a = createA2AAdapter({
    server: adcp,
    agentCard: {
      name: 'Async test seller',
      description: 'create_media_buy async submitted fixture',
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
    close: () =>
      new Promise(resolve => {
        server.close(resolve);
      }),
  };
}

describe(
  'storyboard adcp#3083: create_media_buy_async_submitted (A2A end-to-end)',
  { skip: !fixtureAvailable() && 'YAML fixture not vendored at test/fixtures/' },
  () => {
    it('parses the upstream YAML cleanly via parseStoryboard', () => {
      const sb = loadScenario();
      assert.strictEqual(sb.id, 'media_buy_seller/create_media_buy_async_submitted');
      assert.strictEqual(sb.phases.length, 3);
      const stepIds = sb.phases.flatMap(p => p.steps.map(s => s.id));
      assert.deepStrictEqual(stepIds, ['get_products_brief', 'create_media_buy', 'get_media_buys_active']);
    });

    it('runs the create_media_buy phase against a conformant A2A adapter (a2a_submitted_artifact passes)', async () => {
      const { handlers } = buildSellerHandlers();
      const fixture = await startA2aFixture({ handlers });
      try {
        const sb = withA2aWireShapeCheck(loadScenario());
        const result = await runStoryboardStep(fixture.url, sb, 'create_media_buy', {
          protocol: 'a2a',
          allow_http: true,
          invariants: DISABLE_DEFAULT_INVARIANTS,
        });
        // Step pass overall (the upstream YAML's MCP-level checks +
        // the new A2A wire-shape check both succeed against the
        // conformant adapter).
        const a2aCheck = result.validations.find(v => v.check === 'a2a_submitted_artifact');
        assert.ok(
          a2aCheck,
          `a2a_submitted_artifact ran (validations=${result.validations.map(v => v.check).join(',')})`
        );
        assert.strictEqual(
          a2aCheck.passed,
          true,
          `a2a check should pass against the post-#899 adapter: ${JSON.stringify(a2aCheck)}`
        );
        // Capture must have fired — non-A2A skip path means the
        // runner's wire-up for protocol:'a2a' regressed.
        assert.ok(
          !(a2aCheck.observations ?? []).some(o => /a2a_envelope_not_captured/.test(o)),
          'wire-shape capture must fire on A2A protocol runs'
        );
        // The MCP-style status check (also asserted by the upstream
        // YAML) must still see the submitted payload — confirms our
        // runner doesn't strip the AdCP layer when capturing the A2A
        // envelope.
        const statusCheck = result.validations.find(v => v.check === 'field_value' && v.path === 'status');
        assert.ok(statusCheck);
        assert.strictEqual(
          statusCheck.passed,
          true,
          `status:'submitted' check should pass: ${JSON.stringify(statusCheck)}`
        );
      } finally {
        await fixture.close();
      }
    });

    it('runs the create_media_buy phase against a regressed adapter (a2a_submitted_artifact fails specifically)', async () => {
      // Hand-rolled Express handler that emits the pre-#899 shape so we
      // confirm the new check catches it on the upstream YAML.
      const app = express();
      app.use(express.json());
      const server = app.listen(0);
      await new Promise(resolve => server.once('listening', resolve));
      const { port } = server.address();
      const baseUrl = `http://127.0.0.1:${port}`;
      app.get('/.well-known/agent-card.json', (_req, res) => {
        res.json({
          name: 'Regressed seller',
          description: 'pre-#899 wire shape',
          url: baseUrl,
          version: '1.0.0',
          protocolVersion: '0.3.0',
          defaultInputModes: ['application/json'],
          defaultOutputModes: ['application/json'],
          capabilities: { streaming: false, pushNotifications: false },
          skills: [
            { id: 'create_media_buy', name: 'create_media_buy', description: 'create', tags: ['adcp'] },
            { id: 'get_products', name: 'get_products', description: 'discover', tags: ['adcp'] },
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
        if (skill === 'get_adcp_capabilities') {
          res.json({
            jsonrpc: '2.0',
            id,
            result: {
              kind: 'task',
              id: 'a2a-task-caps',
              contextId: 'ctx-caps',
              status: { state: 'completed', timestamp: new Date().toISOString() },
              history: [],
              artifacts: [
                {
                  artifactId: 'art-caps',
                  name: 'result',
                  parts: [
                    {
                      kind: 'data',
                      data: {
                        adcp_version: '3.0.0',
                        supported_protocols: ['media-buy'],
                        tools: [{ name: 'create_media_buy' }, { name: 'get_products' }],
                      },
                    },
                  ],
                },
              ],
            },
          });
          return;
        }
        // Pre-#899 shape on create_media_buy — the regression #904 catches.
        res.json({
          jsonrpc: '2.0',
          id,
          result: {
            kind: 'task',
            id: 'a2a-task-async',
            contextId: 'ctx-async',
            // Regression: terminal 'submitted' (forbidden in A2A 0.3.0)
            status: { state: 'submitted', timestamp: new Date().toISOString() },
            history: [],
            artifacts: [
              {
                artifactId: 'art-async',
                name: 'submitted',
                parts: [
                  {
                    kind: 'data',
                    // Regression: adcp_task_id leaked into payload
                    data: {
                      status: 'submitted',
                      task_id: 'tk_async_regressed',
                      adcp_task_id: 'tk_async_regressed',
                    },
                  },
                ],
                // Regression: no metadata at all
              },
            ],
          },
        });
      });

      try {
        const sb = withA2aWireShapeCheck(loadScenario());
        const result = await runStoryboardStep(baseUrl, sb, 'create_media_buy', {
          protocol: 'a2a',
          allow_http: true,
          invariants: DISABLE_DEFAULT_INVARIANTS,
        });
        const a2aCheck = result.validations.find(v => v.check === 'a2a_submitted_artifact');
        assert.ok(a2aCheck, 'a2a_submitted_artifact ran');
        assert.strictEqual(a2aCheck.passed, false, 'pre-#899 shape must fail the wire-shape guard');
        const pointers = (a2aCheck.actual?.failures ?? []).map(f => f.pointer);
        // All three regressions surface in one validation result
        assert.ok(pointers.includes('/result/status/state'), `pointers=${JSON.stringify(pointers)}`);
        assert.ok(pointers.includes('/result/artifacts/0/metadata/adcp_task_id'));
        assert.ok(pointers.includes('/result/artifacts/0/parts/0/data/adcp_task_id'));
      } finally {
        await new Promise(resolve => server.close(resolve));
      }
    });
  }
);
