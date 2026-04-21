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
const { writeFileSync, chmodSync, unlinkSync, mkdtempSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CLI = path.resolve(__dirname, '../../bin/adcp.js');

let tmpDir;
let scenarioPath;
let stubTunnelPath;

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

  // Stub tunnel for --webhook-receiver-auto-tunnel tests. Emits a URL on
  // stdout using the `ADCP_TUNNEL_URL=<url>` marker the CLI's custom-template
  // path scans for, then sleeps until killed. Each test can adjust behavior
  // via env vars the stub reads.
  stubTunnelPath = path.join(tmpDir, 'fake-tunnel.sh');
  writeFileSync(
    stubTunnelPath,
    [
      '#!/bin/sh',
      '# Args: $1 = port (from {port} substitution in ADCP_WEBHOOK_TUNNEL)',
      'if [ "$FAKE_TUNNEL_EXIT_BEFORE_URL" = "1" ]; then',
      '  echo "tunnel startup failed" >&2',
      '  exit 1',
      'fi',
      'if [ "$FAKE_TUNNEL_SILENT" = "1" ]; then',
      '  # Never emit the marker — exercises the startup-timeout path.',
      '  while true; do sleep 60; done',
      'fi',
      'if [ -n "$FAKE_TUNNEL_NOISE_URL" ]; then',
      '  # Print a bystander URL (docs link, diagnostics) before the marker',
      '  # so we can assert the scanner ignores non-marker URLs.',
      '  echo "See $FAKE_TUNNEL_NOISE_URL for help"',
      'fi',
      'echo "ADCP_TUNNEL_URL=https://stub-${1:-0}.tunnel.test"',
      "# Stay alive until killed so the CLI doesn't see EOF.",
      'while true; do sleep 60; done',
      '',
    ].join('\n')
  );
  chmodSync(stubTunnelPath, 0o755);
});

after(() => {
  try {
    unlinkSync(scenarioPath);
  } catch {
    /* ignore */
  }
  try {
    unlinkSync(stubTunnelPath);
  } catch {
    /* ignore */
  }
});

function runCli(args, env = {}, { timeout = 10_000 } = {}) {
  // Use process.execPath so tests that zero out $PATH (e.g. the no-tunnel-binary
  // test) can still locate the node interpreter. The timeout guards against a
  // regression where auto-tunnel captures the URL but then hangs indefinitely
  // in the run path — without this the test would block CI.
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout,
    killSignal: 'SIGKILL',
  });
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

describe('storyboard run --webhook-receiver-auto-tunnel', () => {
  // The stub tunnel is fed via ADCP_WEBHOOK_TUNNEL so we don't depend on
  // ngrok/cloudflared being installed on the CI image. `{port}` is the
  // substitution placeholder documented in the CLI help.

  test('conflicts with --webhook-receiver-public-url', () => {
    const result = runCli(
      [
        'storyboard',
        'run',
        'test-mcp',
        '--file',
        scenarioPath,
        '--webhook-receiver-auto-tunnel',
        '--webhook-receiver-public-url',
        'https://already.tunnel.example.com',
        '--dry-run',
      ],
      { ADCP_WEBHOOK_TUNNEL: `${stubTunnelPath} {port}` }
    );
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /--webhook-receiver-auto-tunnel conflicts with --webhook-receiver-public-url/);
  });

  test('conflicts with any --webhook-receiver flag (auto-tunnel implies proxy)', () => {
    // Bare `--webhook-receiver` (defaults to loopback), explicit `loopback`,
    // and explicit `proxy` all collide with auto-tunnel — rejected uniformly
    // so operators don't silently get their --webhook-receiver ignored.
    for (const extra of [['--webhook-receiver'], ['--webhook-receiver', 'loopback'], ['--webhook-receiver', 'proxy']]) {
      const result = runCli(
        [
          'storyboard',
          'run',
          'test-mcp',
          '--file',
          scenarioPath,
          ...extra,
          '--webhook-receiver-auto-tunnel',
          '--dry-run',
        ],
        { ADCP_WEBHOOK_TUNNEL: `${stubTunnelPath} {port}` }
      );
      assert.strictEqual(result.status, 2, `extra=${extra.join(' ')} stderr: ${result.stderr}`);
      assert.match(
        result.stderr,
        /already implies proxy mode|--webhook-receiver proxy requires/,
        `extra=${extra.join(' ')}`
      );
    }
  });

  test('incompatible with --multi-instance-strategy multi-pass', () => {
    const result = runCli(
      [
        'storyboard',
        'run',
        'idempotency',
        '--url',
        'https://a.example.com',
        '--url',
        'https://b.example.com',
        '--multi-instance-strategy',
        'multi-pass',
        '--webhook-receiver-auto-tunnel',
      ],
      { ADCP_WEBHOOK_TUNNEL: `${stubTunnelPath} {port}` }
    );
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /incompatible with --multi-instance-strategy multi-pass/);
  });

  test('dry-run does not spawn the tunnel', () => {
    // A preview-only run should never pay tunnel startup cost. If we spawned
    // the stub we'd hang waiting for it to emit a URL; the fact that dry-run
    // returns promptly with exit 0 is the assertion.
    const result = runCli(
      ['storyboard', 'run', 'test-mcp', '--file', scenarioPath, '--webhook-receiver-auto-tunnel', '--dry-run'],
      { ADCP_WEBHOOK_TUNNEL: `${stubTunnelPath} {port}`, FAKE_TUNNEL_SILENT: '1' }
    );
    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
  });

  test('missing tunnel binary fails with an actionable error', () => {
    // Empty PATH so ngrok/cloudflared can't be discovered, and no override.
    // Must exit 2 with install guidance, not hang.
    const result = runCli(['storyboard', 'run', 'test-mcp', '--file', scenarioPath, '--webhook-receiver-auto-tunnel'], {
      PATH: '',
      ADCP_WEBHOOK_TUNNEL: '',
    });
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /no supported tunnel binary found on PATH/);
    assert.match(result.stderr, /ADCP_WEBHOOK_TUNNEL/);
  });

  test('ADCP_WEBHOOK_TUNNEL override substitutes {port} and captures marker URL', () => {
    // End-to-end of the override path: the stub prints the URL behind the
    // `ADCP_TUNNEL_URL=` marker and stays alive. The CLI must capture that URL,
    // proceed to runStoryboard, fail at network dispatch (test-mcp isn't real
    // here), and kill the tunnel on exit. The `runCli` timeout is the
    // regression guard — if capture succeeds but the run hangs, the test fails
    // loudly instead of stalling CI.
    const result = runCli(['storyboard', 'run', 'test-mcp', '--file', scenarioPath, '--webhook-receiver-auto-tunnel'], {
      ADCP_WEBHOOK_TUNNEL: `${stubTunnelPath} {port}`,
      ADCP_WEBHOOK_TUNNEL_TIMEOUT_MS: '5000',
    });
    assert.notStrictEqual(result.signal, 'SIGKILL', 'CLI hung past timeout — regression');
    assert.match(result.stderr, /Auto-tunnel \(.+\): https:\/\/stub-\d+\.tunnel\.test → http:\/\/localhost:\d+/);
  });

  test('custom template ignores unrelated URLs; only matches ADCP_TUNNEL_URL= marker', () => {
    // If a tunnel binary logs a docs or crash-reporter URL before its actual
    // forwarding URL, the scanner must not latch onto that bystander. The stub
    // prints the noise URL first, then the marker; success proves the scanner
    // kept reading past the noise instead of wiring the wrong destination.
    const result = runCli(['storyboard', 'run', 'test-mcp', '--file', scenarioPath, '--webhook-receiver-auto-tunnel'], {
      ADCP_WEBHOOK_TUNNEL: `${stubTunnelPath} {port}`,
      FAKE_TUNNEL_NOISE_URL: 'https://docs.example.com/getting-started',
      ADCP_WEBHOOK_TUNNEL_TIMEOUT_MS: '5000',
    });
    assert.match(result.stderr, /Auto-tunnel \(.+\): https:\/\/stub-\d+\.tunnel\.test/);
    assert.doesNotMatch(result.stderr, /Auto-tunnel \(.+\): https:\/\/docs\.example\.com/);
  });

  test('tunnel startup timeout surfaces a clear error', () => {
    const result = runCli(['storyboard', 'run', 'test-mcp', '--file', scenarioPath, '--webhook-receiver-auto-tunnel'], {
      ADCP_WEBHOOK_TUNNEL: `${stubTunnelPath} {port}`,
      FAKE_TUNNEL_SILENT: '1',
      ADCP_WEBHOOK_TUNNEL_TIMEOUT_MS: '500',
    });
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /did not emit a public URL within/);
  });

  test('tunnel exiting before URL surfaces the exit reason', () => {
    const result = runCli(['storyboard', 'run', 'test-mcp', '--file', scenarioPath, '--webhook-receiver-auto-tunnel'], {
      ADCP_WEBHOOK_TUNNEL: `${stubTunnelPath} {port}`,
      FAKE_TUNNEL_EXIT_BEFORE_URL: '1',
      ADCP_WEBHOOK_TUNNEL_TIMEOUT_MS: '5000',
    });
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /exited .+ before emitting a public URL/);
  });
});
