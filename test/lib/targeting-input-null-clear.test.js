const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { applyTargetingInput, hasTargetingClears, resolveTargetingInput } = require('../../dist/lib/index.js');
const { createMediaBuyStore, InMemoryStateStore } = require('../../dist/lib/server/index.js');

const PROPERTY_LIST = { list_id: 'pl_1' };
const COLLECTION_LIST = { list_id: 'cl_1' };

// AdCP 3.2 / DR-0020. `null` on a targeting dimension is a *command* — suppress
// a default on create, clear stored state on update — and never targeting state
// itself. Discovery criteria, accepted commercial snapshots, mutation responses,
// and package readback all use the strict overlay and MUST NOT contain null.
describe('request-only Targeting Input projection (DR-0020)', () => {
  test('resolveTargetingInput drops clear commands and keeps replacements', () => {
    assert.deepEqual(
      resolveTargetingInput({ geo_countries: ['US'], audience_include: null, property_list: PROPERTY_LIST }),
      { geo_countries: ['US'], property_list: PROPERTY_LIST }
    );
  });

  test('resolveTargetingInput yields undefined rather than an empty overlay', () => {
    // A cleared dimension is *absent* from effective readback. Returning `{}`
    // would put an empty object on the wire where the seller should simply
    // omit targeting_overlay.
    assert.equal(resolveTargetingInput({ geo_countries: null }), undefined);
    assert.equal(resolveTargetingInput({}), undefined);
    assert.equal(resolveTargetingInput(null), undefined);
    assert.equal(resolveTargetingInput(undefined), undefined);
  });

  test('applyTargetingInput implements all three per-dimension states', () => {
    const prior = { geo_countries: ['US'], property_list: PROPERTY_LIST, collection_list: COLLECTION_LIST };

    // omitted → preserve; null → clear; value → replace. All in one patch.
    assert.deepEqual(applyTargetingInput(prior, { property_list: null, geo_countries: ['CA'] }), {
      geo_countries: ['CA'],
      collection_list: COLLECTION_LIST,
    });
  });

  test('applyTargetingInput distinguishes an absent patch from a whole-overlay clear', () => {
    const prior = { geo_countries: ['US'] };
    assert.deepEqual(applyTargetingInput(prior, undefined), prior, 'undefined leaves stored state untouched');
    assert.equal(applyTargetingInput(prior, null), undefined, 'null clears the whole overlay');
  });

  test('applyTargetingInput never lets an explicit undefined erase a prior dimension', () => {
    // JSON round-trips drop undefined, but an in-process caller can still spell
    // it. Only `null` is the clear command; `undefined` means "not mentioned".
    assert.deepEqual(applyTargetingInput({ geo_countries: ['US'] }, { geo_countries: undefined }), {
      geo_countries: ['US'],
    });
  });

  test('hasTargetingClears reports whether a patch carries any command', () => {
    assert.equal(hasTargetingClears({ geo_countries: ['US'] }), false);
    assert.equal(hasTargetingClears({ geo_countries: null }), true);
    assert.equal(hasTargetingClears(null), true);
    assert.equal(hasTargetingClears(undefined), false);
  });
});

describe('createMediaBuyStore never persists a clear command', () => {
  const setup = () => ({ store: createMediaBuyStore({ store: new InMemoryStateStore() }) });
  const readBack = (store, accountId = 'acct_a', packageIds = ['seller_pkg_001']) =>
    store.backfill(accountId, {
      media_buys: [{ media_buy_id: 'mb_1', packages: packageIds.map(package_id => ({ package_id })) }],
    });

  test('persistFromCreate resolves request nulls away when the seller does not echo an overlay', async () => {
    const { store } = setup();
    // No `targeting_overlay` on the response package, so the store falls back
    // to the request — which is a Targeting *Input* and may carry commands.
    await store.persistFromCreate(
      'acct_a',
      { packages: [{ buyer_ref: 'pkg_a', targeting_overlay: { property_list: PROPERTY_LIST, geo_countries: null } }] },
      { media_buy_id: 'mb_1', packages: [{ package_id: 'seller_pkg_001', buyer_ref: 'pkg_a' }] }
    );

    const overlay = (await readBack(store)).media_buys[0].packages[0].targeting_overlay;
    assert.deepEqual(overlay, { property_list: PROPERTY_LIST });
    assert.equal(hasTargetingClears(overlay), false, 'a clear command must not reach get_media_buys readback');
  });

  test('persistFromCreate tracks nothing when every requested dimension is a clear', async () => {
    const { store } = setup();
    await store.persistFromCreate(
      'acct_a',
      { packages: [{ buyer_ref: 'pkg_a', targeting_overlay: { geo_countries: null } }] },
      { media_buy_id: 'mb_1', packages: [{ package_id: 'seller_pkg_001', buyer_ref: 'pkg_a' }] }
    );

    assert.equal((await readBack(store)).media_buys[0].packages[0].targeting_overlay, undefined);
  });

  test('mergeFromUpdate drops the tracked overlay once its last dimension is cleared', async () => {
    const { store } = setup();
    await store.persistFromCreate(
      'acct_a',
      { packages: [{ buyer_ref: 'pkg_a', targeting_overlay: { property_list: PROPERTY_LIST } }] },
      { media_buy_id: 'mb_1', packages: [{ package_id: 'seller_pkg_001', buyer_ref: 'pkg_a' }] }
    );

    await store.mergeFromUpdate('acct_a', 'mb_1', {
      packages: [{ package_id: 'seller_pkg_001', targeting_overlay: { property_list: null } }],
    });

    // Not `{}` — an overlay with no surviving dimensions is omitted entirely.
    assert.equal((await readBack(store)).media_buys[0].packages[0].targeting_overlay, undefined);
  });

  test('mergeFromUpdate new_packages resolves clears rather than persisting them', async () => {
    const { store } = setup();
    await store.persistFromCreate(
      'acct_a',
      { packages: [{ buyer_ref: 'pkg_a', targeting_overlay: { property_list: PROPERTY_LIST } }] },
      { media_buy_id: 'mb_1', packages: [{ package_id: 'seller_pkg_001', buyer_ref: 'pkg_a' }] }
    );

    await store.mergeFromUpdate('acct_a', 'mb_1', {
      new_packages: [
        {
          package_id: 'seller_pkg_002',
          buyer_ref: 'pkg_b',
          // A brand-new package has no stored state, so `null` here suppresses a
          // product default. Either way it must not become durable state.
          targeting_overlay: { collection_list: COLLECTION_LIST, geo_countries: null },
        },
      ],
    });

    const packages = (await readBack(store, 'acct_a', ['seller_pkg_001', 'seller_pkg_002'])).media_buys[0].packages;
    assert.deepEqual(packages[1].targeting_overlay, { collection_list: COLLECTION_LIST });
    assert.equal(hasTargetingClears(packages[1].targeting_overlay), false);
  });
});
