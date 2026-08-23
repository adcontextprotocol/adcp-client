// adcp#6735 — a storyboard's declared `prerequisites.test_kit` is a runner
// loading directive, not decoration. These tests cover the resolution matrix:
// declared kit auto-loads from the compliance cache; caller-supplied
// options.test_kit wins; an unresolvable from_test_kit credential fails the
// step with an explicit configuration error instead of silently sending an
// unauthenticated probe; and declared paths cannot escape the cache root.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } = require('node:fs');
const { join } = require('node:path');
const os = require('node:os');

const {
  runStoryboard,
  runStoryboardStep,
  applyStoryboardVersionOptions,
} = require('../../dist/lib/testing/storyboard/runner');
const { resolveDeclaredTestKit, validateTestKit } = require('../../dist/lib/testing/storyboard/test-kit');
const { loadBundleStoryboards } = require('../../dist/lib/testing/storyboard/compliance');
const { parseStoryboard } = require('../../dist/lib/testing/storyboard/loader');

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

test('runStoryboardStep resolves the declared kit used by printed fix commands', async () => {
  const cacheDir = makeCacheDirWithKit();
  const calls = [];
  const server = captureAgent(calls);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await runStoryboardStep(
      `http://127.0.0.1:${server.address().port}/mcp`,
      storyboardWithKit({ test_kit: 'test-kits/live.yaml' }),
      'kit_auth_step',
      { ...RUN_OPTIONS, complianceDir: cacheDir }
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].authorization, `Bearer ${KIT_KEY}`);
    assert.equal(result.passed, true, JSON.stringify(result));
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

test('basic-auth from_test_kit false preserves explicit credentials', async () => {
  const calls = [];
  const server = captureAgent(calls);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const storyboard = storyboardWithKit(undefined);
    storyboard.phases[0].steps[0].auth = {
      type: 'basic',
      from_test_kit: false,
      username: 'explicit-user',
      password: 'explicit-password',
    };
    const result = await runStoryboard(`http://127.0.0.1:${server.address().port}/mcp`, storyboard, RUN_OPTIONS);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].authorization, `Basic ${Buffer.from('explicit-user:explicit-password').toString('base64')}`);
    assert.equal(result.phases[0].steps[0].passed, true, JSON.stringify(result.phases[0].steps[0]));
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

test('declared kit symlinks cannot escape the physical compliance cache root', () => {
  const cacheDir = mkdtempSync(join(os.tmpdir(), 'adcp-declared-kit-symlink-cache-'));
  const outsideDir = makeCacheDirWithKit();
  try {
    mkdirSync(join(cacheDir, 'test-kits'), { recursive: true });
    symlinkSync(join(outsideDir, 'test-kits', 'live.yaml'), join(cacheDir, 'test-kits', 'live.yaml'));
    assert.throws(
      () =>
        resolveDeclaredTestKit(
          { id: 'symlink_escape_probe', prerequisites: { test_kit: 'test-kits/live.yaml' } },
          { complianceDir: cacheDir }
        ),
      /outside the physical compliance cache root/
    );
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('a declared kit path that is not a regular file fails explicitly', () => {
  const cacheDir = mkdtempSync(join(os.tmpdir(), 'adcp-declared-kit-directory-'));
  try {
    mkdirSync(join(cacheDir, 'test-kits', 'directory.yaml'), { recursive: true });
    assert.throws(
      () =>
        resolveDeclaredTestKit(
          { id: 'directory_probe', prerequisites: { test_kit: 'test-kits/directory.yaml' } },
          { complianceDir: cacheDir }
        ),
      /not a regular file/
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

test('a declared kit that exists but is invalid YAML throws without leaking source or local paths', () => {
  const cacheDir = mkdtempSync(join(os.tmpdir(), 'adcp-declared-kit-corrupt-'));
  const secret = 'sk-secret-that-must-not-reach-logs';
  try {
    mkdirSync(join(cacheDir, 'test-kits'), { recursive: true });
    writeFileSync(join(cacheDir, 'test-kits', 'bad.yaml'), `auth: [${secret}`);
    let error;
    try {
      resolveDeclaredTestKit(
        { id: 'corrupt_kit_probe', prerequisites: { test_kit: 'test-kits/bad.yaml' } },
        { complianceDir: cacheDir }
      );
    } catch (err) {
      error = err;
    }
    assert.ok(error instanceof Error);
    assert.match(error.message, /not valid YAML/);
    assert.equal(error.message.includes(secret), false);
    assert.equal(error.message.includes(cacheDir), false);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('valid YAML with invalid test-kit shapes fails at the file boundary', () => {
  const cacheDir = mkdtempSync(join(os.tmpdir(), 'adcp-declared-kit-shape-'));
  try {
    mkdirSync(join(cacheDir, 'test-kits'), { recursive: true });
    writeFileSync(join(cacheDir, 'test-kits', 'scalar.yaml'), 'not-a-mapping\n');
    assert.throws(
      () =>
        resolveDeclaredTestKit(
          { id: 'scalar_kit_probe', prerequisites: { test_kit: 'test-kits/scalar.yaml' } },
          { complianceDir: cacheDir }
        ),
      /test_kit must be a YAML mapping/
    );
    writeFileSync(join(cacheDir, 'test-kits', 'auth-scalar.yaml'), 'auth: not-a-mapping\n');
    assert.throws(
      () =>
        resolveDeclaredTestKit(
          { id: 'scalar_auth_probe', prerequisites: { test_kit: 'test-kits/auth-scalar.yaml' } },
          { complianceDir: cacheDir }
        ),
      /test_kit.auth must be a YAML mapping/
    );
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('declared test-kit paths must be non-empty strings', () => {
  assert.throws(
    () =>
      resolveDeclaredTestKit(
        { id: 'invalid_declaration_probe', prerequisites: { test_kit: 42 } },
        { complianceDir: os.tmpdir() }
      ),
    /expected a non-empty string/
  );
});

test('a storyboard-authored version alone cannot authorize packaged-cache credential loading', () => {
  const options = { adcpVersion: '3.2.0-beta.5' };
  const resolved = resolveDeclaredTestKit(
    {
      id: 'untrusted_version_probe',
      adcp_version: '3.2.0-beta.5',
      prerequisites: { test_kit: 'test-kits/acme-outdoor-live.yaml' },
    },
    options
  );
  assert.equal(resolved, options);
  assert.equal(resolved.test_kit, undefined);
});

test('empty or malformed compliance roots cannot grant filesystem authority', () => {
  const storyboard = {
    id: 'invalid_root_probe',
    prerequisites: { test_kit: 'compliance/cache/3.2.0-beta.5/test-kits/acme-outdoor-live.yaml' },
  };
  for (const complianceDir of ['', '   ', null]) {
    assert.throws(
      () => resolveDeclaredTestKit(storyboard, { complianceDir }),
      /invalid complianceDir.*expected a non-empty string/
    );
  }
});

test('a malformed explicit test-kit override fails closed instead of falling back to disk', () => {
  const cacheDir = makeCacheDirWithKit();
  try {
    const options = { complianceDir: cacheDir, test_kit: null };
    const resolved = resolveDeclaredTestKit(
      { id: 'malformed_override_probe', prerequisites: { test_kit: 'test-kits/live.yaml' } },
      options
    );
    assert.equal(resolved, options);
    assert.throws(() => validateTestKit(resolved.test_kit), /test_kit must be a YAML mapping/);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('test-kit validation never echoes invalid probe_task values', () => {
  const misplacedSecret = 'sk-misplaced-secret-that-must-not-reach-reports';
  let error;
  try {
    validateTestKit({ auth: { probe_task: misplacedSecret } });
  } catch (err) {
    error = err;
  }
  assert.ok(error instanceof Error);
  assert.match(error.message, /not in the allowlist/);
  assert.equal(error.message.includes(misplacedSecret), false);
});

test('test-kit validation rejects malformed API keys without echoing them', () => {
  for (const api_key of [123, '', 'line-break\nsecret']) {
    let error;
    try {
      validateTestKit({ auth: { api_key, probe_task: 'list_creatives' } });
    } catch (err) {
      error = err;
    }
    assert.ok(error instanceof Error);
    assert.match(error.message, /api_key must be a non-empty string containing only printable ASCII/);
    if (String(api_key).length > 0) assert.equal(error.message.includes(String(api_key)), false);
  }
});

test('storyboard YAML cannot author compliance cache provenance', () => {
  assert.throws(
    () => parseStoryboard(JSON.stringify({ ...storyboardWithKit(undefined), compliance_dir: os.tmpdir() })),
    /compliance_dir is loader-owned runtime provenance/
  );
  const forged = { ...storyboardWithKit(undefined), compliance_dir: os.tmpdir() };
  assert.equal(applyStoryboardVersionOptions(forged, {}).complianceDir, undefined);
});

test('the compliance loader attaches trusted cache provenance out of band', () => {
  const cacheDir = mkdtempSync(join(os.tmpdir(), 'adcp-declared-kit-provenance-'));
  const storyboardPath = join(cacheDir, 'universal', 'declared-kit.yaml');
  try {
    mkdirSync(join(cacheDir, 'universal'), { recursive: true });
    writeFileSync(storyboardPath, JSON.stringify(storyboardWithKit(undefined)));
    const [loaded] = loadBundleStoryboards({
      kind: 'universal',
      id: 'declared-kit',
      path: storyboardPath,
      adcp_version: '3.2.0-beta.5',
    });
    assert.ok(loaded);
    assert.equal(applyStoryboardVersionOptions(loaded, {}).complianceDir, cacheDir);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
