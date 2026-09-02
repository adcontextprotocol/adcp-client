const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const { writeFileSync, unlinkSync, mkdtempSync, mkdirSync, rmSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

const CLI = path.resolve(__dirname, '../../bin/adcp.js');

let tmpDir;
let scenarioPath;

before(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'adcp-cli-'));
  scenarioPath = path.join(tmpDir, 'scenario.yaml');
  writeFileSync(
    scenarioPath,
    [
      'id: cli-file-flag-test',
      'title: CLI file-flag test',
      'protocol: media-buy',
      'phases:',
      '  - id: phase-1',
      '    title: Ping',
      '    steps:',
      '      - id: step-1',
      '        title: Ping',
      '        task: get_adcp_capabilities',
      '        request: {}',
      '',
    ].join('\n')
  );
});

after(() => {
  try {
    unlinkSync(scenarioPath);
  } catch {
    /* ignore */
  }
});

function runCli(args) {
  return spawnSync('node', [CLI, ...args], { encoding: 'utf8' });
}

function runCliAsync(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI, ...args], { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

function writeComplianceIndex(complianceDir, version) {
  mkdirSync(complianceDir, { recursive: true });
  writeFileSync(
    path.join(complianceDir, 'index.json'),
    JSON.stringify({ adcp_version: version, universal: [], protocols: [], specialisms: [] })
  );
}

test('--file <path> (space form) loads the YAML', () => {
  const result = runCli(['storyboard', 'run', 'test-mcp', '--file', scenarioPath, '--dry-run']);
  assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
  assert.match(result.stderr, /Running storyboard: CLI file-flag test/);
  assert.doesNotMatch(result.stderr, /Cannot combine a storyboard ID with --file/);
});

test('--file=<path> (equals form) loads the YAML', () => {
  const result = runCli(['storyboard', 'run', 'test-mcp', `--file=${scenarioPath}`, '--dry-run']);
  assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
  assert.match(result.stderr, /Running storyboard: CLI file-flag test/);
});

test('--file before positional agent loads the YAML', () => {
  const result = runCli(['storyboard', 'run', '--file', scenarioPath, 'test-mcp', '--dry-run']);
  assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
  assert.match(result.stderr, /Running storyboard: CLI file-flag test/);
});

test('--file combined with a storyboard ID is rejected', () => {
  const result = runCli(['storyboard', 'run', 'test-mcp', 'some-id', '--file', scenarioPath, '--dry-run']);
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /Cannot combine a storyboard ID with --file/);
});

test('--compliance-version fails before dry-run when matching schemas are unavailable', () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'adcp-cli-compliance-missing-schema-'));
  const complianceDir = path.join(tempRoot, 'compliance-cache', '9.9.0-beta.1');
  const oldComplianceDir = process.env.ADCP_COMPLIANCE_DIR;
  const oldSchemaRoot = process.env.ADCP_SCHEMA_ROOT;
  try {
    process.env.ADCP_COMPLIANCE_DIR = complianceDir;
    delete process.env.ADCP_SCHEMA_ROOT;
    writeComplianceIndex(complianceDir, '9.9.0-beta.1');

    const result = runCli([
      'storyboard',
      'run',
      'test-mcp',
      '--file',
      scenarioPath,
      '--dry-run',
      '--compliance-version',
      '9.9.0-beta.1',
    ]);

    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /--compliance-version 9\.9\.0-beta\.1 selected AdCP compliance version/);
    assert.match(result.stderr, /installed default schemas/);
    assert.match(result.stderr, /--schema-root/);
  } finally {
    if (oldComplianceDir === undefined) delete process.env.ADCP_COMPLIANCE_DIR;
    else process.env.ADCP_COMPLIANCE_DIR = oldComplianceDir;
    if (oldSchemaRoot === undefined) delete process.env.ADCP_SCHEMA_ROOT;
    else process.env.ADCP_SCHEMA_ROOT = oldSchemaRoot;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('--compliance-version rejects an environment cache from a different protocol line', () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'adcp-cli-compliance-version-mismatch-'));
  const complianceDir = path.join(tempRoot, 'compliance-cache', '3.1.13');
  const oldComplianceDir = process.env.ADCP_COMPLIANCE_DIR;
  try {
    process.env.ADCP_COMPLIANCE_DIR = complianceDir;
    writeComplianceIndex(complianceDir, '3.1.13');

    const result = runCli([
      'storyboard',
      'run',
      'test-mcp',
      '--file',
      scenarioPath,
      '--dry-run',
      '--compliance-version',
      '3.2.0-beta.6',
    ]);

    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /--compliance-version 3\.2\.0-beta\.6/);
    assert.match(result.stderr, /cache that declares AdCP 3\.1\.13/);
  } finally {
    if (oldComplianceDir === undefined) delete process.env.ADCP_COMPLIANCE_DIR;
    else process.env.ADCP_COMPLIANCE_DIR = oldComplianceDir;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('multi-target --file modes infer version and schemas from --compliance-dir before dry-run', () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'adcp-cli-multi-file-schema-'));
  const complianceDir = path.join(tempRoot, 'compliance-cache', '9.9.0-beta.1');
  try {
    writeComplianceIndex(complianceDir, '9.9.0-beta.1');
    const common = [
      '--protocol',
      'mcp',
      '--allow-http',
      '--file',
      scenarioPath,
      '--compliance-dir',
      complianceDir,
      '--dry-run',
    ];
    const multiInstance = runCli([
      'storyboard',
      'run',
      '--url',
      'http://127.0.0.1:1/mcp',
      '--url',
      'http://127.0.0.1:2/mcp',
      ...common,
    ]);
    assert.strictEqual(multiInstance.status, 2);
    assert.match(multiInstance.stderr, /matching schemas|--schema-root|installed default schemas/);

    const routed = runCli([
      'storyboard',
      'run',
      '--agent',
      'default=http://127.0.0.1:1/mcp',
      '--default-agent',
      'default',
      ...common,
    ]);
    assert.strictEqual(routed.status, 2);
    assert.match(routed.stderr, /matching schemas|--schema-root|installed default schemas/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('--file forwards explicit cache authority for a declared test kit', { timeout: 60_000 }, async t => {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'adcp-cli-declared-kit-'));
  const complianceDir = path.join(fixtureRoot, 'compliance');
  const kitDir = path.join(complianceDir, 'test-kits');
  const storyboardPath = path.join(fixtureRoot, 'storyboard.yaml');
  const cliHome = path.join(fixtureRoot, 'home');
  mkdirSync(kitDir, { recursive: true });
  mkdirSync(cliHome, { recursive: true });
  writeComplianceIndex(complianceDir, '3.2.0-beta.11');
  writeFileSync(
    path.join(kitDir, 'live.yaml'),
    ['auth:', '  api_key: "cli-declared-kit-key"', '  probe_task: list_creatives', ''].join('\n')
  );
  writeFileSync(
    storyboardPath,
    [
      'id: cli-declared-kit',
      'title: CLI declared-kit forwarding',
      'protocol: media-buy',
      'prerequisites:',
      '  test_kit: test-kits/live.yaml',
      'phases:',
      '  - id: phase-1',
      '    title: Authenticated capabilities',
      '    steps:',
      '      - id: step-1',
      '        title: Authenticated capabilities',
      '        task: get_adcp_capabilities',
      '        auth:',
      '          type: api_key',
      '          from_test_kit: true',
      '        request: {}',
      '',
    ].join('\n')
  );

  const authorizations = [];
  const server = http.createServer(async (req, res) => {
    authorizations.push(req.headers.authorization);
    const mcp = new McpServer({ name: 'cli-declared-kit-capture', version: '1.0.0' });
    mcp.registerTool('get_adcp_capabilities', { inputSchema: {} }, async () => ({
      content: [{ type: 'text', text: '{}' }],
      structuredContent: {
        success: true,
        adcp: { major_versions: [3], idempotency: { supported: true, replay_ttl_seconds: 86400 } },
        supported_protocols: ['media_buy'],
        specialisms: [],
      },
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } finally {
      await mcp.close();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  const run = async (selectionArgs, env = {}) => {
    authorizations.length = 0;
    return runCliAsync(
      [
        'storyboard',
        'run',
        `http://127.0.0.1:${server.address().port}/mcp`,
        '--protocol',
        'mcp',
        '--allow-http',
        '--file',
        storyboardPath,
        ...selectionArgs,
        '--soft-fail',
      ],
      { HOME: cliHome, ADCP_SKIP_VERSION_CHECK: '1', ...env }
    );
  };

  const explicitDir = await run(['--compliance-dir', complianceDir], { ADCP_COMPLIANCE_DIR: '' });
  assert.strictEqual(explicitDir.status, 0, explicitDir.stderr);
  assert.ok(authorizations.includes('Bearer cli-declared-kit-key'));

  const versionOnly = await run(['--compliance-version', '3.2.0-beta.11'], {
    ADCP_COMPLIANCE_DIR: complianceDir,
  });
  assert.strictEqual(versionOnly.status, 0, versionOnly.stderr);
  assert.equal(
    authorizations.includes('Bearer cli-declared-kit-key'),
    false,
    '--compliance-version must not authorize an ad-hoc storyboard to transmit cache credentials'
  );
  assert.match(
    `${versionOnly.stdout}\n${versionOnly.stderr}`,
    /no test kit with auth\.api_key is configured|no credential was resolved/
  );
});
