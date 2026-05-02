/**
 * CI gates for `examples/hello_seller_adapter_sales_guaranteed.ts`.
 *
 * Three independent assertions, mirroring the signal-marketplace template
 * with one specialism-specific accommodation:
 *   1. The example typechecks under the strictest realistic adopter config.
 *   2. The main `sales_guaranteed` storyboard reports zero failed steps.
 *      Cascade scenarios under `media_buy_seller/*` (driven by
 *      `requires_scenarios` in the storyboard yaml) require a
 *      `comply_test_controller` wiring that this worked example
 *      intentionally omits — those failures are tolerated. Adopters who
 *      need the full scenario suite to pass wire `createComplyController`
 *      separately (see `examples/comply-controller-seller.ts`).
 *   3. After the run, every expected upstream route shows ≥1 hit at
 *      /_debug/traffic — the façade-resistance gate.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { bootMockServer } = require('@adcp/sdk/mock-server');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const EXAMPLE_FILE = path.join(REPO_ROOT, 'examples', 'hello_seller_adapter_sales_guaranteed.ts');
const CLI = path.join(REPO_ROOT, 'bin', 'adcp.js');

const AGENT_PORT = 35004;
const UPSTREAM_PORT = 41504;
const ADCP_AUTH_TOKEN = 'sk_harness_do_not_use_in_prod';
const UPSTREAM_API_KEY = 'mock_sales_guaranteed_key_do_not_use_in_prod';

const EXPECTED_ROUTES = [
  'GET /_lookup/network',
  'GET /v1/products',
  'POST /v1/orders',
  'GET /v1/tasks/{id}',
  'GET /v1/orders/{id}',
  'POST /v1/orders/{id}/lineitems',
];

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

describe('examples/hello_seller_adapter_sales_guaranteed', () => {
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

  let mockHandle;
  let agent;

  before(async () => {
    mockHandle = await bootMockServer({
      specialism: 'sales-guaranteed',
      port: UPSTREAM_PORT,
      apiKey: UPSTREAM_API_KEY,
    });
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

  it('passes the sales_guaranteed main storyboard with zero failed steps (cascade scenarios under media_buy_seller/* require comply_test_controller and are not exercised here)', async () => {
    const grader = await runGrader(`http://127.0.0.1:${AGENT_PORT}/mcp`, 'sales_guaranteed');
    const mainFailures = (grader.failures || []).filter(f => f.storyboard_id === 'sales_guaranteed');
    assert.equal(
      mainFailures.length,
      0,
      `sales_guaranteed main storyboard reported ${mainFailures.length} failed step(s):\n` +
        mainFailures
          .map(
            f =>
              `  ✗ ${f.task || '?'} — ${f.step_title || f.step_id || '?'}\n      ${String(f.validation?.description || f.expected || '').slice(0, 200)}`
          )
          .join('\n')
    );
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
});

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
