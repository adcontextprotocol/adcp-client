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
const releases = ['3.0', '3.1', ADCP_VERSION];

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

test('shared body schema preserves webhook-specific scheduling fields', () => {
  const body = report({ notification_type: 'adjusted', sequence_number: 4 });
  assert.deepEqual(MediaBuyDeliveryReportSchema.parse(body), body);
});
