const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { validateRequest, validateResponse } = require('../../dist/lib/validation/schema-validator');
const { buildAdcpValidationErrorPayload, buildValidationError } = require('../../dist/lib/validation/schema-errors');
const { jsonPointerToJsonPathLite } = require('../../dist/lib/utils/pointer-utils');
const { InMemoryStateStore } = require('../../dist/lib/index');
const { createAdcpServer } = require('../../dist/lib/server/legacy/v5');
const { adcpError } = require('../../dist/lib/server/errors');

function request(packages) {
  return {
    account: { account_id: 'account-1' },
    media_buy_id: 'media-buy-1',
    idempotency_key: 'validation-package-update-0001',
    packages,
  };
}

describe('forbidden-field validation diagnostics (#3114)', () => {
  it('does not count undefined fields as present in in-process requests', () => {
    const outcome = validateRequest(
      'update_media_buy',
      request([{ package_id: 'package-1', product_id: undefined, format_ids: [] }]),
      '3.1.24'
    );
    assert.equal(outcome.valid, false);
    assert.equal(
      outcome.issues.some(issue => issue.pointer === '/packages/0/product_id'),
      false
    );
    assert.ok(outcome.issues.some(issue => issue.pointer === '/packages/0/format_ids'));
  });
  for (const version of ['3.1.24', '3.2.1']) {
    it(`names every forbidden field and preserves allowed updates (${version})`, () => {
      const outcome = validateRequest(
        'update_media_buy',
        request([
          {
            package_id: 'package-1',
            product_id: 'product-1',
            format_ids: [{ agent_url: 'https://example.com', id: 'image' }],
          },
          { package_id: 'package-2', product_id: null },
        ]),
        version
      );
      assert.equal(outcome.valid, false);
      const issues = outcome.issues.filter(
        issue => issue.keyword === 'not' && issue.message.includes('cannot be set here')
      );
      assert.deepEqual(issues.map(issue => issue.pointer).sort(), [
        '/packages/0/format_ids',
        '/packages/0/product_id',
        '/packages/1/product_id',
      ]);
      for (const issue of issues) {
        assert.match(issue.message, /cannot be set here/);
        assert.ok(issue.schemaPath.endsWith('/not'));
        assert.ok(issue.schemaId);
      }
      const valid = validateRequest('update_media_buy', request([{ package_id: 'package-1', paused: true }]), version);
      assert.equal(valid.valid, true, JSON.stringify(valid.issues));
    });
  }

  it('leaves other not shapes opaque instead of inventing a field-level cause', () => {
    const outcome = validateResponse('buy_products', {
      status: 'failed',
      errors: [{ code: 'INVALID_REQUEST', message: 'Invalid request' }],
      media_buy_id: 'media-buy-1',
    });
    assert.equal(outcome.valid, false);
    // Success/Error union diagnostics still select the actionable surviving arm.
    assert.ok(outcome.issues.length > 0);
    assert.equal(
      outcome.issues.some(issue => issue.keyword === 'not' && issue.pointer === '/media_buy_id'),
      false
    );
  });

  it('bounds many failing request and response records with visible omission', () => {
    const outcomes = [
      validateRequest(
        'update_media_buy',
        request(
          Array.from({ length: 250 }, (_, index) => ({
            package_id: `package-${index}`,
            product_id: 'product-1',
            format_ids: [],
            delivery_type: 'guaranteed',
            pricing_option_id: 'pricing-1',
            currency: 'USD',
            budget: 100,
            targeting_overlay: {},
          }))
        )
      ),
      validateResponse('get_products', { products: Array.from({ length: 250 }, () => ({ product_id: 123 })) }),
    ];
    for (const outcome of outcomes) {
      assert.equal(outcome.valid, false);
      assert.ok(outcome.issues.length <= 100);
      assert.match(outcome.issues.at(-1).message, /diagnostic limit/);
      assert.ok(Buffer.byteLength(JSON.stringify(outcome.issues)) <= 64 * 1024);
      assert.doesNotMatch(outcome.issues[0].message, /diagnostic limit/);
    }
  });

  it('bounds byte-heavy enrichment and mirrored payloads from external issue lists', () => {
    const issues = Array.from({ length: 1000 }, () => ({
      pointer: '/packages/0/targeting',
      keyword: 'enum',
      message: 'Invalid targeting',
      schemaPath: '#/properties/targeting',
      allowedValues: Array.from({ length: 50 }, () => 'é'.repeat(40)),
    }));
    for (const exposeSchemaPath of [false, true]) {
      const payload = buildAdcpValidationErrorPayload('update_media_buy', 'request', issues, { exposeSchemaPath });
      assert.equal(payload.field, 'packages[0].targeting');
      assert.match(payload.issues.at(-1).message, /diagnostic limit/);
      assert.equal(payload.details.issues_truncated, true);
      assert.ok(Buffer.byteLength(JSON.stringify(payload.issues)) <= 64 * 1024);
      assert.deepEqual(payload.details.issues, payload.issues);
      assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 140 * 1024);
    }
    assert.ok(buildValidationError('update_media_buy', 'request', issues).details.issues.length < 100);
  });

  it('bounds a single oversized diagnostic without echoing its oversized value', () => {
    const payload = buildAdcpValidationErrorPayload('update_media_buy', 'request', [
      {
        pointer: '/packages/0',
        keyword: 'enum',
        message: 'x'.repeat(128 * 1024),
        schemaPath: '#/enum',
      },
    ]);
    assert.equal(payload.issues.length, 1);
    assert.equal(payload.issues[0].keyword, 'enum');
    assert.equal(payload.issues[0].pointer, '/packages/0');
    assert.equal(payload.details.issues_truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 1024);
  });

  it('bounds all dispatcher mirrors for escape-heavy diagnostic strings', async () => {
    const issues = Array.from({ length: 1000 }, () => ({
      pointer: `/ext/${'"\\'.repeat(400)}`,
      keyword: 'type',
      message: '"\\'.repeat(700),
      schemaPath: '#/type',
    }));
    const payload = buildAdcpValidationErrorPayload('update_media_buy', 'request', issues, { exposeSchemaPath: true });
    const server = createAdcpServer({
      name: 'escaped-diagnostics',
      version: '0.0.1',
      stateStore: new InMemoryStateStore(),
      idempotency: 'disabled',
      validation: { requests: 'off', responses: 'off' },
      mediaBuy: { updateMediaBuy: async () => adcpError('VALIDATION_ERROR', payload) },
    });
    const frame = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'update_media_buy', arguments: request([{ package_id: 'package-1', paused: true }]) },
    });
    assert.equal(frame.structuredContent.adcp_error.code, 'VALIDATION_ERROR');
    assert.ok(frame.structuredContent.errors[0].issues.length > 0);
    assert.equal(payload.details.issues_truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(frame)) < 1024 * 1024);
    assert.equal(payload.field, jsonPointerToJsonPathLite(issues[0].pointer));
  });

  it('keeps the real dispatcher error frame bounded for a request below 2 MiB', async () => {
    let called = false;
    const server = createAdcpServer({
      name: 'validation-regression',
      version: '0.0.1',
      stateStore: new InMemoryStateStore(),
      idempotency: 'disabled',
      validation: { requests: 'strict' },
      mediaBuy: {
        updateMediaBuy: async () => {
          called = true;
          return {};
        },
      },
    });
    const params = request(
      Array.from({ length: 14000 }, (_, index) => ({
        package_id: `package-${index}`,
        product_id: 'product-1',
        format_ids: [],
      }))
    );
    assert.ok(Buffer.byteLength(JSON.stringify(params)) < 2 * 1024 * 1024);
    const frame = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'update_media_buy', arguments: params },
    });
    assert.equal(called, false);
    assert.equal(frame.structuredContent.adcp_error.code, 'VALIDATION_ERROR');
    const issue = frame.structuredContent.adcp_error.issues[0];
    assert.equal(frame.structuredContent.adcp_error.field, jsonPointerToJsonPathLite(issue.pointer));
    assert.ok(Buffer.byteLength(JSON.stringify(frame)) < 1024 * 1024);
  });
});

describe('JSONPath-lite error fields', () => {
  for (const [pointer, expected] of [
    ['/packages/0/targeting', 'packages[0].targeting'],
    ['/ext/a~1b~0c', 'ext["a/b~c"]'],
    ['/ext/a.b', 'ext["a.b"]'],
    ['/ext/a"b', 'ext["a\\"b"]'],
    ['/items/01', 'items["01"]'],
    ['/0/name', '$[0].name'],
    ['', '$'],
    ['/', '$'],
  ]) {
    it(`translates ${JSON.stringify(pointer)}`, () => {
      assert.equal(jsonPointerToJsonPathLite(pointer), expected);
      const payload = buildAdcpValidationErrorPayload('update_media_buy', 'request', [
        {
          pointer,
          message: 'Invalid value',
          keyword: 'type',
          schemaPath: '#/type',
        },
      ]);
      assert.equal(payload.field, expected);
      assert.equal(payload.issues[0].pointer, pointer);
    });
  }
});
