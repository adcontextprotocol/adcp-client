// Regression tests for adcp-client#962.
//
// Anchors the contract that `a2a_context_continuity` catches sellers
// that bypass the @a2a-js/sdk DefaultRequestHandler and stamp their
// own contextId on the response. Per A2A 0.3.0 §7.1 the server MUST
// echo the client-supplied contextId on every follow-up send; a
// divergent value indicates the seller broke the SDK's automatic
// contextId echo.
//
// Single-call tests pin the validator's logic against synthetic
// envelopes; the runner-level integration is covered separately by
// stacking step results in `priorA2aEnvelope`.

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { runValidations } = require('../dist/lib/testing/storyboard/validations.js');

const VALIDATION = {
  check: 'a2a_context_continuity',
  description: 'A2A Task.contextId carries through across steps',
};

function envelope(contextId, opts = {}) {
  return {
    result: {
      kind: 'task',
      id: opts.taskId ?? 'task-uuid',
      contextId,
      status: { state: 'completed', timestamp: '2026-04-25T12:00:00Z' },
      artifacts: [],
    },
    envelope: { jsonrpc: '2.0', id: 1, result: {} },
    http_status: 200,
  };
}

function ctx({ current, prior, priorStepId } = {}) {
  return {
    taskName: 'follow_up_step',
    agentUrl: 'https://example.com/a2a',
    contributions: new Set(),
    ...(current && { a2aEnvelope: current }),
    ...(prior && { priorA2aEnvelope: prior }),
    ...(priorStepId && { priorA2aStepId: priorStepId }),
  };
}

describe('a2a_context_continuity', () => {
  it('passes when current and prior contextIds match', () => {
    const SHARED_CTX = 'ctx-shared-123';
    const [result] = runValidations(
      [VALIDATION],
      ctx({ current: envelope(SHARED_CTX), prior: envelope(SHARED_CTX, { taskId: 'prior-task' }) })
    );
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.check, 'a2a_context_continuity');
  });

  it('fails when current contextId diverges from prior — seller stamped their own', () => {
    const [result] = runValidations(
      [VALIDATION],
      ctx({
        current: envelope('ctx-seller-stamped'),
        prior: envelope('ctx-original'),
        priorStepId: 'create_media_buy',
      })
    );
    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.json_pointer, '/result/contextId');
    assert.strictEqual(result.expected, 'ctx-original');
    assert.strictEqual(result.actual, 'ctx-seller-stamped');
    assert.match(result.error, /diverged across steps.*create_media_buy/);
    assert.match(result.error, /A2A 0\.3\.0 §7\.1/);
  });

  it('fails when current Task is missing contextId entirely', () => {
    const cur = envelope('whatever');
    delete cur.result.contextId;
    const [result] = runValidations([VALIDATION], ctx({ current: cur, prior: envelope('ctx-prior') }));
    assert.strictEqual(result.passed, false);
    assert.match(result.error, /missing `contextId`/);
  });

  it('passes with skip-observation on non-A2A transport (no envelope)', () => {
    const [result] = runValidations([VALIDATION], ctx({}));
    assert.strictEqual(result.passed, true);
    assert.ok(result.observations?.[0]?.includes('a2a_envelope_not_captured'));
  });

  it('passes with skip-observation on first A2A step (no prior to compare)', () => {
    const [result] = runValidations([VALIDATION], ctx({ current: envelope('ctx-first') }));
    assert.strictEqual(result.passed, true);
    assert.ok(result.observations?.[0]?.includes('first_a2a_step'));
  });

  it('passes with skip-observation when prior step had no contextId', () => {
    const priorEnv = envelope('discarded');
    delete priorEnv.result.contextId;
    const [result] = runValidations([VALIDATION], ctx({ current: envelope('ctx-current'), prior: priorEnv }));
    assert.strictEqual(result.passed, true);
    assert.ok(result.observations?.[0]?.includes('prior_contextId_absent'));
  });

  it('passes with skip-observation when current envelope is a JSON-RPC error', () => {
    const errEnvelope = {
      result: null,
      envelope: { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid params' } },
      http_status: 200,
    };
    const [result] = runValidations([VALIDATION], ctx({ current: errEnvelope, prior: envelope('ctx-prior') }));
    assert.strictEqual(result.passed, true);
    assert.ok(result.observations?.[0]?.includes('jsonrpc_error_envelope'));
  });

  it('passes with skip-observation when prior envelope is a JSON-RPC error', () => {
    const errEnvelope = {
      result: null,
      envelope: { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid params' } },
      http_status: 200,
    };
    const [result] = runValidations([VALIDATION], ctx({ current: envelope('ctx-current'), prior: errEnvelope }));
    assert.strictEqual(result.passed, true);
    assert.ok(result.observations?.[0]?.includes('jsonrpc_error_envelope'));
  });

  it('treats empty-string contextId as missing', () => {
    const cur = envelope('');
    const [result] = runValidations([VALIDATION], ctx({ current: cur, prior: envelope('ctx-prior') }));
    assert.strictEqual(result.passed, false);
    assert.match(result.error, /missing `contextId`/);
  });

  it('extracts contextId from `result` (the post-redaction envelope shape)', () => {
    // Defensive — confirms the validator reads from envelope.result.contextId,
    // not from envelope.envelope.result.contextId or some other path. The
    // capture pipeline writes both result and envelope.result, but the
    // validator should consult the canonical location.
    const SHARED = 'ctx-from-result';
    const env = {
      result: { kind: 'task', id: 't', contextId: SHARED, status: { state: 'completed' }, artifacts: [] },
      envelope: { jsonrpc: '2.0', id: 1, result: { kind: 'task', id: 't', contextId: SHARED } },
      http_status: 200,
    };
    const [result] = runValidations([VALIDATION], ctx({ current: env, prior: env }));
    assert.strictEqual(result.passed, true);
  });
});
