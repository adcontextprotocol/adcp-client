/**
 * Storyboard runner — multi-instance (round-robin) mode.
 *
 * Issue #2267: sellers deployed behind a load balancer with in-memory state
 * pass every storyboard against a single URL but break in production because
 * brand-scoped state isn't shared across machines. The runner's multi-URL
 * mode round-robins steps across 2+ seller URLs so cross-machine persistence
 * is exercised in CI.
 *
 * These tests stand up two local HTTP servers as fake MCP agents. Steps use
 * `auth: 'none'` so dispatch goes through `rawMcpProbe` (no MCP SDK session
 * handshake) — sufficient for the round-robin and attribution assertions,
 * and keeps the tests free of MCP initialization concerns.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner.js');
const { GovernanceAgentStub } = require('../../dist/lib/testing/stubs/index.js');
const { closeMCPConnections } = require('../../dist/lib/protocols/mcp.js');

// ────────────────────────────────────────────────────────────
// Fake agent harness
// ────────────────────────────────────────────────────────────

/**
 * Start a fake MCP agent on an ephemeral port. `state` is a Map the handler
 * writes to for `create_*` tasks and reads from for `get_*` tasks — inject
 * one shared Map across two agents to simulate a correctly shared backing
 * store, or separate Maps to simulate the per-process bug.
 */
async function startFakeAgent({ state, label }) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const toolName = rpc.params?.name;
    const args = rpc.params?.arguments ?? {};
    requests.push({ tool: toolName, args, label });

    const ok = structured =>
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { structuredContent: structured } }));
    const notFound = msg =>
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: { isError: true, structuredContent: { error: msg, code: 'NOT_FOUND' } },
        })
      );

    // Use non-AdCP tool names so the runner's request builder map doesn't
    // rewrite the sample_request (`sync_accounts` and similar have builders
    // that strip caller-provided IDs).
    if (toolName === '__test_write') {
      const key = args.key ?? 'default';
      state.set(key, { key, value: args.value ?? 'v', written_on: label });
      return ok({ key, stored: true });
    }
    if (toolName === '__test_read') {
      const key = args.key ?? 'default';
      const rec = state.get(key);
      if (!rec) return notFound(`key ${key} NOT_FOUND on instance ${label}`);
      return ok(rec);
    }
    if (toolName === '__test_probe') {
      return ok({ instance: label });
    }
    if (toolName === 'get_adcp_capabilities') {
      return ok({ version: '1.0', protocols: [], specialisms: [] });
    }
    return notFound(`unknown tool ${toolName} on instance ${label}`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { server, url: `http://127.0.0.1:${port}/mcp`, requests };
}

function stopAgent(agent) {
  return new Promise(r => agent.server.close(r));
}

// ────────────────────────────────────────────────────────────
// Storyboard fixtures
// ────────────────────────────────────────────────────────────

function storyboardWith(steps) {
  return {
    id: 'multi_instance_sb',
    version: '1.0.0',
    title: 'Multi-instance test',
    category: 'testing',
    summary: '',
    narrative: '',
    agent: { interaction_model: '*', capabilities: [] },
    caller: { role: 'buyer_agent' },
    phases: [{ id: 'p', title: 'crud', steps }],
  };
}

// Every step uses `auth: 'none'` so dispatch goes via rawMcpProbe. We set
// `agentTools` to pretend every tool is advertised (so the runner doesn't
// skip them for missing_tool) and inject a `_profile` to skip discovery.
const AGENT_TOOLS = ['__test_write', '__test_read', '__test_probe', 'get_adcp_capabilities'];
const RUN_OPTIONS_BASE = {
  protocol: 'mcp',
  allow_http: true,
  agentTools: AGENT_TOOLS,
  _profile: { name: 'fake', tools: AGENT_TOOLS.map(name => ({ name })) },
};

// ────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────

describe('runStoryboard: multi-instance round-robin', () => {
  let agentA;
  let agentB;

  afterEach(async () => {
    if (agentA) await stopAgent(agentA);
    if (agentB) await stopAgent(agentB);
    agentA = undefined;
    agentB = undefined;
  });

  test('dispatches steps round-robin across URLs and records agent_index', async () => {
    const shared = new Map();
    agentA = await startFakeAgent({ state: shared, label: 'A' });
    agentB = await startFakeAgent({ state: shared, label: 'B' });

    const storyboard = storyboardWith([
      { id: 's1', title: 's1', task: '__test_probe', auth: 'none', sample_request: {} },
      { id: 's2', title: 's2', task: '__test_probe', auth: 'none', sample_request: {} },
      { id: 's3', title: 's3', task: '__test_probe', auth: 'none', sample_request: {} },
      { id: 's4', title: 's4', task: '__test_probe', auth: 'none', sample_request: {} },
    ]);

    const result = await runStoryboard([agentA.url, agentB.url], storyboard, RUN_OPTIONS_BASE);

    assert.deepStrictEqual(result.agent_urls, [agentA.url, agentB.url]);
    assert.strictEqual(result.multi_instance_strategy, 'round-robin');
    const steps = result.phases[0].steps;
    assert.strictEqual(steps[0].agent_index, 1);
    assert.strictEqual(steps[1].agent_index, 2);
    assert.strictEqual(steps[2].agent_index, 1);
    assert.strictEqual(steps[3].agent_index, 2);
    assert.strictEqual(steps[0].agent_url, agentA.url);
    assert.strictEqual(steps[1].agent_url, agentB.url);
    // Each instance received exactly 2 requests.
    assert.strictEqual(agentA.requests.length, 2);
    assert.strictEqual(agentB.requests.length, 2);
  });

  test('shared backing store: write on A, read on B succeeds', async () => {
    const shared = new Map();
    agentA = await startFakeAgent({ state: shared, label: 'A' });
    agentB = await startFakeAgent({ state: shared, label: 'B' });

    const storyboard = storyboardWith([
      {
        id: 'create',
        title: 'create',
        task: '__test_write',
        stateful: true,
        auth: 'none',
        sample_request: { key: 'k1', value: 'v1' },
      },
      {
        id: 'read',
        title: 'read',
        task: '__test_read',
        stateful: true,
        auth: 'none',
        sample_request: { key: 'k1' },
      },
    ]);

    const result = await runStoryboard([agentA.url, agentB.url], storyboard, RUN_OPTIONS_BASE);
    assert.ok(result.overall_passed, `expected overall_passed, got error: ${result.phases[0].steps[1].error}`);
    assert.strictEqual(result.phases[0].steps[0].agent_index, 1);
    assert.strictEqual(result.phases[0].steps[1].agent_index, 2);
  });

  test('per-process state: write on A, read on B fails with attribution block', async () => {
    // Each agent gets its own state map — the horizontal-scaling bug.
    agentA = await startFakeAgent({ state: new Map(), label: 'A' });
    agentB = await startFakeAgent({ state: new Map(), label: 'B' });

    const storyboard = storyboardWith([
      {
        id: 'create',
        title: 'create',
        task: '__test_write',
        stateful: true,
        auth: 'none',
        sample_request: { key: 'k1', value: 'v1' },
      },
      {
        id: 'read',
        title: 'read',
        task: '__test_read',
        stateful: true,
        auth: 'none',
        sample_request: { key: 'k1' },
      },
    ]);

    const result = await runStoryboard([agentA.url, agentB.url], storyboard, RUN_OPTIONS_BASE);

    assert.strictEqual(result.overall_passed, false);
    const readStep = result.phases[0].steps[1];
    assert.strictEqual(readStep.passed, false);
    assert.ok(readStep.error, 'expected an error message on the failed read step');
    // Wording mirrors the failure example in
    // https://adcontextprotocol.org/docs/building/validate-your-agent#verifying-cross-instance-state
    assert.match(readStep.error, /create on replica \[#1\]/);
    assert.match(readStep.error, /read on replica \[#2\] .* failed with NOT_FOUND/);
    assert.match(readStep.error, /→ Brand-scoped state is not shared across replicas\./);
    assert.match(
      readStep.error,
      /validate-your-agent#verifying-cross-instance-state/,
      'expected deep link to upstream docs anchor'
    );
    assert.match(readStep.error, /Reproduce single-replica: adcp storyboard run/);
  });

  test('single URL as string keeps backward-compatible result shape', async () => {
    const shared = new Map();
    agentA = await startFakeAgent({ state: shared, label: 'A' });

    const storyboard = storyboardWith([
      { id: 's1', title: 's1', task: '__test_probe', auth: 'none', sample_request: {} },
    ]);

    const result = await runStoryboard(agentA.url, storyboard, RUN_OPTIONS_BASE);
    assert.strictEqual(result.agent_url, agentA.url);
    assert.strictEqual(result.agent_urls, undefined);
    assert.strictEqual(result.multi_instance_strategy, undefined);
    assert.strictEqual(result.phases[0].steps[0].agent_index, undefined);
    assert.strictEqual(result.phases[0].steps[0].agent_url, undefined);
  });

  test('rejects _client override in multi-instance mode', async () => {
    await assert.rejects(
      runStoryboard(['http://a', 'http://b'], storyboardWith([]), {
        ...RUN_OPTIONS_BASE,
        _client: {},
      }),
      /incompatible with multi-instance mode/
    );
  });

  test('rejects empty URL array', async () => {
    await assert.rejects(runStoryboard([], storyboardWith([]), RUN_OPTIONS_BASE), /at least one agent URL required/);
  });
});

// ────────────────────────────────────────────────────────────
// multi-pass strategy (#607)
//
// `multi-pass` runs the storyboard once per replica, each pass starting the
// round-robin dispatcher at a different replica (offset K for pass K). The
// win is that every step gets exercised against a different replica across
// passes — a bug that's isolated to one replica's deployment (config drift,
// stale state, different version) surfaces on a pass where that replica
// serves the relevant step.
//
// Known limitation (follow-up #607 option 2): for N=2, pure offset-shift
// preserves pair parity — a write→read pair separated by an odd number of
// steps lands same-replica in every pass. Closing that gap requires
// dependency-aware dispatch (`context_inputs` → pick a replica different
// from the most recent writer). This suite verifies the offset-shift
// mechanics and the per-pass aggregation; it does NOT claim to catch every
// 2-replica cross-state bug.
// ────────────────────────────────────────────────────────────

describe('runStoryboard: multi-instance multi-pass', () => {
  let agentA;
  let agentB;

  afterEach(async () => {
    if (agentA) await stopAgent(agentA);
    if (agentB) await stopAgent(agentB);
    agentA = undefined;
    agentB = undefined;
  });

  test('runs N passes with swapped starting replica and reports per-pass detail', async () => {
    const shared = new Map();
    agentA = await startFakeAgent({ state: shared, label: 'A' });
    agentB = await startFakeAgent({ state: shared, label: 'B' });

    const storyboard = storyboardWith([
      { id: 's1', title: 's1', task: '__test_probe', auth: 'none', sample_request: {} },
      { id: 's2', title: 's2', task: '__test_probe', auth: 'none', sample_request: {} },
    ]);

    const result = await runStoryboard([agentA.url, agentB.url], storyboard, {
      ...RUN_OPTIONS_BASE,
      multi_instance_strategy: 'multi-pass',
    });

    assert.strictEqual(result.multi_instance_strategy, 'multi-pass');
    assert.ok(result.passes, 'expected passes[] on result');
    assert.strictEqual(result.passes.length, 2);

    const [pass1, pass2] = result.passes;
    assert.strictEqual(pass1.pass_index, 1);
    assert.strictEqual(pass1.dispatch_offset, 0);
    assert.strictEqual(pass2.pass_index, 2);
    assert.strictEqual(pass2.dispatch_offset, 1);

    // Pass 1 starts at [#1]: step 0 → #1, step 1 → #2
    assert.strictEqual(pass1.phases[0].steps[0].agent_index, 1);
    assert.strictEqual(pass1.phases[0].steps[1].agent_index, 2);
    // Pass 2 starts at [#2]: step 0 → #2, step 1 → #1 (swapped)
    assert.strictEqual(pass2.phases[0].steps[0].agent_index, 2);
    assert.strictEqual(pass2.phases[0].steps[1].agent_index, 1);

    // Aggregated counts sum across all passes
    assert.strictEqual(result.passed_count, pass1.passed_count + pass2.passed_count);
    assert.ok(result.overall_passed);

    // Top-level `phases` exposes the first pass's phases for single-pass consumers.
    assert.strictEqual(result.phases[0].steps[0].agent_index, 1);
    assert.strictEqual(result.phases[0].steps[1].agent_index, 2);
  });

  test('aggregates failures from a per-replica bug across both passes', async () => {
    // One replica is missing a key (B) — the bug is per-replica, not
    // cross-replica. Every step that lands on B fails. The test pins the
    // aggregation contract: failed_count sums across passes, overall_passed
    // is false when any pass fails. Explicitly NOT a cross-replica state
    // test — round-robin catches this bug too (the single pass that hits B
    // fails). The value of multi-pass here is redundant coverage, not
    // uncovering a bug that round-robin misses.
    const stateA = new Map([['k1', { key: 'k1', value: 'v1', written_on: 'A' }]]);
    const stateB = new Map();
    agentA = await startFakeAgent({ state: stateA, label: 'A' });
    agentB = await startFakeAgent({ state: stateB, label: 'B' });

    const storyboard = storyboardWith([
      { id: 'r1', title: 'r1', task: '__test_read', auth: 'none', sample_request: { key: 'k1' } },
      { id: 'r2', title: 'r2', task: '__test_read', auth: 'none', sample_request: { key: 'k1' } },
    ]);

    const result = await runStoryboard([agentA.url, agentB.url], storyboard, {
      ...RUN_OPTIONS_BASE,
      multi_instance_strategy: 'multi-pass',
    });

    assert.strictEqual(result.overall_passed, false);
    assert.ok(result.failed_count >= 2, `expected ≥2 failed steps, got ${result.failed_count}`);
    assert.ok(result.passes.every(p => !p.overall_passed));
  });

  test('ANDs overall_passed across mixed-outcome passes (pass 1 green, pass 2 red)', async () => {
    // Pins the core AND-combining contract: even when a single pass reports
    // overall_passed=true, the run fails when any later pass fails.
    //
    // Construction: storyboard has two steps. On pass 1 (offset 0), step 0 →
    // agent A (serves __test_probe), step 1 → agent B (serves __test_probe).
    // On pass 2 (offset 1), step 0 → agent B, step 1 → agent A. We make
    // agent B fail on its SECOND inbound request (not the first) — so pass 1
    // still passes (B is hit once) but pass 2 fails (B is hit twice across
    // the run, second time trips the gate).
    const shared = new Map();
    let bRequestCount = 0;
    agentA = await startFakeAgent({ state: shared, label: 'A' });
    // Custom B: first probe OK, second returns error. Can't easily do with
    // startFakeAgent's uniform handler, so hand-roll a tiny server.
    const http = require('http');
    let server;
    await new Promise(resolve => {
      server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const tool = rpc.params?.name;
        if (tool === 'get_adcp_capabilities') {
          res.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: rpc.id,
              result: { structuredContent: { version: '1.0', protocols: [], specialisms: [] } },
            })
          );
          return;
        }
        bRequestCount++;
        if (bRequestCount > 1) {
          res.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: rpc.id,
              result: { isError: true, structuredContent: { error: 'second-hit failure', code: 'BROKEN' } },
            })
          );
          return;
        }
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { structuredContent: { instance: 'B' } } }));
      });
      server.listen(0, '127.0.0.1', resolve);
    });
    const bUrl = `http://127.0.0.1:${server.address().port}/mcp`;

    try {
      const storyboard = storyboardWith([
        { id: 's1', title: 's1', task: '__test_probe', auth: 'none', sample_request: {} },
        { id: 's2', title: 's2', task: '__test_probe', auth: 'none', sample_request: {} },
      ]);

      const result = await runStoryboard([agentA.url, bUrl], storyboard, {
        ...RUN_OPTIONS_BASE,
        multi_instance_strategy: 'multi-pass',
      });

      // Pass 1: step 0 → A (ok), step 1 → B's first hit (ok)         → passes
      // Pass 2: step 0 → B's second hit (FAIL), step 1 → A (ok)      → fails
      assert.strictEqual(result.passes.length, 2);
      assert.strictEqual(result.passes[0].overall_passed, true, 'pass 1 should pass (B hit once)');
      assert.strictEqual(result.passes[1].overall_passed, false, 'pass 2 should fail (B hit second time)');
      assert.strictEqual(result.overall_passed, false, 'overall must AND across passes');
      assert.strictEqual(result.failed_count, 1);
    } finally {
      await new Promise(r => server.close(r));
    }
  });

  test('rejects webhook_receiver + multi-pass', async () => {
    await assert.rejects(
      runStoryboard(['http://a', 'http://b'], storyboardWith([]), {
        ...RUN_OPTIONS_BASE,
        multi_instance_strategy: 'multi-pass',
        webhook_receiver: { mode: 'loopback_mock' },
      }),
      /webhook_receiver is incompatible with multi_instance_strategy: "multi-pass"/
    );
  });

  test('rotates dispatch across 3 replicas with 3 passes', async () => {
    const shared = new Map();
    const agents = await Promise.all([
      startFakeAgent({ state: shared, label: 'A' }),
      startFakeAgent({ state: shared, label: 'B' }),
      startFakeAgent({ state: shared, label: 'C' }),
    ]);
    try {
      const storyboard = storyboardWith([
        { id: 's1', title: 's1', task: '__test_probe', auth: 'none', sample_request: {} },
        { id: 's2', title: 's2', task: '__test_probe', auth: 'none', sample_request: {} },
        { id: 's3', title: 's3', task: '__test_probe', auth: 'none', sample_request: {} },
      ]);

      const result = await runStoryboard(
        agents.map(a => a.url),
        storyboard,
        { ...RUN_OPTIONS_BASE, multi_instance_strategy: 'multi-pass' }
      );

      assert.strictEqual(result.passes.length, 3);
      // Pass offsets rotate through 0, 1, 2 — step 0 hits replicas [#1, #2, #3]
      // respectively.
      assert.strictEqual(result.passes[0].phases[0].steps[0].agent_index, 1);
      assert.strictEqual(result.passes[1].phases[0].steps[0].agent_index, 2);
      assert.strictEqual(result.passes[2].phases[0].steps[0].agent_index, 3);
      // Every replica serves each step position at some pass.
      assert.ok(result.overall_passed);
    } finally {
      for (const a of agents) await stopAgent(a);
    }
  });

  test('ANDs overall_passed across passes and sums counts', async () => {
    const shared = new Map();
    agentA = await startFakeAgent({ state: shared, label: 'A' });
    agentB = await startFakeAgent({ state: shared, label: 'B' });

    const storyboard = storyboardWith([
      { id: 's1', title: 's1', task: '__test_probe', auth: 'none', sample_request: {} },
      { id: 's2', title: 's2', task: '__test_probe', auth: 'none', sample_request: {} },
    ]);

    const result = await runStoryboard([agentA.url, agentB.url], storyboard, {
      ...RUN_OPTIONS_BASE,
      multi_instance_strategy: 'multi-pass',
    });

    assert.ok(result.overall_passed);
    assert.strictEqual(result.passed_count, 4); // 2 steps × 2 passes
    assert.strictEqual(result.failed_count, 0);
    // 2 steps × 2 passes = 4 probes; with swapped starts each replica serves
    // exactly 2 probes total (one per pass).
    assert.strictEqual(agentA.requests.length, 2);
    assert.strictEqual(agentB.requests.length, 2);
  });

  test('falls back to single-pass when only one URL is provided', async () => {
    const shared = new Map();
    agentA = await startFakeAgent({ state: shared, label: 'A' });

    const storyboard = storyboardWith([
      { id: 's1', title: 's1', task: '__test_probe', auth: 'none', sample_request: {} },
    ]);

    const result = await runStoryboard([agentA.url], storyboard, {
      ...RUN_OPTIONS_BASE,
      multi_instance_strategy: 'multi-pass',
    });

    // Single-URL mode — multi-pass is a no-op. The result reports
    // single-instance (agent_urls undefined, no passes[]).
    assert.strictEqual(result.agent_urls, undefined);
    assert.strictEqual(result.passes, undefined);
  });
});

// ────────────────────────────────────────────────────────────
// MCP SDK dispatch path (no auth: 'none' override — full MCP handshake)
// ────────────────────────────────────────────────────────────

/**
 * The tests above use `auth: 'none'` which routes through `rawMcpProbe`
 * (raw fetch, no MCP session handshake). That's sufficient for dispatch
 * and attribution logic but doesn't exercise the real production path:
 * two ADCPMultiAgentClient instances each with their own
 * StreamableHTTPClientTransport, each doing an `initialize` + tool dispatch.
 * This block covers that path using two GovernanceAgentStub servers.
 */
describe('runStoryboard: multi-instance through MCP SDK', () => {
  let stubA;
  let stubB;
  let urls;

  beforeEach(async () => {
    stubA = new GovernanceAgentStub();
    stubB = new GovernanceAgentStub();
    const a = await stubA.start();
    const b = await stubB.start();
    urls = [a.url, b.url];
  });

  afterEach(async () => {
    // Close the client-side MCP connection cache first so transports attached
    // to the about-to-die servers don't linger and leak sockets into the next
    // test's event loop.
    await closeMCPConnections();
    await stubA.stop();
    await stubB.stop();
  });

  test('round-robins a stateless storyboard across two MCP stubs via the SDK', async () => {
    // check_governance is deterministic per plan_id — both stubs accept it and
    // return identical responses, so this storyboard doesn't depend on state
    // sharing. It exists solely to verify that the MCP SDK path (initialize
    // handshake, tools/call serialization, session handling) works when the
    // runner has two distinct transports rotating per step.
    const storyboard = {
      id: 'mcp_sdk_multi_instance',
      version: '1.0.0',
      title: 'MCP SDK multi-instance',
      category: 'testing',
      summary: '',
      narrative: '',
      agent: { interaction_model: '*', capabilities: [] },
      caller: { role: 'buyer_agent' },
      phases: [
        {
          id: 'p',
          title: 'alternating governance checks',
          steps: [
            {
              id: 's1',
              title: 'check 1',
              task: 'check_governance',
              sample_request: {
                plan_id: 'plan-mcp-sdk',
                binding: 'proposed',
                caller: 'buyer',
                tool: 'create_media_buy',
                payload: { budget: 100 },
              },
            },
            {
              id: 's2',
              title: 'check 2',
              task: 'check_governance',
              sample_request: {
                plan_id: 'plan-mcp-sdk',
                binding: 'proposed',
                caller: 'buyer',
                tool: 'create_media_buy',
                payload: { budget: 200 },
              },
            },
            {
              id: 's3',
              title: 'check 3',
              task: 'check_governance',
              sample_request: {
                plan_id: 'plan-mcp-sdk',
                binding: 'proposed',
                caller: 'buyer',
                tool: 'create_media_buy',
                payload: { budget: 300 },
              },
            },
          ],
        },
      ],
    };

    const result = await runStoryboard(urls, storyboard, {
      protocol: 'mcp',
      allow_http: true,
      agentTools: ['check_governance', 'get_adcp_capabilities'],
      _profile: {
        name: 'stub',
        tools: [{ name: 'check_governance' }, { name: 'get_adcp_capabilities' }],
      },
    });

    assert.ok(
      result.overall_passed,
      `expected all stateless steps to pass; first error: ${result.phases[0].steps.find(s => !s.passed)?.error}`
    );
    const steps = result.phases[0].steps;
    assert.strictEqual(steps[0].agent_index, 1);
    assert.strictEqual(steps[1].agent_index, 2);
    assert.strictEqual(steps[2].agent_index, 1);
    // We care about the check_governance calls — the SDK may also do a
    // tools/list on first contact. Filter to the tool we dispatched.
    const aChecks = stubA.getCallsForTool('check_governance');
    const bChecks = stubB.getCallsForTool('check_governance');
    assert.strictEqual(aChecks.length, 2, `stubA check_governance count: ${JSON.stringify(stubA.getCallLog())}`);
    assert.strictEqual(bChecks.length, 1, `stubB check_governance count: ${JSON.stringify(stubB.getCallLog())}`);
  });

  test('does not echo the auth token in any step result or error', async () => {
    // Regression for the security review's concern: a hostile agent could
    // force a failure and embed the token if the runner ever placed it in
    // attribution text. Verify empirically by passing a distinctive token
    // and scanning the entire serialized result for it.
    const SECRET = 'adcp-test-token-DO-NOT-ECHO-MUST-NOT-LEAK';
    // Deliberately call a step whose task isn't declared to force a skip
    // that still exercises the multi-instance path.
    const storyboard = {
      id: 'token_no_echo',
      version: '1.0.0',
      title: 'Token no-echo',
      category: 'testing',
      summary: '',
      narrative: '',
      agent: { interaction_model: '*', capabilities: [] },
      caller: { role: 'buyer_agent' },
      phases: [
        {
          id: 'p',
          title: 'governance',
          steps: [
            {
              id: 's1',
              title: 's1',
              task: 'check_governance',
              sample_request: {
                plan_id: 'plan-no-echo',
                binding: 'proposed',
                caller: 'buyer',
                tool: 'create_media_buy',
                payload: {},
              },
            },
            {
              id: 's2',
              title: 's2',
              task: 'check_governance',
              sample_request: {
                plan_id: 'plan-no-echo',
                binding: 'proposed',
                caller: 'buyer',
                tool: 'create_media_buy',
                payload: {},
              },
            },
          ],
        },
      ],
    };

    const result = await runStoryboard(urls, storyboard, {
      protocol: 'mcp',
      allow_http: true,
      auth: { type: 'bearer', token: SECRET },
      agentTools: ['check_governance', 'get_adcp_capabilities'],
      _profile: { name: 'stub', tools: [{ name: 'check_governance' }] },
    });

    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(SECRET), 'token leaked into result JSON');
    assert.ok(!serialized.includes(SECRET.slice(5)), 'token substring leaked into result JSON');
  });
});
