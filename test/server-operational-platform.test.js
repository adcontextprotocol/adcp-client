// Tests for #1530 — OperationalPlatform interface.
//
// `OperationalPlatform` is the named contract for in-process consumers
// (pollers, scheduled jobs, storefront fan-out paths) that don't carry
// an MCP request. Distinct from `DecisioningPlatform` (buyer-facing
// MCP dispatch with `RequestContext`).
//
// The interface is type-shaped — there's no runtime dispatcher to test.
// `defineOperationalPlatform` is a type-level identity helper, so its
// behavioral contract is "returns the input unchanged." Most of the
// value lives in the type system; these tests pin the runtime
// guarantees and the public-surface shape.

process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { defineOperationalPlatform } = require('../dist/lib/server/operational-platform');
const { AdcpError } = require('../dist/lib/server/decisioning/async-outcome');

describe('defineOperationalPlatform', () => {
  it('returns the input platform object unchanged', () => {
    const ops = {
      platformId: 'test',
      extractContext: async () => ({ accessToken: undefined }),
      updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      getMediaBuyDelivery: async () => ({
        reporting_period: { start: '2026-05-01T00:00:00Z', end: '2026-05-02T00:00:00Z' },
        media_buy_deliveries: [],
      }),
    };
    const result = defineOperationalPlatform(ops);
    assert.strictEqual(result, ops, 'identity helper must not clone or wrap');
  });

  it('preserves optional methods when present', async () => {
    const platformData = { ad_account_id: 'act_123' };
    const ops = defineOperationalPlatform({
      platformId: 'test',
      extractContext: async () => ({ accessToken: 'tok' }),
      updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      getMediaBuyDelivery: async () => ({
        reporting_period: { start: '2026-05-01T00:00:00Z', end: '2026-05-02T00:00:00Z' },
        media_buy_deliveries: [],
      }),
      pollAudienceStatuses: async data => {
        const m = new Map();
        m.set(String(data.ad_account_id), 'active');
        return m;
      },
      getProducts: async () => ({ products: [] }),
    });
    assert.strictEqual(typeof ops.pollAudienceStatuses, 'function');
    assert.strictEqual(typeof ops.getProducts, 'function');
    assert.deepStrictEqual(
      [...(await ops.pollAudienceStatuses(platformData, 'tok')).entries()],
      [['act_123', 'active']]
    );
  });

  it('platforms without optional methods omit them entirely (not undefined-stub)', () => {
    const ops = defineOperationalPlatform({
      platformId: 'test',
      extractContext: async () => ({ accessToken: 'tok' }),
      updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      getMediaBuyDelivery: async () => ({
        reporting_period: { start: '2026-05-01T00:00:00Z', end: '2026-05-02T00:00:00Z' },
        media_buy_deliveries: [],
      }),
    });
    assert.strictEqual('pollAudienceStatuses' in ops, false);
    assert.strictEqual('getProducts' in ops, false);
  });
});

describe('OperationalPlatform — error contract', () => {
  it('extractContext throws AdcpError(AUTH_REQUIRED) when token absent and requireAuth=true', async () => {
    const ops = defineOperationalPlatform({
      platformId: 'test',
      extractContext: async (_args, sessionToken, requireAuth = true) => {
        if (!sessionToken && requireAuth) {
          throw new AdcpError('AUTH_REQUIRED', { message: 'No token available' });
        }
        return { accessToken: sessionToken };
      },
      updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      getMediaBuyDelivery: async () => ({
        reporting_period: { start: '2026-05-01T00:00:00Z', end: '2026-05-02T00:00:00Z' },
        media_buy_deliveries: [],
      }),
    });

    await assert.rejects(
      () => ops.extractContext({}, undefined, true),
      err => err instanceof AdcpError && err.code === 'AUTH_REQUIRED'
    );
  });

  it('extractContext returns no-token context when requireAuth=false', async () => {
    const ops = defineOperationalPlatform({
      platformId: 'test',
      extractContext: async (_args, sessionToken, requireAuth = true) => {
        if (!sessionToken && requireAuth) {
          throw new AdcpError('AUTH_REQUIRED', { message: 'No token available' });
        }
        return { accessToken: sessionToken };
      },
      updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      getMediaBuyDelivery: async () => ({
        reporting_period: { start: '2026-05-01T00:00:00Z', end: '2026-05-02T00:00:00Z' },
        media_buy_deliveries: [],
      }),
    });

    const ctx = await ops.extractContext({}, undefined, false);
    assert.strictEqual(ctx.accessToken, undefined);
  });

  it('updateMediaBuy throws AdcpError on structured rejection (matches DecisioningPlatform convention)', async () => {
    const ops = defineOperationalPlatform({
      platformId: 'test',
      extractContext: async () => ({ accessToken: 'tok' }),
      updateMediaBuy: async () => {
        throw new AdcpError('NOT_CANCELLABLE', {
          message: 'Media buy cannot be canceled in its current state',
        });
      },
      getMediaBuyDelivery: async () => ({
        reporting_period: { start: '2026-05-01T00:00:00Z', end: '2026-05-02T00:00:00Z' },
        media_buy_deliveries: [],
      }),
    });

    await assert.rejects(
      () =>
        ops.updateMediaBuy({ accessToken: 'tok' }, { media_buy_id: 'mb_1', canceled: true, idempotency_key: 'uuid-1' }),
      err => err instanceof AdcpError && err.code === 'NOT_CANCELLABLE'
    );
  });
});

describe('OperationalPlatform — three call patterns of extractContext', () => {
  // The shim-derived `extractContext(args, sessionToken?, requireAuth?)`
  // serves three distinct patterns. These tests exercise each so the
  // contract is locked in before the post-migration split into
  // `synthesizeFromToken` / `synthesizeFromArgs`.

  function buildOps(impl) {
    return defineOperationalPlatform({
      platformId: 'test',
      extractContext: impl,
      updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      getMediaBuyDelivery: async () => ({
        reporting_period: { start: '2026-05-01T00:00:00Z', end: '2026-05-02T00:00:00Z' },
        media_buy_deliveries: [],
      }),
    });
  }

  it('poller path — empty args, sessionToken provided', async () => {
    const ops = buildOps(async (args, sessionToken) => {
      assert.deepStrictEqual(args, {}, 'poller passes empty args');
      assert.strictEqual(sessionToken, 'stored-token');
      return { accessToken: sessionToken };
    });
    const ctx = await ops.extractContext({}, 'stored-token');
    assert.strictEqual(ctx.accessToken, 'stored-token');
  });

  it('storefront fan-out — scrubbed args, optional master token', async () => {
    const ops = buildOps(async (args, sessionToken) => ({
      accessToken: sessionToken ?? String(args.context?.managed_access_token ?? ''),
    }));
    const ctx = await ops.extractContext({ context: { managed_access_token: 'storefront-creds' } }, undefined);
    assert.strictEqual(ctx.accessToken, 'storefront-creds');
  });

  it('server-side scan — no args, no token, requireAuth=false', async () => {
    const ops = buildOps(async (_args, sessionToken, requireAuth = true) => {
      assert.strictEqual(requireAuth, false);
      return { accessToken: sessionToken };
    });
    const ctx = await ops.extractContext({}, undefined, false);
    assert.strictEqual(ctx.accessToken, undefined);
  });
});
