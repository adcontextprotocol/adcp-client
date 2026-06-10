/**
 * Cascade-skip behavior when a prior stateful step skipped or failed.
 *
 * Refactored to a fixture-table matrix (issue adcp-client#1548) keyed by
 * the three orthogonal dimensions of cascade behavior:
 *
 *   skip_reason     ∈ { missing_tool, missing_test_controller,
 *                       not_applicable, real_failure }
 *   peer_shape      ∈ { sole_stateful, peer_passes, peer_fails,
 *                       peer_substitute_declared, peer_substitute_missing }
 *   phase_topology  ∈ { same_phase, downstream_phase }
 *
 * Each row is one fixture run end-to-end. Cells the cube can't represent
 * (e.g., `peer_substitute_declared × sole_stateful` — sole means no peer)
 * are marked `structurally_impossible` in MATRIX_COVERAGE so reviewers see
 * empty cells in the grid rather than discovering them as production bugs.
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
 *
 * The sole-stateful-step exemption (adcp-client#1146 + #1545): when a
 * stateful step is the ONLY stateful step in its phase and skips for a
 * reason in the exemption family (`not_applicable`, `missing_tool`,
 * `missing_test_controller`), no peer could have established substitute
 * state — the runner treats the phase as "platform legitimately doesn't
 * use this pathway" and lets downstream phases run.
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner.js');
const { closeMCPConnections } = require('../../dist/lib/protocols/mcp.js');

// ---------------------------------------------------------------------
// Fake agent + storyboard builders
// ---------------------------------------------------------------------

async function startFakeAgent() {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (rpc.method === 'initialize') {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'test-session' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'test', version: '1.0.0' } },
        })
      );
      return;
    }
    if (rpc.method === 'notifications/initialized') {
      res.writeHead(202);
      res.end();
      return;
    }
    if (rpc.method === 'tools/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            tools: ['__test_setup', '__test_assert', 'sync_accounts', '__test_fail', 'get_adcp_capabilities'].map(
              name => ({ name, inputSchema: { type: 'object' } })
            ),
          },
        })
      );
      return;
    }
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
      // Always fails — for cascade-message-truthfulness tests that need
      // a real fail (not a skip) to trip statefulFailed.
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

function step(id, task, extras = {}) {
  return {
    id,
    title: id,
    task,
    stateful: true,
    auth: 'none',
    sample_request: {},
    ...extras,
  };
}

function runWith(agent, storyboard, advertised, profileExtras = {}) {
  const tools = advertised.map(name => ({ name }));
  return runStoryboard([agent.url], storyboard, {
    protocol: 'mcp',
    allow_http: true,
    agentTools: advertised,
    _profile: { name: 'fake', tools, ...profileExtras },
  });
}

// ---------------------------------------------------------------------
// Matrix definitions
// ---------------------------------------------------------------------

const SKIP_REASONS = ['missing_tool', 'missing_test_controller', 'not_applicable', 'real_failure'];
const PEER_SHAPES = [
  'sole_stateful',
  'peer_passes',
  'peer_fails',
  'peer_substitute_declared',
  'peer_substitute_missing',
];
const PHASE_TOPOLOGIES = ['same_phase', 'downstream_phase'];

// ---------------------------------------------------------------------
// Matrix rows
//
// Each row carries:
//   - axes: { skip_reason, peer_shape, phase_topology }
//   - title: short scenario name (becomes the test name)
//   - issue: tracking issue/PR for the original assertion
//   - build(agent): returns { storyboard, advertised, profileExtras? }
//   - assert(result): runs the assertions for this row
//
// Historical 35 prose-driven scenarios are preserved here as named rows.
// ---------------------------------------------------------------------

const MATRIX_ROWS = [
  // -------------------------------------------------------------------
  // missing_tool
  // -------------------------------------------------------------------
  {
    axes: { skip_reason: 'missing_tool', peer_shape: 'sole_stateful', phase_topology: 'same_phase' },
    title: 'missing_tool on prior stateful step cascades to subsequent stateful step in same phase',
    issue: 'F6',
    build: () => ({
      storyboard: storyboardWith([step('setup', '__test_setup'), step('assert', '__test_assert')]),
      advertised: ['__test_assert', 'get_adcp_capabilities'],
    }),
    assert: result => {
      const [setupStep, assertStep] = result.phases[0].steps;
      assert.strictEqual(setupStep.skipped, true);
      assert.strictEqual(setupStep.skip_reason, 'missing_tool');
      assert.strictEqual(assertStep.skipped, true, 'F6: stateful assertion cascade-skips when stateful setup skipped');
      assert.strictEqual(assertStep.skip_reason, 'prerequisite_failed');
      // Detail message must tell the truth: prior step skipped (not failed).
      assert.match(assertStep.skip.detail ?? '', /prior stateful step "setup" skipped \(missing_tool\)/);
      assert.match(assertStep.skip.detail ?? '', /state never materialized/);
    },
  },
  {
    axes: { skip_reason: 'missing_tool', peer_shape: 'sole_stateful', phase_topology: 'downstream_phase' },
    title: 'sole stateful step missing_tool → no cascade (adcp-client-python#550)',
    issue: 'adcp-client#1545',
    build: () => ({
      storyboard: storyboardWithPhases([
        { id: 'account_setup', title: 'setup', steps: [step('sync', 'sync_accounts')] },
        { id: 'consume', title: 'consume', steps: [step('assert', '__test_assert')] },
      ]),
      advertised: ['__test_assert', 'get_adcp_capabilities'],
    }),
    assert: result => {
      const syncStep = result.phases[0].steps[0];
      const assertStep = result.phases[1].steps[0];
      assert.strictEqual(syncStep.skipped, true);
      assert.strictEqual(syncStep.skip_reason, 'missing_tool');
      assert.ok(!assertStep.skipped, 'downstream runs — sole stateful step missing_tool does not cascade');
      assert.strictEqual(assertStep.passed, true);
      assert.match(syncStep.skip.detail ?? '', /Sole stateful step exemption applied for phase 'account_setup'/);
    },
  },
  {
    axes: { skip_reason: 'missing_tool', peer_shape: 'peer_fails', phase_topology: 'downstream_phase' },
    title: 'cross-phase cascade when both stateful peers miss with no rescue',
    issue: 'F6 round-2',
    build: () => ({
      storyboard: storyboardWithPhases([
        {
          id: 'phase_setup',
          title: 'governance setup',
          steps: [step('sync_gov', '__test_setup_gov'), step('sync_gov_peer', '__test_setup_gov_peer')],
        },
        {
          id: 'phase_intermediate',
          title: 'unrelated step',
          steps: [step('probe', '__test_assert', { stateful: false })],
        },
        {
          id: 'phase_consume',
          title: 'consume governance state',
          steps: [step('activate_denied', '__test_assert')],
        },
      ]),
      advertised: ['__test_assert', 'get_adcp_capabilities'],
    }),
    assert: result => {
      const setupStep = result.phases[0].steps[0];
      const probeStep = result.phases[1].steps[0];
      const consumeStep = result.phases[2].steps[0];
      assert.strictEqual(setupStep.skipped, true, 'phase 1 setup skipped');
      assert.strictEqual(setupStep.skip_reason, 'missing_tool');
      assert.notStrictEqual(probeStep.skipped, true, 'phase 2 non-stateful step runs');
      assert.strictEqual(consumeStep.skipped, true, 'cross-phase cascade fires');
      assert.strictEqual(consumeStep.skip_reason, 'prerequisite_failed');
      assert.match(consumeStep.skip.detail ?? '', /sync_gov/, 'detail references the phase-1 trigger');
      assert.match(consumeStep.skip.detail ?? '', /missing_tool/);
    },
  },
  {
    axes: {
      skip_reason: 'missing_tool',
      peer_shape: 'peer_substitute_declared',
      phase_topology: 'downstream_phase',
    },
    title: 'missing_tool + declared substitute that PASSES → no cascade (rescue)',
    issue: 'adcp-client#1144',
    build: () => ({
      storyboard: storyboardWithPhases([
        {
          id: 'account_setup',
          title: 'account setup',
          steps: [step('sync', 'sync_accounts'), step('list', '__test_setup', { peer_substitutes_for: 'sync' })],
        },
        { id: 'consume', title: 'consume', steps: [step('audience', '__test_assert')] },
      ]),
      advertised: ['__test_setup', '__test_assert', 'get_adcp_capabilities'],
    }),
    assert: result => {
      const [syncStep, listStep] = result.phases[0].steps;
      const audienceStep = result.phases[1].steps[0];
      assert.strictEqual(syncStep.skipped, true, 'sync_accounts skipped after rescue');
      // adcp-client#1267: rescued targets are re-graded `peer_substituted`.
      assert.strictEqual(syncStep.skip_reason, 'peer_substituted');
      assert.match(syncStep.skip.detail ?? '', /sync state provided by account_setup\.list/);
      assert.strictEqual(listStep.passed, true, 'list_accounts substitute passes');
      assert.ok(!audienceStep.skipped, 'no cascade — declared substitute established state');
    },
  },
  {
    axes: {
      skip_reason: 'missing_tool',
      peer_shape: 'peer_substitute_declared',
      phase_topology: 'same_phase',
    },
    title: 'peer_substitutes_for accepts string[] — bulk substitute rescues multiple targets',
    issue: 'adcp-client#1144',
    build: () => ({
      storyboard: storyboardWithPhases([
        {
          id: 'setup_phase',
          title: 'setup',
          steps: [
            step('sync_accounts_step', 'sync_accounts'),
            step('sync_event_sources_step', 'sync_event_sources'),
            step('bulk', '__test_setup', {
              peer_substitutes_for: ['sync_accounts_step', 'sync_event_sources_step'],
            }),
          ],
        },
        { id: 'consume', title: 'consume', steps: [step('downstream', '__test_assert')] },
      ]),
      advertised: ['__test_setup', '__test_assert', 'get_adcp_capabilities'],
    }),
    assert: result => {
      const [syncAcc, syncEvt, bulk] = result.phases[0].steps;
      const downstream = result.phases[1].steps[0];
      assert.strictEqual(syncAcc.skip_reason, 'peer_substituted');
      assert.strictEqual(syncEvt.skip_reason, 'peer_substituted');
      assert.match(syncAcc.skip.detail ?? '', /sync_accounts_step state provided by setup_phase\.bulk/);
      assert.match(syncEvt.skip.detail ?? '', /sync_event_sources_step state provided by setup_phase\.bulk/);
      assert.strictEqual(bulk.passed, true, 'bulk substitute passes');
      assert.ok(!downstream.skipped, 'no cascade — bulk substitute rescued both targets');
    },
  },
  {
    axes: {
      skip_reason: 'missing_tool',
      peer_shape: 'peer_substitute_missing',
      phase_topology: 'downstream_phase',
    },
    title: 'mutual peer_substitutes_for declarations + both miss → cascade with substitution-chain detail',
    issue: 'adcp-client#1144',
    build: () => ({
      storyboard: storyboardWithPhases([
        {
          id: 'account_setup',
          title: 'account setup',
          steps: [
            step('sync', 'sync_accounts', { peer_substitutes_for: 'list' }),
            step('list', 'list_accounts', { peer_substitutes_for: 'sync' }),
          ],
        },
        { id: 'consume', title: 'consume', steps: [step('audience', '__test_assert')] },
      ]),
      advertised: ['__test_assert', 'get_adcp_capabilities'],
    }),
    assert: result => {
      const [syncStep, listStep] = result.phases[0].steps;
      const audienceStep = result.phases[1].steps[0];
      assert.strictEqual(syncStep.skip_reason, 'missing_tool');
      assert.strictEqual(listStep.skip_reason, 'missing_tool');
      assert.strictEqual(audienceStep.skipped, true, 'cascade fires when no peer rescued');
      assert.strictEqual(audienceStep.skip_reason, 'prerequisite_failed');
      // Detail names the originating step AND the declared substitute that didn't pass.
      assert.match(audienceStep.skip.detail ?? '', /prior stateful step "sync"/);
      assert.match(audienceStep.skip.detail ?? '', /missing_tool/);
      assert.match(audienceStep.skip.detail ?? '', /declared substitute "list" did not pass/);
    },
  },
  {
    axes: { skip_reason: 'missing_tool', peer_shape: 'peer_passes', phase_topology: 'same_phase' },
    title: 'missing_tool + passing peer with no declaration: same-phase consumer still cascades',
    issue: 'adcp-client#1589',
    build: () => ({
      storyboard: storyboardWith([
        step('peer', '__test_setup'),
        step('trigger', '__test_setup_missing'),
        step('consumer', '__test_assert'),
      ]),
      advertised: ['__test_setup', '__test_assert', 'get_adcp_capabilities'],
    }),
    assert: result => {
      const [peerStep, triggerStep, consumerStep] = result.phases[0].steps;
      assert.strictEqual(peerStep.passed, true, 'non-declared peer passed before trigger');
      assert.notStrictEqual(peerStep.skipped, true, 'peer was not cascade-skipped');
      assert.strictEqual(triggerStep.skipped, true);
      assert.strictEqual(triggerStep.skip_reason, 'missing_tool');
      assert.strictEqual(consumerStep.skipped, true, 'passing peer does not rescue without declaration');
      assert.strictEqual(consumerStep.skip_reason, 'prerequisite_failed');
      assert.match(consumerStep.skip.detail ?? '', /prior stateful step "trigger" skipped \(missing_tool\)/);
      assert.match(consumerStep.skip.detail ?? '', /state never materialized/);
    },
  },
  {
    axes: { skip_reason: 'missing_tool', peer_shape: 'peer_passes', phase_topology: 'downstream_phase' },
    title: 'missing_tool + passing peer with no declaration: downstream consumer still cascades',
    issue: 'adcp-client#1589',
    build: () => ({
      storyboard: storyboardWithPhases([
        {
          id: 'setup_phase',
          title: 'setup',
          steps: [step('peer', '__test_setup'), step('trigger', '__test_setup_missing')],
        },
        { id: 'consume', title: 'consume', steps: [step('consumer', '__test_assert')] },
      ]),
      advertised: ['__test_setup', '__test_assert', 'get_adcp_capabilities'],
    }),
    assert: result => {
      const [peerStep, triggerStep] = result.phases[0].steps;
      const consumerStep = result.phases[1].steps[0];
      assert.strictEqual(peerStep.passed, true, 'peer passed before missing-tool trigger');
      assert.strictEqual(triggerStep.skipped, true);
      assert.strictEqual(triggerStep.skip_reason, 'missing_tool');
      assert.strictEqual(consumerStep.skipped, true, 'cross-phase cascade fires');
      assert.strictEqual(consumerStep.skip_reason, 'prerequisite_failed');
      assert.match(consumerStep.skip.detail ?? '', /prior stateful step "trigger" skipped \(missing_tool\)/);
    },
  },
  {
    axes: { skip_reason: 'missing_tool', peer_shape: 'peer_fails', phase_topology: 'same_phase' },
    title: 'missing_tool after earlier peer failure: same-phase consumer keeps real-failure diagnostic',
    issue: 'adcp-client#1589',
    build: () => ({
      storyboard: storyboardWith([
        step('peer', '__test_fail'),
        step('trigger', '__test_setup_missing'),
        step('consumer', '__test_assert'),
      ]),
      advertised: ['__test_fail', '__test_assert', 'get_adcp_capabilities'],
    }),
    assert: result => {
      const [peerStep, triggerStep, consumerStep] = result.phases[0].steps;
      assert.strictEqual(peerStep.passed, false, 'peer failed for real');
      assert.notStrictEqual(peerStep.skipped, true, 'peer ran before missing-tool trigger');
      assert.strictEqual(triggerStep.skipped, true);
      assert.strictEqual(triggerStep.skip_reason, 'missing_tool');
      assert.strictEqual(consumerStep.skipped, true);
      assert.strictEqual(consumerStep.skip_reason, 'prerequisite_failed');
      assert.match(consumerStep.skip.detail ?? '', /prior stateful step failed/);
      assert.doesNotMatch(consumerStep.skip.detail ?? '', /missing_tool/, 'real failure wins the diagnostic');
    },
  },
  {
    axes: { skip_reason: 'missing_tool', peer_shape: 'sole_stateful', phase_topology: 'same_phase' },
    title: 'missing_tool with NO declared substitute → cascade fires immediately (existing behavior)',
    issue: 'adcp-client#1144',
    build: () => ({
      storyboard: storyboardWith([step('setup', '__test_setup'), step('assert', '__test_assert')]),
      advertised: ['__test_assert', 'get_adcp_capabilities'],
    }),
    assert: result => {
      const [setupStep, assertStep] = result.phases[0].steps;
      assert.strictEqual(setupStep.skip_reason, 'missing_tool');
      assert.strictEqual(assertStep.skipped, true);
      assert.strictEqual(assertStep.skip_reason, 'prerequisite_failed');
      // No declaration in play — detail must NOT mention substitution chain.
      assert.doesNotMatch(assertStep.skip.detail ?? '', /declared substitute/);
    },
  },
  {
    axes: { skip_reason: 'missing_tool', peer_shape: 'sole_stateful', phase_topology: 'same_phase' },
    title: 'non-stateful step does NOT cascade-skip when stateful setup skipped',
    issue: 'F6',
    build: () => ({
      storyboard: storyboardWith([
        step('setup', '__test_setup'),
        step('observe', '__test_assert', { stateful: false }),
      ]),
      advertised: ['__test_assert', 'get_adcp_capabilities'],
    }),
    assert: result => {
      const [setupStep, observeStep] = result.phases[0].steps;
      assert.strictEqual(setupStep.skipped, true);
      assert.strictEqual(setupStep.skip_reason, 'missing_tool');
      // observe runs because it's not stateful — cascade gates only stateful.
      assert.notStrictEqual(observeStep.skipped, true, 'non-stateful step runs despite stateful skip');
    },
  },
  {
    axes: { skip_reason: 'missing_tool', peer_shape: 'sole_stateful', phase_topology: 'downstream_phase' },
    title: 'depends_on: [] — independent phase runs even when prior phase tripped cascade',
    issue: 'adcp-client#1161',
    build: () => ({
      storyboard: storyboardWithPhases([
        { id: 'account_setup', title: 'account setup', steps: [step('sync', 'sync_accounts')] },
        {
          id: 'audience_sync',
          title: 'audience sync (independent)',
          depends_on: [],
          steps: [step('sync_aud', '__test_setup')],
        },
      ]),
      advertised: ['__test_setup', 'get_adcp_capabilities'],
    }),
    assert: result => {
      const syncStep = result.phases[0].steps[0];
      const audStep = result.phases[1].steps[0];
      assert.strictEqual(syncStep.skip_reason, 'missing_tool', 'phase 1 tripped');
      assert.notStrictEqual(audStep.skipped, true, 'phase 2 ran (depends_on: [] = independent)');
      assert.strictEqual(audStep.passed, true);
    },
  },
  {
    axes: { skip_reason: 'missing_tool', peer_shape: 'sole_stateful', phase_topology: 'downstream_phase' },
    title: 'depends_on: ["specific_phase"] — cascades only when that phase tripped',
    issue: 'adcp-client#1161',
    build: () => ({
      storyboard: storyboardWithPhases([
        { id: 'account_setup', title: 'account setup', steps: [step('sync', '__test_setup')] },
        { id: 'audience_sync', title: 'audience sync', steps: [step('aud', 'sync_audiences')] },
        {
          id: 'creative_push',
          title: 'creative push',
          depends_on: ['account_setup'],
          steps: [step('cre', '__test_assert')],
        },
      ]),
      advertised: ['__test_setup', '__test_assert', 'get_adcp_capabilities'],
    }),
    assert: result => {
      const phase1 = result.phases[0].steps[0];
      const phase2 = result.phases[1].steps[0];
      const phase3 = result.phases[2].steps[0];
      assert.strictEqual(phase1.passed, true, 'account_setup passes');
      assert.strictEqual(phase2.skip_reason, 'missing_tool', 'audience_sync tripped');
      assert.notStrictEqual(phase3.skipped, true, 'creative_push runs (deps on account_setup which passed)');
      assert.strictEqual(phase3.passed, true);
    },
  },
  {
    axes: { skip_reason: 'missing_tool', peer_shape: 'peer_fails', phase_topology: 'downstream_phase' },
    title: 'depends_on default (undefined) preserves all-prior-phases cascade — F6 round-2 still works',
    issue: 'adcp-client#1161',
    build: () => ({
      storyboard: storyboardWithPhases([
        {
          id: 'phase_1_trip',
          title: 'phase 1 (trips)',
          steps: [step('setup', 'sync_governance'), step('setup_peer', 'sync_governance_peer')],
        },
        { id: 'phase_2', title: 'phase 2', steps: [step('consume', '__test_assert')] },
      ]),
      advertised: ['__test_assert', 'get_adcp_capabilities'],
    }),
    assert: result => {
      const phase2 = result.phases[1].steps[0];
      assert.strictEqual(phase2.skipped, true, 'default depends_on = all prior, cascade fires');
      assert.strictEqual(phase2.skip_reason, 'prerequisite_failed');
    },
  },
  {
    axes: { skip_reason: 'missing_tool', peer_shape: 'sole_stateful', phase_topology: 'downstream_phase' },
    title: 'three-phase transitive: A trips, B independent, C depends_on:[B] runs',
    issue: 'adcp-client#1161',
    build: () => ({
      storyboard: storyboardWithPhases([
        { id: 'A', title: 'A', steps: [step('a', 'sync_accounts')] },
        { id: 'B', title: 'B', depends_on: [], steps: [step('b', '__test_setup')] },
        { id: 'C', title: 'C', depends_on: ['B'], steps: [step('c', '__test_assert')] },
      ]),
      advertised: ['__test_setup', '__test_assert', 'get_adcp_capabilities'],
    }),
    assert: result => {
      const a = result.phases[0].steps[0];
      const b = result.phases[1].steps[0];
      const c = result.phases[2].steps[0];
      assert.strictEqual(a.skip_reason, 'missing_tool', 'A tripped');
      assert.strictEqual(b.passed, true, 'B ran cleanly (independent)');
      assert.strictEqual(c.passed, true, 'C ran cleanly (its dep B passed; A irrelevant)');
    },
  },
  {
    axes: {
      skip_reason: 'missing_tool',
      peer_shape: 'peer_substitute_declared',
      phase_topology: 'downstream_phase',
    },
    title: 'peer_substitutes_for × depends_on compose: substitute rescues within-phase',
    issue: 'adcp-client#1144 + #1161',
    build: () => ({
      storyboard: storyboardWithPhases([
        { id: 'upstream_dep', title: 'upstream', steps: [step('up', '__test_setup')] },
        {
          id: 'account_setup',
          title: 'account setup',
          depends_on: ['upstream_dep'],
          steps: [step('sync', 'sync_accounts'), step('list', '__test_setup', { peer_substitutes_for: 'sync' })],
        },
      ]),
      advertised: ['__test_setup', 'get_adcp_capabilities'],
    }),
    assert: result => {
      const up = result.phases[0].steps[0];
      const [syncStep, listStep] = result.phases[1].steps;
      assert.strictEqual(up.passed, true, 'upstream passed');
      assert.strictEqual(syncStep.skip_reason, 'peer_substituted', 'sync re-graded after rescue');
      assert.match(syncStep.skip.detail ?? '', /sync state provided by account_setup\.list/);
      assert.strictEqual(listStep.passed, true, 'list (substitute) passed — phase 2 not cascade-tripped');
    },
  },
  {
    axes: { skip_reason: 'missing_tool', peer_shape: 'sole_stateful', phase_topology: 'same_phase' },
    title: 'within-phase cascade still fires regardless of depends_on',
    issue: 'adcp-client#1161',
    build: () => ({
      storyboard: storyboardWithPhases([
        {
          id: 'lonely',
          title: 'single independent phase with intra-phase cascade',
          depends_on: [],
          steps: [step('setup', 'sync_accounts'), step('consume', '__test_assert')],
        },
      ]),
      advertised: ['__test_assert', 'get_adcp_capabilities'],
    }),
    assert: result => {
      const [setupStep, consumeStep] = result.phases[0].steps;
      assert.strictEqual(setupStep.skip_reason, 'missing_tool');
      // depends_on is INTER-phase. Intra-phase cascade still fires.
      assert.strictEqual(consumeStep.skipped, true, 'within-phase cascade fires');
      assert.strictEqual(consumeStep.skip_reason, 'prerequisite_failed');
    },
  },

  // -------------------------------------------------------------------
  // not_applicable
  // -------------------------------------------------------------------
  {
    axes: { skip_reason: 'not_applicable', peer_shape: 'sole_stateful', phase_topology: 'downstream_phase' },
    title: 'sole stateful step not_applicable → no cascade (platform has no peer-substitute)',
    issue: 'adcp-client#1144 / #1146',
    build: () => ({
      storyboard: storyboardWithPhases([
        { id: 'account_setup', title: 'account setup', steps: [step('sync', 'sync_accounts')] },
        { id: 'consume', title: 'consume', steps: [step('assert', '__test_assert')] },
      ]),
      advertised: ['sync_accounts', '__test_assert', 'get_adcp_capabilities'],
      profileExtras: { raw_capabilities: { account: { require_operator_auth: true } } },
    }),
    assert: result => {
      const syncStep = result.phases[0].steps[0];
      const assertStep = result.phases[1].steps[0];
      assert.strictEqual(syncStep.skipped, true);
      assert.strictEqual(syncStep.skip_reason, 'not_applicable');
      assert.ok(!assertStep.skipped, 'downstream step runs — no cascade for sole not_applicable');
      assert.strictEqual(assertStep.passed, true);
    },
  },
  {
    axes: { skip_reason: 'not_applicable', peer_shape: 'peer_fails', phase_topology: 'downstream_phase' },
    title: 'not_applicable + peer stateful step fails hard → cascade fires',
    issue: 'adcp-client#1144',
    build: () => ({
      storyboard: storyboardWithPhases([
        {
          id: 'account_setup',
          title: 'account setup',
          steps: [step('sync', 'sync_accounts'), step('peer', '__test_fail')],
        },
        { id: 'consume', title: 'consume', steps: [step('assert', '__test_assert')] },
      ]),
      advertised: ['sync_accounts', '__test_fail', '__test_assert', 'get_adcp_capabilities'],
      profileExtras: { raw_capabilities: { account: { require_operator_auth: true } } },
    }),
    assert: result => {
      const syncStep = result.phases[0].steps[0];
      const peerStep = result.phases[0].steps[1];
      const assertStep = result.phases[1].steps[0];
      assert.strictEqual(syncStep.skipped, true);
      assert.strictEqual(syncStep.skip_reason, 'not_applicable');
      assert.ok(!peerStep.skipped, 'peer step ran (not cascade-skipped)');
      assert.ok(!peerStep.passed, 'peer step failed');
      assert.strictEqual(assertStep.skipped, true, 'cascade fires when peers existed but none established state');
      assert.strictEqual(assertStep.skip_reason, 'prerequisite_failed');
    },
  },
  {
    axes: { skip_reason: 'not_applicable', peer_shape: 'peer_passes', phase_topology: 'downstream_phase' },
    title: 'not_applicable + stateful peer passes in same phase → no cascade (substitute established state)',
    issue: 'adcp-client#1005 round-9',
    build: () => ({
      storyboard: storyboardWithPhases([
        {
          id: 'account_setup',
          title: 'account setup',
          steps: [step('sync', 'sync_accounts'), step('list', '__test_setup')],
        },
        { id: 'consume', title: 'consume', steps: [step('audience', '__test_assert')] },
      ]),
      advertised: ['sync_accounts', '__test_setup', '__test_assert', 'get_adcp_capabilities'],
      profileExtras: { raw_capabilities: { account: { require_operator_auth: true } } },
    }),
    assert: result => {
      const [syncStep, listStep] = result.phases[0].steps;
      const audienceStep = result.phases[1].steps[0];
      assert.strictEqual(syncStep.skipped, true, 'sync_accounts skipped not_applicable');
      assert.strictEqual(syncStep.skip_reason, 'not_applicable');
      assert.notStrictEqual(listStep.skipped, true, 'list_accounts substitute runs (not cascade-skipped)');
      assert.strictEqual(listStep.passed, true, 'list_accounts substitute passes');
      assert.notStrictEqual(
        audienceStep.skipped,
        true,
        'cross-phase stateful step runs (substitute established state)'
      );
    },
  },
  {
    axes: { skip_reason: 'not_applicable', peer_shape: 'peer_passes', phase_topology: 'downstream_phase' },
    title: 'not_applicable: peer passes BEFORE the not_applicable skip → no cascade (order-independent)',
    issue: 'adcp-client#1005 round-9',
    build: () => ({
      storyboard: storyboardWithPhases([
        {
          id: 'account_setup',
          title: 'account setup',
          steps: [step('list', '__test_setup'), step('sync', 'sync_accounts')],
        },
        { id: 'consume', title: 'consume', steps: [step('audience', '__test_assert')] },
      ]),
      advertised: ['sync_accounts', '__test_setup', '__test_assert', 'get_adcp_capabilities'],
      profileExtras: { raw_capabilities: { account: { require_operator_auth: true } } },
    }),
    assert: result => {
      const [listStep, syncStep] = result.phases[0].steps;
      const audienceStep = result.phases[1].steps[0];
      assert.strictEqual(listStep.passed, true);
      assert.strictEqual(syncStep.skipped, true);
      assert.strictEqual(syncStep.skip_reason, 'not_applicable');
      assert.ok(!audienceStep.skipped, 'no cascade — peer passed earlier in phase');
    },
  },
  {
    axes: { skip_reason: 'not_applicable', peer_shape: 'sole_stateful', phase_topology: 'downstream_phase' },
    title: 'not_applicable + non-stateful peer: downstream runs (sole-stateful-step rule)',
    issue: 'adcp-client#1144',
    build: () => ({
      storyboard: storyboardWithPhases([
        {
          id: 'account_setup',
          title: 'account setup',
          steps: [step('sync', 'sync_accounts'), step('observe', '__test_assert', { stateful: false })],
        },
        { id: 'consume', title: 'consume', steps: [step('audience', '__test_assert')] },
      ]),
      advertised: ['sync_accounts', '__test_assert', 'get_adcp_capabilities'],
      profileExtras: { raw_capabilities: { account: { require_operator_auth: true } } },
    }),
    assert: result => {
      const [syncStep, observeStep] = result.phases[0].steps;
      const audienceStep = result.phases[1].steps[0];
      assert.strictEqual(syncStep.skipped, true);
      assert.strictEqual(syncStep.skip_reason, 'not_applicable');
      assert.ok(!observeStep.skipped, 'non-stateful peer runs');
      assert.strictEqual(observeStep.passed, true);
      // Sole stateful step rule applies regardless of non-stateful peers.
      assert.ok(!audienceStep.skipped, 'no cascade — sole stateful step returned not_applicable');
      assert.strictEqual(audienceStep.passed, true);
    },
  },
  {
    axes: { skip_reason: 'not_applicable', peer_shape: 'peer_fails', phase_topology: 'downstream_phase' },
    title: 'not_applicable + later real failure in same phase: real failure wins the diagnostic',
    issue: 'F6',
    build: () => ({
      storyboard: storyboardWithPhases([
        {
          id: 'account_setup',
          title: 'account setup',
          steps: [step('sync', 'sync_accounts'), step('broken', '__test_fail')],
        },
        { id: 'consume', title: 'consume', steps: [step('audience', '__test_assert')] },
      ]),
      advertised: ['sync_accounts', '__test_fail', '__test_assert', 'get_adcp_capabilities'],
      profileExtras: { raw_capabilities: { account: { require_operator_auth: true } } },
    }),
    assert: result => {
      const [syncStep, brokenStep] = result.phases[0].steps;
      const audienceStep = result.phases[1].steps[0];
      assert.strictEqual(syncStep.skip_reason, 'not_applicable');
      assert.strictEqual(brokenStep.passed, false, 'broken peer failed for real');
      assert.ok(!brokenStep.skipped, 'broken peer ran (did not skip)');
      assert.strictEqual(audienceStep.skipped, true);
      assert.strictEqual(audienceStep.skip_reason, 'prerequisite_failed');
      // Real failure wins the diagnostic — must NOT reference the not_applicable skip.
      assert.match(audienceStep.skip.detail ?? '', /prior stateful step failed/);
      assert.doesNotMatch(
        audienceStep.skip.detail ?? '',
        /not_applicable/,
        'detail must reference the real failure, not the earlier not_applicable trigger'
      );
    },
  },
  {
    axes: {
      skip_reason: 'not_applicable',
      peer_shape: 'peer_substitute_declared',
      phase_topology: 'same_phase',
    },
    title: 'not_applicable + declared substitute that passes: same-phase consumer runs',
    issue: 'adcp-client#1589',
    build: () => ({
      storyboard: storyboardWith([
        step('sync', 'sync_accounts'),
        step('list', '__test_setup', { provides_state_for: 'sync' }),
        step('consumer', '__test_assert'),
      ]),
      advertised: ['sync_accounts', '__test_setup', '__test_assert', 'get_adcp_capabilities'],
      profileExtras: { raw_capabilities: { account: { require_operator_auth: true } } },
    }),
    assert: result => {
      const [syncStep, listStep, consumerStep] = result.phases[0].steps;
      assert.strictEqual(syncStep.skipped, true);
      assert.strictEqual(syncStep.skip_reason, 'not_applicable');
      assert.doesNotMatch(syncStep.skip.detail ?? '', /peer_substituted/);
      assert.strictEqual(listStep.passed, true, 'declared substitute passed');
      assert.ok(!consumerStep.skipped, 'same-phase consumer runs after stateful peer pass');
      assert.strictEqual(consumerStep.passed, true);
    },
  },
  {
    axes: {
      skip_reason: 'not_applicable',
      peer_shape: 'peer_substitute_declared',
      phase_topology: 'downstream_phase',
    },
    title: 'not_applicable + declared substitute that passes: downstream consumer runs',
    issue: 'adcp-client#1589',
    build: () => ({
      storyboard: storyboardWithPhases([
        {
          id: 'account_setup',
          title: 'account setup',
          steps: [step('sync', 'sync_accounts'), step('list', '__test_setup', { provides_state_for: 'sync' })],
        },
        { id: 'consume', title: 'consume', steps: [step('consumer', '__test_assert')] },
      ]),
      advertised: ['sync_accounts', '__test_setup', '__test_assert', 'get_adcp_capabilities'],
      profileExtras: { raw_capabilities: { account: { require_operator_auth: true } } },
    }),
    assert: result => {
      const [syncStep, listStep] = result.phases[0].steps;
      const consumerStep = result.phases[1].steps[0];
      assert.strictEqual(syncStep.skipped, true);
      assert.strictEqual(syncStep.skip_reason, 'not_applicable');
      assert.strictEqual(listStep.passed, true, 'declared substitute passed');
      assert.ok(!consumerStep.skipped, 'downstream runs because a stateful peer established state');
      assert.strictEqual(consumerStep.passed, true);
    },
  },
  {
    axes: {
      skip_reason: 'not_applicable',
      peer_shape: 'peer_substitute_missing',
      phase_topology: 'downstream_phase',
    },
    title: 'not_applicable + mutual substitute declarations both skip: downstream consumer cascades',
    issue: 'adcp-client#1589',
    build: () => ({
      storyboard: storyboardWithPhases([
        {
          id: 'account_setup',
          title: 'account setup',
          steps: [
            step('sync_a', 'sync_accounts', { provides_state_for: 'sync_b' }),
            step('sync_b', 'sync_accounts', { provides_state_for: 'sync_a' }),
          ],
        },
        { id: 'consume', title: 'consume', steps: [step('consumer', '__test_assert')] },
      ]),
      advertised: ['sync_accounts', '__test_assert', 'get_adcp_capabilities'],
      profileExtras: { raw_capabilities: { account: { require_operator_auth: true } } },
    }),
    assert: result => {
      const [syncA, syncB] = result.phases[0].steps;
      const consumerStep = result.phases[1].steps[0];
      assert.strictEqual(syncA.skip_reason, 'not_applicable');
      assert.strictEqual(syncB.skip_reason, 'not_applicable');
      assert.strictEqual(consumerStep.skipped, true, 'phase-end not_applicable promotion cascades downstream');
      assert.strictEqual(consumerStep.skip_reason, 'prerequisite_failed');
      assert.match(consumerStep.skip.detail ?? '', /prior stateful step "sync_a" skipped \(not_applicable\)/);
      assert.doesNotMatch(
        consumerStep.skip.detail ?? '',
        /declared substitute/,
        'not_applicable uses any-peer phase-end logic, not hard-missing substitution-chain detail'
      );
    },
  },
  {
    axes: { skip_reason: 'not_applicable', peer_shape: 'peer_passes', phase_topology: 'same_phase' },
    title: 'not_applicable + passing peer with no declaration: same-phase consumer runs',
    issue: 'adcp-client#1589',
    build: () => ({
      storyboard: storyboardWith([
        step('sync', 'sync_accounts'),
        step('peer', '__test_setup'),
        step('consumer', '__test_assert'),
      ]),
      advertised: ['sync_accounts', '__test_setup', '__test_assert', 'get_adcp_capabilities'],
      profileExtras: { raw_capabilities: { account: { require_operator_auth: true } } },
    }),
    assert: result => {
      const [syncStep, peerStep, consumerStep] = result.phases[0].steps;
      assert.strictEqual(syncStep.skipped, true);
      assert.strictEqual(syncStep.skip_reason, 'not_applicable');
      assert.strictEqual(peerStep.passed, true, 'stateful peer passed');
      assert.ok(!consumerStep.skipped, 'same-phase consumer runs after stateful peer pass');
      assert.strictEqual(consumerStep.passed, true);
    },
  },
  {
    axes: { skip_reason: 'not_applicable', peer_shape: 'peer_fails', phase_topology: 'same_phase' },
    title: 'not_applicable + peer failure: same-phase consumer keeps real-failure diagnostic',
    issue: 'adcp-client#1589',
    build: () => ({
      storyboard: storyboardWith([
        step('sync', 'sync_accounts'),
        step('peer', '__test_fail'),
        step('consumer', '__test_assert'),
      ]),
      advertised: ['sync_accounts', '__test_fail', '__test_assert', 'get_adcp_capabilities'],
      profileExtras: { raw_capabilities: { account: { require_operator_auth: true } } },
    }),
    assert: result => {
      const [syncStep, peerStep, consumerStep] = result.phases[0].steps;
      assert.strictEqual(syncStep.skipped, true);
      assert.strictEqual(syncStep.skip_reason, 'not_applicable');
      assert.strictEqual(peerStep.passed, false, 'peer failed for real');
      assert.notStrictEqual(peerStep.skipped, true, 'peer ran despite deferred not_applicable trigger');
      assert.strictEqual(consumerStep.skipped, true);
      assert.strictEqual(consumerStep.skip_reason, 'prerequisite_failed');
      assert.match(consumerStep.skip.detail ?? '', /prior stateful step failed/);
      assert.doesNotMatch(
        consumerStep.skip.detail ?? '',
        /not_applicable/,
        'real failure wins over earlier deferred not_applicable'
      );
    },
  },

  // -------------------------------------------------------------------
  // real_failure
  // -------------------------------------------------------------------
  {
    axes: { skip_reason: 'real_failure', peer_shape: 'sole_stateful', phase_topology: 'same_phase' },
    title: 'real failure cascade-detail says "failed" (not "skipped")',
    issue: 'F6',
    build: () => ({
      storyboard: storyboardWith([
        step('setup', '__test_fail', {
          validations: [{ check: 'response_field', path: '$.never_present', expected: true }],
        }),
        step('assert', '__test_assert'),
      ]),
      advertised: ['__test_fail', '__test_assert', 'get_adcp_capabilities'],
    }),
    assert: result => {
      const [setupStep, assertStep] = result.phases[0].steps;
      assert.strictEqual(setupStep.passed, false, 'setup actually failed');
      assert.notStrictEqual(setupStep.skipped, true, 'setup ran and failed (did not skip)');
      assert.strictEqual(assertStep.skipped, true, 'cascade still fires');
      assert.strictEqual(assertStep.skip_reason, 'prerequisite_failed');
      assert.match(assertStep.skip.detail ?? '', /prior stateful step failed/);
      assert.doesNotMatch(assertStep.skip.detail ?? '', /skipped \(/, 'detail must NOT call a real failure a skip');
    },
  },
  {
    axes: { skip_reason: 'real_failure', peer_shape: 'sole_stateful', phase_topology: 'downstream_phase' },
    title: 'cascade-skipped step with un-advertised task gets missing_tool (capability-aware)',
    issue: 'adcp-client#1169',
    build: () => ({
      storyboard: storyboardWithPhases([
        { id: 'setup', title: 'setup', steps: [step('setup', '__test_fail')] },
        { id: 'creative_push', title: 'creative push', steps: [step('sync_creatives', 'sync_creatives')] },
      ]),
      advertised: ['__test_fail', 'get_adcp_capabilities'],
    }),
    assert: result => {
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
    },
  },
  {
    axes: { skip_reason: 'real_failure', peer_shape: 'sole_stateful', phase_topology: 'downstream_phase' },
    title: 'cascade-skipped step with advertised task still gets prerequisite_failed',
    issue: 'adcp-client#1169',
    build: () => ({
      storyboard: storyboardWithPhases([
        { id: 'setup', title: 'setup', steps: [step('setup', '__test_fail')] },
        { id: 'consume', title: 'consume', steps: [step('assert', '__test_assert')] },
      ]),
      advertised: ['__test_fail', '__test_assert', 'get_adcp_capabilities'],
    }),
    assert: result => {
      const setupStep = result.phases[0].steps[0];
      const assertStep = result.phases[1].steps[0];
      assert.ok(!setupStep.passed, 'setup failed');
      assert.strictEqual(assertStep.skipped, true, 'assert cascade-skipped');
      assert.strictEqual(
        assertStep.skip_reason,
        'prerequisite_failed',
        'advertised task still gets prerequisite_failed'
      );
      assert.strictEqual(assertStep.passed, false, 'prerequisite_failed is a failing skip');
    },
  },
  {
    axes: { skip_reason: 'real_failure', peer_shape: 'sole_stateful', phase_topology: 'downstream_phase' },
    title: '$test_kit.* step: resolved task checked against agentTools, not template string',
    issue: 'adcp-client#1169',
    build: () => ({
      storyboard: storyboardWithPhases([
        { id: 'setup', title: 'setup', steps: [step('setup', '__test_fail')] },
        {
          id: 'consume',
          title: 'consume (test-kit)',
          steps: [step('testkit_step', '$test_kit.nonexistent.path', { task_default: '__test_assert' })],
        },
      ]),
      advertised: ['__test_fail', '__test_assert', 'get_adcp_capabilities'],
    }),
    assert: result => {
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
    },
  },
  {
    axes: { skip_reason: 'real_failure', peer_shape: 'peer_passes', phase_topology: 'same_phase' },
    title:
      'real failure with passing peer earlier in same phase: cascade still fires (no rescue without peer_substitutes_for)',
    issue: 'adcp-client#1589',
    build: () => ({
      // Peer runs first and passes; trigger then fails. Without
      // peer_substitutes_for, a passing peer does not rescue a real
      // failure — cascade still fires for the same-phase consumer.
      storyboard: storyboardWith([
        step('peer', '__test_setup'),
        step('setup', '__test_fail'),
        step('assert', '__test_assert'),
      ]),
      advertised: ['__test_fail', '__test_setup', '__test_assert', 'get_adcp_capabilities'],
    }),
    assert: result => {
      const [peerStep, setupStep, assertStep] = result.phases[0].steps;
      assert.strictEqual(peerStep.passed, true, 'peer ran and passed');
      assert.notStrictEqual(peerStep.skipped, true, 'peer not skipped');
      assert.strictEqual(setupStep.passed, false, 'setup actually failed');
      assert.notStrictEqual(setupStep.skipped, true, 'setup ran and failed');
      assert.strictEqual(assertStep.skipped, true, 'consumer cascade-skipped');
      assert.strictEqual(assertStep.skip_reason, 'prerequisite_failed');
      assert.match(assertStep.skip.detail ?? '', /prior stateful step failed/);
    },
  },
  {
    axes: { skip_reason: 'real_failure', peer_shape: 'peer_passes', phase_topology: 'downstream_phase' },
    title: 'real failure with passing peer in setup phase: downstream phase still cascades',
    issue: 'adcp-client#1589',
    build: () => ({
      storyboard: storyboardWithPhases([
        {
          id: 'setup_phase',
          title: 'setup',
          steps: [step('peer', '__test_setup'), step('setup', '__test_fail')],
        },
        { id: 'consume', title: 'consume', steps: [step('assert', '__test_assert')] },
      ]),
      advertised: ['__test_fail', '__test_setup', '__test_assert', 'get_adcp_capabilities'],
    }),
    assert: result => {
      const [peerStep, setupStep] = result.phases[0].steps;
      const assertStep = result.phases[1].steps[0];
      assert.strictEqual(peerStep.passed, true, 'peer passed');
      assert.strictEqual(setupStep.passed, false, 'setup actually failed');
      assert.strictEqual(assertStep.skipped, true, 'downstream cascade fires');
      assert.strictEqual(assertStep.skip_reason, 'prerequisite_failed');
      assert.match(assertStep.skip.detail ?? '', /prior stateful step failed/);
    },
  },
  {
    axes: { skip_reason: 'real_failure', peer_shape: 'peer_fails', phase_topology: 'same_phase' },
    title: 'real failure earlier in same phase + later peer also fails: consumer cascade-skips with failure detail',
    issue: 'adcp-client#1589',
    build: () => ({
      // Two real failures in one phase: the second is itself
      // cascade-skipped (within-phase cascade kicks in on the first
      // failure), and the consumer downstream of both gets the same
      // "prior stateful step failed" detail.
      storyboard: storyboardWith([
        step('setup', '__test_fail'),
        step('peer', '__test_fail'),
        step('assert', '__test_assert'),
      ]),
      advertised: ['__test_fail', '__test_assert', 'get_adcp_capabilities'],
    }),
    assert: result => {
      const [setupStep, peerStep, assertStep] = result.phases[0].steps;
      assert.strictEqual(setupStep.passed, false, 'setup failed');
      assert.notStrictEqual(setupStep.skipped, true, 'setup ran');
      // peer is cascade-skipped because the first real failure already
      // tripped the within-phase cascade — runner does not run further
      // stateful steps in the phase.
      assert.strictEqual(peerStep.skipped, true, 'peer cascade-skipped after first failure');
      assert.strictEqual(peerStep.skip_reason, 'prerequisite_failed');
      assert.strictEqual(assertStep.skipped, true, 'consumer cascade-skipped');
      assert.strictEqual(assertStep.skip_reason, 'prerequisite_failed');
      assert.match(assertStep.skip.detail ?? '', /prior stateful step failed/);
      assert.doesNotMatch(assertStep.skip.detail ?? '', /skipped \(/, 'detail must NOT call a real failure a skip');
    },
  },
  {
    axes: { skip_reason: 'real_failure', peer_shape: 'peer_fails', phase_topology: 'downstream_phase' },
    title: 'real failure in setup phase + peer also a real failure: downstream phase cascades with failure detail',
    issue: 'adcp-client#1589',
    build: () => ({
      storyboard: storyboardWithPhases([
        {
          id: 'setup_phase',
          title: 'setup',
          steps: [step('setup', '__test_fail'), step('peer', '__test_fail')],
        },
        { id: 'consume', title: 'consume', steps: [step('assert', '__test_assert')] },
      ]),
      advertised: ['__test_fail', '__test_assert', 'get_adcp_capabilities'],
    }),
    assert: result => {
      const [setupStep, peerStep] = result.phases[0].steps;
      const assertStep = result.phases[1].steps[0];
      assert.strictEqual(setupStep.passed, false, 'setup failed');
      // peer is cascade-skipped within the same phase after the first failure.
      assert.strictEqual(peerStep.skipped, true, 'peer cascade-skipped after setup failure');
      assert.strictEqual(assertStep.skipped, true, 'downstream cascade fires');
      assert.strictEqual(assertStep.skip_reason, 'prerequisite_failed');
      assert.match(assertStep.skip.detail ?? '', /prior stateful step failed/);
      assert.doesNotMatch(assertStep.skip.detail ?? '', /skipped \(/, 'detail must NOT call a real failure a skip');
    },
  },
];

// ---------------------------------------------------------------------
// "No cascade" controls — successful runs assert the negative.
// Excluded from the matrix because no skip occurs (skip_reason = none).
// ---------------------------------------------------------------------

const CONTROL_ROWS = [
  {
    title: 'stateful step that runs successfully does NOT trigger cascade-skip',
    issue: 'F6',
    build: () => ({
      storyboard: storyboardWith([step('setup', '__test_setup'), step('assert', '__test_assert')]),
      advertised: ['__test_setup', '__test_assert', 'get_adcp_capabilities'],
    }),
    assert: result => {
      const [setupStep, assertStep] = result.phases[0].steps;
      assert.notStrictEqual(setupStep.skipped, true, 'setup ran');
      assert.notStrictEqual(assertStep.skipped, true, 'assertion ran (no cascade)');
    },
  },
];

// ---------------------------------------------------------------------
// Parse-time validation rows — these reject malformed storyboards before
// any cascade evaluation. They live outside the cascade matrix because
// they assert authoring-time errors, not runtime cascade behavior.
// ---------------------------------------------------------------------

const VALIDATION_ROWS = [
  {
    title: 'peer_substitutes_for: self-reference rejected at parse time',
    storyboard: storyboardWith([step('self', '__test_setup', { peer_substitutes_for: 'self' })]),
    advertised: ['__test_setup', 'get_adcp_capabilities'],
    rejects: /peer_substitutes_for cannot reference itself/,
  },
  {
    title: 'peer_substitutes_for: empty-string entry in array rejected at parse time',
    storyboard: storyboardWith([
      step('target', '__test_setup'),
      step('sub', '__test_assert', { peer_substitutes_for: ['target', ''] }),
    ]),
    advertised: ['__test_setup', '__test_assert', 'get_adcp_capabilities'],
    rejects: /peer_substitutes_for entries must be non-empty strings/,
  },
  {
    title: 'peer_substitutes_for: target step must be stateful',
    storyboard: storyboardWith([
      step('target_nonstateful', '__test_setup', { stateful: false }),
      step('sub', '__test_assert', { peer_substitutes_for: 'target_nonstateful' }),
    ]),
    advertised: ['__test_setup', '__test_assert', 'get_adcp_capabilities'],
    rejects: /peer_substitutes_for target 'target_nonstateful' must be stateful/,
  },
  {
    title: 'peer_substitutes_for: substitute step must itself be stateful',
    storyboard: storyboardWith([
      step('target', '__test_setup'),
      step('sub_nonstateful', '__test_assert', {
        stateful: false,
        peer_substitutes_for: 'target',
      }),
    ]),
    advertised: ['__test_setup', '__test_assert', 'get_adcp_capabilities'],
    rejects: /peer_substitutes_for is only legal on stateful steps/,
  },
  {
    title: 'peer_substitutes_for is same-phase only — cross-phase reference rejected',
    storyboard: storyboardWithPhases([
      { id: 'phase_one', title: 'phase 1', steps: [step('sync', 'sync_accounts')] },
      {
        id: 'phase_two',
        title: 'phase 2',
        steps: [step('list', '__test_setup', { peer_substitutes_for: 'sync' })],
      },
    ]),
    advertised: ['__test_setup', 'get_adcp_capabilities'],
    rejects: /peer_substitutes_for target 'sync' is not a step in this phase/,
  },
  {
    title: 'depends_on rejects forward references at parse time',
    storyboard: storyboardWithPhases([
      { id: 'first', title: 'first', depends_on: ['later'], steps: [step('a', '__test_setup')] },
      { id: 'later', title: 'later', steps: [step('b', '__test_setup')] },
    ]),
    advertised: ['__test_setup', 'get_adcp_capabilities'],
    rejects: /depends_on 'later' is not a phase declared earlier/,
  },
  {
    title: 'depends_on rejects self-reference at parse time',
    storyboard: storyboardWithPhases([
      {
        id: 'self_ref',
        title: 'self',
        depends_on: ['self_ref'],
        steps: [step('a', '__test_setup')],
      },
    ]),
    advertised: ['__test_setup', 'get_adcp_capabilities'],
    rejects: /depends_on cannot reference itself/,
  },
  {
    title: 'depends_on rejects unknown phase ids at parse time',
    storyboard: storyboardWithPhases([
      { id: 'first', title: 'first', steps: [step('a', '__test_setup')] },
      {
        id: 'second',
        title: 'second',
        depends_on: ['nonexistent_phase'],
        steps: [step('b', '__test_setup')],
      },
    ]),
    advertised: ['__test_setup', 'get_adcp_capabilities'],
    rejects: /depends_on 'nonexistent_phase' is not a phase declared earlier/,
  },
  {
    title: 'depends_on: <non-array> rejected at parse time (string instead of array)',
    storyboard: storyboardWithPhases([
      { id: 'first', title: 'first', steps: [step('a', '__test_setup')] },
      { id: 'second', title: 'second', depends_on: 'first', steps: [step('b', '__test_setup')] },
    ]),
    advertised: ['__test_setup', 'get_adcp_capabilities'],
    rejects: /depends_on must be an array of phase ids/,
  },
];

// ---------------------------------------------------------------------
// Matrix coverage map — every (skip_reason × peer_shape × phase_topology)
// combination is either covered by ≥1 row, structurally impossible, or
// tracked in a follow-up issue. Adding new rows automatically updates the
// covered set; adding new axis values requires updating IMPOSSIBLE_CELLS
// or TRACKED_GAPS. The assertion at the bottom of this file fails if any
// cell becomes uncovered — so empty cells stay structurally visible.
// ---------------------------------------------------------------------

/**
 * Cells the cube can't represent.
 *
 * `real_failure × peer_substitute_*` is impossible: a step that ran and
 * failed cannot be the subject of a `peer_substitutes_for` declaration
 * because the rescue path is keyed on hard-missing skip reasons. A real
 * failure trips `statefulFailed` directly and the substitute lookup is
 * never consulted.
 *
 * Note: `peer_substitute_*` is a peer_shape and `sole_stateful` is also
 * a peer_shape — they are mutually exclusive values on the same axis,
 * so cells like `*|peer_substitute_declared|sole_stateful` aren't cube
 * cells at all. They don't appear here.
 */
const IMPOSSIBLE_CELLS = new Set([
  'real_failure|peer_substitute_declared|same_phase',
  'real_failure|peer_substitute_declared|downstream_phase',
  'real_failure|peer_substitute_missing|same_phase',
  'real_failure|peer_substitute_missing|downstream_phase',
]);

/**
 * Cells that are reachable in principle but not yet covered by a row.
 * Each entry must reference a tracking issue so reviewers can follow the
 * coverage gap to a concrete plan. New issues here = new rows to author;
 * leaving cells uncovered without a tracking issue fails the assertion
 * at the bottom of this file.
 */
const TRACKED_GAPS = new Map([
  // missing_test_controller: triggered behind the controller-seeding
  // probe, which has a different surface (phase-level vs per-step). The
  // exemption logic is shared — regression coverage lives in
  // test/lib/storyboard-controller-seeding.test.js. Cells are tracked
  // there rather than mirrored here. If that suite is removed before
  // mirroring, file a follow-up issue and reference it here.
  ['missing_test_controller|sole_stateful|same_phase', 'tracked_in_storyboard-controller-seeding.test.js'],
  ['missing_test_controller|sole_stateful|downstream_phase', 'tracked_in_storyboard-controller-seeding.test.js'],
  ['missing_test_controller|peer_passes|same_phase', 'tracked_in_storyboard-controller-seeding.test.js'],
  ['missing_test_controller|peer_passes|downstream_phase', 'tracked_in_storyboard-controller-seeding.test.js'],
  ['missing_test_controller|peer_fails|same_phase', 'tracked_in_storyboard-controller-seeding.test.js'],
  ['missing_test_controller|peer_fails|downstream_phase', 'tracked_in_storyboard-controller-seeding.test.js'],

  // missing_tool peer_substitute_missing × same_phase is reachable today,
  // but the observed behavior ("same-phase consumer runs before phase-end
  // promotion") pins runner loop timing rather than a settled cascade
  // contract. Keep tracked until same-phase deferred-substitution semantics
  // are explicitly decided.
  ['missing_tool|peer_substitute_missing|same_phase', 'tracked_in_issue_1589'],

  // missing_test_controller × peer_substitute_*: declared substitutes for
  // controller-seeding skips are not exercised — the controller-seeding
  // probe is phase-level, so the peer_substitutes_for shape doesn't
  // compose with it the way it composes with per-step missing_tool. May
  // be structurally impossible; tracking until the controller-seeding
  // surface is audited.
  ['missing_test_controller|peer_substitute_declared|same_phase', 'tracked_in_storyboard-controller-seeding.test.js'],
  [
    'missing_test_controller|peer_substitute_declared|downstream_phase',
    'tracked_in_storyboard-controller-seeding.test.js',
  ],
  ['missing_test_controller|peer_substitute_missing|same_phase', 'tracked_in_storyboard-controller-seeding.test.js'],
  [
    'missing_test_controller|peer_substitute_missing|downstream_phase',
    'tracked_in_storyboard-controller-seeding.test.js',
  ],

  // not_applicable same-phase deferred-promotion cases need a contract
  // decision. A same-phase stateful consumer is itself a peer, so
  // `sole_stateful × same_phase` cannot currently prove the sole-stateful
  // exemption; `peer_substitute_missing × same_phase` likewise only proves
  // phase-end timing.
  ['not_applicable|sole_stateful|same_phase', 'tracked_in_issue_1589'],
  ['not_applicable|peer_substitute_missing|same_phase', 'tracked_in_issue_1589'],
]);

function cellKey(reason, peer, topology) {
  return `${reason}|${peer}|${topology}`;
}

function buildCoverageReport() {
  const coveredSet = new Set();
  for (const row of MATRIX_ROWS) {
    coveredSet.add(cellKey(row.axes.skip_reason, row.axes.peer_shape, row.axes.phase_topology));
  }

  // Classify each cell by precedence: covered > impossible > tracked > empty.
  // Precedence guarantees the four buckets partition the cube.
  const buckets = { covered: [], impossible: [], tracked: [], empty: [] };
  for (const reason of SKIP_REASONS) {
    for (const peer of PEER_SHAPES) {
      for (const topology of PHASE_TOPOLOGIES) {
        const key = cellKey(reason, peer, topology);
        if (coveredSet.has(key)) buckets.covered.push(key);
        else if (IMPOSSIBLE_CELLS.has(key)) buckets.impossible.push(key);
        else if (TRACKED_GAPS.has(key)) buckets.tracked.push(key);
        else buckets.empty.push(key);
      }
    }
  }

  return {
    total: SKIP_REASONS.length * PEER_SHAPES.length * PHASE_TOPOLOGIES.length,
    ...buckets,
  };
}

// ---------------------------------------------------------------------
// Test execution
// ---------------------------------------------------------------------

describe('runStoryboard cascade-skip matrix (skip_reason × peer_shape × phase_topology)', () => {
  let agent;

  afterEach(async () => {
    if (agent) await stopAgent(agent);
    agent = undefined;
    await closeMCPConnections().catch(() => {});
  });

  for (const row of MATRIX_ROWS) {
    const tag = `[${row.axes.skip_reason} × ${row.axes.peer_shape} × ${row.axes.phase_topology}]`;
    test(`${tag} ${row.title}`, async () => {
      agent = await startFakeAgent();
      const fixture = row.build(agent);
      const result = await runWith(agent, fixture.storyboard, fixture.advertised, fixture.profileExtras);
      row.assert(result);
    });
  }
});

describe('runStoryboard cascade-skip controls (no skip occurs)', () => {
  let agent;

  afterEach(async () => {
    if (agent) await stopAgent(agent);
    agent = undefined;
    await closeMCPConnections().catch(() => {});
  });

  for (const row of CONTROL_ROWS) {
    test(row.title, async () => {
      agent = await startFakeAgent();
      const fixture = row.build(agent);
      const result = await runWith(agent, fixture.storyboard, fixture.advertised, fixture.profileExtras);
      row.assert(result);
    });
  }
});

describe('runStoryboard cascade-skip: parse-time validation', () => {
  let agent;

  afterEach(async () => {
    if (agent) await stopAgent(agent);
    agent = undefined;
    await closeMCPConnections().catch(() => {});
  });

  for (const row of VALIDATION_ROWS) {
    test(row.title, async () => {
      agent = await startFakeAgent();
      await assert.rejects(runWith(agent, row.storyboard, row.advertised), row.rejects);
    });
  }
});

describe('runStoryboard cascade-skip: sole-stateful-step exemption parity invariant', () => {
  // Structural guard against future asymmetric blind spots: every skip
  // reason in the sole-stateful-step exemption family MUST produce
  // identical cascade outcomes (downstream runs) and an explicit
  // exemption marker on the skip detail. The bug behind adcp-client#1545
  // (PR #1545 / adcp-client-python#550) was exactly an asymmetry —
  // #1146 fixed not_applicable, missing_tool was forgotten. This loop
  // catches the next time someone adds a new skip reason to the family
  // and forgets to wire it in. Add the new reason here when the family
  // grows.
  let agent;

  afterEach(async () => {
    if (agent) await stopAgent(agent);
    agent = undefined;
    await closeMCPConnections().catch(() => {});
  });

  test('all exemption-family skip reasons produce identical cascade outcomes', async () => {
    agent = await startFakeAgent();

    const buildStoryboard = () =>
      storyboardWithPhases([
        { id: 'account_setup', title: 'sole stateful step', steps: [step('sync', 'sync_accounts')] },
        { id: 'consume', title: 'downstream', steps: [step('assert', '__test_assert')] },
      ]);

    const cases = [
      {
        skip_reason: 'missing_tool',
        // sync_accounts NOT in agentTools → missing_tool
        run: () =>
          runStoryboard([agent.url], buildStoryboard(), {
            protocol: 'mcp',
            allow_http: true,
            agentTools: ['__test_assert', 'get_adcp_capabilities'],
            _profile: {
              name: 'fake',
              tools: [{ name: '__test_assert' }, { name: 'get_adcp_capabilities' }],
            },
          }),
      },
      {
        skip_reason: 'not_applicable',
        // sync_accounts advertised but profile signals not_applicable via
        // raw_capabilities → not_applicable
        run: () =>
          runStoryboard([agent.url], buildStoryboard(), {
            protocol: 'mcp',
            allow_http: true,
            agentTools: ['sync_accounts', '__test_assert', 'get_adcp_capabilities'],
            _profile: {
              name: 'fake',
              tools: [{ name: 'sync_accounts' }, { name: '__test_assert' }, { name: 'get_adcp_capabilities' }],
              raw_capabilities: { account: { require_operator_auth: true } },
            },
          }),
      },
    ];

    for (const c of cases) {
      const result = await c.run();
      const setupStep = result.phases[0].steps[0];
      const downstreamStep = result.phases[1].steps[0];

      assert.strictEqual(setupStep.skipped, true, `${c.skip_reason}: setup step skipped`);
      assert.strictEqual(setupStep.skip_reason, c.skip_reason, `${c.skip_reason}: skip_reason matches`);
      assert.match(
        setupStep.skip.detail ?? '',
        /Sole stateful step exemption applied for phase 'account_setup'/,
        `${c.skip_reason}: exemption marker present on skip detail`
      );
      assert.ok(!downstreamStep.skipped, `${c.skip_reason}: downstream phase runs (no cascade)`);
      assert.strictEqual(downstreamStep.passed, true, `${c.skip_reason}: downstream passes`);
    }
  });
});

// ---------------------------------------------------------------------
// Coverage assertion — fails CI if reality drifts from declared coverage.
//
// This is the structural alarm bell from issue #1548: empty cells stay
// visible. If a new dimension value is added (e.g., a new skip reason)
// or a new combination becomes reachable, this block fails until either
// (a) a covering row is added to MATRIX_ROWS, (b) the cell is added to
// IMPOSSIBLE_CELLS with rationale, or (c) the cell is added to
// TRACKED_GAPS with a tracking issue.
// ---------------------------------------------------------------------

describe('runStoryboard cascade-skip matrix: coverage report', () => {
  test('every cell in (skip_reason × peer_shape × phase_topology) is covered, impossible, or tracked', () => {
    const report = buildCoverageReport();
    if (process.env.MATRIX_REPORT === '1') {
      // eslint-disable-next-line no-console
      console.log(
        `\nMatrix coverage: covered=${report.covered.length} ` +
          `impossible=${report.impossible.length} tracked=${report.tracked.length} ` +
          `empty=${report.empty.length} total=${report.total}`
      );
      // eslint-disable-next-line no-console
      console.log('  covered:', report.covered);
      // eslint-disable-next-line no-console
      console.log('  impossible:', report.impossible);
      // eslint-disable-next-line no-console
      console.log('  tracked:', report.tracked);
    }
    const fmt = lines => lines.map(l => `  ${l}`).join('\n');

    if (report.empty.length > 0) {
      assert.fail(
        `Cascade matrix has ${report.empty.length} uncovered cell(s):\n${fmt(report.empty)}\n\n` +
          `Each cell must be either:\n` +
          `  - covered by a row in MATRIX_ROWS, or\n` +
          `  - listed in IMPOSSIBLE_CELLS with rationale, or\n` +
          `  - listed in TRACKED_GAPS with a tracking issue.`
      );
    }

    // Precedence-based partition: covered > impossible > tracked > empty.
    // The four buckets sum to the full cube by construction.
    const sum = report.covered.length + report.impossible.length + report.tracked.length + report.empty.length;
    assert.strictEqual(
      sum,
      report.total,
      `coverage buckets must partition the cube: covered=${report.covered.length} ` +
        `+ impossible=${report.impossible.length} + tracked=${report.tracked.length} ` +
        `+ empty=${report.empty.length} = ${sum}, expected ${report.total}`
    );
  });
});
