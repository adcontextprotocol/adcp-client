const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner');

const LIVE_KEY = 'demo-live-account-key';

function modeGateStoryboard() {
  return {
    id: 'comply_controller_mode_gate',
    version: '1.0.0',
    title: 'Controller mode gate',
    category: 'security',
    summary: '',
    narrative: '',
    agent: { interaction_model: '*', capabilities: [] },
    caller: { role: 'buyer_agent' },
    phases: [
      {
        id: 'live_mode_denial',
        title: 'Live-mode denial',
        steps: [
          {
            id: 'deny_live_caller',
            title: 'Controller rejects a live-mode account',
            task: 'comply_test_controller',
            auth: { type: 'api_key', from_test_kit: true },
            expect_error: true,
            sample_request: {
              scenario: 'force_creative_status',
              params: { creative_id: 'comply-live-mode-probe-000', status: 'approved' },
              // The controller request schema requires sandbox:true. The
              // seller determines live mode from this authenticated principal.
              account: { sandbox: true },
              context: { correlation_id: 'comply_controller_mode_gate--deny_live_caller' },
            },
            validations: [
              { check: 'field_value', path: 'success', allowed_values: [false], description: 'request rejected' },
              { check: 'field_value', path: 'error', allowed_values: ['FORBIDDEN'], description: 'live mode denied' },
              { check: 'field_present', path: 'context', description: 'context echoed' },
            ],
          },
        ],
      },
    ],
  };
}

test('mode-gate payload rejection passes expect_error after a successful MCP call', async () => {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));

    if (rpc.method === 'initialize') {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'mode-gate-test' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            serverInfo: { name: 'mode-gate-capture', version: '1.0.0' },
          },
        })
      );
      return;
    }
    if (rpc.method === 'notifications/initialized') {
      res.writeHead(202);
      res.end();
      return;
    }

    calls.push({
      authorization: req.headers.authorization,
      name: rpc.params?.name,
      args: rpc.params?.arguments,
    });
    const payload = { success: false, error: 'FORBIDDEN', context: rpc.params?.arguments?.context };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: rpc.id,
        result: {
          structuredContent: payload,
          content: [{ type: 'text', text: JSON.stringify(payload) }],
        },
      })
    );
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const result = await runStoryboard(`http://127.0.0.1:${address.port}/mcp`, modeGateStoryboard(), {
      protocol: 'mcp',
      allow_http: true,
      agentTools: ['comply_test_controller'],
      _profile: { name: 'mode-gate-capture', tools: [{ name: 'comply_test_controller' }] },
      _client: {
        getAgentInfo: async () => ({ name: 'mode-gate-capture', tools: [{ name: 'comply_test_controller' }] }),
      },
      test_kit: {
        sandbox: false,
        auth: { api_key: LIVE_KEY, probe_task: 'list_creatives' },
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].authorization, `Bearer ${LIVE_KEY}`);
    assert.equal(calls[0].name, 'comply_test_controller');
    assert.equal(calls[0].args.account.sandbox, true);
    assert.equal(calls[0].args.scenario, 'force_creative_status');

    const step = result.phases[0].steps[0];
    assert.equal(step.passed, true, JSON.stringify(step));
    assert.equal(
      step.validations.every(validation => validation.passed),
      true
    );
    assert.equal(result.overall_passed, true);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
