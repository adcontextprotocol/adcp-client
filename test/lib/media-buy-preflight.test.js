// Tests for buyer-side preflight helpers landed for AdCP 3.1 / RFC #4480.
// Covers:
//   - boolean gates (canPause, canExtendFlight, ...)
//   - decomposeUpdateMediaBuy / getActionForMutation across direction cases
//   - preflightUpdateMediaBuy ok / not-ok paths and compat shim

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const {
  canPause,
  canResume,
  canCancel,
  canExtendFlight,
  canShortenFlight,
  canIncreaseBudget,
  canDecreaseBudget,
  canReallocateBudget,
  canRemoveCreative,
  canAddPackages,
  decomposeUpdateMediaBuy,
  findAvailableAction,
  getActionForMutation,
  getAvailableActions,
  getRollupParent,
  preflightUpdateMediaBuy,
  recoveryForModeMismatch,
  __resetValidActionsWarningForTests,
} = require('../../dist/lib/media-buy');
const { ValidationError } = require('../../dist/lib/errors');

function buyWith(availableActions, overrides = {}) {
  return {
    media_buy_id: 'mb_1',
    status: 'live',
    end_time: '2026-06-01T00:00:00Z',
    packages: [
      { package_id: 'pkg_1', budget: 1000, end_time: '2026-06-01T00:00:00Z' },
      { package_id: 'pkg_2', budget: 500, end_time: '2026-06-01T00:00:00Z' },
    ],
    available_actions: availableActions,
    ...overrides,
  };
}

describe('boolean gates', () => {
  test('canPause/canResume reflect available_actions[]', () => {
    const buy = buyWith([
      { action: 'pause', mode: 'self_serve' },
      { action: 'resume', mode: 'self_serve' },
    ]);
    assert.strictEqual(canPause(buy), true);
    assert.strictEqual(canResume(buy), true);
    assert.strictEqual(canCancel(buy), false);
  });

  test('canExtendFlight true when seller emits extend_flight', () => {
    const buy = buyWith([{ action: 'extend_flight', mode: 'requires_approval' }]);
    assert.strictEqual(canExtendFlight(buy), true);
    assert.strictEqual(canShortenFlight(buy), false);
  });

  test('fine-grained gate falls back to legacy rollup parent', () => {
    // Seller emits the coarse legacy action; buyer asks about a child.
    const buy = buyWith([{ action: 'update_budget', mode: 'self_serve' }]);
    assert.strictEqual(canIncreaseBudget(buy), true);
    assert.strictEqual(canDecreaseBudget(buy), true);
    assert.strictEqual(canReallocateBudget(buy), true);
  });

  test('canRemoveCreative reflects remove_creative availability', () => {
    const buy = buyWith([{ action: 'remove_creative', mode: 'self_serve' }]);
    assert.strictEqual(canRemoveCreative(buy), true);
  });

  test('canAddPackages false when not advertised', () => {
    const buy = buyWith([{ action: 'pause', mode: 'self_serve' }]);
    assert.strictEqual(canAddPackages(buy), false);
  });
});

describe('getAvailableActions compat shim', () => {
  beforeEach(() => __resetValidActionsWarningForTests());

  test('returns available_actions[] when present', () => {
    const buy = buyWith([{ action: 'pause', mode: 'requires_approval' }]);
    const result = getAvailableActions(buy);
    assert.strictEqual(result.source, 'available_actions');
    assert.strictEqual(result.actions.length, 1);
    assert.strictEqual(result.actions[0].mode, 'requires_approval');
    assert.strictEqual(result.deprecationHint, undefined);
  });

  test('synthesizes from valid_actions[] with self_serve default', () => {
    const buy = {
      media_buy_id: 'mb_1',
      packages: [],
      valid_actions: ['pause', 'cancel'],
    };
    const result = getAvailableActions(buy, { silent: true });
    assert.strictEqual(result.source, 'valid_actions');
    assert.ok(result.deprecationHint);
    assert.deepStrictEqual(result.actions.map(a => a.action).sort(), ['cancel', 'pause']);
    assert.ok(result.actions.every(a => a.mode === 'self_serve'));
  });

  test('returns absent source on empty input', () => {
    const result = getAvailableActions({ media_buy_id: 'x' });
    assert.strictEqual(result.source, 'absent');
    assert.strictEqual(result.actions.length, 0);
  });

  test('findAvailableAction honors rollup', () => {
    const buy = {
      media_buy_id: 'mb_1',
      valid_actions: ['update_budget'],
    };
    const hit = findAvailableAction(buy, 'increase_budget', { silent: true });
    assert.ok(hit);
    assert.strictEqual(hit.entry.action, 'update_budget');
  });

  test('getRollupParent maps fine-grained to legacy coarse', () => {
    assert.strictEqual(getRollupParent('increase_budget'), 'update_budget');
    assert.strictEqual(getRollupParent('extend_flight'), 'update_dates');
    assert.strictEqual(getRollupParent('pause'), undefined);
  });
});

describe('decomposeUpdateMediaBuy', () => {
  const buy = buyWith([
    { action: 'extend_flight', mode: 'self_serve' },
    { action: 'increase_budget', mode: 'self_serve' },
    { action: 'update_frequency_caps', mode: 'self_serve' },
  ]);

  test('returns concrete package mutations with action, path, and before/after values', () => {
    const plan = decomposeUpdateMediaBuy(buy, {
      end_time: '2026-07-01T00:00:00Z',
      packages: [
        {
          package_id: 'pkg_1',
          budget: 1500,
          targeting_overlay: { frequency_cap: { count: 3, interval: 'day' } },
        },
      ],
    });

    assert.deepStrictEqual(plan.actions.map(a => a.action).sort(), [
      'extend_flight',
      'increase_budget',
      'update_frequency_caps',
    ]);
    assert.deepStrictEqual(plan.touched_fields, [
      'end_time',
      'packages[].budget',
      'packages[].targeting_overlay.frequency_cap',
    ]);

    const budget = plan.mutations.find(m => m.path === 'packages[0].budget');
    assert.ok(budget);
    assert.strictEqual(budget.action, 'increase_budget');
    assert.strictEqual(budget.direction, 'increase');
    assert.strictEqual(budget.scope, 'package');
    assert.strictEqual(budget.package_id, 'pkg_1');
    assert.strictEqual(budget.from, 1000);
    assert.strictEqual(budget.to, 1500);
  });

  test('preserves separate package mutations while aggregating shared actions', () => {
    const plan = decomposeUpdateMediaBuy(buy, {
      packages: [
        { package_id: 'pkg_1', budget: 1200 },
        { package_id: 'pkg_2', budget: 300 },
      ],
    });

    assert.strictEqual(plan.actions.length, 1);
    assert.strictEqual(plan.actions[0].action, 'reallocate_budget');
    assert.strictEqual(plan.actions[0].direction, 'reallocate');
    assert.deepStrictEqual(
      plan.mutations.map(m => [m.path, m.from, m.to]),
      [
        ['packages[0].budget', 1000, 1200],
        ['packages[1].budget', 500, 300],
      ]
    );
  });

  test('returns empty plan for unknown/no-op patches', () => {
    const plan = decomposeUpdateMediaBuy(buy, {
      packages: [{ package_id: 'pkg_1', paused: false }],
    });
    assert.deepStrictEqual(plan, {
      mutations: [],
      actions: [],
      touched_fields: [],
    });
  });
});

describe('getActionForMutation resolver', () => {
  const buy = buyWith([
    { action: 'pause', mode: 'self_serve' },
    { action: 'extend_flight', mode: 'self_serve' },
    { action: 'increase_budget', mode: 'self_serve' },
  ]);

  test('paused: true resolves to pause', () => {
    const result = getActionForMutation(buy, { paused: true });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].action, 'pause');
  });

  test('paused: false resolves to resume', () => {
    const result = getActionForMutation(buy, { paused: false });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].action, 'resume');
  });

  test('budget increase on a package resolves to increase_budget', () => {
    const result = getActionForMutation(buy, {
      packages: [{ package_id: 'pkg_1', budget: 1500 }],
    });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].action, 'increase_budget');
    assert.strictEqual(result[0].direction, 'increase');
  });

  test('budget decrease resolves to decrease_budget', () => {
    const result = getActionForMutation(buy, {
      packages: [{ package_id: 'pkg_1', budget: 800 }],
    });
    assert.strictEqual(result[0].action, 'decrease_budget');
    assert.strictEqual(result[0].direction, 'decrease');
  });

  test('budget shift between packages with constant total is reallocate_budget', () => {
    const result = getActionForMutation(buy, {
      packages: [
        { package_id: 'pkg_1', budget: 1200 },
        { package_id: 'pkg_2', budget: 300 },
      ],
    });
    assert.strictEqual(result[0].action, 'reallocate_budget');
    assert.strictEqual(result[0].direction, 'reallocate');
  });

  test('later end_time resolves to extend_flight', () => {
    const result = getActionForMutation(buy, { end_time: '2026-07-01T00:00:00Z' });
    assert.strictEqual(result[0].action, 'extend_flight');
    assert.strictEqual(result[0].direction, 'extend');
  });

  test('earlier end_time resolves to shorten_flight', () => {
    const result = getActionForMutation(buy, { end_time: '2026-05-15T00:00:00Z' });
    assert.strictEqual(result[0].action, 'shorten_flight');
    assert.strictEqual(result[0].direction, 'shorten');
  });

  test('end_time without baseline falls through to update_flight_dates', () => {
    // Buy carries no end_time, so direction is indeterminate. Generic
    // vocabulary is safer than guessing extend.
    const noBaseline = { available_actions: buy.available_actions, packages: [] };
    const result = getActionForMutation(noBaseline, { end_time: '2026-07-01T00:00:00Z' });
    assert.strictEqual(result[0].action, 'update_flight_dates');
    assert.strictEqual(result[0].direction, 'shift');
  });

  test('budget unchanged on a single package resolves to reallocate_budget', () => {
    // Equal totals with no per-package movement still attaches an action
    // so the preflight gate runs against a real entry.
    const result = getActionForMutation(buy, {
      packages: [{ package_id: 'pkg_1', budget: 1000 }],
    });
    assert.strictEqual(result[0].action, 'reallocate_budget');
    assert.strictEqual(result[0].direction, 'reallocate');
  });

  test('end + start touched together resolves to update_flight_dates', () => {
    const result = getActionForMutation(buy, {
      start_time: '2026-04-01T00:00:00Z',
      end_time: '2026-07-01T00:00:00Z',
    });
    assert.strictEqual(result[0].action, 'update_flight_dates');
    assert.strictEqual(result[0].direction, 'shift');
  });

  test('frequency cap only resolves to update_frequency_caps', () => {
    const result = getActionForMutation(buy, {
      packages: [{ package_id: 'pkg_1', targeting_overlay: { frequency_cap: { count: 3 } } }],
    });
    assert.strictEqual(result[0].action, 'update_frequency_caps');
  });

  test('full targeting_overlay resolves to update_targeting', () => {
    const result = getActionForMutation(buy, {
      packages: [{ package_id: 'pkg_1', targeting_overlay: { geo: { include: ['US'] } } }],
    });
    assert.strictEqual(result[0].action, 'update_targeting');
  });

  test('package canceled resolves to remove_packages', () => {
    const result = getActionForMutation(buy, {
      packages: [{ package_id: 'pkg_1', canceled: true }],
    });
    assert.strictEqual(result[0].action, 'remove_packages');
  });

  test('new_packages resolves to add_packages', () => {
    const result = getActionForMutation(buy, {
      new_packages: [{ product_id: 'prod_1' }],
    });
    assert.strictEqual(result[0].action, 'add_packages');
  });

  test('cancellation resolves to cancel', () => {
    const result = getActionForMutation(buy, { canceled: true, cancellation_reason: 'oops' });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].action, 'cancel');
  });

  test('mixed mutation returns multiple resolved actions', () => {
    const result = getActionForMutation(buy, {
      end_time: '2026-07-01T00:00:00Z',
      packages: [{ package_id: 'pkg_1', budget: 1500 }],
    });
    const actions = result.map(r => r.action).sort();
    assert.deepStrictEqual(actions, ['extend_flight', 'increase_budget']);
  });

  test('no recognized field returns empty array', () => {
    const result = getActionForMutation(buy, {});
    assert.strictEqual(result.length, 0);
  });
});

describe('preflightUpdateMediaBuy', () => {
  beforeEach(() => __resetValidActionsWarningForTests());

  test('ok path returns matched actions and modes', () => {
    const buy = buyWith([
      { action: 'extend_flight', mode: 'requires_approval' },
      { action: 'increase_budget', mode: 'self_serve' },
    ]);
    const result = preflightUpdateMediaBuy(buy, {
      end_time: '2026-07-01T00:00:00Z',
      packages: [{ package_id: 'pkg_1', budget: 1500 }],
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.actions.length, 2);
    assert.strictEqual(result.mutations.length, 2);
    assert.deepStrictEqual(result.mutations.map(m => m.path).sort(), ['end_time', 'packages[0].budget']);
    assert.deepStrictEqual(result.modes.sort(), ['requires_approval', 'self_serve']);
    assert.strictEqual(result.requiresAsyncFlow, true);
    assert.strictEqual(result.compat, undefined);
  });

  test('denied when resolved action missing from available_actions', () => {
    const buy = buyWith([{ action: 'pause', mode: 'self_serve' }]);
    const result = preflightUpdateMediaBuy(buy, { end_time: '2026-07-01T00:00:00Z' });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.denials.length, 1);
    assert.strictEqual(result.denials[0].action, 'extend_flight');
    assert.strictEqual(result.denials[0].reason, 'not_supported_on_buy');
    assert.strictEqual(result.mutations[0].path, 'end_time');
    assert.ok(Array.isArray(result.currently_available_actions));
  });

  test('multi-action request reports every blocked action', () => {
    // Buy advertises only `increase_budget`. Request touches end_time
    // (extend_flight) AND a second packages[].budget bump that maps to
    // `increase_budget`, AND a frequency cap change. Two of three should
    // be denied; the budget bump is allowed.
    const buy = buyWith([{ action: 'increase_budget', mode: 'self_serve' }]);
    const result = preflightUpdateMediaBuy(buy, {
      end_time: '2026-07-01T00:00:00Z',
      packages: [{ package_id: 'pkg_1', budget: 1500, targeting_overlay: { frequency_cap: { count: 3 } } }],
    });
    assert.strictEqual(result.ok, false);
    const denied = result.denials.map(d => d.action).sort();
    assert.deepStrictEqual(denied, ['extend_flight', 'update_frequency_caps']);
  });

  test('compat shim populates compat field on valid_actions[] only buy', () => {
    const buy = {
      media_buy_id: 'mb_1',
      packages: [{ package_id: 'pkg_1', budget: 1000 }],
      end_time: '2026-06-01T00:00:00Z',
      valid_actions: ['update_budget', 'pause'],
    };
    const result = preflightUpdateMediaBuy(buy, {
      packages: [{ package_id: 'pkg_1', budget: 1500 }],
    });
    assert.strictEqual(result.ok, true);
    assert.ok(result.compat);
    assert.strictEqual(result.compat.source, 'valid_actions');
    assert.ok(result.compat.message.length > 0);
    assert.strictEqual(result.modes[0], 'self_serve');
  });

  test('empty request body throws ValidationError (buyer-side no-op)', () => {
    const buy = buyWith([{ action: 'pause', mode: 'self_serve' }]);
    assert.throws(() => preflightUpdateMediaBuy(buy, {}), ValidationError);
  });

  test('request touching only pkg.paused throws (not a real action)', () => {
    // pkg.paused has no entry in the action mapping - the spec keys pause
    // at the buy level only. Resolver should ignore it; preflight should
    // refuse to dispatch a no-op rather than misclassify it as `pause`.
    const buy = buyWith([{ action: 'pause', mode: 'self_serve' }]);
    assert.throws(
      () => preflightUpdateMediaBuy(buy, { packages: [{ package_id: 'pkg_1', paused: false }] }),
      ValidationError
    );
  });

  test('requiresAsyncFlow false when every mode is self_serve', () => {
    const buy = buyWith([{ action: 'pause', mode: 'self_serve' }]);
    const result = preflightUpdateMediaBuy(buy, { paused: true });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.requiresAsyncFlow, false);
  });
});

describe('recoveryForModeMismatch', () => {
  test('requires_proposal returns createProposal hint', () => {
    const r = recoveryForModeMismatch('extend_flight', [{ action: 'extend_flight', mode: 'requires_proposal' }]);
    assert.strictEqual(r.kind, 'createProposal');
    assert.match(r.message, /create_proposal/);
  });

  test('requires_approval returns waitForApproval hint', () => {
    const r = recoveryForModeMismatch('cancel', [{ action: 'cancel', mode: 'requires_approval' }]);
    assert.strictEqual(r.kind, 'waitForApproval');
  });

  test('conditional_self_serve returns reissueAsDirect hint', () => {
    const r = recoveryForModeMismatch('increase_budget', [
      { action: 'increase_budget', mode: 'conditional_self_serve' },
    ]);
    assert.strictEqual(r.kind, 'reissueAsDirect');
  });

  test('returns undefined when attempted action not in available list', () => {
    const r = recoveryForModeMismatch('pause', [{ action: 'cancel', mode: 'requires_approval' }]);
    assert.strictEqual(r, undefined);
  });
});
