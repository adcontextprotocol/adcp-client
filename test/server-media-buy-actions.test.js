const { test, describe } = require('node:test');
const assert = require('node:assert');

const { AdcpError, assertUpdateMediaBuyAllowed } = require('../dist/lib/server');

function buyWith(availableActions, overrides = {}) {
  return {
    media_buy_id: 'mb_1',
    status: 'active',
    end_time: '2026-06-01T00:00:00Z',
    packages: [{ package_id: 'pkg_1', budget: 1000, end_time: '2026-06-01T00:00:00Z' }],
    available_actions: availableActions,
    ...overrides,
  };
}

describe('assertUpdateMediaBuyAllowed', () => {
  test('returns enriched preflight result for allowed mutations', () => {
    const result = assertUpdateMediaBuyAllowed(
      buyWith([
        { action: 'extend_flight', mode: 'self_serve' },
        { action: 'increase_budget', mode: 'self_serve' },
      ]),
      {
        end_time: '2026-07-01T00:00:00Z',
        packages: [{ package_id: 'pkg_1', budget: 1500 }],
      }
    );

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(
      result.actions.map(a => a.action).sort(),
      ['extend_flight', 'increase_budget']
    );
    assert.deepStrictEqual(
      result.mutations.map(m => m.path).sort(),
      ['end_time', 'packages[0].budget']
    );
  });

  test('throws ACTION_NOT_ALLOWED with details for unavailable actions', () => {
    assert.throws(
      () =>
        assertUpdateMediaBuyAllowed(buyWith([{ action: 'pause', mode: 'self_serve' }]), {
          end_time: '2026-07-01T00:00:00Z',
        }),
      err => {
        assert.ok(err instanceof AdcpError);
        assert.strictEqual(err.code, 'ACTION_NOT_ALLOWED');
        assert.strictEqual(err.field, 'update_media_buy');
        assert.strictEqual(err.details.attempted_action, 'extend_flight');
        assert.strictEqual(err.details.reason, 'not_supported_on_buy');
        assert.deepStrictEqual(err.details.currently_available_actions, [{ action: 'pause', mode: 'self_serve' }]);
        return true;
      }
    );
  });

  test('supports caller reason override for missing actions', () => {
    assert.throws(
      () =>
        assertUpdateMediaBuyAllowed(
          buyWith([{ action: 'pause', mode: 'self_serve' }]),
          { end_time: '2026-07-01T00:00:00Z' },
          { reason: 'wrong_status' }
        ),
      err => {
        assert.strictEqual(err.code, 'ACTION_NOT_ALLOWED');
        assert.strictEqual(err.details.reason, 'wrong_status');
        return true;
      }
    );
  });

  test('allowedModes rejects non-direct flows as mode_mismatch', () => {
    assert.throws(
      () =>
        assertUpdateMediaBuyAllowed(
          buyWith([{ action: 'extend_flight', mode: 'requires_approval' }]),
          { end_time: '2026-07-01T00:00:00Z' },
          { allowedModes: ['self_serve'] }
        ),
      err => {
        assert.strictEqual(err.code, 'ACTION_NOT_ALLOWED');
        assert.strictEqual(err.details.attempted_action, 'extend_flight');
        assert.strictEqual(err.details.reason, 'mode_mismatch');
        assert.deepStrictEqual(err.details.currently_available_actions, [
          { action: 'extend_flight', mode: 'requires_approval' },
        ]);
        return true;
      }
    );
  });

  test('throws INVALID_REQUEST for patches with no recognized mutation', () => {
    assert.throws(
      () =>
        assertUpdateMediaBuyAllowed(buyWith([{ action: 'pause', mode: 'self_serve' }]), {
          packages: [{ package_id: 'pkg_1', paused: false }],
        }),
      err => {
        assert.ok(err instanceof AdcpError);
        assert.strictEqual(err.code, 'INVALID_REQUEST');
        assert.strictEqual(err.field, 'request');
        return true;
      }
    );
  });
});
