/**
 * End-to-end test: grader in MCP transport mode against the MCP signed
 * agent from test-agents/seller-agent-signed-mcp.ts. Validates that
 * `transport: 'mcp'` correctly wraps vectors in JSON-RPC envelopes, posts
 * to the agent's single MCP endpoint, and surfaces the verifier's
 * per-vector outcomes identically to raw mode.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

const { gradeRequestSigning } = require('../dist/lib/testing/storyboard/request-signing/index.js');

// MCP signed agent is compiled to test-agents/dist/. The suite auto-builds
// it if missing — CI runs `npm test` without an explicit build:test-agents
// step, so the fallback keeps CI green without an extra workflow line.
const MCP_AGENT_SCRIPT = path.join(__dirname, '..', 'test-agents', 'dist', 'seller-agent-signed-mcp.js');
const TEST_AGENTS_TSCONFIG = path.join(__dirname, '..', 'test-agents', 'tsconfig.json');
const REPO_ROOT = path.join(__dirname, '..');

function ensureMcpAgentBuilt() {
  if (existsSync(MCP_AGENT_SCRIPT)) return;
  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, 'node_modules', '.bin', 'tsc'), '-p', TEST_AGENTS_TSCONFIG, '--rootDir', 'test-agents'],
    { cwd: REPO_ROOT, stdio: 'inherit' }
  );
  if (result.status !== 0 || !existsSync(MCP_AGENT_SCRIPT)) {
    throw new Error(
      `Could not build test-agents (tsc exited ${result.status}). Run \`npm run build:test-agents\` manually to diagnose.`
    );
  }
}

function startMcpAgent(overrides = {}) {
  // PORT=0 asks the OS for a free ephemeral port so parallel test workers
  // and leftover zombies from previous runs can't collide. The child
  // process's `AdCP agent running at http://localhost:<port>/mcp` banner
  // carries the actual bound port; we parse it and stash on `child.port`
  // for the caller. Closes adcp-client#884 (rate-abuse subtest flake).
  const env = { ...process.env, ...overrides, PORT: '0' };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MCP_AGENT_SCRIPT], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    const stderrTail = [];
    const stdoutTail = [];
    const onStdout = chunk => {
      if (settled) return;
      const s = chunk.toString();
      stdoutTail.push(s);
      // Parse the actual bound port from the banner — the banner line is
      // authoritative because PORT=0 means the OS picked it. Fail the
      // startup (rather than silently using port 0) if the banner arrives
      // but we can't extract a port — that'd indicate a banner-format
      // change the caller needs to hear about.
      const portMatch = /running at https?:\/\/[^:]+:(\d+)/i.exec(stdoutTail.join(''));
      if (s.includes('listening') || s.includes('running at')) {
        if (!portMatch) {
          settled = true;
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
          reject(
            new Error(
              `MCP agent signaled ready but startMcpAgent could not parse a port from the banner:\n${stdoutTail.join('')}`
            )
          );
          return;
        }
        settled = true;
        child.port = Number(portMatch[1]);
        resolve(child);
      }
    };
    const onStderr = chunk => {
      if (settled) return;
      stderrTail.push(chunk.toString());
    };
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.on('error', err => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    // If the child exits before the startup banner, it crashed — reject with
    // captured stderr/stdout so the failure is actionable instead of surfacing
    // as opaque grader-level connect errors 20s later.
    child.on('exit', code => {
      if (settled) return;
      settled = true;
      const tail = (stderrTail.join('') + stdoutTail.join('')).trim() || '(no output)';
      reject(new Error(`MCP agent exited with code ${code} before signaling ready:\n${tail}`));
    });
    // Hard cap: if the banner never arrives, reject rather than "assume
    // started" — the earlier fallback hid crashes behind 20s of connect
    // errors inside the grader. 15s leaves headroom for `tsx` first-run
    // transpile on a cold CI runner.
    setTimeout(() => {
      if (settled) return;
      settled = true;
      const tail = (stderrTail.join('') + stdoutTail.join('')).trim() || '(no output)';
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      reject(new Error(`MCP agent did not signal ready within 10s:\n${tail}`));
    }, 10000);
    // Reap orphan on abnormal parent exit (CI runner crash, OOM) so the
    // next run doesn't hit EADDRINUSE on the same port.
    const reap = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    };
    process.once('exit', reap);
    child.once('exit', () => process.removeListener('exit', reap));
  });
}

function stopMcpAgent(child) {
  return new Promise(resolve => {
    if (!child || child.killed) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
      resolve();
    }, 2000);
  });
}

describe('request-signing grader — MCP transport vs. reference MCP agent', () => {
  // Ephemeral ports (PORT=0) eliminate the parallel-worker collision and
  // zombie-port races that used to flake the rate-abuse subtest (#884).
  // `agent.port` is populated from the startup banner in `startMcpAgent`.
  let agent;
  let AGENT_URL;

  before(async () => {
    ensureMcpAgentBuilt();
    agent = await startMcpAgent();
    AGENT_URL = `http://127.0.0.1:${agent.port}/mcp`;
  });

  after(async () => {
    await stopMcpAgent(agent);
  });

  test('MCP mode grades every non-profile vector against the MCP signed agent', async () => {
    const report = await gradeRequestSigning(AGENT_URL, {
      allowPrivateIp: true,
      transport: 'mcp',
      skipRateAbuse: true,
      agentContentDigestPolicy: 'either',
    });

    // Collect failures so a regression prints all at once.
    const failures = [];
    for (const v of [...report.positive, ...report.negative]) {
      if (!v.passed && !v.skipped) {
        failures.push(`${v.kind}/${v.vector_id}: status=${v.http_status} ${v.diagnostic ?? ''}`);
      }
    }
    assert.deepStrictEqual(failures, [], 'every non-profile vector grades as expected under MCP transport');
    assert.ok(report.passed, 'overall grade is PASS');
    assert.strictEqual(report.positive.length, 12);
    assert.strictEqual(report.negative.length, 27);
  });

  test('MCP mode vector bodies are wrapped in JSON-RPC tools/call envelopes', async () => {
    const {
      buildPositiveRequest,
      loadRequestSigningVectors,
    } = require('../dist/lib/testing/storyboard/request-signing/index.js');
    const loaded = loadRequestSigningVectors();
    const vector = loaded.positive.find(v => v.id === '001-basic-post');
    const signed = buildPositiveRequest(vector, loaded.keys, {
      baseUrl: 'http://127.0.0.1:9999/mcp',
      transport: 'mcp',
    });
    const body = JSON.parse(signed.body);
    assert.strictEqual(body.jsonrpc, '2.0');
    assert.strictEqual(body.method, 'tools/call');
    assert.strictEqual(body.params.name, 'create_media_buy');
    // Arguments = parsed vector body verbatim (vector 001's body has plan_id + packages).
    assert.deepStrictEqual(body.params.arguments, JSON.parse(vector.request.body));
    // URL is baseUrl as-is — no path join from the vector.
    assert.strictEqual(signed.url, 'http://127.0.0.1:9999/mcp');
    // Accept header is added so MCP Streamable HTTP servers don't 406.
    assert.match(signed.headers['Accept'] ?? '', /application\/json/);
    assert.match(signed.headers['Accept'] ?? '', /text\/event-stream/);
  });

  test('MCP mode rejects transport: mcp without a baseUrl', () => {
    const {
      buildPositiveRequest,
      loadRequestSigningVectors,
    } = require('../dist/lib/testing/storyboard/request-signing/index.js');
    const loaded = loadRequestSigningVectors();
    const vector = loaded.positive.find(v => v.id === '001-basic-post');
    assert.throws(
      () => buildPositiveRequest(vector, loaded.keys, { transport: 'mcp' }),
      /transport: 'mcp' requires a baseUrl/
    );
  });

  test('rate-abuse vector: (cap+1)th request rejected with request_signature_rate_abuse under MCP', async () => {
    // Dedicated MCP agent instance with a tight cap matched to the grader's
    // rateAbuseCap so the flood trips the rejection in ~11 requests rather
    // than 101. Needs `allowLiveSideEffects: true` because the reference
    // agent doesn't advertise `endpoint_scope: sandbox` — preflightSkip
    // otherwise refuses to run 020.
    //
    // Uses an ephemeral port (startMcpAgent binds PORT=0 and returns the
    // OS-picked port on `child.port`) so this spawn can't collide with the
    // `before()` agent or with a parallel test worker. Fixes #884.
    const fresh = await startMcpAgent({ ADCP_REPLAY_CAP: '10' });
    try {
      const report = await gradeRequestSigning(`http://127.0.0.1:${fresh.port}/mcp`, {
        allowPrivateIp: true,
        transport: 'mcp',
        onlyVectors: ['020-rate-abuse'],
        rateAbuseCap: 10,
        allowLiveSideEffects: true,
      });
      const v020 = report.negative.find(v => v.vector_id === '020-rate-abuse');
      assert.ok(v020, '020-rate-abuse present in report');
      assert.ok(v020.passed && !v020.skipped, `020 should pass under MCP: ${v020.diagnostic}`);
      assert.strictEqual(v020.actual_error_code, 'request_signature_rate_abuse');
      assert.strictEqual(v020.http_status, 401);
    } finally {
      await stopMcpAgent(fresh);
    }
  });

  test('every negative mutation produces an MCP-shaped request under transport: mcp', () => {
    // Locks the invariant that every path in MUTATIONS routes through
    // applyTransport. A regression that bypasses applyTransport (e.g. a new
    // mutator that sets url/body directly from vector.request.*) shows up
    // here before it reaches the e2e grader.
    const {
      buildNegativeRequest,
      loadRequestSigningVectors,
    } = require('../dist/lib/testing/storyboard/request-signing/index.js');
    const loaded = loadRequestSigningVectors();
    const BASE = 'http://127.0.0.1:9999/mcp';
    for (const vector of loaded.negative) {
      const signed = buildNegativeRequest(vector, loaded.keys, { baseUrl: BASE, transport: 'mcp' });
      assert.strictEqual(signed.url, BASE, `${vector.id}: url must be baseUrl (MCP single endpoint)`);
      // Body is expected on every mutation — the vectors all have bodies.
      assert.ok(signed.body, `${vector.id}: body must be present`);
      const envelope = JSON.parse(signed.body);
      assert.strictEqual(envelope.jsonrpc, '2.0', `${vector.id}: jsonrpc`);
      assert.strictEqual(envelope.method, 'tools/call', `${vector.id}: method`);
      const originalOp = new URL(vector.request.url).pathname.split('/').filter(Boolean).pop();
      assert.strictEqual(envelope.params.name, originalOp, `${vector.id}: params.name from vector URL tail`);
    }
  });
});
