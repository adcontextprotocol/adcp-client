/**
 * ComplyOptions.routeStoryboard — per-storyboard routing for comply()
 * (adcontextprotocol/adcp#7758, #7779).
 *
 * comply() grades one agent. `requires: [multi_agent]` storyboards need a
 * second agent, so without routing they skip with `requirement_unmet` and cap
 * their bundle. The hook lets hosted grading route those storyboards (or
 * record an explicit skip) while every other storyboard keeps the ordinary
 * single-URL run.
 *
 * Two loopback MCP agents stand in for the seller under test and the
 * governance agent. Each records the tool calls and Authorization header it
 * receives so credential isolation is asserted on the wire, not inferred.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { comply, formatComplianceResults } = require('../../dist/lib/testing/compliance/index.js');
const { ADCP_VERSION } = require('../../dist/lib/version.js');

const OWNER_TOKEN = 'owner-token-for-seller-only';
const GOVERNANCE_TOKEN = 'governance-token-for-governance-only';

function probeStep(id, agent, sampleRequest = {}) {
  return `      - id: ${id}
        title: ${id}
        task: __test_probe
${agent ? `        agent: ${agent}\n` : ''}        sample_request: ${JSON.stringify(sampleRequest)}
        validations:
          - check: field_present
            path: probed
            description: probe answered
`;
}

function storyboardYaml(id, { requires, extra = '', steps }) {
  return `id: ${id}
version: 1.0.0
title: ${id}
category: testing
track: core
summary: ''
narrative: ''
agent:
  interaction_model: '*'
  capabilities: []
caller:
  role: buyer_agent
${requires ? `requires: [${requires.join(', ')}]\n` : ''}${extra}invariants:
  disable:
    - status.monotonic
    - impairment.coherence
phases:
  - id: flow
    title: Flow
    steps:
${steps.join('')}`;
}

function writeComplianceCache() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-comply-route-'));
  fs.mkdirSync(path.join(dir, 'universal'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'index.json'),
    JSON.stringify({
      adcp_version: ADCP_VERSION,
      generated_at: new Date().toISOString(),
      universal: ['plain-single', 'governed-multi', 'gated-multi', 'governance-only', 'kit-leak', 'kit-pinned'],
      protocols: [],
      specialisms: [],
    })
  );
  fs.writeFileSync(
    path.join(dir, 'universal', 'plain-single.yaml'),
    storyboardYaml('plain_single', { steps: [probeStep('plain_probe')] })
  );
  fs.writeFileSync(
    path.join(dir, 'universal', 'governed-multi.yaml'),
    storyboardYaml('governed_multi', {
      requires: ['multi_agent'],
      extra: 'context:\n  seller_agent_url: https://authored.example/mcp\n',
      steps: [
        probeStep('seller_probe', 'seller'),
        probeStep('governance_probe', 'governance', { seller: '$context.seller_agent_url' }),
      ],
    })
  );
  // A multi_agent storyboard behind a root capability predicate the seller
  // does not satisfy: applicability must win over routing.
  fs.writeFileSync(
    path.join(dir, 'universal', 'gated-multi.yaml'),
    storyboardYaml('gated_multi', {
      requires: ['multi_agent'],
      extra: 'requires_capability:\n  path: governance_test.enabled\n  equals: true\n',
      steps: [probeStep('gated_seller', 'seller'), probeStep('gated_governance', 'governance')],
    })
  );
  // Every step is served by the governance agent: passing evidence that says
  // nothing about the agent under test.
  fs.writeFileSync(
    path.join(dir, 'universal', 'governance-only.yaml'),
    storyboardYaml('governance_only', {
      requires: ['multi_agent'],
      steps: [probeStep('gov_only_a', 'governance'), probeStep('gov_only_b', 'governance')],
    })
  );
  // An unpinned step reads the test-kit credential; it could route to governance.
  fs.writeFileSync(
    path.join(dir, 'universal', 'kit-leak.yaml'),
    storyboardYaml('kit_leak', {
      requires: ['multi_agent'],
      steps: [
        probeStep('kit_leak_seller', 'seller'),
        probeStep('kit_leak_gov', 'governance'),
        probeStep('kit_leak_unpinned', undefined, { key: '$test_kit.auth.api_key' }),
      ],
    })
  );
  // The same reference on a step pinned to the agent under test is allowed.
  fs.writeFileSync(
    path.join(dir, 'universal', 'kit-pinned.yaml'),
    storyboardYaml('kit_pinned', {
      requires: ['multi_agent'],
      steps: [
        probeStep('kit_pinned_seller', 'seller', { key: '$test_kit.auth.api_key' }),
        probeStep('kit_pinned_gov', 'governance'),
      ],
    })
  );
  return dir;
}

function okTool(res, id, structuredContent) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      id,
      result: { structuredContent, content: [{ type: 'text', text: JSON.stringify(structuredContent) }] },
    })
  );
}

async function startAgent(name) {
  const requests = [];
  // 'ok' | 'bad_probe' (probe answers without `probed`) | 'down' (HTTP 500)
  const state = { mode: 'ok' };
  const server = http.createServer(async (req, res) => {
    if (state.mode === 'down') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'down' }));
      requests.push({ method: 'down', authorization: req.headers.authorization });
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const rpc = raw ? JSON.parse(raw) : {};
    const authorization = req.headers.authorization;
    requests.push({ method: rpc.method, tool: rpc.params?.name, args: rpc.params?.arguments, authorization });

    if (rpc.method === 'initialize') {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': `${name}-session` });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name, version: '1.0.0' } },
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
            tools: ['__test_probe', 'get_adcp_capabilities'].map(tool => ({
              name: tool,
              inputSchema: { type: 'object' },
            })),
          },
        })
      );
      return;
    }
    if (rpc.params?.name === 'get_adcp_capabilities') {
      return okTool(res, rpc.id, {
        adcp: {
          major_versions: [3],
          supported_versions: [ADCP_VERSION],
          build_version: ADCP_VERSION,
          idempotency: { supported: false },
        },
        supported_protocols: [],
        specialisms: [],
      });
    }
    if (rpc.params?.name === '__test_probe') {
      return okTool(res, rpc.id, state.mode === 'bad_probe' ? { served_by: name } : { probed: true, served_by: name });
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { isError: true, structuredContent: {} } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    name,
    requests,
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    probes: () => requests.filter(r => r.tool === '__test_probe'),
    state,
    reset: () => {
      requests.splice(0);
      state.mode = 'ok';
    },
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

function resultFor(result, storyboardId) {
  for (const track of result.tracks) {
    const scenario = track.scenarios.find(s => s.scenario.startsWith(`${storyboardId}/`));
    if (scenario) return scenario;
  }
  return undefined;
}

function bundleStatus(result, storyboardId) {
  return result.bundle_results.find(b => b.storyboard_ids.includes(storyboardId))?.status;
}

describe('comply() routeStoryboard', () => {
  let seller;
  let governance;
  let complianceDir;

  before(async () => {
    complianceDir = writeComplianceCache();
    seller = await startAgent('seller');
    governance = await startAgent('governance');
  });

  after(async () => {
    await seller.close();
    await governance.close();
    fs.rmSync(complianceDir, { recursive: true, force: true });
  });

  function run(extra = {}) {
    seller.reset();
    governance.reset();
    return comply(seller.url, {
      allow_http: true,
      complianceDir,
      auth: { type: 'bearer', token: OWNER_TOKEN },
      ...extra,
    });
  }

  function governanceRoute(overrides = {}) {
    return {
      agents: {
        governance: { url: governance.url, auth: { type: 'bearer', token: GOVERNANCE_TOKEN } },
        seller: { url: seller.url },
      },
      default_agent: 'seller',
      context: { seller_agent_url: seller.url },
      ...overrides,
    };
  }

  test('without a hook, multi_agent storyboards keep the requirement_unmet skip', async () => {
    const result = await run();

    assert.deepEqual(result.storyboards_executed.sort(), [
      'gated_multi',
      'governance_only',
      'governed_multi',
      'kit_leak',
      'kit_pinned',
      'plain_single',
    ]);
    assert.equal(governance.requests.length, 0, 'no second agent is contacted');
    assert.equal(bundleStatus(result, 'governed_multi'), 'partial');
    assert.equal(bundleStatus(result, 'plain_single'), 'passing');
  });

  test('undefined keeps the normal run; a route runs routed and counts in bundle_results', async () => {
    const calls = [];
    const result = await run({
      routeStoryboard: (storyboard, context) => {
        calls.push({ id: storyboard.id, agent_url: context.agent_url, tools: context.profile.tools });
        return storyboard.id === 'governed_multi' ? governanceRoute() : undefined;
      },
    });

    // The hook sees every applicable storyboard with the discovered profile,
    // but never the capability-gated one the seller does not claim.
    assert.deepEqual(calls.map(c => c.id).sort(), [
      'governance_only',
      'governed_multi',
      'kit_leak',
      'kit_pinned',
      'plain_single',
    ]);
    for (const call of calls) {
      assert.equal(call.agent_url, seller.url);
      assert.ok(call.tools.includes('__test_probe'));
    }

    assert.equal(bundleStatus(result, 'governed_multi'), 'passing', 'routed result flows into bundle_results');
    assert.equal(bundleStatus(result, 'plain_single'), 'passing');
    assert.equal(bundleStatus(result, 'gated_multi'), 'not_applicable', 'applicability wins over routing');
    assert.ok(result.storyboards_executed.includes('governed_multi'));
    assert.equal(result.failures, undefined);

    const routed = resultFor(result, 'governed_multi');
    assert.ok(routed, 'routed storyboard appears in tracks');
    assert.equal(routed.overall_passed, true);

    // Wire: each agent served only its own step, with only its own credential.
    assert.equal(seller.probes().length, 2, 'seller served plain_single and the routed seller step');
    for (const probe of seller.probes()) assert.equal(probe.authorization, `Bearer ${OWNER_TOKEN}`);
    const governanceProbes = governance.probes();
    assert.equal(governanceProbes.length, 1, 'governance served only its pinned step');
    assert.equal(governanceProbes[0].args.seller, seller.url, 'route context overrides authored context');
    for (const request of governance.requests) {
      assert.equal(request.authorization, `Bearer ${GOVERNANCE_TOKEN}`);
      assert.ok(!JSON.stringify(request).includes(OWNER_TOKEN), 'owner credential never reaches governance');
    }
    for (const request of seller.requests) {
      assert.ok(!JSON.stringify(request).includes(GOVERNANCE_TOKEN), 'governance credential never reaches seller');
    }
  });

  test('a skip records a requirement_unmet result that caps the bundle', async () => {
    const reason = 'governed_multi requires multi_agent but cannot be routed by hosted grading: test reason';
    const result = await run({
      routeStoryboard: storyboard => (storyboard.id === 'governed_multi' ? { skip: reason } : undefined),
    });

    assert.equal(governance.requests.length, 0);
    assert.ok(
      result.storyboards_executed.includes('governed_multi'),
      'listed like an unrouted requirement_unmet storyboard'
    );
    assert.equal(bundleStatus(result, 'governed_multi'), 'partial');
    assert.equal(bundleStatus(result, 'plain_single'), 'passing');
    assert.ok((result.summary.skipped_by_reason?.requirement_unmet ?? 0) >= 1);

    const skipped = resultFor(result, 'governed_multi');
    assert.ok(skipped, 'skipped storyboard still appears in its track');
    const step = skipped.steps.find(s => s.skipped);
    assert.ok(step, 'synthetic skip step present');
    assert.equal(skipped.scenario, 'governed_multi/requirement_unmet');
    assert.equal(step.skip_reason, 'requirement_unmet');
    assert.equal(step.requirement, 'multi_agent');
    assert.deepEqual(step.warnings, [reason], 'the hook reason is the reported skip detail');
  });

  test('an async hook is awaited', async () => {
    const result = await run({
      routeStoryboard: async storyboard => (storyboard.id === 'governed_multi' ? governanceRoute() : undefined),
    });
    assert.equal(bundleStatus(result, 'governed_multi'), 'passing');
  });

  test('explicit auth on the agent-under-test entry is used as-is', async () => {
    const route = governanceRoute();
    route.agents.seller.auth = { type: 'bearer', token: 'explicit-seller-token' };
    await run({ routeStoryboard: sb => (sb.id === 'governed_multi' ? route : undefined) });
    const routedSellerProbes = seller.probes().filter(p => p.authorization === 'Bearer explicit-seller-token');
    assert.equal(routedSellerProbes.length, 1, 'routed seller step used the entry auth, not run-level auth');
  });

  test('a hosted test-kit credential stays on the agent under test', async () => {
    // Hosted runs copy the owner credential into test_kit.auth.api_key and may
    // pass no run-level auth. The runner uses that key as the default bearer
    // for any client without explicit auth, so only explicit per-entry auth
    // keeps it off the governance route.
    seller.reset();
    governance.reset();
    const result = await comply(seller.url, {
      allow_http: true,
      complianceDir,
      test_kit: { auth: { api_key: OWNER_TOKEN, probe_task: 'list_accounts' } },
      routeStoryboard: sb => (sb.id === 'governed_multi' ? governanceRoute() : undefined),
    });
    assert.equal(bundleStatus(result, 'governed_multi'), 'passing');
    assert.ok(governance.requests.length > 0);
    for (const request of governance.requests) {
      assert.equal(request.authorization, `Bearer ${GOVERNANCE_TOKEN}`);
    }
    assert.ok(seller.probes().every(p => p.authorization === `Bearer ${OWNER_TOKEN}`));
  });

  test('refuses an entry for another agent without its own auth, before contacting it', async () => {
    const route = governanceRoute();
    delete route.agents.governance.auth;
    await assert.rejects(
      run({ routeStoryboard: sb => (sb.id === 'governed_multi' ? route : undefined) }),
      /agents\['governance'\].*must declare its own `auth`/
    );
    assert.equal(governance.requests.length, 0, 'the run-level credential was never offered to governance');
  });

  test('refuses to route while run-level headers are set', async () => {
    await assert.rejects(
      run({
        headers: { 'x-tenant': 'seller' },
        routeStoryboard: sb => (sb.id === 'governed_multi' ? governanceRoute() : undefined),
      }),
      /refusing to route while run-level `headers` are set/
    );
    assert.equal(governance.requests.length, 0);
  });

  test('refuses a default_agent that is not the agent under test', async () => {
    await assert.rejects(
      run({
        routeStoryboard: sb =>
          sb.id === 'governed_multi' ? governanceRoute({ default_agent: 'governance' }) : undefined,
      }),
      /must be the agent under test/
    );
  });

  test('refuses a replacement storyboard with a different id', async () => {
    await assert.rejects(
      run({
        routeStoryboard: sb =>
          sb.id === 'governed_multi' ? governanceRoute({ storyboard: { ...sb, id: 'plain_single' } }) : undefined,
      }),
      /different id/
    );
  });

  test('refuses malformed skip results', async () => {
    await assert.rejects(
      run({ routeStoryboard: sb => (sb.id === 'governed_multi' ? { skip: '  ' } : undefined) }),
      /non-empty reason/
    );
    await assert.rejects(
      run({ routeStoryboard: sb => (sb.id === 'governed_multi' ? { skip: 'x', ...governanceRoute() } : undefined) }),
      /both `skip` and `agents`/
    );
  });

  test('a replacement storyboard with the same id is the one that runs', async () => {
    const result = await run({
      routeStoryboard: sb => {
        if (sb.id !== 'governed_multi') return undefined;
        const patched = structuredClone(sb);
        patched.phases[0].steps[1].sample_request = { patched: true };
        return governanceRoute({ storyboard: patched });
      },
    });
    assert.equal(bundleStatus(result, 'governed_multi'), 'passing');
    assert.deepEqual(governance.probes()[0].args.patched, true);
  });

  test('routed agents share the run-level transport (fetch guard)', async () => {
    const seen = [];
    const trustedFetchFn = (input, init) => {
      seen.push(typeof input === 'string' ? input : (input.url ?? String(input)));
      return fetch(input, init);
    };
    const result = await run({
      transport: { trustedFetchFn },
      routeStoryboard: sb => (sb.id === 'governed_multi' ? governanceRoute() : undefined),
    });
    assert.equal(bundleStatus(result, 'governed_multi'), 'passing');
    assert.ok(governance.requests.length > 0);
    assert.ok(
      seen.some(url => url.startsWith(governance.url)),
      'governance traffic went through the caller-supplied fetch'
    );
  });
  function routeOnly(ids, route = () => governanceRoute()) {
    const set = new Set(ids);
    return sb => (set.has(sb.id) ? route(sb) : undefined);
  }

  function stepsOf(result, storyboardId) {
    return result.tracks
      .flatMap(track => track.scenarios)
      .filter(scenario => scenario.scenario.startsWith(`${storyboardId}/`))
      .flatMap(scenario => scenario.steps);
  }

  for (const bad of [null, '', false, 0, {}, { type: 'bearer' }, { type: 'bearer', token: '' }, { type: 'nope' }]) {
    test(`refuses a non-credential auth value ${JSON.stringify(bad)} on another agent`, async () => {
      const route = governanceRoute();
      route.agents.governance.auth = bad;
      await assert.rejects(
        run({ routeStoryboard: routeOnly(['governed_multi'], () => route) }),
        /must declare its own `auth` credential object/
      );
      assert.equal(governance.requests.length, 0, 'the run-level credential was never offered to governance');
    });
  }

  test('refuses an explicit non-credential auth on the agent-under-test entry too', async () => {
    const route = governanceRoute();
    route.agents.seller.auth = null;
    await assert.rejects(
      run({ routeStoryboard: routeOnly(['governed_multi'], () => route) }),
      /agents\['seller'\].*credential object/
    );
  });

  test('a failed step on another routed agent is a coverage gap, never failing', async () => {
    const result = await run({
      routeStoryboard: sb => {
        if (sb.id === 'governed_multi') governance.state.mode = 'bad_probe';
        return sb.id === 'governed_multi' ? governanceRoute() : undefined;
      },
    });
    assert.equal(bundleStatus(result, 'governed_multi'), 'partial');
    assert.ok(!(result.failures ?? []).some(f => f.storyboard_id === 'governed_multi'));
    const step = stepsOf(result, 'governed_multi').find(s => s.step === 'governance_probe');
    assert.equal(step.skipped, true);
    assert.equal(step.skip_reason, 'prerequisite_failed');
    assert.equal(resultFor(result, 'governed_multi').overall_passed, true);
  });

  test("another routed agent's discovery failure is a coverage gap, never failing", async () => {
    governance.state.mode = 'down';
    const result = await comply(seller.url, {
      allow_http: true,
      complianceDir,
      auth: { type: 'bearer', token: OWNER_TOKEN },
      routeStoryboard: routeOnly(['governed_multi']),
    });
    governance.state.mode = 'ok';
    assert.equal(bundleStatus(result, 'governed_multi'), 'partial');
    assert.ok(!(result.failures ?? []).some(f => f.storyboard_id === 'governed_multi'));
    const sellerStep = stepsOf(result, 'governed_multi').find(s => s.step === 'seller_probe');
    assert.equal(sellerStep?.passed, true, 'the agent under test is still graded on its own step');
  });

  test('a failed step on the agent under test still fails the bundle', async () => {
    const result = await run({
      routeStoryboard: sb => {
        if (sb.id === 'governed_multi') seller.state.mode = 'bad_probe';
        return sb.id === 'governed_multi' ? governanceRoute() : undefined;
      },
    });
    assert.equal(bundleStatus(result, 'governed_multi'), 'failing');
    assert.ok(result.failures.some(f => f.storyboard_id === 'governed_multi' && f.step_id === 'seller_probe'));
  });

  test('passing steps served only by other agents cannot make the bundle pass', async () => {
    const result = await run({ routeStoryboard: routeOnly(['governance_only']) });
    assert.equal(governance.probes().length, 2);
    assert.equal(bundleStatus(result, 'governance_only'), 'partial');
    const gap = stepsOf(result, 'governance_only').find(s => s.skip_reason === 'prerequisite_failed');
    assert.ok(gap, 'agent_under_test_coverage gap row present');
  });

  test('refuses (as a skip) a route whose unpinned step reads test-kit credentials', async () => {
    const result = await run({
      test_kit: { auth: { api_key: OWNER_TOKEN, probe_task: 'list_accounts' } },
      routeStoryboard: routeOnly(['kit_leak']),
    });
    assert.equal(governance.requests.length, 0);
    assert.equal(bundleStatus(result, 'kit_leak'), 'partial');
    const step = stepsOf(result, 'kit_leak')[0];
    assert.equal(step.skip_reason, 'requirement_unmet');
    assert.match(step.warnings[0], /kit_leak_unpinned.*test-kit credentials/);
  });

  test('allows test-kit references on steps pinned to the agent under test', async () => {
    const result = await run({
      test_kit: { auth: { api_key: OWNER_TOKEN, probe_task: 'list_accounts' } },
      routeStoryboard: routeOnly(['kit_pinned']),
    });
    assert.equal(bundleStatus(result, 'kit_pinned'), 'passing');
    assert.ok(
      seller.probes().some(p => p.args?.key !== undefined),
      'the pinned step ran on the seller'
    );
    for (const request of governance.requests) assert.ok(!JSON.stringify(request).includes(OWNER_TOKEN));
  });

  test('refuses a replacement storyboard that changes what is graded', async () => {
    await assert.rejects(
      run({
        routeStoryboard: routeOnly(['governed_multi'], sb => {
          const patched = structuredClone(sb);
          patched.phases[0].steps[0].validations = [];
          return governanceRoute({ storyboard: patched });
        }),
      }),
      /changes what is graded/
    );
  });

  test('a skip on a storyboard without multi_agent carries no requirement', async () => {
    const result = await run({ routeStoryboard: routeOnly(['plain_single'], () => ({ skip: 'operator skip' })) });
    const step = stepsOf(result, 'plain_single')[0];
    assert.equal(step.skip_reason, 'requirement_unmet');
    assert.equal(step.requirement, undefined);
    assert.equal(bundleStatus(result, 'plain_single'), 'partial');
  });

  test('strips control and bidi characters from the skip reason', async () => {
    const result = await run({
      routeStoryboard: routeOnly(['governed_multi'], () => ({ skip: 'bad\u0007reason‮\ninjected' })),
    });
    const warning = stepsOf(result, 'governed_multi')[0].warnings[0];
    assert.doesNotMatch(warning, /[\u0000-\u001f‮]/);
    assert.match(warning, /badreason/);
  });

  test('an error thrown by the hook propagates', async () => {
    await assert.rejects(
      run({
        routeStoryboard: () => {
          throw new Error('router exploded');
        },
      }),
      /router exploded/
    );
  });

  test('routed and skipped rows render in the text report', async () => {
    const result = await run({
      routeStoryboard: sb =>
        sb.id === 'governed_multi' ? governanceRoute() : sb.id === 'kit_pinned' ? { skip: 'not today' } : undefined,
    });
    const text = formatComplianceResults(result);
    assert.match(text, /governed_multi|governed-multi/);
  });
});
