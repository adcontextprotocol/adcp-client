/**
 * End-to-end threading for the `adcp storyboard run` request-signing flags
 * (adcontextprotocol/adcp-client#2956).
 *
 * Split out of `cli-storyboard-signing-flags.test.js` and marked slow: each
 * case spawns the CLI against a live mock agent, which is the only way to
 * prove the flags survive the whole option-assembly path. The argument
 * semantics themselves are unit-tested in the fast file.
 */

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const http = require('node:http');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

const CLI = path.resolve(__dirname, '../../bin/adcp.js');
const SKIPPED_VECTOR = '001-no-signature-header';
// Second id in the CSV: proves the list is parsed, not passed through whole.
const RATE_ABUSE_SENTINEL_VECTOR = '002-wrong-tag';

function runCliAsync(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ADCP_SKIP_VERSION_CHECK: '1', ...env },
    });
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

test('--signing-skip-vectors reaches the runner and skips the vector as operator_skip', async t => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'adcp-cli-signing-flags-'));
  const storyboardPath = path.join(tmpDir, 'signing.yaml');
  writeFileSync(
    storyboardPath,
    [
      'id: cli-signing-flag-threading',
      'title: CLI signing flag threading',
      'protocol: media-buy',
      'phases:',
      '  - id: negative_vectors',
      '    title: Negative vectors',
      '    steps:',
      `      - id: negative-${SKIPPED_VECTOR}`,
      '        title: Negative vector',
      '        task: request_signing_probe',
      '        validations:',
      '          - check: http_status',
      '            value: 401',
      '',
    ].join('\n')
  );

  // The storyboard implicitly requires `request_signing.supported: true`, so
  // the agent has to advertise it or the whole run skips before dispatch.
  const requestedPaths = [];
  const server = http.createServer(async (req, res) => {
    requestedPaths.push(req.url);
    const mcp = new McpServer({ name: 'cli-signing-flags', version: '1.0.0' });
    mcp.registerTool('get_adcp_capabilities', { inputSchema: {} }, async () => ({
      content: [{ type: 'text', text: '{}' }],
      structuredContent: {
        success: true,
        adcp: { major_versions: [3], idempotency: { supported: true, replay_ttl_seconds: 86400 } },
        supported_protocols: ['media_buy'],
        specialisms: [],
        request_signing: { supported: true, covers_content_digest: 'either', required_for: [] },
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
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const agentUrl = `http://127.0.0.1:${server.address().port}/mcp`;
  const run = signingArgs =>
    runCliAsync([
      'storyboard',
      'run',
      agentUrl,
      '--protocol',
      'mcp',
      '--allow-http',
      '--file',
      storyboardPath,
      ...signingArgs,
      '--json',
      '--soft-fail',
    ]);

  const stepFrom = result => {
    const parsed = JSON.parse(result.stdout);
    const step = parsed.phases?.[0]?.steps?.[0];
    assert.ok(step, `expected one graded step, got: ${result.stdout}`);
    return step;
  };

  const skipped = stepFrom(await run(['--signing-skip-vectors', SKIPPED_VECTOR]));
  assert.strictEqual(skipped.skipped, true);
  assert.strictEqual(skipped.skip_reason, 'operator_skip');

  // Without the flag the same vector is dispatched — proving the skip above
  // came from the flag, not from the storyboard or the agent.
  requestedPaths.length = 0;
  const graded = stepFrom(await run([]));
  assert.notStrictEqual(graded.skip_reason, 'operator_skip');
  // Inferred transport on an MCP run: the vector is framed as a `tools/call`
  // envelope posted to the mount, never to a per-operation path.
  assert.ok(
    requestedPaths.every(path => path === '/mcp'),
    `expected every probe at the MCP mount, saw: ${requestedPaths.join(', ')}`
  );

  // `--signing-transport raw` reaches the grader: the same vector is now
  // replayed against its per-operation REST target under the mount.
  requestedPaths.length = 0;
  stepFrom(await run(['--signing-transport', 'raw']));
  assert.ok(
    requestedPaths.some(path => path.startsWith('/mcp/adcp/')),
    `expected a per-operation probe path, saw: ${requestedPaths.join(', ')}`
  );

  // Human output (no --json) must say why the step was skipped — the printer
  // is wired, not just unit-tested.
  const human = await runCliAsync([
    'storyboard',
    'run',
    agentUrl,
    '--protocol',
    'mcp',
    '--allow-http',
    '--file',
    storyboardPath,
    '--signing-skip-vectors',
    SKIPPED_VECTOR,
    '--soft-fail',
  ]);
  const humanOutput = `${human.stdout}${human.stderr}`;
  assert.match(humanOutput, /Skipped \(unsatisfied_contract \/ operator_skip\)/, humanOutput.slice(0, 500));
  assert.match(humanOutput, /request_signing\.skipVectors/);
});

test('storyboard run <url> signed_requests threads the flags through the assessment path', async t => {
  // `adcp storyboard run <agent> <storyboard-id>` routes through
  // `runFullAssessment` → `comply()`, NOT the `--file` branch above. A
  // comply()-level test does not discriminate this: `request_signing` already
  // reached `runStoryboard` through comply's rest-spread before this change.
  // Only driving the CLI proves `runFullAssessment` populates the option.
  // Do not read `req` here: the MCP transport needs an unconsumed stream, and
  // draining it makes discovery fail with an empty agent profile.
  const server = http.createServer(async (req, res) => {
    const mcp = new McpServer({ name: 'cli-assessment-path', version: '1.0.0' });
    mcp.registerTool('get_adcp_capabilities', { inputSchema: {} }, async () => ({
      content: [{ type: 'text', text: '{}' }],
      structuredContent: {
        success: true,
        adcp: { major_versions: [3], idempotency: { supported: true, replay_ttl_seconds: 86400 } },
        supported_protocols: ['media_buy'],
        specialisms: ['signed-requests'],
        request_signing: { supported: true, covers_content_digest: 'either', required_for: [] },
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
  });

  const agentUrl = `http://127.0.0.1:${server.address().port}/mcp`;
  const result = await runCliAsync([
    'storyboard',
    'run',
    agentUrl,
    'signed_requests',
    '--protocol',
    'mcp',
    '--allow-http',
    '--signing-skip-vectors',
    `${SKIPPED_VECTOR},${RATE_ABUSE_SENTINEL_VECTOR}`,
    '--signing-skip-rate-abuse',
    '--json',
    '--soft-fail',
  ]);

  const parsed = JSON.parse(result.stdout);
  const steps = parsed.tracks
    .flatMap(track => track.scenarios)
    .flatMap(scenario => scenario.steps ?? [])
    .filter(step => step.task === 'request_signing_probe');
  assert.ok(steps.length > 0, `expected synthesized vector steps, got: ${result.stdout.slice(0, 400)}`);

  // Two ids were named on the CLI; exactly two vectors must carry
  // `operator_skip`. Zero means `runFullAssessment` dropped the flag on the
  // way to `comply()`; a different count means the CSV was mis-parsed.
  const operatorSkipped = steps.filter(step => step.skip_reason === 'operator_skip');
  assert.strictEqual(
    operatorSkipped.length,
    2,
    `expected both named vectors skipped via the CLI flag, saw ${operatorSkipped.length}`
  );
  assert.ok(
    steps.some(step => step.skip_reason === 'rate_abuse_opt_out'),
    '--signing-skip-rate-abuse must also reach the runner'
  );

  // False-assurance guard: this mock accepts every signed probe with 200, so
  // the negatives it *did* grade must fail. A run against a verifier-less
  // agent can never report a clean signing pass.
  const graded = steps.filter(step => !step.skipped);
  assert.ok(graded.length > 0, 'expected at least one graded vector against the mock');
  assert.ok(
    graded.some(step => step.passed === false),
    'an agent that accepts negative vectors must fail them, not pass silently'
  );
  assert.strictEqual(parsed.overall_status !== 'passing', true, 'unverified signing cannot report passing');
  // Counterpart to the all-excluded run below: this run graded vectors, so
  // the coverage-unavailable exit path must stay silent.
  assert.doesNotMatch(
    `${result.stdout}${result.stderr}`,
    /no request-signing vector reached the agent/,
    'a run that graded vectors must not trip the coverage-unavailable exit'
  );
});

test('an assessment that excluded every vector exits nonzero and says why', async t => {
  // The laundering path all three exact-head codex personas converged on:
  // exclude every wire vector and the in-library self-check is the only green
  // step, yet the reason-keyed exit rule returned 0. Driving the real CLI
  // against a real assessment is the only way to prove the wiring, not just
  // the predicate.
  const { loadRequestSigningVectors } = require('../../dist/lib/testing/storyboard/request-signing/index.js');
  const loaded = loadRequestSigningVectors();
  const everyVectorId = [...loaded.positive, ...loaded.negative].map(vector => vector.id).join(',');

  const server = http.createServer(async (req, res) => {
    const mcp = new McpServer({ name: 'cli-all-excluded', version: '1.0.0' });
    mcp.registerTool('get_adcp_capabilities', { inputSchema: {} }, async () => ({
      content: [{ type: 'text', text: '{}' }],
      structuredContent: {
        success: true,
        adcp: { major_versions: [3], idempotency: { supported: true, replay_ttl_seconds: 86400 } },
        supported_protocols: ['media_buy'],
        specialisms: ['signed-requests'],
        request_signing: { supported: true, covers_content_digest: 'either', required_for: [] },
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
  });
  const agentUrl = `http://127.0.0.1:${server.address().port}/mcp`;

  const excluded = await runCliAsync([
    'storyboard',
    'run',
    agentUrl,
    'signed_requests',
    '--protocol',
    'mcp',
    '--allow-http',
    '--signing-skip-vectors',
    everyVectorId,
  ]);

  const output = `${excluded.stdout}${excluded.stderr}`;
  // The report names the gap, and the exit line names the cause — operator
  // scope here, not a missing transport.
  assert.match(
    output,
    /COVERAGE UNAVAILABLE — signed_requests: none of \d+ request-signing vector\(s\)/,
    output.slice(-1500)
  );
  assert.match(output, /signed_requests: no request-signing vector reached the agent/);
  assert.match(output, /every vector was excluded by this run's own selection/);
  assert.notStrictEqual(excluded.status, 0, 'a run that graded no verifier must not exit 0');

  // `--soft-fail` is the documented opt-out and still reports the gap.
  const soft = await runCliAsync([
    'storyboard',
    'run',
    agentUrl,
    'signed_requests',
    '--protocol',
    'mcp',
    '--allow-http',
    '--signing-skip-vectors',
    everyVectorId,
    '--soft-fail',
  ]);
  assert.strictEqual(soft.status, 0, `expected soft-fail exit 0, got ${soft.status}`);
  const softOutput = `${soft.stdout}${soft.stderr}`;
  assert.match(softOutput, /no request-signing vector reached the agent/);
  assert.doesNotMatch(softOutput, /Pass --soft-fail/, 'do not advise a flag the operator already passed');
});

test('a coverage-unavailable single step exits nonzero instead of reporting success', async () => {
  // `adcp storyboard step` maps the step's `passed` flag to the exit code,
  // and a skipped step is `passed: true` — so before adcp-client#2954 an
  // ungradable signing vector exited 0 and `… && echo ok` printed ok for a
  // vector nothing verified. The probe self-skips before any network work,
  // so this needs no live agent.
  const result = await runCliAsync([
    'storyboard',
    'step',
    'https://agent.invalid/a2a',
    'signed_requests',
    'negative-001-no-signature-header',
    '--protocol',
    'a2a',
  ]);

  assert.strictEqual(result.status, 3, `expected exit 3, got ${result.status}. stdout: ${result.stdout}`);
  assert.match(result.stdout, /Not verified/);
  assert.match(result.stdout, /COVERAGE UNAVAILABLE \(not_applicable \/ signing_transport_unavailable\)/);
  assert.match(result.stdout, /Remedy: verify the A2A SDK peer is installed/);
});

test('--soft-fail turns the single-step coverage gap into exit 0, as the help promises', async () => {
  // The help block and the guide both offer `--soft-fail` as the opt-out for
  // the exit-code change; `storyboard step` did not implement it, so the one
  // command whose exit newly changed had a documented escape hatch that was
  // a no-op.
  const result = await runCliAsync([
    'storyboard',
    'step',
    'https://agent.invalid/a2a',
    'signed_requests',
    'negative-001-no-signature-header',
    '--protocol',
    'a2a',
    '--soft-fail',
  ]);

  assert.strictEqual(result.status, 0, `expected soft-fail exit 0, got ${result.status}. stderr: ${result.stderr}`);
  assert.match(result.stdout, /Not verified/, 'the gap is still reported, just not fatal');
  assert.match(result.stderr, /--soft-fail set: exiting 0/);
});

test('an in-library vector still exits 0 on the same A2A run — only real gaps fail', async () => {
  // The exit rule must not turn every A2A signing step nonzero: vector 025
  // is decided against the SDK verifier with no wire exchange, so it grades
  // normally and the command reports success.
  const result = await runCliAsync([
    'storyboard',
    'step',
    'https://agent.invalid/a2a',
    'signed_requests',
    'negative-025-jwk-alg-crv-mismatch',
    '--protocol',
    'a2a',
  ]);

  assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}. stdout: ${result.stdout}`);
  assert.match(result.stdout, /✅ Passed/);
});
