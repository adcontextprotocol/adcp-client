const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  assessMediaBuyAction,
  assessActionAvailability,
  assessProductAction,
  assessProposalAction,
  evaluateChangeTermConstraints,
  refreshMediaBuyActions,
  mediaBuyActionTasks,
} = require('../../dist/lib/media-buy/actions.js');
const {
  decomposeUpdateMediaBuy,
  preflightUpdateMediaBuy,
  getAvailableActions,
} = require('../../dist/lib/media-buy/index.js');
const { mediaBuyActionResolver } = require('../../dist/lib/server/media-buy-action-resolver.js');
const NOW = Date.parse('2027-01-01T00:00:00Z');
const accept = () => ({ authorization: true, governance: true, policy: true });
const term = (action = 'pause', extra = {}) => ({
  term_id: `right_${action}`,
  action,
  service_mode: 'self_serve',
  ...extra,
});
function buy(terms = [term()], extra = {}) {
  const state = {
    media_buy_id: 'buy1',
    status: 'active',
    revision: 3,
    currency: 'USD',
    total_budget: 1000,
    start_time: '2027-01-01T00:00:00Z',
    end_time: '2027-02-01T00:00:00Z',
    packages: [
      { package_id: 'p1', budget: 600 },
      { package_id: 'p2', budget: 400 },
    ],
    accepted_proposal_id: 'proposal1',
    accepted_proposal: {
      proposal_id: 'proposal1',
      proposal_status: 'accepted',
      media_buy_id: 'buy1',
      commercial_terms: { change_terms: terms },
    },
    ...extra,
  };
  state.available_actions ??= mediaBuyActionResolver.resolve({ buy: state, decide: accept }).available_actions;
  return state;
}
function constraint(t, state, request, options = {}) {
  return evaluateChangeTermConstraints(t, state, request, decomposeUpdateMediaBuy(state, request).mutations, options);
}

test('product possibility, explicit non-negotiation, and absent legacy rights remain separate', () => {
  const product = { allowed_actions: [{ action: 'pause', modes: ['self_serve'] }] };
  const result = assessMediaBuyAction({ action: 'pause', product, buy: buy([]) });
  assert.equal(result.possibility.status, 'possible');
  assert.equal(result.possibility.binding, false);
  assert.equal(result.promise.status, 'not_negotiated');
  assert.equal(result.availability.reason, 'not_supported_on_buy');
  assert.equal(assessProductAction({ allowed_actions: [] }, 'pause').status, 'unsupported');
  assert.equal(assessProposalAction({ commercial_terms: {} }, 'pause').status, 'unknown');
  const legacy = assessMediaBuyAction({
    action: 'pause',
    product,
    buy: { status: 'active', valid_actions: ['pause'] },
  });
  assert.equal(legacy.availability.compat.reason, 'no_change_terms');
  assert.equal(legacy.availability.certainty, 'unknown');
});

test('3.1.19 opaque terms_ref never identifies a term even when values coincide', () => {
  for (const pointer of ['opaque-contract-token', 'right_pause']) {
    const state = buy([term()], { available_actions: [{ action: 'pause', mode: 'self_serve', terms_ref: pointer }] });
    const result = assessActionAvailability(state, 'pause', { adcpVersion: '3.1.19', termsRefIsAlias: true });
    assert.equal(result.certainty, 'unknown');
    assert.equal(result.reason, 'condition_unresolved');
  }
  const old = { valid_actions: ['pause'] };
  assert.equal(getAvailableActions(old, { silent: true }).source, 'valid_actions');
  assert.equal(preflightUpdateMediaBuy(old, { paused: true }).ok, true);
  assert.equal(assessActionAvailability(old, 'pause').compat.reason, 'no_change_terms');
});

test('released early 3.2 beta without change_terms does not manufacture authority', () => {
  const old = {
    status: 'active',
    accepted_proposal: { commercial_terms: {} },
    available_actions: [{ task: 'control_media_buy', action: 'pause', mode: 'self_serve' }],
  };
  const result = assessActionAvailability(old, 'pause', { adcpVersion: '3.2.0-beta.8' });
  assert.equal(result.compat.reason, 'no_change_terms');
});

test('3.2 term identity, deliberate aliases, and independent opaque document references', () => {
  const state = buy([term('pause', { terms_ref: 'https://seller.example/contract' })]);
  assert.equal(assessActionAvailability(state, 'pause').status, 'available_now');
  state.available_actions[0].terms_ref = 'right_pause';
  assert.equal(assessActionAvailability(state, 'pause', { termsRefIsAlias: true }).status, 'available_now');
  state.available_actions[0].terms_ref = 'unrelated-opaque-document';
  assert.equal(assessActionAvailability(state, 'pause').status, 'available_now');
  assert.equal(assessActionAvailability(state, 'pause', { termsRefIsAlias: true }).certainty, 'unknown');
  state.available_actions[0].change_term_id = 'wrong-term';
  assert.equal(assessActionAvailability(state, 'pause').certainty, 'unknown');
});

test('explicit empty structured actions supersede stale flat valid_actions', () => {
  const state = buy([term()], { available_actions: [], valid_actions: ['pause'] });
  assert.deepEqual(getAvailableActions(state), { source: 'available_actions', actions: [] });
  assert.equal(assessActionAvailability(state, 'pause').status, 'currently_unavailable');
  assert.equal(preflightUpdateMediaBuy(state, { paused: true }).ok, false);
});

test('wrong status, immediate control, seller-managed refinement, and creative routes', () => {
  const terms = [
    term(),
    term('resume', { allowed_statuses: ['paused'] }),
    term('increase_budget', { service_mode: 'seller_managed', processing_sla: { completion_max: 'PT24H' } }),
    term('replace_creative'),
  ];
  const state = buy(terms);
  assert.equal(assessActionAvailability(state, 'resume').reason, 'wrong_status');
  assert.equal(assessActionAvailability(state, 'pause').nonDefaultRoute, 'control_media_buy');
  const increase = state.available_actions.find(e => e.action === 'increase_budget');
  increase.task = 'refine_proposals';
  assert.equal(
    assessActionAvailability(state, 'increase_budget', { task: 'control_media_buy' }).reason,
    'mode_mismatch'
  );
  assert.equal(assessActionAvailability(state, 'increase_budget', { task: 'refine_proposals' }).mode, 'seller_managed');
  assert.equal(assessActionAvailability(state, 'replace_creative').nonDefaultRoute, 'sync_creatives');
  assert.deepEqual(mediaBuyActionTasks('extend_flight'), ['refine_proposals']);
});

test('opaque conditions stay unknown to buyers and need explicit seller evaluation', () => {
  const state = buy([term('pause', { conditions: ['seller_credit_check'] })]);
  assert.deepEqual(state.available_actions, []);
  state.available_actions = mediaBuyActionResolver.resolve({
    buy: state,
    decide: () => ({ ...accept(), conditionsSatisfied: true }),
  }).available_actions;
  assert.equal(state.available_actions.length, 1);
  assert.equal(assessActionAvailability(state, 'pause').certainty, 'unknown');
});

test('stale revisions and action echoes do not revive rights or alter revision', () => {
  const state = buy();
  assert.equal(assessActionAvailability(state, 'pause', { request: { revision: 2, paused: true } }).code, 'CONFLICT');
  const refreshed = refreshMediaBuyActions(state, { currently_available_actions: [] });
  assert.equal(refreshed.revision, 3);
  assert.equal(assessActionAvailability(refreshed, 'pause').status, 'currently_unavailable');
  assert.equal(state.available_actions.length, 1);
  state.accepted_proposal_id = 'amended-away';
  assert.equal(assessActionAvailability(state, 'pause').certainty, 'unknown');
});

test('budget constraints evaluate deltas, percent, results, currencies, zero and missing baselines', () => {
  const cases = [
    [{ max_delta_amount: { amount: 50, currency: 'USD' } }, 1100, 'max_delta_amount'],
    [{ max_delta_percent: 5 }, 1100, 'max_delta_percent'],
    [{ min_result_amount: { amount: 1200, currency: 'USD' } }, 1100, 'min_result_amount'],
    [{ max_result_amount: { amount: 1050, currency: 'USD' } }, 1100, 'max_result_amount'],
  ];
  for (const [bounds, amount, key] of cases) {
    const t = term('increase_budget', { constraints: { kind: 'budget', ...bounds } }),
      state = buy([t]);
    const request = { total_budget: { amount, currency: 'USD' } };
    assert.equal(constraint(t, state, request).constraint, key);
    const assessment = assessActionAvailability(state, t.action, { request });
    assert.equal(assessment.code, 'REQUOTE_REQUIRED');
    assert.equal(preflightUpdateMediaBuy(state, request).ok, false);
  }
  const t = term('increase_budget', { constraints: { kind: 'budget', max_delta_percent: 10 } });
  assert.equal(constraint(t, buy([t]), { total_budget: { amount: 1100, currency: 'USD' } }).status, 'satisfied');
  assert.equal(
    constraint(t, buy([t], { total_budget: 0 }), { total_budget: { amount: 1, currency: 'USD' } }).status,
    'exceeded'
  );
  assert.equal(
    constraint(t, buy([t], { total_budget: undefined }), { total_budget: { amount: 100, currency: 'USD' } }).status,
    'unknown'
  );
  assert.equal(
    constraint(t, buy([t]), { total_budget: { amount: 1100, currency: 'EUR' } }).constraint,
    'currency_mismatch'
  );
});

test('mixed package increases/decreases cannot hide a blocked action in a net increase', () => {
  const state = buy([term('increase_budget')]);
  const request = {
    packages: [
      { package_id: 'p1', budget: 800 },
      { package_id: 'p2', budget: 300 },
    ],
  };
  assert.deepEqual(
    decomposeUpdateMediaBuy(state, request).actions.map(a => a.action),
    ['increase_budget', 'decrease_budget']
  );
  assert.equal(preflightUpdateMediaBuy(state, request).denials[0].reason, 'not_supported_on_buy');
  assert.equal(
    preflightUpdateMediaBuy(buy(), { paused: true, total_budget: { amount: 1200, currency: 'USD' } }).ok,
    false
  );
});

test('flight bounds preserve unknown dates/campaign durations and never treat changed timestamps as effective notice', () => {
  for (const [bounds, key] of [
    [{ max_change: { interval: 1, unit: 'days' } }, 'max_change'],
    [{ latest_result: '2027-02-02T00:00:00Z' }, 'latest_result'],
    [{ earliest_result: '2027-02-05T00:00:00Z' }, 'earliest_result'],
    [{ minimum_notice: { interval: 1, unit: 'hours' } }, 'minimum_notice'],
  ]) {
    const t = term('extend_flight', { constraints: { kind: 'flight', ...bounds } });
    assert.equal(constraint(t, buy([t]), { end_time: '2027-02-03T00:00:00Z' }).constraint, key);
  }
  const t = term('extend_flight', { constraints: { kind: 'flight', max_change: { interval: 1, unit: 'campaign' } } });
  assert.equal(constraint(t, buy([t]), { end_time: '2027-02-03T00:00:00Z' }).status, 'unknown');
});

test('package count constraints count only known active identities', () => {
  const t = term('add_packages', { constraints: { kind: 'package_count', max_result_count: 2 } });
  const state = buy([t]);
  assert.equal(constraint(t, state, { new_packages: [{}] }).constraint, 'max_result_count');
  assert.equal(
    constraint(t, state, { new_packages: [{}], packages: [{ package_id: 'p1', canceled: true }] }).status,
    'satisfied'
  );
  assert.equal(
    constraint(t, state, { new_packages: [{}], packages: [{ package_id: 'unknown', canceled: true }] }).status,
    'unknown'
  );
  for (const [action, bound, request] of [
    ['add_packages', 'max_additions', { new_packages: [{}] }],
    ['remove_packages', 'max_removals', { packages: [{ package_id: 'p1', canceled: true }] }],
  ]) {
    const limited = term(action, { constraints: { kind: 'package_count', [bound]: 0 } });
    assert.equal(constraint(limited, buy([limited]), request).constraint, bound);
  }
});

test('effective timing uses explicit current time and positive notice cannot be instant', () => {
  for (const [bounds, key] of [
    [{ minimum_notice: { interval: 1, unit: 'seconds' } }, 'minimum_notice'],
    [{ earliest_effective_at: '2027-01-02T00:00:00Z' }, 'earliest_effective_at'],
    [{ latest_effective_at: '2026-12-31T00:00:00Z' }, 'latest_effective_at'],
  ]) {
    const t = term('pause', { constraints: { kind: 'effective_timing', ...bounds } });
    assert.equal(constraint(t, buy([t]), { paused: true }, { now: NOW }).constraint, key);
  }
  const t = term('pause', { constraints: { kind: 'effective_timing', earliest_effective_at: '2026-01-01T00:00:00Z' } });
  assert.equal(constraint(t, buy([t]), { paused: true }).status, 'unknown');
  assert.equal(constraint(t, buy([t]), { paused: true }, { now: NOW }).status, 'satisfied');
});

test('seller explicit materialization, independent gates, status projections, and 3.1 compatibility', () => {
  const products = [{ allowed_actions: [{ action: 'pause', modes: ['self_serve'] }] }];
  assert.throws(() => mediaBuyActionResolver.materialize({ products, acceptedTerms: [term()] }), /acceptance/);
  const accepted = mediaBuyActionResolver.materialize({ products, acceptedTerms: [term()], sellerAccepted: true });
  assert.deepEqual(accepted, [term()]);
  assert.notEqual(accepted[0], products[0].allowed_actions[0]);
  const terms = [
    term(),
    term('resume', { allowed_statuses: ['paused'] }),
    term('cancel', { service_mode: 'seller_managed' }),
  ];
  for (const [status, expected] of [
    ['active', ['pause', 'cancel']],
    ['paused', ['resume', 'cancel']],
    ['completed', []],
    ['rejected', []],
    ['canceled', []],
  ]) {
    const projected = mediaBuyActionResolver.resolve({ buy: buy(terms, { status }), decide: accept });
    assert.deepEqual(
      projected.available_actions.map(a => a.action),
      expected
    );
  }
  for (const gate of ['authorization', 'governance', 'policy']) {
    for (const denied of [false, 'unknown', undefined])
      assert.equal(
        mediaBuyActionResolver.resolve({ buy: buy(), decide: () => ({ ...accept(), [gate]: denied }) })
          .available_actions.length,
        0
      );
  }
  const state = buy([term('cancel', { service_mode: 'seller_managed' })]);
  assert.deepEqual(
    mediaBuyActionResolver.resolve({ buy: state, decide: accept, wireVersion: '3.1' }).available_actions,
    [{ action: 'cancel', mode: 'requires_approval', terms_ref: 'right_cancel' }]
  );
  assert.equal(
    mediaBuyActionResolver.resolve({ buy: state, decide: accept, emitTermsRefAlias: true }).available_actions[0]
      .terms_ref,
    'right_cancel'
  );
});

test('seller rejects duplicate identities, incompatible constraints/statuses, and widening', () => {
  for (const terms of [
    [term(), term()],
    [term(), term('cancel', { term_id: 'right_pause' })],
    [term('pause', { constraints: { kind: 'budget', max_delta_percent: 10 } })],
    [term('pause', { allowed_statuses: ['completed'] })],
    [term('pause', { constraints: { kind: 'script', code: 'true' } })],
  ]) {
    assert.throws(
      () => mediaBuyActionResolver.resolve({ buy: buy(terms, { available_actions: [] }), decide: accept }),
      TypeError
    );
  }
  const state = buy([term('pause', { processing_sla: { completion_max: 'PT1H' } })]);
  assert.equal(
    mediaBuyActionResolver.resolve({ buy: state, decide: () => ({ ...accept(), sla: { completion_max: 'PT2H' } }) })
      .available_actions.length,
    0
  );
  assert.equal(
    mediaBuyActionResolver.resolve({ buy: state, decide: () => ({ ...accept(), task: 'sync_creatives' }) })
      .available_actions.length,
    0
  );
  const products = [{ allowed_actions: [{ action: 'pause', modes: ['self_serve'] }] }, { allowed_actions: [] }];
  assert.throws(
    () => mediaBuyActionResolver.materialize({ products, acceptedTerms: [term()], sellerAccepted: true }),
    TypeError
  );
  assert.equal(mediaBuyActionResolver.resolve({ buy: state, products, decide: accept }).available_actions.length, 0);
});

test('rc.3 shared frequency cap routes use canonical metadata without admitting an incompatible constraint', () => {
  const state = buy([term('update_media_buy_frequency_cap')]);
  assert.equal(assessActionAvailability(state, 'update_media_buy_frequency_cap').nonDefaultRoute, 'control_media_buy');
  assert.throws(
    () => buy([term('update_media_buy_frequency_cap', { constraints: { kind: 'budget', max_delta_percent: 1 } })]),
    TypeError
  );
});

test('seller materializes advisory bounds only on explicit acceptance and permits narrower bounds', () => {
  const product = {
    allowed_actions: [
      {
        action: 'increase_budget',
        modes: ['self_serve'],
        allowed_statuses: ['active'],
        sla: { completion_max: 'PT2H' },
        constraints: { kind: 'budget', max_delta_percent: 20 },
        terms_ref: 'seller-contract',
      },
    ],
  };
  const original = term('increase_budget');
  const [materialized] = mediaBuyActionResolver.materialize({
    products: [product],
    acceptedTerms: [original],
    sellerAccepted: true,
  });
  assert.equal(materialized.constraints.max_delta_percent, 20);
  assert.deepEqual(materialized.allowed_statuses, ['active']);
  assert.equal(materialized.processing_sla.completion_max, 'PT2H');
  assert.equal(materialized.terms_ref, 'seller-contract');
  assert.equal(original.constraints, undefined);
  assert.equal(
    mediaBuyActionResolver.materialize({
      products: [product],
      acceptedTerms: [term('increase_budget', { constraints: { kind: 'budget', max_delta_percent: 10 } })],
      sellerAccepted: true,
    })[0].constraints.max_delta_percent,
    10
  );
  assert.throws(() =>
    mediaBuyActionResolver.materialize({
      products: [product],
      acceptedTerms: [term('increase_budget', { constraints: { kind: 'budget', max_delta_percent: 30 } })],
      sellerAccepted: true,
    })
  );
});

test('mixed targeting and cap changes require both actions without changing targeting value types', () => {
  const state = buy([term('update_targeting')]);
  const request = {
    packages: [
      { package_id: 'p1', targeting_overlay: { geo_countries: ['US'], frequency_cap: { max_impressions: 3 } } },
    ],
  };
  assert.deepEqual(
    decomposeUpdateMediaBuy(state, request)
      .actions.map(a => a.action)
      .sort(),
    ['update_frequency_caps', 'update_targeting']
  );
  assert.equal(preflightUpdateMediaBuy(state, request).ok, false);
});

test('strict multi-action preflight refuses unmapped fields and unknown baseline cap removals', () => {
  const { preflightMediaBuyActions } = require('../../dist/lib/media-buy/actions.js');
  assert.equal(preflightMediaBuyActions(buy(), { paused: true, unsupported_mutation: 1 }).ok, false);
  assert.equal(
    preflightMediaBuyActions(buy([term('increase_budget')]), { packages: [{ package_id: 'p1', budget: null }] }).ok,
    false
  );
  assert.equal(preflightMediaBuyActions(buy(), { paused: true }, { task: 'control_media_buy' }).ok, true);
});

test('seller does not project effective timing that cannot execute now', () => {
  const t = term('pause', {
    constraints: { kind: 'effective_timing', minimum_notice: { interval: 1, unit: 'hours' } },
  });
  assert.equal(mediaBuyActionResolver.resolve({ buy: buy([t]), decide: accept, now: NOW }).available_actions.length, 0);
});

test('portable historical fixtures preserve absence without authorizing coincidental identities', () => {
  for (const fixture of require('../fixtures/media-buy-actions/compatibility.json')) {
    const result = assessActionAvailability(fixture.buy, 'pause', { adcpVersion: fixture.version });
    assert.equal(result.status, fixture.expected.status, fixture.description);
    assert.equal(result.reason, fixture.expected.reason, fixture.description);
    assert.equal(result.compat.reason, fixture.expected.compat_reason, fixture.description);
  }
});
