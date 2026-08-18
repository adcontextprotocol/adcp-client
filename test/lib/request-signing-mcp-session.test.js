// Tests for MCP session initialization and Mcp-Session-Id header injection.
// Validates that (1) the grader auto-initializes a session when transport='mcp',
// (2) the session ID is injected AFTER signing so it is not a covered component,
// and (3) passing '' opts out of auto-init for stateless servers.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('MCP session injection preserves the already-computed signature headers byte-for-byte', () => {
  const { attachMcpSessionHeader } = require('../../dist/lib/testing/storyboard/request-signing/probe.js');
  const signedHeaders = {
    'Content-Type': 'application/json',
    'Content-Digest': 'sha-256=:signed-digest:',
    'Signature-Input': 'sig1=("@method" "@target-uri" "content-digest");created=1',
    Signature: 'sig1=:signed-bytes:',
  };

  const withSession = attachMcpSessionHeader(signedHeaders, 'session-123');

  assert.strictEqual(withSession['Signature-Input'], signedHeaders['Signature-Input']);
  assert.strictEqual(withSession.Signature, signedHeaders.Signature);
  assert.strictEqual(withSession['Content-Digest'], signedHeaders['Content-Digest']);
  assert.strictEqual(withSession['Mcp-Session-Id'], 'session-123');
  assert.strictEqual(
    withSession['MCP-Protocol-Version'],
    undefined,
    'a pre-provisioned session must not invent a protocol version'
  );
  assert.strictEqual(signedHeaders['Mcp-Session-Id'], undefined, 'the signed header object is not mutated');
});

test('official MCP lifecycle sends initialized and carries negotiated headers into signed probes', async t => {
  const {
    initializeMcpSession,
    probeSignedRequest,
  } = require('../../dist/lib/testing/storyboard/request-signing/probe.js');
  const seen = [];
  let listeningGetCount = 0;
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    if (req.method === 'GET' || req.method === 'DELETE') {
      if (req.method === 'GET') listeningGetCount++;
      res.writeHead(405).end();
      return;
    }
    seen.push({ method: body?.method, headers: req.headers });

    if (body?.method === 'initialize') {
      res.writeHead(200, {
        'content-type': 'application/json',
        'mcp-session-id': 'strict-session-123',
      });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            serverInfo: { name: 'strict-test-server', version: '1.0.0' },
          },
        })
      );
      return;
    }

    assert.strictEqual(req.headers['mcp-session-id'], 'strict-session-123');
    assert.strictEqual(req.headers['mcp-protocol-version'], '2024-11-05');
    if (body?.method === 'notifications/initialized') {
      res.writeHead(202).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [] } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/mcp`;

  const initialized = await initializeMcpSession(url, { allowPrivateIp: true });
  assert.deepStrictEqual(initialized, {
    sessionId: 'strict-session-123',
    protocolVersion: '2024-11-05',
  });

  const result = await probeSignedRequest(
    {
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json', Signature: 'sig1=:signed-bytes:' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'test', arguments: {} } }),
    },
    {
      allowPrivateIp: true,
      mcpSessionId: initialized.sessionId,
      mcpProtocolVersion: initialized.protocolVersion,
    }
  );

  assert.strictEqual(result.status, 200);
  assert.deepStrictEqual(
    seen.map(entry => entry.method),
    ['initialize', 'notifications/initialized', 'tools/call']
  );
  assert.strictEqual(listeningGetCount, 0, 'grader must not leave an optional listening SSE request open');
});

test('default MCP mode does not initialize when all vectors skip or run locally', async () => {
  const { gradeOneVector, gradeRequestSigning } = require('../../dist/lib/testing/storyboard/request-signing/index.js');
  const unreachable = 'http://127.0.0.1:1/mcp';

  const skipped = await gradeRequestSigning(unreachable, {
    allowPrivateIp: true,
    onlyVectors: ['005-default-port-stripped'],
  });
  assert.strictEqual(skipped.failed_count, 0);
  assert.strictEqual(skipped.skipped_count, skipped.positive.length + skipped.negative.length);

  const local = await gradeOneVector('025-jwk-alg-crv-mismatch', 'negative', unreachable, {
    allowPrivateIp: true,
  });
  assert.strictEqual(local.passed, true);
  assert.strictEqual(local.http_status, 0);
});

test('MCP initialization honors caller cancellation before the probe timeout', async t => {
  const { initializeMcpSession } = require('../../dist/lib/testing/storyboard/request-signing/probe.js');
  const server = http.createServer((_req, _res) => {
    // Deliberately leave initialize pending until the caller aborts.
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const started = Date.now();

  const initialized = await initializeMcpSession(`http://127.0.0.1:${port}/mcp`, {
    allowPrivateIp: true,
    timeoutMs: 2_000,
    signal: controller.signal,
  });

  assert.ok(initialized.error);
  assert.ok(Date.now() - started < 1_000, 'caller abort should not wait for the probe timeout');
});

test('successful probes dispose composed caller-signal listeners', async t => {
  const { probeSignedRequest } = require('../../dist/lib/testing/storyboard/request-signing/probe.js');
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  const controller = new AbortController();
  const signal = controller.signal;
  const originalAdd = signal.addEventListener.bind(signal);
  const originalRemove = signal.removeEventListener.bind(signal);
  let adds = 0;
  let removes = 0;
  signal.addEventListener = (...args) => {
    adds++;
    return originalAdd(...args);
  };
  signal.removeEventListener = (...args) => {
    removes++;
    return originalRemove(...args);
  };

  const result = await probeSignedRequest(
    {
      method: 'POST',
      url: `http://127.0.0.1:${port}/mcp`,
      headers: { 'content-type': 'application/json' },
      body: '{}',
    },
    { allowPrivateIp: true, signal }
  );

  assert.strictEqual(result.status, 200);
  assert.strictEqual(adds, 1);
  assert.strictEqual(removes, adds, 'successful probe must remove its caller abort listener');
});

test('CLI reads MCP initialize authorization from the environment without forwarding it to signed vectors', async t => {
  const lifecycle = [];
  const secret = 'Bearer cli-initialize-secret';
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    if (req.method === 'GET' || req.method === 'DELETE') {
      res.writeHead(405).end();
      return;
    }
    lifecycle.push(body?.method);

    if (body?.method === 'initialize') {
      assert.strictEqual(req.headers.authorization, secret);
      res.writeHead(200, {
        'content-type': 'application/json',
        'mcp-session-id': 'cli-session',
      });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            serverInfo: { name: 'cli-test', version: '1.0.0' },
          },
        })
      );
      return;
    }
    if (body?.method === 'notifications/initialized') {
      assert.strictEqual(req.headers.authorization, secret);
      res.writeHead(202).end();
      return;
    }
    assert.strictEqual(req.headers.authorization, undefined, 'bearer must not be copied onto signed vectors');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [] } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  const cli = path.resolve(__dirname, '../../bin/adcp-grade.js');

  const child = spawn(
    process.execPath,
    [cli, 'request-signing', `http://127.0.0.1:${port}/mcp`, '--allow-http', '--only', '001-basic-post', '--json'],
    {
      env: { ...process.env, ADCP_GRADE_INITIALIZE_AUTHORIZATION: secret },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => (stdout += chunk));
  child.stderr.on('data', chunk => (stderr += chunk));
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });

  assert.strictEqual(exitCode, 0, stderr);
  assert.strictEqual(JSON.parse(stdout).passed, true);
  assert.deepStrictEqual(lifecycle, ['initialize', 'notifications/initialized', 'tools/call']);
});

test('initializeMcpSession is exported from the request-signing barrel', () => {
  const mod = require('../../dist/lib/testing/storyboard/request-signing/index.js');
  assert.strictEqual(typeof mod.initializeMcpSession, 'function');
});

test('request-signing grader is importable from its documented package subpath', () => {
  const mod = require('@adcp/sdk/testing/storyboard/request-signing');
  assert.strictEqual(typeof mod.gradeRequestSigning, 'function');
});

test('empty MCP session sentinel leaves the signed header object unchanged', () => {
  const { attachMcpSessionHeader } = require('../../dist/lib/testing/storyboard/request-signing/probe.js');
  const signedHeaders = { Signature: 'sig1=:signed-bytes:' };
  assert.strictEqual(attachMcpSessionHeader(signedHeaders, ''), signedHeaders);
});
