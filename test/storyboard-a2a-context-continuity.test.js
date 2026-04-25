const { describe, it } = require('node:test');
const assert = require('node:assert');

const { runValidations } = require('../dist/lib/testing/storyboard/validations.js');

const VALIDATION = {
  check: 'a2a_context_continuity',
  description: 'Seller echoes buyer-supplied contextId on follow-up A2A send',
};

const PRIOR_CTX_ID = 'ctx-prior-step-uuid';

function ctx({ envelope, outboundA2aContextId } = {}) {
  return {
    taskName: 'create_media_buy',
    agentUrl: 'https://example.com/a2a',
    contributions: new Set(),
    ...(envelope !== undefined && { a2aEnvelope: envelope }),
    ...(outboundA2aContextId !== undefined && { outboundA2aContextId }),
  };
}

function makeEnvelope({ contextId = PRIOR_CTX_ID } = {}) {
  return {
    result: {
      kind: 'task',
      id: 'a2a-task-uuid',
      contextId,
      status: { state: 'completed', timestamp: '2026-04-25T00:00:00Z' },
      artifacts: [],
    },
    envelope: { jsonrpc: '2.0', id: 1, result: {} },
    http_status: 200,
  };
}

describe('a2a_context_continuity', () => {
  it('passes when seller echoes the forwarded contextId', () => {
    const [result] = runValidations(
      [VALIDATION],
      ctx({ envelope: makeEnvelope({ contextId: PRIOR_CTX_ID }), outboundA2aContextId: PRIOR_CTX_ID })
    );
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.check, 'a2a_context_continuity');
    assert.ok(!result.error);
  });

  it('passes with not_applicable when no outboundA2aContextId (first A2A step)', () => {
    const [result] = runValidations([VALIDATION], ctx({ envelope: makeEnvelope(), outboundA2aContextId: undefined }));
    assert.strictEqual(result.passed, true);
    assert.ok(Array.isArray(result.observations));
    assert.ok(result.observations[0].includes('no_prior_a2a_context_id'));
  });

  it('passes with not_applicable when outboundA2aContextId is absent (non-A2A transport)', () => {
    // No envelope and no outbound id — non-A2A MCP run
    const [result] = runValidations([VALIDATION], ctx({}));
    assert.strictEqual(result.passed, true);
    assert.ok(Array.isArray(result.observations));
    assert.ok(result.observations[0].includes('no_prior_a2a_context_id'));
  });

  it('passes with not_applicable when envelope absent but outboundA2aContextId set (capture miss)', () => {
    const [result] = runValidations([VALIDATION], ctx({ envelope: undefined, outboundA2aContextId: PRIOR_CTX_ID }));
    assert.strictEqual(result.passed, true);
    assert.ok(Array.isArray(result.observations));
    assert.ok(result.observations[0].includes('a2a_envelope_not_captured'));
  });

  it('fails when response Task.contextId differs from outbound contextId (seller stamped new id)', () => {
    const [result] = runValidations(
      [VALIDATION],
      ctx({
        envelope: makeEnvelope({ contextId: 'ctx-SELLER-STAMPED-WRONG' }),
        outboundA2aContextId: PRIOR_CTX_ID,
      })
    );
    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.check, 'a2a_context_continuity');
    assert.strictEqual(result.json_pointer, '/result/contextId');
    assert.strictEqual(result.expected, PRIOR_CTX_ID);
    assert.strictEqual(result.actual, 'ctx-SELLER-STAMPED-WRONG');
    assert.match(result.error, /does not match the forwarded contextId/);
  });

  it('fails when response Task.contextId is absent (continuity break — seller dropped it)', () => {
    const env = makeEnvelope();
    delete env.result.contextId;
    const [result] = runValidations([VALIDATION], ctx({ envelope: env, outboundA2aContextId: PRIOR_CTX_ID }));
    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.json_pointer, '/result/contextId');
    assert.strictEqual(result.expected, PRIOR_CTX_ID);
    assert.strictEqual(result.actual, null);
    assert.match(result.error, /absent or empty on a follow-up send/);
  });

  it('fails when response Task.contextId is empty string (treated as absent)', () => {
    const [result] = runValidations(
      [VALIDATION],
      ctx({
        envelope: makeEnvelope({ contextId: '' }),
        outboundA2aContextId: PRIOR_CTX_ID,
      })
    );
    assert.strictEqual(result.passed, false);
    assert.match(result.error, /absent or empty on a follow-up send/);
  });

  it('passes with not_applicable when JSON-RPC error envelope (no Task to verify contextId on)', () => {
    const env = {
      result: null,
      envelope: { jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'Invalid Request' } },
      http_status: 200,
    };
    const [result] = runValidations([VALIDATION], ctx({ envelope: env, outboundA2aContextId: PRIOR_CTX_ID }));
    assert.strictEqual(result.passed, true);
    assert.ok(Array.isArray(result.observations));
    assert.ok(result.observations[0].includes('a2a_jsonrpc_error_envelope'));
  });

  it('fails when result is not an object', () => {
    const env = {
      result: 'not-an-object',
      envelope: { jsonrpc: '2.0', id: 1, result: 'not-an-object' },
      http_status: 200,
    };
    const [result] = runValidations([VALIDATION], ctx({ envelope: env, outboundA2aContextId: PRIOR_CTX_ID }));
    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.json_pointer, '/result');
    assert.match(result.error, /not an object/);
  });
});
