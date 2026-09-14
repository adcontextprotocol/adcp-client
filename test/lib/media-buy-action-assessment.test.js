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
    true
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

test('incomplete package baselines never establish a net-zero reallocation', () => {
  const state = buy([term('reallocate_budget')], {
    packages: [{ package_id: 'p1', budget: 600 }, { package_id: 'p2' }],
  });
  const request = {
    packages: [
      { package_id: 'p1', budget: 500 },
      { package_id: 'p2', budget: 100 },
    ],
  };
  const decomposition = decomposeUpdateMediaBuy(state, request);
  assert.equal(
    decomposition.actions.some(a => a.action === 'reallocate_budget'),
    false
  );
  assert.equal(preflightUpdateMediaBuy(state, request).ok, false);
});

test('currency is protected independently of optional portable bounds', () => {
  for (const extra of [{}, { constraints: { kind: 'budget', max_delta_percent: 20 } }]) {
    const state = buy([term('increase_budget', extra)]);
    const request = { total_budget: { amount: 1100, currency: 'EUR' } };
    assert.equal(
      assessActionAvailability(state, 'increase_budget', { request }).constraints.constraint,
      'currency_mismatch'
    );
    delete state.currency;
    assert.equal(assessActionAvailability(state, 'increase_budget', { request }).certainty, 'unknown');
  }
});

test('legacy task defaults and advisory coarse templates do not fabricate term identity', () => {
  const state = buy([term('increase_budget')]);
  delete state.available_actions[0].task;
  const result = assessActionAvailability(state, 'increase_budget', { task: 'update_media_buy' });
  assert.equal(result.status, 'available_now');
  assert.equal(result.nonDefaultRoute, undefined);
  const product = {
    allowed_actions: [
      { action: 'update_budget', modes: ['self_serve'] },
      { action: 'update_name', modes: ['self_serve'] },
    ],
  };
  assert.equal(assessProductAction(product, 'increase_budget').status, 'possible');
  assert.equal(
    mediaBuyActionResolver.materialize({
      products: [product],
      acceptedTerms: [term('increase_budget')],
      sellerAccepted: true,
    })[0].action,
    'increase_budget'
  );
  assert.equal(
    assessProposalAction({ commercial_terms: { change_terms: [] } }, 'increase_budget').status,
    'not_negotiated'
  );
});

test('metadata-only name changes require explicit live seller authority without a fabricated term', () => {
  const state = buy([]);
  assert.equal(assessActionAvailability(state, 'update_name').status, 'currently_unavailable');
  state.available_actions = mediaBuyActionResolver.resolve({
    buy: state,
    decide: accept,
    metadata: { update_name: accept() },
  }).available_actions;
  const result = assessActionAvailability(state, 'update_name');
  assert.equal(result.status, 'available_now');
  assert.equal(result.authority, 'live_metadata');
  assert.equal(result.term, undefined);
  assert.equal(state.available_actions[0].change_term_id, undefined);
  assert.equal(preflightUpdateMediaBuy(state, { name: 'New name' }).ok, true);
});

test('mixed mutations require one route and mapped fields on every package', () => {
  const { preflightMediaBuyActions } = require('../../dist/lib/media-buy/actions.js');
  const state = buy([term('pause'), term('replace_creative')]);
  const request = { paused: true, packages: [{ package_id: 'p1', creatives: ['creative1'] }] };
  assert.equal(preflightMediaBuyActions(state, request).ok, false);
  assert.equal(preflightUpdateMediaBuy(state, request).ok, false);
  for (const request of [
    { paused: true, invoice_recipient: 'buyer' },
    { paused: true, packages: [{ package_id: 'p1', paused: true }] },
    JSON.parse('{"paused":true,"constructor":{}}'),
  ]) {
    assert.throws(() => preflightUpdateMediaBuy(state, request), /no supported action mapping/);
    assert.equal(preflightMediaBuyActions(state, request).ok, false);
  }
  assert.equal(preflightUpdateMediaBuy(state, { paused: true, packages: [] }).ok, true);
});

test('rc.3 package-scoped grants cannot authorize siblings or buy-wide changes', () => {
  const state = buy([term('increase_budget')]);
  state.available_actions = mediaBuyActionResolver.resolve({
    buy: state,
    decide: () => ({ ...accept(), applicable_package_ids: ['p1'] }),
  }).available_actions;
  for (const request of [
    { packages: [{ package_id: 'p2', budget: 450 }] },
    { total_budget: { amount: 1100, currency: 'USD' } },
  ])
    assert.equal(preflightUpdateMediaBuy(state, request).ok, false);
  assert.equal(preflightUpdateMediaBuy(state, { packages: [{ package_id: 'p1', budget: 650 }] }).ok, true);
  assert.equal(assessActionAvailability(state, 'increase_budget').certainty, 'unknown');
  assert.equal(
    mediaBuyActionResolver.resolve({ buy: state, decide: () => ({ ...accept(), applicable_package_ids: ['missing'] }) })
      .available_actions.length,
    0
  );
  assert.equal(
    mediaBuyActionResolver.resolve({
      buy: state,
      wireVersion: '3.1',
      decide: () => ({ ...accept(), applicable_package_ids: ['p1'] }),
    }).available_actions.length,
    0
  );
});

test('request denial preserves full projection and hard denials preserve the action echo', () => {
  const t = term('increase_budget', { constraints: { kind: 'budget', max_delta_percent: 10 } });
  const state = buy([t]);
  const request = { total_budget: { amount: 1200, currency: 'USD' } };
  const result = mediaBuyActionResolver.resolve({ buy: state, decide: accept, request });
  assert.equal(result.available_actions.length, 1);
  assert.equal(result.request_assessments[0].code, 'REQUOTE_REQUIRED');
  const { assertUpdateMediaBuyAllowed } = require('../../dist/lib/server/media-buy-actions.js');
  assert.throws(
    () => assertUpdateMediaBuyAllowed(state, { ...request, paused: true }),
    error => error.code === 'ACTION_NOT_ALLOWED' && error.details.currently_available_actions.length === 1
  );
});

test('action refresh accepts optional unknown error details and deeply isolates the echo', () => {
  const state = buy();
  assert.equal(refreshMediaBuyActions(state, { attempted_action: 'pause', reason: 'wrong_status' }), state);
  const echo = {
    currently_available_actions: [
      { action: 'pause', mode: 'seller_managed', sla: { completion_max: 'PT1H' }, applicable_package_ids: ['p1'] },
    ],
  };
  const refreshed = refreshMediaBuyActions(state, echo);
  echo.currently_available_actions[0].sla.completion_max = 'PT2H';
  echo.currently_available_actions[0].applicable_package_ids.push('p2');
  assert.equal(refreshed.available_actions[0].sla.completion_max, 'PT1H');
  assert.deepEqual(refreshed.available_actions[0].applicable_package_ids, ['p1']);
});

test('released 3.1.19, beta.8 and rc.3 schemas validate the actual compatibility and projection shapes', () => {
  const Ajv = require('ajv');
  const addFormats = require('ajv-formats');
  const bundles = require('../fixtures/media-buy-actions/released-schemas.json');
  const fixtures = require('../fixtures/media-buy-actions/compatibility.json');
  const validators = new Map();
  for (const bundle of bundles) {
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    bundle.schemas.forEach(schema => ajv.addSchema(schema));
    validators.set(bundle.version, ajv);
  }
  for (const fixture of fixtures) {
    const ajv = validators.get(fixture.version);
    const prefix = fixture.version === '3.1.19' ? '' : 'https://adcontextprotocol.org';
    const kind = fixture.version === '3.1.19' ? 'media-buy-available-action' : 'canonical-media-buy-action';
    for (const entry of fixture.buy.available_actions ?? []) {
      const valid = ajv.getSchema(`${prefix}/schemas/${fixture.version}/core/${kind}.json`);
      assert.equal(valid(entry), true, JSON.stringify(valid.errors));
    }
    for (const action of fixture.buy.valid_actions ?? [])
      assert.equal(
        ajv.getSchema(`${prefix}/schemas/${fixture.version}/enums/media-buy-valid-action.json`)(action),
        true
      );
  }
  const rc = validators.get('3.2.0-rc.3');
  const valid = rc.getSchema('https://adcontextprotocol.org/schemas/3.2.0-rc.3/core/canonical-media-buy-action.json');
  const actions = bundles
    .find(b => b.version === '3.2.0-rc.3')
    .schemas.find(s => s.$id.endsWith('/enums/canonical-media-buy-action.json')).enum;
  for (const action of actions) {
    const terms = [term(action)];
    const state = buy(terms, { status: action === 'resume' ? 'paused' : 'active' });
    assert.equal(state.available_actions.length, 1, action);
    assert.equal(valid(state.available_actions[0]), true, `${action}: ${JSON.stringify(valid.errors)}`);
  }
  const state = buy([term('increase_budget')]);
  const entry = mediaBuyActionResolver.resolve({
    buy: state,
    decide: () => ({ ...accept(), applicable_package_ids: ['p1'] }),
  }).available_actions[0];
  assert.equal(valid(entry), true, JSON.stringify(valid.errors));
});

test('canonical control fields cannot use legacy rollups to acquire a different negotiated right', () => {
  const request = { packages: [{ package_id: 'p1', keyword_targets_add: ['running'], min_spend_target: 100 }] };
  const state = buy([term('update_targeting'), term('update_budget_allocation')]);
  assert.deepEqual(
    decomposeUpdateMediaBuy(state, request)
      .actions.map(a => a.action)
      .sort(),
    ['update_keywords', 'update_spend_target']
  );
  assert.equal(preflightUpdateMediaBuy(state, request).ok, false);
  const negotiated = buy([
    term('update_keywords'),
    term('update_spend_target', {
      constraints: { kind: 'budget', max_result_amount: { amount: 200, currency: 'USD' } },
    }),
  ]);
  assert.equal(preflightUpdateMediaBuy(negotiated, request).ok, true);
});

test('duplicate or unknown package identities cannot establish mutation authority', () => {
  const { preflightMediaBuyActions } = require('../../dist/lib/media-buy/actions.js');
  const state = buy([term('reallocate_budget')]);
  const request = {
    packages: [
      { package_id: 'p1', budget: 500 },
      { package_id: 'p1', budget: 700 },
    ],
  };
  assert.equal(preflightUpdateMediaBuy(state, request).ok, false);
  assert.equal(preflightMediaBuyActions(state, request).ok, false);
  assert.equal(assessActionAvailability(state, 'reallocate_budget', { request }).certainty, 'unknown');
});

test('historical seller projection uses the target 3.1.19 vocabulary and product metadata restrictions', () => {
  const Ajv = require('ajv');
  const addFormats = require('ajv-formats');
  const bundle = require('../fixtures/media-buy-actions/released-schemas.json')[0];
  const ajv = new Ajv({ strict: false });
  addFormats(ajv);
  bundle.schemas.forEach(schema => ajv.addSchema(schema));
  const valid = ajv.getSchema('/schemas/3.1.19/core/media-buy-available-action.json');
  const state = buy([term('pause'), term('update_budget_allocation'), term('update_bidding')]);
  const result = mediaBuyActionResolver.resolve({
    buy: state,
    wireVersion: '3.1',
    decide: accept,
    metadata: { update_name: accept() },
  });
  assert.deepEqual(
    result.available_actions.map(a => a.action),
    ['pause']
  );
  result.available_actions.forEach(entry => assert.equal(valid(entry), true, JSON.stringify(valid.errors)));
  const product = {
    allowed_actions: [{ action: 'update_name', modes: ['self_serve'], allowed_statuses: ['pending_start'] }],
  };
  assert.equal(
    mediaBuyActionResolver.resolve({
      buy: buy([]),
      products: [product],
      decide: accept,
      metadata: { update_name: accept() },
    }).available_actions.length,
    0
  );
});

test('malformed live SLA, task, scope, and duplicate echoes cannot become current authority', () => {
  for (const entries of [
    [{ action: 'pause', mode: 'self_serve', sla: { completion_max: 123 } }],
    [{ action: 'pause', mode: 'self_serve', task: 'run_arbitrary_tool' }],
    [{ action: 'pause', mode: 'self_serve', applicable_package_ids: [] }],
    [
      { action: 'pause', mode: 'self_serve' },
      { action: 'pause', mode: 'self_serve' },
    ],
  ]) {
    assert.throws(() => refreshMediaBuyActions(buy(), { currently_available_actions: entries }), /Invalid/);
    assert.equal(assessActionAvailability(buy([term()], { available_actions: entries }), 'pause').certainty, 'unknown');
  }
  assert.equal(
    mediaBuyActionResolver.resolve({ buy: buy(), decide: () => ({ ...accept(), sla: { completion_max: 'invalid' } }) })
      .available_actions.length,
    0
  );
});

test('legacy no-snapshot inference is retained and disallowed modes precede requote recovery', () => {
  assert.equal(
    preflightUpdateMediaBuy(
      { available_actions: [{ action: 'increase_budget', mode: 'self_serve' }] },
      { packages: [{ package_id: 'p1', budget: 100 }] }
    ).ok,
    true
  );
  const state = buy([
    term('increase_budget', { service_mode: 'seller_managed', constraints: { kind: 'budget', max_delta_percent: 1 } }),
  ]);
  const { assertUpdateMediaBuyAllowed } = require('../../dist/lib/server/media-buy-actions.js');
  assert.throws(
    () =>
      assertUpdateMediaBuyAllowed(
        state,
        { total_budget: { amount: 2000, currency: 'USD' } },
        { allowedModes: ['self_serve'] }
      ),
    error => error.code === 'ACTION_NOT_ALLOWED' && error.details.reason === 'mode_mismatch'
  );
});
