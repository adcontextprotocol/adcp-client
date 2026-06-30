const assert = require('node:assert/strict');
const test = require('node:test');

const {
  sanitizeTransportHeaders,
  sanitizeTransportUrl,
  withTransportDiagnostics,
  wrapFetchWithTransportDiagnostics,
} = require('../../dist/lib/protocols/index.js');

test('transport diagnostics emits sanitized request and response events', async () => {
  const events = [];
  const upstream = async () =>
    new Response(JSON.stringify({ ok: true, access_token: 'response-token', id: 'resp-1' }), {
      status: 202,
      statusText: 'Accepted',
      headers: {
        'content-type': 'application/json',
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
          push_notification_config: {
            token: 'webhook-token',
            authentication: { credentials: 'webhook-secret' },
          },
        }),
      })
  );

  assert.equal(response.status, 202);
  assert.equal(await response.text(), JSON.stringify({ ok: true, access_token: 'response-token', id: 'resp-1' }));

  assert.equal(events.length, 2);
  const [started, received] = events;

  assert.equal(started.type, 'request_started');
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
  assert.equal(JSON.parse(started.requestBody).push_notification_config.token, '[redacted]');
  assert.equal(JSON.parse(started.requestBody).push_notification_config.authentication.credentials, '[redacted]');
  assert.equal(started.requestBodyTruncated, false);

  assert.equal(received.type, 'response_received');
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

test('transport diagnostics redacts camelCase secrets and strips URL-bearing body fields', async () => {
  const events = [];
  const instrumentedFetch = wrapFetchWithTransportDiagnostics(
    async () =>
      new Response(
        JSON.stringify({
          refreshToken: 'response-refresh',
          nested: [{ privateKey: 'pem-secret' }],
          callbackUrl: 'https://callback.example/path?token=response-token#frag',
        }),
        { headers: { 'content-type': 'application/json' } }
      )
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
