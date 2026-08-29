const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildRequest } = require('../../dist/lib/testing/storyboard/request-builder.js');
const { applyBrandInvariant } = require('../../dist/lib/testing/storyboard/runner.js');

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
  assert.deepStrictEqual(productsOpaque.account, {
    brand: BRAND,
    operator: BRAND.domain,
    sandbox: true,
  });
  assert.deepStrictEqual(signalsOpaque.account, {
    brand: BRAND,
    operator: BRAND.domain,
    sandbox: true,
  });

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
