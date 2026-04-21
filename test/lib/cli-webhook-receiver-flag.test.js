/**
 * CLI plumbing for `--webhook-receiver` — closes adcontextprotocol/adcp-client#675.
 *
 * The runtime has long supported `webhook_receiver` on `runStoryboard` options;
 * without a CLI surface, storyboards whose grading depends on the receiver
 * (webhook-emission, idempotency) skip their webhook-assertion steps with
 * "Test-kit contract 'webhook_receiver_runner' is not configured on this runner."
 *
 * These tests exercise flag parsing and validation only — the webhook receiver
 * itself is covered in `test/lib/storyboard-webhook-receiver.test.js`.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const { writeFileSync, unlinkSync, mkdtempSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CLI = path.resolve(__dirname, '../../bin/adcp.js');

let tmpDir;
let scenarioPath;

before(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'adcp-cli-webhook-'));
  scenarioPath = path.join(tmpDir, 'scenario.yaml');
  writeFileSync(
    scenarioPath,
    [
      'id: cli-webhook-receiver-test',
      'title: CLI webhook-receiver test',
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

describe('storyboard run --webhook-receiver', () => {
  test('bare --webhook-receiver (loopback default) survives positional parsing', () => {
    const result = runCli(['storyboard', 'run', 'test-mcp', '--file', scenarioPath, '--webhook-receiver', '--dry-run']);
    assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
    assert.match(result.stderr, /Running storyboard: CLI webhook-receiver test/);
  });

  test('explicit --webhook-receiver loopback accepted', () => {
    const result = runCli([
      'storyboard',
      'run',
      'test-mcp',
      '--file',
      scenarioPath,
      '--webhook-receiver',
      'loopback',
      '--dry-run',
    ]);
    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
  });

  test('invalid mode rejected with usage message', () => {
    const result = runCli([
      'storyboard',
      'run',
      'test-mcp',
      '--file',
      scenarioPath,
      '--webhook-receiver',
      'bogus',
      '--dry-run',
    ]);
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /--webhook-receiver value must be "loopback" or "proxy"/);
  });

  test('proxy mode without --webhook-receiver-public-url is rejected', () => {
    const result = runCli([
      'storyboard',
      'run',
      'test-mcp',
      '--file',
      scenarioPath,
      '--webhook-receiver',
      'proxy',
      '--dry-run',
    ]);
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /--webhook-receiver proxy requires --webhook-receiver-public-url/);
  });

  test('loopback mode with --webhook-receiver-public-url is rejected', () => {
    const result = runCli([
      'storyboard',
      'run',
      'test-mcp',
      '--file',
      scenarioPath,
      '--webhook-receiver',
      'loopback',
      '--webhook-receiver-public-url',
      'https://tunnel.example.com',
      '--dry-run',
    ]);
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /--webhook-receiver-public-url is only valid with --webhook-receiver proxy/);
  });

  test('--webhook-receiver-public-url alone implies proxy mode', () => {
    const result = runCli([
      'storyboard',
      'run',
      'test-mcp',
      '--file',
      scenarioPath,
      '--webhook-receiver-public-url',
      'https://tunnel.example.com',
      '--dry-run',
    ]);
    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
  });

  test('non-integer --webhook-receiver-port is rejected', () => {
    const result = runCli([
      'storyboard',
      'run',
      'test-mcp',
      '--file',
      scenarioPath,
      '--webhook-receiver-port',
      'abc',
      '--dry-run',
    ]);
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /--webhook-receiver-port must be an integer/);
  });

  test('out-of-range --webhook-receiver-port is rejected with a distinct message', () => {
    const result = runCli([
      'storyboard',
      'run',
      'test-mcp',
      '--file',
      scenarioPath,
      '--webhook-receiver-port',
      '99999',
      '--dry-run',
    ]);
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /--webhook-receiver-port must be between 0 and 65535/);
  });

  test('--webhook-receiver-port 0 (auto-assign) is accepted', () => {
    // Regression guard: "0" is a falsy string. A naive `.filter(Boolean)` on
    // the positional-arg exclusion list would drop it and leak it into
    // positionalArgs. Must pass cleanly.
    const result = runCli([
      'storyboard',
      'run',
      'test-mcp',
      '--file',
      scenarioPath,
      '--webhook-receiver',
      '--webhook-receiver-port',
      '0',
      '--dry-run',
    ]);
    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
  });

  test('--webhook-receiver followed by a storyboard ID does not consume the ID as mode', () => {
    // Footgun check: `--webhook-receiver` takes an OPTIONAL value. An operator
    // writing `... --webhook-receiver webhook-emission` (expecting webhook-emission
    // to be the positional storyboard ID) must fail with a mode error, not
    // silently swallow the ID. This test locks in the fail-loudly contract.
    const result = runCli(['storyboard', 'run', 'test-mcp', '--webhook-receiver', 'webhook-emission', '--dry-run']);
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /--webhook-receiver value must be "loopback" or "proxy"/);
    assert.match(result.stderr, /Omit the value to use the default/);
  });

  test('--webhook-receiver is rejected alongside --multi-instance-strategy multi-pass', () => {
    // Place the storyboard bundle id between `--webhook-receiver` and any
    // further flags so the optional mode value is not consumed.
    const result = runCli([
      'storyboard',
      'run',
      'idempotency',
      '--url',
      'https://a.example.com',
      '--url',
      'https://b.example.com',
      '--multi-instance-strategy',
      'multi-pass',
      '--webhook-receiver',
    ]);
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /incompatible with --multi-instance-strategy multi-pass/);
  });
});
