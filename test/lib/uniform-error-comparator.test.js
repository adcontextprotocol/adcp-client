// Byte-equivalence comparator for the uniform-error-response invariant.
// Exercises the hard-fail paths (status, header, body, envelope fields,
// MCP isError, A2A task state) and the soft latency metadata channel.

const { describe, test } = require('node:test');
const assert = require('node:assert');

const { compareProbes } = require('../../dist/lib/conformance/invariants/uniformErrorComparator.js');

function capture({ status = 404, headers = {}, body = '', latencyMs = 100 } = {}) {
  return {
    url: 'http://test/probe',
    method: 'POST',
    status,
    headers,
    body,
    latencyMs,
    timestamp: '2026-04-21T00:00:00Z',
    bodyTruncated: false,
  };
}

function envelope(code, extra = {}) {
  return JSON.stringify({ error: { code, message: 'Reference not found', ...extra } });
}

describe('uniformErrorComparator', () => {
  test('byte-equivalent captures → equivalent', () => {
    const body = envelope('REFERENCE_NOT_FOUND');
    const r = compareProbes(
      capture({ status: 404, headers: { 'content-type': 'application/json' }, body }),
      capture({ status: 404, headers: { 'content-type': 'application/json' }, body })
    );
    assert.equal(r.equivalent, true);
    assert.deepEqual(r.differences, []);
  });

  test('divergent HTTP status → fail', () => {
    const r = compareProbes(
      capture({ status: 404, body: envelope('REFERENCE_NOT_FOUND') }),
      capture({ status: 403, body: envelope('REFERENCE_NOT_FOUND') })
    );
    assert.equal(r.equivalent, false);
    assert.ok(r.differences.some(d => d.includes('HTTP status')));
  });

  test('divergent error.code → fail (envelope-aware)', () => {
    const r = compareProbes(
      capture({ body: envelope('REFERENCE_NOT_FOUND') }),
      capture({ body: envelope('PERMISSION_DENIED') })
    );
    assert.equal(r.equivalent, false);
    assert.ok(r.differences.some(d => d.startsWith('error.code diverges')));
  });

  test('divergent error.details → fail (envelope-aware)', () => {
    const r = compareProbes(
      capture({ body: envelope('REFERENCE_NOT_FOUND', { details: { searched_for: 'abc' } }) }),
      capture({ body: envelope('REFERENCE_NOT_FOUND', { details: { searched_for: 'xyz' } }) })
    );
    assert.equal(r.equivalent, false);
    assert.ok(r.differences.some(d => d.startsWith('error.details diverges')));
  });

  test('ETag header divergence → fail (not allowlisted)', () => {
    const body = envelope('REFERENCE_NOT_FOUND');
    const r = compareProbes(
      capture({ body, headers: { etag: '"v1"' } }),
      capture({ body, headers: { etag: '"v2"' } })
    );
    assert.equal(r.equivalent, false);
    assert.ok(r.differences.some(d => d.includes('"etag"') && d.includes('diverges')));
  });

  test('Cache-Control divergence → fail (not allowlisted)', () => {
    const body = envelope('REFERENCE_NOT_FOUND');
    const r = compareProbes(
      capture({ body, headers: { 'cache-control': 'max-age=60' } }),
      capture({ body, headers: { 'cache-control': 'no-cache' } })
    );
    assert.equal(r.equivalent, false);
    assert.ok(r.differences.some(d => d.includes('"cache-control"')));
  });

  test('X-Request-Id divergence → OK (allowlisted)', () => {
    const body = envelope('REFERENCE_NOT_FOUND');
    const r = compareProbes(
      capture({ body, headers: { 'content-type': 'application/json', 'x-request-id': 'abc' } }),
      capture({ body, headers: { 'content-type': 'application/json', 'x-request-id': 'xyz' } })
    );
    assert.equal(r.equivalent, true);
  });

  test('Date divergence → OK (allowlisted)', () => {
    const body = envelope('REFERENCE_NOT_FOUND');
    const r = compareProbes(
      capture({ body, headers: { date: 'Tue, 21 Apr 2026 00:00:00 GMT' } }),
      capture({ body, headers: { date: 'Tue, 21 Apr 2026 00:00:05 GMT' } })
    );
    assert.equal(r.equivalent, true);
  });

  test('traceparent + tracestate divergence → OK (allowlisted)', () => {
    const body = envelope('REFERENCE_NOT_FOUND');
    const r = compareProbes(
      capture({ body, headers: { traceparent: '00-abc-01', tracestate: 'vendor=a' } }),
      capture({ body, headers: { traceparent: '00-xyz-01', tracestate: 'vendor=b' } })
    );
    assert.equal(r.equivalent, true);
  });

  test('header name case normalizes', () => {
    const body = envelope('REFERENCE_NOT_FOUND');
    const r = compareProbes(
      capture({ body, headers: { 'X-Request-Id': 'abc' } }),
      capture({ body, headers: { 'x-request-id': 'xyz' } })
    );
    assert.equal(r.equivalent, true);
  });

  test('rate-limit header divergence → fail (closed allowlist)', () => {
    const body = envelope('REFERENCE_NOT_FOUND');
    const r = compareProbes(
      capture({ body, headers: { 'x-ratelimit-remaining': '99' } }),
      capture({ body, headers: { 'x-ratelimit-remaining': '42' } })
    );
    assert.equal(r.equivalent, false);
  });

  test('header presence only on one side → fail', () => {
    const body = envelope('REFERENCE_NOT_FOUND');
    const r = compareProbes(
      capture({ body, headers: { etag: '"v1"' } }),
      capture({ body, headers: {} })
    );
    assert.equal(r.equivalent, false);
    assert.ok(r.differences.some(d => d.includes('present on probe A only')));
  });

  test('MCP isError wrapper — identical → equivalent', () => {
    const body = JSON.stringify({
      isError: true,
      content: [{ type: 'text', text: envelope('REFERENCE_NOT_FOUND') }],
    });
    const r = compareProbes(capture({ body }), capture({ body }));
    assert.equal(r.equivalent, true);
  });

  test('MCP isError true vs false → fail', () => {
    const errBody = JSON.stringify({
      isError: true,
      content: [{ type: 'text', text: envelope('REFERENCE_NOT_FOUND') }],
    });
    const okBody = JSON.stringify({
      isError: false,
      content: [{ type: 'text', text: envelope('REFERENCE_NOT_FOUND') }],
    });
    const r = compareProbes(capture({ body: errBody }), capture({ body: okBody }));
    assert.equal(r.equivalent, false);
    assert.ok(r.differences.some(d => d.includes('MCP isError diverges')));
  });

  test('MCP isError wrapper — diverges inside text envelope → fail', () => {
    const body1 = JSON.stringify({
      isError: true,
      content: [{ type: 'text', text: envelope('REFERENCE_NOT_FOUND') }],
    });
    const body2 = JSON.stringify({
      isError: true,
      content: [{ type: 'text', text: envelope('PERMISSION_DENIED') }],
    });
    const r = compareProbes(capture({ body: body1 }), capture({ body: body2 }));
    assert.equal(r.equivalent, false);
    assert.ok(r.differences.some(d => d.startsWith('error.code diverges')));
  });

  test('A2A task.status.state divergence → fail', () => {
    const body1 = JSON.stringify({ task: { status: { state: 'failed' } } });
    const body2 = JSON.stringify({ task: { status: { state: 'rejected' } } });
    const r = compareProbes(capture({ body: body1 }), capture({ body: body2 }));
    assert.equal(r.equivalent, false);
    assert.ok(r.differences.some(d => d.includes('A2A task.status.state diverges')));
  });

  test('JSON-RPC error shape with tunneled code → envelope-aware diff', () => {
    const body1 = JSON.stringify({ error: { code: -32001, message: 'domain error', data: { code: 'REFERENCE_NOT_FOUND' } } });
    const body2 = JSON.stringify({ error: { code: -32001, message: 'domain error', data: { code: 'PERMISSION_DENIED' } } });
    const r = compareProbes(capture({ body: body1 }), capture({ body: body2 }));
    assert.equal(r.equivalent, false);
    assert.ok(r.differences.some(d => d.startsWith('error.code diverges')));
  });

  test('key-order-insensitive body compare', () => {
    const body1 = JSON.stringify({ error: { code: 'REFERENCE_NOT_FOUND', message: 'm' } });
    const body2 = JSON.stringify({ error: { message: 'm', code: 'REFERENCE_NOT_FOUND' } });
    const r = compareProbes(capture({ body: body1 }), capture({ body: body2 }));
    assert.equal(r.equivalent, true);
  });

  test('non-JSON body bytes diverge → fail with byte-count hint', () => {
    const r = compareProbes(
      capture({ headers: { 'content-type': 'text/plain' }, body: 'foo' }),
      capture({ headers: { 'content-type': 'text/plain' }, body: 'foobar' })
    );
    assert.equal(r.equivalent, false);
    assert.ok(r.differences.some(d => d.includes('3 bytes vs 6 bytes')));
  });

  test('latency delta recorded even when equivalent', () => {
    const body = envelope('REFERENCE_NOT_FOUND');
    const r = compareProbes(capture({ body, latencyMs: 10 }), capture({ body, latencyMs: 350 }));
    assert.equal(r.equivalent, true);
    assert.equal(r.latencyDeltaMs, 340);
  });

  test('CDN insertions (cf-ray, x-amz-cf-id, x-amz-request-id) allowlisted', () => {
    const body = envelope('REFERENCE_NOT_FOUND');
    const r = compareProbes(
      capture({
        body,
        headers: {
          'cf-ray': '903a1f23f4cb4c5e-EWR',
          'x-amz-cf-id': 'abc123',
          'x-amz-request-id': 'req-1',
        },
      }),
      capture({
        body,
        headers: {
          'cf-ray': 'a02b2f34a5dc5d6f-SFO',
          'x-amz-cf-id': 'xyz789',
          'x-amz-request-id': 'req-2',
        },
      })
    );
    assert.equal(r.equivalent, true);
  });

  test('server-timing + age + via allowlisted', () => {
    const body = envelope('REFERENCE_NOT_FOUND');
    const r = compareProbes(
      capture({ body, headers: { 'server-timing': 'db;dur=42', age: '0', via: '1.1 cache-1' } }),
      capture({ body, headers: { 'server-timing': 'db;dur=99', age: '12', via: '1.1 cache-2' } })
    );
    assert.equal(r.equivalent, true);
  });

  test('Content-Length divergence → fail (must match, not allowlisted)', () => {
    const body = envelope('REFERENCE_NOT_FOUND');
    const r = compareProbes(
      capture({ body, headers: { 'content-length': '100' } }),
      capture({ body, headers: { 'content-length': '101' } })
    );
    assert.equal(r.equivalent, false);
    assert.ok(r.differences.some(d => d.includes('"content-length"')));
  });

  test('Vary divergence → fail (must match, not allowlisted)', () => {
    const body = envelope('REFERENCE_NOT_FOUND');
    const r = compareProbes(
      capture({ body, headers: { vary: 'Accept' } }),
      capture({ body, headers: { vary: 'Accept-Encoding' } })
    );
    assert.equal(r.equivalent, false);
    assert.ok(r.differences.some(d => d.includes('"vary"')));
  });

  test('Content-Type divergence → fail (must match, not allowlisted)', () => {
    const body = envelope('REFERENCE_NOT_FOUND');
    const r = compareProbes(
      capture({ body, headers: { 'content-type': 'application/json' } }),
      capture({ body, headers: { 'content-type': 'text/html' } })
    );
    assert.equal(r.equivalent, false);
    assert.ok(r.differences.some(d => d.includes('"content-type"')));
  });
});
