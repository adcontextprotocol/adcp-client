/**
 * Cascade-skip behavior when a prior stateful step skipped or failed.
 *
 * Two skip reasons trip the cascade immediately because the agent
 * genuinely lacks the capability and no in-phase peer can substitute:
 *
 *   - `missing_tool` — agent did not advertise the required tool
 *   - `missing_test_controller` — agent did not advertise comply_test_controller
 *
 * `not_applicable` is handled differently: it means "this path doesn't
 * apply to this agent" but the storyboard may carry a peer step (e.g.
 * `list_accounts` paired with `sync_accounts`) that establishes
 * equivalent state. The runner defers the cascade decision to phase
 * end — if any stateful peer in the same phase passes, the substitute
 * is treated as the state-establishing event and no cascade fires. If
 * none does, the deferred trigger promotes to a hard cascade so
 * downstream phases skip cleanly with `prerequisite_failed`.
 *
 * Real stateful failures always trip the cascade immediately and win
 * the diagnostic message — a real failure is the worse signal, so
 * downstream cascade text references the failure rather than any
 * earlier benign skip.
 */

const { describe, test, afterEach } = require('node:test');
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

function storyboardWithPhases(phases) {
  return {
    id: 'cascade_skip_multiphase_sb',
    version: '1.0.0',
    title: 'F6 cascade-skip multi-phase',
    category: 'testing',
    summary: '',
    narrative: '',
    agent: { interaction_model: '*', capabilities: [] },
    caller: { role: 'buyer_agent' },
    phases,
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

  test('cascade-skip on not_applicable WHEN no stateful peer establishes state: cascade fires across phases', async () => {
    // F9 introduced not_applicable for sync_accounts in explicit mode.
    // adcp-client#1005 round-9 refined the cascade: not_applicable is
    // semantically "this path doesn't apply" rather than "state never
    // materialized" — the storyboard may carry a peer step (e.g.
    // list_accounts) that establishes equivalent state. The cascade
    // should fire ONLY when no such peer succeeded in the same phase.
    //
    // This test isolates the no-substitute case: sync_accounts skips
    // not_applicable in phase 1 with no peer, downstream stateful step
    // sits in phase 2. The phase-end cascade resolution should promote
    // the deferred trigger and the phase-2 step should cascade-skip
    // with prerequisite_failed.
    agent = await startFakeAgent();
    const storyboard = storyboardWithPhases([
      {
        id: 'account_setup',
        title: 'account setup (sync only)',
        steps: [
          {
            id: 'sync',
            title: 'sync_accounts setup',
            task: 'sync_accounts',
            stateful: true,
            auth: 'none',
            sample_request: { accounts: [] },
          },
        ],
      },
      {
        id: 'consume',
        title: 'consume account state',
        steps: [
          {
            id: 'assert',
            title: 'assert against synced state',
            task: '__test_assert',
            stateful: true,
            auth: 'none',
            sample_request: {},
          },
        ],
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
        // gate on sync_accounts.
        raw_capabilities: { account: { require_operator_auth: true } },
      },
    });
    const syncStep = result.phases[0].steps[0];
    const assertStep = result.phases[1].steps[0];
    assert.strictEqual(syncStep.skipped, true);
    assert.strictEqual(syncStep.skip_reason, 'not_applicable');
    assert.strictEqual(assertStep.skipped, true, 'cascade fires when no stateful peer established state');
    assert.strictEqual(assertStep.skip_reason, 'prerequisite_failed');
    assert.match(assertStep.skip.detail ?? '', /not_applicable/);
    assert.match(assertStep.skip.detail ?? '', /prior stateful step "sync"/);
  });

  test('not_applicable + stateful peer passes in SAME phase → no cascade (substitute established state)', async () => {
    // adcp-client#1005 round-9: explicit-mode sellers skip
    // sync_accounts as not_applicable BUT establish account state
    // through list_accounts (the canonical alternative for that
    // account shape). Pre-fix: the runner cascade-skipped every
    // downstream stateful step including list_accounts itself,
    // collapsing 12 adapter storyboards to 1/N passing. Post-fix: the
    // not_applicable trigger is deferred to phase end, list_accounts
    // runs and passes (counts as the substitute), and downstream
    // stateful steps proceed normally.
    agent = await startFakeAgent();
    const storyboard = storyboardWithPhases([
      {
        id: 'account_setup',
        title: 'account setup',
        steps: [
          {
            id: 'sync',
            title: 'sync_accounts (not applicable in explicit mode)',
            task: 'sync_accounts',
            stateful: true,
            auth: 'none',
            sample_request: { accounts: [] },
          },
          {
            // The fake agent answers __test_setup with { ok: true }.
            // Acts as a stand-in for list_accounts as the
            // state-establishing peer.
            id: 'list',
            title: 'list_accounts substitute',
            task: '__test_setup',
            stateful: true,
            auth: 'none',
            sample_request: {},
          },
        ],
      },
      {
        id: 'consume',
        title: 'consume account state',
        steps: [
          {
            id: 'audience',
            title: 'sync_audiences depends on account state',
            task: '__test_assert',
            stateful: true,
            auth: 'none',
            sample_request: {},
          },
        ],
      },
    ]);
    const ADVERTISED = ['sync_accounts', '__test_setup', '__test_assert', 'get_adcp_capabilities'];
    const result = await runStoryboard([agent.url], storyboard, {
      protocol: 'mcp',
      allow_http: true,
      agentTools: ADVERTISED,
      _profile: {
        name: 'fake',
        tools: ADVERTISED.map(name => ({ name })),
        raw_capabilities: { account: { require_operator_auth: true } },
      },
    });
    const [syncStep, listStep] = result.phases[0].steps;
    const audienceStep = result.phases[1].steps[0];
    assert.strictEqual(syncStep.skipped, true, 'sync_accounts skipped not_applicable');
    assert.strictEqual(syncStep.skip_reason, 'not_applicable');
    // The substitute peer must run (NOT cascade-skipped) — this is
    // the regression the fix targets.
    assert.notStrictEqual(listStep.skipped, true, 'list_accounts substitute runs (not cascade-skipped)');
    assert.strictEqual(listStep.passed, true, 'list_accounts substitute passes');
    // Downstream stateful step proceeds because the phase established
    // state via the substitute.
    assert.notStrictEqual(audienceStep.skipped, true, 'cross-phase stateful step runs (substitute established state)');
  });

  test('not_applicable: peer passes BEFORE the not_applicable skip → no cascade (order-independent)', async () => {
    // Order-flip variant of the substitute test. list_accounts comes
    // first and passes; sync_accounts is gated to not_applicable
    // afterwards. The phase-end resolution must work regardless of
    // step ordering: if any stateful peer passed, the deferred
    // trigger never fires.
    agent = await startFakeAgent();
    const storyboard = storyboardWithPhases([
      {
        id: 'account_setup',
        title: 'account setup',
        steps: [
          {
            id: 'list',
            title: 'list_accounts substitute (runs first)',
            task: '__test_setup',
            stateful: true,
            auth: 'none',
            sample_request: {},
          },
          {
            id: 'sync',
            title: 'sync_accounts (not applicable)',
            task: 'sync_accounts',
            stateful: true,
            auth: 'none',
            sample_request: { accounts: [] },
          },
        ],
      },
      {
        id: 'consume',
        title: 'consume account state',
        steps: [
          {
            id: 'audience',
            title: 'depends on account state',
            task: '__test_assert',
            stateful: true,
            auth: 'none',
            sample_request: {},
          },
        ],
      },
    ]);
    const ADVERTISED = ['sync_accounts', '__test_setup', '__test_assert', 'get_adcp_capabilities'];
    const result = await runStoryboard([agent.url], storyboard, {
      protocol: 'mcp',
      allow_http: true,
      agentTools: ADVERTISED,
      _profile: {
        name: 'fake',
        tools: ADVERTISED.map(name => ({ name })),
        raw_capabilities: { account: { require_operator_auth: true } },
      },
    });
    const [listStep, syncStep] = result.phases[0].steps;
    const audienceStep = result.phases[1].steps[0];
    assert.strictEqual(listStep.passed, true);
    assert.strictEqual(syncStep.skipped, true);
    assert.strictEqual(syncStep.skip_reason, 'not_applicable');
    assert.ok(!audienceStep.skipped, 'no cascade — peer passed earlier in phase');
  });

  test('not_applicable + non-stateful peer that passes does NOT cancel the deferred cascade', async () => {
    // The substitute signal is a passing *stateful* peer — non-stateful
    // peers explicitly do not establish state per the storyboard's own
    // declaration. A storyboard that pairs a stateful not_applicable
    // step with a non-stateful peer that runs successfully should still
    // cascade-skip downstream stateful steps, because the phase did not
    // establish state via any stateful path.
    agent = await startFakeAgent();
    const storyboard = storyboardWithPhases([
      {
        id: 'account_setup',
        title: 'account setup',
        steps: [
          {
            id: 'sync',
            title: 'sync_accounts (not applicable)',
            task: 'sync_accounts',
            stateful: true,
            auth: 'none',
            sample_request: { accounts: [] },
          },
          {
            id: 'observe',
            title: 'non-stateful observation peer',
            task: '__test_assert',
            // No stateful: true — runs successfully but does not
            // establish state per the storyboard's declaration.
            auth: 'none',
            sample_request: {},
          },
        ],
      },
      {
        id: 'consume',
        title: 'consume account state',
        steps: [
          {
            id: 'audience',
            title: 'depends on account state',
            task: '__test_assert',
            stateful: true,
            auth: 'none',
            sample_request: {},
          },
        ],
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
        raw_capabilities: { account: { require_operator_auth: true } },
      },
    });
    const [syncStep, observeStep] = result.phases[0].steps;
    const audienceStep = result.phases[1].steps[0];
    assert.strictEqual(syncStep.skipped, true);
    assert.strictEqual(syncStep.skip_reason, 'not_applicable');
    assert.ok(!observeStep.skipped, 'non-stateful peer runs');
    assert.strictEqual(observeStep.passed, true);
    // Cascade still fires because no *stateful* peer established state.
    assert.strictEqual(audienceStep.skipped, true, 'cascade fires — non-stateful pass does not establish state');
    assert.strictEqual(audienceStep.skip_reason, 'prerequisite_failed');
    assert.match(audienceStep.skip.detail ?? '', /not_applicable/);
  });

  test('not_applicable + later real failure in same phase: real failure wins the diagnostic', async () => {
    // When a stateful step skips not_applicable and a *later* stateful
    // step in the same phase fails for real, the real failure should
    // win the cascade-detail message — failures are the worse signal,
    // so downstream readers should see "prior stateful step failed"
    // rather than a stale not_applicable trigger. This locks in the
    // `&& !statefulFailed` guard at the phase-end resolution: when a
    // real failure has already tripped statefulFailed (and cleared
    // statefulSkipTrigger), the deferred not_applicable trigger must
    // not overwrite the failure-detail message.
    agent = await startFakeAgent();
    const storyboard = storyboardWithPhases([
      {
        id: 'account_setup',
        title: 'account setup',
        steps: [
          {
            id: 'sync',
            title: 'sync_accounts (not applicable)',
            task: 'sync_accounts',
            stateful: true,
            auth: 'none',
            sample_request: { accounts: [] },
          },
          {
            id: 'broken',
            title: 'stateful peer that fails for real',
            task: '__test_fail',
            stateful: true,
            auth: 'none',
            sample_request: {},
          },
        ],
      },
      {
        id: 'consume',
        title: 'consume account state',
        steps: [
          {
            id: 'audience',
            title: 'depends on account state',
            task: '__test_assert',
            stateful: true,
            auth: 'none',
            sample_request: {},
          },
        ],
      },
    ]);
    const ADVERTISED = ['sync_accounts', '__test_fail', '__test_assert', 'get_adcp_capabilities'];
    const result = await runStoryboard([agent.url], storyboard, {
      protocol: 'mcp',
      allow_http: true,
      agentTools: ADVERTISED,
      _profile: {
        name: 'fake',
        tools: ADVERTISED.map(name => ({ name })),
        raw_capabilities: { account: { require_operator_auth: true } },
      },
    });
    const [syncStep, brokenStep] = result.phases[0].steps;
    const audienceStep = result.phases[1].steps[0];
    assert.strictEqual(syncStep.skip_reason, 'not_applicable');
    assert.strictEqual(brokenStep.passed, false, 'broken peer failed for real');
    assert.ok(!brokenStep.skipped, 'broken peer ran (did not skip)');
    assert.strictEqual(audienceStep.skipped, true);
    assert.strictEqual(audienceStep.skip_reason, 'prerequisite_failed');
    // Real failure wins the diagnostic — the cascade-detail must NOT
    // reference the not_applicable skip.
    assert.match(audienceStep.skip.detail ?? '', /prior stateful step failed/);
    assert.doesNotMatch(
      audienceStep.skip.detail ?? '',
      /not_applicable/,
      'detail must reference the real failure, not the earlier not_applicable trigger'
    );
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

describe('runStoryboard: #1144 peer_substitutes_for — declared-substitute rescue for missing_tool', () => {
  let agent;

  afterEach(async () => {
    if (agent) await stopAgent(agent);
    agent = undefined;
    await closeMCPConnections().catch(() => {});
  });

  test('missing_tool + declared substitute that PASSES → no cascade (rescue)', async () => {
    // The 1/9/0 adapter case (#1144): sync_accounts is missing_tool because
    // the agent doesn't advertise it (explicit-mode platform with accounts
    // pre-provisioned out-of-band). list_accounts declares
    // `peer_substitutes_for: sync_accounts` and passes — phase establishes
    // equivalent state via the substitute, downstream stateful steps run.
    agent = await startFakeAgent();
    const storyboard = storyboardWithPhases([
      {
        id: 'account_setup',
        title: 'account setup',
        steps: [
          {
            id: 'sync',
            title: 'sync_accounts (not advertised — missing_tool)',
            task: 'sync_accounts',
            stateful: true,
            auth: 'none',
            sample_request: {},
          },
          {
            id: 'list',
            title: 'list_accounts (declared substitute)',
            task: '__test_setup',
            stateful: true,
            peer_substitutes_for: 'sync',
            auth: 'none',
            sample_request: {},
          },
        ],
      },
      {
        id: 'consume',
        title: 'consume account state',
        steps: [
          {
            id: 'audience',
            title: 'depends on account state',
            task: '__test_assert',
            stateful: true,
            auth: 'none',
            sample_request: {},
          },
        ],
      },
    ]);
    // sync_accounts is NOT advertised — triggers missing_tool.
    // __test_setup IS advertised — list_accounts runs and passes.
    const ADVERTISED = ['__test_setup', '__test_assert', 'get_adcp_capabilities'];
    const result = await runStoryboard([agent.url], storyboard, {
      protocol: 'mcp',
      allow_http: true,
      agentTools: ADVERTISED,
      _profile: { name: 'fake', tools: ADVERTISED.map(name => ({ name })) },
    });
    const [syncStep, listStep] = result.phases[0].steps;
    const audienceStep = result.phases[1].steps[0];
    assert.strictEqual(syncStep.skipped, true, 'sync_accounts skipped missing_tool');
    assert.strictEqual(syncStep.skip_reason, 'missing_tool');
    assert.strictEqual(listStep.passed, true, 'list_accounts substitute passes');
    assert.ok(!audienceStep.skipped, 'no cascade — declared substitute established state');
  });

  test('mutual declaration + both miss → cascade fires with substitution-chain detail', async () => {
    // Both sync_accounts and list_accounts unadvertised AND each declares
    // the other as a substitute. Both steps are deferred (each has a
    // declared substitute in the phase). Phase-end resolution promotes
    // the first deferred trigger and the cascade-detail names the
    // declared substitute that didn't rescue — the new diagnostic
    // affordance from #1144 so adopters see the substitution chain.
    agent = await startFakeAgent();
    const storyboard = storyboardWithPhases([
      {
        id: 'account_setup',
        title: 'account setup',
        steps: [
          {
            id: 'sync',
            title: 'sync_accounts (missing)',
            task: 'sync_accounts',
            stateful: true,
            peer_substitutes_for: 'list',
            auth: 'none',
            sample_request: {},
          },
          {
            id: 'list',
            title: 'list_accounts substitute (also missing)',
            task: 'list_accounts',
            stateful: true,
            peer_substitutes_for: 'sync',
            auth: 'none',
            sample_request: {},
          },
        ],
      },
      {
        id: 'consume',
        title: 'consume account state',
        steps: [
          {
            id: 'audience',
            title: 'depends on account state',
            task: '__test_assert',
            stateful: true,
            auth: 'none',
            sample_request: {},
          },
        ],
      },
    ]);
    // Neither sync_accounts nor list_accounts advertised.
    const ADVERTISED = ['__test_assert', 'get_adcp_capabilities'];
    const result = await runStoryboard([agent.url], storyboard, {
      protocol: 'mcp',
      allow_http: true,
      agentTools: ADVERTISED,
      _profile: { name: 'fake', tools: ADVERTISED.map(name => ({ name })) },
    });
    const [syncStep, listStep] = result.phases[0].steps;
    const audienceStep = result.phases[1].steps[0];
    assert.strictEqual(syncStep.skip_reason, 'missing_tool');
    assert.strictEqual(listStep.skip_reason, 'missing_tool');
    assert.strictEqual(audienceStep.skipped, true, 'cascade fires when no peer rescued');
    assert.strictEqual(audienceStep.skip_reason, 'prerequisite_failed');
    // First-wins: phasePendingMissingTool tracks the leftmost step.
    // Detail names the originating step AND the declared substitute
    // that didn't pass.
    assert.match(audienceStep.skip.detail ?? '', /prior stateful step "sync"/);
    assert.match(audienceStep.skip.detail ?? '', /missing_tool/);
    assert.match(audienceStep.skip.detail ?? '', /declared substitute "list" did not pass/);
  });

  test('missing_tool with NO declared substitute → cascade fires immediately (existing behavior preserved)', async () => {
    // Backward-compat guard: a stateful step that misses without anyone
    // in the phase declaring `peer_substitutes_for: <this>` still trips
    // the cascade immediately. The deferred-rescue path is opt-in.
    agent = await startFakeAgent();
    const storyboard = storyboardWith([
      {
        id: 'setup',
        title: 'setup state (no declared substitute)',
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
    assert.strictEqual(setupStep.skip_reason, 'missing_tool');
    assert.strictEqual(assertStep.skipped, true);
    assert.strictEqual(assertStep.skip_reason, 'prerequisite_failed');
    // Detail does NOT mention substitution chain — no declaration in play.
    assert.doesNotMatch(assertStep.skip.detail ?? '', /declared substitute/);
  });

  test('peer_substitutes_for accepts string[] — any declared substitute passing rescues', async () => {
    // Bulk-substitute hedge: a `bulk_setup` step can declare it
    // substitutes for multiple peers at once. Any single passing
    // substitute rescues every named target.
    agent = await startFakeAgent();
    const storyboard = storyboardWithPhases([
      {
        id: 'setup_phase',
        title: 'setup',
        steps: [
          {
            id: 'sync_accounts_step',
            title: 'sync_accounts (missing)',
            task: 'sync_accounts',
            stateful: true,
            auth: 'none',
            sample_request: {},
          },
          {
            id: 'sync_event_sources_step',
            title: 'sync_event_sources (missing)',
            task: 'sync_event_sources',
            stateful: true,
            auth: 'none',
            sample_request: {},
          },
          {
            id: 'bulk',
            title: 'bulk_setup (substitutes for both)',
            task: '__test_setup',
            stateful: true,
            peer_substitutes_for: ['sync_accounts_step', 'sync_event_sources_step'],
            auth: 'none',
            sample_request: {},
          },
        ],
      },
      {
        id: 'consume',
        title: 'consume state',
        steps: [
          {
            id: 'downstream',
            title: 'depends on both',
            task: '__test_assert',
            stateful: true,
            auth: 'none',
            sample_request: {},
          },
        ],
      },
    ]);
    const ADVERTISED = ['__test_setup', '__test_assert', 'get_adcp_capabilities'];
    const result = await runStoryboard([agent.url], storyboard, {
      protocol: 'mcp',
      allow_http: true,
      agentTools: ADVERTISED,
      _profile: { name: 'fake', tools: ADVERTISED.map(name => ({ name })) },
    });
    const [syncAcc, syncEvt, bulk] = result.phases[0].steps;
    const downstream = result.phases[1].steps[0];
    assert.strictEqual(syncAcc.skip_reason, 'missing_tool');
    assert.strictEqual(syncEvt.skip_reason, 'missing_tool');
    assert.strictEqual(bulk.passed, true, 'bulk substitute passes');
    assert.ok(!downstream.skipped, 'no cascade — bulk substitute rescued both targets');
  });

  test('peer_substitutes_for: self-reference rejected at parse time', async () => {
    agent = await startFakeAgent();
    const storyboard = storyboardWith([
      {
        id: 'self',
        title: 'self-substitute',
        task: '__test_setup',
        stateful: true,
        peer_substitutes_for: 'self',
        auth: 'none',
        sample_request: {},
      },
    ]);
    await assert.rejects(
      runStoryboard([agent.url], storyboard, {
        protocol: 'mcp',
        allow_http: true,
        agentTools: ['__test_setup', 'get_adcp_capabilities'],
        _profile: { name: 'fake', tools: [{ name: '__test_setup' }, { name: 'get_adcp_capabilities' }] },
      }),
      /peer_substitutes_for cannot reference itself/
    );
  });

  test('peer_substitutes_for: empty-string entry in array rejected at parse time', async () => {
    agent = await startFakeAgent();
    const storyboard = storyboardWith([
      {
        id: 'target',
        title: 'target',
        task: '__test_setup',
        stateful: true,
        auth: 'none',
        sample_request: {},
      },
      {
        id: 'sub',
        title: 'substitute with empty entry',
        task: '__test_assert',
        stateful: true,
        peer_substitutes_for: ['target', ''],
        auth: 'none',
        sample_request: {},
      },
    ]);
    await assert.rejects(
      runStoryboard([agent.url], storyboard, {
        protocol: 'mcp',
        allow_http: true,
        agentTools: ['__test_setup', '__test_assert', 'get_adcp_capabilities'],
        _profile: {
          name: 'fake',
          tools: [{ name: '__test_setup' }, { name: '__test_assert' }, { name: 'get_adcp_capabilities' }],
        },
      }),
      /peer_substitutes_for entries must be non-empty strings/
    );
  });

  test('peer_substitutes_for: target step must be stateful (rejected at parse time)', async () => {
    agent = await startFakeAgent();
    const storyboard = storyboardWith([
      {
        id: 'target_nonstateful',
        title: 'non-stateful target',
        task: '__test_setup',
        auth: 'none',
        sample_request: {},
      },
      {
        id: 'sub',
        title: 'substitute pointing at non-stateful target',
        task: '__test_assert',
        stateful: true,
        peer_substitutes_for: 'target_nonstateful',
        auth: 'none',
        sample_request: {},
      },
    ]);
    await assert.rejects(
      runStoryboard([agent.url], storyboard, {
        protocol: 'mcp',
        allow_http: true,
        agentTools: ['__test_setup', '__test_assert', 'get_adcp_capabilities'],
        _profile: {
          name: 'fake',
          tools: [{ name: '__test_setup' }, { name: '__test_assert' }, { name: 'get_adcp_capabilities' }],
        },
      }),
      /peer_substitutes_for target 'target_nonstateful' must be stateful/
    );
  });

  test('peer_substitutes_for: substitute step must itself be stateful (rejected at parse time)', async () => {
    agent = await startFakeAgent();
    const storyboard = storyboardWith([
      {
        id: 'target',
        title: 'stateful target',
        task: '__test_setup',
        stateful: true,
        auth: 'none',
        sample_request: {},
      },
      {
        id: 'sub_nonstateful',
        title: 'non-stateful substitute',
        task: '__test_assert',
        peer_substitutes_for: 'target',
        auth: 'none',
        sample_request: {},
      },
    ]);
    await assert.rejects(
      runStoryboard([agent.url], storyboard, {
        protocol: 'mcp',
        allow_http: true,
        agentTools: ['__test_setup', '__test_assert', 'get_adcp_capabilities'],
        _profile: {
          name: 'fake',
          tools: [{ name: '__test_setup' }, { name: '__test_assert' }, { name: 'get_adcp_capabilities' }],
        },
      }),
      /peer_substitutes_for is only legal on stateful steps/
    );
  });

  test('peer_substitutes_for is same-phase only — cross-phase reference rejected at parse time', async () => {
    // Scope guard: substitution is confined to a single phase. The
    // loader's authoring-time validator rejects cross-phase references
    // so storyboard authors see typos and scope mistakes on build, not
    // as a silent no-rescue at run time.
    agent = await startFakeAgent();
    const storyboard = storyboardWithPhases([
      {
        id: 'phase_one',
        title: 'phase 1',
        steps: [
          {
            id: 'sync',
            title: 'sync_accounts (target lives here)',
            task: 'sync_accounts',
            stateful: true,
            auth: 'none',
            sample_request: {},
          },
        ],
      },
      {
        id: 'phase_two',
        title: 'phase 2 (would-be substitute lives here)',
        steps: [
          {
            id: 'list',
            title: 'list_accounts in wrong phase',
            task: '__test_setup',
            stateful: true,
            peer_substitutes_for: 'sync',
            auth: 'none',
            sample_request: {},
          },
        ],
      },
    ]);
    await assert.rejects(
      runStoryboard([agent.url], storyboard, {
        protocol: 'mcp',
        allow_http: true,
        agentTools: ['__test_setup', 'get_adcp_capabilities'],
        _profile: { name: 'fake', tools: [{ name: '__test_setup' }, { name: 'get_adcp_capabilities' }] },
      }),
      /peer_substitutes_for target 'sync' is not a step in this phase/
    );
  });
});

describe('runStoryboard: F6 round-2 — cascade survives phase boundaries', () => {
  let agent;

  afterEach(async () => {
    if (agent) await stopAgent(agent);
    agent = undefined;
    await closeMCPConnections().catch(() => {});
  });

  test('stateful skip in phase 1 cascades to stateful step in phase 3 (cross-phase)', async () => {
    // Models the real adopter case (signal_marketplace/governance_denied):
    // sync_governance setup in phase 1 skips with missing_tool, then
    // activate_signal_denied assertion in phase 3 needs that state.
    // Pre-fix: statefulFailed reset at phase boundary, assertion ran
    // against absent state and failed misleadingly. Post-fix: cascade
    // survives across phases, assertion cleanly skips.
    agent = await startFakeAgent();
    const storyboard = storyboardWithPhases([
      {
        id: 'phase_setup',
        title: 'governance setup',
        steps: [
          {
            id: 'sync_gov',
            title: 'sync_governance setup',
            task: '__test_setup_gov',
            stateful: true,
            auth: 'none',
            sample_request: {},
          },
        ],
      },
      {
        id: 'phase_intermediate',
        title: 'unrelated step',
        steps: [
          {
            id: 'probe',
            title: 'unrelated probe (not stateful)',
            task: '__test_assert',
            auth: 'none',
            sample_request: {},
          },
        ],
      },
      {
        id: 'phase_consume',
        title: 'consume governance state',
        steps: [
          {
            id: 'activate_denied',
            title: 'activate against denied state',
            task: '__test_assert',
            stateful: true,
            auth: 'none',
            sample_request: {},
          },
        ],
      },
    ]);
    // __test_setup_gov is NOT in agentTools — sync skips with missing_tool.
    // __test_assert IS advertised — without the cascade fix, the
    // phase-3 stateful step would run and (in a real scenario) fail.
    const ADVERTISED = ['__test_assert', 'get_adcp_capabilities'];
    const result = await runStoryboard([agent.url], storyboard, {
      protocol: 'mcp',
      allow_http: true,
      agentTools: ADVERTISED,
      _profile: { name: 'fake', tools: ADVERTISED.map(name => ({ name })) },
    });
    const setupStep = result.phases[0].steps[0];
    const probeStep = result.phases[1].steps[0];
    const consumeStep = result.phases[2].steps[0];

    assert.strictEqual(setupStep.skipped, true, 'phase 1 setup skipped');
    assert.strictEqual(setupStep.skip_reason, 'missing_tool');

    // Non-stateful intermediate step in phase 2 still runs — cascade
    // gates only stateful steps.
    assert.notStrictEqual(probeStep.skipped, true, 'phase 2 non-stateful step runs');

    // Phase 3 stateful step cascade-skips even though phase 1's
    // statefulFailed flag would have been reset under the old per-phase
    // scope. This is the round-2 lift fix.
    assert.strictEqual(consumeStep.skipped, true, 'cross-phase cascade fires');
    assert.strictEqual(consumeStep.skip_reason, 'prerequisite_failed');
    assert.match(consumeStep.skip.detail ?? '', /sync_gov/, 'detail references the phase-1 trigger');
    assert.match(consumeStep.skip.detail ?? '', /missing_tool/);
  });
});

describe('runStoryboard: capability-aware cascade (adcp-client#1169)', () => {
  // When a phase's stateful cascade trips, downstream stateful steps
  // should be classified by their intrinsic skip-eligibility BEFORE the
  // cascade reason is applied:
  //   - task not in agentTools → missing_tool (passed: true, benign)
  //   - task in agentTools     → prerequisite_failed (passed: false, genuine cascade)
  let agent;

  afterEach(async () => {
    if (agent) await stopAgent(agent);
    agent = undefined;
    await closeMCPConnections().catch(() => {});
  });

  test('cascade-skipped step with un-advertised task gets missing_tool (not prerequisite_failed)', async () => {
    // Phase 1: sync_setup fails (stateful). Phase 2: sync_creatives is
    // stateful but NOT in agentTools. Before fix: phase-2 step gets
    // prerequisite_failed (passed: false). After fix: phase-2 step gets
    // missing_tool (passed: true) — the agent never claimed this surface.
    agent = await startFakeAgent();
    const storyboard = storyboardWithPhases([
      {
        id: 'setup',
        title: 'setup (fails)',
        steps: [
          {
            id: 'setup',
            title: 'setup step (fails)',
            task: '__test_fail',
            stateful: true,
            auth: 'none',
            sample_request: {},
          },
        ],
      },
      {
        id: 'creative_push',
        title: 'creative push',
        steps: [
          {
            id: 'sync_creatives',
            title: 'sync_creatives (not advertised)',
            task: 'sync_creatives',
            stateful: true,
            auth: 'none',
            sample_request: {},
          },
        ],
      },
    ]);
    // sync_creatives is NOT in agentTools — independently missing_tool.
    const ADVERTISED = ['__test_fail', 'get_adcp_capabilities'];
    const result = await runStoryboard([agent.url], storyboard, {
      protocol: 'mcp',
      allow_http: true,
      agentTools: ADVERTISED,
      _profile: { name: 'fake', tools: ADVERTISED.map(name => ({ name })) },
    });
    const setupStep = result.phases[0].steps[0];
    const creativeStep = result.phases[1].steps[0];

    assert.ok(!setupStep.skipped, 'setup step ran (not cascade-skipped)');
    assert.ok(!setupStep.passed, 'setup step failed (trips statefulFailed)');
    // Capability-aware cascade: sync_creatives not advertised → missing_tool
    assert.strictEqual(creativeStep.skipped, true, 'creative step skipped');
    assert.strictEqual(
      creativeStep.skip_reason,
      'missing_tool',
      'skip reason is missing_tool (not prerequisite_failed)'
    );
    assert.strictEqual(creativeStep.passed, true, 'missing_tool skip is a passing skip');
    assert.match(creativeStep.skip.detail ?? '', /sync_creatives/, 'detail names the un-advertised tool');
  });

  test('cascade-skipped step with advertised task still gets prerequisite_failed', async () => {
    // Upstream fails. Downstream task IS advertised. The cascade should
    // still fire with prerequisite_failed — the fix must not suppress
    // genuine cascades where the agent has the tool but state never
    // materialized.
    agent = await startFakeAgent();
    const storyboard = storyboardWithPhases([
      {
        id: 'setup',
        title: 'setup (fails)',
        steps: [
          {
            id: 'setup',
            title: 'setup step (fails)',
            task: '__test_fail',
            stateful: true,
            auth: 'none',
            sample_request: {},
          },
        ],
      },
      {
        id: 'consume',
        title: 'consume state',
        steps: [
          {
            id: 'assert',
            title: 'assert (advertised)',
            task: '__test_assert',
            stateful: true,
            auth: 'none',
            sample_request: {},
          },
        ],
      },
    ]);
    // __test_assert IS in agentTools — genuine cascade should fire.
    const ADVERTISED = ['__test_fail', '__test_assert', 'get_adcp_capabilities'];
    const result = await runStoryboard([agent.url], storyboard, {
      protocol: 'mcp',
      allow_http: true,
      agentTools: ADVERTISED,
      _profile: { name: 'fake', tools: ADVERTISED.map(name => ({ name })) },
    });
    const setupStep = result.phases[0].steps[0];
    const assertStep = result.phases[1].steps[0];

    assert.ok(!setupStep.passed, 'setup failed');
    assert.strictEqual(assertStep.skipped, true, 'assert cascade-skipped');
    assert.strictEqual(assertStep.skip_reason, 'prerequisite_failed', 'advertised task still gets prerequisite_failed');
    assert.strictEqual(assertStep.passed, false, 'prerequisite_failed is a failing skip');
  });

  test('$test_kit.* step: resolved task checked against agentTools, not template string', async () => {
    // Regression guard for the blocker identified in pre-implementation
    // review: the tool-advertisement check must use resolveTaskName(),
    // not step.task, so $test_kit.* steps are checked against the
    // concrete resolved name. Without the resolveTaskName() call, the
    // template string "$test_kit...." would never be in agentTools and
    // every $test_kit.* step would incorrectly become missing_tool.
    //
    // This test verifies that a $test_kit.* step whose task_default IS
    // in agentTools still receives prerequisite_failed (not missing_tool)
    // when upstream state never materialized.
    agent = await startFakeAgent();
    const storyboard = storyboardWithPhases([
      {
        id: 'setup',
        title: 'setup (fails)',
        steps: [
          {
            id: 'setup',
            title: 'setup step (fails)',
            task: '__test_fail',
            stateful: true,
            auth: 'none',
            sample_request: {},
          },
        ],
      },
      {
        id: 'consume',
        title: 'consume state (test-kit step)',
        steps: [
          {
            id: 'testkit_step',
            title: 'test-kit resolved step (advertised via task_default)',
            task: '$test_kit.nonexistent.path',
            task_default: '__test_assert',
            stateful: true,
            auth: 'none',
            sample_request: {},
          },
        ],
      },
    ]);
    // __test_assert IS in agentTools. The cascade must not misclassify
    // the $test_kit.* step as missing_tool just because the template
    // string isn't in agentTools.
    const ADVERTISED = ['__test_fail', '__test_assert', 'get_adcp_capabilities'];
    const result = await runStoryboard([agent.url], storyboard, {
      protocol: 'mcp',
      allow_http: true,
      agentTools: ADVERTISED,
      _profile: { name: 'fake', tools: ADVERTISED.map(name => ({ name })) },
    });
    const setupStep = result.phases[0].steps[0];
    const testkitStep = result.phases[1].steps[0];

    assert.ok(!setupStep.passed, 'setup failed');
    assert.strictEqual(testkitStep.skipped, true, 'test-kit step cascade-skipped');
    // Resolved task (__test_assert) IS advertised → genuine cascade, not missing_tool.
    assert.strictEqual(
      testkitStep.skip_reason,
      'prerequisite_failed',
      '$test_kit.* step with advertised task_default still gets prerequisite_failed'
    );
  });
});

describe('runStoryboard: #1161 phase.depends_on cascade scoping', () => {
  let agent;

  afterEach(async () => {
    if (agent) await stopAgent(agent);
    agent = undefined;
    await closeMCPConnections().catch(() => {});
  });

  test('depends_on: [] — independent phase runs even when prior phase tripped cascade', async () => {
    // The citrusad-shape case (#1161): account_setup phase trips
    // missing_tool; audience_sync is functionally independent (carries
    // its own account ref via brand+operator). Declaring `depends_on: []`
    // on audience_sync lets it run instead of cascade-skipping.
    agent = await startFakeAgent();
    const storyboard = storyboardWithPhases([
      {
        id: 'account_setup',
        title: 'account setup (will trip)',
        steps: [
          {
            id: 'sync',
            title: 'sync_accounts (missing)',
            task: 'sync_accounts',
            stateful: true,
            auth: 'none',
            sample_request: {},
          },
        ],
      },
      {
        id: 'audience_sync',
        title: 'audience sync (independent)',
        depends_on: [],
        steps: [
          {
            id: 'sync_aud',
            title: 'sync audiences',
            task: '__test_setup',
            stateful: true,
            auth: 'none',
            sample_request: {},
          },
        ],
      },
    ]);
    // sync_accounts not advertised — phase 1 trips. __test_setup is
    // advertised — phase 2 should run normally because it declares
    // independence.
    const ADVERTISED = ['__test_setup', 'get_adcp_capabilities'];
    const result = await runStoryboard([agent.url], storyboard, {
      protocol: 'mcp',
      allow_http: true,
      agentTools: ADVERTISED,
      _profile: { name: 'fake', tools: ADVERTISED.map(name => ({ name })) },
    });
    const syncStep = result.phases[0].steps[0];
    const audStep = result.phases[1].steps[0];
    assert.strictEqual(syncStep.skip_reason, 'missing_tool', 'phase 1 tripped');
    assert.notStrictEqual(audStep.skipped, true, 'phase 2 ran (depends_on: [] = independent)');
    assert.strictEqual(audStep.passed, true);
  });

  test('depends_on: ["specific_phase"] — cascades only when that phase tripped', async () => {
    // Targeted dependency: phase 3 depends only on phase 1 (not phase 2).
    // Phase 2 trips cascade, but phase 3 should still run because it
    // doesn't depend on phase 2.
    agent = await startFakeAgent();
    const storyboard = storyboardWithPhases([
      {
        id: 'account_setup',
        title: 'account setup (passes)',
        steps: [
          {
            id: 'sync',
            title: 'sync accounts',
            task: '__test_setup',
            stateful: true,
            auth: 'none',
            sample_request: {},
          },
        ],
      },
      {
        id: 'audience_sync',
        title: 'audience sync (will trip)',
        steps: [
          {
            id: 'aud',
            title: 'sync audiences (missing)',
            task: 'sync_audiences',
            stateful: true,
            auth: 'none',
            sample_request: {},
          },
        ],
      },
      {
        id: 'creative_push',
        title: 'creative push (depends only on account_setup)',
        depends_on: ['account_setup'],
        steps: [
          {
            id: 'cre',
            title: 'sync creatives',
            task: '__test_assert',
            stateful: true,
            auth: 'none',
            sample_request: {},
          },
        ],
      },
    ]);
    const ADVERTISED = ['__test_setup', '__test_assert', 'get_adcp_capabilities'];
    const result = await runStoryboard([agent.url], storyboard, {
      protocol: 'mcp',
      allow_http: true,
      agentTools: ADVERTISED,
      _profile: { name: 'fake', tools: ADVERTISED.map(name => ({ name })) },
    });
    const phase1 = result.phases[0].steps[0];
    const phase2 = result.phases[1].steps[0];
    const phase3 = result.phases[2].steps[0];
    assert.strictEqual(phase1.passed, true, 'account_setup passes');
    assert.strictEqual(phase2.skip_reason, 'missing_tool', 'audience_sync tripped');
    // creative_push depends only on account_setup, not audience_sync.
    assert.notStrictEqual(phase3.skipped, true, 'creative_push runs (deps on account_setup which passed)');
    assert.strictEqual(phase3.passed, true);
  });

  test('depends_on default (undefined) preserves all-prior-phases cascade — F6 round-2 still works', async () => {
    // Backward-compat guard: storyboards without `depends_on` keep the
    // legacy "depend on every prior phase" semantics. The F6 round-2
    // cross-phase pattern (signal_marketplace/governance_denied) MUST
    // continue to cascade without YAML changes.
    agent = await startFakeAgent();
    const storyboard = storyboardWithPhases([
      {
        id: 'phase_1_trip',
        title: 'phase 1 (trips)',
        steps: [
          {
            id: 'setup',
            title: 'setup (missing)',
            task: 'sync_governance',
            stateful: true,
            auth: 'none',
            sample_request: {},
          },
        ],
      },
      {
        id: 'phase_2',
        title: 'phase 2 (default depends_on — implicit "all prior")',
        steps: [
          {
            id: 'consume',
            title: 'consume',
            task: '__test_assert',
            stateful: true,
            auth: 'none',
            sample_request: {},
          },
        ],
      },
    ]);
    const ADVERTISED = ['__test_assert', 'get_adcp_capabilities'];
    const result = await runStoryboard([agent.url], storyboard, {
      protocol: 'mcp',
      allow_http: true,
      agentTools: ADVERTISED,
      _profile: { name: 'fake', tools: ADVERTISED.map(name => ({ name })) },
    });
    const phase2 = result.phases[1].steps[0];
    // Legacy default: implicit "all prior" → phase 2 cascade-skips.
    assert.strictEqual(phase2.skipped, true, 'default depends_on = all prior, cascade fires');
    assert.strictEqual(phase2.skip_reason, 'prerequisite_failed');
  });

  test('depends_on rejects forward references at parse time', async () => {
    agent = await startFakeAgent();
    const storyboard = storyboardWithPhases([
      {
        id: 'first',
        title: 'first (declares forward dep on later)',
        depends_on: ['later'],
        steps: [
          {
            id: 'a',
            title: 'a',
            task: '__test_setup',
            stateful: true,
            auth: 'none',
            sample_request: {},
          },
        ],
      },
      {
        id: 'later',
        title: 'later phase',
        steps: [
          {
            id: 'b',
            title: 'b',
            task: '__test_setup',
            stateful: true,
            auth: 'none',
            sample_request: {},
          },
        ],
      },
    ]);
    await assert.rejects(
      runStoryboard([agent.url], storyboard, {
        protocol: 'mcp',
        allow_http: true,
        agentTools: ['__test_setup', 'get_adcp_capabilities'],
        _profile: { name: 'fake', tools: [{ name: '__test_setup' }, { name: 'get_adcp_capabilities' }] },
      }),
      /depends_on 'later' is not a phase declared earlier/
    );
  });

  test('depends_on rejects self-reference at parse time', async () => {
    agent = await startFakeAgent();
    const storyboard = storyboardWithPhases([
      {
        id: 'self_ref',
        title: 'self-referential phase',
        depends_on: ['self_ref'],
        steps: [
          {
            id: 'a',
            title: 'a',
            task: '__test_setup',
            stateful: true,
            auth: 'none',
            sample_request: {},
          },
        ],
      },
    ]);
    await assert.rejects(
      runStoryboard([agent.url], storyboard, {
        protocol: 'mcp',
        allow_http: true,
        agentTools: ['__test_setup', 'get_adcp_capabilities'],
        _profile: { name: 'fake', tools: [{ name: '__test_setup' }, { name: 'get_adcp_capabilities' }] },
      }),
      /depends_on cannot reference itself/
    );
  });

  test('depends_on rejects unknown phase ids at parse time', async () => {
    agent = await startFakeAgent();
    const storyboard = storyboardWithPhases([
      {
        id: 'first',
        title: 'first',
        steps: [
          {
            id: 'a',
            title: 'a',
            task: '__test_setup',
            stateful: true,
            auth: 'none',
            sample_request: {},
          },
        ],
      },
      {
        id: 'second',
        title: 'second (depends on nonexistent)',
        depends_on: ['nonexistent_phase'],
        steps: [
          {
            id: 'b',
            title: 'b',
            task: '__test_setup',
            stateful: true,
            auth: 'none',
            sample_request: {},
          },
        ],
      },
    ]);
    await assert.rejects(
      runStoryboard([agent.url], storyboard, {
        protocol: 'mcp',
        allow_http: true,
        agentTools: ['__test_setup', 'get_adcp_capabilities'],
        _profile: { name: 'fake', tools: [{ name: '__test_setup' }, { name: 'get_adcp_capabilities' }] },
      }),
      /depends_on 'nonexistent_phase' is not a phase declared earlier/
    );
  });

  test('within-phase cascade still fires regardless of depends_on (intra-phase state dependency)', async () => {
    // depends_on scopes INTER-phase cascade. Within a single phase,
    // stateful steps later in the phase still depend on stateful steps
    // earlier in the same phase by storyboard authoring intent — that
    // can't be opted out of with depends_on.
    agent = await startFakeAgent();
    const storyboard = storyboardWithPhases([
      {
        id: 'lonely',
        title: 'single independent phase with intra-phase cascade',
        depends_on: [],
        steps: [
          {
            id: 'setup',
            title: 'setup (missing)',
            task: 'sync_accounts',
            stateful: true,
            auth: 'none',
            sample_request: {},
          },
          {
            id: 'consume',
            title: 'consume earlier state',
            task: '__test_assert',
            stateful: true,
            auth: 'none',
            sample_request: {},
          },
        ],
      },
    ]);
    const ADVERTISED = ['__test_assert', 'get_adcp_capabilities'];
    const result = await runStoryboard([agent.url], storyboard, {
      protocol: 'mcp',
      allow_http: true,
      agentTools: ADVERTISED,
      _profile: { name: 'fake', tools: ADVERTISED.map(name => ({ name })) },
    });
    const [setupStep, consumeStep] = result.phases[0].steps;
    assert.strictEqual(setupStep.skip_reason, 'missing_tool');
    // Within-phase cascade: consume cascades regardless of depends_on
    // because setup is in the SAME phase.
    assert.strictEqual(consumeStep.skipped, true, 'within-phase cascade fires');
    assert.strictEqual(consumeStep.skip_reason, 'prerequisite_failed');
  });
});
