// CLI smoke test for `adcp fuzz`. Verifies flag parsing, --help, and
// end-to-end execution against an in-process signals agent.

const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');

const { serve, createAdcpServer } = require('../../dist/lib/index.js');

const CLI = path.resolve(__dirname, '../../bin/adcp.js');

function runCli(args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [CLI, 'fuzz', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ADCP_ALLOW_V2: '1' },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => (stdout += d.toString()));
    proc.stderr.on('data', d => (stderr += d.toString()));
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`CLI timed out after ${timeoutMs}ms: ${stderr}`));
    }, timeoutMs);
    proc.on('exit', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function waitForListening(server) {
  return new Promise(resolve => {
    if (server.listening) return resolve();
    server.on('listening', resolve);
  });
}

describe('adcp fuzz CLI', () => {
  let httpServer;
  let port;

  test('setup: start in-process signals agent', async () => {
    httpServer = serve(
      () =>
        createAdcpServer({
          name: 'CLI Smoke Agent',
          version: '1.0.0',
          signals: { getSignals: async () => ({ signals: [] }) },
        }),
      { port: 0, onListening: () => {} }
    );
    await waitForListening(httpServer);
    port = httpServer.address().port;
  });

  after(() => httpServer?.close());

  test('--help prints usage and exits 0', async () => {
    const { code, stdout } = await runCli(['--help']);
    assert.equal(code, 0);
    assert.match(stdout, /Usage: adcp fuzz/);
    assert.match(stdout, /--fixture/);
  });

  test('--list-tools prints the default tool set', async () => {
    const { code, stdout } = await runCli(['--list-tools']);
    assert.equal(code, 0);
    assert.match(stdout, /get_signals/);
    assert.match(stdout, /get_creative_delivery/);
  });

  test('unknown flag → exit 2 with usage hint', async () => {
    const { code, stderr } = await runCli(['http://localhost:1/mcp', '--nope']);
    assert.equal(code, 2);
    assert.match(stderr, /unknown flag/);
  });

  test('exits 0 against a clean agent', async () => {
    const { code, stdout } = await runCli([
      `http://localhost:${port}/mcp`,
      '--seed',
      '7',
      '--tools',
      'get_signals',
      '--turn-budget',
      '3',
      '--protocol',
      'mcp',
    ]);
    assert.equal(code, 0, `CLI exited non-zero with stdout: ${stdout}`);
    assert.match(stdout, /Conformance report/);
    assert.match(stdout, /get_signals/);
    assert.match(stdout, /Failures: 0/);
  });

  test('--format json emits a parseable report', async () => {
    const { code, stdout } = await runCli([
      `http://localhost:${port}/mcp`,
      '--seed',
      '11',
      '--tools',
      'get_signals',
      '--turn-budget',
      '2',
      '--protocol',
      'mcp',
      '--format',
      'json',
    ]);
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(typeof parsed.schemaVersion, 'string');
    assert.equal(typeof parsed.seed, 'number');
    assert.ok(parsed.perTool.get_signals);
  });

  test('--fixture parses into named ID pools', async () => {
    const { code, stdout } = await runCli([
      `http://localhost:${port}/mcp`,
      '--seed',
      '13',
      '--tools',
      'get_signals',
      '--turn-budget',
      '2',
      '--protocol',
      'mcp',
      '--fixture',
      'creative_ids=cre_1,cre_2',
      '--format',
      'json',
    ]);
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.totalFailures, 0);
  });

  test('--fixture with unknown pool → exit 2', async () => {
    const { code, stderr } = await runCli([`http://localhost:${port}/mcp`, '--fixture', 'banana_ids=x,y']);
    assert.equal(code, 2);
    assert.match(stderr, /unknown fixture pool/);
  });

  test('flag with missing value exits 2, not TypeError crash', async () => {
    // Regression: `argv[++i]` on the last token used to return `undefined`
    // and crash inside .indexOf / parseInt with exit code 1 and a Node
    // stack trace. Now every flag guards with requireValue().
    const { code, stderr } = await runCli([`http://localhost:${port}/mcp`, '--fixture']);
    assert.equal(code, 2);
    assert.match(stderr, /--fixture requires a value/);
  });

  test('empty fixture name → exit 2 with actionable message', async () => {
    const { code, stderr } = await runCli([`http://localhost:${port}/mcp`, '--fixture', '=cre_a']);
    assert.equal(code, 2);
    assert.match(stderr, /--fixture name is empty/);
  });

  test('--list-tools annotates Tier-2 tools', async () => {
    const { code, stdout } = await runCli(['--list-tools']);
    assert.equal(code, 0);
    assert.match(stdout, /get_signals\b/);
    assert.match(stdout, /get_property_list.*referential/);
  });

  test('clean-run output tells the user to pin the seed', async () => {
    const { code, stdout } = await runCli([
      `http://localhost:${port}/mcp`,
      '--seed',
      '7',
      '--tools',
      'get_signals',
      '--turn-budget',
      '2',
      '--protocol',
      'mcp',
    ]);
    assert.equal(code, 0);
    assert.match(stdout, /Pin this seed in CI: --seed 7/);
  });

  test('--list-tools marks Tier-3 update tools too', async () => {
    const { code, stdout } = await runCli(['--list-tools']);
    assert.equal(code, 0);
    assert.match(stdout, /update_media_buy.*update.*--auto-seed/);
  });

  test('--auto-seed surfaces seed warnings on the report', async () => {
    // The default signals agent from earlier tests has no create_* handlers,
    // so all three seeders will produce warnings. We just check the plumbing:
    // --auto-seed is honored, autoSeeded is set, warnings propagate.
    const { code, stdout } = await runCli([
      `http://localhost:${port}/mcp`,
      '--seed',
      '3',
      '--tools',
      'get_signals',
      '--turn-budget',
      '1',
      '--protocol',
      'mcp',
      '--auto-seed',
      '--format',
      'json',
    ]);
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.autoSeeded, true);
    assert.ok(Array.isArray(parsed.seedWarnings));
    // Seeders all fail against this stub (only getSignals is implemented) —
    // that's what we're asserting: the pipeline runs, records warnings,
    // and keeps fuzzing the tools that do work.
    assert.ok(parsed.seedWarnings.length >= 1);
  });

  test('JSON report includes reproducibility metadata', async () => {
    const { stdout } = await runCli([
      `http://localhost:${port}/mcp`,
      '--seed',
      '9',
      '--tools',
      'get_signals',
      '--turn-budget',
      '1',
      '--protocol',
      'mcp',
      '--fixture',
      'creative_ids=cre_a',
      '--format',
      'json',
    ]);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.protocol, 'mcp');
    assert.equal(parsed.turnBudget, 1);
    assert.deepEqual(parsed.fixturesUsed, { creative_ids: ['cre_a'] });
  });
});
