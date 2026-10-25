// Tests for `src/lib/server/state-machine.ts` — the canonical lifecycle
// graphs and `assert*Transition` helpers exposed for production sellers.
//
// The same maps back the storyboard runner's `status.monotonic` invariant,
// so these tests double as a guard against drift between SDK-blessed
// runtime enforcement and conformance-runner enforcement.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const sdk = require('../../dist/lib/server/index.js');

describe('server/state-machine exports', () => {
  test('all lifecycle surface members are exported', () => {
    assert.ok(sdk.MEDIA_BUY_TRANSITIONS instanceof Map, 'MEDIA_BUY_TRANSITIONS is a Map');
    assert.ok(sdk.CREATIVE_ASSET_TRANSITIONS instanceof Map, 'CREATIVE_ASSET_TRANSITIONS is a Map');
    assert.strictEqual(typeof sdk.isLegalMediaBuyTransition, 'function');
    assert.strictEqual(typeof sdk.isLegalCreativeTransition, 'function');
    assert.strictEqual(typeof sdk.assertMediaBuyTransition, 'function');
    assert.strictEqual(typeof sdk.assertCreativeTransition, 'function');
    assert.strictEqual(typeof sdk.getMediaBuyTransitions, 'function');
    assert.strictEqual(require('../../dist/lib/index.js').getMediaBuyTransitions, sdk.getMediaBuyTransitions);
  });

  test('terminals are correctly declared with no outbound edges', () => {
    const { MEDIA_BUY_TRANSITIONS } = sdk;
    assert.strictEqual(MEDIA_BUY_TRANSITIONS.get('canceled').size, 0, 'canceled is terminal');
    assert.strictEqual(MEDIA_BUY_TRANSITIONS.get('completed').size, 0, 'completed is terminal');
    assert.strictEqual(MEDIA_BUY_TRANSITIONS.get('rejected').size, 0, 'rejected is terminal');
  });

  test('isLegalMediaBuyTransition tolerates non-enum string inputs', () => {
    // Confirms the `?? false` branch — predicate must not throw on
    // unexpected upstream status strings.
    assert.strictEqual(sdk.isLegalMediaBuyTransition('garbage', 'active'), false);
    assert.strictEqual(sdk.isLegalMediaBuyTransition('active', 'garbage'), false);
  });
});

describe('isLegalMediaBuyTransition', () => {
  const { isLegalMediaBuyTransition } = sdk;

  test('legal forward edges return true', () => {
    assert.strictEqual(isLegalMediaBuyTransition('pending_creatives', 'pending_start'), true);
    assert.strictEqual(isLegalMediaBuyTransition('pending_start', 'active'), true);
    assert.strictEqual(isLegalMediaBuyTransition('active', 'paused'), true);
    assert.strictEqual(isLegalMediaBuyTransition('paused', 'active'), true);
    assert.strictEqual(isLegalMediaBuyTransition('active', 'completed'), true);
    assert.strictEqual(isLegalMediaBuyTransition('active', 'canceled'), true);
  });

  test('terminal-state escapes return false', () => {
    assert.strictEqual(isLegalMediaBuyTransition('canceled', 'active'), false);
    assert.strictEqual(isLegalMediaBuyTransition('completed', 'active'), false);
    assert.strictEqual(isLegalMediaBuyTransition('rejected', 'pending_creatives'), false);
  });

  test('self-edges return false (including terminals)', () => {
    assert.strictEqual(isLegalMediaBuyTransition('active', 'active'), false);
    assert.strictEqual(isLegalMediaBuyTransition('canceled', 'canceled'), false);
  });
});

describe('media-buy creative review transitions by AdCP version', () => {
  const { getMediaBuyTransitions, isLegalMediaBuyTransition, assertMediaBuyTransition } = sdk;

  test('the exported default graph and omitted version follow the SDK protocol pin', () => {
    assert.strictEqual(getMediaBuyTransitions(), sdk.MEDIA_BUY_TRANSITIONS);
    assert.strictEqual(
      isLegalMediaBuyTransition('pending_start', 'pending_creatives'),
      sdk.MEDIA_BUY_TRANSITIONS.get('pending_start').has('pending_creatives')
    );
  });

  for (const version of ['3.3-beta', '3.3-beta.0', '3.3.0-beta.0', '3.3-rc.1', '3.3', '3.3.0', '3.4.0']) {
    test(`${version}: review rejection can introduce buyer work before activation`, () => {
      assert.strictEqual(getMediaBuyTransitions(version).get('pending_start').has('pending_creatives'), true);
      assert.strictEqual(isLegalMediaBuyTransition('pending_start', 'pending_creatives', version), true);
      assert.doesNotThrow(() => assertMediaBuyTransition('pending_start', 'pending_creatives', version));
      assert.strictEqual(isLegalMediaBuyTransition('pending_creatives', 'pending_start', version), true);
    });
  }

  for (const version of ['3.0', '3.1.29', '3.2', '3.2.7', '3.3.0-alpha.1', 'invalid', 'latest']) {
    test(`${version}: the 3.3 review cycle is not enabled`, () => {
      assert.strictEqual(isLegalMediaBuyTransition('pending_start', 'pending_creatives', version), false);
      assert.throws(() => assertMediaBuyTransition('pending_start', 'pending_creatives', version), {
        code: 'INVALID_STATE',
        field: 'status',
      });
    });
  }

  for (const version of ['3.2.7', '3.3-beta.0', '3.3']) {
    test(`${version}: activation and terminal protections remain intact`, () => {
      for (const from of ['active', 'paused', 'completed', 'rejected', 'canceled']) {
        for (const to of ['pending_start', 'pending_creatives']) {
          assert.strictEqual(isLegalMediaBuyTransition(from, to, version), false, `${from} -> ${to}`);
          assert.throws(() => assertMediaBuyTransition(from, to, version), { code: 'INVALID_STATE' });
        }
      }
      for (const terminal of ['completed', 'rejected', 'canceled']) {
        assert.strictEqual(getMediaBuyTransitions(version).get(terminal).size, 0);
        assert.throws(() => assertMediaBuyTransition(terminal, 'canceled', version), { code: 'NOT_CANCELLABLE' });
      }
    });
  }

  test('selecting a candidate graph does not change older graphs', () => {
    const stable = getMediaBuyTransitions('3.2');
    const candidate = getMediaBuyTransitions('3.3-beta.0');
    assert.notStrictEqual(stable, candidate);
    assert.strictEqual(stable.get('pending_start').has('pending_creatives'), false);
  });
});

describe('assertMediaBuyTransition', () => {
  const { assertMediaBuyTransition } = sdk;

  test('legal transition does not throw', () => {
    assert.doesNotThrow(() => assertMediaBuyTransition('active', 'completed'));
  });

  test('canceled → canceled throws NOT_CANCELLABLE (cancel-idempotency path)', () => {
    let caught;
    try {
      assertMediaBuyTransition('canceled', 'canceled');
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'expected to throw');
    assert.strictEqual(caught.code, 'NOT_CANCELLABLE');
    assert.strictEqual(caught.recovery, 'correctable');
    assert.strictEqual(caught.field, 'status');
  });

  test('completed → canceled throws NOT_CANCELLABLE (cancel-from-terminal)', () => {
    // Per compliance/cache/<version>/protocols/media-buy/state-machine.yaml:
    // "The cancellation-specific code takes precedence over INVALID_STATE
    // when the attempted action is cancel."
    let caught;
    try {
      assertMediaBuyTransition('completed', 'canceled');
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'expected to throw');
    assert.strictEqual(caught.code, 'NOT_CANCELLABLE');
  });

  test('rejected → canceled throws NOT_CANCELLABLE (cancel-from-terminal)', () => {
    let caught;
    try {
      assertMediaBuyTransition('rejected', 'canceled');
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'expected to throw');
    assert.strictEqual(caught.code, 'NOT_CANCELLABLE');
  });

  test('canceled → paused (terminal escape, NOT cancel-attempt) throws INVALID_STATE', () => {
    // Storyboard prose specifically reserves NOT_CANCELLABLE for the
    // double-cancel idempotency case. Other illegal moves out of `canceled`
    // are normal terminal-state escapes — INVALID_STATE.
    let caught;
    try {
      assertMediaBuyTransition('canceled', 'paused');
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'expected to throw');
    assert.strictEqual(caught.code, 'INVALID_STATE');
    assert.strictEqual(caught.recovery, 'correctable');
  });

  test('completed → active throws INVALID_STATE', () => {
    let caught;
    try {
      assertMediaBuyTransition('completed', 'active');
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'expected to throw');
    assert.strictEqual(caught.code, 'INVALID_STATE');
  });

  test('error message includes both states for diagnostics', () => {
    let caught;
    try {
      assertMediaBuyTransition('completed', 'paused');
    } catch (err) {
      caught = err;
    }
    assert.match(caught.message, /completed/);
    assert.match(caught.message, /paused/);
  });
});

describe('isLegalCreativeTransition', () => {
  const { isLegalCreativeTransition } = sdk;

  test('processing has no direct edge to approved (must route via pending_review)', () => {
    assert.strictEqual(isLegalCreativeTransition('processing', 'pending_review'), true);
    assert.strictEqual(isLegalCreativeTransition('processing', 'approved'), false);
  });

  test('rejected → processing | pending_review (re-sync path)', () => {
    assert.strictEqual(isLegalCreativeTransition('rejected', 'processing'), true);
    assert.strictEqual(isLegalCreativeTransition('rejected', 'pending_review'), true);
  });

  test('approved ↔ archived is reversible', () => {
    assert.strictEqual(isLegalCreativeTransition('approved', 'archived'), true);
    assert.strictEqual(isLegalCreativeTransition('archived', 'approved'), true);
  });

  test('self-edges return false', () => {
    assert.strictEqual(isLegalCreativeTransition('approved', 'approved'), false);
  });
});

describe('assertCreativeTransition', () => {
  const { assertCreativeTransition } = sdk;

  test('legal transition does not throw', () => {
    assert.doesNotThrow(() => assertCreativeTransition('pending_review', 'approved'));
  });

  test('illegal transition throws INVALID_STATE (no creative analogue to NOT_CANCELLABLE)', () => {
    let caught;
    try {
      assertCreativeTransition('processing', 'approved');
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'expected to throw');
    assert.strictEqual(caught.code, 'INVALID_STATE');
    assert.strictEqual(caught.field, 'status');
  });
});
