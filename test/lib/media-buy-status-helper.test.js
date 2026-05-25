const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { getAuthoritativeMediaBuyStatus, isMediaBuyStatus } = require('../../dist/lib/index.js');

describe('media-buy status helpers', () => {
  test('prefers canonical media_buy_status over envelope status', () => {
    const status = getAuthoritativeMediaBuyStatus({
      status: 'completed',
      media_buy_status: 'paused',
    });

    assert.equal(status, 'paused');
  });

  test('falls back to legacy lifecycle status', () => {
    assert.equal(getAuthoritativeMediaBuyStatus({ status: 'pending_start' }), 'pending_start');
  });

  test('does not infer completed lifecycle status from explicit 3.1 envelope-only status', () => {
    assert.equal(
      getAuthoritativeMediaBuyStatus({
        adcp_version: '3.1',
        media_buy_id: 'mb_1',
        status: 'completed',
      }),
      undefined
    );
  });

  test('does not infer overlapping lifecycle statuses from explicit 3.1 envelope-only status', () => {
    for (const status of ['rejected', 'canceled']) {
      assert.equal(
        getAuthoritativeMediaBuyStatus({
          adcp_version: '3.1',
          media_buy_id: 'mb_1',
          status,
        }),
        undefined,
        status
      );
    }
  });

  test('allows completed lifecycle status when canonical media_buy_status is present', () => {
    assert.equal(
      getAuthoritativeMediaBuyStatus({
        adcp_version: '3.1',
        media_buy_id: 'mb_1',
        status: 'completed',
        media_buy_status: 'completed',
      }),
      'completed'
    );
  });

  test('allows overlapping lifecycle statuses when canonical media_buy_status is present', () => {
    for (const status of ['rejected', 'canceled']) {
      assert.equal(
        getAuthoritativeMediaBuyStatus({
          adcp_version: '3.1',
          media_buy_id: 'mb_1',
          status: 'completed',
          media_buy_status: status,
        }),
        status
      );
    }
  });

  test('ignores task-only statuses', () => {
    for (const status of ['working', 'submitted', 'failed', 'input-required']) {
      assert.equal(getAuthoritativeMediaBuyStatus({ status }), undefined, status);
    }
  });

  test('does not fall back when canonical status is present but invalid', () => {
    assert.equal(
      getAuthoritativeMediaBuyStatus({
        media_buy_status: 'not_a_lifecycle_status',
        status: 'active',
      }),
      undefined
    );
  });

  test('handles non-object inputs', () => {
    assert.equal(getAuthoritativeMediaBuyStatus(undefined), undefined);
    assert.equal(getAuthoritativeMediaBuyStatus(null), undefined);
    assert.equal(getAuthoritativeMediaBuyStatus('active'), undefined);
    assert.equal(getAuthoritativeMediaBuyStatus(['active']), undefined);
  });

  test('isMediaBuyStatus validates against the generated schema', () => {
    assert.equal(isMediaBuyStatus('active'), true);
    assert.equal(isMediaBuyStatus('submitted'), false);
  });
});
