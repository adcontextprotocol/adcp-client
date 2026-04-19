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
