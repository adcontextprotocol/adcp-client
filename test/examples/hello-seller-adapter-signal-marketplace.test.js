/**
 * CI gates for `examples/hello_seller_adapter_signal_marketplace.ts`.
 *
 * Three independent assertions:
 *   1. The example typechecks under the strictest realistic adopter config
 *      (--strict + 4 extra strictness flags).
 *   2. With the published mock-server as upstream, the storyboard runner
 *      reports zero failed steps (skipped steps for tools the specialism
 *      doesn't claim are allowed).
 *   3. After the storyboard run, every expected upstream endpoint shows ≥1
 *      hit at /_debug/traffic — the façade-resistance gate.
 *
 * Together these make the example self-policing: a contributor (or LLM) who
 * modifies the example or the SDK in a way that breaks any of the three
 * gates fails CI, not "looks fine" review. This is the pattern the
 * validate-with-mock-fixtures spec guide describes — applied here to our
 * own reference adapter so what we tell adopters to do is what we
 * ourselves do.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
// Public sub-export (per #1287/#1294) — adopters use this exact import path
// in their own integration tests.
const { bootMockServer } = require('@adcp/sdk/mock-server');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const EXAMPLE_FILE = path.join(REPO_ROOT, 'examples', 'hello_seller_adapter_signal_marketplace.ts');
const CLI = path.join(REPO_ROOT, 'bin', 'adcp.js');

// Use high ports that won't collide with dev defaults (3001, 4150).
const AGENT_PORT = 35001;
const UPSTREAM_PORT = 41500;
const ADCP_AUTH_TOKEN = 'sk_harness_do_not_use_in_prod';
const UPSTREAM_API_KEY = 'mock_signal_market_key_do_not_use_in_prod';

const EXPECTED_ROUTES = ['GET /_lookup/operator', 'GET /v2/cohorts', 'POST /v2/activations'];

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

describe('examples/hello_seller_adapter_signal_marketplace', () => {
  // -------------------------------------------------------------------------
  // Gate 1 — strictest realistic typecheck
  // -------------------------------------------------------------------------
  it('passes tsc with --strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes + noPropertyAccessFromIndexSignature', () => {
    const res = spawnSync(
      'npx',
      [
        'tsc',
        '--noEmit',
        EXAMPLE_FILE,
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

  // -------------------------------------------------------------------------
  // Gates 2 + 3 — runtime: storyboard pass + traffic verification
  // Shared boot so the cost (~5s) is paid once.
  // -------------------------------------------------------------------------
  let mockHandle;
  let agent;

  before(async () => {
    mockHandle = await bootMockServer({
      specialism: 'signal-marketplace',
      port: UPSTREAM_PORT,
      apiKey: UPSTREAM_API_KEY,
    });
    // Boot the example as a child process — it calls `serve()` at module
    // load and runs forever. Async spawn keeps the test's event loop alive
    // (same lesson as #1250's runGrader fix: spawnSync would deadlock).
    agent = spawn('npx', ['tsx', EXAMPLE_FILE], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PORT: String(AGENT_PORT),
        UPSTREAM_URL: mockHandle.url,
        UPSTREAM_API_KEY,
        ADCP_AUTH_TOKEN,
        NODE_ENV: 'development',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Drain stdio so the kernel pipe buffers don't fill and block the child.
    agent.stdout.on('data', () => {});
    agent.stderr.on('data', () => {});
    await waitForPort('127.0.0.1', AGENT_PORT, 30_000);
  });

  after(async () => {
    if (agent && agent.exitCode === null) {
      agent.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 500));
      if (agent.exitCode === null) agent.kill('SIGKILL');
    }
    if (mockHandle) await mockHandle.close();
  });

  it('passes the signal_marketplace storyboard with zero failed steps', async () => {
    const grader = await runGrader(`http://127.0.0.1:${AGENT_PORT}/mcp`, 'signal_marketplace');
    assert.equal(
      grader.summary.steps_failed,
      0,
      `storyboard reported ${grader.summary.steps_failed} failed steps:\n` + formatFailures(grader)
    );
    // Allow `partial` overall_status when no steps failed — that's the
    // runner's "silent track" classification (issue #1209). What we
    // strictly disallow is any explicitly-failed step.
    assert.notEqual(grader.overall_status, 'failing');
  });

  it('hits every expected upstream route at least once (façade gate)', async () => {
    const res = await fetch(`${mockHandle.url}/_debug/traffic`);
    const body = await res.json();
    const traffic = body.traffic || {};
    const missing = EXPECTED_ROUTES.filter(r => (traffic[r] || 0) < 1);
    assert.deepEqual(
      missing,
      [],
      `These upstream routes had zero hits — the adapter is a façade for them:\n  ${missing.join('\n  ')}\n\nFull traffic:\n${JSON.stringify(traffic, null, 2)}`
    );
  });

  // -------------------------------------------------------------------------
  // Gate 4 — BuyerAgentRegistry wiring works end-to-end
  //
  // The example wires a `BuyerAgentRegistry` (Phase 1 of #1269) keyed off
  // the api-key principal. Verifies that:
  //   - Authenticated requests with a known onboarding-ledger entry
  //     succeed (registry resolved, status active).
  //   - Unknown api-keys are rejected upstream by `verifyApiKey` (auth
  //     failure happens before the registry runs).
  //
  // The registry is exercised implicitly by Gate 2's storyboard (every
  // run goes through `agentRegistry.resolve`), but a dedicated assertion
  // here makes the registry's behavior visible and prevents future
  // refactors from silently dropping the wiring.
  // -------------------------------------------------------------------------
  it('rejects unknown api-key tokens before reaching the registry (auth gate fires first)', async () => {
    const res = await fetch(`http://127.0.0.1:${AGENT_PORT}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer sk_unknown_token_not_in_keys_map',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_signals', arguments: { signal_spec: 'test' } },
      }),
    });
    // verifyApiKey rejects unknown tokens with 401 before the registry
    // runs. This locks in the auth-before-registry order and confirms
    // the registry isn't running on un-authenticated traffic.
    assert.equal(res.status, 401, 'unknown api-key MUST be rejected at the auth layer');
  });

  // Note: the sandbox_only ↔ accounts.sandbox load-bearing pair is
  // covered behaviorally by Gate 2 (storyboard) — if either side of the
  // pair regresses, every storyboard step 403s and Gate 2 fails. The
  // framework's gate behavior itself is unit-tested in
  // `test/server-buyer-agent-sandbox-only.test.js`.
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runGrader(agentUrl, storyboardId) {
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
        ADCP_AUTH_TOKEN,
        '--webhook-receiver',
      ],
      {
        cwd: REPO_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    const out = [];
    const err = [];
    child.stdout.on('data', c => out.push(c));
    child.stderr.on('data', c => err.push(c));
    const timer = setTimeout(() => child.kill('SIGTERM'), 60_000);
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

function formatFailures(grader) {
  const failed = [];
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.passed === false && !node.skipped) {
      const detail = node.details || node.error || '';
      failed.push(
        `  ✗ ${node.task || '?'} — ${node.step || node.step_id || '?'}\n      ${String(detail).slice(0, 200)}`
      );
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (typeof v === 'object') walk(v);
    }
  }
  walk(grader);
  return failed.join('\n') || '(no per-step detail captured)';
}
