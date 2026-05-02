/**
 * CI gates for `examples/hello_seller_adapter_sales_social.ts`.
 *
 * Three independent assertions, mirroring the signal-marketplace template:
 *   1. The example typechecks under the strictest realistic adopter config.
 *   2. With the published sales-social mock as upstream, the storyboard
 *      runner reports zero failed steps.
 *   3. After the run, every expected upstream route shows ≥1 hit at
 *      /_debug/traffic — the façade-resistance gate.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { bootMockServer } = require('@adcp/sdk/mock-server');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const EXAMPLE_FILE = path.join(REPO_ROOT, 'examples', 'hello_seller_adapter_sales_social.ts');
const CLI = path.join(REPO_ROOT, 'bin', 'adcp.js');

const AGENT_PORT = 35003;
const UPSTREAM_PORT = 41503;
const ADCP_AUTH_TOKEN = 'sk_harness_do_not_use_in_prod';

// sales-social mock issues OAuth tokens via /oauth/token; client_id and
// client_secret are seeded constants in the mock package. These match the
// example's defaults — adopter forks should override via env vars.
const UPSTREAM_OAUTH_CLIENT_ID = 'tiktok_test_client_001';
const UPSTREAM_OAUTH_CLIENT_SECRET = 'tiktok_test_secret_do_not_use_in_prod';

const EXPECTED_ROUTES = [
  'POST /oauth/token',
  'GET /_lookup/advertiser',
  'POST /v1.3/advertiser/{id}/custom_audience/create',
  'POST /v1.3/advertiser/{id}/creative/create',
  'POST /v1.3/advertiser/{id}/catalog/create',
  'POST /v1.3/advertiser/{id}/catalog/upload',
  'POST /v1.3/advertiser/{id}/pixel/create',
  'POST /v1.3/advertiser/{id}/event/track',
  'GET /v1.3/advertiser/{id}/info',
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

describe('examples/hello_seller_adapter_sales_social', () => {
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
    mockHandle = await bootMockServer({ specialism: 'sales-social', port: UPSTREAM_PORT });
    agent = spawn('npx', ['tsx', EXAMPLE_FILE], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PORT: String(AGENT_PORT),
        UPSTREAM_URL: mockHandle.url,
        UPSTREAM_OAUTH_CLIENT_ID,
        UPSTREAM_OAUTH_CLIENT_SECRET,
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

  it('passes the sales_social storyboard with zero failed steps', async () => {
    const grader = await runGrader(`http://127.0.0.1:${AGENT_PORT}/mcp`, 'sales_social');
    assert.equal(
      grader.summary.steps_failed,
      0,
      `storyboard reported ${grader.summary.steps_failed} failed steps:\n` + formatFailures(grader)
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
    const timer = setTimeout(() => child.kill('SIGTERM'), 90_000);
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
