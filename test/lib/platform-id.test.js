// AdCP 3.3 platform_id / seller_id dual emission: pure helpers.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  platformIdOf,
  withDualPlatformIds,
  withSellerIdOnly,
  addDualPlatformIdsInPlace,
  findPlatformIdMismatch,
  assertPlatformIdsAgree,
  PlatformIdMismatchError,
  projectPlatformIdsForRelease,
  releaseCarriesPlatformId,
  toolHasPlatformIdRows,
} = require('../../dist/lib/utils/platform-id.js');

describe('platformIdOf', () => {
  it('prefers platform_id over seller_id', () => {
    assert.strictEqual(platformIdOf({ platform_id: 'p', seller_id: 's' }), 'p');
    assert.strictEqual(platformIdOf({ platform_id: 'p' }), 'p');
  });
  it('falls back to seller_id when platform_id is absent', () => {
    assert.strictEqual(platformIdOf({ seller_id: 's' }), 's');
  });
  it('returns undefined with neither name, or for null/non-object input', () => {
    assert.strictEqual(platformIdOf({ audience_id: 'a' }), undefined);
    assert.strictEqual(platformIdOf(null), undefined);
    assert.strictEqual(platformIdOf(undefined), undefined);
    assert.strictEqual(platformIdOf('p'), undefined);
    assert.strictEqual(platformIdOf(7), undefined);
  });
});

describe('toolHasPlatformIdRows', () => {
  it('is true only for sync_audiences and sync_event_sources', () => {
    assert.strictEqual(toolHasPlatformIdRows('sync_audiences'), true);
    assert.strictEqual(toolHasPlatformIdRows('sync_event_sources'), true);
    assert.strictEqual(toolHasPlatformIdRows('get_products'), false);
    assert.strictEqual(toolHasPlatformIdRows('toString'), false);
    assert.strictEqual(toolHasPlatformIdRows(undefined), false);
  });
});

describe('withDualPlatformIds', () => {
  it('adds the missing name on audiences and event_sources rows', () => {
    const out = withDualPlatformIds({
      audiences: [
        { audience_id: 'a', platform_id: 'p' },
        { audience_id: 'b', seller_id: 's' },
      ],
      event_sources: [{ event_source_id: 'e', seller_id: 'x' }],
      other: 1,
    });
    assert.deepStrictEqual(out.audiences, [
      { audience_id: 'a', platform_id: 'p', seller_id: 'p' },
      { audience_id: 'b', platform_id: 's', seller_id: 's' },
    ]);
    assert.deepStrictEqual(out.event_sources, [{ event_source_id: 'e', seller_id: 'x', platform_id: 'x' }]);
    assert.strictEqual(out.other, 1);
  });
  it('keeps reference identity when nothing changes', () => {
    const both = { audiences: [{ audience_id: 'a', platform_id: 'p', seller_id: 'p' }] };
    assert.strictEqual(withDualPlatformIds(both), both);
    const neither = { audiences: [{ audience_id: 'a' }] };
    assert.strictEqual(withDualPlatformIds(neither), neither);
    const noArrays = { foo: [] };
    assert.strictEqual(withDualPlatformIds(noArrays), noArrays);
  });
  it('leaves non-object rows, missing arrays and non-object results alone', () => {
    const result = { audiences: ['str', null, { audience_id: 'a', platform_id: 'p' }] };
    const out = withDualPlatformIds(result);
    assert.strictEqual(out.audiences[0], 'str');
    assert.strictEqual(out.audiences[1], null);
    assert.strictEqual(out.audiences[2].seller_id, 'p');
    assert.strictEqual(withDualPlatformIds(null), null);
    assert.strictEqual(withDualPlatformIds('x'), 'x');
    const arr = [];
    assert.strictEqual(withDualPlatformIds(arr), arr);
  });
  it('does not mutate its input and only copies changed arrays', () => {
    const untouched = [{ audience_id: 'z' }];
    const input = { audiences: [{ audience_id: 'a', platform_id: 'p' }], event_sources: untouched };
    const out = withDualPlatformIds(input);
    assert.strictEqual(input.audiences[0].seller_id, undefined);
    assert.notStrictEqual(out, input);
    assert.strictEqual(out.event_sources, untouched);
  });
  it('is idempotent', () => {
    const once = withDualPlatformIds({ audiences: [{ platform_id: 'p' }] });
    assert.strictEqual(withDualPlatformIds(once), once);
  });
  it('leaves mismatched rows untouched', () => {
    const input = { audiences: [{ platform_id: 'p', seller_id: 's' }] };
    assert.strictEqual(withDualPlatformIds(input), input);
  });
});

describe('withSellerIdOnly', () => {
  it('drops platform_id and carries it as seller_id', () => {
    const out = withSellerIdOnly({
      audiences: [
        { audience_id: 'a', platform_id: 'p' },
        { audience_id: 'b', platform_id: 'q', seller_id: 'q' },
      ],
    });
    assert.deepStrictEqual(out.audiences, [
      { audience_id: 'a', seller_id: 'p' },
      { audience_id: 'b', seller_id: 'q' },
    ]);
  });
  it('keeps reference identity for seller_id-only rows and rows with neither name', () => {
    const a = { audiences: [{ audience_id: 'a', seller_id: 's' }, { audience_id: 'b' }] };
    assert.strictEqual(withSellerIdOnly(a), a);
    assert.strictEqual(withSellerIdOnly(null), null);
  });
  it('leaves mismatched rows untouched', () => {
    const input = { event_sources: [{ platform_id: 'p', seller_id: 's' }] };
    assert.strictEqual(withSellerIdOnly(input), input);
  });
});

describe('addDualPlatformIdsInPlace', () => {
  it('mutates single-name rows and leaves the rest', () => {
    const result = {
      audiences: [
        { platform_id: 'p' },
        { seller_id: 's' },
        { platform_id: 'a', seller_id: 'b' },
        { audience_id: 'n' },
        'x',
      ],
    };
    addDualPlatformIdsInPlace(result);
    assert.deepStrictEqual(result.audiences, [
      { platform_id: 'p', seller_id: 'p' },
      { seller_id: 's', platform_id: 's' },
      { platform_id: 'a', seller_id: 'b' },
      { audience_id: 'n' },
      'x',
    ]);
  });
  it('tolerates non-object results and missing arrays', () => {
    addDualPlatformIdsInPlace(null);
    addDualPlatformIdsInPlace('x');
    const r = { audiences: 'nope' };
    addDualPlatformIdsInPlace(r);
    assert.deepStrictEqual(r, { audiences: 'nope' });
  });
});

describe('findPlatformIdMismatch / assertPlatformIdsAgree', () => {
  it('reports the first differing row with a JSON pointer', () => {
    const mismatch = findPlatformIdMismatch({
      audiences: [
        { platform_id: 'p', seller_id: 'p' },
        { platform_id: 'a', seller_id: 'b' },
      ],
    });
    assert.deepStrictEqual(mismatch, { pointer: '/audiences/1', platform_id: 'a', seller_id: 'b' });
    assert.strictEqual(
      findPlatformIdMismatch({ event_sources: [{ platform_id: 'a', seller_id: 'b' }] }).pointer,
      '/event_sources/0'
    );
  });
  it('returns undefined for agreeing, single-name, empty and malformed results', () => {
    assert.strictEqual(
      findPlatformIdMismatch({ audiences: [{ platform_id: 'p', seller_id: 'p' }, { seller_id: 's' }, {}] }),
      undefined
    );
    assert.strictEqual(findPlatformIdMismatch({}), undefined);
    assert.strictEqual(findPlatformIdMismatch(null), undefined);
    assert.strictEqual(findPlatformIdMismatch({ audiences: [null, 'x'] }), undefined);
  });
  it('assert throws PlatformIdMismatchError carrying the mismatch', () => {
    assert.doesNotThrow(() => assertPlatformIdsAgree({ audiences: [{ platform_id: 'p' }] }));
    assert.throws(
      () => assertPlatformIdsAgree({ audiences: [{ platform_id: 'a', seller_id: 'b' }] }),
      err =>
        err instanceof PlatformIdMismatchError &&
        err.mismatch.pointer === '/audiences/0' &&
        /identical/.test(err.message)
    );
  });
});

describe('releaseCarriesPlatformId / projectPlatformIdsForRelease', () => {
  const carries = ['3.3-rc.3', '3.3.0-rc.3', '3.3', '3.3.1', 'v3.3', '4.0'];
  const lacks = ['3.2', '3.2.8', '3.0', '3.2-beta.5', 'garbage', ''];
  for (const r of carries) {
    it(`${r} carries both names`, () => {
      assert.strictEqual(releaseCarriesPlatformId(r), true);
      const out = projectPlatformIdsForRelease({ audiences: [{ platform_id: 'p' }] }, r);
      assert.deepStrictEqual(out.audiences[0], { platform_id: 'p', seller_id: 'p' });
    });
  }
  for (const r of lacks) {
    it(`${JSON.stringify(r)} carries seller_id only`, () => {
      assert.strictEqual(releaseCarriesPlatformId(r), false);
      const out = projectPlatformIdsForRelease({ audiences: [{ platform_id: 'p', seller_id: 'p' }] }, r);
      assert.deepStrictEqual(out.audiences[0], { seller_id: 'p' });
    });
  }
  it('preserves reference identity when the projection is a no-op', () => {
    const both = { audiences: [{ platform_id: 'p', seller_id: 'p' }] };
    assert.strictEqual(projectPlatformIdsForRelease(both, '3.3-rc.3'), both);
    const seller = { audiences: [{ seller_id: 's' }] };
    assert.strictEqual(projectPlatformIdsForRelease(seller, '3.2'), seller);
  });
});
