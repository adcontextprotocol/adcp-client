/**
 * Storyboard runner: idempotency_key invariant.
 *
 * Issue #625 — AdCP v3 requires `idempotency_key` on every mutating request.
 * Storyboard `sample_request` blocks generally omit it, so the SDK (or the
 * server) would reject the request with INVALID_REQUEST before the handler
 * runs, masking real handler behavior. The runner now auto-injects a fresh
 * UUID on mutating steps that don't supply one. Missing-key error scenarios
 * (`expect_error: true`) still flow through without a key so the server's
 * required-field check is exercised.
 */

const { describe, test, it } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const {
  applyIdempotencyInvariant,
  runStoryboard,
  __defaultAuthHeadersForRawProbeForTest: defaultAuthHeadersForRawProbe,
} = require('../../dist/lib/testing/storyboard/runner.js');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('applyIdempotencyInvariant', () => {
  test('injects a UUID v4 on mutating tasks when the request omits one', () => {
    const result = applyIdempotencyInvariant({ name: 'p1' }, 'create_property_list', {});
    assert.match(result.idempotency_key, UUID_V4);
  });

  test('injects on mutating expect_error steps so the server reaches the error path the storyboard named (e.g. GOVERNANCE_DENIED, UNAUTHORIZED)', () => {
    const result = applyIdempotencyInvariant({ campaign: { id: 'c1' } }, 'acquire_rights', { expect_error: true });
    assert.match(result.idempotency_key, UUID_V4);
  });

  test('passes through read-only tasks untouched', () => {
    const input = { filter: 'x' };
    const result = applyIdempotencyInvariant(input, 'get_products', {});
    assert.strictEqual(result, input);
    assert.strictEqual(result.idempotency_key, undefined);
  });

  test('preserves a caller-supplied idempotency_key (BYOK)', () => {
    const result = applyIdempotencyInvariant(
      { idempotency_key: 'byok-1234567890abcdef', name: 'p1' },
      'create_property_list',
      {}
    );
    assert.strictEqual(result.idempotency_key, 'byok-1234567890abcdef');
  });

  test('preserves a concrete UUID pre-resolved by the context injector from $generate:uuid_v4#alias (replay scenarios)', () => {
    const preResolved = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const result = applyIdempotencyInvariant({ idempotency_key: preResolved, name: 'p1' }, 'create_property_list', {});
    assert.strictEqual(result.idempotency_key, preResolved);
  });

  test('treats empty-string idempotency_key as unset and injects a fresh UUID', () => {
    const result = applyIdempotencyInvariant({ idempotency_key: '', name: 'p1' }, 'create_property_list', {});
    assert.match(result.idempotency_key, UUID_V4);
  });

  test('does not inject when step.omit_idempotency_key=true — the scenario explicitly exercises missing-key rejection', () => {
    const result = applyIdempotencyInvariant({ name: 'p1' }, 'create_property_list', {
      omit_idempotency_key: true,
    });
    assert.strictEqual(result.idempotency_key, undefined);
  });

  test('covers tasks not in TASK_TO_METHOD that fall through to executeTask (e.g. acquire_rights)', () => {
    const result = applyIdempotencyInvariant({ campaign: { id: 'c1' } }, 'acquire_rights', {});
    assert.match(result.idempotency_key, UUID_V4);
  });

  test('does not mutate the input request', () => {
    const input = { name: 'p1' };
    applyIdempotencyInvariant(input, 'create_property_list', {});
    assert.strictEqual(input.idempotency_key, undefined);
  });
});

// ────────────────────────────────────────────────────────────
// Integration: runner call-site regression
// ────────────────────────────────────────────────────────────

/**
 * Wire-level: a mutating step with a sample_request that omits
 * idempotency_key must still land at the server carrying one. Before the
 * fix, the server's required-field check would short-circuit and the
 * handler under test would never run.
 */
describe('runStoryboard: idempotency_key invariant on the wire', () => {
  it('auto-injects idempotency_key on mutating steps whose sample_request omits it, including untyped tasks (acquire_rights) that fall through to executeTask', async () => {
    const seen = [];
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      seen.push({ name: rpc.params.name, args: rpc.params.arguments });
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="x"' });
      res.end('{}');
    });
    await new Promise(r => server.listen(0, r));
    const agentUrl = `http://127.0.0.1:${server.address().port}/mcp`;
    try {
      const storyboard = {
        id: 'idempotency_invariant_sb',
        version: '1.0.0',
        title: 'Idempotency invariant',
        category: 'compliance',
        summary: '',
        narrative: '',
        agent: { interaction_model: '*', capabilities: [] },
        caller: { role: 'buyer_agent' },
        phases: [
          {
            id: 'p',
            title: 'mutating',
            steps: [
              {
                id: 's1_typed_mutating_sample_omits_key',
                title: 'typed mutating task, sample_request omits idempotency_key',
                task: 'create_property_list',
                auth: 'none',
                sample_request: { name: 'pl-1', entries: [] },
                validations: [{ check: 'http_status_in', allowed_values: [401], description: '' }],
              },
              {
                id: 's2_untyped_acquire_rights',
                title: 'untyped mutating task falls through to executeTask',
                task: 'acquire_rights',
                auth: 'none',
                sample_request: { campaign: { id: 'c1' } },
                validations: [{ check: 'http_status_in', allowed_values: [401], description: '' }],
              },
              {
                id: 's3_read_only_untouched',
                title: 'read-only task must not receive idempotency_key',
                task: 'get_products',
                auth: 'none',
                sample_request: { brief: 'test' },
                validations: [{ check: 'http_status_in', allowed_values: [401], description: '' }],
              },
            ],
          },
        ],
      };
      await runStoryboard(agentUrl, storyboard, {
        protocol: 'mcp',
        allow_http: true,
        agentTools: ['create_property_list', 'acquire_rights', 'get_products'],
        _profile: {
          name: 'Test',
          tools: ['create_property_list', 'acquire_rights', 'get_products'],
        },
        _client: {
          getAgentInfo: async () => ({
            name: 'Test',
            tools: [{ name: 'create_property_list' }, { name: 'acquire_rights' }, { name: 'get_products' }],
          }),
        },
      });

      assert.strictEqual(seen.length, 3, `expected 3 tool calls, got ${seen.length}`);

      const mutating = seen.filter(c => c.name === 'create_property_list' || c.name === 'acquire_rights');
      for (const call of mutating) {
        assert.match(
          String(call.args.idempotency_key),
          UUID_V4,
          `step ${call.name} missing or malformed idempotency_key`
        );
      }

      const readOnly = seen.find(c => c.name === 'get_products');
      assert.strictEqual(readOnly.args.idempotency_key, undefined, 'read-only task must not receive idempotency_key');
    } finally {
      server.close();
    }
  });

  it('injects on expect_error mutating steps so storyboards testing GOVERNANCE_DENIED / UNAUTHORIZED / brand_mismatch reach the error path they named', async () => {
    const seen = [];
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      seen.push({ name: rpc.params.name, args: rpc.params.arguments });
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          error: { code: -32000, message: 'GOVERNANCE_DENIED' },
        })
      );
    });
    await new Promise(r => server.listen(0, r));
    const agentUrl = `http://127.0.0.1:${server.address().port}/mcp`;
    try {
      const storyboard = {
        id: 'expect_governance_denied_sb',
        version: '1.0.0',
        title: 'Governance denied',
        category: 'compliance',
        summary: '',
        narrative: '',
        agent: { interaction_model: '*', capabilities: [] },
        caller: { role: 'buyer_agent' },
        phases: [
          {
            id: 'p',
            title: 'governance',
            steps: [
              {
                id: 's1_expect_governance_denied',
                title: 'mutating step expects GOVERNANCE_DENIED, must still carry idempotency_key',
                task: 'acquire_rights',
                auth: 'none',
                expect_error: true,
                sample_request: { campaign: { id: 'c1' } },
                validations: [],
              },
            ],
          },
        ],
      };
      await runStoryboard(agentUrl, storyboard, {
        protocol: 'mcp',
        allow_http: true,
        agentTools: ['acquire_rights'],
        _profile: { name: 'Test', tools: ['acquire_rights'] },
        _client: {
          getAgentInfo: async () => ({ name: 'Test', tools: [{ name: 'acquire_rights' }] }),
        },
      });

      assert.strictEqual(seen.length, 1, `expected 1 tool call, got ${seen.length}`);
      assert.match(
        String(seen[0].args.idempotency_key),
        UUID_V4,
        'expect_error step on mutating task must still receive auto-injected idempotency_key'
      );
    } finally {
      server.close();
    }
  });

  it('leaves idempotency_key absent when step.omit_idempotency_key=true so the server sees a missing-key request', async () => {
    const seen = [];
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      seen.push({ name: rpc.params.name, args: rpc.params.arguments });
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          error: { code: -32000, message: 'INVALID_REQUEST: idempotency_key is required' },
        })
      );
    });
    await new Promise(r => server.listen(0, r));
    const agentUrl = `http://127.0.0.1:${server.address().port}/mcp`;
    try {
      const storyboard = {
        id: 'missing_key_sb',
        version: '1.0.0',
        title: 'Missing key',
        category: 'compliance',
        summary: '',
        narrative: '',
        agent: { interaction_model: '*', capabilities: [] },
        caller: { role: 'buyer_agent' },
        phases: [
          {
            id: 'p',
            title: 'error',
            steps: [
              {
                id: 's1_expect_missing_key_error',
                title: 'compliance step: missing-key must be rejected',
                task: 'create_property_list',
                auth: 'none',
                expect_error: true,
                omit_idempotency_key: true,
                sample_request: { name: 'pl-1', entries: [] },
                validations: [],
              },
            ],
          },
        ],
      };
      await runStoryboard(agentUrl, storyboard, {
        protocol: 'mcp',
        allow_http: true,
        agentTools: ['create_property_list'],
        _profile: { name: 'Test', tools: ['create_property_list'] },
        _client: {
          getAgentInfo: async () => ({ name: 'Test', tools: [{ name: 'create_property_list' }] }),
        },
      });

      assert.strictEqual(seen.length, 1, `expected 1 tool call, got ${seen.length}`);
      assert.strictEqual(
        seen[0].args.idempotency_key,
        undefined,
        'omit_idempotency_key step must not receive auto-injected idempotency_key'
      );
    } finally {
      server.close();
    }
  });

  // Defense-in-depth (issue #678): an agent that authenticates with a bearer
  // token (no per-step auth override) MUST still see a missing-key request
  // when the storyboard declares omit_idempotency_key: true. Before this fix,
  // the SDK's request normalizer/adapter had three injection sites — any one
  // failing to honor skipIdempotencyAutoInject would silently populate a key
  // and the compliance vector would pass vacuously. The runner now routes
  // the call via the raw MCP probe so no SDK layer can touch the body.
  it('bypasses the SDK via raw probe when omit_idempotency_key=true on a bearer-authenticated mutating step (defense-in-depth for SDK injection)', async () => {
    const seen = [];
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      seen.push({
        name: rpc.params.name,
        args: rpc.params.arguments,
        authorization: req.headers['authorization'],
        sessionId: req.headers['x-test-session-id'],
      });
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          error: { code: -32000, message: 'INVALID_REQUEST: idempotency_key is required' },
        })
      );
    });
    await new Promise(r => server.listen(0, r));
    const agentUrl = `http://127.0.0.1:${server.address().port}/mcp`;
    try {
      const storyboard = {
        id: 'missing_key_bearer_sb',
        version: '1.0.0',
        title: 'Missing key (bearer auth, no step auth override)',
        category: 'compliance',
        summary: '',
        narrative: '',
        agent: { interaction_model: '*', capabilities: [] },
        caller: { role: 'buyer_agent' },
        phases: [
          {
            id: 'p',
            title: 'error',
            steps: [
              {
                id: 's1_bearer_missing_key',
                title: 'bearer-authenticated missing-key vector must reach the server without a key',
                task: 'create_property_list',
                expect_error: true,
                omit_idempotency_key: true,
                sample_request: { name: 'pl-bearer', entries: [] },
                validations: [],
              },
            ],
          },
        ],
      };
      await runStoryboard(agentUrl, storyboard, {
        protocol: 'mcp',
        allow_http: true,
        auth: { type: 'bearer', token: 'tok-678' },
        test_session_id: 'sess-678',
        agentTools: ['create_property_list'],
        _profile: { name: 'Test', tools: ['create_property_list'] },
        _client: {
          getAgentInfo: async () => ({ name: 'Test', tools: [{ name: 'create_property_list' }] }),
        },
      });

      assert.strictEqual(seen.length, 1, `expected 1 tool call, got ${seen.length}`);
      assert.strictEqual(
        seen[0].args.idempotency_key,
        undefined,
        'SDK-layer normalization must not inject idempotency_key when omit_idempotency_key=true'
      );
      assert.strictEqual(
        seen[0].authorization,
        'Bearer tok-678',
        'raw probe must forward the bearer token so the agent can still authenticate'
      );
      assert.strictEqual(seen[0].sessionId, 'sess-678', 'raw probe must forward X-Test-Session-ID for test isolation');
    } finally {
      server.close();
    }
  });
});

// ────────────────────────────────────────────────────────────
// Unit: defaultAuthHeadersForRawProbe
// ────────────────────────────────────────────────────────────

/**
 * The helper the dispatcher consults to decide whether the defense-in-depth
 * raw-probe path is available (non-undefined return) and what headers to send
 * when it is. Direct unit coverage keeps the gates explicit without requiring
 * a full MCP handshake to run through the SDK.
 */
describe('defaultAuthHeadersForRawProbe', () => {
  test('no auth → empty headers (public agent; raw dispatch still valid)', () => {
    const h = defaultAuthHeadersForRawProbe({});
    assert.deepStrictEqual(h, {});
  });

  test('bearer → authorization header with SDK casing for session + user-agent', () => {
    const h = defaultAuthHeadersForRawProbe({
      auth: { type: 'bearer', token: 'abc' },
      test_session_id: 'sess-1',
      userAgent: 'compliance-harness/1.0',
    });
    assert.deepStrictEqual(h, {
      authorization: 'Bearer abc',
      'X-Test-Session-ID': 'sess-1',
      'User-Agent': 'compliance-harness/1.0',
    });
  });

  test('basic → base64(user:pass)', () => {
    const u = 'test-user';
    const p = 'test-fixture-not-a-real-secret';
    const h = defaultAuthHeadersForRawProbe({ auth: { type: 'basic', username: u, password: p } });
    assert.deepStrictEqual(h, { authorization: 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64') });
  });

  test('oauth → undefined (SDK fallback; refresh semantics unreplicable)', () => {
    const h = defaultAuthHeadersForRawProbe({
      auth: { type: 'oauth', tokens: { access_token: 'x', refresh_token: 'y', token_type: 'Bearer' } },
    });
    assert.strictEqual(h, undefined);
  });

  test('bearer with empty token throws (fail loud, not silent SDK fallback)', () => {
    assert.throws(
      () => defaultAuthHeadersForRawProbe({ auth: { type: 'bearer', token: '' } }),
      /options\.auth\.token is required/
    );
  });

  test('basic with colon in username throws (RFC 7617)', () => {
    assert.throws(
      () =>
        defaultAuthHeadersForRawProbe({
          auth: { type: 'basic', username: 'has:colon', password: 'test-fixture' },
        }),
      /must not contain colon/
    );
  });

  test('header values with CR/LF throw and name the offending field without echoing the value', () => {
    let captured;
    assert.throws(
      () => defaultAuthHeadersForRawProbe({ auth: { type: 'bearer', token: 'abc\r\nx-injected: yes' } }),
      err => {
        captured = err;
        return /options\.auth\.token contains invalid characters/.test(err.message);
      }
    );
    assert.ok(captured, 'expected an error to be thrown');
    assert.ok(!/x-injected/.test(captured.message), 'error must not echo the offending value');
  });

  test('non-printable ASCII in session id throws with field name', () => {
    assert.throws(
      () => defaultAuthHeadersForRawProbe({ test_session_id: 'sess\x01' }),
      /options\.test_session_id contains invalid characters/
    );
  });
});

// ────────────────────────────────────────────────────────────
// Dispatch gate: a2a stays on SDK path
// ────────────────────────────────────────────────────────────

/**
 * A2A agents use a different envelope than MCP JSON-RPC, so the raw MCP
 * probe can't substitute. Confirm the dispatcher doesn't route A2A steps
 * through it even when `omit_idempotency_key: true` would otherwise trigger.
 * A fetch against the toy server reaching *any* endpoint other than the A2A
 * URL would indicate leakage; we assert by observing the SDK's failure shape
 * (no raw probe body ever lands).
 */
describe('runStoryboard dispatch: A2A + omit_idempotency_key stays on SDK path', () => {
  it('does not invoke the raw MCP probe for A2A steps', async () => {
    const mcpJsonRpcCallsSeen = [];
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const text = Buffer.concat(chunks).toString('utf8');
      // The raw MCP probe sends exactly a JSON-RPC tools/call body. Anything
      // matching that shape on an A2A-configured run would be the bug.
      try {
        const parsed = JSON.parse(text);
        if (parsed?.method === 'tools/call') mcpJsonRpcCallsSeen.push(parsed);
      } catch {
        // Non-JSON — definitely not the raw MCP probe.
      }
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise(r => server.listen(0, r));
    const agentUrl = `http://127.0.0.1:${server.address().port}/`;
    try {
      const storyboard = {
        id: 'a2a_dispatch_sb',
        version: '1.0.0',
        title: 'A2A dispatch gate',
        category: 'compliance',
        summary: '',
        narrative: '',
        agent: { interaction_model: '*', capabilities: [] },
        caller: { role: 'buyer_agent' },
        phases: [
          {
            id: 'p',
            title: 'a2a',
            steps: [
              {
                id: 's1_a2a_missing_key',
                title: 'a2a + omit_idempotency_key must not hit the raw MCP probe',
                task: 'create_property_list',
                expect_error: true,
                omit_idempotency_key: true,
                sample_request: { name: 'pl-a2a', entries: [] },
                validations: [],
              },
            ],
          },
        ],
      };
      // Feed a pre-discovered A2A profile + a fake client so the runner
      // proceeds to dispatch without discovery.
      await runStoryboard(agentUrl, storyboard, {
        protocol: 'a2a',
        allow_http: true,
        auth: { type: 'bearer', token: 'tok-a2a' },
        agentTools: ['create_property_list'],
        _profile: { name: 'Test', tools: ['create_property_list'] },
        _client: {
          getAgentInfo: async () => ({ name: 'Test', tools: [{ name: 'create_property_list' }] }),
        },
      });

      assert.strictEqual(
        mcpJsonRpcCallsSeen.length,
        0,
        `A2A run must not emit MCP JSON-RPC tools/call; saw ${mcpJsonRpcCallsSeen.length}`
      );
    } finally {
      server.close();
    }
  });
});
