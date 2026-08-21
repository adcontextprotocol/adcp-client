// adcp#6735 — a storyboard's declared `prerequisites.test_kit` is a runner
// loading directive, not decoration. These tests cover the resolution matrix:
// declared kit auto-loads from the compliance cache; caller-supplied
// options.test_kit wins; an unresolvable from_test_kit credential fails the
// step with an explicit configuration error instead of silently sending an
// unauthenticated probe; and declared paths cannot escape the cache root.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const os = require('node:os');

const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner');
const { resolveDeclaredTestKit } = require('../../dist/lib/testing/storyboard/test-kit');

const KIT_KEY = 'demo-declared-kit-key';

function storyboardWithKit(prerequisites) {
  return {
    id: 'declared_kit_probe',
    version: '1.0.0',
    title: 'Declared-kit credential delivery',
    category: 'security',
    summary: '',
    narrative: '',
    agent: { interaction_model: '*', capabilities: [] },
    caller: { role: 'buyer_agent' },
    ...(prerequisites ? { prerequisites } : {}),
    phases: [
      {
        id: 'probe',
        title: 'Credentialed probe',
        steps: [
          {
            id: 'kit_auth_step',
            title: 'Step authenticates with the kit credential',
            task: 'comply_test_controller',
            auth: { type: 'api_key', from_test_kit: true },
            expect_error: true,
            sample_request: {
              scenario: 'force_creative_status',
              params: { creative_id: 'probe-000', status: 'approved' },
              account: { sandbox: true },
              context: { correlation_id: 'declared_kit_probe--kit_auth_step' },
            },
            validations: [
              { check: 'field_value', path: 'success', allowed_values: [false], description: 'request rejected' },
              { check: 'field_value', path: 'error', allowed_values: ['FORBIDDEN'], description: 'denied' },
            ],
          },
        ],
      },
    ],
  };
}

function makeCacheDirWithKit() {
  const dir = mkdtempSync(join(os.tmpdir(), 'adcp-declared-kit-'));
  mkdirSync(join(dir, 'test-kits'), { recursive: true });
  writeFileSync(
    join(dir, 'test-kits', 'live.yaml'),
    ['auth:', `  api_key: "${KIT_KEY}"`, '  probe_task: list_creatives', ''].join('\n')
  );
  return dir;
}

function captureAgent(calls) {
  return http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (rpc.method === 'initialize') {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'declared-kit-test' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            serverInfo: { name: 'declared-kit-capture', version: '1.0.0' },
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
    calls.push({ authorization: req.headers.authorization, name: rpc.params?.name });
    const payload = { success: false, error: 'FORBIDDEN', context: rpc.params?.arguments?.context };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: rpc.id,
        result: { structuredContent: payload, content: [{ type: 'text', text: JSON.stringify(payload) }] },
      })
    );
  });
}

const RUN_OPTIONS = {
  protocol: 'mcp',
  allow_http: true,
  agentTools: ['comply_test_controller'],
  _profile: { name: 'declared-kit-capture', tools: [{ name: 'comply_test_controller' }] },
  _client: {
    getAgentInfo: async () => ({ name: 'declared-kit-capture', tools: [{ name: 'comply_test_controller' }] }),
  },
};

test('declared prerequisites.test_kit auto-loads and its credential reaches the step', async () => {
  const cacheDir = makeCacheDirWithKit();
  const calls = [];
  const server = captureAgent(calls);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await runStoryboard(
      `http://127.0.0.1:${server.address().port}/mcp`,
      storyboardWithKit({ test_kit: 'test-kits/live.yaml' }),
      { ...RUN_OPTIONS, complianceDir: cacheDir }
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].authorization, `Bearer ${KIT_KEY}`);
    assert.equal(result.phases[0].steps[0].passed, true, JSON.stringify(result.phases[0].steps[0]));
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('caller-supplied options.test_kit wins over the declared kit', async () => {
  const cacheDir = makeCacheDirWithKit();
  const calls = [];
  const server = captureAgent(calls);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await runStoryboard(
      `http://127.0.0.1:${server.address().port}/mcp`,
      storyboardWithKit({ test_kit: 'test-kits/live.yaml' }),
      {
        ...RUN_OPTIONS,
        complianceDir: cacheDir,
        test_kit: { auth: { api_key: 'caller-override-key', probe_task: 'list_creatives' } },
      }
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].authorization, 'Bearer caller-override-key');
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('from_test_kit with no kit anywhere fails the step, never sends an unauthenticated probe', async () => {
  const calls = [];
  const server = captureAgent(calls);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await runStoryboard(
      `http://127.0.0.1:${server.address().port}/mcp`,
      storyboardWithKit(undefined),
      RUN_OPTIONS
    );
    const step = result.phases[0].steps[0];
    assert.equal(step.passed, false);
    assert.match(step.error ?? '', /auth configuration error/i);
    assert.equal(calls.length, 0, 'no tools/call must reach the agent without a credential');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('basic-auth from_test_kit with no kit anywhere fails the step, never sends an unauthenticated probe', async () => {
  const calls = [];
  const server = captureAgent(calls);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const storyboard = storyboardWithKit(undefined);
    storyboard.phases[0].steps[0].auth = { type: 'basic', from_test_kit: true };
    const result = await runStoryboard(`http://127.0.0.1:${server.address().port}/mcp`, storyboard, RUN_OPTIONS);
    const step = result.phases[0].steps[0];
    assert.equal(step.passed, false);
    assert.match(step.error ?? '', /auth configuration error/i);
    assert.match(step.error ?? '', /basic/i);
    assert.equal(calls.length, 0, 'no tools/call must reach the agent without a credential');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('declared kit paths cannot escape the compliance cache root', () => {
  const cacheDir = makeCacheDirWithKit();
  try {
    assert.throws(
      () =>
        resolveDeclaredTestKit(
          { id: 'escape_probe', prerequisites: { test_kit: '../outside.yaml' } },
          { complianceDir: cacheDir }
        ),
      /outside the compliance cache root/
    );
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('a declared kit missing from the cache is tolerated at load time (step-level hard-fail covers users)', () => {
  const cacheDir = mkdtempSync(join(os.tmpdir(), 'adcp-declared-kit-missing-'));
  try {
    const options = { complianceDir: cacheDir };
    const resolved = resolveDeclaredTestKit(
      { id: 'missing_kit_probe', prerequisites: { test_kit: 'test-kits/nope.yaml' } },
      options
    );
    assert.equal(resolved.test_kit, undefined);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('a declared kit that exists but is invalid YAML throws', () => {
  const cacheDir = mkdtempSync(join(os.tmpdir(), 'adcp-declared-kit-corrupt-'));
  try {
    mkdirSync(join(cacheDir, 'test-kits'), { recursive: true });
    writeFileSync(join(cacheDir, 'test-kits', 'bad.yaml'), 'auth: [unclosed');
    assert.throws(
      () =>
        resolveDeclaredTestKit(
          { id: 'corrupt_kit_probe', prerequisites: { test_kit: 'test-kits/bad.yaml' } },
          { complianceDir: cacheDir }
        ),
      /not valid YAML/
    );
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
