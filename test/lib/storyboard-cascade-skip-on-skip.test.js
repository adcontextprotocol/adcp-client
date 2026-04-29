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
    if (tool === '__test_setup' || tool === '__test_assert' || tool === 'sync_accounts') {
      return ok({ ok: true });
    }
    if (tool === '__test_fail') {
      // Always fails — for the cascade-message-truthfulness test that
      // needs a real fail (not a skip) to trip statefulFailed.
      return ok({ error: 'simulated failure', code: 'INVALID_ARGUMENT' }, true);
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
    // Detail message MUST tell the truth: prior step skipped (not failed),
    // and reference the originating step + reason. The pre-fix message
    // lied with "prior stateful step failed" when the prior step actually
    // skipped — defeating F6's truthful-diagnostics goal.
    assert.match(assertStep.skip.detail ?? '', /prior stateful step "setup" skipped \(missing_tool\)/);
    assert.match(assertStep.skip.detail ?? '', /state never materialized/);
  });

  test('cascade-skip on not_applicable: explicit-mode sync_accounts skip cascades to dependent stateful step', async () => {
    // F9 introduced not_applicable for sync_accounts in explicit mode.
    // F6 ensures a downstream stateful step that needed sync_accounts
    // state cascade-skips rather than running against absent state.
    agent = await startFakeAgent();
    const storyboard = storyboardWith([
      {
        id: 'sync',
        title: 'sync_accounts setup',
        task: 'sync_accounts',
        stateful: true,
        auth: 'none',
        sample_request: { accounts: [] },
      },
      {
        id: 'assert',
        title: 'assert against synced state',
        task: '__test_assert',
        stateful: true,
        auth: 'none',
        sample_request: {},
      },
    ]);
    const ADVERTISED = ['sync_accounts', '__test_assert', 'get_adcp_capabilities'];
    const result = await runStoryboard([agent.url], storyboard, {
      protocol: 'mcp',
      allow_http: true,
      agentTools: ADVERTISED,
      _profile: {
        name: 'fake',
        tools: ADVERTISED.map(name => ({ name })),
        // require_operator_auth: true triggers the F9 not_applicable
        // gate on sync_accounts (runner.ts:1519-1545).
        raw_capabilities: { account: { require_operator_auth: true } },
      },
    });
    const [syncStep, assertStep] = result.phases[0].steps;
    assert.strictEqual(syncStep.skipped, true);
    assert.strictEqual(syncStep.skip_reason, 'not_applicable');
    assert.strictEqual(assertStep.skipped, true, 'F6: cascade fires on not_applicable');
    assert.strictEqual(assertStep.skip_reason, 'prerequisite_failed');
    assert.match(assertStep.skip.detail ?? '', /not_applicable/);
  });

  test('cascade-skip detail references "failed" (not "skipped") when prior stateful step actually failed', async () => {
    // Reverse-direction guard for the new message branching: a real
    // failure must NOT be reported as a skip, otherwise the diagnostic
    // is worse than before F6 landed.
    agent = await startFakeAgent();
    const storyboard = storyboardWith([
      {
        id: 'setup',
        title: 'setup that fails',
        task: '__test_fail',
        stateful: true,
        auth: 'none',
        sample_request: {},
        validations: [{ check: 'response_field', path: '$.never_present', expected: true }],
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
    const ADVERTISED = ['__test_fail', '__test_assert', 'get_adcp_capabilities'];
    const result = await runStoryboard([agent.url], storyboard, {
      protocol: 'mcp',
      allow_http: true,
      agentTools: ADVERTISED,
      _profile: { name: 'fake', tools: ADVERTISED.map(name => ({ name })) },
    });
    const [setupStep, assertStep] = result.phases[0].steps;
    assert.strictEqual(setupStep.passed, false, 'setup actually failed');
    assert.notStrictEqual(setupStep.skipped, true, 'setup ran and failed (did not skip)');
    assert.strictEqual(assertStep.skipped, true, 'cascade still fires');
    assert.strictEqual(assertStep.skip_reason, 'prerequisite_failed');
    assert.match(assertStep.skip.detail ?? '', /prior stateful step failed/);
    assert.doesNotMatch(assertStep.skip.detail ?? '', /skipped \(/, 'detail must NOT call a real failure a skip');
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
