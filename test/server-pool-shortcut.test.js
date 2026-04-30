process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createAdcpServerFromPlatform, getAllAdcpMigrations } = require('../dist/lib/server');

describe('createAdcpServerFromPlatform — pool shortcut', () => {
  it('getAllAdcpMigrations returns concatenated DDL for all three tables', () => {
    const ddl = getAllAdcpMigrations();
    assert.match(ddl, /adcp_idempotency/);
    assert.match(ddl, /adcp_ctx_metadata/);
    assert.match(ddl, /CREATE TABLE/);
    // All three tables present
    const tableMatches = ddl.match(/CREATE TABLE IF NOT EXISTS/g);
    assert.ok(
      tableMatches && tableMatches.length >= 3,
      `expected ≥3 CREATE TABLE statements, got ${tableMatches?.length}`
    );
  });

  it('opts.pool wires idempotency + ctxMetadata + taskRegistry without explicit per-store opts', () => {
    // Lightweight mock pool — implements PgQueryable
    let queryCount = 0;
    const mockPool = {
      async query(_text, _values) {
        queryCount++;
        // Return empty result for any read; the framework only queries
        // during dispatch / probe, so this stays passive at construction time.
        return { rows: [], rowCount: 0 };
      },
    };

    const platform = {
      capabilities: {
        adcp_version: '3.0.0',
        specialisms: ['sales-non-guaranteed'],
        pricingModels: ['cpm'],
        channels: ['display'],
        formats: [{ format_id: 'display_300x250' }],
        idempotency: { replay_ttl_seconds: 86400 },
      },
      accounts: {
        resolution: 'derived',
        resolve: async () => ({ id: 'pub_main', operator: 'mypub', ctx_metadata: {} }),
        upsert: async () => ({ ok: true, items: [] }),
        list: async () => ({ items: [], nextCursor: null }),
      },
      sales: {
        getProducts: async () => ({ products: [] }),
        createMediaBuy: async () => ({ media_buy_id: 'mb_1', status: 'active', packages: [] }),
        updateMediaBuy: async () => ({ media_buy_id: 'mb_1', status: 'active', packages: [] }),
        getMediaBuyDelivery: async () => ({ deliveries: [] }),
        getMediaBuys: async () => ({ media_buys: [] }),
      },
    };

    // Should not throw — framework wires idempotency / ctxMetadata / taskRegistry from pool
    const server = createAdcpServerFromPlatform(platform, {
      name: 'pool-shortcut-test',
      version: '1.0.0',
      pool: mockPool,
      validation: { requests: 'off', responses: 'off' },
    });
    assert.ok(server);
    // No queries expected at construction time (probes are explicit, not auto-fired)
    assert.equal(queryCount, 0);
  });

  it('explicit per-store opts win over pool-derived defaults', async () => {
    const mockPool = {
      async query() {
        return { rows: [], rowCount: 0 };
      },
    };
    let explicitCtxMetadataAccessed = false;
    const explicitCtxMetadata = {
      async get() {
        explicitCtxMetadataAccessed = true;
        return undefined;
      },
      async bulkGet() {
        explicitCtxMetadataAccessed = true;
        return new Map();
      },
      async set() {},
      async setEntry() {},
      async setResource() {},
      async getEntry() {
        return undefined;
      },
      async bulkGetEntries() {
        return new Map();
      },
      async delete() {},
      async probe() {},
      async close() {},
      async clearAll() {},
    };

    const platform = {
      capabilities: {
        adcp_version: '3.0.0',
        specialisms: ['sales-non-guaranteed'],
        pricingModels: ['cpm'],
        channels: ['display'],
        formats: [{ format_id: 'display_300x250' }],
        idempotency: { replay_ttl_seconds: 86400 },
      },
      accounts: {
        resolution: 'derived',
        resolve: async () => ({ id: 'pub_main', operator: 'mypub', ctx_metadata: {} }),
        upsert: async () => ({ ok: true, items: [] }),
        list: async () => ({ items: [], nextCursor: null }),
      },
      sales: {
        getProducts: async (req, ctx) => {
          // Touch ctx.ctxMetadata so we can assert which store it routed to
          await ctx.ctxMetadata?.product('prod_x');
          return { products: [] };
        },
        createMediaBuy: async () => ({ media_buy_id: 'mb_1', status: 'active', packages: [] }),
        updateMediaBuy: async () => ({ media_buy_id: 'mb_1', status: 'active', packages: [] }),
        getMediaBuyDelivery: async () => ({ deliveries: [] }),
        getMediaBuys: async () => ({ media_buys: [] }),
      },
    };

    const server = createAdcpServerFromPlatform(platform, {
      name: 'override-test',
      version: '1.0.0',
      pool: mockPool,
      ctxMetadata: explicitCtxMetadata, // explicit wins
      validation: { requests: 'off', responses: 'off' },
    });

    await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_products', arguments: { brief: 'b', promoted_offering: 'o' } },
    });

    assert.equal(explicitCtxMetadataAccessed, true, 'explicit ctxMetadata should be used, not pool-derived default');
  });
});
