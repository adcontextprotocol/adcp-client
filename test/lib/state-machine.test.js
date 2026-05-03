const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  MEDIA_BUY_TRANSITIONS,
  CREATIVE_ASSET_TRANSITIONS,
  isLegalMediaBuyTransition,
  assertMediaBuyTransition,
  isLegalCreativeTransition,
  assertCreativeTransition,
} = require('../../dist/lib/server/state-machine');

describe('isLegalMediaBuyTransition', () => {
  it('allows legal edges', () => {
    assert.strictEqual(isLegalMediaBuyTransition('active', 'paused'), true);
    assert.strictEqual(isLegalMediaBuyTransition('paused', 'active'), true);
    assert.strictEqual(isLegalMediaBuyTransition('active', 'canceled'), true);
    assert.strictEqual(isLegalMediaBuyTransition('pending_creatives', 'pending_start'), true);
    assert.strictEqual(isLegalMediaBuyTransition('pending_start', 'active'), true);
  });

  it('rejects illegal edges', () => {
    assert.strictEqual(isLegalMediaBuyTransition('completed', 'active'), false);
    assert.strictEqual(isLegalMediaBuyTransition('canceled', 'active'), false);
    assert.strictEqual(isLegalMediaBuyTransition('rejected', 'paused'), false);
    assert.strictEqual(isLegalMediaBuyTransition('active', 'pending_creatives'), false);
  });

  it('rejects self-transitions on terminal states', () => {
    assert.strictEqual(isLegalMediaBuyTransition('canceled', 'canceled'), false);
    assert.strictEqual(isLegalMediaBuyTransition('completed', 'completed'), false);
    assert.strictEqual(isLegalMediaBuyTransition('rejected', 'rejected'), false);
  });

  it('handles unknown status gracefully', () => {
    assert.strictEqual(isLegalMediaBuyTransition('unknown_status', 'active'), false);
  });
});

describe('assertMediaBuyTransition', () => {
  it('passes on legal transition', () => {
    assert.doesNotThrow(() => assertMediaBuyTransition('active', 'paused'));
    assert.doesNotThrow(() => assertMediaBuyTransition('pending_creatives', 'pending_start'));
  });

  it('throws NOT_CANCELLABLE for canceled → canceled', () => {
    try {
      assertMediaBuyTransition('canceled', 'canceled');
      assert.fail('should have thrown');
    } catch (err) {
      assert.strictEqual(err?.structuredContent?.adcp_error?.code, 'NOT_CANCELLABLE');
    }
  });

  it('throws NOT_CANCELLABLE with mediaBuyId in message when provided', () => {
    try {
      assertMediaBuyTransition('canceled', 'canceled', 'buy-123');
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err?.structuredContent?.adcp_error?.message?.includes('buy-123'), 'message should include mediaBuyId');
    }
  });

  it('throws INVALID_STATE for other illegal edges', () => {
    try {
      assertMediaBuyTransition('completed', 'active');
      assert.fail('should have thrown');
    } catch (err) {
      assert.strictEqual(err?.structuredContent?.adcp_error?.code, 'INVALID_STATE');
    }
  });

  it('throws INVALID_STATE for canceled → active (not NOT_CANCELLABLE)', () => {
    try {
      assertMediaBuyTransition('canceled', 'active');
      assert.fail('should have thrown');
    } catch (err) {
      assert.strictEqual(err?.structuredContent?.adcp_error?.code, 'INVALID_STATE');
    }
  });
});

describe('isLegalCreativeTransition', () => {
  it('allows spec-defined edges', () => {
    assert.strictEqual(isLegalCreativeTransition('processing', 'pending_review'), true);
    assert.strictEqual(isLegalCreativeTransition('pending_review', 'approved'), true);
    assert.strictEqual(isLegalCreativeTransition('approved', 'archived'), true);
    assert.strictEqual(isLegalCreativeTransition('archived', 'approved'), true);
    assert.strictEqual(isLegalCreativeTransition('rejected', 'processing'), true);
  });

  it('rejects edges absent from spec', () => {
    assert.strictEqual(isLegalCreativeTransition('processing', 'approved'), false);
    assert.strictEqual(isLegalCreativeTransition('pending_review', 'archived'), false);
    assert.strictEqual(isLegalCreativeTransition('archived', 'rejected'), false);
  });
});

describe('assertCreativeTransition', () => {
  it('passes on legal transition', () => {
    assert.doesNotThrow(() => assertCreativeTransition('processing', 'pending_review'));
    assert.doesNotThrow(() => assertCreativeTransition('rejected', 'processing'));
  });

  it('throws INVALID_STATE for illegal edge', () => {
    try {
      assertCreativeTransition('processing', 'approved');
      assert.fail('should have thrown');
    } catch (err) {
      assert.strictEqual(err?.structuredContent?.adcp_error?.code, 'INVALID_STATE');
    }
  });

  it('throws INVALID_STATE with creativeId in message when provided', () => {
    try {
      assertCreativeTransition('processing', 'approved', 'cr-42');
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err?.structuredContent?.adcp_error?.message?.includes('cr-42'), 'message should include creativeId');
    }
  });
});

describe('exported maps have correct types', () => {
  it('MEDIA_BUY_TRANSITIONS is a ReadonlyMap', () => {
    assert.ok(MEDIA_BUY_TRANSITIONS instanceof Map);
    assert.ok(MEDIA_BUY_TRANSITIONS.get('active') instanceof Set);
  });

  it('CREATIVE_ASSET_TRANSITIONS is a ReadonlyMap', () => {
    assert.ok(CREATIVE_ASSET_TRANSITIONS instanceof Map);
    assert.ok(CREATIVE_ASSET_TRANSITIONS.get('processing') instanceof Set);
  });
});
