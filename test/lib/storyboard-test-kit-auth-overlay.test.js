/**
 * `test_kit_auth` — a credential laid over each storyboard's declared test
 * kit (adcontextprotocol/adcp#8929).
 *
 * A host that grades with its own credential used to put it in a run-level
 * `test_kit`, and that kit replaced every storyboard's declared kit: no
 * storyboard got its own fixtures. The overlay keeps each declared kit and
 * replaces only its `auth`, except for a live-mode kit (`sandbox: false`),
 * whose own principal is what the storyboard tests.
 *
 * The comply() cases run against a loopback MCP agent that records the
 * credential headers and arguments of every probe, so the credential and the
 * fixture each storyboard got are asserted on the wire. Each storyboard's
 * probe sits in a phase gated on its own kit's `fixture_marker`, and the
 * kit-less storyboards carry a phase that runs only if a marker leaked into
 * them. `auth: none` steps check that the overlay never turns into a
 * credential on an unauthenticated probe.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { comply } = require('../../dist/lib/testing/compliance/index.js');
const { resolveDeclaredTestKit } = require('../../dist/lib/testing/storyboard/test-kit');
const { ADCP_VERSION, toReleasePrecisionVersion } = require('../../dist/lib/version.js');

const TRANSPORT_TOKEN = 'owner-transport-token';
const OVERLAY = Object.freeze({ api_key: 'owner-grading-overlay-key', probe_task: 'list_creatives' });
const SANDBOX_A_AUTH = Object.freeze({
  api_key: 'demo-sandbox-a-key',
  basic: { username: 'demo-a-user', password: 'demo-a-password' },
  probe_task: 'get_signals',
});
const SANDBOX_B_AUTH = Object.freeze({ api_key: 'demo-sandbox-b-key', probe_task: 'list_creatives' });
const LIVE_AUTH = Object.freeze({ api_key: 'live-principal-key', probe_task: 'list_creatives' });
const STALE_PROBE_AUTH = Object.freeze({ api_key: 'demo-stale-key', probe_task: 'not_an_allowlisted_probe' });

const KITS = {
  'sandbox-a.yaml': { id: 'sandbox_a', sandbox: true, fixture_marker: 'a', auth: SANDBOX_A_AUTH },
  'sandbox-b.yaml': { id: 'sandbox_b', sandbox: true, fixture_marker: 'b', auth: SANDBOX_B_AUTH },
  'live.yaml': { id: 'live', sandbox: false, fixture_marker: 'live', auth: LIVE_AUTH },
  'runner.yaml': { id: 'runner', applies_to: ['runner'], fixture_marker: 'runner' },
  'stale-probe.yaml': { id: 'stale_probe', sandbox: true, fixture_marker: 'stale', auth: STALE_PROBE_AUTH },
};

// Universal storyboards, in run order: kit-less storyboards run after a kit
// storyboard, so a fixture leaking from one storyboard to the next shows up.
const STORYBOARDS = [
  { file: 'kit-a', id: 'kit_a', kit: 'test-kits/sandbox-a.yaml', marker: 'a' },
  { file: 'no-kit', id: 'no_kit' },
  { file: 'kit-live', id: 'kit_live', kit: 'test-kits/live.yaml', marker: 'live' },
  { file: 'kit-b', id: 'kit_b', kit: 'test-kits/sandbox-b.yaml', marker: 'b' },
  { file: 'missing-kit', id: 'missing_kit', kit: 'test-kits/missing.yaml' },
];

function kitYaml(kit) {
  return JSON.stringify(kit);
}

const FROM_TEST_KIT_AUTH = `
          type: api_key
          from_test_kit: true`;

function probeStep(id, request, auth = FROM_TEST_KIT_AUTH) {
  return `      - id: ${id}
        title: ${id}
        task: __test_probe
        auth: ${auth}
        sample_request: ${JSON.stringify(request)}
        validations:
          - check: field_present
            path: probed
            description: probe answered
`;
}

function phase(id, skipIf, steps) {
  return `  - id: ${id}
    title: ${id}
${skipIf ? `    skip_if: ${JSON.stringify(skipIf)}\n` : ''}    steps:
${steps.join('')}`;
}

function unauthenticatedStep(id) {
  return probeStep(`${id}_unauthenticated`, { storyboard: id, unauthenticated: true }, 'none');
}

function storyboardYaml({ id, kit, marker }) {
  const phases = marker
    ? [
        phase('own_fixture', `test_kit.fixture_marker != '${marker}'`, [
          probeStep(`${id}_probe`, { storyboard: id }),
          ...(id === 'kit_a' ? [unauthenticatedStep(id)] : []),
        ]),
      ]
    : [
        phase('credential', undefined, [
          probeStep(`${id}_probe`, { storyboard: id }),
          ...(id === 'no_kit' ? [unauthenticatedStep(id)] : []),
        ]),
        phase('leak', '!test_kit.fixture_marker', [probeStep(`${id}_leak`, { storyboard: id, leaked: true })]),
      ];
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
${kit ? `prerequisites:\n  test_kit: ${kit}\n` : ''}invariants:
  disable:
    - status.monotonic
    - impairment.coherence
phases:
${phases.join('')}`;
}

function writeComplianceCache() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-test-kit-auth-'));
  fs.mkdirSync(path.join(dir, 'universal'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'test-kits'), { recursive: true });
  for (const [file, kit] of Object.entries(KITS)) {
    fs.writeFileSync(path.join(dir, 'test-kits', file), kitYaml(kit));
  }
  for (const storyboard of STORYBOARDS) {
    fs.writeFileSync(path.join(dir, 'universal', `${storyboard.file}.yaml`), storyboardYaml(storyboard));
  }
  fs.writeFileSync(
    path.join(dir, 'index.json'),
    JSON.stringify({
      adcp_version: ADCP_VERSION,
      generated_at: new Date().toISOString(),
      universal: STORYBOARDS.map(storyboard => storyboard.file),
      protocols: [],
      specialisms: [],
    })
  );
  return dir;
}

function toolResult(res, id, structuredContent) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      id,
      result: { structuredContent, content: [{ type: 'text', text: JSON.stringify(structuredContent) }] },
    })
  );
}

async function startAgent() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const rpc = raw ? JSON.parse(raw) : {};
    requests.push({
      method: rpc.method,
      tool: rpc.params?.name,
      args: rpc.params?.arguments,
      authorization: req.headers.authorization,
      adcpAuth: req.headers['x-adcp-auth'],
    });
    if (rpc.method === 'initialize') {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'test-kit-auth-session' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            serverInfo: { name: 'test-kit-auth', version: '1.0.0' },
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
    if (rpc.method === 'tools/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            tools: ['__test_probe', 'get_adcp_capabilities'].map(name => ({ name, inputSchema: { type: 'object' } })),
          },
        })
      );
      return;
    }
    if (rpc.params?.name === 'get_adcp_capabilities') {
      return toolResult(res, rpc.id, {
        adcp: {
          major_versions: [3],
          supported_versions: [toReleasePrecisionVersion(ADCP_VERSION)],
          build_version: ADCP_VERSION,
          idempotency: { supported: false },
        },
        supported_protocols: ['media_buy'],
        specialisms: [],
      });
    }
    return toolResult(res, rpc.id, { probed: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    requests,
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    probesFor: storyboardId =>
      requests.filter(
        r => r.tool === '__test_probe' && r.args?.storyboard === storyboardId && !r.args?.unauthenticated
      ),
    unauthenticatedProbes: () => requests.filter(r => r.tool === '__test_probe' && r.args?.unauthenticated),
    reset: () => requests.splice(0),
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

function withoutAuth(kit) {
  const { auth: _auth, ...rest } = kit;
  return rest;
}

describe('resolveDeclaredTestKit with test_kit_auth', () => {
  let complianceDir;

  before(() => {
    complianceDir = writeComplianceCache();
  });

  after(() => {
    fs.rmSync(complianceDir, { recursive: true, force: true });
  });

  function resolveFor(kitPath, extra = {}) {
    const storyboard = { id: 'overlay_probe', ...(kitPath && { prerequisites: { test_kit: kitPath } }) };
    return resolveDeclaredTestKit(storyboard, { complianceDir, test_kit_auth: OVERLAY, ...extra });
  }

  test('a sandbox kit keeps its fixtures and its whole auth block becomes the overlay', () => {
    const resolved = resolveFor('test-kits/sandbox-a.yaml');
    assert.deepEqual(resolved.test_kit, { ...withoutAuth(KITS['sandbox-a.yaml']), auth: OVERLAY });
    assert.equal(JSON.stringify(resolved).includes(SANDBOX_A_AUTH.api_key), false);
    assert.equal(JSON.stringify(resolved).includes(SANDBOX_A_AUTH.basic.password), false);
    assert.equal('test_kit_auth' in resolved, false, 'the overlay is consumed');
    // Consumed, so resolving again (nested runner entry points) neither
    // throws for test_kit + test_kit_auth nor swaps the kit.
    const again = { id: 'again', prerequisites: { test_kit: 'test-kits/live.yaml' } };
    assert.equal(resolveDeclaredTestKit(again, resolved), resolved);
  });

  test('a live-mode kit keeps its own credential, and the overlay is still consumed', () => {
    const resolved = resolveFor('test-kits/live.yaml');
    assert.deepEqual(resolved.test_kit, KITS['live.yaml']);
    assert.equal('test_kit_auth' in resolved, false);
  });

  test('a kit without auth gets the overlay', () => {
    const resolved = resolveFor('test-kits/runner.yaml');
    assert.deepEqual(resolved.test_kit, { ...KITS['runner.yaml'], auth: OVERLAY });
  });

  test('a storyboard that declares no kit gets the overlay alone', () => {
    assert.deepEqual(resolveFor(undefined).test_kit, { auth: OVERLAY });
  });

  test('a declared kit that cannot be loaded gets no overlay, and the overlay is still consumed', () => {
    // Nothing says an unloadable kit is not a live-mode principal, so its
    // from_test_kit steps must fail closed rather than send the overlay.
    for (const resolved of [
      resolveFor('test-kits/missing.yaml'),
      resolveFor('test-kits/live.yaml', { complianceDir: undefined }),
    ]) {
      assert.equal(resolved.test_kit, undefined);
      assert.equal('test_kit_auth' in resolved, false);
    }
  });

  test('the merged kit is validated after the overlay, so a stale kit probe_task is replaced', () => {
    const storyboard = { id: 'stale_probe', prerequisites: { test_kit: 'test-kits/stale-probe.yaml' } };
    assert.throws(() => resolveDeclaredTestKit(storyboard, { complianceDir }), /not in the allowlist/);
    const resolved = resolveDeclaredTestKit(storyboard, { complianceDir, test_kit_auth: OVERLAY });
    assert.deepEqual(resolved.test_kit.auth, OVERLAY);
  });

  test('each storyboard resolves its own kit from the same run options', () => {
    const runOptions = Object.freeze({ complianceDir, test_kit_auth: OVERLAY });
    const kitA = resolveDeclaredTestKit(
      { id: 'a', prerequisites: { test_kit: 'test-kits/sandbox-a.yaml' } },
      runOptions
    );
    const kitB = resolveDeclaredTestKit(
      { id: 'b', prerequisites: { test_kit: 'test-kits/sandbox-b.yaml' } },
      runOptions
    );
    const none = resolveDeclaredTestKit({ id: 'none' }, runOptions);
    assert.equal(kitA.test_kit.fixture_marker, 'a');
    assert.equal(kitB.test_kit.fixture_marker, 'b');
    assert.deepEqual(none.test_kit, { auth: OVERLAY });
    assert.equal(runOptions.test_kit, undefined, 'the shared run options are not changed');
  });

  test('test_kit and test_kit_auth together throw', () => {
    assert.throws(
      () => resolveFor('test-kits/sandbox-a.yaml', { test_kit: { auth: SANDBOX_B_AUTH } }),
      err => err.name === 'TestKitValidationError' && err.field === 'test_kit_auth' && /not both/.test(err.message)
    );
  });

  test('the overlay follows the test_kit.auth rules, probe_task included', () => {
    const storyboard = { id: 'invalid_overlay' };
    assert.throws(
      () => resolveDeclaredTestKit(storyboard, { test_kit_auth: { api_key: OVERLAY.api_key } }),
      err => err.name === 'TestKitValidationError' && err.field === 'test_kit_auth.probe_task'
    );
    assert.throws(
      () =>
        resolveDeclaredTestKit(storyboard, { test_kit_auth: { api_key: 'line\nbreak', probe_task: 'list_creatives' } }),
      err => err.field === 'test_kit_auth.api_key'
    );
  });
});

describe('comply() with test_kit_auth', () => {
  let agent;
  let complianceDir;

  before(async () => {
    complianceDir = writeComplianceCache();
    agent = await startAgent();
  });

  after(async () => {
    await agent.close();
    fs.rmSync(complianceDir, { recursive: true, force: true });
  });

  function run(options) {
    agent.reset();
    return comply(agent.url, { allow_http: true, complianceDir, ...options });
  }

  function assertUnauthenticatedProbesCarryNoCredential() {
    const probes = agent.unauthenticatedProbes();
    assert.deepEqual(probes.map(p => p.args.storyboard).sort(), ['kit_a', 'no_kit']);
    for (const probe of probes) {
      assert.equal(probe.authorization, undefined, `${probe.args.storyboard} auth: none sent no Authorization`);
      assert.equal(probe.adcpAuth, undefined, `${probe.args.storyboard} auth: none sent no x-adcp-auth`);
    }
  }

  test('every storyboard gets its own kit fixtures, with the overlay credential except on the live kit', async () => {
    await run({ auth: { type: 'bearer', token: TRANSPORT_TOKEN }, test_kit_auth: OVERLAY });

    for (const id of ['kit_a', 'kit_b', 'no_kit']) {
      const probes = agent.probesFor(id);
      assert.equal(probes.length, 1, `${id} sent exactly its own probe, and no leak probe`);
      assert.equal(probes[0].authorization, `Bearer ${OVERLAY.api_key}`, `${id} used the overlay credential`);
    }
    const liveProbes = agent.probesFor('kit_live');
    assert.equal(liveProbes.length, 1);
    assert.equal(liveProbes[0].authorization, `Bearer ${LIVE_AUTH.api_key}`, 'the live-mode kit keeps its principal');
    assert.equal(agent.probesFor('missing_kit').length, 0, 'an unloadable declared kit fails closed');
    assertUnauthenticatedProbesCarryNoCredential();

    for (const request of agent.requests) {
      assert.equal(request.args?.leaked, undefined, 'no kit fixture leaked into a kit-less storyboard');
      for (const demoKey of [SANDBOX_A_AUTH.api_key, SANDBOX_B_AUTH.api_key]) {
        assert.equal(JSON.stringify(request).includes(demoKey), false, 'no sandbox kit credential reaches the agent');
      }
    }
  });

  test('without run-level auth, comply() discovery authenticates with the overlay', async () => {
    await run({ test_kit_auth: OVERLAY });
    // Only comply()'s own discovery, before any storyboard runs: inside the
    // live-mode storyboard the transport falls back to that kit's principal.
    const firstProbe = agent.requests.findIndex(r => r.tool === '__test_probe');
    assert.ok(firstProbe > 0);
    const discovery = agent.requests.slice(0, firstProbe).filter(r => r.tool === 'get_adcp_capabilities');
    assert.ok(discovery.length > 0);
    for (const request of discovery) assert.equal(request.authorization, `Bearer ${OVERLAY.api_key}`);
    assertUnauthenticatedProbesCarryNoCredential();
  });

  test('test_kit and test_kit_auth together are refused before the agent is contacted', async () => {
    await assert.rejects(
      run({ test_kit: { auth: SANDBOX_B_AUTH }, test_kit_auth: OVERLAY }),
      err => err.name === 'TestKitValidationError' && err.field === 'test_kit_auth'
    );
    assert.equal(agent.requests.length, 0);
  });

  test('an overlay without probe_task is refused before the agent is contacted', async () => {
    await assert.rejects(
      run({ test_kit_auth: { api_key: OVERLAY.api_key } }),
      err => err.name === 'TestKitValidationError' && err.field === 'test_kit_auth.probe_task'
    );
    assert.equal(agent.requests.length, 0);
  });
});
