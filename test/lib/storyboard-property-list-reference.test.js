const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { verifyPropertyListReference } = require('../../dist/lib/testing/storyboard/property-list-reference.js');
const { runStoryboard, runStoryboardStep } = require('../../dist/lib/testing/storyboard/runner.js');
const { redactSecrets } = require('../../dist/lib/utils/redact-secrets.js');
const { runValidations } = require('../../dist/lib/testing/storyboard/validations.js');
const { withTestClientScope } = require('../../dist/lib/testing/client.js');
const {
  rememberPropertyListCredentials,
  withPropertyListCredentialRedaction,
} = require('../../dist/lib/testing/storyboard/property-list-reference.js');

const TOKEN = 'reference-credential-that-must-never-appear-in-reports';
const OWNER = 'owner-credential-that-must-never-reach-the-probe';
const identifiers = ['news', 'sports', 'video'].map(name => ({ type: 'domain', value: `${name}.publisher.example` }));
const list = { list_id: 'shared-list', name: 'Shared reference list' };
const validation = {
  check: 'property_list_reference',
  description: 'Reference is isolated',
  agent_url: '$agent_url',
  list_id_path: 'list.list_id',
  auth_token_path: 'auth_token',
  denied_list_id: 'control-list',
  page_size: 2,
  max_pages: 3,
  expected_identifiers: identifiers,
};
let server;
let url;
let received;
let mode;
let initializes;
let sessions;
let pageCalls;
let openStreams;
let activeAbort;
let pendingStream;

before(async () => {
  server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const rpc = body ? JSON.parse(body) : null;
    received.push({ method: req.method, url: req.url, headers: req.headers, rpc });
    if (req.url !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    if (req.method === 'DELETE') {
      res.writeHead(200).end();
      return;
    }
    if (req.method === 'GET' && mode === 'open-stream') {
      openStreams.add(res);
      res.on('close', () => openStreams.delete(res));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': keepalive\n\n');
      return;
    }
    if (req.method === 'GET' && mode === 'delayed-get') {
      pendingStream = res;
      openStreams.add(res);
      res.on('close', () => openStreams.delete(res));
      return;
    }
    if (req.method === 'GET' || (!rpc?.id && rpc?.id !== 0)) {
      res.writeHead(202).end();
      return;
    }
    if (mode === 'redirect') {
      res.writeHead(307, { location: '/must-not-follow' }).end();
      return;
    }
    if (rpc.method === 'initialize') {
      initializes++;
      if (mode === 'init-denied') {
        res.writeHead(401).end();
        return;
      }
      const session = `probe-session-${initializes}`;
      received.at(-1).issuedSessionId = session;
      sessions.add(session);
      res.setHeader('mcp-session-id', session);
      send({
        protocolVersion: rpc.params.protocolVersion,
        serverInfo: { name: `List issuer ${TOKEN}`, version: '1.0' },
        capabilities: { tools: {} },
      });
      return;
    }
    if (rpc.method === 'tools/list') {
      send({
        tools: ['get_adcp_capabilities', 'create_property_list', 'get_property_list', 'update_property_list'].map(
          name => ({ name, inputSchema: { type: 'object', additionalProperties: true } })
        ),
      });
      return;
    }
    const { name, arguments: args } = rpc.params;
    const owner = req.headers.authorization === `Bearer ${OWNER}`;
    if (name === 'get_adcp_capabilities') {
      send(
        tool({
          adcp_version: '3.2',
          adcp: {
            major_versions: [3],
            supported_versions: ['3.2'],
            idempotency: { supported: true, replay_ttl_seconds: 3600 },
          },
          supported_protocols: ['governance'],
        })
      );
      return;
    }
    if (name === 'create_property_list' && owner) {
      const control = args.name === 'Control';
      send(
        tool({
          list: { list_id: control ? 'control-list' : list.list_id, name: args.name },
          auth_token: control ? 'control-reference-secret' : TOKEN,
        })
      );
      return;
    }
    if (name === 'get_property_list' && args.list_id === list.list_id) {
      pageCalls++;
      if (mode === 'read-denied') {
        res.writeHead(403).end();
        return;
      }
      let payload = args.pagination.cursor
        ? { list, identifiers: identifiers.slice(2), pagination: { has_more: false } }
        : { list, identifiers: identifiers.slice(0, 2), pagination: { has_more: true, cursor: 'next-page' } };
      if (mode === 'wrong-list') payload.list = { ...list, list_id: 'another-list' };
      if (mode === 'no-pagination') delete payload.pagination;
      if (mode === 'early-terminal') payload.pagination = { has_more: false };
      if (mode === 'repeated-cursor') payload.pagination = { has_more: true, cursor: 'next-page' };
      if (mode === 'missing-cursor') payload.pagination = { has_more: true };
      if (mode === 'terminal-cursor' && args.pagination.cursor) payload.pagination.cursor = 'stale';
      if (mode === 'duplicate' && args.pagination.cursor) payload.identifiers = [identifiers[0]];
      if (mode === 'oversized') payload.identifiers = identifiers;
      if (mode === 'extra' && args.pagination.cursor)
        payload.identifiers = [{ type: 'domain', value: 'extra.publisher.example' }];
      if (mode === 'malformed') payload.list = { list_id: list.list_id };
      if (mode === 'limit') payload.pagination = { has_more: true, cursor: `page-${pageCalls}` };
      send(tool(payload));
      return;
    }
    const mutation = name === 'update_property_list';
    if (mode === 'delayed-get') {
      if (pendingStream) {
        pendingStream.writeHead(200, { 'content-type': 'text/event-stream' });
        pendingStream.write(': keepalive\n\n');
        pendingStream = undefined;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
      res.writeHead(403).end();
      return;
    }
    if (mode === 'abort-denial') {
      activeAbort.abort();
      return;
    }
    if ((mode === 'cross-list-success' && !mutation) || (mode === 'mutation-success' && mutation)) {
      send(tool({ list: { ...list, list_id: args.list_id } }));
      return;
    }
    if (mode === 'http-leak') {
      res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ list }));
      return;
    }
    if (mode === 'http-array-leak') {
      res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify([{ list }]));
      return;
    }
    if (mode === 'http-nested-leak') {
      res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ data: { list } }));
      return;
    }
    if (mode === 'http-unrelated-error') {
      res
        .writeHead(403, { 'content-type': 'application/json' })
        .end(JSON.stringify({ status: 'failed', errors: [{ code: 'INVALID_REQUEST', message: 'Bad request' }] }));
      return;
    }
    if (mode === 'rpc-method-error') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          error: {
            code: -32601,
            message: 'Method not found',
            data: { code: 'PERMISSION_DENIED', message: 'Denied' },
          },
        })
      );
      return;
    }
    if (mode === 'sse-leak') {
      res
        .writeHead(403, { 'content-type': 'text/event-stream' })
        .end(`data: ${JSON.stringify({ list, identifiers })}\n\n`);
      return;
    }
    if (mode === 'http-denial') {
      res.writeHead(mutation ? 403 : 401).end();
      return;
    }
    let code =
      mode === 'scope-denial'
        ? 'SCOPE_INSUFFICIENT'
        : mode === 'read-only-denial'
          ? 'READ_ONLY_SCOPE'
          : mode === 'invalid-request'
            ? 'INVALID_REQUEST'
            : mode === 'account-required'
              ? 'ACCOUNT_REQUIRED'
              : mode === 'unsupported'
                ? 'UNSUPPORTED_TASK'
                : mode === 'not-found' || (mode === 'cross-not-found' && !mutation)
                  ? 'REFERENCE_NOT_FOUND'
                  : 'PERMISSION_DENIED';
    const payload = { errors: [{ code, message: `Denied ${TOKEN}` }] };
    if (mode === 'malformed-denial') payload.errors = [{ code }];
    if (mode === 'malformed-envelope') payload.context = 99;
    if (mode === 'conflicting-errors') payload.adcp_error = { code: 'INVALID_REQUEST', message: 'Bad request' };
    if (mode === 'actual-metadata-secret') {
      payload.status = 'completed';
      payload.list = list;
      payload.task = TOKEN;
    }
    if (mode === 'success-and-error') payload.list = list;
    send(tool(payload, true));

    function tool(payload, isError = false) {
      payload = { status: isError ? 'failed' : 'completed', ...payload };
      if (mode === 'text-hidden-success' && isError)
        return {
          structuredContent: payload,
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ status: 'completed', list }) }],
        };
      if (mode === 'text-conflicting-error' && isError)
        return {
          structuredContent: payload,
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({ status: 'failed', errors: [{ code: 'INVALID_REQUEST', message: 'Bad request' }] }),
            },
          ],
        };
      return mode === 'text-fallback'
        ? { content: [{ type: 'text', text: JSON.stringify(payload) }], ...(isError && { isError }) }
        : {
            structuredContent: payload,
            content: [{ type: 'text', text: JSON.stringify(payload) }],
            ...(isError && { isError }),
          };
    }
    function send(result) {
      if (mode === 'post-stream') {
        openStreams.add(res);
        res.on('close', () => openStreams.delete(res));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result })}\n\n`);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}/mcp`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

function reset(nextMode = 'success') {
  mode = nextMode;
  received = [];
  initializes = 0;
  sessions = new Set();
  pageCalls = 0;
  openStreams = new Set();
  pendingStream = undefined;
}
function probe(overrides = {}, options = {}) {
  return verifyPropertyListReference(
    { ...validation, ...overrides },
    { list, auth_token: TOKEN },
    { agentUrl: url, allowHttp: true, ...options }
  );
}

test('uses a fresh token-only official MCP session for every page and both valid denial probes', async () => {
  reset();
  const result = await probe();
  assert.equal(result.passed, true, JSON.stringify(result));
  assert.equal(initializes, 1);
  const calls = received.filter(row => row.rpc?.method === 'tools/call');
  assert.deepEqual(
    calls.map(row => row.rpc.params.name),
    ['get_property_list', 'get_property_list', 'get_property_list', 'update_property_list']
  );
  assert.equal(calls[1].rpc.params.arguments.pagination.cursor, 'next-page');
  for (const row of received) {
    assert.equal(row.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(row.headers.cookie, undefined);
    assert.equal(row.headers['x-api-key'], undefined);
    assert.equal(row.headers['x-adcp-auth'], undefined);
    assert.equal(row.url, '/mcp');
    if (row.rpc?.params?.arguments) assert.equal(row.rpc.params.arguments.account, undefined);
  }
  const mutation = calls.at(-1).rpc.params.arguments;
  assert.notEqual(mutation.name, list.name);
  assert.match(mutation.idempotency_key, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(result.observations[0].request.operation, 'initialize');
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.ok(
    received.some(row => row.method === 'DELETE'),
    'terminates the isolated session'
  );
});

for (const successMode of [
  'text-fallback',
  'http-denial',
  'cross-not-found',
  'scope-denial',
  'read-only-denial',
  'post-stream',
  'delayed-get',
]) {
  test(`accepts ${successMode} through the official transport`, async () => {
    reset(successMode);
    const result = await probe();
    assert.equal(result.passed, true, JSON.stringify(result));
    assert.equal(JSON.stringify(result).includes(TOKEN), false);
  });
}
for (const failureMode of [
  'init-denied',
  'read-denied',
  'wrong-list',
  'no-pagination',
  'early-terminal',
  'repeated-cursor',
  'missing-cursor',
  'terminal-cursor',
  'duplicate',
  'oversized',
  'extra',
  'malformed',
  'cross-list-success',
  'mutation-success',
  'invalid-request',
  'account-required',
  'unsupported',
  'not-found',
  'malformed-denial',
  'success-and-error',
  'redirect',
  'http-leak',
  'malformed-envelope',
  'sse-leak',
  'http-nested-leak',
  'http-array-leak',
  'http-unrelated-error',
  'rpc-method-error',
  'conflicting-errors',
  'text-hidden-success',
  'text-conflicting-error',
  'actual-metadata-secret',
]) {
  test(`fails closed on ${failureMode}`, async () => {
    reset(failureMode);
    const result = await probe();
    assert.equal(result.passed, false, JSON.stringify(result));
    assert.equal(JSON.stringify(result).includes(TOKEN), false);
    assert.equal(
      received.some(row => row.url === '/must-not-follow'),
      false
    );
    assert.equal(
      received.some(row => row.headers.authorization === `Bearer ${OWNER}`),
      false
    );
  });
}

test('enforces page count and validates author configuration before initialization', async () => {
  reset('limit');
  const limited = await probe({ max_pages: 1 });
  assert.equal(limited.passed, false);
  assert.match(limited.error, /max_pages/);
  for (const overrides of [
    { page_size: 0 },
    { max_pages: 101 },
    { denied_list_id: list.list_id },
    { expected_identifiers: [...identifiers, identifiers[0]] },
    { agent_url: `${url}?api_key=owner` },
  ]) {
    reset();
    const result = await probe(overrides);
    assert.equal(result.passed, false);
    assert.equal(received.length, 0);
  }
});

test('cancellation cannot become authorization-denial evidence', async () => {
  reset();
  const controller = new AbortController();
  controller.abort();
  const result = await probe({}, { signal: controller.signal });
  assert.equal(result.passed, false);
});

function storyboard() {
  const account = { brand: { domain: 'acmeoutdoor.example' }, operator: 'pinnacle-agency.example', sandbox: true };
  return {
    id: 'property_list_reference_resolution',
    version: '1.0.0',
    title: 'Reference resolution',
    category: 'schema_validation',
    summary: '',
    narrative: '',
    requires: ['property_list_reference_runner'],
    agent: { interaction_model: 'governance_agent', capabilities: [] },
    caller: { role: 'buyer_agent' },
    phases: [
      {
        id: 'reference',
        title: 'Reference',
        steps: [
          {
            id: 'control',
            title: 'Control',
            task: 'create_property_list',
            sample_request: { account, name: 'Control', idempotency_key: 'control-idempotency-key' },
            context_outputs: [{ key: 'control_id', path: 'list.list_id' }],
          },
          {
            id: 'shared',
            title: 'Shared',
            task: 'create_property_list',
            sample_request: { account, name: list.name, idempotency_key: 'shared-idempotency-key' },
            validations: [{ ...validation, denied_list_id: '$context.control_id' }],
          },
        ],
      },
    ],
  };
}

test('the full runner executes credential isolation after owner creates and redacts every output path', async () => {
  reset();
  const tools = ['create_property_list', 'get_property_list', 'update_property_list'];
  const result = await runStoryboard(url, storyboard(), {
    protocol: 'mcp',
    allow_http: true,
    auth: { type: 'bearer', token: OWNER },
    headers: { 'x-api-key': 'owner-key', cookie: 'owner-cookie' },
    transport: {
      trustedFetchFn: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set('x-owner-transport-identity', OWNER);
        return fetch(input, { ...init, headers });
      },
    },
    _profile: { name: 'List issuer', tools, raw_capabilities: {} },
    agentTools: tools,
  });
  assert.equal(result.overall_passed, true, JSON.stringify(result));
  const shared = result.phases.flatMap(phase => phase.steps).find(step => step.step_id === 'shared');
  assert.ok(
    shared.validations.some(
      check => check.check === 'property_list_reference' && check.passed && !check.not_applicable
    ),
    JSON.stringify(result)
  );
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.equal(JSON.stringify(result).includes('control-reference-secret'), false);
  const recipientInitializes = received.filter(
    row => row.rpc?.method === 'initialize' && row.headers.authorization === `Bearer ${TOKEN}`
  );
  assert.equal(recipientInitializes.length, 1);
  const ownerSessions = received
    .filter(row => row.rpc?.method === 'initialize' && row.headers.authorization === `Bearer ${OWNER}`)
    .map(row => row.issuedSessionId);
  assert.ok(ownerSessions.length > 0);
  assert.ok(!ownerSessions.includes(recipientInitializes[0].issuedSessionId), 'recipient opens a fresh session');
  const tokenOnly = received.filter(row => row.headers.authorization === `Bearer ${TOKEN}`);
  assert.ok(tokenOnly.length >= 5);
  for (const row of tokenOnly) {
    if (row.rpc?.method !== 'initialize')
      assert.equal(row.headers['mcp-session-id'], recipientInitializes[0].issuedSessionId);
    assert.equal(row.headers.cookie, undefined);
    assert.equal(row.headers['x-api-key'], undefined);
    assert.equal(row.headers.signature, undefined);
    assert.equal(row.headers['x-owner-transport-identity'], undefined);
    assert.equal(row.rpc?.params?.arguments?.account, undefined);
  }
});

test('uses the endpoint discovered by the owner when the registered URL is a host root', async () => {
  reset();
  const tools = ['create_property_list', 'get_property_list', 'update_property_list'];
  const result = await runStoryboard(new URL(url).origin, storyboard(), {
    protocol: 'mcp',
    allow_http: true,
    auth: { type: 'bearer', token: OWNER },
    _profile: { name: 'List issuer', tools, raw_capabilities: {} },
    agentTools: tools,
  });
  assert.equal(result.overall_passed, true, JSON.stringify(result));
  const tokenRequests = received.filter(row => row.headers.authorization === `Bearer ${TOKEN}`);
  assert.ok(tokenRequests.length > 0);
  assert.ok(tokenRequests.every(row => row.url === '/mcp'));
});

test('closes a live MCP GET SSE stream when the probe finishes', async () => {
  reset('open-stream');
  const result = await probe();
  assert.equal(result.passed, true, JSON.stringify(result));
  for (let attempt = 0; attempt < 50 && openStreams.size; attempt++)
    await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(openStreams.size, 0, 'probe teardown aborts its streaming connections');
});

test('an abort during a denial cannot establish authorization isolation', async () => {
  reset('abort-denial');
  activeAbort = new AbortController();
  const result = await probe({}, { signal: activeAbort.signal });
  assert.equal(result.passed, false);
  assert.equal(
    received.some(row => row.rpc?.params?.name === 'update_property_list'),
    false
  );
});

test('A2A reports the unavailable runner before discovery, fixture setup, or owner calls', async () => {
  reset();
  const sb = storyboard();
  sb.requires.push('controller');
  const result = await runStoryboard(url, sb, { protocol: 'a2a', allow_http: true });
  assert.equal(result.passed_count, 0);
  assert.equal(result.phases[0].steps[0].skip.requirement, 'property_list_reference_runner');
  assert.equal(received.length, 0);
});

test('durable task redaction retains auth_token; only runner reports remove it', () => {
  assert.deepEqual(redactSecrets({ list: { auth_token: TOKEN }, 'Auth-Token': TOKEN }), {
    list: { auth_token: TOKEN },
    'Auth-Token': TOKEN,
  });
});

test('rejects unresolved control IDs and foreign managing endpoints before initialization', async () => {
  for (const overrides of [
    { denied_list_id: '$context.missing' },
    { denied_list_id: '{{missing}}' },
    { agent_url: 'https://another-issuer.example/mcp' },
  ]) {
    reset();
    const result = await probe(overrides);
    assert.equal(result.passed, false);
    assert.equal(received.length, 0);
  }
});

test('single-step A2A execution also reports requirement_unmet without contacting the issuer', async () => {
  reset();
  const result = await runStoryboardStep(url, storyboard(), 'shared', { protocol: 'a2a', allow_http: true });
  assert.equal(result.skip.requirement, 'property_list_reference_runner');
  assert.equal(received.length, 0);
});

test('short or colliding credentials cannot rewrite report metadata or rollup keys', async () => {
  for (const token of ['list', 'mcp', 'failed', 'property_list_reference']) {
    const report = await withPropertyListCredentialRedaction(async () => {
      rememberPropertyListCredentials({ auth_token: token });
      return {
        check: 'property_list_reference',
        step_id: token,
        failed_count: 1,
        request: { transport: 'mcp', operation: 'get_property_list', payload: { auth_token: token } },
        error: `Issuer echoed Bearer ${token}`,
      };
    });
    assert.equal(report.check, 'property_list_reference');
    assert.equal(report.step_id, token);
    assert.equal(report.failed_count, 1);
    assert.equal(report.request.transport, 'mcp');
    assert.equal(report.request.payload.auth_token, '[redacted]');
    assert.ok(report.error.endsWith('Bearer [redacted]'));
  }
});

test('shared client scopes do not discover an explicitly unavailable A2A runner', async () => {
  reset();
  let discovered = 0;
  const result = await withTestClientScope(() =>
    runStoryboard(url, storyboard(), {
      protocol: 'a2a',
      _client: {
        getAgentInfo: async () => {
          discovered++;
          throw new Error('Must not discover');
        },
      },
    })
  );
  assert.equal(discovered, 0);
  assert.equal(result.phases[0].steps[0].skip.requirement, 'property_list_reference_runner');
  assert.equal(received.length, 0);
});

test('a one-page fixture may omit optional pagination metadata', async () => {
  reset('no-pagination');
  const result = await probe({ expected_identifiers: identifiers.slice(0, 2) });
  assert.equal(result.passed, true, JSON.stringify(result));
});

test('redacts JSON-escaped tokens and thrown diagnostic errors', async () => {
  const token = 'quoted-credential-"-\\-unicode-π';
  const report = await withPropertyListCredentialRedaction(async () => {
    rememberPropertyListCredentials({ auth_token: token });
    return {
      response: { payload: { auth_token: token } },
      wire_responses: [{ body: JSON.stringify({ echo: token }) }],
    };
  });
  assert.equal(report.response.payload.auth_token, '[redacted]');
  assert.equal(report.wire_responses[0].body.includes(JSON.stringify(token).slice(1, -1)), false);
  await assert.rejects(
    () =>
      withPropertyListCredentialRedaction(async () => {
        rememberPropertyListCredentials({ auth_token: token });
        throw new Error(`Reflected ${token}`);
      }),
    error => !error.message.includes(token) && !error.stack.includes(token)
  );
});

test('the synchronous validator cannot claim coverage for a probe it did not execute', () => {
  const result = runValidations([validation], {
    taskName: 'create_property_list',
    taskResult: { success: true, data: { list, auth_token: TOKEN } },
  });
  assert.equal(result[0].passed, false);
  assert.notEqual(result[0].not_applicable, true);
});
