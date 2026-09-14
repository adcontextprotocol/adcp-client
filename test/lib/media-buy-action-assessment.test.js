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
  state.available_actions ??= mediaBuyActionResolver.resolve({
    buy: state,
    decide: accept,
    adcpVersion: '3.2.0-rc.3',
  }).available_actions;
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
  assert.equal(
    mediaBuyActionResolver.resolve({ buy: state, productPolicy: products, decide: accept }).available_actions.length,
    0
  );
});

test('rc.3 shared frequency cap routes use canonical metadata without admitting an incompatible constraint', () => {
  const state = buy([term('update_media_buy_frequency_cap')]);
  assert.equal(assessActionAvailability(state, 'update_media_buy_frequency_cap').nonDefaultRoute, 'control_media_buy');
  const defaultProjection = mediaBuyActionResolver.resolve({ buy: state, decide: accept });
  assert.equal(defaultProjection.available_actions[0].action, 'update_media_buy_frequency_cap');
  assert.equal(defaultProjection.available_actions[0].task, 'control_media_buy');
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

test('seller preserves notice-bound rights and evaluates notice only for a requested mutation', () => {
  const t = term('pause', {
    constraints: { kind: 'effective_timing', minimum_notice: { interval: 1, unit: 'hours' } },
  });
  const state = buy([t]);
  const result = mediaBuyActionResolver.resolve({ buy: state, decide: accept, request: { paused: true }, now: NOW });
  assert.equal(result.available_actions.length, 1);
  assert.equal(result.request_assessments[0].code, 'REQUOTE_REQUIRED');
  const flight = buy([
    term('extend_flight', {
      constraints: {
        kind: 'flight',
        minimum_notice: { interval: 1, unit: 'days' },
        max_change: { interval: 30, unit: 'days' },
      },
    }),
  ]);
  assert.equal(flight.available_actions.length, 1);
  assert.equal(
    assessActionAvailability(flight, 'extend_flight', { request: { end_time: '2027-02-02T00:00:00Z' } }).constraints
      .constraint,
    'minimum_notice'
  );
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
  assert.equal(preflightUpdateMediaBuy(state, request).ok, true);
  for (const request of [
    { paused: true, invoice_recipient: 'buyer' },
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
    adcpVersion: '3.2.0-rc.3',
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
      adcpVersion: '3.2.0-rc.3',
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
    () => assertUpdateMediaBuyAllowed(state, { ...request, paused: true }, { task: 'control_media_buy' }),
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
    adcpVersion: '3.2.0-rc.3',
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
      productPolicy: [product],
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
        { allowedModes: ['self_serve'], task: 'control_media_buy' }
      ),
    error => error.code === 'ACTION_NOT_ALLOWED' && error.details.reason === 'mode_mismatch'
  );
});

test('canonical and legacy package control spellings map to the same exact rights', () => {
  const state = buy([term('update_catalog_assignments'), term('update_bidding'), term('remove_packages')]);
  for (const key of ['catalogs', 'catalog_ids'])
    assert.equal(preflightUpdateMediaBuy(state, { packages: [{ package_id: 'p1', [key]: [] }] }).ok, true);
  assert.equal(preflightUpdateMediaBuy(state, { packages: [{ package_id: 'p1', bid_price: 2 }] }).ok, true);
  assert.equal(
    preflightUpdateMediaBuy(state, {
      packages: [{ package_id: 'p1', canceled: true, cancellation_reason: 'finished', context: { trace: 'x' } }],
    }).ok,
    true
  );
  assert.throws(
    () =>
      preflightUpdateMediaBuy(state, {
        packages: [{ package_id: 'p1', canceled: true, ext: { vendor: { controls: 1 } } }],
      }),
    /no supported action mapping/
  );
});

test('scoped package pause and resume require known package state and negotiated buy status', () => {
  const state = buy([term('pause'), term('resume')], {
    packages: [
      { package_id: 'p1', paused: false },
      { package_id: 'p2', paused: true },
    ],
  });
  state.available_actions = mediaBuyActionResolver.resolve({
    buy: state,
    adcpVersion: '3.2.0-rc.3',
    decide: t => ({ ...accept(), applicable_package_ids: t.action === 'pause' ? ['p1'] : ['p2'] }),
  }).available_actions;
  assert.equal(preflightUpdateMediaBuy(state, { packages: [{ package_id: 'p1', paused: true }] }).ok, true);
  assert.equal(preflightUpdateMediaBuy(state, { packages: [{ package_id: 'p2', paused: false }] }).ok, true);
  assert.equal(preflightUpdateMediaBuy(state, { packages: [{ package_id: 'p1', paused: false }] }).ok, false);
  assert.equal(preflightUpdateMediaBuy(state, { paused: false }).ok, false);
  assert.equal(
    preflightUpdateMediaBuy({ ...state, status: 'paused' }, { packages: [{ package_id: 'p1', paused: true }] }).ok,
    true
  );
  for (const status of ['completed', 'canceled', 'failed', 'rejected']) {
    assert.equal(
      preflightUpdateMediaBuy({ ...state, status }, { packages: [{ package_id: 'p1', paused: true }] }).ok,
      false
    );
    assert.equal(
      preflightUpdateMediaBuy({ ...state, status }, { packages: [{ package_id: 'p2', paused: false }] }).ok,
      false
    );
  }
  const unknown = buy([term('pause')], { packages: [{ package_id: 'p1', status: 'unrecognized' }] });
  assert.equal(
    preflightUpdateMediaBuy(unknown, { packages: [{ package_id: 'p1', paused: true }] }).denials[0].assessment
      .certainty,
    'unknown'
  );
});

test('daily cap clearing is an increase and cannot exceed finite accepted ceilings', () => {
  const state = buy([term('increase_budget')], {
    daily_budget_cap: 100,
    packages: [{ package_id: 'p1', daily_budget_cap: 50 }],
  });
  assert.equal(preflightUpdateMediaBuy(state, { daily_budget_cap: null }).ok, true);
  assert.equal(preflightUpdateMediaBuy(state, { packages: [{ package_id: 'p1', daily_budget_cap: null }] }).ok, true);
  const bounded = buy([term('increase_budget', { constraints: { kind: 'budget', max_delta_percent: 10 } })], {
    daily_budget_cap: 100,
  });
  assert.equal(
    assessActionAvailability(bounded, 'increase_budget', { request: { daily_budget_cap: null } }).constraints
      .constraint,
    'unbounded_result'
  );
});

test('malformed JSON gets typed seller errors and assignment removal has its own right', () => {
  const { assertUpdateMediaBuyAllowed } = require('../../dist/lib/server/media-buy-actions.js');
  const { preflightMediaBuyActions } = require('../../dist/lib/media-buy/actions.js');
  for (const request of [
    { paused: true, total_budget: null },
    { paused: true, new_packages: null },
    { packages: {} },
    { packages: [null] },
    { packages: [{ package_id: 'p1', targeting_overlay: null }] },
    { packages: [{ package_id: 'p1', creatives: [] }] },
  ]) {
    assert.throws(
      () => assertUpdateMediaBuyAllowed(buy(), request),
      error => error.code === 'INVALID_REQUEST'
    );
    assert.equal(preflightMediaBuyActions(buy(), request).ok, false);
  }
  const remove = { packages: [{ package_id: 'p1', creative_assignments: [] }] };
  assert.equal(preflightUpdateMediaBuy(buy([term('remove_creative')]), remove).ok, true);
  assert.equal(preflightUpdateMediaBuy(buy([term('replace_creative')]), remove).ok, false);
  assert.throws(
    () =>
      assertUpdateMediaBuyAllowed(
        buy([term('extend_flight')]),
        { end_time: '2027-02-02T00:00:00Z' },
        { task: 'control_media_buy' }
      ),
    error => error.code === 'ACTION_NOT_ALLOWED'
  );
});

test('advisory product differences do not override a live negotiated grant; coarse bounds remain usable', () => {
  const state = buy([term('increase_budget')]);
  const product = { allowed_actions: [{ action: 'pause', modes: ['self_serve'] }] };
  const result = assessMediaBuyAction({ action: 'increase_budget', product, buy: state });
  assert.equal(result.possibility.status, 'unsupported');
  assert.equal(result.availability.status, 'available_now');
  const coarse = {
    allowed_actions: [
      { action: 'update_budget', modes: ['self_serve'], constraints: { kind: 'budget', max_delta_percent: 10 } },
    ],
  };
  assert.equal(assessProductAction(coarse, 'increase_budget').status, 'possible');
  assert.equal(
    mediaBuyActionResolver.materialize({
      products: [coarse],
      acceptedTerms: [term('increase_budget')],
      sellerAccepted: true,
    })[0].constraints.max_delta_percent,
    10
  );
});

test('rc.3 seller emission requires a matching served version and error details obey the pinned schema', () => {
  const { readFileSync } = require('node:fs');
  const { join } = require('node:path');
  const Ajv = require('ajv');
  const addFormats = require('ajv-formats');
  const version = require('../../package.json').adcp_version;
  const ajv = new Ajv({ strict: false });
  addFormats(ajv);
  const seen = new Set();
  function add(relative) {
    const schema = JSON.parse(readFileSync(join('schemas/cache', version, relative), 'utf8'));
    if (seen.has(schema.$id)) return schema.$id;
    seen.add(schema.$id);
    ajv.addSchema(schema);
    function walk(value) {
      if (!value || typeof value !== 'object') return;
      if (value.$ref?.includes(`/schemas/${version}/`)) add(value.$ref.split(`/schemas/${version}/`)[1].split('#')[0]);
      Object.values(value).forEach(walk);
    }
    walk(schema);
    return schema.$id;
  }
  const errorId = add('core/error.json');
  const detailsId = add('error-details/action-not-allowed.json');
  const valid = ajv.getSchema(detailsId);
  const scoped = buy([term('increase_budget')]);
  const old = mediaBuyActionResolver.resolve({
    buy: scoped,
    adcpVersion: '3.2.0-rc.2',
    decide: () => ({ ...accept(), applicable_package_ids: ['p1'] }),
  });
  assert.equal(old.available_actions.length, 0);
  const cap = buy([term('update_media_buy_frequency_cap')]);
  assert.equal(
    mediaBuyActionResolver.resolve({ buy: cap, adcpVersion: '3.2.0-rc.2', decide: accept }).available_actions.length,
    0
  );
  const { assertUpdateMediaBuyAllowed } = require('../../dist/lib/server/media-buy-actions.js');
  const bounded = term('increase_budget', { constraints: { kind: 'budget', max_delta_percent: 10 } });
  for (const [state, request, code] of [
    [buy([bounded]), { total_budget: { amount: 2000, currency: 'USD' } }, 'REQUOTE_REQUIRED'],
    [buy([bounded]), { total_budget: { amount: 1100, currency: 'EUR' } }, 'REQUOTE_REQUIRED'],
    [buy([bounded], { daily_budget_cap: 100 }), { daily_budget_cap: null }, 'REQUOTE_REQUIRED'],
    [buy(), { paused: true, revision: 1 }, 'CONFLICT'],
  ]) {
    assert.throws(
      () => assertUpdateMediaBuyAllowed(state, request),
      error => {
        assert.equal(error.code, code);
        const wire = {
          code: error.code,
          message: error.message,
          recovery: error.recovery,
          field: error.field,
          ...(error.details && { details: error.details }),
        };
        const validate = ajv.getSchema(errorId);
        assert.equal(validate(wire), true, JSON.stringify(validate.errors));
        return true;
      }
    );
  }
  for (const [state, request] of [
    [buy(), { total_budget: { amount: 1100, currency: 'USD' } }],
    [buy([term('update_spend_target')]), { paused: true }],
    [buy(), { packages: [{ package_id: 'p1', keyword_targets_add: ['run'] }] }],
  ]) {
    assert.throws(
      () => assertUpdateMediaBuyAllowed(state, request, { task: 'control_media_buy' }),
      error => {
        assert.equal(error.code, 'ACTION_NOT_ALLOWED');
        if (error.details) assert.equal(valid(error.details), true, JSON.stringify(valid.errors));
        return true;
      }
    );
  }
});

test('the update facade subsumes compact routes for single and atomic mixed actions', () => {
  const { preflightMediaBuyActions } = require('../../dist/lib/media-buy/actions.js');
  const { assertUpdateMediaBuyAllowed } = require('../../dist/lib/server/media-buy-actions.js');
  const state = buy([term('update_targeting'), term('update_creative_assignments')]);
  const target = { package_id: 'p1', targeting_overlay: { geo_countries: ['US'] } };
  const assignment = { package_id: 'p1', creative_assignments: [{ creative_id: 'c1', weight: 1 }] };
  for (const [action, patch, task] of [
    ['update_targeting', target, 'control_media_buy'],
    ['update_creative_assignments', assignment, 'sync_creatives'],
  ]) {
    assert.equal(
      assessActionAvailability(state, action, { request: { packages: [patch] }, task: 'update_media_buy' }).status,
      'available_now'
    );
    assert.equal(preflightMediaBuyActions(state, { packages: [patch] }, { task }).ok, true);
    assert.equal(
      preflightMediaBuyActions(
        state,
        { packages: [patch] },
        { task: task === 'control_media_buy' ? 'sync_creatives' : 'control_media_buy' }
      ).ok,
      false
    );
    assert.equal(assertUpdateMediaBuyAllowed(state, { packages: [patch] }).ok, true);
  }
  const request = { packages: [{ ...target, ...assignment }] };
  assert.equal(preflightMediaBuyActions(state, request, { task: 'update_media_buy' }).ok, true);
  assert.equal(preflightUpdateMediaBuy(state, request).ok, true);
  assert.equal(assertUpdateMediaBuyAllowed(state, request, { task: 'update_media_buy' }).ok, true);
  for (const task of ['control_media_buy', 'sync_creatives', 'refine_proposals']) {
    assert.equal(preflightMediaBuyActions(state, request, { task }).ok, false);
    assert.throws(
      () => assertUpdateMediaBuyAllowed(state, request, { task }),
      e => e.code === 'ACTION_NOT_ALLOWED'
    );
  }
  state.available_actions.pop();
  assert.equal(preflightMediaBuyActions(state, request, { task: 'update_media_buy' }).ok, false);
});

test('a separately supplied accepted proposal drives the same canonical decomposition and bounds', () => {
  const { preflightMediaBuyActions } = require('../../dist/lib/media-buy/actions.js');
  const { assertUpdateMediaBuyAllowed } = require('../../dist/lib/server/media-buy-actions.js');
  const state = buy([
    term('update_spend_target', {
      constraints: { kind: 'budget', max_result_amount: { amount: 200, currency: 'USD' } },
    }),
  ]);
  const { accepted_proposal: proposal, ...separate } = state;
  for (const min_spend_target of [100, 300]) {
    const request = { packages: [{ package_id: 'p1', min_spend_target }] };
    assert.deepEqual(preflightUpdateMediaBuy(separate, request, { proposal }), preflightUpdateMediaBuy(state, request));
    assert.deepEqual(
      preflightMediaBuyActions(separate, request, { proposal }),
      preflightMediaBuyActions(state, request)
    );
    assert.equal(preflightMediaBuyActions(separate, request, { proposal }).ok, min_spend_target === 100);
  }
  assert.equal(
    assertUpdateMediaBuyAllowed(separate, { packages: [{ package_id: 'p1', min_spend_target: 100 }] }, { proposal })
      .actions[0].action,
    'update_spend_target'
  );
  assert.equal(
    assessActionAvailability(separate, 'update_spend_target', {
      proposal: { ...proposal, proposal_status: 'proposed' },
    }).certainty,
    'unknown'
  );
});

test('unaccounted added-package budgets cannot pass portable result bounds', () => {
  const bounded = term('increase_budget', {
    constraints: { kind: 'budget', max_result_amount: { amount: 2000, currency: 'USD' } },
  });
  const state = buy([bounded, term('add_packages')]);
  for (const new_packages of [[{ product_id: 'new' }], [{ product_id: 'new', budget: 9000 }]]) {
    const request = { total_budget: { amount: 1100, currency: 'USD' }, new_packages };
    assert.equal(constraint(bounded, state, request).status, 'unknown');
    assert.equal(preflightUpdateMediaBuy(state, request).ok, false);
  }
});

test('opposite package budget movements neither conceal nor fabricate directional bound violations', () => {
  const increase = term('increase_budget', {
    constraints: { kind: 'budget', max_delta_amount: { amount: 100, currency: 'USD' } },
  });
  const decrease = term('decrease_budget', {
    constraints: { kind: 'budget', max_delta_amount: { amount: 300, currency: 'USD' } },
  });
  const state = buy([increase, decrease]);
  for (const [next, expected] of [
    [650, 'satisfied'],
    [750, 'exceeded'],
  ]) {
    const request = {
      packages: [
        { package_id: 'p1', budget: next },
        { package_id: 'p2', budget: 200 },
      ],
    };
    assert.equal(constraint(increase, state, request).status, expected);
    assert.equal(constraint(decrease, state, request).status, 'satisfied');
  }
  const request = {
    packages: [
      { package_id: 'p1', budget: 950 },
      { package_id: 'p2', budget: 350 },
    ],
  };
  assert.equal(constraint(increase, state, request).status, 'exceeded');
  assert.equal(constraint(decrease, state, request).status, 'satisfied');
});

test('unknown legacy structured modes cannot become executable through exact or coarse lookup', () => {
  const { canIncreaseBudget } = require('../../dist/lib/media-buy/index.js');
  for (const action of ['increase_budget', 'update_budget']) {
    const state = {
      available_actions: [{ action, mode: 'future_opaque_mode' }],
      packages: [{ package_id: 'p1', budget: 100 }],
    };
    assert.equal(preflightUpdateMediaBuy(state, { packages: [{ package_id: 'p1', budget: 110 }] }).ok, false);
    assert.equal(canIncreaseBudget(state), false);
  }
});

test('mixed allocation changes evaluate the resulting total and preserve returned accepted bounds', () => {
  const bounded = term('update_budget_allocation', {
    constraints: { kind: 'budget', max_result_amount: { amount: 1500, currency: 'USD' } },
  });
  const state = buy([bounded, term('increase_budget')]);
  const request = { total_budget: { amount: 2000, currency: 'USD' }, budget_allocation: { mode: 'fixed' } };
  assert.equal(constraint(bounded, state, request).status, 'exceeded');
  assert.equal(preflightUpdateMediaBuy(state, request).ok, false);
  request.total_budget.amount = 1100;
  const projection = mediaBuyActionResolver.resolve({ buy: state, decide: accept, request });
  assert.deepEqual(
    projection.request_assessments.find(a => a.action === 'update_budget_allocation').term.constraints,
    bounded.constraints
  );
  assert.deepEqual(state.accepted_proposal.commercial_terms.change_terms[0].constraints, bounded.constraints);
});

test('legacy compatibility never discards an explicit current package scope or compact task', () => {
  const { assertUpdateMediaBuyAllowed } = require('../../dist/lib/server/media-buy-actions.js');
  const state = {
    packages: [
      { package_id: 'p1', budget: 100 },
      { package_id: 'p2', budget: 100 },
    ],
    available_actions: [
      { action: 'increase_budget', mode: 'self_serve', task: 'control_media_buy', applicable_package_ids: ['p1'] },
    ],
  };
  for (const request of [
    { packages: [{ package_id: 'p2', budget: 110 }] },
    { total_budget: { amount: 110, currency: 'USD' } },
  ]) {
    assert.equal(preflightUpdateMediaBuy(state, request).ok, false);
    assert.throws(
      () => assertUpdateMediaBuyAllowed(state, request),
      e => e.code === 'ACTION_NOT_ALLOWED'
    );
  }
  const allowed = { packages: [{ package_id: 'p1', budget: 110 }] };
  assert.equal(preflightUpdateMediaBuy(state, allowed).ok, true);
  assert.equal(preflightUpdateMediaBuy(state, allowed, { task: 'sync_creatives' }).ok, false);
  state.available_actions[0].applicable_package_ids = [];
  assert.equal(preflightUpdateMediaBuy(state, allowed).ok, false);
});

test('explicit legacy scope also rejects opaque unmapped sibling mutations', () => {
  const { assertUpdateMediaBuyAllowed } = require('../../dist/lib/server/media-buy-actions.js');
  const state = {
    packages: [{ package_id: 'p1', budget: 100 }],
    available_actions: [{ action: 'increase_budget', mode: 'self_serve', applicable_package_ids: ['p1'] }],
  };
  const request = {
    packages: [
      { package_id: 'p1', budget: 110 },
      { package_id: 'p2', ext: { vendor: { controls: 1 } } },
    ],
  };
  assert.throws(() => preflightUpdateMediaBuy(state, request), /no supported action mapping/);
  assert.throws(
    () => assertUpdateMediaBuyAllowed(state, request),
    e => e.code === 'INVALID_REQUEST'
  );
});

test('terminal package state overrides stale pause toggles in preflight and live projection', () => {
  for (const action of ['pause', 'resume']) {
    for (const terminal of [
      { canceled: true },
      { status: 'canceled' },
      { status: 'completed' },
      { status: 'failed' },
      { status: 'rejected' },
    ]) {
      const state = buy([term(action)], { packages: [{ package_id: 'p1', paused: action === 'resume', ...terminal }] });
      const request = { packages: [{ package_id: 'p1', paused: action === 'pause' }] };
      assert.equal(preflightUpdateMediaBuy(state, request).ok, false);
      assert.equal(assessActionAvailability(state, action, { request }).reason, 'wrong_status');
      assert.equal(
        mediaBuyActionResolver.resolve({
          buy: state,
          adcpVersion: '3.2.0-rc.3',
          decide: () => ({ ...accept(), applicable_package_ids: ['p1'] }),
        }).available_actions.length,
        0
      );
    }
  }
});

test('seller lifecycle scope respects default unpaused state and excludes explicit unknown state', () => {
  const state = buy([term('pause'), term('resume')], {
    packages: [
      { package_id: 'p1', paused: false },
      { package_id: 'p2', paused: true },
      { package_id: 'p3' },
      { package_id: 'p4', status: 'unrecognized' },
    ],
  });
  const projection = mediaBuyActionResolver.resolve({
    buy: state,
    adcpVersion: '3.2.0-rc.3',
    decide: () => ({ ...accept(), applicable_package_ids: ['p1', 'p2', 'p3', 'p4'] }),
  });
  assert.deepEqual(projection.available_actions.find(a => a.action === 'pause').applicable_package_ids, ['p1', 'p3']);
  assert.deepEqual(projection.available_actions.find(a => a.action === 'resume').applicable_package_ids, ['p2']);
});

test('plain legacy grants cannot hide governance-bearing or opaque siblings and errors retain no request payload', () => {
  const { assertUpdateMediaBuyAllowed } = require('../../dist/lib/server/media-buy-actions.js');
  const state = { available_actions: [{ action: 'pause', mode: 'self_serve' }] };
  for (const extra of [
    { invoice_recipient: { name: 'Recipient' } },
    { reporting_webhook: { url: 'https://buyer.example/report' } },
    { ext: { vendor: { controls: 1 } } },
  ]) {
    const request = { paused: true, governance_context: 'private-authorization', ...extra };
    assert.throws(
      () => preflightUpdateMediaBuy(state, request),
      e => e.details.value === undefined
    );
    assert.throws(
      () => assertUpdateMediaBuyAllowed(state, request),
      e => e.code === 'INVALID_REQUEST'
    );
  }
});

test('separate proposal snapshots need accepted status and explicit current identity before granting authority', () => {
  const { preflightMediaBuyActions } = require('../../dist/lib/media-buy/actions.js');
  const state = buy();
  const { accepted_proposal, accepted_proposal_id, ...separate } = state;
  const proposal = { commercial_terms: accepted_proposal.commercial_terms };
  for (const snapshot of [
    proposal,
    { ...proposal, proposal_status: 'accepted' },
    { ...proposal, media_buy_id: 'other-buy', proposal_status: 'accepted' },
  ]) {
    assert.equal(assessActionAvailability(separate, 'pause', { proposal: snapshot }).certainty, 'unknown');
    assert.equal(preflightUpdateMediaBuy(separate, { paused: true }, { proposal: snapshot }).ok, false);
    assert.equal(preflightMediaBuyActions(separate, { paused: true }, { proposal: snapshot }).ok, false);
  }
});

test('served version is explicit at both seller emission and assertion boundaries', () => {
  const { assertUpdateMediaBuyAllowed } = require('../../dist/lib/server/media-buy-actions.js');
  const state = buy([term('increase_budget')]);
  state.available_actions[0].applicable_package_ids = ['p1'];
  const request = { packages: [{ package_id: 'p1', budget: 650 }] };
  const defaultProjection = mediaBuyActionResolver.resolve({
    buy: state,
    decide: () => ({ ...accept(), applicable_package_ids: ['p1'] }),
  });
  assert.deepEqual(defaultProjection.available_actions[0].applicable_package_ids, ['p1']);
  assert.equal(assertUpdateMediaBuyAllowed(state, request).ok, true);
  assert.equal(assertUpdateMediaBuyAllowed(state, request, { adcpVersion: '3.2.0-rc.3' }).ok, true);
  assert.throws(
    () => assertUpdateMediaBuyAllowed(state, request, { adcpVersion: '3.2.0-rc.2' }),
    e => e.code === 'ACTION_NOT_ALLOWED'
  );
});

test('legacy compatibility enforces served versions for native shared caps and package scope', () => {
  const { assertUpdateMediaBuyAllowed } = require('../../dist/lib/server/media-buy-actions.js');
  for (const [entry, request] of [
    [{ action: 'update_media_buy_frequency_cap' }, { frequency_cap: null }],
    [{ action: 'increase_budget', applicable_package_ids: ['p1'] }, { packages: [{ package_id: 'p1', budget: 650 }] }],
  ]) {
    const state = {
      status: 'active',
      packages: [{ package_id: 'p1', budget: 600 }],
      available_actions: [{ ...entry, mode: 'self_serve', task: 'control_media_buy' }],
    };
    for (const adcpVersion of ['3.1.19', '3.2.0-beta.8', '3.2.0-rc.2']) {
      const result = preflightUpdateMediaBuy(state, request, { adcpVersion });
      assert.equal(result.ok, false, adcpVersion);
      assert.equal(result.denials[0].reason, 'condition_unresolved');
      assert.match(result.denials[0].assessment.message, /seller version/);
      assert.throws(
        () => assertUpdateMediaBuyAllowed(state, request, { adcpVersion }),
        error => error.code === 'ACTION_NOT_ALLOWED'
      );
    }
    assert.equal(preflightUpdateMediaBuy(state, request, { adcpVersion: '3.2.0-rc.3' }).ok, true);
    assert.equal(assertUpdateMediaBuyAllowed(state, request, { adcpVersion: '3.2.0-rc.3' }).ok, true);
  }
});

test('missing stored budget stays unknown rather than throwing a raw property error', () => {
  const state = buy([term('increase_budget')], { total_budget: null });
  const request = { total_budget: { amount: 1100, currency: 'USD' } };
  assert.equal(preflightUpdateMediaBuy(state, request).ok, false);
});

test('flat action hints never create metadata execution authority in compatibility preflight or seller assertion', () => {
  const { assertUpdateMediaBuyAllowed } = require('../../dist/lib/server/media-buy-actions.js');
  const state = { status: 'active', valid_actions: ['update_name'] };
  assert.equal(preflightUpdateMediaBuy(state, { name: 'Changed' }).ok, false);
  assert.throws(
    () => assertUpdateMediaBuyAllowed(state, { name: 'Changed' }),
    e => e.code === 'ACTION_NOT_ALLOWED'
  );
  const structured = {
    status: 'active',
    available_actions: [{ action: 'update_name', mode: 'self_serve', task: 'control_media_buy' }],
  };
  assert.equal(preflightUpdateMediaBuy(structured, { name: 'Changed' }).ok, true);
  assert.equal(assertUpdateMediaBuyAllowed(structured, { name: 'Changed' }).ok, true);
});

test('add-only requests cannot bypass monetary assessment through package-count rights', () => {
  const { preflightMediaBuyActions } = require('../../dist/lib/media-buy/actions.js');
  const { assertUpdateMediaBuyAllowed } = require('../../dist/lib/server/media-buy-actions.js');
  for (const terms of [
    [term('add_packages')],
    [
      term('add_packages'),
      term('increase_budget', {
        constraints: { kind: 'budget', max_result_amount: { amount: 2000, currency: 'USD' } },
      }),
    ],
  ]) {
    const state = buy(terms);
    for (const money of [{ budget: 9000 }, { min_spend_target: 9000 }, { daily_budget_cap: 9000 }]) {
      const request = { new_packages: [{ product_id: 'new', pricing_option_id: 'price', ...money }] };
      const result = assessActionAvailability(state, 'add_packages', { request });
      assert.equal(result.certainty, 'unknown');
      assert.equal(result.constraints.constraint, 'added_package_budget');
      assert.equal(preflightMediaBuyActions(state, request).ok, false);
      assert.equal(preflightUpdateMediaBuy(state, request).ok, false);
      assert.throws(
        () => assertUpdateMediaBuyAllowed(state, request),
        e => e.code === 'ACTION_NOT_ALLOWED'
      );
    }
  }
});

test('opaque new-package extensions never ride an add-package grant', () => {
  const { preflightMediaBuyActions } = require('../../dist/lib/media-buy/actions.js');
  const { assertUpdateMediaBuyAllowed } = require('../../dist/lib/server/media-buy-actions.js');
  for (const state of [buy([term('add_packages')]), { valid_actions: ['add_packages'] }]) {
    const request = { new_packages: [{ product_id: 'new', ext: { vendor: { controls: 1 } } }] };
    assert.equal(preflightMediaBuyActions(state, request).ok, false);
    assert.throws(
      () => assertUpdateMediaBuyAllowed(state, request),
      e => e.code === 'INVALID_REQUEST'
    );
  }
});

test('explicit negotiated lifecycle scope admits pending hold controls without widening legacy defaults', () => {
  const { preflightMediaBuyActions } = require('../../dist/lib/media-buy/actions.js');
  const { assertUpdateMediaBuyAllowed } = require('../../dist/lib/server/media-buy-actions.js');
  for (const status of ['pending_creatives', 'pending_start']) {
    for (const action of ['pause', 'resume']) {
      for (const service_mode of ['self_serve', 'seller_managed']) {
        const right = term(action, { allowed_statuses: [status], service_mode });
        const state = buy([right], { status, paused: action === 'resume' });
        const request = { paused: action === 'pause', revision: 3 };
        assert.equal(state.available_actions.length, 1, `${status}/${action}/${service_mode} projection`);
        assert.equal(state.available_actions[0].mode, service_mode);
        assert.equal(assessActionAvailability(state, action, { request }).status, 'available_now');
        assert.equal(assessMediaBuyAction({ action, buy: state, request }).availability.status, 'available_now');
        assert.equal(preflightMediaBuyActions(state, request).ok, true);
        assert.equal(preflightUpdateMediaBuy(state, request).ok, true);
        assert.equal(assertUpdateMediaBuyAllowed(state, request).ok, true);
        for (const otherStatus of ['active', 'paused', 'completed', 'canceled', 'failed', 'rejected']) {
          const outside = { ...state, status: otherStatus };
          assert.equal(assessActionAvailability(outside, action, { request }).reason, 'wrong_status');
          assert.equal(mediaBuyActionResolver.resolve({ buy: outside, decide: accept }).available_actions.length, 0);
        }
        assert.equal(
          mediaBuyActionResolver.resolve({ buy: state, decide: () => ({ ...accept(), policy: 'unknown' }) })
            .available_actions.length,
          0
        );
        const mismatched = {
          ...state,
          available_actions: [{ ...state.available_actions[0], change_term_id: 'other' }],
        };
        assert.equal(assessActionAvailability(mismatched, action, { request }).certainty, 'unknown');
        assert.equal(
          assessActionAvailability(state, action, { request: { ...request, revision: 2 } }).code,
          'CONFLICT'
        );
      }
      const legacyDefault = buy([term(action)], { status });
      assert.equal(assessActionAvailability(legacyDefault, action).reason, 'wrong_status');
      assert.equal(legacyDefault.available_actions.length, 0);
    }
  }
});

test('metadata rename needs a current structured grant but no commercial snapshot hydration', () => {
  const { preflightMediaBuyActions } = require('../../dist/lib/media-buy/actions.js');
  const { assertUpdateMediaBuyAllowed } = require('../../dist/lib/server/media-buy-actions.js');
  const state = {
    media_buy_id: 'buy1',
    status: 'active',
    revision: 3,
    accepted_proposal_id: 'proposal1',
    accepted_proposal_digest: 'opaque-verified-digest',
    available_actions: [{ action: 'update_name', mode: 'self_serve', task: 'control_media_buy' }],
  };
  const request = { name: 'Updated name', revision: 3 };
  const result = assessActionAvailability(state, 'update_name', { request });
  assert.equal(result.status, 'available_now');
  assert.equal(result.authority, 'live_metadata');
  assert.equal(result.term, undefined);
  assert.equal(
    assessMediaBuyAction({ action: 'update_name', buy: state, request }).availability.status,
    'available_now'
  );
  assert.equal(preflightMediaBuyActions(state, request).ok, true);
  assert.equal(preflightUpdateMediaBuy(state, request).ok, true);
  assert.equal(assertUpdateMediaBuyAllowed(state, request).ok, true);
  assert.deepEqual(
    mediaBuyActionResolver.resolve({ buy: state, decide: accept, metadata: { update_name: accept() } })
      .available_actions,
    state.available_actions
  );
  assert.equal(
    mediaBuyActionResolver.resolve({
      buy: state,
      decide: accept,
      metadata: { update_name: { ...accept(), authorization: false } },
    }).available_actions.length,
    0
  );
  for (const proposal of [
    { proposal_id: 'other', proposal_status: 'accepted', media_buy_id: 'buy1' },
    { proposal_id: 'proposal1', proposal_status: 'draft', media_buy_id: 'buy1' },
    { proposal_id: 'proposal1', proposal_status: 'accepted', media_buy_id: 'other' },
  ]) {
    assert.equal(assessActionAvailability(state, 'update_name', { request, proposal }).certainty, 'unknown');
    assert.equal(
      assessActionAvailability({ ...state, accepted_proposal: proposal }, 'update_name', { request }).certainty,
      'unknown'
    );
  }
  assert.equal(
    assessActionAvailability(state, 'update_name', { request: { ...request, revision: 2 } }).code,
    'CONFLICT'
  );
  assert.equal(
    assessActionAvailability({ ...state, status: 'completed' }, 'update_name', { request }).reason,
    'wrong_status'
  );
  assert.equal(
    assessActionAvailability(
      { ...state, available_actions: undefined, valid_actions: ['update_name'] },
      'update_name',
      { request }
    ).certainty,
    'unknown'
  );
  assert.equal(
    assessActionAvailability(state, 'pause', { request: { paused: true } }).compat.reason,
    'no_change_terms'
  );
  const opaque = { ...request, ext: { vendor: { controls: 1 } } };
  assert.equal(assessActionAvailability(state, 'update_name', { request: opaque }).certainty, 'unknown');
  assert.equal(preflightMediaBuyActions(state, opaque).ok, false);
  assert.throws(
    () => assertUpdateMediaBuyAllowed(state, opaque),
    e => e.code === 'INVALID_REQUEST'
  );
});

test('package pause uses schema default false only for an existing nonterminal package', () => {
  const { preflightMediaBuyActions } = require('../../dist/lib/media-buy/actions.js');
  const { assertUpdateMediaBuyAllowed } = require('../../dist/lib/server/media-buy-actions.js');
  for (const current of [{ package_id: 'p1' }, { package_id: 'p1', paused: false }]) {
    const state = buy([term('pause')], { packages: [current] });
    state.available_actions = mediaBuyActionResolver.resolve({
      buy: state,
      decide: () => ({ ...accept(), applicable_package_ids: ['p1'] }),
    }).available_actions;
    assert.equal(state.available_actions.length, 1);
    const request = { packages: [{ package_id: 'p1', paused: true }] };
    assert.equal(assessActionAvailability(state, 'pause', { request }).status, 'available_now');
    assert.equal(assessMediaBuyAction({ action: 'pause', buy: state, request }).availability.status, 'available_now');
    assert.equal(preflightMediaBuyActions(state, request).ok, true);
    assert.equal(preflightUpdateMediaBuy(state, request).ok, true);
    assert.equal(assertUpdateMediaBuyAllowed(state, request).ok, true);
    for (const packages of [
      [],
      undefined,
      [{ package_id: 'p1', status: 'unrecognized' }],
      [{ package_id: 'p1', canceled: true }],
    ]) {
      assert.equal(preflightMediaBuyActions({ ...state, packages }, request).ok, false);
      assert.equal(
        mediaBuyActionResolver.resolve({
          buy: { ...state, packages },
          decide: () => ({ ...accept(), applicable_package_ids: ['p1'] }),
        }).available_actions.length,
        0
      );
    }
  }
});

test('direct and unified availability reject opaque new-package extensions consistently with whole preflight', () => {
  const { preflightMediaBuyActions } = require('../../dist/lib/media-buy/actions.js');
  const { assertUpdateMediaBuyAllowed } = require('../../dist/lib/server/media-buy-actions.js');
  const state = buy([term('add_packages')], { budget_allocation: 'seller_optimized' });
  const clean = { new_packages: [{ product_id: 'new', pricing_option_id: 'price' }] };
  assert.equal(assessActionAvailability(state, 'add_packages', { request: clean }).status, 'available_now');
  for (const ext of [{ vendor: { controls: 1 } }, {}, null]) {
    const request = { new_packages: [{ ...clean.new_packages[0], ext }] };
    for (const assessment of [
      assessActionAvailability(state, 'add_packages', { request }),
      assessMediaBuyAction({ action: 'add_packages', buy: state, request }).availability,
    ]) {
      assert.equal(assessment.status, 'currently_unavailable');
      assert.equal(assessment.reason, 'condition_unresolved');
      assert.equal(assessment.certainty, 'unknown');
    }
    assert.equal(preflightMediaBuyActions(state, request).ok, false);
    assert.throws(() => preflightUpdateMediaBuy(state, request), /no supported action mapping/);
    assert.throws(
      () => assertUpdateMediaBuyAllowed(state, request),
      e => e.code === 'INVALID_REQUEST'
    );
    const projection = mediaBuyActionResolver.resolve({ buy: state, decide: accept, request });
    assert.equal(projection.request_assessments[0].certainty, 'unknown');
    assert.equal(projection.available_actions.length, 1, 'request refusal does not erase the bounded right');
  }
});

test('explicit unknown package status outranks either pause flag in assessment and seller scope', () => {
  const { preflightMediaBuyActions } = require('../../dist/lib/media-buy/actions.js');
  const { assertUpdateMediaBuyAllowed } = require('../../dist/lib/server/media-buy-actions.js');
  for (const paused of [undefined, false, true]) {
    for (const action of ['pause', 'resume']) {
      const state = buy([term(action)], { packages: [{ package_id: 'p1', status: 'unrecognized', paused }] });
      const request = { packages: [{ package_id: 'p1', paused: action === 'pause' }] };
      const assessment = assessActionAvailability(state, action, { request });
      assert.equal(assessment.status, 'currently_unavailable');
      assert.equal(assessment.certainty, 'unknown');
      assert.equal(preflightMediaBuyActions(state, request).ok, false);
      assert.equal(preflightUpdateMediaBuy(state, request).ok, false);
      assert.throws(
        () => assertUpdateMediaBuyAllowed(state, request),
        e => e.code === 'ACTION_NOT_ALLOWED'
      );
      assert.equal(
        mediaBuyActionResolver.resolve({ buy: state, decide: () => ({ ...accept(), applicable_package_ids: ['p1'] }) })
          .available_actions.length,
        0
      );
    }
  }
});

test('pending package controls require explicit negotiated buy-status scope too', () => {
  const { preflightMediaBuyActions } = require('../../dist/lib/media-buy/actions.js');
  const { assertUpdateMediaBuyAllowed } = require('../../dist/lib/server/media-buy-actions.js');
  for (const status of ['pending_creatives', 'pending_start']) {
    for (const action of ['pause', 'resume']) {
      const state = buy([term(action)], {
        status,
        packages: [{ package_id: 'p1', paused: action === 'resume' }],
        available_actions: [
          {
            action,
            mode: 'self_serve',
            task: 'control_media_buy',
            change_term_id: `right_${action}`,
            applicable_package_ids: ['p1'],
          },
        ],
      });
      const request = { packages: [{ package_id: 'p1', paused: action === 'pause' }] };
      assert.equal(assessActionAvailability(state, action, { request }).reason, 'wrong_status');
      assert.equal(preflightMediaBuyActions(state, request).ok, false);
      assert.equal(preflightUpdateMediaBuy(state, request).ok, false);
      assert.throws(
        () => assertUpdateMediaBuyAllowed(state, request),
        e => e.code === 'ACTION_NOT_ALLOWED'
      );
      const decide = () => ({ ...accept(), applicable_package_ids: ['p1'] });
      assert.equal(mediaBuyActionResolver.resolve({ buy: state, decide }).available_actions.length, 0);
      state.accepted_proposal.commercial_terms.change_terms[0].allowed_statuses = [status];
      assert.equal(assessActionAvailability(state, action, { request }).status, 'available_now');
      assert.equal(preflightMediaBuyActions(state, request).ok, true);
      assert.equal(preflightUpdateMediaBuy(state, request).ok, true);
      assert.equal(mediaBuyActionResolver.resolve({ buy: state, decide }).available_actions.length, 1);
    }
  }
});

test('explicit false never overrides a locally pending package status', () => {
  const { preflightMediaBuyActions } = require('../../dist/lib/media-buy/actions.js');
  const { assertUpdateMediaBuyAllowed } = require('../../dist/lib/server/media-buy-actions.js');
  for (const status of ['pending_creatives', 'pending_start']) {
    for (const paused of [undefined, false]) {
      const state = buy([term('pause')], { packages: [{ package_id: 'p1', status, paused }] });
      const request = { packages: [{ package_id: 'p1', paused: true }] };
      assert.equal(assessActionAvailability(state, 'pause', { request }).reason, 'wrong_status');
      assert.equal(preflightMediaBuyActions(state, request).ok, false);
      assert.equal(preflightUpdateMediaBuy(state, request).ok, false);
      assert.throws(
        () => assertUpdateMediaBuyAllowed(state, request),
        e => e.code === 'ACTION_NOT_ALLOWED'
      );
      assert.equal(
        mediaBuyActionResolver.resolve({ buy: state, decide: () => ({ ...accept(), applicable_package_ids: ['p1'] }) })
          .available_actions.length,
        0
      );
    }
  }
});

test('a modern term-linked projection cannot downgrade to legacy compatibility when its snapshot is missing', () => {
  const { preflightMediaBuyActions } = require('../../dist/lib/media-buy/actions.js');
  const { assertUpdateMediaBuyAllowed } = require('../../dist/lib/server/media-buy-actions.js');
  const state = buy([term('increase_budget', { constraints: { kind: 'budget', max_delta_percent: 10 } })]);
  const proposal = state.accepted_proposal;
  delete state.accepted_proposal;
  const request = { total_budget: { amount: 10000, currency: 'USD' } };
  const missing = preflightUpdateMediaBuy(state, request);
  assert.equal(missing.ok, false);
  assert.equal(missing.denials[0].assessment.compat.reason, 'no_change_terms');
  assert.equal(preflightMediaBuyActions(state, request).ok, false);
  assert.throws(
    () => assertUpdateMediaBuyAllowed(state, request),
    e => e.code === 'ACTION_NOT_ALLOWED'
  );
  assert.equal(preflightUpdateMediaBuy(state, request, { proposal }).ok, false);
  assert.equal(
    preflightUpdateMediaBuy(state, { total_budget: { amount: 1050, currency: 'USD' } }, { proposal }).ok,
    true
  );
  const legacy = {
    ...state,
    available_actions: [{ action: 'increase_budget', mode: 'self_serve', terms_ref: 'opaque-3.1-reference' }],
  };
  assert.equal(preflightUpdateMediaBuy(legacy, request, { adcpVersion: '3.1.19' }).ok, true);
  assert.equal(assessActionAvailability(legacy, 'increase_budget', { request }).certainty, 'unknown');
});

test('explicit local pending package status outranks every pause flag for scoped resume', () => {
  const { preflightMediaBuyActions } = require('../../dist/lib/media-buy/actions.js');
  const { assertUpdateMediaBuyAllowed } = require('../../dist/lib/server/media-buy-actions.js');
  for (const status of ['pending_start', 'pending_creatives']) {
    for (const paused of [true, false, undefined]) {
      for (const buyStatus of ['active', status]) {
        const state = buy([term('resume', buyStatus === 'active' ? {} : { allowed_statuses: [buyStatus] })], {
          status: buyStatus,
          packages: [{ package_id: 'p1', status, ...(paused !== undefined && { paused }) }],
          available_actions: [
            {
              action: 'resume',
              mode: 'self_serve',
              task: 'control_media_buy',
              change_term_id: 'right_resume',
              applicable_package_ids: ['p1'],
            },
          ],
        });
        const request = { packages: [{ package_id: 'p1', paused: false }] };
        for (const assessment of [
          assessActionAvailability(state, 'resume', { request }),
          assessMediaBuyAction({ action: 'resume', buy: state, request }).availability,
        ]) {
          assert.equal(assessment.status, 'currently_unavailable', `${buyStatus}/${status}/${paused}`);
          assert.equal(assessment.reason, 'wrong_status');
        }
        assert.equal(preflightMediaBuyActions(state, request).ok, false);
        assert.equal(preflightUpdateMediaBuy(state, request).ok, false);
        assert.throws(
          () => assertUpdateMediaBuyAllowed(state, request),
          e => e.code === 'ACTION_NOT_ALLOWED'
        );
        const projection = mediaBuyActionResolver.resolve({
          buy: state,
          request,
          decide: () => ({ ...accept(), applicable_package_ids: ['p1'] }),
        });
        assert.deepEqual(projection.available_actions, []);
        assert.equal(projection.unavailable[0].reason, 'wrong_status');
        assert.equal(projection.request_assessments[0].status, 'currently_unavailable');
        assert.equal(projection.request_assessments[0].reason, 'wrong_status');
      }
    }
  }
});

test('local active and paused package controls remain executable on active and paused buys', () => {
  const { preflightMediaBuyActions } = require('../../dist/lib/media-buy/actions.js');
  const { assertUpdateMediaBuyAllowed } = require('../../dist/lib/server/media-buy-actions.js');
  for (const buyStatus of ['active', 'paused']) {
    for (const [status, paused, action] of [
      ['active', false, 'pause'],
      ['active', true, 'resume'],
      ['paused', true, 'resume'],
      ['paused', undefined, 'resume'],
    ]) {
      const state = buy([term(action)], {
        status: buyStatus,
        packages: [{ package_id: 'p1', status, ...(paused !== undefined && { paused }) }],
      });
      const request = { packages: [{ package_id: 'p1', paused: action === 'pause' }] };
      const projection = mediaBuyActionResolver.resolve({
        buy: state,
        request,
        decide: () => ({ ...accept(), applicable_package_ids: ['p1'] }),
      });
      assert.equal(projection.available_actions.length, 1);
      assert.equal(projection.request_assessments[0].status, 'available_now');
      state.available_actions = projection.available_actions;
      assert.equal(assessActionAvailability(state, action, { request }).status, 'available_now');
      assert.equal(assessMediaBuyAction({ action, buy: state, request }).availability.status, 'available_now');
      assert.equal(preflightMediaBuyActions(state, request).ok, true);
      assert.equal(preflightUpdateMediaBuy(state, request).ok, true);
      assert.equal(assertUpdateMediaBuyAllowed(state, request).ok, true);
    }
  }
});
