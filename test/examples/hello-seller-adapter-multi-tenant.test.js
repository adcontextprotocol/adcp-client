/**
 * CI gate for `examples/hello_seller_adapter_multi_tenant.ts`.
 *
 * Runtime coverage is intentionally narrower than the shared three-gate
 * helper because `runHelloAdapterGates` requires `bootMockServer({ specialism })`
 * plus an upstream traffic façade — neither applies to the multi-tenant adapter:
 *
 *   - It hosts three specialisms (governance-spend-authority, property-lists,
 *     brand-rights) and there are no governance/property-lists/brand-rights
 *     mock-servers today (`bootMockServer` covers sales-* / creative-* /
 *     signal-marketplace / sponsored-intelligence only).
 *   - The adapter has no upstream — all tenant state is in-memory, seeded
 *     directly. The façade gate would assert against routes that don't exist.
 *
 * Storyboard validation for the multi-tenant adapter lands when a
 * governance / brand-rights mock-server ships. Until then, this test ensures
 * the adapter compiles under the same strict tsc flags as the other hello
 * adapters and directly proves the buyer-agent-derived tenant routing seam
 * on no-account tools.
 */

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createServer, connect } = require('node:net');
const { createMCPClient } = require('../../dist/lib/protocols');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const EXAMPLE_FILE = path.join(REPO_ROOT, 'examples', 'hello_seller_adapter_multi_tenant.ts');

describe('examples/hello_seller_adapter_multi_tenant', () => {
  let agent;
  let agentPort;

  before(async () => {
    agentPort = await pickFreePort();
    agent = spawn('npx', ['tsx', EXAMPLE_FILE], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PORT: String(agentPort),
        NODE_ENV: 'development',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
  });

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

  it('routes no-account brand-rights reads by resolved buyer-agent tenant', async () => {
    const agentUrl = `http://127.0.0.1:${agentPort}/mcp`;
    const request = { query: 'commercial rights', uses: ['commercial'] };

    const pinnacle = await createMCPClient(agentUrl, 'sk_pinnacle_addie_demo').callTool('get_rights', request);
    const meridian = await createMCPClient(agentUrl, 'sk_meridian_buyer_demo').callTool('get_rights', request);

    const pinnacleIds = (pinnacle?.structuredContent?.rights ?? []).map(r => r.rights_id);
    const meridianIds = (meridian?.structuredContent?.rights ?? []).map(r => r.rights_id);

    assert.ok(pinnacleIds.includes('rights_acme_likeness_q2'), JSON.stringify(pinnacle));
    assert.ok(!pinnacleIds.includes('rights_zenith_anthem_sync'), JSON.stringify(pinnacle));
    assert.ok(meridianIds.includes('rights_zenith_anthem_sync'), JSON.stringify(meridian));
    assert.ok(!meridianIds.includes('rights_acme_likeness_q2'), JSON.stringify(meridian));
  });
});

function waitForPort(host, port, timeoutMs) {
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

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(err => (err ? reject(err) : resolve(port)));
    });
  });
}
