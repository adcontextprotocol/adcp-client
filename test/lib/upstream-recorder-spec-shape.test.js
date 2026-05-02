/**
 * Spec-shape conformance test for `RecordedCall` (issue adcp-client#1290).
 *
 * Pins that what the recorder produces (and what
 * `toQueryUpstreamTrafficResponse` projects) matches the wire shape the
 * spec defines for `comply_test_controller`'s `query_upstream_traffic`
 * scenario response (`UpstreamTrafficSuccess` in
 * `comply-test-controller-response.json`, spec PR
 * adcontextprotocol/adcp#3816 — merged to spec `main`, not yet in any
 * released 3.0.x cache as of this writing).
 *
 * Once a 3.0.5+ AdCP release lands the schema in
 * `schemas/cache/<version>/compliance/comply-test-controller-response.json`,
 * this test SHOULD switch to compiling against that cached subschema
 * instead of the inline fixture below — that way `npm run sync-schemas`
 * surfaces wire-shape drift the moment the spec evolves. Until then the
 * inline schema mirrors the merged spec PR's diff verbatim and exists
 * to catch field-name regressions on the SDK side.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const Ajv = require('ajv').default;
const addFormats = require('ajv-formats').default;

const { createUpstreamRecorder, toQueryUpstreamTrafficResponse } = require('../../dist/lib/upstream-recorder');

// ────────────────────────────────────────────────────────────
// Spec fixture — UpstreamTrafficSuccess.recorded_calls[].items
// ────────────────────────────────────────────────────────────

/**
 * Inline copy of the `UpstreamTrafficSuccess.recorded_calls[].items`
 * subschema from spec PR adcp#3816. Switch to the cached-schema
 * extraction below once 3.0.5+ ships.
 *
 * Source: https://github.com/adcontextprotocol/adcp/blob/main/static/schemas/source/compliance/comply-test-controller-response.json
 */
const RECORDED_CALL_SCHEMA = {
  type: 'object',
  properties: {
    method: {
      type: 'string',
      enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
    },
    endpoint: { type: 'string' },
    url: { type: 'string', format: 'uri' },
    host: { type: 'string' },
    path: { type: 'string' },
    content_type: { type: 'string' },
    payload: {},
    timestamp: { type: 'string', format: 'date-time' },
    status_code: { type: 'integer', minimum: 100, maximum: 599 },
  },
  required: ['method', 'endpoint', 'url', 'content_type', 'payload', 'timestamp'],
  additionalProperties: true,
};

const UPSTREAM_TRAFFIC_SUCCESS_SCHEMA = {
  type: 'object',
  properties: {
    success: { type: 'boolean', const: true },
    recorded_calls: { type: 'array', items: RECORDED_CALL_SCHEMA },
    total_count: { type: 'integer', minimum: 0 },
    truncated: { type: 'boolean' },
    since_timestamp: { type: 'string', format: 'date-time' },
  },
  required: ['success', 'recorded_calls', 'total_count'],
  additionalProperties: true,
};

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const validateRecordedCall = ajv.compile(RECORDED_CALL_SCHEMA);
const validateUpstreamTrafficSuccess = ajv.compile(UPSTREAM_TRAFFIC_SUCCESS_SCHEMA);

function explain(errors) {
  return JSON.stringify(errors, null, 2);
}

// ────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────

describe('RecordedCall spec-shape conformance (UpstreamTrafficSuccess)', () => {
  test('a maximally-populated RecordedCall validates', async () => {
    const recorder = createUpstreamRecorder({
      enabled: true,
      purpose: () => 'platform_primary',
    });
    await recorder.runWithPrincipal('p', async () => {
      recorder.record({
        method: 'POST',
        url: 'https://api.example.test/v1/audience/upload?cohort=2',
        content_type: 'application/json',
        headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
        payload: { users: [{ hashed_email: 'vec-1' }, { hashed_email: 'vec-2' }] },
        status_code: 201,
      });
    });
    const { items } = recorder.query({ principal: 'p' });
    assert.equal(items.length, 1);
    const ok = validateRecordedCall(items[0]);
    assert.ok(ok, `RecordedCall failed schema: ${explain(validateRecordedCall.errors)}`);
  });

  test('a minimal RecordedCall (only required fields) validates', async () => {
    const recorder = createUpstreamRecorder({ enabled: true });
    await recorder.runWithPrincipal('p', async () => {
      recorder.record({
        method: 'GET',
        url: 'https://x.example/health',
        content_type: 'application/json',
        // no payload — recorded as undefined; spec says payload is required
        // but `{}` validates as `payload: {}` since `payload: {}` matches
        // the `payload: {}` schema (open). Use an explicit payload to pin.
        payload: {},
      });
    });
    const { items } = recorder.query({ principal: 'p' });
    assert.equal(items.length, 1);
    assert.ok(validateRecordedCall(items[0]), explain(validateRecordedCall.errors));
  });

  test('non-JSON content_type with binary marker payload still validates', async () => {
    const recorder = createUpstreamRecorder({ enabled: true });
    await recorder.runWithPrincipal('p', async () => {
      recorder.record({
        method: 'POST',
        url: 'https://x.example/upload',
        content_type: 'application/octet-stream',
        payload: Buffer.from([1, 2, 3]),
      });
    });
    const { items } = recorder.query({ principal: 'p' });
    // payload is now `'[binary 3 bytes]'` per the recorder's binary
    // handling — schema's `payload: {}` accepts strings.
    assert.equal(items[0].payload, '[binary 3 bytes]');
    assert.ok(validateRecordedCall(items[0]), explain(validateRecordedCall.errors));
  });

  test('toQueryUpstreamTrafficResponse output validates against UpstreamTrafficSuccess', async () => {
    const recorder = createUpstreamRecorder({ enabled: true });
    await recorder.runWithPrincipal('p', async () => {
      recorder.record({
        method: 'POST',
        url: 'https://x.example/upload',
        content_type: 'application/json',
        payload: { users: [{ hashed_email: 'vec-1' }] },
        status_code: 200,
      });
    });
    const result = recorder.query({ principal: 'p' });
    const wireShape = toQueryUpstreamTrafficResponse(result);
    const ok = validateUpstreamTrafficSuccess(wireShape);
    assert.ok(ok, `UpstreamTrafficSuccess failed schema: ${explain(validateUpstreamTrafficSuccess.errors)}`);
    // The renames are the load-bearing claim — pin them explicitly.
    assert.deepEqual(Object.keys(wireShape).sort(), [
      'recorded_calls',
      'since_timestamp',
      'success',
      'total_count',
      'truncated',
    ]);
    assert.equal(wireShape.success, true);
  });

  test('empty result still validates as UpstreamTrafficSuccess', async () => {
    const recorder = createUpstreamRecorder({ enabled: true });
    const result = recorder.query({ principal: 'p' });
    const wireShape = toQueryUpstreamTrafficResponse(result);
    assert.ok(validateUpstreamTrafficSuccess(wireShape), explain(validateUpstreamTrafficSuccess.errors));
    assert.deepEqual(wireShape.recorded_calls, []);
    assert.equal(wireShape.total_count, 0);
  });
});
