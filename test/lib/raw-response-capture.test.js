// Raw HTTP response capture — verifies the AsyncLocalStorage-scoped
// wrapper records status, headers, body, and latency from a live local
// server, and is a pass-through when no capture slot is active.

const { describe, test, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const {
  wrapFetchWithCapture,
  withRawResponseCapture,
  rawResponseCaptureStorage,
} = require('../../dist/lib/protocols/rawResponseCapture.js');

function startServer(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function stop(server) {
  return new Promise(resolve => server.close(resolve));
}

describe('rawResponseCapture', () => {
  const servers = [];
  after(async () => {
    for (const s of servers) await stop(s);
  });

  test('records status, headers, body, latency when capture is active', async () => {
    const { server, url } = await startServer((req, res) => {
      res.writeHead(404, {
        'content-type': 'application/json',
        'x-request-id': 'req-123',
        etag: '"v1"',
      });
      res.end(JSON.stringify({ error: { code: 'REFERENCE_NOT_FOUND' } }));
    });
    servers.push(server);

    const capturingFetch = wrapFetchWithCapture(fetch);
    const { result, captures } = await withRawResponseCapture(async () => {
      const res = await capturingFetch(url + '/probe');
      return res.status;
    });

    assert.equal(result, 404);
    assert.equal(captures.length, 1);
    const [cap] = captures;
    assert.equal(cap.status, 404);
    assert.equal(cap.method, 'GET');
    assert.equal(cap.url, url + '/probe');
    assert.equal(cap.headers['content-type'], 'application/json');
    assert.equal(cap.headers['x-request-id'], 'req-123');
    assert.equal(cap.headers.etag, '"v1"');
    assert.equal(cap.body, JSON.stringify({ error: { code: 'REFERENCE_NOT_FOUND' } }));
    assert.equal(cap.bodyTruncated, false);
    assert.ok(typeof cap.latencyMs === 'number' && cap.latencyMs >= 0);
    assert.ok(typeof cap.timestamp === 'string' && !Number.isNaN(Date.parse(cap.timestamp)));
  });

  test('is a pass-through when no capture slot is active', async () => {
    const { server, url } = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    servers.push(server);

    // No withRawResponseCapture wrapper — ALS slot is absent.
    const capturingFetch = wrapFetchWithCapture(fetch);
    const res = await capturingFetch(url);
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.equal(body, '{"ok":true}');
    // No store exists; the wrapper must not have tried to record anywhere.
    assert.equal(rawResponseCaptureStorage.getStore(), undefined);
  });

  test('records method and preserves body for SDK consumption', async () => {
    const { server, url } = await startServer(async (req, res) => {
      let received = '';
      for await (const chunk of req) received += chunk;
      const parsed = JSON.parse(received);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ echo: parsed }));
    });
    servers.push(server);

    const capturingFetch = wrapFetchWithCapture(fetch);
    const { captures } = await withRawResponseCapture(async () => {
      const res = await capturingFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hello: 'world' }),
      });
      // Downstream SDK code needs to still be able to read the body after
      // we've captured it from the clone.
      const parsed = await res.json();
      assert.deepEqual(parsed, { echo: { hello: 'world' } });
      return parsed;
    });

    assert.equal(captures.length, 1);
    assert.equal(captures[0].method, 'POST');
    assert.equal(captures[0].body, JSON.stringify({ echo: { hello: 'world' } }));
  });

  test('extracts JSON-RPC metadata when fetch receives a Request body', async () => {
    const { server, url } = await startServer(async (req, res) => {
      for await (const _chunk of req) void _chunk;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"jsonrpc":"2.0","id":"response","result":{}}');
    });
    servers.push(server);

    const capturingFetch = wrapFetchWithCapture(fetch);
    const request = new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'request',
        method: 'SendMessage',
        params: { message: { parts: [{ data: { skill: 'list_creatives', input: {} } }] } },
      }),
    });
    const { captures } = await withRawResponseCapture(() => capturingFetch(request));

    assert.equal(captures[0].requestJsonRpcMethod, 'SendMessage');
    assert.equal(captures[0].requestAdcpSkill, 'list_creatives');
  });

  test('does not retain or parse Request metadata beyond the request-body cap', async () => {
    const { server, url } = await startServer(async (req, res) => {
      for await (const _chunk of req) void _chunk;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    servers.push(server);

    const request = new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'SendMessage',
        params: { message: { parts: [{ data: { skill: 'list_creatives', input: { pad: 'x'.repeat(512) } } }] } },
      }),
    });
    const { captures } = await withRawResponseCapture(() => wrapFetchWithCapture(fetch)(request), {
      maxBodyBytes: 64,
    });

    assert.equal(captures[0].requestJsonRpcMethod, undefined);
    assert.equal(captures[0].requestAdcpSkill, undefined);
  });

  test('bounds metadata reads for a Request stream that never closes', async () => {
    let upstreamCalls = 0;
    const stream = new ReadableStream({ pull() {} });
    const request = new Request('https://seller.example/rpc', {
      method: 'POST',
      body: stream,
      duplex: 'half',
    });
    const startedAt = Date.now();
    const { captures } = await withRawResponseCapture(
      () =>
        wrapFetchWithCapture(async () => {
          upstreamCalls += 1;
          return new Response('{}');
        })(request),
      { requestMetadataTimeoutMs: 20 }
    );

    assert.ok(Date.now() - startedAt < 500, 'metadata capture must not wait indefinitely for a streaming body');
    assert.equal(upstreamCalls, 1);
    assert.equal(captures[0].requestJsonRpcMethod, undefined);
    assert.equal(captures[0].requestAdcpSkill, undefined);
  });

  test('stops a pending Request metadata read when its signal aborts', async () => {
    const controller = new AbortController();
    const request = new Request('https://seller.example/rpc', {
      method: 'POST',
      body: new ReadableStream({ pull() {} }),
      duplex: 'half',
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error('request deadline')), 20);
    const startedAt = Date.now();
    const { captures } = await withRawResponseCapture(
      () => wrapFetchWithCapture(async () => new Response('{}'))(request),
      { requestMetadataTimeoutMs: 5_000 }
    );

    assert.ok(Date.now() - startedAt < 500, 'request abort must stop metadata capture before its fallback timeout');
    assert.equal(captures[0].requestJsonRpcMethod, undefined);
  });

  test('truncates body when it exceeds maxBodyBytes', async () => {
    const big = 'A'.repeat(10_000);
    const { server, url } = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(big);
    });
    servers.push(server);

    const capturingFetch = wrapFetchWithCapture(fetch);
    const { captures } = await withRawResponseCapture(
      async () => {
        const res = await capturingFetch(url);
        // SDK path must still work after truncation (clone is untouched).
        return res.text();
      },
      { maxBodyBytes: 512 }
    );

    assert.equal(captures.length, 1);
    assert.equal(captures[0].bodyTruncated, true);
    assert.equal(captures[0].body.length, 512);
    assert.equal(captures[0].body, 'A'.repeat(512));
  });

  test('stops reading the capture clone after maxBodyBytes', async () => {
    let pulls = 0;
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          pulls += 1;
          controller.enqueue(new TextEncoder().encode('B'.repeat(128)));
        },
      })
    );
    const capturingFetch = wrapFetchWithCapture(async () => response);
    const { captures } = await withRawResponseCapture(() => capturingFetch('https://seller.example/rpc'), {
      maxBodyBytes: 64,
    });

    assert.equal(captures[0].body, 'B'.repeat(64));
    assert.equal(captures[0].bodyTruncated, true);
    assert.ok(pulls <= 3, `capture should stop streaming promptly, observed ${pulls} pulls`);
    await response.body.cancel();
  });

  test('response-body capture has an independent deadline when headers arrive but the body stalls', async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{'));
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
    const startedAt = Date.now();
    const { captures } = await withRawResponseCapture(
      () => wrapFetchWithCapture(async () => response)('https://seller.example/rpc'),
      { responseBodyTimeoutMs: 20 }
    );

    assert.ok(Date.now() - startedAt < 500, 'capture deadline must bound a response body that never closes');
    assert.strictEqual(captures[0].body, '{');
    assert.strictEqual(captures[0].bodyTruncated, true);
    await response.body.cancel();
  });

  test('rejects invalid response-body capture deadlines before dispatch', async () => {
    for (const responseBodyTimeoutMs of [0, -1, Number.POSITIVE_INFINITY, 2_147_483_648]) {
      await assert.rejects(
        withRawResponseCapture(async () => undefined, { responseBodyTimeoutMs }),
        /responseBodyTimeoutMs must be a finite positive number/
      );
    }
  });

  test('validates maxBodyBytes before dispatch or typed-array allocation', async () => {
    let dispatched = false;
    for (const maxBodyBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(
        withRawResponseCapture(
          async () => {
            dispatched = true;
          },
          { maxBodyBytes }
        ),
        /maxBodyBytes must be a finite safe positive integer/
      );
    }
    assert.equal(dispatched, false);
  });

  test('accepts the finite safe positive integer boundaries for maxBodyBytes', async () => {
    const minimum = await withRawResponseCapture(async () => 'minimum', { maxBodyBytes: 1 });
    const maximum = await withRawResponseCapture(async () => 'maximum', { maxBodyBytes: Number.MAX_SAFE_INTEGER });
    assert.equal(minimum.result, 'minimum');
    assert.equal(maximum.result, 'maximum');
  });

  test('records multiple requests in order', async () => {
    const { server, url } = await startServer((req, res) => {
      const id = req.url.slice(1);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id }));
    });
    servers.push(server);

    const capturingFetch = wrapFetchWithCapture(fetch);
    const { captures } = await withRawResponseCapture(async () => {
      await capturingFetch(url + '/one');
      await capturingFetch(url + '/two');
      await capturingFetch(url + '/three');
    });

    assert.equal(captures.length, 3);
    assert.equal(captures[0].url, url + '/one');
    assert.equal(captures[1].url, url + '/two');
    assert.equal(captures[2].url, url + '/three');
  });

  test('redacts credential-bearing response headers', async () => {
    const { server, url } = await startServer((req, res) => {
      res.writeHead(401, {
        'content-type': 'application/json',
        authorization: 'Bearer leaked-token-abc',
        'x-adcp-auth': 'api-key-xyz',
        cookie: 'session=secret',
      });
      res.end('{}');
    });
    servers.push(server);

    const capturingFetch = wrapFetchWithCapture(fetch);
    const { captures } = await withRawResponseCapture(async () => {
      await capturingFetch(url);
    });
    const [cap] = captures;
    assert.equal(cap.headers.authorization, '[redacted]');
    assert.equal(cap.headers['x-adcp-auth'], '[redacted]');
    assert.equal(cap.headers.cookie, '[redacted]');
    // Non-sensitive header passes through.
    assert.equal(cap.headers['content-type'], 'application/json');
  });

  test('redacts bearer tokens echoed inside response body', async () => {
    const { server, url } = await startServer((req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ debug: 'received Authorization: Bearer abc.def.ghi on request' }));
    });
    servers.push(server);

    const capturingFetch = wrapFetchWithCapture(fetch);
    const { captures } = await withRawResponseCapture(async () => {
      await capturingFetch(url);
    });
    assert.match(captures[0].body, /Bearer \[redacted\]/);
    assert.doesNotMatch(captures[0].body, /abc\.def\.ghi/);
  });

  test('capture slots do not leak across concurrent withRawResponseCapture calls', async () => {
    const { server, url } = await startServer((req, res) => {
      const id = req.url.slice(1);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id }));
    });
    servers.push(server);

    const capturingFetch = wrapFetchWithCapture(fetch);

    const [a, b] = await Promise.all([
      withRawResponseCapture(async () => {
        await capturingFetch(url + '/a1');
        await capturingFetch(url + '/a2');
      }),
      withRawResponseCapture(async () => {
        await capturingFetch(url + '/b1');
      }),
    ]);

    assert.equal(a.captures.length, 2);
    assert.equal(a.captures[0].url, url + '/a1');
    assert.equal(a.captures[1].url, url + '/a2');
    assert.equal(b.captures.length, 1);
    assert.equal(b.captures[0].url, url + '/b1');
  });
});
