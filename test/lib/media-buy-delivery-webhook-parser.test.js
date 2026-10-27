const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseMediaBuyDeliveryWebhook: parse } = require('../../dist/lib/webhooks');
const {
  getSchemaValidatorByRef,
  MediaBuyDeliveryWebhookResultSchema,
  MediaBuyDeliveryReportSchema,
  GetMediaBuyDeliveryResponseSchema,
} = require('../../dist/lib/schemas');
const { ADCP_VERSION } = require('../../dist/lib');
const releases = ['3.0', '3.1', '3.2', ADCP_VERSION];

function report(overrides = {}) {
  return {
    notification_type: 'scheduled',
    reporting_period: { start: '2026-10-19T00:00:00Z', end: '2026-10-20T00:00:00Z' },
    currency: 'USD',
    media_buy_deliveries: [
      {
        media_buy_id: 'mb1',
        status: 'active',
        currency: 'USD',
        totals: { spend: 1 },
        by_package: [{ package_id: 'p', spend: 1, currency: 'USD', pricing_model: 'cpm', rate: 1 }],
      },
    ],
    ...overrides,
  };
}
function envelope(result = report(), overrides = {}) {
  return {
    idempotency_key: 'delivery-report-regression-0001',
    operation_id: 'buyer-report-operation',
    task_id: 'delivery-report-1',
    task_type: 'media_buy_delivery',
    status: 'completed',
    timestamp: '2026-10-20T00:00:00Z',
    result,
    ...overrides,
  };
}

for (const adcpVersion of releases) {
  test(`${adcpVersion}: parses an authenticated envelope without rewriting report data`, () => {
    const body = envelope(report({ aggregated_totals: { impressions: 1, spend: 2, media_buy_count: 1 } }));
    const parsed = parse(body, { adcpVersion });
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    assert.equal(parsed.wireFormat, 'mcp_envelope');
    assert.deepEqual(parsed.envelope, body);
    assert.deepEqual(parsed.result, body.result);
    assert.notEqual(parsed.envelope, body);
    body.result.media_buy_deliveries[0].totals.spend = 500;
    assert.equal(parsed.result.media_buy_deliveries[0].totals.spend, 1);
  });
  test(`${adcpVersion}: missing package breakdown is a readable result error`, () => {
    const body = envelope();
    delete body.result.media_buy_deliveries[0].by_package;
    const parsed = parse(body, { adcpVersion });
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, 'webhook_result_invalid');
    assert.ok(parsed.errors.includes('result.media_buy_deliveries[0].by_package is required'), JSON.stringify(parsed));
    assert.match(parsed.message, /result\.media_buy_deliveries\[0\]\.by_package is required/);
  });
  test(`${adcpVersion}: accepts bare reports only with explicit opt-in and a marker`, () => {
    const body = report();
    assert.equal(parse(body, { adcpVersion }).code, 'webhook_unsupported_payload');
    const parsed = parse(body, { adcpVersion, acceptBareDeliveryReport: true });
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    assert.equal(parsed.wireFormat, 'bare_delivery_report');
    assert.equal(parsed.envelope, undefined);
    assert.deepEqual(parsed.result, body);
    assert.equal(parsed.result.task_id, undefined);
    const polled = { ...report(), status: 'completed' };
    const compatiblePoll = parse(polled, { adcpVersion, acceptBareDeliveryReport: true });
    assert.equal(compatiblePoll.ok, true, JSON.stringify(compatiblePoll));
    assert.equal(compatiblePoll.wireFormat, 'bare_delivery_report');
    assert.deepEqual(compatiblePoll.result, polled);
    delete body.media_buy_deliveries[0].by_package;
    const invalid = parse(body, { adcpVersion, acceptBareDeliveryReport: true });
    assert.equal(invalid.code, 'webhook_result_invalid');
    assert.ok(invalid.errors.includes('media_buy_deliveries[0].by_package is required'));
  });
  test(`${adcpVersion}: task status and reporting notification type are independent`, () => {
    for (const status of ['completed', 'working', 'failed', 'input-required']) {
      const parsed = parse(envelope(report({ notification_type: 'delayed' }), { status }), { adcpVersion });
      assert.equal(parsed.ok, true, JSON.stringify(parsed));
      assert.equal(parsed.envelope.status, status);
    }
    assert.equal(parse(envelope(report(), { status: 'delayed' }), { adcpVersion }).code, 'webhook_envelope_invalid');
  });
  test(`${adcpVersion}: currency requirements follow the supplied release`, () => {
    const body = envelope();
    delete body.result.currency;
    const parsed = parse(body, { adcpVersion });
    if (adcpVersion === '3.0' || adcpVersion === '3.1') {
      assert.equal(parsed.code, 'webhook_result_invalid');
      assert.ok(parsed.errors.includes('result.currency is required'));
    } else assert.equal(parsed.ok, true, JSON.stringify(parsed));
  });
}

test('operation_id is optional only on 3.0 and is never synthesized', () => {
  const body = envelope();
  delete body.operation_id;
  const legacy = parse(body, { adcpVersion: '3.0' });
  assert.equal(legacy.ok, true, JSON.stringify(legacy));
  assert.equal(legacy.envelope.operation_id, undefined);
  for (const adcpVersion of ['3.1', '3.2', ADCP_VERSION]) {
    const parsed = parse(body, { adcpVersion });
    assert.equal(parsed.code, 'webhook_envelope_invalid');
    assert.ok(parsed.errors.includes('operation_id is required'));
  }
});

test('invalid metadata cannot fall back to bare report handling', () => {
  for (const missing of ['task_type', 'task_id', 'timestamp', 'idempotency_key', 'status', 'result']) {
    const body = envelope();
    delete body[missing];
    assert.equal(parse(body, { acceptBareDeliveryReport: true }).code, 'webhook_envelope_invalid');
  }
  assert.equal(parse(envelope(report(), { task_type: 'create_media_buy' })).code, 'webhook_unsupported_payload');
});

test('strings and bytes parse, while malformed JSON and non-JSON objects fail safely', () => {
  const body = envelope();
  for (const value of [
    JSON.stringify(body),
    Buffer.from(JSON.stringify(body)),
    new TextEncoder().encode(JSON.stringify(body)),
  ]) {
    assert.equal(parse(value).ok, true);
  }
  const cycle = {};
  cycle.self = cycle;
  let getterCalls = 0;
  const getter = {
    get result() {
      getterCalls++;
      throw new Error('must not execute getters');
    },
  };
  const deep = {};
  let node = deep;
  for (let i = 0; i < 70; i++) node = node.next = {};
  for (const value of ['{', Buffer.from([0xff]), undefined, null, [], 42, cycle, getter, deep, new Date()]) {
    const parsed = parse(value);
    assert.equal(parsed.code, 'webhook_envelope_invalid');
    assert.ok(parsed.errors.length > 0);
  }
  assert.equal(getterCalls, 0);
});

test('body version claims do not select the report validator', () => {
  const body = envelope();
  delete body.result.currency;
  body.adcp_version = '3.1';
  assert.equal(parse(body, { adcpVersion: '3.2' }).ok, true);
  body.adcp_version = ADCP_VERSION;
  assert.equal(parse(body, { adcpVersion: '3.1' }).code, 'webhook_result_invalid');
});

test('delivery envelope projection never weakens the raw cached schema validator', () => {
  const body = envelope();
  const strict = getSchemaValidatorByRef('core/mcp-webhook-payload.json', '3.0');
  assert.equal(strict(body), false, 'the authored 3.0 task-type enum omits the reporting task');
  assert.equal(parse(body, { adcpVersion: '3.0' }).ok, true);
  assert.equal(strict(body), false, 'the compatibility projection must use a separate cache entry');
  assert.equal(getSchemaValidatorByRef('core/mcp-webhook-payload.json', '3.0'), strict);
});

test('public schema-ref validators can collect complete diagnostics explicitly', () => {
  const validate = getSchemaValidatorByRef('media-buy/media-buy-delivery-webhook-result.json', '3.1', undefined, {
    allErrors: true,
  });
  assert.equal(validate({}), false);
  assert.ok(validate.errors.length >= 4);
});

test('shared body schema accepts poll and push data without synthesizing task status', () => {
  const body = report();
  assert.deepEqual(MediaBuyDeliveryReportSchema.parse(body), body);
  assert.equal(
    GetMediaBuyDeliveryResponseSchema.safeParse(body).success,
    false,
    'poll status is inherited from protocol-envelope'
  );
  assert.equal(GetMediaBuyDeliveryResponseSchema.safeParse({ ...body, status: 'completed' }).success, true);
  assert.equal(MediaBuyDeliveryWebhookResultSchema.safeParse(body).success, true);
  delete body.media_buy_deliveries[0].by_package;
  assert.equal(MediaBuyDeliveryWebhookResultSchema.safeParse(body).success, false);
  assert.equal(MediaBuyDeliveryReportSchema.safeParse(body).success, false);
});

test('inline notification enum compatibility export remains available', () => {
  const types = require('../../dist/lib/types');
  assert.deepEqual(types.MediaBuyDeliveryWebhookResult_NotificationTypeValues, [
    'scheduled',
    'final',
    'delayed',
    'adjusted',
    'window_update',
  ]);
});

async function registeredReceiver(deliveryKind = 'reporting') {
  const taskType = deliveryKind === 'reporting' ? 'media_buy_delivery' : 'artifact_delivery';
  const { SingleAgentClient, InMemoryWebhookRegistrationStore } = require('../../dist/lib');
  const { StaticJwksResolver } = require('../../dist/lib/signing/jwks');
  const { signWebhook } = require('../../dist/lib/signing/client');
  const { keys } = require('../fixtures/webhook-signing-vectors/keys.json');
  const key = keys.find(key => key.kid === 'test-ed25519-webhook-2026');
  const { _private_d_for_test_only: d, ...publicKey } = key;
  const agent = {
    id: 'reporting-3461-seller',
    name: 'Seller',
    agent_uri: 'https://seller.example/mcp',
    protocol: 'mcp',
  };
  const store = new InMemoryWebhookRegistrationStore();
  const operationId = 'trusted-report-route';
  const url = 'https://buyer.example/reports';
  const now = Date.now();
  await store.putIfAbsent({
    agentId: agent.id,
    agentUrl: agent.agent_uri,
    protocol: 'mcp',
    operationId,
    taskType,
    callbackUrl: url,
    method: 'POST',
    mode: 'rfc9421',
    deliveryKind,
    authorizationContextVersion: 1,
    createdAt: now,
    expiresAt: now + 60000,
  });
  const client = new SingleAgentClient(agent, {
    webhookRegistrationStore: store,
    webhookVerification: { jwks: new StaticJwksResolver([publicKey]) },
  });
  return {
    client,
    options(body, adcpVersion) {
      const rawBody = JSON.stringify(body);
      const signed = signWebhook(
        { method: 'POST', url, headers: { 'content-type': 'application/json' }, body: rawBody },
        { keyid: key.kid, alg: 'ed25519', privateKey: { ...publicKey, d } }
      );
      return {
        rawBody,
        headers: signed.headers,
        operationId,
        taskType,
        requestMethod: 'POST',
        requestUrl: url,
        adcpVersion,
      };
    },
  };
}

test('registered deliveries use the supplied report release after signature verification', async () => {
  const receiver = await registeredReceiver();
  const body = envelope(report({ notification_type: 'delayed' }), { status: 'working' });
  delete body.result.currency;
  const invalid31 = await receiver.client.verifyAndParseWebhook(receiver.options(body, '3.1'));
  assert.equal(invalid31.code, 'webhook_result_invalid');
  assert.ok(invalid31.errors.includes('result.currency is required'));
  const options32 = receiver.options(body, '3.2');
  const valid32 = await receiver.client.verifyAndParseWebhook(options32);
  assert.equal(valid32.ok, true, JSON.stringify(valid32));
  assert.equal(valid32.metadata.status, 'working');
  assert.deepEqual(valid32.result, body.result);
  const replay = await receiver.client.verifyAndParseWebhook(options32);
  assert.equal(replay.ok, false);
  assert.equal(replay.code, 'webhook_signature_replayed');
});

test('signature failures precede delivery diagnostics and verified bytes precede parsed bodies', async () => {
  const receiver = await registeredReceiver();
  const body = envelope();
  const options = receiver.options(body, '3.2');
  const tampered = structuredClone(body);
  delete tampered.result.media_buy_deliveries[0].by_package;
  const rejected = await receiver.client.verifyAndParseWebhook({ ...options, rawBody: JSON.stringify(tampered) });
  assert.equal(rejected.ok, false);
  assert.notEqual(rejected.code, 'webhook_result_invalid');
  assert.equal(rejected.errors, undefined);
  const valid = await receiver.client.verifyAndParseWebhook({ ...receiver.options(body, '3.2'), payload: tampered });
  assert.equal(valid.ok, true, JSON.stringify(valid));
  assert.deepEqual(valid.result, body.result);
});

test('registered 3.0 delivery keeps a missing operation_id absent in the envelope', async () => {
  const receiver = await registeredReceiver();
  const body = envelope();
  delete body.operation_id;
  const parsed = await receiver.client.verifyAndParseWebhook(receiver.options(body, '3.0'));
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.equal(parsed.envelope.operation_id, undefined);
  assert.equal(parsed.metadata.operationId, 'trusted-report-route');
});

test('published ESM entry points expose the shared schema and discriminated parser result', () => {
  const { spawnSync } = require('node:child_process');
  const { resolve } = require('node:path');
  const compiled = spawnSync(
    process.execPath,
    [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '--strict',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--skipLibCheck',
      'test/fixtures/types/media-buy-delivery-webhook.mts',
    ],
    { cwd: resolve(__dirname, '../..'), encoding: 'utf8', timeout: 30000 }
  );
  assert.equal(compiled.status, 0, compiled.stdout || compiled.stderr || String(compiled.error));
});

test('invalid reporting configuration does not consume a signed delivery nonce', async () => {
  const receiver = await registeredReceiver();
  const options = receiver.options(envelope(), '3.2');
  const unavailable = await receiver.client.verifyAndParseWebhook({ ...options, adcpVersion: '3.3.0' });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.code, 'webhook_verification_unavailable');
  const accepted = await receiver.client.verifyAndParseWebhook({ ...options, adcpVersion: '3.2' });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(accepted.metadata.operationId, 'trusted-report-route');
  assert.equal(accepted.envelope.operation_id, 'buyer-report-operation');
  const replayed = await receiver.client.verifyAndParseWebhook({ ...options, adcpVersion: '3.2' });
  assert.equal(replayed.code, 'webhook_signature_replayed');
});

test('shared body schema preserves webhook-specific scheduling fields', () => {
  const body = report({ notification_type: 'window_update', sequence_number: 4 });
  assert.deepEqual(MediaBuyDeliveryReportSchema.parse(body), body);
});

test('artifact schema configuration failures also preserve the signed delivery nonce', async t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { withExternalSchemaRoot } = require('../../dist/lib/validation/schema-loader');
  const receiver = await registeredReceiver('artifact');
  const body = {
    idempotency_key: 'artifact-preflight-regression-3461',
    media_buy_id: 'mb1',
    batch_id: 'batch1',
    timestamp: '2026-10-20T00:00:00Z',
    artifacts: [],
  };
  const options = receiver.options(body);
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-artifact-preflight-'));
  t.after(() => fs.rmSync(emptyRoot, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(emptyRoot, 'preflight.json'),
    JSON.stringify({ $id: `/schemas/${ADCP_VERSION}/core/preflight.json`, type: 'object' })
  );
  const failed = await withExternalSchemaRoot(ADCP_VERSION, emptyRoot, () =>
    receiver.client.verifyAndParseWebhook(options)
  );
  assert.equal(failed.code, 'webhook_verification_unavailable');
  const accepted = await receiver.client.verifyAndParseWebhook(options);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.deepEqual(accepted.result, body);
  const replay = await receiver.client.verifyAndParseWebhook(options);
  assert.equal(replay.code, 'webhook_signature_replayed');
});
