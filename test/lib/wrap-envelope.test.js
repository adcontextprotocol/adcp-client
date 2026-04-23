/**
 * Tests for the public `wrapEnvelope` helper.
 *
 * Covers success and error envelope construction with the sibling
 * allowlist used for error codes like IDEMPOTENCY_CONFLICT. Parity with
 * `create-adcp-server.ts`'s internal `injectReplayed` + `finalize()` path
 * is asserted via behavioral tests — the implementations stay separate
 * for now, both satisfied by this suite.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  wrapEnvelope,
  ERROR_ENVELOPE_FIELD_ALLOWLIST,
  DEFAULT_ERROR_ENVELOPE_FIELDS,
  CONFLICT_ADCP_ERROR_ALLOWLIST,
} = require('../../dist/lib/server/index.js');

describe('wrapEnvelope: success envelopes', () => {
  it('attaches replayed:true when explicitly set', () => {
    const out = wrapEnvelope({ media_buy_id: 'mb_1' }, { replayed: true });
    assert.deepEqual(out, { media_buy_id: 'mb_1', replayed: true });
  });

  it('attaches replayed:false when explicitly set (storyboard-required)', () => {
    // replayed:false is a meaningful value — fresh-path mutations MUST
    // emit it so conformance storyboards can assert the absence of a
    // replay. The helper must not collapse false to absent.
    const out = wrapEnvelope({ media_buy_id: 'mb_1' }, { replayed: false });
    assert.deepEqual(out, { media_buy_id: 'mb_1', replayed: false });
    assert.ok('replayed' in out, 'replayed key must be present');
    assert.equal(out.replayed, false);
  });

  it('omits replayed when not passed in opts', () => {
    const out = wrapEnvelope({ media_buy_id: 'mb_1' }, {});
    assert.deepEqual(out, { media_buy_id: 'mb_1' });
    assert.ok(!('replayed' in out));
  });

  it('echoes context on success', () => {
    const ctx = { correlation_id: 'corr_1' };
    const out = wrapEnvelope({ media_buy_id: 'mb_1' }, { context: ctx });
    assert.equal(out.media_buy_id, 'mb_1');
    assert.deepEqual(out.context, ctx);
  });

  it('emits operation_id in snake_case', () => {
    const out = wrapEnvelope({ media_buy_id: 'mb_1' }, { operationId: 'op_xyz' });
    assert.equal(out.operation_id, 'op_xyz');
    assert.ok(!('operationId' in out), 'camelCase key must not leak through');
  });

  it('attaches all envelope fields together', () => {
    const out = wrapEnvelope(
      { media_buy_id: 'mb_1', status: 'active' },
      {
        replayed: false,
        context: { correlation_id: 'corr_1' },
        operationId: 'op_xyz',
      }
    );
    assert.deepEqual(out, {
      media_buy_id: 'mb_1',
      status: 'active',
      replayed: false,
      context: { correlation_id: 'corr_1' },
      operation_id: 'op_xyz',
    });
  });

  it('ignores non-object context (string / null / array)', () => {
    // Matches `injectContextIntoResponse` — SI tools override request
    // context to a string, and echoing a string would break response
    // schema validation.
    const strOut = wrapEnvelope({ k: 'v' }, { context: 'not-an-object' });
    assert.ok(!('context' in strOut));

    const nullOut = wrapEnvelope({ k: 'v' }, { context: null });
    assert.ok(!('context' in nullOut));

    const arrOut = wrapEnvelope({ k: 'v' }, { context: ['a', 'b'] });
    assert.ok(!('context' in arrOut));
  });

  it('preserves handler-provided context (parity with injectContextIntoResponse)', () => {
    // Mirror of `injectContextIntoResponse` guard: if the handler already
    // placed a context on the inner payload, opts.context must NOT
    // clobber it. Correlation-id tracing works as long as something
    // ends up on the envelope; the handler's value wins over the opts
    // fallback.
    const handlerContext = { correlation_id: 'from-handler' };
    const optsContext = { correlation_id: 'from-opts' };
    const out = wrapEnvelope({ media_buy_id: 'mb_1', context: handlerContext }, { context: optsContext });
    assert.equal(out.context, handlerContext);
    assert.notEqual(out.context, optsContext);
  });
});

describe('wrapEnvelope: error envelopes', () => {
  it('echoes context on IDEMPOTENCY_CONFLICT error', () => {
    const err = {
      adcp_error: {
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'key reused with different payload',
        recovery: 'terminal',
      },
    };
    const out = wrapEnvelope(err, {
      context: { correlation_id: 'corr_1' },
    });
    assert.equal(out.adcp_error.code, 'IDEMPOTENCY_CONFLICT');
    assert.deepEqual(out.context, { correlation_id: 'corr_1' });
  });

  it('drops replayed on IDEMPOTENCY_CONFLICT (sibling allowlist)', () => {
    // A conflict is not a replay — the framework's `finalize()` path
    // for IDEMPOTENCY_CONFLICT never calls `injectReplayed`. The helper
    // mirrors that by honoring the ERROR_ENVELOPE_FIELD_ALLOWLIST entry
    // for IDEMPOTENCY_CONFLICT, which excludes `replayed`.
    const err = {
      adcp_error: {
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'key reused with different payload',
        recovery: 'terminal',
      },
    };
    const out = wrapEnvelope(err, {
      replayed: true,
      context: { correlation_id: 'corr_1' },
      operationId: 'op_xyz',
    });
    assert.ok(!('replayed' in out), 'replayed must be stripped');
    assert.deepEqual(out.context, { correlation_id: 'corr_1' });
    assert.equal(out.operation_id, 'op_xyz');
  });

  it('emits operation_id on IDEMPOTENCY_CONFLICT (sibling allowlist)', () => {
    const err = {
      adcp_error: {
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'key reused',
        recovery: 'terminal',
      },
    };
    const out = wrapEnvelope(err, { operationId: 'op_abc' });
    assert.equal(out.operation_id, 'op_abc');
  });

  it('unknown error code fails closed — only context echoes', () => {
    // An unregistered error code falls back to DEFAULT_ERROR_ENVELOPE_FIELDS
    // ({ context }). A seller who introduces a new code without registering
    // it does NOT inherit success-path semantics — they must opt in to any
    // sibling field they want round-tripped. Correlation tracing still
    // works because context is in the default set.
    const err = {
      adcp_error: {
        code: 'SOME_BESPOKE_CODE',
        message: 'custom',
        recovery: 'terminal',
      },
    };
    const out = wrapEnvelope(err, {
      replayed: false,
      context: { correlation_id: 'corr_1' },
      operationId: 'op_xyz',
    });
    assert.ok(!('replayed' in out), 'fail-closed: replayed dropped on unregistered code');
    assert.deepEqual(out.context, { correlation_id: 'corr_1' }, 'context always echoes');
    assert.ok(!('operation_id' in out), 'fail-closed: operation_id dropped on unregistered code');
  });

  it('errorCode override forces allowlist lookup even without adcp_error', () => {
    // Callers wiring A2A handlers may represent errors differently but
    // still want framework-aligned envelope semantics. `errorCode:
    // 'IDEMPOTENCY_CONFLICT'` applies the sibling allowlist regardless
    // of the inner shape.
    const out = wrapEnvelope(
      { error: { code: 'IDEMPOTENCY_CONFLICT' } },
      { replayed: true, errorCode: 'IDEMPOTENCY_CONFLICT' }
    );
    assert.ok(!('replayed' in out));
  });
});

describe('wrapEnvelope: purity', () => {
  it('does not mutate the input', () => {
    const inner = { media_buy_id: 'mb_1', status: 'active' };
    const snapshot = JSON.parse(JSON.stringify(inner));
    const out = wrapEnvelope(inner, {
      replayed: true,
      context: { correlation_id: 'corr_1' },
      operationId: 'op_xyz',
    });
    assert.deepEqual(inner, snapshot, 'input must not be mutated');
    assert.notEqual(out, inner, 'helper must return a new object');
  });

  it('does not mutate the input on error path', () => {
    const err = {
      adcp_error: {
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'x',
        recovery: 'terminal',
      },
    };
    const snapshot = JSON.parse(JSON.stringify(err));
    wrapEnvelope(err, {
      replayed: true,
      context: { correlation_id: 'corr_1' },
      operationId: 'op_xyz',
    });
    assert.deepEqual(err, snapshot);
  });
});

describe('ERROR_ENVELOPE_FIELD_ALLOWLIST: exported shape', () => {
  it('lists IDEMPOTENCY_CONFLICT with context + operation_id only', () => {
    const set = ERROR_ENVELOPE_FIELD_ALLOWLIST.IDEMPOTENCY_CONFLICT;
    assert.ok(set instanceof Set);
    assert.ok(set.has('context'));
    assert.ok(set.has('operation_id'));
    assert.ok(!set.has('replayed'), 'replayed must NOT be in the allowlist');
    assert.equal(set.size, 2);
  });

  it('every allowlist entry includes context (sanity invariant)', () => {
    // Future error codes can't silently drop context echo — correlation
    // tracing breaks if an error path stops echoing it. The module-load
    // `ensureContextEcho` check enforces this; the test asserts the
    // invariant at the shipped surface too.
    for (const [code, fields] of Object.entries(ERROR_ENVELOPE_FIELD_ALLOWLIST)) {
      assert.ok(fields.has('context'), `ERROR_ENVELOPE_FIELD_ALLOWLIST['${code}'] must include 'context'`);
    }
  });
});

describe('DEFAULT_ERROR_ENVELOPE_FIELDS: fail-closed default', () => {
  it('permits context only', () => {
    assert.ok(DEFAULT_ERROR_ENVELOPE_FIELDS instanceof Set);
    assert.ok(DEFAULT_ERROR_ENVELOPE_FIELDS.has('context'));
    assert.ok(!DEFAULT_ERROR_ENVELOPE_FIELDS.has('replayed'));
    assert.ok(!DEFAULT_ERROR_ENVELOPE_FIELDS.has('operation_id'));
    assert.equal(DEFAULT_ERROR_ENVELOPE_FIELDS.size, 1);
  });
});

describe('CONFLICT_ADCP_ERROR_ALLOWLIST: exported shape', () => {
  it('permits only metadata keys inside the adcp_error block', () => {
    // Guards against the stolen-key read oracle: an IDEMPOTENCY_CONFLICT
    // response must NOT echo the prior request payload inside adcp_error.
    // Only spec-defined metadata keys are permitted.
    assert.ok(CONFLICT_ADCP_ERROR_ALLOWLIST instanceof Set);
    for (const expected of ['code', 'message', 'status', 'correlation_id', 'request_id', 'operation_id']) {
      assert.ok(CONFLICT_ADCP_ERROR_ALLOWLIST.has(expected), `missing ${expected}`);
    }
    // Common payload fields that would leak prior state must NOT be in the set.
    for (const leaky of ['payload', 'stored_payload', 'budget', 'product_id', 'account_id']) {
      assert.ok(!CONFLICT_ADCP_ERROR_ALLOWLIST.has(leaky), `leaky key ${leaky} must not be allowlisted`);
    }
  });

  it('excludes recovery — adcpError() drops it on IDEMPOTENCY_CONFLICT', () => {
    // The `recovery` classifier is redundant with `code` (derivable from
    // STANDARD_ERROR_CODES) and widens the surface the stolen-key-read
    // invariant has to defend. `adcpError()` consults this allowlist
    // per-code and strips `recovery` from the output on conflict, so the
    // allowlist stays strict (keeping option 1 from #826).
    assert.ok(!CONFLICT_ADCP_ERROR_ALLOWLIST.has('recovery'));
  });

  it('excludes retry_after — a computed value would leak cached-entry age', () => {
    // Retry hints belong on transient codes (SERVICE_UNAVAILABLE,
    // RATE_LIMITED). On a terminal conflict, a seller that naively
    // computed `retry_after = cached_entry_age` would leak a
    // distinguisher between "key never seen" and "key seen N seconds
    // ago" — a stolen-key read oracle narrower than payload echo but
    // still load-bearing.
    assert.ok(!CONFLICT_ADCP_ERROR_ALLOWLIST.has('retry_after'));
  });
});
