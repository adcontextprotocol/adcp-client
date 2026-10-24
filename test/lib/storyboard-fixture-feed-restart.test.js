const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  prepareStoryboardFixtures,
  runStoryboard,
  runStoryboardStep,
  withPreparedFixtures,
} = require('../../dist/lib/testing/index.js');
const { ENDPOINT, SELECTED, board, product, transport } = require('../helpers/fixture-discovery-seller.js');
const ALLOW = () => ({ authorized: true });
function page(products, version, more = false, extra = {}) {
  return {
    status: 'completed',
    products,
    cache_scope: 'account',
    ...(version !== undefined && { wholesale_feed_version: version }),
    ...(more && { pagination: { has_more: true, cursor: 'next' } }),
    ...extra,
  };
}
for (const changedField of ['wholesale_feed_version', 'pricing_version', 'cache_scope']) {
  test(`${changedField} changes restart the whole catalog without mixing captures`, async () => {
    let changed = false;
    const stale = product('old-selected', { collection_targeting_allowed: true });
    const io = transport([], {
      read: request => {
        if (request.pagination?.cursor) changed = true;
        const identity = { wholesale_feed_version: 'opaque-v1', pricing_version: 'price-v1', cache_scope: 'account' };
        if (changed) identity[changedField] = changedField === 'cache_scope' ? 'public' : 'opaque-v2';
        return page(
          request.pagination?.cursor ? (changed ? [SELECTED] : []) : changed ? [] : [stale],
          undefined,
          !request.pagination?.cursor,
          identity
        );
      },
    });
    const state = await prepareStoryboardFixtures(ENDPOINT, board(), io.options);
    assert.equal(state.disposition.status, 'resolved', JSON.stringify(state.disposition));
    const reads = io.calls.filter(call => call.task === 'get_products');
    assert.deepEqual(
      reads.map(call => call.request.pagination.cursor),
      [undefined, 'next', undefined, 'next']
    );
    assert.equal(state.captures.__adcp_fixture_product_id, SELECTED.product_id);
    assert.equal(state.captures.__adcp_fixture_currency, 'EUR');
    assert.ok(
      state.resolutions.filter(r => r.status === 'resolved').every(r => r.seller_ids.product_id === SELECTED.product_id)
    );
    assert.doesNotMatch(JSON.stringify(state.phase), /old-selected/);
  });
}
for (const tokenChange of ['appears', 'disappears']) {
  test(`an opaque token that ${tokenChange} restarts enumeration`, async () => {
    let changed = false;
    const io = transport([], {
      read: request => {
        if (request.pagination.cursor) changed = true;
        const version = (tokenChange === 'appears') === changed ? 'opaque' : undefined;
        return page(request.pagination.cursor ? [SELECTED] : [], version, !request.pagination.cursor);
      },
    });
    const state = await prepareStoryboardFixtures(ENDPOINT, board(), io.options);
    assert.equal(state.disposition.status, 'resolved');
    assert.equal(io.calls.filter(call => call.task === 'get_products').length, 4);
  });
}
test('a stable snapshot keeps one walk and may reuse opaque token strings', async () => {
  const io = transport([], {
    read: request => page(request.pagination.cursor ? [SELECTED] : [], 'opaque', !request.pagination.cursor),
  });
  const state = await prepareStoryboardFixtures(ENDPOINT, board(), io.options);
  assert.equal(state.disposition.status, 'resolved');
  assert.equal(io.calls.filter(call => call.task === 'get_products').length, 2);
});
test('feed identity is compared before duplicate identities from an abandoned walk', async () => {
  let calls = 0;
  const io = transport([], {
    read: request => {
      calls++;
      return calls === 1 ? page([SELECTED], 'v1', true) : page([SELECTED], 'v2');
    },
  });
  const state = await prepareStoryboardFixtures(ENDPOINT, board(), io.options);
  assert.equal(state.disposition.status, 'resolved', JSON.stringify(state.disposition));
  assert.equal(calls, 3);
});
for (const malformed of ['cursor', 'schema', 'unchanged']) {
  test(`a changed feed does not hide a ${malformed} failure`, async () => {
    let calls = 0;
    const io = transport([], {
      read: () => {
        calls++;
        if (calls === 1) return page([], 'v1', true);
        if (malformed === 'cursor') return page([], 'v2', false, { pagination: { has_more: true } });
        if (malformed === 'schema') return page([{ product_id: 'malformed' }], 'v2');
        return { status: 'completed', cache_scope: 'account', wholesale_feed_version: 'v2', unchanged: true };
      },
    });
    const state = await prepareStoryboardFixtures(ENDPOINT, board(), io.options);
    assert.equal(state.disposition.status, 'failed', JSON.stringify(state.disposition));
    assert.equal(calls, 2);
    assert.deepEqual(state.captures, {});
  });
}
test('stable duplicate products and repeated cursors remain terminal', async () => {
  for (const duplicate of [true, false]) {
    const io = transport([], {
      read: request => page(duplicate ? [SELECTED] : [], 'same', !duplicate || !request.pagination.cursor),
    });
    const state = await prepareStoryboardFixtures(ENDPOINT, board(), io.options);
    assert.equal(state.disposition.status, 'failed');
    assert.match(state.disposition.detail, duplicate ? /duplicate product_id/ : /repeated cursor/);
    assert.deepEqual(state.captures, {});
  }
});
function churningSeller() {
  let reads = 0;
  return transport([], { read: () => page([SELECTED], `v-${reads++}`, true) });
}
test('continuous feed churn becomes a bounded runner gap in prepared, full, and standalone flows', async () => {
  const prepIo = churningSeller();
  const state = await prepareStoryboardFixtures(ENDPOINT, board(), prepIo.options);
  assert.deepEqual(state.disposition, {
    status: 'unsupported',
    reason: 'not_applicable',
    detail: 'fixture discovery could not enumerate a stable feed within the runner’s 3-restart budget',
  });
  assert.equal(prepIo.calls.filter(call => call.task === 'get_products').length, 8);
  assert.deepEqual(state.captures, {});
  assert.deepEqual(state.witnesses, {});
  assert.ok(state.resolutions.every(record => record.unavailable_reason === 'runner_budget_exhausted'));
  for (const prepared of [true, false]) {
    const io = churningSeller();
    const result = await runStoryboard(ENDPOINT, board(), {
      ...io.options,
      ...(prepared && withPreparedFixtures(state, ALLOW)),
    });
    assert.equal(result.failed_count, 0, JSON.stringify(result));
    assert.equal(result.skipped_count, 1);
    assert.equal(result.phases[0].steps[0].skip_reason, 'not_applicable');
    assert.ok(result.fixture_preparation);
    assert.equal(
      io.calls.some(call => call.task === 'create_media_buy'),
      false
    );
  }
  const stepIo = churningSeller();
  const step = await runStoryboardStep(ENDPOINT, board(), 'create', {
    ...stepIo.options,
    ...withPreparedFixtures(state, ALLOW),
  });
  assert.equal(step.skipped, true);
  assert.equal(step.skip_reason, 'not_applicable');
  assert.ok(step.fixture_preparation);
  assert.equal(stepIo.calls.length, 0);
});
test('multi-pass churn reports one runner gap without dispatching a consumer', async () => {
  const io = churningSeller();
  const result = await runStoryboard([ENDPOINT, ENDPOINT], board(), {
    ...io.options,
    multi_instance_strategy: 'multi-pass',
  });
  assert.equal(result.failed_count, 0);
  assert.equal(result.skipped_count, 1);
  assert.equal(io.calls.filter(call => call.task === 'get_products').length, 8);
  assert.equal(
    io.calls.some(call => call.task === 'create_media_buy'),
    false
  );
});

test('a runner gap never hides a separate controller failure in the same graph', async () => {
  const doc = board();
  doc.fixtures.products.push(product('seed-only'));
  doc.fixture_resolution.products.push({ handle: 'seed-only', strategies: ['seed'] });
  const io = churningSeller();
  const { CAPS, TOOLS } = require('../helpers/fixture-discovery-seller.js');
  const controllerIo = transport([], {
    tools: [...TOOLS, 'comply_test_controller'],
    controller: () => ({ success: false, error: 'UPSTREAM_FAILURE' }),
    capabilities: () => ({ ...CAPS, compliance_testing: { scenarios: [] } }),
  });
  const original = io.options.transport.trustedFetchFn;
  io.options.transport.trustedFetchFn = (input, init = {}) => {
    const rpc = JSON.parse(init.body);
    if (rpc.params?.name === 'get_adcp_capabilities' || rpc.method === 'tools/list')
      return controllerIo.options.transport.trustedFetchFn(input, init);
    return rpc.params?.name === 'comply_test_controller'
      ? controllerIo.options.transport.trustedFetchFn(input, init)
      : original(input, init);
  };
  io.options.profile = {
    name: 'Controller seller',
    tools: [...TOOLS, 'comply_test_controller'],
    raw_capabilities: CAPS,
  };
  const state = await prepareStoryboardFixtures(ENDPOINT, doc, io.options);
  assert.equal(state.disposition.status, 'failed', JSON.stringify(state.disposition));
  assert.match(state.disposition.detail, /UPSTREAM_FAILURE/);
  assert.deepEqual(state.captures, {});
});

test('a colliding pricing handle retains its own real controller failure', async () => {
  const doc = board();
  doc.fixtures.products.push(product('seed-only'));
  doc.fixture_resolution.products.push({ handle: 'seed-only', strategies: ['seed'] });
  doc.fixtures.pricing_options.push({
    product_id: 'seed-only',
    pricing_option_id: 'authored-product',
    pricing_model: 'cpm',
  });
  doc.fixture_resolution.pricing_options.push({
    handle: 'authored-product',
    product_handle: 'seed-only',
    strategies: ['seed'],
  });
  const io = churningSeller();
  const { CAPS, TOOLS } = require('../helpers/fixture-discovery-seller.js');
  const controllerIo = transport([], {
    tools: [...TOOLS, 'comply_test_controller'],
    controller: request =>
      request.scenario === 'list_scenarios'
        ? { success: true, scenarios: ['seed_product', 'seed_pricing_option'] }
        : request.scenario === 'seed_product'
          ? { success: true }
          : { success: false, error: 'UPSTREAM_FAILURE' },
  });
  const original = io.options.transport.trustedFetchFn;
  io.options.transport.trustedFetchFn = (input, init = {}) => {
    const rpc = JSON.parse(init.body);
    return rpc.params?.name === 'comply_test_controller' || rpc.method === 'tools/list'
      ? controllerIo.options.transport.trustedFetchFn(input, init)
      : original(input, init);
  };
  io.options.profile = {
    name: 'Controller seller',
    tools: [...TOOLS, 'comply_test_controller'],
    raw_capabilities: CAPS,
  };
  const state = await prepareStoryboardFixtures(ENDPOINT, doc, io.options);
  assert.equal(state.disposition.status, 'failed', JSON.stringify(state.disposition));
  const actualFailure = state.phase.steps.find(step => step.error?.includes('UPSTREAM_FAILURE'));
  assert.equal(actualFailure.passed, false);
  assert.notEqual(actualFailure.skipped, true);
  const resolution = state.resolutions.find(
    record => record.fixture_type === 'pricing_option' && record.product_handle === 'seed-only'
  );
  assert.equal(resolution.unavailable_reason, undefined);
  assert.deepEqual(state.captures, {});
});

test('a stable feed beyond the page budget is also a runner-owned observation gap', async () => {
  let reads = 0;
  const io = transport([], {
    read: () => page([], 'stable', false, { pagination: { has_more: true, cursor: `page-${++reads}` } }),
  });
  const state = await prepareStoryboardFixtures(ENDPOINT, board(), io.options);
  assert.equal(reads, 1000);
  assert.equal(state.disposition.status, 'unsupported');
  assert.equal(state.disposition.reason, 'not_applicable');
  assert.deepEqual(state.captures, {});
  assert.ok(state.phase.steps.some(step => step.response_record?.payload));
  const runIo = transport([]);
  const result = await runStoryboard(ENDPOINT, board(), { ...runIo.options, ...withPreparedFixtures(state, ALLOW) });
  assert.equal(result.failed_count, 0);
  assert.equal(result.skipped_count, 1);
  assert.equal(result.phases[0].steps[0].skip_reason, 'not_applicable');
  assert.deepEqual(runIo.calls, []);
});
