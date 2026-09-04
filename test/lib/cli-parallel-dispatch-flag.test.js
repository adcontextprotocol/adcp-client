/**
 * CLI plumbing for `--parallel-dispatch` — closes adcontextprotocol/adcp-client#2826.
 *
 * The storyboard runner already implements process-local parallel dispatches.
 * These tests verify that the CLI keeps that contract opt-in: omission retains
 * the existing not_applicable skip, while the flag dispatches every requested
 * concurrent call.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const http = require('node:http');
const { writeFileSync, mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

const CLI = path.resolve(__dirname, '../../bin/adcp.js');

function runCli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } });
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

async function createCapabilityServer(t, name) {
  let toolCalls = 0;
  const server = http.createServer(async (req, res) => {
    const mcp = new McpServer({ name, version: '1.0.0' });
    mcp.registerTool('get_adcp_capabilities', { inputSchema: {} }, async () => {
      toolCalls++;
      return {
        content: [{ type: 'text', text: '{}' }],
        structuredContent: {
          success: true,
          adcp: { major_versions: [3], idempotency: { supported: true, replay_ttl_seconds: 86400 } },
          supported_protocols: ['media_buy'],
          specialisms: [],
        },
      };
    });
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
  });

  return {
    address: () => server.address().port,
    toolCalls: () => toolCalls,
  };
}

test('--parallel-dispatch opts into process-local parallel dispatch grading', { timeout: 60_000 }, async t => {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'adcp-cli-parallel-dispatch-'));
  const storyboardPath = path.join(fixtureRoot, 'storyboard.yaml');
  writeFileSync(
    storyboardPath,
    [
      'id: cli-parallel-dispatch-contract',
      'title: CLI parallel dispatch contract',
      'protocol: media-buy',
      'phases:',
      '  - id: phase-1',
      '    title: Concurrent capability probes',
      '    steps:',
      '      - id: concurrent-capabilities',
      '        title: Concurrent capability probes',
      '        task: get_adcp_capabilities',
      '        request: {}',
      '        parallel_dispatch:',
      '          count: 2',
      '',
    ].join('\n')
  );

  const capabilityServer = await createCapabilityServer(t, 'cli-parallel-dispatch');
  t.after(async () => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  const command = extraArgs => [
    'storyboard',
    'run',
    `http://127.0.0.1:${capabilityServer.address()}/mcp`,
    '--protocol',
    'mcp',
    '--allow-http',
    '--file',
    storyboardPath,
    '--json',
    ...extraArgs,
  ];

  const withoutFlag = await runCli(command([]), { ADCP_SKIP_VERSION_CHECK: '1' });
  assert.strictEqual(withoutFlag.status, 0, withoutFlag.stderr);
  const skipped = JSON.parse(withoutFlag.stdout);
  assert.strictEqual(skipped.phases[0].steps[0].skip_reason, 'not_applicable');
  // Every storyboard run primes capabilities before evaluating its steps.
  // The skipped step itself must add no second dispatch.
  assert.strictEqual(capabilityServer.toolCalls(), 1, 'the gated step must not dispatch without the opt-in');

  const callsBeforeWithFlag = capabilityServer.toolCalls();
  const withFlag = await runCli(command(['--parallel-dispatch']), { ADCP_SKIP_VERSION_CHECK: '1' });
  assert.strictEqual(withFlag.status, 0, withFlag.stderr);
  const graded = JSON.parse(withFlag.stdout);
  assert.strictEqual(graded.phases[0].steps[0].skipped, undefined);
  assert.strictEqual(
    capabilityServer.toolCalls() - callsBeforeWithFlag,
    3,
    'the opt-in run must make one capability probe and fan out both requested dispatches'
  );
});

test('--parallel-dispatch and --webhook-receiver retain both runner contracts', { timeout: 60_000 }, async t => {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'adcp-cli-combined-runner-contracts-'));
  const storyboardPath = path.join(fixtureRoot, 'storyboard.yaml');
  writeFileSync(
    storyboardPath,
    [
      'id: cli-combined-runner-contracts',
      'title: CLI combined runner contracts',
      'protocol: media-buy',
      'phases:',
      '  - id: phase-1',
      '    title: Combined contracts',
      '    steps:',
      '      - id: webhook-contract',
      '        title: Webhook contract probe',
      '        task: get_adcp_capabilities',
      '        request: {}',
      '        requires_contract: webhook_receiver_runner',
      '      - id: parallel-contract',
      '        title: Parallel contract probe',
      '        task: get_adcp_capabilities',
      '        request: {}',
      '        parallel_dispatch:',
      '          count: 2',
      '',
    ].join('\n')
  );
  const capabilityServer = await createCapabilityServer(t, 'cli-combined-runner-contracts');
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  const callsBeforeRun = capabilityServer.toolCalls();
  const result = await runCli(
    [
      'storyboard',
      'run',
      `http://127.0.0.1:${capabilityServer.address()}/mcp`,
      '--protocol',
      'mcp',
      '--allow-http',
      '--file',
      storyboardPath,
      '--json',
      '--parallel-dispatch',
      '--webhook-receiver',
    ],
    { ADCP_SKIP_VERSION_CHECK: '1' }
  );

  assert.strictEqual(result.status, 0, result.stderr);
  const combined = JSON.parse(result.stdout);
  assert.strictEqual(combined.phases[0].steps[0].skipped, undefined, 'webhook runner contract must remain in scope');
  assert.strictEqual(combined.phases[0].steps[1].skipped, undefined, 'parallel runner contract must remain in scope');
  assert.strictEqual(
    capabilityServer.toolCalls() - callsBeforeRun,
    4,
    'the combined run must make one capability probe, one webhook-contract probe, and two parallel dispatches'
  );
});

test('storyboard help describes the parallel dispatch opt-in and its mode limits', async () => {
  const result = await runCli(['storyboard', '--help'], { ADCP_SKIP_VERSION_CHECK: '1' });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /--parallel-dispatch/);
  assert.match(result.stdout, /process-local concurrent dispatches/);
  assert.match(result.stdout, /Distributed mode is not implemented and/);
});
