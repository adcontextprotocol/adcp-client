const assert = require('node:assert/strict');
const test = require('node:test');

const { BODY_SNIPPET_TIMEOUT_MS, OBSERVER_FLUSH_TIMEOUT_MS } = require('../../dist/lib/index.js');
const {
  sanitizeTransportHeaders,
  sanitizeTransportUrl,
  withTransportDiagnostics,
  wrapFetchWithTransportDiagnostics,
} = require('../../dist/lib/protocols/index.js');

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for transport diagnostic event');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('transport diagnostics emits sanitized request and response events', async () => {
  const events = [];
  const responsePayload = JSON.stringify({ ok: true, access_token: 'response-token', id: 'resp-1' });
  const upstream = async () =>
    new Response(responsePayload, {
      status: 202,
      statusText: 'Accepted',
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(responsePayload)),
        'set-cookie': 'sid=secret',
        'x-request-id': 'srv-req-1',
      },
    });
  const instrumentedFetch = wrapFetchWithTransportDiagnostics(upstream);

  const response = await withTransportDiagnostics(
    {
      agentId: 'agent-1',
      protocol: 'mcp',
      tool: 'get_products',
      operationId: 'op-1',
      taskId: 'task-1',
      contextId: 'ctx-1',
      idempotencyKey: 'idem-1',
      onTransportActivity: event => events.push(event),
    },
    () =>
      instrumentedFetch('https://user:pass@example.com/mcp?signature=signed#fragment', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer request-token',
          'Content-Type': 'application/json',
          Cookie: 'sid=secret',
          'x-adcp-auth': 'adcp-token',
          'x-api-key': 'api-key',
          'x-private-tenant': 'tenant-a',
          'x-scope3-debug-id': 'debug-1',
        },
        body: JSON.stringify({
          idempotency_key: 'idem-1',
          access_token: 'request-token',
          governance_context: 'signed-governance-token',
          consultation_context: 'consultation-handle',
          push_notification_config: {
            token: 'webhook-token',
            authentication: { credentials: 'webhook-secret' },
          },
        }),
      })
  );

  assert.equal(response.status, 202);
  assert.equal(await response.text(), responsePayload);

  await waitFor(() => events.length === 2);

  assert.equal(events.length, 2);
  const [started, received] = events;

  assert.equal(started.type, 'request_started');
  assert.equal(typeof started.transportRequestId, 'string');
  assert.equal(started.agentId, 'agent-1');
  assert.equal(started.protocol, 'mcp');
  assert.equal(started.tool, 'get_products');
  assert.equal(started.taskType, 'get_products');
  assert.equal(started.operationId, 'op-1');
  assert.equal(started.taskId, 'task-1');
  assert.equal(started.contextId, 'ctx-1');
  assert.equal(typeof started.idempotencyKeyHash, 'string');
  assert.notEqual(started.idempotencyKeyHash, 'idem-1');
  assert.equal(started.method, 'POST');
  assert.equal(started.url, 'https://example.com/mcp');
  assert.deepEqual(started.requestHeaders, {
    authorization: '[redacted]',
    'content-type': 'application/json',
    cookie: '[redacted]',
    'x-adcp-auth': '[redacted]',
    'x-api-key': '[redacted]',
    'x-scope3-debug-id': 'debug-1',
  });
  assert.equal(JSON.parse(started.requestBody).idempotency_key, '[redacted]');
  assert.equal(JSON.parse(started.requestBody).access_token, '[redacted]');
  assert.equal(JSON.parse(started.requestBody).governance_context, '[redacted]');
  assert.equal(JSON.parse(started.requestBody).consultation_context, '[redacted]');
  assert.equal(JSON.parse(started.requestBody).push_notification_config.token, '[redacted]');
  assert.equal(JSON.parse(started.requestBody).push_notification_config.authentication.credentials, '[redacted]');
  assert.equal(started.requestBodyTruncated, false);

  assert.equal(received.type, 'response_received');
  assert.equal(received.transportRequestId, started.transportRequestId);
  assert.equal(received.httpStatus, 202);
  assert.equal(received.statusText, 'Accepted');
  assert.equal(received.url, 'https://example.com/mcp');
  assert.equal(received.durationMs >= 0, true);
  assert.deepEqual(received.responseHeaders, {
    'content-type': 'application/json',
    'set-cookie': '[redacted]',
    'x-request-id': 'srv-req-1',
  });
  assert.deepEqual(JSON.parse(received.responseBody), {
    ok: true,
    access_token: '[redacted]',
    id: 'resp-1',
  });
  assert.equal(received.responseBodyTruncated, false);
});

test('transport diagnostics emits request_failed without swallowing the error', async () => {
  const events = [];
  const instrumentedFetch = wrapFetchWithTransportDiagnostics(async () => {
    throw new TypeError(
      'socket hang up for https://user:pass@seller.example/a2a?access_token=query-token with Bearer header-token'
    );
  });

  await assert.rejects(
    withTransportDiagnostics(
      {
        agentId: 'agent-2',
        protocol: 'a2a',
        tool: 'create_media_buy',
        onTransportActivity: event => events.push(event),
      },
      () => instrumentedFetch('https://seller.example/a2a', { method: 'POST' })
    ),
    /socket hang up/
  );

  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'request_started');
  assert.equal(events[1].type, 'request_failed');
  assert.equal(events[1].errorName, 'TypeError');
  assert.equal(events[1].errorMessage.includes('https://seller.example/a2a'), true);
  assert.equal(events[1].errorMessage.includes('user:pass'), false);
  assert.equal(events[1].errorMessage.includes('query-token'), false);
  assert.equal(events[1].errorMessage.includes('header-token'), false);
  assert.equal(events[1].durationMs >= 0, true);
});

test('transport diagnostics waits for async handlers after the request completes', async () => {
  const events = [];
  const instrumentedFetch = wrapFetchWithTransportDiagnostics(async () => new Response('{}'));

  await withTransportDiagnostics(
    {
      agentId: 'agent-async',
      protocol: 'mcp',
      tool: 'get_products',
      onTransportActivity: async event => {
        await new Promise(resolve => setTimeout(resolve, 5));
        events.push(event);
      },
    },
    () => instrumentedFetch('https://seller.example/mcp', { method: 'POST' })
  );

  assert.deepEqual(
    events.map(event => event.type),
    ['request_started', 'response_received']
  );
});

test('transport diagnostics bounds capture of a never-closing body without Content-Length', async () => {
  const events = [];
  let streamController;
  const stream = new ReadableStream({
    start(controller) {
      streamController = controller;
      controller.enqueue(new TextEncoder().encode('{"ok":true}'));
    },
  });
  const instrumentedFetch = wrapFetchWithTransportDiagnostics(
    async () => new Response(stream, { headers: { 'content-type': 'application/json' } })
  );

  let responseDeliveredAt;
  const captureStartedAt = Date.now();
  const response = await withTransportDiagnostics(
    {
      agentId: 'stalled-body-agent',
      protocol: 'mcp',
      onTransportActivity: event => events.push(event),
    },
    async () => {
      const startedAt = Date.now();
      const operational = await instrumentedFetch('https://seller.example/mcp');
      responseDeliveredAt = Date.now() - startedAt;
      return operational;
    }
  );
  const captureElapsed = Date.now() - captureStartedAt;

  assert.equal(responseDeliveredAt < BODY_SNIPPET_TIMEOUT_MS, true);
  assert.equal(captureElapsed < BODY_SNIPPET_TIMEOUT_MS + 1500, true);
  assert.equal(events.length, 2);
  assert.equal(events[1].responseBody, undefined);
  assert.equal(events[1].responseBodyTruncated, true);
  streamController.close();
  assert.equal(await response.text(), '{"ok":true}');
});

test('transport diagnostics returns a declared streaming response before asynchronous preview capture completes', async () => {
  const events = [];
  let streamController;
  const body = '{"ok":true}';
  const stream = new ReadableStream({
    start(controller) {
      streamController = controller;
      controller.enqueue(new TextEncoder().encode(body));
    },
  });
  const instrumentedFetch = wrapFetchWithTransportDiagnostics(
    async () =>
      new Response(stream, {
        headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
      })
  );

  let response;
  let consumed;
  await withTransportDiagnostics(
    {
      agentId: 'declared-stream-agent',
      protocol: 'mcp',
      onTransportActivity: event => events.push(event),
    },
    async () => {
      const startedAt = Date.now();
      response = await instrumentedFetch('https://seller.example/mcp');
      assert.equal(Date.now() - startedAt < BODY_SNIPPET_TIMEOUT_MS, true);
      assert.equal(events.length, 1, 'capture remains asynchronous after the operational response is delivered');
      setTimeout(() => streamController.close(), 20);
      consumed = await response.text();
    }
  );

  assert.equal(consumed, body);
  assert.equal(events.length, 2, 'the enclosing scope flushes the canonical response event');
  assert.equal(events[1].responseBody, body);
  assert.equal(events[1].responseBodyTruncated, false);
});

test('transport diagnostics emits one truncated response event when declared preview capture expires', async () => {
  const events = [];
  let streamController;
  const body = '{"ok":true}';
  const stream = new ReadableStream({
    start(controller) {
      streamController = controller;
      controller.enqueue(new TextEncoder().encode(body));
    },
  });
  const instrumentedFetch = wrapFetchWithTransportDiagnostics(
    async () =>
      new Response(stream, {
        headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
      })
  );

  let responseDeliveredAt;
  const response = await withTransportDiagnostics(
    {
      agentId: 'expired-capture-agent',
      protocol: 'mcp',
      onTransportActivity: event => events.push(event),
    },
    async () => {
      const startedAt = Date.now();
      const operational = await instrumentedFetch('https://seller.example/mcp');
      responseDeliveredAt = Date.now() - startedAt;
      return operational;
    }
  );
  assert.equal(responseDeliveredAt < BODY_SNIPPET_TIMEOUT_MS, true);

  assert.equal(events.length, 2);
  assert.equal(events.filter(event => event.type === 'response_received').length, 1);
  assert.equal(events[1].responseBody, undefined);
  assert.equal(events[1].responseBodyTruncated, true);
  streamController.close();
  assert.equal(await response.text(), body);
});

test('transport diagnostics bounds a never-settling async observer', async () => {
  const instrumentedFetch = wrapFetchWithTransportDiagnostics(async () => new Response('{}'));
  const startedAt = Date.now();
  const result = await withTransportDiagnostics(
    {
      agentId: 'stalled-observer-agent',
      protocol: 'mcp',
      onTransportActivity: () => new Promise(() => {}),
    },
    async () => (await instrumentedFetch('https://seller.example/mcp')).text()
  );
  const elapsed = Date.now() - startedAt;

  assert.equal(result, '{}');
  assert.equal(elapsed >= OBSERVER_FLUSH_TIMEOUT_MS, true);
  assert.equal(elapsed < OBSERVER_FLUSH_TIMEOUT_MS + 1500, true);
});

test('ESM transport diagnostics entry keeps observer work off the unbounded critical path', async () => {
  const esm = await import('../../dist/lib/protocols/index.mjs');
  const publicEsm = await import('../../dist/lib/index.mjs');
  const instrumentedFetch = esm.wrapFetchWithTransportDiagnostics(async () => new Response('{}'));
  const startedAt = Date.now();
  const result = await esm.withTransportDiagnostics(
    {
      agentId: 'esm-stalled-observer-agent',
      protocol: 'mcp',
      onTransportActivity: () => new Promise(() => {}),
    },
    async () => (await instrumentedFetch('https://seller.example/mcp')).text()
  );

  assert.equal(result, '{}');
  assert.equal(Date.now() - startedAt < publicEsm.OBSERVER_FLUSH_TIMEOUT_MS + 1500, true);
});

test('ESM transport diagnostics bounds an unbounded body preview', async () => {
  const esm = await import('../../dist/lib/protocols/index.mjs');
  const events = [];
  let streamController;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        streamController = controller;
        controller.enqueue(new TextEncoder().encode('{}'));
      },
    }),
    { headers: { 'content-type': 'application/json' } }
  );
  const originalClone = response.clone.bind(response);
  let cloneCalls = 0;
  response.clone = () => {
    cloneCalls += 1;
    return originalClone();
  };
  const instrumentedFetch = esm.wrapFetchWithTransportDiagnostics(async () => response);

  const operational = await esm.withTransportDiagnostics(
    {
      agentId: 'esm-unbounded-agent',
      protocol: 'mcp',
      onTransportActivity: event => events.push(event),
    },
    () => instrumentedFetch('https://seller.example/mcp')
  );

  assert.equal(cloneCalls, 1);
  assert.equal(events.length, 2);
  assert.equal(events[1].responseBodyTruncated, true);
  streamController.close();
  assert.equal(await operational.text(), '{}');
});

test('transport diagnostics skips SSE response previews without disturbing the stream', async () => {
  const events = [];
  const body = 'event: message\ndata: {"ok":true}\n\n';
  const instrumentedFetch = wrapFetchWithTransportDiagnostics(
    async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  );
  const response = await withTransportDiagnostics(
    {
      agentId: 'sse-agent',
      protocol: 'mcp',
      onTransportActivity: event => events.push(event),
    },
    () => instrumentedFetch('https://seller.example/mcp')
  );

  assert.equal(events[1].responseBody, undefined);
  assert.equal(events[1].responseBodyTruncated, true);
  assert.equal(await response.text(), body);
});

test('transport diagnostics skips non-text and declared oversized bodies', async () => {
  for (const [name, headers] of [
    ['non-text', { 'content-type': 'application/octet-stream', 'content-length': '2' }],
    ['over-limit', { 'content-type': 'application/json', 'content-length': String(64 * 1024 + 1) }],
  ]) {
    const events = [];
    const response = new Response('{}', { headers });
    const originalClone = response.clone.bind(response);
    let cloneCalls = 0;
    response.clone = () => {
      cloneCalls += 1;
      return originalClone();
    };
    const instrumentedFetch = wrapFetchWithTransportDiagnostics(async () => response);

    const operational = await withTransportDiagnostics(
      {
        agentId: `skip-${name}-agent`,
        protocol: 'mcp',
        onTransportActivity: event => events.push(event),
      },
      () => instrumentedFetch('https://seller.example/mcp')
    );

    assert.equal(cloneCalls, 0, name);
    assert.equal(events.length, 2, name);
    assert.equal(events[1].responseBodyTruncated, true, name);
    assert.equal(await operational.text(), '{}', name);
  }
});

test('transport diagnostics captures text bodies without a finite Content-Length', async () => {
  for (const [name, headers] of [
    ['missing-length', { 'content-type': 'application/json' }],
    ['invalid-length', { 'content-type': 'application/json', 'content-length': 'unknown' }],
  ]) {
    const events = [];
    const response = new Response('{"ok":true}', { headers });
    const originalClone = response.clone.bind(response);
    let cloneCalls = 0;
    response.clone = () => {
      cloneCalls += 1;
      return originalClone();
    };
    const instrumentedFetch = wrapFetchWithTransportDiagnostics(async () => response);

    const operational = await withTransportDiagnostics(
      {
        agentId: `capture-${name}-agent`,
        protocol: 'mcp',
        onTransportActivity: event => events.push(event),
      },
      () => instrumentedFetch('https://seller.example/mcp')
    );

    assert.equal(cloneCalls, 1, name);
    assert.equal(events.length, 2, name);
    assert.equal(events[1].responseBody, '{"ok":true}', name);
    assert.equal(events[1].responseBodyTruncated, false, name);
    assert.equal(await operational.text(), '{"ok":true}', name);
  }
});

test('transport diagnostics does not deadlock on responses larger than the snippet limit', async () => {
  const events = [];
  const largeBody = JSON.stringify({ payload: 'x'.repeat(70 * 1024) });
  const instrumentedFetch = wrapFetchWithTransportDiagnostics(
    async () => new Response(largeBody, { headers: { 'content-type': 'application/json' } })
  );

  let timeout;
  let consumedBody;
  try {
    consumedBody = await Promise.race([
      withTransportDiagnostics(
        {
          agentId: 'large-catalog-agent',
          protocol: 'mcp',
          onTransportActivity: event => events.push(event),
        },
        async () => {
          const response = await instrumentedFetch('https://seller.example/mcp', { method: 'POST' });
          return response.text();
        }
      ),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('large diagnostic response timed out')), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }

  assert.equal(consumedBody, largeBody);
  assert.equal(events.length, 2);
  assert.equal(events[1].type, 'response_received');
  assert.equal(events[1].responseBody.length, 64 * 1024);
  assert.equal(events[1].responseBodyTruncated, true);
});

test('transport diagnostics redacts camelCase secrets and strips URL-bearing body fields', async () => {
  const events = [];
  const responsePayload = JSON.stringify({
    refreshToken: 'response-refresh',
    nested: [{ privateKey: 'pem-secret' }],
    callbackUrl: 'https://callback.example/path?token=response-token#frag',
  });
  const instrumentedFetch = wrapFetchWithTransportDiagnostics(
    async () =>
      new Response(responsePayload, {
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(responsePayload)),
        },
      })
  );

  await withTransportDiagnostics(
    {
      agentId: 'agent-3',
      protocol: 'mcp',
      tool: 'sync_creatives',
      onTransportActivity: event => events.push(event),
    },
    () =>
      instrumentedFetch('https://seller.example/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          accessToken: 'request-token',
          nested: [{ privateKey: 'pem-secret' }],
          webhookUrl: 'https://hooks.example/path?token=request-token#frag',
        }),
      })
  );

  await waitFor(() => events.length === 2);

  assert.deepEqual(JSON.parse(events[0].requestBody), {
    accessToken: '[redacted]',
    nested: [{ privateKey: '[redacted]' }],
    webhookUrl: 'https://hooks.example/path',
  });
  assert.deepEqual(JSON.parse(events[1].responseBody), {
    refreshToken: '[redacted]',
    nested: [{ privateKey: '[redacted]' }],
    callbackUrl: 'https://callback.example/path',
  });
});

test('transport diagnostics redacts sensitive form-style body fields', async () => {
  const events = [];
  const instrumentedFetch = wrapFetchWithTransportDiagnostics(async () => new Response('{}'));

  await withTransportDiagnostics(
    {
      agentId: 'agent-3',
      protocol: 'mcp',
      tool: 'sync_creatives',
      onTransportActivity: event => events.push(event),
    },
    () =>
      instrumentedFetch('https://seller.example/mcp', {
        method: 'POST',
        body: 'access_token=secret-token&safe=value',
      })
  );

  assert.equal(events[0].requestBody, 'access_token=[redacted]&safe=value');
});

test('transport diagnostics helpers sanitize URLs and headers', () => {
  assert.equal(
    sanitizeTransportUrl('https://user:pass@example.com/path?token=signed#frag'),
    'https://example.com/path'
  );
  assert.deepEqual(
    sanitizeTransportHeaders({
      Authorization: 'Bearer secret',
      'mcp-session-id': 'session-secret',
      Traceparent: '00-abc',
      'x-custom-routing': 'tenant',
      'x-scope3-debug-id': 'debug',
    }),
    {
      authorization: '[redacted]',
      'mcp-session-id': '[redacted]',
      traceparent: '00-abc',
      'x-scope3-debug-id': 'debug',
    }
  );
});
