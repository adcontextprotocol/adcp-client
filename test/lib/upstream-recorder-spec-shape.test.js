/**
 * Spec-shape conformance test for `RecordedCall` (issue adcp-client#1290).
 *
 * Pins that what the recorder produces (and what
 * `toQueryUpstreamTrafficResponse` projects) matches the wire shape the
 * spec defines for `comply_test_controller`'s `query_upstream_traffic`
 * scenario response (`UpstreamTrafficSuccess` in the cached
 * `comply-test-controller-response.json`). The test compiles the cached
 * subschema directly so `npm run sync-schemas` surfaces wire-shape drift.
 */

const path = require('node:path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const Ajv = require('ajv').default;
const addFormats = require('ajv-formats').default;

const { createUpstreamRecorder, toQueryUpstreamTrafficResponse } = require('../../dist/lib/upstream-recorder');
const { ADCP_VERSION } = require('../../dist/lib/version');

// ────────────────────────────────────────────────────────────
// Cached schema — UpstreamTrafficSuccess.recorded_calls[].items
// ────────────────────────────────────────────────────────────

const COMPLY_RESPONSE_SCHEMA = require(path.resolve(
  __dirname,
  '../../schemas/cache',
  ADCP_VERSION,
  'compliance/comply-test-controller-response.json'
));
const CONTEXT_SCHEMA = require(path.resolve(
  __dirname,
  '../../schemas/cache',
  ADCP_VERSION,
  'core/context.json'
));
const EXT_SCHEMA = require(path.resolve(
  __dirname,
  '../../schemas/cache',
  ADCP_VERSION,
  'core/ext.json'
));
const UPSTREAM_TRAFFIC_SUCCESS_SCHEMA = COMPLY_RESPONSE_SCHEMA.oneOf.find(
  branch => branch.title === 'UpstreamTrafficSuccess'
);
assert.ok(UPSTREAM_TRAFFIC_SUCCESS_SCHEMA, 'cached comply_test_controller response schema must include UpstreamTrafficSuccess');
const RECORDED_CALL_SCHEMA = UPSTREAM_TRAFFIC_SUCCESS_SCHEMA.properties.recorded_calls.items;

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(CONTEXT_SCHEMA);
ajv.addSchema(EXT_SCHEMA);
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
        headers: { authorization: 'Bearer fake_test_fixture_not_a_real_token_fff', 'content-type': 'application/json' },
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
        // no payload supplied by the adapter; the recorder emits a raw-mode
        // empty object so the 3.1 schema's required `payload` field is present.
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

  test('digest-mode query validates and returns identifier match proofs', async () => {
    const recorder = createUpstreamRecorder({ enabled: true });
    await recorder.runWithPrincipal('p', async () => {
      recorder.record({
        method: 'POST',
        url: 'https://x.example/upload',
        content_type: 'application/json',
        payload: { users: [{ hashed_email: 'vec-1' }, { hashed_email: 'vec-2' }] },
        status_code: 200,
      });
    });
    const result = recorder.query({
      principal: 'p',
      attestationMode: 'digest',
      identifierValueDigests: [sha256Hex('vec-1'), sha256Hex('missing')],
    });
    const wireShape = toQueryUpstreamTrafficResponse(result);
    assert.ok(validateUpstreamTrafficSuccess(wireShape), explain(validateUpstreamTrafficSuccess.errors));
    const [call] = wireShape.recorded_calls;
    assert.equal(call.attestation_mode, 'digest');
    assert.equal(call.payload, undefined);
    assert.match(call.payload_digest_sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(call.identifier_match_proofs, [
      { identifier_value_sha256: sha256Hex('vec-1'), found: true },
      { identifier_value_sha256: sha256Hex('missing'), found: false },
    ]);
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

function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
