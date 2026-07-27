const { describe, test } = require('node:test');
const assert = require('node:assert');

const { SingleAgentClient } = require('../../dist/lib/core/SingleAgentClient.js');
const { concealLegacyFormatRefs } = require('../../dist/lib/v2/projection/legacy-metadata.js');

const agent = {
  id: 'route-cache-seller',
  name: 'Route cache seller',
  agent_uri: 'https://seller.example/mcp',
  protocol: 'mcp',
};

function client(config = {}) {
  return new SingleAgentClient(agent, config);
}

function canonicalOption(id, legacyId, extra = {}) {
  return concealLegacyFormatRefs({
    format_option_id: id,
    format_kind: 'image',
    params: {},
    v1_format_ref: [{ agent_url: 'https://formats.example', id: legacyId }],
    ...extra,
  });
}

function selector(productId, optionId) {
  return {
    source: 'selector',
    selector: {
      product_id: productId,
      format_option_refs: [{ scope: 'product', format_option_id: optionId }],
    },
    operation: 'create_media_buy',
    field: '(package selector)',
  };
}

describe('canonical legacy route cache', () => {
  test('authoritative product refresh removes changed, removed, and canonical-only routes', () => {
    const c = client();
    const account = { account_id: 'acct-a' };
    c.rememberCanonicalProductRoutes(
      [{ product_id: 'p', format_options: [canonicalOption('kept', 'old'), canonicalOption('removed', 'gone')] }],
      account
    );
    assert.equal(c.cachedCanonicalLegacyRefs(selector('p', 'kept'), account)[0].id, 'old');

    c.rememberCanonicalProductRoutes(
      [
        {
          product_id: 'p',
          format_options: [
            canonicalOption('kept', 'new'),
            { format_option_id: 'canonical-only', format_kind: 'image', params: {}, canonical_formats_only: true },
          ],
        },
      ],
      account
    );

    assert.equal(c.cachedCanonicalLegacyRefs(selector('p', 'kept'), account)[0].id, 'new');
    assert.equal(c.cachedCanonicalLegacyRefs(selector('p', 'removed'), account), undefined);
    assert.equal(c.cachedCanonicalLegacyRefs(selector('p', 'canonical-only'), account), undefined);
  });

  test('uses one accountless discovery route but never crosses conflicting account scopes', () => {
    const c = client();
    c.rememberCanonicalProductRoutes(
      [{ product_id: 'p', format_options: [canonicalOption('opt', 'public')] }],
      undefined
    );
    assert.equal(c.cachedCanonicalLegacyRefs(selector('p', 'opt'), { account_id: 'acct-a' })[0].id, 'public');

    c.rememberCanonicalProductRoutes([{ product_id: 'p', format_options: [canonicalOption('opt', 'tenant-a')] }], {
      account_id: 'acct-a',
    });
    assert.equal(c.cachedCanonicalLegacyRefs(selector('p', 'opt'), { account_id: 'acct-a' })[0].id, 'tenant-a');
    assert.equal(c.cachedCanonicalLegacyRefs(selector('p', 'opt'), { account_id: 'acct-b' }), undefined);
  });

  test('uses only natural-key account identity when requests carry brand overrides', () => {
    const c = client();
    const fullAccount = {
      brand: {
        domain: 'brand.example',
        brand_id: 'subbrand',
        industries: ['IAB1'],
        data_subject_contestation: { email: 'privacy@brand.example' },
        brand_kit_override: { tagline: `large-${'x'.repeat(32 * 1024)}` },
      },
      operator: 'agency.example',
      sandbox: true,
    };
    const identity = {
      brand: { domain: 'brand.example', brand_id: 'subbrand' },
      operator: 'agency.example',
      sandbox: true,
    };
    c.rememberCanonicalProductRoutes(
      [{ product_id: 'p', format_options: [canonicalOption('opt', 'natural-key')] }],
      fullAccount
    );

    assert.equal(c.canonicalAccountScope(fullAccount), c.canonicalAccountScope(identity));
    assert.equal(c.cachedCanonicalLegacyRefs(selector('p', 'opt'), identity)[0].id, 'natural-key');
  });

  test('per-call resolver wins, then cache, then configured resolver', () => {
    const configured = () => ({ agent_url: 'https://formats.example', id: 'configured' });
    const override = () => ({ agent_url: 'https://formats.example', id: 'per-call' });
    const c = client({ canonicalFormatLegacyResolver: configured });
    const account = { account_id: 'acct-a' };
    c.rememberCanonicalProductRoutes(
      [{ product_id: 'p', format_options: [canonicalOption('opt', 'cached')] }],
      account
    );

    assert.equal(c.resolveCanonicalFormatLegacyResolver(override, account)(selector('p', 'opt')).id, 'per-call');
    assert.equal(c.resolveCanonicalFormatLegacyResolver(undefined, account)(selector('p', 'opt'))[0].id, 'cached');
    assert.equal(
      c.resolveCanonicalFormatLegacyResolver(undefined, account)(selector('missing', 'opt')).id,
      'configured'
    );
  });

  test('records package routes for legal package-id-only update and sync selectors', () => {
    const c = client();
    const account = { account_id: 'acct-a' };
    const request = {
      account,
      packages: [
        {
          product_id: 'p',
          format_option_refs: [{ scope: 'product', format_option_id: 'opt' }],
        },
      ],
    };
    c.rememberCanonicalProductRoutes(
      [{ product_id: 'p', format_options: [canonicalOption('opt', 'legacy-opt')] }],
      account
    );
    c.rememberCanonicalPackageRoutes(
      { media_buy_id: 'mb', packages: [{ package_id: 'pkg', product_id: 'p' }] },
      request
    );

    const packageContext = {
      source: 'selector',
      selector: { package_id: 'pkg' },
      operation: 'update_media_buy',
      field: 'pkg',
    };
    assert.equal(c.cachedCanonicalLegacyRefs(packageContext, account)[0].id, 'legacy-opt');
    assert.equal(
      c.cachedCanonicalLegacyRefs(packageContext, undefined),
      undefined,
      'an accountless write must not consume a tenant-scoped package route'
    );
    assert.equal(
      c.cachedCanonicalLegacyRefs(
        {
          source: 'creative',
          creative: { creative_id: 'cr', format_kind: 'image' },
          selector: { selector_containers: [{ package_id: 'pkg' }] },
          operation: 'sync_creatives',
          field: 'cr',
        },
        account
      )[0].id,
      'legacy-opt'
    );
  });

  test('resolves multiple assigned packages only when every route agrees', () => {
    const c = client();
    const account = { account_id: 'acct-a' };
    c.rememberCanonicalLegacyRoute(c.canonicalLegacyPackageRouteKey(account, 'pkg-a'), {
      kind: 'package',
      accountScope: c.canonicalAccountScope(account),
      packageId: 'pkg-a',
      refs: [{ agent_url: 'https://formats.example', id: 'same' }],
    });
    c.rememberCanonicalLegacyRoute(c.canonicalLegacyPackageRouteKey(account, 'pkg-b'), {
      kind: 'package',
      accountScope: c.canonicalAccountScope(account),
      packageId: 'pkg-b',
      refs: [{ agent_url: 'https://formats.example', id: 'same' }],
    });
    const context = {
      source: 'creative',
      creative: { creative_id: 'cr', format_kind: 'image' },
      selector: { selector_containers: [{ package_id: 'pkg-a' }, { package_id: 'pkg-b' }] },
      operation: 'sync_creatives',
      field: 'cr',
    };
    assert.equal(c.cachedCanonicalLegacyRefs(context, account)[0].id, 'same');

    c.rememberCanonicalLegacyRoute(c.canonicalLegacyPackageRouteKey(account, 'pkg-b'), {
      kind: 'package',
      accountScope: c.canonicalAccountScope(account),
      packageId: 'pkg-b',
      refs: [{ agent_url: 'https://formats.example', id: 'different' }],
    });
    assert.equal(c.cachedCanonicalLegacyRefs(context, account), undefined);
  });

  test('learns package routes from polling and webhook completions', async () => {
    const c = client();
    const account = { account_id: 'acct-a' };
    const request = {
      account,
      packages: [
        {
          product_id: 'p',
          format_option_refs: [{ scope: 'product', format_option_id: 'opt' }],
        },
      ],
    };
    c.rememberCanonicalProductRoutes(
      [{ product_id: 'p', format_options: [canonicalOption('opt', 'legacy-opt')] }],
      account
    );
    const completed = {
      success: true,
      status: 'completed',
      data: { media_buy_id: 'mb', packages: [{ package_id: 'pkg-poll', product_id: 'p' }] },
      metadata: { taskId: 'task', taskName: 'create_media_buy', status: 'completed' },
    };
    const wrapped = c.wrapCanonicalCreativeContinuations(
      {
        success: true,
        status: 'submitted',
        metadata: { taskId: 'task', taskName: 'create_media_buy', status: 'submitted' },
        submitted: {
          taskId: 'task',
          track: async () => ({ taskId: 'task', taskType: 'create_media_buy', status: 'working' }),
          waitForCompletion: async () => completed,
        },
      },
      'create_media_buy',
      undefined,
      undefined,
      request
    );
    await wrapped.submitted.waitForCompletion();
    const pollContext = {
      source: 'selector',
      selector: { package_id: 'pkg-poll' },
      operation: 'update_media_buy',
      field: 'pkg-poll',
    };
    assert.equal(c.cachedCanonicalLegacyRefs(pollContext, account)[0].id, 'legacy-opt');

    c.rememberCanonicalCreativeTaskAssociation('op-webhook', 'create_media_buy', undefined, request);
    c.canonicalizeWebhookCreativeResult(
      {
        operation_id: 'op-webhook',
        task_id: 'task-webhook',
        agent_id: agent.id,
        task_type: 'create_media_buy',
        status: 'completed',
        timestamp: new Date().toISOString(),
        protocol: 'mcp',
      },
      { media_buy_id: 'mb-webhook', packages: [{ package_id: 'pkg-webhook', product_id: 'p' }] }
    );
    assert.equal(
      c.cachedCanonicalLegacyRefs(
        { ...pollContext, selector: { package_id: 'pkg-webhook' }, field: 'pkg-webhook' },
        account
      )[0].id,
      'legacy-opt'
    );
  });

  test('learns update routes from new_packages and affected_packages across polling and webhooks', async () => {
    const c = client();
    const account = { account_id: 'acct-update' };
    const request = {
      account,
      new_packages: [
        {
          product_id: 'p',
          format_option_refs: [{ scope: 'product', format_option_id: 'opt' }],
        },
      ],
    };
    c.rememberCanonicalProductRoutes(
      [{ product_id: 'p', format_options: [canonicalOption('opt', 'legacy-update')] }],
      account
    );
    const wrapped = c.wrapCanonicalCreativeContinuations(
      {
        success: true,
        status: 'submitted',
        metadata: { taskId: 'update-poll', taskName: 'update_media_buy', status: 'submitted' },
        submitted: {
          taskId: 'update-poll',
          track: async () => ({ taskId: 'update-poll', taskType: 'update_media_buy', status: 'working' }),
          waitForCompletion: async () => ({
            success: true,
            status: 'completed',
            data: { media_buy_id: 'mb', affected_packages: [{ package_id: 'pkg-update-poll', product_id: 'p' }] },
            metadata: { taskId: 'update-poll', taskName: 'update_media_buy', status: 'completed' },
          }),
        },
      },
      'update_media_buy',
      undefined,
      undefined,
      request
    );
    await wrapped.submitted.waitForCompletion();

    const packageContext = packageId => ({
      source: 'selector',
      selector: { package_id: packageId },
      operation: 'update_media_buy',
      field: packageId,
    });
    assert.equal(c.cachedCanonicalLegacyRefs(packageContext('pkg-update-poll'), account)[0].id, 'legacy-update');

    c.rememberCanonicalCreativeTaskAssociation('update-webhook', 'update_media_buy', undefined, request);
    c.canonicalizeWebhookCreativeResult(
      {
        operation_id: 'update-webhook',
        task_id: 'seller-update-webhook',
        agent_id: agent.id,
        task_type: 'update_media_buy',
        status: 'completed',
        timestamp: new Date().toISOString(),
        protocol: 'mcp',
      },
      { media_buy_id: 'mb', affected_packages: [{ package_id: 'pkg-update-webhook', product_id: 'p' }] }
    );
    assert.equal(c.cachedCanonicalLegacyRefs(packageContext('pkg-update-webhook'), account)[0].id, 'legacy-update');
  });

  test('bounds route memory with LRU eviction', () => {
    const c = client();
    for (let index = 0; index <= 10_000; index += 1) {
      c.rememberCanonicalProductRoutes(
        [{ product_id: `p-${index}`, format_options: [canonicalOption('opt', `legacy-${index}`)] }],
        undefined
      );
    }
    assert.equal(c.canonicalLegacyRoutes.size, 10_000);
    assert.equal(c.cachedCanonicalLegacyRefs(selector('p-0', 'opt'), undefined), undefined);
    assert.equal(c.cachedCanonicalLegacyRefs(selector('p-10000', 'opt'), undefined)[0].id, 'legacy-10000');
  });
});
