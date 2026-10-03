const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildRequest } = require('../../dist/lib/testing/storyboard/request-builder.js');
const { applyBrandInvariant } = require('../../dist/lib/testing/storyboard/runner.js');
const { GetMediaBuyDeliveryRequestSchema } = require('../../dist/lib/types/schemas.generated.js');

const BRAND = { domain: 'acmeoutdoor.example' };
const ACCOUNT = {
  brand: BRAND,
  operator: 'pinnacle-agency.example',
  sandbox: true,
};
const OPTIONS = { brand: BRAND, sandbox: true };

function effectiveRequest(task, sampleRequest, context) {
  const step = { id: `scope-${task}`, title: `Scope ${task}`, task, sample_request: sampleRequest };
  return applyBrandInvariant(buildRequest(step, context, OPTIONS), OPTIONS, task);
}

test('controller uses an authored natural-key operator over stale context with the run brand (#3044)', () => {
  const authoredAccount = {
    brand: { domain: 'shared-seller.example' },
    operator: 'buyer-agent.example',
    sandbox: false,
  };
  const request = effectiveRequest(
    'comply_test_controller',
    { scenario: 'list_scenarios', account: authoredAccount },
    { account: { account_id: 'account-from-sync' } }
  );

  assert.deepStrictEqual(request.account, { ...authoredAccount, brand: BRAND, sandbox: true });
});

test('reporting controller uses an authored account ID over a different context account (#3044)', () => {
  const request = effectiveRequest(
    'comply_test_controller',
    { scenario: 'reporting_core_lifecycle_probe', account: { account_id: 'shared-account', sandbox: false } },
    { account: { account_id: 'account-from-sync' } }
  );

  assert.deepStrictEqual(request.account, { account_id: 'shared-account', sandbox: true });
});

test('media-buy simulation keeps the create and plain delivery account scope (#3044)', () => {
  const context = { account: { account_id: 'account-from-sync' } };
  const authoredAccount = { account_id: 'different-fixture-account' };
  const controller = effectiveRequest(
    'comply_test_controller',
    { scenario: 'simulate_delivery', account: authoredAccount },
    context
  );
  const create = effectiveRequest('create_media_buy', { account: authoredAccount }, context);
  const delivery = effectiveRequest('get_media_buy_delivery', { account: authoredAccount }, context);

  assert.deepStrictEqual(controller.account, { ...create.account, sandbox: true });
  assert.deepStrictEqual(delivery.account, create.account);
});

test('media-buy seeding keeps the later list account scope with a synced natural key (#3044)', () => {
  const context = { account: { brand: BRAND, operator: 'synced-buyer.example' } };
  const authoredAccount = { account_id: 'primary-account', sandbox: true };
  const controller = effectiveRequest(
    'comply_test_controller',
    { scenario: 'seed_media_buy', account: authoredAccount, params: { media_buy_id: 'media-buy-1' } },
    context
  );
  const list = effectiveRequest('get_media_buys', { account: authoredAccount }, context);

  assert.deepStrictEqual(controller.account, { ...list.account, sandbox: true });
  assert.deepStrictEqual(list.account, context.account);
});

test('Core revision controller and exact delivery read use the same authored account ID (#3044)', () => {
  const context = { account: { account_id: 'account-from-sync' }, media_buy_id: 'stale-media-buy' };
  const authoredAccount = { account_id: 'reporting_core_nonempty_lab' };
  const controller = effectiveRequest(
    'comply_test_controller',
    { scenario: 'reporting_core_lifecycle_probe', account: { ...authoredAccount, sandbox: true } },
    context
  );
  const delivery = effectiveRequest(
    'get_media_buy_delivery',
    { account: authoredAccount, reporting_revision_id: 'reporting-revision-1', pagination: { max_results: 1 } },
    context
  );

  assert.deepStrictEqual(controller.account, { ...authoredAccount, sandbox: true });
  assert.deepStrictEqual(delivery.account, authoredAccount);
  assert.deepStrictEqual(delivery.pagination, { max_results: 1 });
  assert.strictEqual(delivery.media_buy_ids, undefined);
});

test('exact revision read strips controller-only sandbox from an authored account ID (#3044)', () => {
  const request = effectiveRequest(
    'get_media_buy_delivery',
    { account: { account_id: 'reporting-core-lab', sandbox: true }, reporting_revision_id: 'revision-1' },
    { account: { account_id: 'account-from-sync' } }
  );

  assert.deepStrictEqual(request.account, { account_id: 'reporting-core-lab' });
  assert.ok(GetMediaBuyDeliveryRequestSchema.safeParse(request).success);
});

test('exact revision read keeps an authored natural key in the sandbox partition (#3044)', () => {
  const account = { brand: { domain: 'fixture-brand.example' }, operator: 'buyer-agent.example' };
  const request = effectiveRequest(
    'get_media_buy_delivery',
    { account, reporting_revision_id: 'revision-1' },
    { account: { account_id: 'account-from-sync' } }
  );

  assert.deepStrictEqual(request.account, { brand: BRAND, operator: account.operator, sandbox: true });
  assert.ok(GetMediaBuyDeliveryRequestSchema.safeParse(request).success);
});

test('controller treats a sandbox-only fixture as a routing hint, not an account target (#3044)', () => {
  const request = effectiveRequest(
    'comply_test_controller',
    { scenario: 'simulate_delivery', account: { sandbox: true } },
    { account: { account_id: 'account-from-sync' } }
  );

  assert.deepStrictEqual(request.account, { account_id: 'account-from-sync', sandbox: true });
});

test('sandbox-only controller fallback retains the run brand on a natural context account (#3044)', () => {
  const contextAccount = {
    brand: { domain: 'synced-brand.example' },
    operator: 'buyer-agent.example',
  };
  const request = effectiveRequest(
    'comply_test_controller',
    { scenario: 'simulate_delivery', account: { sandbox: true } },
    { account: contextAccount }
  );

  assert.deepStrictEqual(request.account, { ...contextAccount, brand: BRAND, sandbox: true });
});

test('media-buy simulation and delivery read share the run brand and resolved operator (#3044)', () => {
  const context = {
    account: { brand: { domain: 'synced-brand.example' }, operator: 'buyer-agent.example' },
  };
  const authoredAccount = {
    brand: { domain: 'fixture-brand.example' },
    operator: 'buyer-agent.example',
    sandbox: true,
  };
  const controller = effectiveRequest(
    'comply_test_controller',
    { scenario: 'simulate_delivery', account: authoredAccount },
    context
  );
  const delivery = effectiveRequest(
    'get_media_buy_delivery',
    { account: authoredAccount, media_buy_id: 'media-buy-1' },
    context
  );

  assert.deepStrictEqual(controller.account, { ...delivery.account, sandbox: true });
  assert.deepStrictEqual(controller.account.brand, BRAND);
});

test('seed_account uses the authorized caller, not the account being created (#3044)', () => {
  const request = effectiveRequest(
    'comply_test_controller',
    { scenario: 'seed_account', account: { account_id: 'new-account', sandbox: true } },
    { account: { account_id: 'authorized-caller' } }
  );

  assert.deepStrictEqual(request.account, { account_id: 'authorized-caller', sandbox: true });
});

test('seed_account falls back to the harness caller for an authored natural key (#3044)', () => {
  const request = effectiveRequest(
    'comply_test_controller',
    {
      scenario: 'seed_account',
      account: { brand: { domain: 'new-brand.example' }, operator: 'new-operator.example' },
    },
    {}
  );

  assert.deepStrictEqual(request.account, { brand: BRAND, operator: BRAND.domain, sandbox: true });
});

test('creative feature async arm keeps the later operation account scope and run brand (#3044)', () => {
  const context = { account: { account_id: 'authorized-caller' } };
  const authoredAccount = {
    brand: { domain: 'fixture-brand.example' },
    operator: 'buyer-agent.example',
    sandbox: true,
  };
  const controller = effectiveRequest(
    'comply_test_controller',
    { scenario: 'force_get_creative_features_arm', account: authoredAccount },
    context
  );
  const operation = effectiveRequest('get_creative_features', { account: authoredAccount }, context);

  assert.deepStrictEqual(controller.account, operation.account);
  assert.deepStrictEqual(controller.account.brand, BRAND);
});

test('create_media_buy and get_task_status retain one authored natural account scope (#2703)', () => {
  const context = {
    products: [
      {
        product_id: 'async_lifecycle_video_q3',
        pricing_options: [{ pricing_option_id: 'async_lifecycle_cpm', pricing_model: 'cpm' }],
      },
    ],
    async_media_buy_task_id: 'task_async_media_buy_lifecycle_q3',
  };
  const forceSubmitted = effectiveRequest(
    'comply_test_controller',
    {
      account: ACCOUNT,
      scenario: 'force_create_media_buy_arm',
      params: { arm: 'submitted', task_id: 'task_async_media_buy_lifecycle_q3' },
    },
    context
  );
  const create = effectiveRequest(
    'create_media_buy',
    {
      account: ACCOUNT,
      brand: BRAND,
      start_time: 'asap',
      end_time: '2099-09-30T23:59:59Z',
      packages: [
        {
          product_id: 'async_lifecycle_video_q3',
          budget: 30_000,
          pricing_option_id: 'async_lifecycle_cpm',
        },
      ],
    },
    context
  );
  const poll = effectiveRequest(
    'get_task_status',
    { task_id: '$context.async_media_buy_task_id', account: ACCOUNT },
    context
  );
  const list = effectiveRequest('list_tasks', { account: ACCOUNT, filters: { statuses: ['submitted'] } }, context);
  const update = effectiveRequest(
    'update_media_buy',
    {
      account: ACCOUNT,
      media_buy_id: 'mb_async_lifecycle_q3',
      packages: [{ package_id: 'pkg_async_lifecycle_q3', paused: true }],
    },
    context
  );
  const forceCompletion = effectiveRequest(
    'comply_test_controller',
    {
      account: ACCOUNT,
      scenario: 'force_task_completion',
      params: {
        task_id: '$context.async_media_buy_task_id',
        result: { media_buy_id: 'mb_async_lifecycle_q3', status: 'completed' },
      },
    },
    context
  );

  assert.deepStrictEqual(forceSubmitted.account, ACCOUNT);
  assert.deepStrictEqual(create.account, ACCOUNT);
  assert.deepStrictEqual(poll.account, ACCOUNT);
  assert.deepStrictEqual(list.account, ACCOUNT);
  assert.deepStrictEqual(update.account, ACCOUNT);
  assert.deepStrictEqual(forceCompletion.account, ACCOUNT);
  assert.deepStrictEqual(create.account, poll.account);
  assert.strictEqual(poll.task_id, 'task_async_media_buy_lifecycle_q3');
});

test('natural fixture preservation does not override trusted context or admit fixture account IDs', () => {
  const trustedContextAccount = { account_id: 'account_resolved_by_framework' };
  const contextScoped = effectiveRequest('create_media_buy', { account: ACCOUNT }, { account: trustedContextAccount });
  assert.deepStrictEqual(contextScoped.account, trustedContextAccount);

  const proposalContextScoped = effectiveRequest(
    'create_media_buy',
    { account: ACCOUNT, proposal_id: 'proposal_context_scope', total_budget: 10_000 },
    { account: trustedContextAccount }
  );
  assert.deepStrictEqual(proposalContextScoped.account, trustedContextAccount);

  const pollContextScoped = effectiveRequest(
    'get_task_status',
    { account: ACCOUNT, task_id: 'task_context_scope' },
    { account: trustedContextAccount }
  );
  const listContextScoped = effectiveRequest(
    'list_tasks',
    { account: { account_id: 'fixture_list_account' }, filters: { statuses: ['submitted'] } },
    { account: trustedContextAccount }
  );
  assert.deepStrictEqual(pollContextScoped.account, trustedContextAccount);
  assert.deepStrictEqual(listContextScoped.account, trustedContextAccount);

  const fixtureOpaque = effectiveRequest(
    'create_media_buy',
    { account: { account_id: 'fixture_supplied_account' } },
    {}
  );
  assert.deepStrictEqual(fixtureOpaque.account, {
    brand: BRAND,
    operator: BRAND.domain,
    sandbox: true,
  });

  const proposalNatural = effectiveRequest(
    'create_media_buy',
    { account: ACCOUNT, proposal_id: 'proposal_natural_scope', total_budget: 10_000 },
    {}
  );
  assert.deepStrictEqual(proposalNatural.account, ACCOUNT);

  const proposalOpaque = effectiveRequest(
    'create_media_buy',
    {
      account: { account_id: 'fixture_supplied_proposal_account' },
      proposal_id: 'proposal_opaque_scope',
      total_budget: 10_000,
    },
    {}
  );
  assert.deepStrictEqual(proposalOpaque.account, {
    brand: BRAND,
    operator: BRAND.domain,
    sandbox: true,
  });

  const pollOpaque = effectiveRequest(
    'get_task_status',
    { account: { account_id: 'fixture_poll_account' }, task_id: 'task_opaque_scope' },
    {}
  );
  assert.deepStrictEqual(pollOpaque.account, {
    brand: BRAND,
    operator: BRAND.domain,
    sandbox: true,
  });
});

test('get_products controller arm retains the operation natural account scope', () => {
  const controller = effectiveRequest(
    'comply_test_controller',
    {
      account: ACCOUNT,
      scenario: 'force_get_products_arm',
      params: { arm: 'submitted', task_id: 'task_products_scope' },
    },
    {}
  );
  const discovery = effectiveRequest(
    'get_products',
    { account: ACCOUNT, buying_mode: 'brief', brief: 'scope test' },
    {}
  );

  assert.deepStrictEqual(controller.account, ACCOUNT);
  assert.deepStrictEqual(discovery.account, ACCOUNT);
});

test('async discovery operations and controller arms use trusted context scope', () => {
  const trustedContextAccount = { account_id: 'trusted_discovery_account' };
  const context = { account: trustedContextAccount };
  const productsController = effectiveRequest(
    'comply_test_controller',
    {
      account: ACCOUNT,
      scenario: 'force_get_products_arm',
      params: { arm: 'submitted', task_id: 'task_products_trusted_scope' },
    },
    context
  );
  const products = effectiveRequest(
    'get_products',
    { account: ACCOUNT, buying_mode: 'brief', brief: 'scope test' },
    context
  );
  const signalsController = effectiveRequest(
    'comply_test_controller',
    {
      account: ACCOUNT,
      scenario: 'force_get_signals_arm',
      params: { arm: 'submitted', task_id: 'task_signals_trusted_scope' },
    },
    context
  );
  const signals = effectiveRequest(
    'get_signals',
    { account: ACCOUNT, discovery_mode: 'brief', signal_spec: 'scope test' },
    context
  );

  assert.deepStrictEqual(productsController.account, { ...trustedContextAccount, sandbox: true });
  assert.deepStrictEqual(products.account, trustedContextAccount);
  assert.deepStrictEqual(signalsController.account, { ...trustedContextAccount, sandbox: true });
  assert.deepStrictEqual(signals.account, trustedContextAccount);

  const productsOpaque = effectiveRequest(
    'get_products',
    { account: { account_id: 'fixture_products_account' }, buying_mode: 'brief', brief: 'scope test' },
    {}
  );
  const signalsOpaque = effectiveRequest(
    'get_signals',
    { account: { account_id: 'fixture_signals_account' }, discovery_mode: 'brief', signal_spec: 'scope test' },
    {}
  );
  assert.deepStrictEqual(productsOpaque.account, { account_id: 'fixture_products_account' });
  assert.deepStrictEqual(signalsOpaque.account, { account_id: 'fixture_signals_account' });

  const wholesaleAccount = {
    brand: { domain: 'wholesale-scope.example' },
    operator: 'wholesale-operator.example',
    sandbox: true,
  };
  const wholesaleProducts = effectiveRequest(
    'get_products',
    { account: wholesaleAccount, buying_mode: 'wholesale' },
    context
  );
  const wholesaleSignals = effectiveRequest(
    'get_signals',
    { account: wholesaleAccount, discovery_mode: 'wholesale' },
    context
  );
  assert.deepStrictEqual(wholesaleProducts.account, wholesaleAccount);
  assert.deepStrictEqual(wholesaleSignals.account, wholesaleAccount);
});

test('controller resolves whole and nested account context references before selecting scope', () => {
  const contextAccount = { account_id: 'resolved_controller_account' };
  const wholeReference = effectiveRequest(
    'comply_test_controller',
    {
      account: '$context.account',
      scenario: 'force_task_completion',
      params: { task_id: 'task_whole_reference', result: {} },
    },
    { account: contextAccount }
  );
  assert.deepStrictEqual(wholeReference.account, { ...contextAccount, sandbox: true });

  const nestedReference = effectiveRequest(
    'comply_test_controller',
    {
      account: { brand: BRAND, operator: '$context.operator', sandbox: false },
      scenario: 'force_get_products_arm',
      params: { arm: 'submitted', task_id: 'task_nested_reference' },
    },
    { operator: ACCOUNT.operator }
  );
  assert.deepStrictEqual(nestedReference.account, ACCOUNT);
});
