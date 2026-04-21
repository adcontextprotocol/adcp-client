// Oracle unit tests — classify hand-crafted responses as accepted /
// rejected / invalid. Mirrors the failure modes called out in the issue:
// 500 HTML in payload, unknown ID → structured rejection, stack-trace
// leak, credential echo.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { evaluate } = require('../../dist/lib/conformance/oracle.js');

function accepted(tool, data, extra = {}) {
  return evaluate({
    tool,
    request: { signal_spec: 'auto intenders' },
    result: { success: true, status: 'completed', data, ...extra },
  });
}

function rejected(tool, code, message, extra = {}) {
  return evaluate({
    tool,
    request: { signal_spec: 'auto intenders' },
    result: {
      success: false,
      status: 'failed',
      error: message,
      adcpError: { code, message },
      ...extra,
    },
  });
}

describe('conformance: oracle', () => {
  test('valid success payload → accepted', () => {
    const out = accepted('get_signals', { signals: [] });
    assert.equal(out.verdict, 'accepted');
    assert.deepEqual(out.invariantFailures, []);
  });

  test('valid error envelope → rejected', () => {
    const out = rejected('get_signals', 'REFERENCE_NOT_FOUND', 'unknown signal_id');
    assert.equal(out.verdict, 'rejected');
    assert.deepEqual(out.invariantFailures, []);
  });

  test('schema-invalid payload → invalid', () => {
    // signals must be an array per schema; passing an object should fail.
    const out = accepted('get_signals', { signals: { not: 'an array' } });
    assert.equal(out.verdict, 'invalid');
    assert.ok(out.invariantFailures[0].startsWith('response schema mismatch'));
  });

  test('stack trace in response body → invariant failure', () => {
    const out = accepted('get_signals', {
      signals: [],
      errors: [{ code: 'INTERNAL', message: 'boom\n    at Object.handler (/app/x.js:42:10)' }],
    });
    assert.equal(out.verdict, 'invalid');
    assert.ok(out.invariantFailures.some((f) => f.includes('stack trace leak')));
  });

  test('Go stack trace in response body → invariant failure', () => {
    const out = accepted('get_signals', {
      signals: [],
      errors: [
        {
          code: 'INTERNAL',
          message: 'panic: runtime error\ngoroutine 1 [running]:\nmain.handler(0x0)\n\t/app/main.go:42 +0x1a',
        },
      ],
    });
    assert.equal(out.verdict, 'invalid');
    assert.ok(out.invariantFailures.some((f) => f.includes('stack trace leak')));
  });

  test('PHP stack trace in response body → invariant failure', () => {
    const out = accepted('get_signals', {
      signals: [],
      errors: [
        {
          code: 'INTERNAL',
          message:
            "Uncaught Exception: boom in /var/www/app.php:42\nStack trace:\n#0 /var/www/app.php(99): Handler->run()\n#1 {main}",
        },
      ],
    });
    assert.equal(out.verdict, 'invalid');
    assert.ok(out.invariantFailures.some((f) => f.includes('stack trace leak')));
  });

  test('credential echo in response → invariant failure', () => {
    const token = 'super-secret-token-abc123xyz';
    const out = evaluate({
      tool: 'get_signals',
      request: { signal_spec: 'x' },
      result: {
        success: true,
        status: 'completed',
        data: { signals: [], errors: [{ code: 'ECHO', message: `you sent ${token}` }] },
      },
      authToken: token,
    });
    assert.equal(out.verdict, 'invalid');
    assert.ok(out.invariantFailures.some((f) => f.includes('auth token')));
  });

  test('credential echo through adcpError.details → invariant failure', () => {
    const token = 'secret-token-xyzzy';
    const out = evaluate({
      tool: 'get_signals',
      request: {},
      result: {
        success: false,
        status: 'failed',
        error: 'rejected',
        adcpError: { code: 'AUTH_REQUIRED', message: 'nope', details: { received_token: token } },
      },
      authToken: token,
    });
    assert.equal(out.verdict, 'invalid');
    assert.ok(out.invariantFailures.some((f) => f.includes('auth token')));
  });

  test('context echoed with reordered keys → accepted', () => {
    const out = evaluate({
      tool: 'get_signals',
      request: { signal_spec: 'x', context: { a: 1, b: 2 } },
      result: {
        success: true,
        status: 'completed',
        // Python/Go dict round-trip commonly reorders keys; the oracle must
        // not flag this as context mutation.
        data: { signals: [], context: { b: 2, a: 1 } },
      },
    });
    assert.equal(out.verdict, 'accepted');
  });

  test('error envelope without reason code → invalid', () => {
    const out = evaluate({
      tool: 'get_signals',
      request: {},
      result: { success: false, status: 'failed', error: 'oops' },
    });
    assert.equal(out.verdict, 'invalid');
    assert.ok(out.invariantFailures.some((f) => f.includes('reason code')));
  });

  test('lowercase reason code → invariant failure', () => {
    const out = rejected('get_signals', 'not_found', 'unknown');
    assert.equal(out.verdict, 'invalid');
    assert.ok(out.invariantFailures.some((f) => f.includes('uppercase-snake')));
  });

  test('context echoed unchanged → accepted', () => {
    const ctx = { trace_id: 'abc123' };
    const out = evaluate({
      tool: 'get_signals',
      request: { signal_spec: 'x', context: ctx },
      result: { success: true, status: 'completed', data: { signals: [], context: ctx } },
    });
    assert.equal(out.verdict, 'accepted');
  });

  test('context mutated on response → invariant failure', () => {
    const out = evaluate({
      tool: 'get_signals',
      request: { signal_spec: 'x', context: { trace_id: 'abc' } },
      result: { success: true, status: 'completed', data: { signals: [], context: { trace_id: 'mutated' } } },
    });
    assert.equal(out.verdict, 'invalid');
    assert.ok(out.invariantFailures.some((f) => f.includes('context not echoed')));
  });
});
