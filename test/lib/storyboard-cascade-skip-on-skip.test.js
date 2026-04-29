/**
 * F6 — cascade-skip stateful steps when a prior stateful step SKIPPED for
 * a missing-state reason. Today the runner cascades only on failed
 * stateful steps; a skipped stateful step (missing_tool /
 * missing_test_controller / not_applicable) leaves downstream stateful
 * steps to run against absent state and surface misleading "X didn't
 * match" errors. This test asserts the extended cascade.
 *
 * Surfaced by training-agent v6 spike — cross-specialism storyboard
 * (signal_marketplace/governance_denied) has a setup step that requires
 * sync_governance and an assertion step that requires activate_signal;
 * a signals-only agent skips the setup as missing_tool, and the runner
 * incorrectly ran the assertion against absent governance state.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner.js');
const { closeMCPConnections } = require('../../dist/lib/protocols/mcp.js');

async function startFakeAgent() {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const ok = (structured, isError = false) =>
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: { isError, structuredContent: structured },
        })
      );
    const tool = rpc.params?.name;
    if (tool === '__test_setup' || tool === '__test_assert') {
      return ok({ ok: true });
    }
    if (tool === 'get_adcp_capabilities') return ok({ version: '1.0' });
    return ok({ error: `unknown tool ${tool}`, code: 'NOT_FOUND' }, true);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}/mcp` };
}

function stopAgent(agent) {
  return new Promise(r => agent.server.close(r));
}

function storyboardWith(steps) {
  return {
    id: 'cascade_skip_sb',
    version: '1.0.0',
    title: 'F6 cascade-skip',
    category: 'testing',
    summary: '',
    narrative: '',
    agent: { interaction_model: '*', capabilities: [] },
    caller: { role: 'buyer_agent' },
    phases: [{ id: 'p', title: 'phase', steps }],
  };
}

describe('runStoryboard: F6 cascade-skip on missing-state stateful skip', () => {
  let agent;

  afterEach(async () => {
    if (agent) await stopAgent(agent);
    agent = undefined;
    await closeMCPConnections().catch(() => {});
  });

  test('stateful step skipped for missing_tool cascades to subsequent stateful steps', async () => {
    agent = await startFakeAgent();
    // The agent advertises only __test_assert. The setup step requires
    // __test_setup, which the agent doesn't advertise → skipped with
    // missing_tool. The assertion step IS advertised but depends on
    // setup state — F6 says cascade-skip it instead of running.
    const storyboard = storyboardWith([
      {
        id: 'setup',
        title: 'setup state',
        task: '__test_setup',
        stateful: true,
        auth: 'none',
        sample_request: {},
      },
      {
        id: 'assert',
        title: 'assert against state',
        task: '__test_assert',
        stateful: true,
        auth: 'none',
        sample_request: {},
      },
    ]);

    const ADVERTISED = ['__test_assert', 'get_adcp_capabilities'];
    const result = await runStoryboard([agent.url], storyboard, {
      protocol: 'mcp',
      allow_http: true,
      agentTools: ADVERTISED,
      _profile: { name: 'fake', tools: ADVERTISED.map(name => ({ name })) },
    });

    const [setupStep, assertStep] = result.phases[0].steps;
    assert.strictEqual(setupStep.skipped, true);
    assert.strictEqual(setupStep.skip_reason, 'missing_tool');

    // The F6 fix — assertion step cascade-skips with prerequisite_failed
    // because the prior stateful step skipped for a missing-state reason.
    assert.strictEqual(assertStep.skipped, true, 'F6: stateful assertion cascade-skips when stateful setup skipped');
    assert.strictEqual(assertStep.skip_reason, 'prerequisite_failed');
    assert.match(assertStep.skip.detail ?? '', /prior stateful step/);
  });

  test('non-stateful step does NOT cascade-skip when stateful setup skipped', async () => {
    agent = await startFakeAgent();
    const storyboard = storyboardWith([
      {
        id: 'setup',
        title: 'setup state',
        task: '__test_setup',
        stateful: true,
        auth: 'none',
        sample_request: {},
      },
      {
        id: 'observe',
        title: 'observe (not stateful)',
        task: '__test_assert',
        // No `stateful: true` — this step doesn't depend on prior state
        // by declaration, so the cascade should leave it alone.
        auth: 'none',
        sample_request: {},
      },
    ]);
    const ADVERTISED = ['__test_assert', 'get_adcp_capabilities'];
    const result = await runStoryboard([agent.url], storyboard, {
      protocol: 'mcp',
      allow_http: true,
      agentTools: ADVERTISED,
      _profile: { name: 'fake', tools: ADVERTISED.map(name => ({ name })) },
    });
    const [setupStep, observeStep] = result.phases[0].steps;
    assert.strictEqual(setupStep.skipped, true);
    assert.strictEqual(setupStep.skip_reason, 'missing_tool');
    // observe runs because it's not stateful
    assert.notStrictEqual(observeStep.skipped, true, 'non-stateful step runs despite stateful skip');
  });

  test('stateful step that runs successfully does NOT trigger cascade-skip', async () => {
    agent = await startFakeAgent();
    const storyboard = storyboardWith([
      {
        id: 'setup',
        title: 'setup state',
        task: '__test_setup',
        stateful: true,
        auth: 'none',
        sample_request: {},
      },
      {
        id: 'assert',
        title: 'assert against state',
        task: '__test_assert',
        stateful: true,
        auth: 'none',
        sample_request: {},
      },
    ]);
    const ADVERTISED = ['__test_setup', '__test_assert', 'get_adcp_capabilities'];
    const result = await runStoryboard([agent.url], storyboard, {
      protocol: 'mcp',
      allow_http: true,
      agentTools: ADVERTISED,
      _profile: { name: 'fake', tools: ADVERTISED.map(name => ({ name })) },
    });
    const [setupStep, assertStep] = result.phases[0].steps;
    assert.notStrictEqual(setupStep.skipped, true, 'setup ran');
    assert.notStrictEqual(assertStep.skipped, true, 'assertion ran (no cascade)');
  });
});
