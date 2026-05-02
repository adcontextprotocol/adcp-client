// Tests for #1314 — composeMethod for wrapping platform methods with
// before/after hooks (short-circuit + enrichment patterns).

process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { composeMethod } = require('../dist/lib/server/decisioning/compose');

describe('composeMethod (#1314)', () => {
  it('passes through to inner when no hooks are supplied', async () => {
    const inner = async (params, ctx) => ({ value: params.x * 2, sawCtx: ctx.id });
    const wrapped = composeMethod(inner, {});
    const result = await wrapped({ x: 5 }, { id: 'ctx_1' });
    assert.deepStrictEqual(result, { value: 10, sawCtx: 'ctx_1' });
  });

  it('before hook short-circuits when it returns { shortCircuit: ... }', async () => {
    let innerCalled = false;
    const inner = async () => {
      innerCalled = true;
      return { from: 'inner' };
    };
    const wrapped = composeMethod(inner, {
      before: async () => ({ shortCircuit: { from: 'before' } }),
    });
    const result = await wrapped({}, {});
    assert.strictEqual(innerCalled, false, 'inner should not be invoked when before short-circuits');
    assert.deepStrictEqual(result, { from: 'before' });
  });

  it('before hook returning undefined falls through to inner', async () => {
    const inner = async params => ({ from: 'inner', x: params.x });
    const wrapped = composeMethod(inner, {
      before: async () => undefined,
    });
    const result = await wrapped({ x: 7 }, {});
    assert.deepStrictEqual(result, { from: 'inner', x: 7 });
  });

  it('before hook with an implicit no-return falls through to inner', async () => {
    const inner = async params => ({ from: 'inner', x: params.x });
    const wrapped = composeMethod(inner, {
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      before: async () => {},
    });
    const result = await wrapped({ x: 9 }, {});
    assert.deepStrictEqual(result, { from: 'inner', x: 9 });
  });

  it('after hook runs on the inner result and can transform it', async () => {
    const inner = async () => ({ products: [{ id: 'p1' }] });
    const wrapped = composeMethod(inner, {
      after: async result => ({ ...result, enriched: true }),
    });
    const result = await wrapped({}, {});
    assert.deepStrictEqual(result, { products: [{ id: 'p1' }], enriched: true });
  });

  it('after hook also runs on a before-short-circuit value', async () => {
    let innerCalled = false;
    const inner = async () => {
      innerCalled = true;
      return { from: 'inner' };
    };
    const wrapped = composeMethod(inner, {
      before: async () => ({ shortCircuit: { from: 'before' } }),
      after: async result => ({ ...result, enriched: true }),
    });
    const result = await wrapped({}, {});
    assert.strictEqual(innerCalled, false);
    assert.deepStrictEqual(result, { from: 'before', enriched: true });
  });

  it('after hook receives original params and ctx', async () => {
    const inner = async () => ({ count: 1 });
    let sawParams;
    let sawCtx;
    const wrapped = composeMethod(inner, {
      after: async (result, params, ctx) => {
        sawParams = params;
        sawCtx = ctx;
        return result;
      },
    });
    await wrapped({ filter: 'active' }, { account: { id: 'acc_1' } });
    assert.deepStrictEqual(sawParams, { filter: 'active' });
    assert.deepStrictEqual(sawCtx, { account: { id: 'acc_1' } });
  });

  it('throws eagerly at wrap time when inner is not a function', () => {
    assert.throws(() => composeMethod(undefined, {}), /must be a function, got undefined/);
    assert.throws(() => composeMethod(null, {}), /must be a function, got null/);
    assert.throws(() => composeMethod({}, {}), /must be a function, got object/);
    assert.throws(() => composeMethod('not-a-fn', {}), /Did you reference an optional method that wasn't implemented/);
  });

  it('short-circuit value can be `undefined` without ambiguity', async () => {
    // Adopter explicitly wants to short-circuit with undefined as the result.
    // Wrapping it as { shortCircuit: undefined } is unambiguous; a bare
    // `undefined` return would have been "fall through" — which is exactly
    // why the discriminated wrapper exists.
    let innerCalled = false;
    const inner = async () => {
      innerCalled = true;
      return 'inner-value';
    };
    const wrapped = composeMethod(inner, {
      before: async () => ({ shortCircuit: undefined }),
    });
    const result = await wrapped({}, {});
    assert.strictEqual(innerCalled, false);
    assert.strictEqual(result, undefined);
  });

  it('composes for a realistic short-circuit + enrichment shape', async () => {
    // Mirror the scope3data/agentic-adapters#237 deferred-gap shape:
    // price-optimization short-circuit + carbon enrichment on
    // getMediaBuyDelivery.
    const baseGetDelivery = async params => ({
      media_buys: [{ media_buy_id: params.media_buy_id, impressions: 100 }],
    });
    const cachedPriceOpt = { media_buys: [{ media_buy_id: 'cached', impressions: 0 }] };
    const enriched = composeMethod(baseGetDelivery, {
      before: async params => (params.optimization === 'price' ? { shortCircuit: cachedPriceOpt } : undefined),
      after: async result => ({
        ...result,
        ext: { carbon_grams_per_impression: 0.42 },
      }),
    });

    const priceResult = await enriched({ media_buy_id: 'mb_1', optimization: 'price' }, {});
    assert.deepStrictEqual(priceResult, {
      media_buys: [{ media_buy_id: 'cached', impressions: 0 }],
      ext: { carbon_grams_per_impression: 0.42 },
    });

    const normalResult = await enriched({ media_buy_id: 'mb_1' }, {});
    assert.deepStrictEqual(normalResult, {
      media_buys: [{ media_buy_id: 'mb_1', impressions: 100 }],
      ext: { carbon_grams_per_impression: 0.42 },
    });
  });
});
