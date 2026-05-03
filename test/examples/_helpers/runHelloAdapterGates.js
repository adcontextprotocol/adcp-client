/**
 * Shared three-gate CI test runner for `examples/hello_*_adapter_*.ts`
 * reference adapters. Each adapter test file passes its config and the
 * helper registers the three gates (strict tsc / storyboard / façade).
 *
 * **Contract**: `docs/guides/EXAMPLE-TEST-CONTRACT.md` documents what each
 * gate catches, the adversarial-sabotage validation pattern (when to add
 * a fourth gate, how to confirm gate independence), and the acceptance
 * criteria new adapters must meet. Read it before adding a new adapter
 * test or modifying this helper.
 *
 * Adversarial-sabotage validated: each gate fires for a distinct
 * regression class. See PR #1274 for the original rationale.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { bootMockServer } = require('@adcp/sdk/mock-server');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(REPO_ROOT, 'bin', 'adcp.js');

/**
 * @typedef {Object} HelloGatesConfig
 * @property {string} suiteName               — `describe()` label, typically `examples/<file>`
 * @property {string} exampleFile             — absolute path to the adapter `.ts` file under test
 * @property {Parameters<typeof bootMockServer>[0]['specialism']} specialism
 * @property {string} storyboardId            — storyboard id passed to `adcp storyboard run`
 * @property {string} adcpAuthToken           — bearer the agent verifies + the grader sends
 * @property {number} agentPort               — high port the agent binds to
 * @property {number} upstreamPort            — high port the mock binds to
 * @property {string[]} expectedRoutes        — façade gate: routes that must show ≥1 hit
 * @property {Record<string, string|undefined>} [extraEnv]  — extra env vars for the agent child
 * @property {Parameters<typeof bootMockServer>[0]} [mockOptions] — extra mock-server boot opts
 * @property {(grader: any) => any[]} [filterFailures] — narrow the failures list (default: all)
 * @property {string} [storyboardSummary]     — optional storyboard description for the test name
 */

/**
 * Register the three CI gates for a hello-adapter example.
 * @param {HelloGatesConfig} config
 */
function runHelloAdapterGates(config) {
  const {
    suiteName,
    exampleFile,
    specialism,
    storyboardId,
    adcpAuthToken,
    agentPort,
    upstreamPort,
    expectedRoutes,
    extraEnv = {},
    mockOptions = {},
    filterFailures,
    storyboardSummary,
  } = config;

  describe(suiteName, () => {
    // ── Gate 1 — strictest realistic typecheck ──
    it('passes tsc with --strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes + noPropertyAccessFromIndexSignature', () => {
      const res = spawnSync(
        'npx',
        [
          'tsc',
          '--noEmit',
          exampleFile,
          '--target',
          'ES2022',
          '--module',
          'commonjs',
          '--moduleResolution',
          'node',
          '--esModuleInterop',
          '--skipLibCheck',
          '--strict',
          '--noUncheckedIndexedAccess',
          '--exactOptionalPropertyTypes',
          '--noImplicitOverride',
          '--noFallthroughCasesInSwitch',
          '--noPropertyAccessFromIndexSignature',
        ],
        { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 }
      );
      assert.equal(res.status, 0, `tsc reported errors:\n${(res.stdout || '') + (res.stderr || '')}`);
    });

    // ── Gates 2 + 3 — runtime: storyboard + traffic ──
    let mockHandle;
    let agent;

    before(async () => {
      mockHandle = await bootMockServer({ specialism, port: upstreamPort, ...mockOptions });
      agent = spawn('npx', ['tsx', exampleFile], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          PORT: String(agentPort),
          UPSTREAM_URL: mockHandle.url,
          ADCP_AUTH_TOKEN: adcpAuthToken,
          NODE_ENV: 'development',
          ...extraEnv,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      // Drain stdio so the kernel pipe buffers don't fill and block the child.
      agent.stdout.on('data', () => {});
      agent.stderr.on('data', () => {});
      await waitForPort('127.0.0.1', agentPort, 30_000);
    });

    after(async () => {
      if (agent && agent.exitCode === null) {
        agent.kill('SIGTERM');
        await new Promise(r => setTimeout(r, 500));
        if (agent.exitCode === null) agent.kill('SIGKILL');
      }
      if (mockHandle) await mockHandle.close();
    });

    const passLabel = storyboardSummary
      ? `passes the ${storyboardId} storyboard with zero failed steps (${storyboardSummary})`
      : `passes the ${storyboardId} storyboard with zero failed steps`;

    it(passLabel, async () => {
      const grader = await runGrader(`http://127.0.0.1:${agentPort}/mcp`, storyboardId, adcpAuthToken);
      const failures = filterFailures ? filterFailures(grader) : (grader.failures || []).filter(f => !f.skipped);
      assert.equal(
        failures.length,
        0,
        `storyboard reported ${failures.length} failed step(s):\n` + formatFailures(failures)
      );
      assert.notEqual(grader.overall_status, 'failing');
    });

    it('hits every expected upstream route at least once (façade gate)', async () => {
      const res = await fetch(`${mockHandle.url}/_debug/traffic`);
      const body = await res.json();
      const traffic = body.traffic || {};
      const missing = expectedRoutes.filter(r => (traffic[r] || 0) < 1);
      assert.deepEqual(
        missing,
        [],
        `These upstream routes had zero hits — the adapter is a façade for them:\n  ${missing.join('\n  ')}\n\nFull traffic:\n${JSON.stringify(traffic, null, 2)}`
      );
    });
  });
}

function waitForPort(host, port, timeoutMs) {
  const { connect } = require('node:net');
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const s = connect(port, host, () => {
        s.end();
        resolve();
      });
      s.on('error', () => {
        if (Date.now() >= deadline) reject(new Error(`timed out waiting for ${host}:${port}`));
        else setTimeout(tick, 100);
      });
    };
    tick();
  });
}

function runGrader(agentUrl, storyboardId, adcpAuthToken) {
  return new Promise((resolveFn, reject) => {
    const child = spawn(
      'node',
      [
        CLI,
        'storyboard',
        'run',
        agentUrl,
        storyboardId,
        '--json',
        '--allow-http',
        '--auth',
        adcpAuthToken,
        '--webhook-receiver',
      ],
      { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const out = [];
    const err = [];
    child.stdout.on('data', c => out.push(c));
    child.stderr.on('data', c => err.push(c));
    const timer = setTimeout(() => child.kill('SIGTERM'), 120_000);
    child.on('close', () => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString('utf8');
      try {
        resolveFn(JSON.parse(stdout));
      } catch (e) {
        reject(
          new Error(
            `grader stdout was not parseable JSON (storyboard=${storyboardId}):\n${stdout.slice(0, 500)}\n\nstderr: ${Buffer.concat(err).toString('utf8').slice(0, 500)}`
          )
        );
      }
    });
    child.on('error', reject);
  });
}

function formatFailures(failures) {
  return (
    failures
      .map(
        f =>
          `  ✗ ${f.task || '?'} — ${f.step_title || f.step_id || '?'}\n      ${String(f.validation?.description || f.expected || f.error || '').slice(0, 200)}`
      )
      .join('\n') || '(no per-step detail captured)'
  );
}

module.exports = { runHelloAdapterGates };
