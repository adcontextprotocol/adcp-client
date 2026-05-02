/**
 * CI gates for `examples/hello_seller_adapter_creative_template.ts`.
 *
 * Three independent assertions, mirroring the signal-marketplace template:
 *   1. The example typechecks under the strictest realistic adopter config.
 *   2. With the published creative-template mock as upstream, the storyboard
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
const EXAMPLE_FILE = path.join(REPO_ROOT, 'examples', 'hello_seller_adapter_creative_template.ts');
const CLI = path.join(REPO_ROOT, 'bin', 'adcp.js');

// Use high ports that won't collide with dev defaults (3001/3002, 4150/4250).
const AGENT_PORT = 35002;
const UPSTREAM_PORT = 41502;
const ADCP_AUTH_TOKEN = 'sk_harness_do_not_use_in_prod';
const UPSTREAM_API_KEY = 'mock_creative_template_key_do_not_use_in_prod';

const EXPECTED_ROUTES = [
  'GET /_lookup/workspace',
  'GET /v3/workspaces/{ws}/templates',
  'POST /v3/workspaces/{ws}/renders',
  'GET /v3/workspaces/{ws}/renders/{id}',
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

describe('examples/hello_seller_adapter_creative_template', () => {
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
      specialism: 'creative-template',
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

  it('passes the creative_template storyboard with zero failed steps', async () => {
    const grader = await runGrader(`http://127.0.0.1:${AGENT_PORT}/mcp`, 'creative_template');
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
