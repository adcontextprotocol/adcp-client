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

const {
  computePayloadDigestSha256,
  createUpstreamRecorder,
  toQueryUpstreamTrafficResponse,
} = require('../../dist/lib/upstream-recorder');
const { canonicalize } = require('../../dist/lib/utils/jcs');
const { ADCP_VERSION } = require('../../dist/lib/version');

// ────────────────────────────────────────────────────────────
// Cached schema — UpstreamTrafficSuccess.recorded_calls[].items
// ────────────────────────────────────────────────────────────

const COMPLY_RESPONSE_SCHEMA = require(
  path.resolve(__dirname, '../../schemas/cache', ADCP_VERSION, 'compliance/comply-test-controller-response.json')
);
const CONTEXT_SCHEMA = require(path.resolve(__dirname, '../../schemas/cache', ADCP_VERSION, 'core/context.json'));
const EXT_SCHEMA = require(path.resolve(__dirname, '../../schemas/cache', ADCP_VERSION, 'core/ext.json'));
const UPSTREAM_TRAFFIC_SUCCESS_SCHEMA = COMPLY_RESPONSE_SCHEMA.oneOf.find(
  branch => branch.title === 'UpstreamTrafficSuccess'
);
assert.ok(
  UPSTREAM_TRAFFIC_SUCCESS_SCHEMA,
  'cached comply_test_controller response schema must include UpstreamTrafficSuccess'
);
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
    assert.equal(
      call.payload_length,
      Buffer.byteLength(canonicalize({ users: [{ hashed_email: 'vec-1' }, { hashed_email: 'vec-2' }] }))
    );
    assert.deepEqual(call.identifier_match_proofs, [
      { identifier_value_sha256: sha256Hex('vec-1'), found: true },
      { identifier_value_sha256: sha256Hex('missing'), found: false },
    ]);
  });

  test('digest-mode identifier proofs parse manual JSON string payloads', async () => {
    const recorder = createUpstreamRecorder({ enabled: true });
    await recorder.runWithPrincipal('p', async () => {
      recorder.record({
        method: 'POST',
        url: 'https://x.example/upload',
        content_type: 'application/json',
        payload: JSON.stringify({ users: [{ hashed_email: 'vec-1' }] }),
        status_code: 200,
      });
    });
    const result = recorder.query({
      principal: 'p',
      attestationMode: 'digest',
      identifierValueDigests: [sha256Hex('vec-1')],
    });
    const [call] = toQueryUpstreamTrafficResponse(result).recorded_calls;
    assert.deepEqual(call.identifier_match_proofs, [{ identifier_value_sha256: sha256Hex('vec-1'), found: true }]);
  });

  test('manual JSON string payloads are parsed and redacted before storage and digesting', async () => {
    const recorder = createUpstreamRecorder({ enabled: true });
    const payload = JSON.stringify({
      authorization: 'Bearer fake_test_fixture_not_a_real_token_aaaa',
      users: [{ hashed_email: 'vec-1' }],
    });
    await recorder.runWithPrincipal('p', async () => {
      recorder.record({
        method: 'POST',
        url: 'https://x.example/upload',
        content_type: 'application/json',
        payload,
      });
    });

    const [rawCall] = recorder.query({ principal: 'p' }).items;
    assert.deepEqual(rawCall.payload, {
      authorization: '[redacted]',
      users: [{ hashed_email: 'vec-1' }],
    });

    const [digestCall] = recorder.query({ principal: 'p', attestationMode: 'digest' }).items;
    assert.equal(digestCall.payload_digest_sha256, computePayloadDigestSha256(payload, 'application/json'));
  });

  test('redaction depth covers payloads that digest canonicalization accepts', async () => {
    let payload = { access_token: 'fake_test_fixture_not_a_real_token_aaaa' };
    for (let i = 0; i < 255; i++) payload = { nested: payload };

    const recorder = createUpstreamRecorder({ enabled: true });
    await recorder.runWithPrincipal('p', async () => {
      recorder.record({
        method: 'POST',
        url: 'https://x.example/upload',
        content_type: 'application/json',
        payload,
      });
    });

    let cursor = recorder.query({ principal: 'p' }).items[0].payload;
    for (let i = 0; i < 255; i++) cursor = cursor.nested;
    assert.equal(cursor.access_token, '[redacted]');
  });

  test('off-spec string purpose tags are omitted and surfaced through onError', async () => {
    const events = [];
    const recorder = createUpstreamRecorder({
      enabled: true,
      purpose: () => 'not_a_spec_purpose',
      onError: event => events.push(event),
    });
    await recorder.runWithPrincipal('p', async () => {
      recorder.record({
        method: 'POST',
        url: 'https://x.example/upload',
        content_type: 'application/json',
        payload: {},
      });
    });

    const [call] = recorder.query({ principal: 'p' }).items;
    assert.equal(call.purpose, undefined);
    assert.deepEqual(events, [{ kind: 'classifier_invalid_purpose', purpose: 'not_a_spec_purpose' }]);
    assert.ok(validateRecordedCall(call), explain(validateRecordedCall.errors));
  });

  test('non-string purpose tags are stringified before onError emission', async () => {
    const events = [];
    const recorder = createUpstreamRecorder({
      enabled: true,
      purpose: () => 42,
      onError: event => events.push(event),
    });
    await recorder.runWithPrincipal('p', async () => {
      recorder.record({
        method: 'POST',
        url: 'https://x.example/upload',
        content_type: 'application/json',
        payload: {},
      });
    });

    const [call] = recorder.query({ principal: 'p' }).items;
    assert.equal(call.purpose, undefined);
    assert.deepEqual(events, [{ kind: 'classifier_invalid_purpose', purpose: '42' }]);
    assert.ok(validateRecordedCall(call), explain(validateRecordedCall.errors));
  });

  test('disabled recorder returns a schema-valid since_timestamp', () => {
    const recorder = createUpstreamRecorder({ enabled: false });
    const wireShape = toQueryUpstreamTrafficResponse(recorder.query({ principal: 'p' }));
    assert.equal(wireShape.since_timestamp, '1970-01-01T00:00:00.000Z');
    assert.ok(validateUpstreamTrafficSuccess(wireShape), explain(validateUpstreamTrafficSuccess.errors));
  });

  test('computePayloadDigestSha256 pins the JCS lowercase-hex digest vector', () => {
    const payload = { b: 1.25, é: ['z'], a: { c: true } };
    const reordered = { a: { c: true }, é: ['z'], b: 1.25 };
    const jsonString = '{ "é": ["z"], "a": { "c": true }, "b": 1.25 }';
    const expected = '1456bd286cd759390538b520050a4df59e11fa794dc2cab8333402620f99ce29';
    assert.equal(computePayloadDigestSha256(payload), expected);
    assert.equal(computePayloadDigestSha256(reordered), expected);
    assert.equal(computePayloadDigestSha256(jsonString, 'application/json'), expected);
  });

  test('computePayloadDigestSha256 rejects parsed JSON strings that cannot be canonicalized', () => {
    const tooDeepJson = `${'['.repeat(260)}"leaf"${']'.repeat(260)}`;
    assert.throws(
      () => computePayloadDigestSha256(tooDeepJson, 'application/json'),
      /JSON payload exceeds max canonicalization depth/
    );
  });

  test('computePayloadDigestSha256 rejects deep object payloads that cannot be canonicalized', () => {
    let payload = 'leaf';
    for (let i = 0; i < 260; i++) payload = [payload];
    assert.throws(() => computePayloadDigestSha256(payload), /JSON payload exceeds max canonicalization depth/);
  });

  test('computePayloadDigestSha256 applies default and custom redaction before hashing', () => {
    const raw = {
      authorization: 'Bearer fake_test_fixture_not_a_real_token_aaaa',
      nested: { vendor_secret: 'fake_test_fixture_not_a_real_secret_bbbb' },
      users: [{ hashed_email: 'vec-1' }],
    };
    const defaultRedacted = {
      authorization: '[redacted]',
      nested: { vendor_secret: 'fake_test_fixture_not_a_real_secret_bbbb' },
      users: [{ hashed_email: 'vec-1' }],
    };
    const customRedacted = {
      authorization: '[redacted]',
      nested: { vendor_secret: '[redacted]' },
      users: [{ hashed_email: 'vec-1' }],
    };
    assert.equal(computePayloadDigestSha256(raw), sha256Hex(canonicalize(defaultRedacted)));
    assert.equal(
      computePayloadDigestSha256(raw, 'application/json', /^(authorization|vendor_secret)$/i),
      sha256Hex(canonicalize(customRedacted))
    );
    assert.equal(
      computePayloadDigestSha256(defaultRedacted, 'application/json', { prenormalized: true }),
      computePayloadDigestSha256(defaultRedacted, 'application/json', false)
    );
  });

  test('computePayloadDigestSha256 matches recorder digest projection for normalized payload shapes', async () => {
    async function assertDigestParity({ payload, contentType, recorderOptions = {}, helperOptions }) {
      const recorder = createUpstreamRecorder({ enabled: true, ...recorderOptions });
      await recorder.runWithPrincipal('p', async () => {
        recorder.record({
          method: 'POST',
          url: 'https://x.example/upload',
          content_type: contentType,
          payload,
        });
      });
      const [call] = recorder.query({ principal: 'p', attestationMode: 'digest' }).items;
      assert.equal(call.payload_digest_sha256, computePayloadDigestSha256(payload, contentType, helperOptions));
    }

    async function assertWrappedFetchDigestParity({ body, contentType, helperOptions }) {
      const recorder = createUpstreamRecorder({ enabled: true });
      const wrappedFetch = recorder.wrapFetch(async () => new Response('ok', { status: 200 }));
      await recorder.runWithPrincipal('p', async () => {
        await wrappedFetch('https://x.example/upload', {
          method: 'POST',
          headers: { 'content-type': contentType },
          body,
        });
      });
      const [call] = recorder.query({ principal: 'p', attestationMode: 'digest' }).items;
      assert.equal(call.payload_digest_sha256, computePayloadDigestSha256(body, contentType, helperOptions));
    }

    async function assertRequestDigestParity(request, bodyForHelper) {
      const contentType = request.headers.get('content-type') ?? '';
      const recorder = createUpstreamRecorder({ enabled: true });
      const wrappedFetch = recorder.wrapFetch(async () => new Response('ok', { status: 200 }));
      await recorder.runWithPrincipal('p', async () => {
        await wrappedFetch(request);
      });
      const [call] = recorder.query({ principal: 'p', attestationMode: 'digest' }).items;
      assert.equal(call.payload_digest_sha256, computePayloadDigestSha256(bodyForHelper, contentType));
    }

    await assertDigestParity({
      payload: JSON.stringify({ b: 2, a: 1 }),
      contentType: 'application/json',
    });
    await assertWrappedFetchDigestParity({
      body: JSON.stringify({
        authorization: 'Bearer fake_test_fixture_not_a_real_token_aaaa',
        audience: 'segment-1',
      }),
      contentType: 'application/json',
    });
    await assertDigestParity({
      payload: 'access_token=fake_test_fixture_not_a_real_token_aaaa&audience=segment-1',
      contentType: 'application/x-www-form-urlencoded',
    });
    await assertWrappedFetchDigestParity({
      body: new URLSearchParams([
        ['access_token', 'fake_test_fixture_not_a_real_token_aaaa'],
        ['audience', 'segment-1'],
      ]),
      contentType: 'application/x-www-form-urlencoded',
    });
    const form = new FormData();
    form.set('access_token', 'fake_test_fixture_not_a_real_token_aaaa');
    form.set('audience', 'segment-1');
    await assertRequestDigestParity(new Request('https://x.example/upload', { method: 'POST', body: form }), form);
    await assertDigestParity({
      payload: Buffer.from([1, 2, 3, 4]),
      contentType: 'application/octet-stream',
    });
    await assertDigestParity({
      payload: { long_field: 'x'.repeat(100) },
      contentType: 'application/json',
      recorderOptions: { maxPayloadBytes: 20 },
      helperOptions: { maxPayloadBytes: 20 },
    });
    await assertDigestParity({
      payload: { long_field: 'x'.repeat(100) },
      contentType: 'application/json',
      recorderOptions: { maxPayloadBytes: 0 },
      helperOptions: { maxPayloadBytes: 0 },
    });
    await assertDigestParity({
      payload: { long_field: 'x'.repeat(100) },
      contentType: 'application/json',
      recorderOptions: { maxPayloadBytes: -1 },
      helperOptions: { maxPayloadBytes: -1 },
    });
    await assertDigestParity({
      payload: { long_field: 'x'.repeat(100) },
      contentType: 'application/json',
      recorderOptions: { maxPayloadBytes: Number.POSITIVE_INFINITY },
      helperOptions: { maxPayloadBytes: Number.POSITIVE_INFINITY },
    });
  });

  test('digest-mode query drops payloads that cannot be canonicalized without poisoning the whole query', async () => {
    const events = [];
    const recorder = createUpstreamRecorder({ enabled: true, onError: event => events.push(event) });
    await recorder.runWithPrincipal('p', async () => {
      recorder.record({
        method: 'POST',
        url: 'https://x.example/upload',
        content_type: 'application/json',
        payload: { value: Number.NaN },
      });
    });
    const result = recorder.query({ principal: 'p', attestationMode: 'digest' });
    assert.equal(result.total, 0);
    assert.deepEqual(result.items, []);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'payload_build_failed');
    assert.match(String(events[0].err), /JCS: non-finite number/);
  });

  test('raw recording rejects structured payloads beyond the redaction depth cap', async () => {
    const events = [];
    const recorder = createUpstreamRecorder({ enabled: true, onError: event => events.push(event) });
    let payload = { authorization: 'fake_test_fixture_not_a_real_token_aaaa' };
    for (let i = 0; i < 260; i++) payload = { wrapper: payload };
    await recorder.runWithPrincipal('p', async () => {
      recorder.record({
        method: 'POST',
        url: 'https://x.example/upload',
        content_type: 'application/json',
        payload,
      });
    });
    assert.equal(recorder.query({ principal: 'p' }).total, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'payload_build_failed');
    assert.match(String(events[0].err), /JSON payload exceeds max canonicalization depth/);
  });

  test('JSON string payloads fail closed when parsed content exceeds the redaction depth cap', async () => {
    const events = [];
    const recorder = createUpstreamRecorder({ enabled: true, onError: event => events.push(event) });
    let payload = { authorization: 'fake_test_fixture_not_a_real_token_aaaa' };
    for (let i = 0; i < 260; i++) payload = { wrapper: payload };
    await recorder.runWithPrincipal('p', async () => {
      recorder.record({
        method: 'POST',
        url: 'https://x.example/upload',
        content_type: 'application/json',
        payload: JSON.stringify(payload),
      });
    });
    const result = recorder.query({ principal: 'p' });
    assert.equal(result.total, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'payload_build_failed');
    assert.match(String(events[0].err), /JSON payload exceeds max canonicalization depth/);
  });

  test('malformed JSON strings scrub secret-shaped keys and emit onError when digest scanning cannot parse them', async () => {
    const events = [];
    const recorder = createUpstreamRecorder({ enabled: true, onError: event => events.push(event) });
    await recorder.runWithPrincipal('p', async () => {
      recorder.record({
        method: 'POST',
        url: 'https://x.example/upload',
        content_type: 'application/json',
        payload: '{"authorization":"fake_test_fixture_not_a_real_token_aaaa"',
      });
    });

    const rawResult = recorder.query({ principal: 'p' });
    assert.equal(rawResult.total, 1);
    assert.equal(rawResult.items[0].payload, '{"authorization":"[redacted]"');
    assert.doesNotMatch(String(rawResult.items[0].payload), /fake_test_fixture_not_a_real_token_aaaa/);

    const result = recorder.query({
      principal: 'p',
      attestationMode: 'digest',
      identifierValueDigests: [sha256Hex('missing')],
    });
    assert.equal(result.total, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'json_payload_parse_failed');
    assert.equal(events[0].content_type, 'application/json');
  });

  test('digest-mode identifier proof scan avoids false negatives in large payloads', async () => {
    const recorder = createUpstreamRecorder({ enabled: true, maxPayloadBytes: 0 });
    const values = Array.from({ length: 4100 }, (_, i) => `vec-${i}`);
    await recorder.runWithPrincipal('p', async () => {
      recorder.record({
        method: 'POST',
        url: 'https://x.example/upload',
        content_type: 'application/json',
        payload: { users: values.map(hashed_email => ({ hashed_email })) },
      });
    });
    const result = recorder.query({
      principal: 'p',
      attestationMode: 'digest',
      identifierValueDigests: [sha256Hex('vec-0'), sha256Hex('vec-4099'), sha256Hex('missing')],
    });
    const [call] = toQueryUpstreamTrafficResponse(result).recorded_calls;
    assert.deepEqual(call.identifier_match_proofs, [
      { identifier_value_sha256: sha256Hex('vec-0'), found: true },
      { identifier_value_sha256: sha256Hex('vec-4099'), found: true },
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
