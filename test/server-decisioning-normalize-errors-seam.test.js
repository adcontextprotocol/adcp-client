// Integration test: the framework applies normalizeErrors at the
// sync_creatives wire-projection seam. Adopters can return errors as
// strings, native Error instances, or partial wire-shaped objects;
// the framework coerces them to canonical Error[] shape before the
// response validator runs. Strict validation must pass.

process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform');

function basePlatform(syncCreatives) {
  return {
    capabilities: {
      specialisms: ['sales-non-guaranteed'],
      creative_agents: [{ agent_url: 'https://example.com/creative-agent/mcp' }],
      channels: ['display'],
      pricingModels: ['cpm'],
      config: {},
    },
    statusMappers: {},
    accounts: {
      resolve: async () => ({
        id: 'acc_1',
        name: 'Acme',
        status: 'active',
        metadata: {},
        authInfo: { kind: 'api_key' },
      }),
    },
    sales: {
      getProducts: async () => ({ products: [] }),
      createMediaBuy: async () => ({
        media_buy_id: 'mb_1',
        status: 'pending_creatives',
        confirmed_at: '2026-04-28T00:00:00Z',
        packages: [],
      }),
      updateMediaBuy: async () => ({ media_buy_id: 'mb_1', status: 'active' }),
      syncCreatives,
      getMediaBuyDelivery: async () => ({
        currency: 'USD',
        reporting_period: { start: '2026-04-01', end: '2026-04-30' },
        media_buy_deliveries: [],
      }),
    },
  };
}

describe('sync_creatives — framework normalizes adopter errors at projection seam', () => {
  it('coerces a bare string in row.errors[] into wire Error shape (strict validation)', async () => {
    const platform = basePlatform(async () => [
      // Adopter returns a row with errors as bare strings — common
      // pattern when wrapping upstream platforms that surface errors
      // as message arrays.
      {
        creative_id: 'cr_1',
        action: 'failed',
        errors: ['creative format unsupported'],
      },
    ]);
    const server = createAdcpServerFromPlatform(platform, {
      name: 'norm-host',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'strict' },
    });

    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'sync_creatives',
        arguments: {
          account: { account_id: 'acc_1' },
          creatives: [{ creative_id: 'cr_1', format_id: { id: 'f', agent_url: 'https://x' } }],
          idempotency_key: '11111111-1111-1111-1111-111111111111',
        },
      },
    });

    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    const row = result.structuredContent.creatives[0];
    assert.strictEqual(row.action, 'failed');
    assert.ok(Array.isArray(row.errors));
    assert.strictEqual(row.errors[0].code, 'GENERIC_ERROR');
    assert.strictEqual(row.errors[0].message, 'creative format unsupported');
    assert.strictEqual(row.errors[0].recovery, 'terminal');
  });

  it('coerces a native Error instance in row.errors[] (strict validation)', async () => {
    const platform = basePlatform(async () => [
      {
        creative_id: 'cr_2',
        action: 'failed',
        errors: [new Error('upstream connection refused')],
      },
    ]);
    const server = createAdcpServerFromPlatform(platform, {
      name: 'norm-host',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'strict' },
    });

    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'sync_creatives',
        arguments: {
          account: { account_id: 'acc_1' },
          creatives: [{ creative_id: 'cr_2', format_id: { id: 'f', agent_url: 'https://x' } }],
          idempotency_key: '22222222-2222-2222-2222-222222222222',
        },
      },
    });

    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    const row = result.structuredContent.creatives[0];
    assert.strictEqual(row.errors[0].code, 'GENERIC_ERROR');
    assert.strictEqual(row.errors[0].message, 'upstream connection refused');
  });

  it('preserves wire-shaped errors and drops vendor extensions', async () => {
    const platform = basePlatform(async () => [
      {
        creative_id: 'cr_3',
        action: 'failed',
        errors: [
          {
            code: 'CREATIVE_REJECTED',
            message: 'Standards review failed',
            recovery: 'terminal',
            field: 'tags',
            // Vendor-specific — should be dropped by the normalizer.
            vendor_internal_id: 'should_drop',
            stack_trace: 'should_drop',
          },
        ],
      },
    ]);
    const server = createAdcpServerFromPlatform(platform, {
      name: 'norm-host',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'strict' },
    });

    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'sync_creatives',
        arguments: {
          account: { account_id: 'acc_1' },
          creatives: [{ creative_id: 'cr_3', format_id: { id: 'f', agent_url: 'https://x' } }],
          idempotency_key: '33333333-3333-3333-3333-333333333333',
        },
      },
    });

    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    const err = result.structuredContent.creatives[0].errors[0];
    assert.strictEqual(err.code, 'CREATIVE_REJECTED');
    assert.strictEqual(err.recovery, 'terminal');
    assert.strictEqual(err.field, 'tags');
    assert.ok(!('vendor_internal_id' in err));
    assert.ok(!('stack_trace' in err));
  });

  it('rows without errors pass through unchanged', async () => {
    const platform = basePlatform(async () => [{ creative_id: 'cr_ok', action: 'created', status: 'approved' }]);
    const server = createAdcpServerFromPlatform(platform, {
      name: 'norm-host',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'strict' },
    });

    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'sync_creatives',
        arguments: {
          account: { account_id: 'acc_1' },
          creatives: [{ creative_id: 'cr_ok', format_id: { id: 'f', agent_url: 'https://x' } }],
          idempotency_key: '44444444-4444-4444-4444-444444444444',
        },
      },
    });

    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    const row = result.structuredContent.creatives[0];
    assert.strictEqual(row.action, 'created');
    assert.strictEqual(row.status, 'approved');
    assert.strictEqual(row.errors, undefined);
  });
});
