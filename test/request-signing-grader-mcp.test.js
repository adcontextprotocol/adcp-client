/**
 * End-to-end test: grader in MCP transport mode against the MCP signed
 * agent from test-agents/seller-agent-signed-mcp.ts. Validates that
 * `transport: 'mcp'` correctly wraps vectors in JSON-RPC envelopes, posts
 * to the agent's single MCP endpoint, and surfaces the verifier's
 * per-vector outcomes identically to raw mode.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');

const { gradeRequestSigning } = require('../dist/lib/testing/storyboard/request-signing/index.js');

// MCP signed agent is compiled to test-agents/dist/ — build it first if
// not already compiled. The test relies on the same compiled output.
const MCP_AGENT_SCRIPT = path.join(__dirname, '..', 'test-agents', 'dist', 'seller-agent-signed-mcp.js');

function startMcpAgent(port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MCP_AGENT_SCRIPT], {
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    const onLog = chunk => {
      if (settled) return;
      const s = chunk.toString();
      if (s.includes(`listening`) || s.includes(`running at`)) {
        settled = true;
        resolve(child);
      }
    };
    child.stdout.on('data', onLog);
    child.stderr.on('data', onLog);
    child.on('error', err => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(child); // assume started — let the grader fail out if not
      }
    }, 3000);
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

// Vectors 007/018 depend on the verifier advertising a specific
// covers_content_digest policy; the MCP agent advertises 'either', so skip
// them the same way the raw-HTTP e2e test does.
const CAPABILITY_PROFILE_VECTORS = ['007-missing-content-digest', '018-digest-covered-when-forbidden'];

describe('request-signing grader — MCP transport vs. reference MCP agent', () => {
  // Dynamic port so the test is safe to run in parallel; fallback to 3111.
  const PORT = Number.parseInt(process.env.ADCP_MCP_TEST_PORT ?? '3111', 10);
  const AGENT_URL = `http://127.0.0.1:${PORT}/mcp`;
  let agent;

  before(async () => {
    agent = await startMcpAgent(PORT);
  });

  after(async () => {
    await stopMcpAgent(agent);
  });

  test('MCP mode grades 25/25 non-profile vectors against the MCP signed agent', async () => {
    const report = await gradeRequestSigning(AGENT_URL, {
      allowPrivateIp: true,
      transport: 'mcp',
      skipRateAbuse: true,
      skipVectors: CAPABILITY_PROFILE_VECTORS,
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
    assert.strictEqual(report.positive.length, 8);
    assert.strictEqual(report.negative.length, 20);
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
});
