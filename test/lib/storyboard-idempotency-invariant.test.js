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

const { applyIdempotencyInvariant, runStoryboard } = require('../../dist/lib/testing/storyboard/runner.js');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('applyIdempotencyInvariant', () => {
  test('injects a UUID v4 on mutating tasks when the request omits one', () => {
    const result = applyIdempotencyInvariant({ name: 'p1' }, 'create_property_list', { expect_error: false });
    assert.match(result.idempotency_key, UUID_V4);
  });

  test('passes through read-only tasks untouched', () => {
    const input = { filter: 'x' };
    const result = applyIdempotencyInvariant(input, 'get_products', { expect_error: false });
    assert.strictEqual(result, input);
    assert.strictEqual(result.idempotency_key, undefined);
  });

  test('preserves a caller-supplied idempotency_key', () => {
    const result = applyIdempotencyInvariant(
      { idempotency_key: 'byok-1234567890abcdef', name: 'p1' },
      'create_property_list',
      { expect_error: false }
    );
    assert.strictEqual(result.idempotency_key, 'byok-1234567890abcdef');
  });

  test('does not inject when the step expects an error — the scenario may test missing-key rejection', () => {
    const result = applyIdempotencyInvariant({ name: 'p1' }, 'create_property_list', { expect_error: true });
    assert.strictEqual(result.idempotency_key, undefined);
  });

  test('covers tasks not in TASK_TO_METHOD that fall through to executeTask (e.g. acquire_rights)', () => {
    const result = applyIdempotencyInvariant({ campaign: { id: 'c1' } }, 'acquire_rights', { expect_error: false });
    assert.match(result.idempotency_key, UUID_V4);
  });

  test('does not mutate the input request', () => {
    const input = { name: 'p1' };
    applyIdempotencyInvariant(input, 'create_property_list', { expect_error: false });
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

  it('leaves idempotency_key absent when the step expects an error (missing-key rejection scenarios)', async () => {
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
        'expect_error step must not receive auto-injected idempotency_key'
      );
    } finally {
      server.close();
    }
  });
});
