// Oracle unit tests — classify hand-crafted responses as accepted /
// rejected / invalid. Mirrors the failure modes called out in the issue:
// 500 HTML in payload, unknown ID → structured rejection, stack-trace
// leak, credential echo.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { evaluate } = require('../../dist/lib/conformance/oracle.js');

function accepted(tool, data, extra = {}) {
  const responseData =
    tool === 'get_signals'
      ? {
          status: 'completed',
          cache_scope: 'public',
          ...data,
        }
      : data;
  return evaluate({
    tool,
    request: { signal_spec: 'auto intenders' },
    result: { success: true, status: 'completed', data: responseData, ...extra },
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

  test('synchronous decline_proposals validates without injecting task status', () => {
    const payload = { results: [{ proposal_id: 'proposal-1', outcome: 'declined' }] };
    const before = structuredClone(payload);
    const out = accepted('decline_proposals', payload);
    assert.equal(out.verdict, 'accepted', out.invariantFailures.join('; '));
    assert.deepEqual(payload, before);
  });

  test('closed response schemas admit canonical version metadata from SDK sellers', () => {
    const payload = {
      adcp_version: '3.2',
      results: [{ proposal_id: 'proposal-1', outcome: 'declined' }],
    };
    const out = accepted('decline_proposals', payload);
    assert.equal(out.verdict, 'accepted', out.invariantFailures.join('; '));
  });

  test('decline_proposals still rejects invalid versions and forbidden sync status', () => {
    const payload = { results: [{ proposal_id: 'proposal-1', outcome: 'declined' }] };
    // AdCP 3.3.0-beta.1 reopens the proposal-flow response roots (DR-0019 / DR-0036).
    const extended = accepted('decline_proposals', { ...payload, unexpected: true });
    assert.equal(extended.verdict, 'accepted', extended.invariantFailures.join('; '));
    for (const invalid of [
      { ...payload, adcp_version: 'not-a-version' },
      { ...payload, adcp_version: '3.2.6' },
      { ...payload, adcp_version: 3.2 },
      { ...payload, adcp_major_version: '3' },
      { ...payload, status: 'completed' },
      { ...payload, task_id: 'unexpected-task' },
      { results: [{ proposal_id: 'proposal-1' }] },
    ]) {
      const out = accepted('decline_proposals', invalid);
      assert.equal(out.verdict, 'invalid', JSON.stringify(invalid));
    }
  });

  test('oracle does not fill missing required status from the TaskResult envelope', () => {
    const out = evaluate({
      tool: 'get_signals',
      request: {},
      result: { success: true, status: 'completed', data: { cache_scope: 'public', signals: [] } },
    });
    assert.equal(out.verdict, 'invalid');
  });

  test('explicit AdCP 3.0 retains status-optional validation without mutating the payload', () => {
    const payload = { adcp_version: '3.0', cache_scope: 'public', signals: [] };
    const out = evaluate({
      tool: 'get_signals',
      request: {},
      result: { success: true, status: 'completed', data: payload },
    });
    assert.equal(out.verdict, 'accepted', out.invariantFailures.join('; '));
    assert.equal(payload.status, undefined);
    const compact = accepted('decline_proposals', {
      adcp_version: '3.0',
      results: [{ proposal_id: 'proposal-1', outcome: 'declined' }],
    });
    assert.equal(compact.verdict, 'accepted', compact.invariantFailures.join('; '));
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
    assert.ok(out.invariantFailures.some(f => f.includes('stack trace leak')));
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
    assert.ok(out.invariantFailures.some(f => f.includes('stack trace leak')));
  });

  test('JVM stack trace in response body → invariant failure', () => {
    const out = accepted('get_signals', {
      signals: [],
      errors: [
        {
          code: 'INTERNAL',
          message:
            'java.lang.NullPointerException\n\tat com.example.Handler.process(Handler.java:42)\n\tat com.example.App.main(App.java:10)',
        },
      ],
    });
    assert.equal(out.verdict, 'invalid');
    assert.ok(out.invariantFailures.some(f => f.includes('stack trace leak')));
  });

  test('unindented JVM frame after an escaped newline → invariant failure', () => {
    const out = accepted('get_signals', {
      signals: [],
      errors: [{ code: 'INTERNAL', message: 'failure\nat com.example.Handler.process(Handler.java:42)' }],
    });
    assert.equal(out.verdict, 'invalid');
    assert.ok(out.invariantFailures.some(failure => failure.includes('stack trace leak')));
  });

  test('long indented non-frame lines do not trigger the JVM detector', () => {
    const out = accepted('get_signals', {
      signals: [],
      errors: [{ code: 'NOTE', message: `documentation\n${' '.repeat(100_000)}not a stack frame` }],
    });
    assert.equal(out.verdict, 'accepted');
    assert.deepEqual(out.invariantFailures, []);
  });

  test('JVM-looking prose with trailing text is not treated as a stack frame', () => {
    const out = accepted('get_signals', {
      signals: [],
      errors: [
        {
          code: 'NOTE',
          message: 'documentation\nat com.example.Handler.process(Handler.java:42) is shown as an example',
        },
      ],
    });
    assert.equal(out.verdict, 'accepted');
    assert.deepEqual(out.invariantFailures, []);
  });

  test('JVM-looking prose punctuation is not mistaken for JSON framing', () => {
    const out = accepted('get_signals', {
      signals: [],
      errors: [{ code: 'NOTE', message: 'documentation\nat com.example.Handler.process(Handler.java:42)},' }],
    });
    assert.equal(out.verdict, 'accepted');
    assert.deepEqual(out.invariantFailures, []);
  });

  test('.NET stack trace in response body → invariant failure', () => {
    const out = accepted('get_signals', {
      signals: [],
      errors: [
        {
          code: 'INTERNAL',
          message:
            'System.NullReferenceException: Object reference not set\n   at Foo.Bar.Baz() in /app/src/Foo.cs:line 42\n   at Foo.Main() in /app/Program.cs:line 10',
        },
      ],
    });
    assert.equal(out.verdict, 'invalid');
    assert.ok(out.invariantFailures.some(f => f.includes('stack trace leak')));
  });

  test('PHP stack trace in response body → invariant failure', () => {
    const out = accepted('get_signals', {
      signals: [],
      errors: [
        {
          code: 'INTERNAL',
          message:
            'Uncaught Exception: boom in /var/www/app.php:42\nStack trace:\n#0 /var/www/app.php(99): Handler->run()\n#1 {main}',
        },
      ],
    });
    assert.equal(out.verdict, 'invalid');
    assert.ok(out.invariantFailures.some(f => f.includes('stack trace leak')));
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
    assert.ok(out.invariantFailures.some(f => f.includes('auth token')));
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
    assert.ok(out.invariantFailures.some(f => f.includes('auth token')));
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
        data: { status: 'completed', cache_scope: 'public', signals: [], context: { b: 2, a: 1 } },
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
    assert.ok(out.invariantFailures.some(f => f.includes('reason code')));
  });

  test('lowercase reason code → invariant failure', () => {
    const out = rejected('get_signals', 'not_found', 'unknown');
    assert.equal(out.verdict, 'invalid');
    assert.ok(out.invariantFailures.some(f => f.includes('uppercase-snake')));
  });

  test('context echoed unchanged → accepted', () => {
    const ctx = { trace_id: 'abc123' };
    const out = evaluate({
      tool: 'get_signals',
      request: { signal_spec: 'x', context: ctx },
      result: {
        success: true,
        status: 'completed',
        data: { status: 'completed', cache_scope: 'public', signals: [], context: ctx },
      },
    });
    assert.equal(out.verdict, 'accepted');
  });

  test('context missing from response → invariant failure when schema declares context', () => {
    // get_signals response schema declares a `context` property, so
    // dropping it entirely is a violation per spec. Earlier versions of
    // the oracle silent-tolerated this case.
    const out = evaluate({
      tool: 'get_signals',
      request: { signal_spec: 'x', context: { trace_id: 'abc' } },
      result: { success: true, status: 'completed', data: { status: 'completed', cache_scope: 'public', signals: [] } },
    });
    assert.equal(out.verdict, 'invalid');
    assert.ok(out.invariantFailures.some(f => f.includes('context') && f.includes('omitted')));
  });

  test('context mutated on response → invariant failure', () => {
    const out = evaluate({
      tool: 'get_signals',
      request: { signal_spec: 'x', context: { trace_id: 'abc' } },
      result: {
        success: true,
        status: 'completed',
        data: { status: 'completed', cache_scope: 'public', signals: [], context: { trace_id: 'mutated' } },
      },
    });
    assert.equal(out.verdict, 'invalid');
    assert.ok(out.invariantFailures.some(f => f.includes('context not echoed')));
  });
});
