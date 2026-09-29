const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  SingleAgentClient,
  AgentClient,
  parseCapabilitiesResponse,
  supportsBuyingMode,
  UnsupportedBuyingModeError,
  AccountRequiredError,
  AccountPendingApprovalError,
  AccountAmbiguousError,
} = require('../../dist/lib/index.js');
const { resolveAccountForMediaBuy } = require('../../dist/lib/testing/scenarios/media-buy.js');
const { selectListedAccount } = require('../../dist/lib/core/account-resolution.js');

function capabilities({ buyingModes, account, versions = ['3.1'] } = {}) {
  return parseCapabilitiesResponse({
    adcp: { major_versions: [3], supported_versions: versions },
    supported_protocols: ['media_buy'],
    media_buy: buyingModes === undefined ? {} : { buying_modes: buyingModes },
    ...(account && { account }),
  });
}

function clientWithCapabilities(caps, config = {}) {
  const client = new SingleAgentClient(
    {
      id: 'seller',
      name: 'Seller',
      agent_uri: 'https://seller.example/mcp',
      protocol: 'mcp',
    },
    config
  );
  client.getCapabilities = async () => caps;
  const calls = [];
  client.executeAndHandle = async (_task, _handler, params) => {
    calls.push(params);
    return { success: true, status: 'completed', data: { products: [] }, metadata: {} };
  };
  return { client, calls };
}

test('buying_modes defaults to brief and the helper uses the declared modes', () => {
  const defaults = capabilities();
  assert.deepEqual(defaults.buyingModes, ['brief']);
  assert.equal(supportsBuyingMode(defaults, 'brief'), true);
  assert.equal(supportsBuyingMode(defaults, 'wholesale'), false);
  assert.deepEqual(capabilities({ buyingModes: ['brief', 'refine'] }).buyingModes, ['brief', 'refine']);
});

test('getProducts refuses undeclared wholesale before dispatch', async () => {
  const { client, calls } = clientWithCapabilities(capabilities({ buyingModes: ['brief', 'refine'] }));
  await assert.rejects(client.getProducts({ buying_mode: 'wholesale' }), error => {
    assert.ok(error instanceof UnsupportedBuyingModeError);
    assert.deepEqual(error.declaredModes, ['brief', 'refine']);
    return true;
  });
  assert.equal(calls.length, 0);
});

test('getProducts promotes a legacy account_id to the wire account reference', async () => {
  const { client, calls } = clientWithCapabilities(
    capabilities({ account: { require_operator_auth: true, required_for_products: true } })
  );
  await client.getProducts({ brief: 'sports', account_id: 'acc-1' });
  assert.deepEqual(calls[0].account, { account_id: 'acc-1' });
  assert.equal('account_id' in calls[0], false);
});

test('getProducts never infers wholesale without a seller declaration', async () => {
  const { client, calls } = clientWithCapabilities(capabilities());
  await assert.rejects(client.getProducts({}), UnsupportedBuyingModeError);
  assert.equal(calls.length, 0);
});

test('getProducts permits the universally supported brief mode when omitted from buying_modes', async () => {
  const { client, calls } = clientWithCapabilities(capabilities({ buyingModes: ['wholesale'] }));
  await client.getProducts({ brief: 'sports' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].brief, 'sports');
});

test('getProducts infers wholesale only when declared', async () => {
  const { client, calls } = clientWithCapabilities(capabilities({ buyingModes: ['brief', 'wholesale'] }));
  await client.getProducts({});
  assert.equal(calls[0].buying_mode, 'wholesale');
});

test('getProducts keeps a valid mode when feature probing is disabled', async () => {
  for (const [config, taskOptions] of [
    [{ validateFeatures: false }, undefined],
    [{}, { skipRequestValidation: true }],
  ]) {
    const { client, calls } = clientWithCapabilities(capabilities(), config);
    client.getCapabilities = async () => {
      throw new Error('feature probing should be skipped');
    };
    await client.getProducts({}, undefined, taskOptions);
    assert.equal(calls[0].buying_mode, 'wholesale');
  }
});

test('getProducts preserves explicit wholesale for a legacy seller without 3.1 capability evidence', async () => {
  const legacy = parseCapabilitiesResponse({
    adcp: { major_versions: [3] },
    supported_protocols: ['media_buy'],
    media_buy: {},
  });
  const { client, calls } = clientWithCapabilities(legacy);
  await client.getProducts({ buying_mode: 'wholesale' });
  assert.equal(calls[0].buying_mode, 'wholesale');
});

test('getProducts keeps the historical no-brief wholesale default for pre-3.1 sellers', async () => {
  const legacy = parseCapabilitiesResponse({
    adcp: { major_versions: [3], supported_versions: ['3.0.25'] },
    supported_protocols: ['media_buy'],
    media_buy: {},
  });
  const { client, calls } = clientWithCapabilities(legacy);
  await client.getProducts({});
  assert.equal(calls[0].buying_mode, 'wholesale');
});

test('getProductsLegacy keeps a valid buying_mode for older raw-wire callers', async () => {
  const { client } = clientWithCapabilities(capabilities());
  let sent;
  client.executeTaskUnprojected = async (_task, params) => {
    sent = params;
    return { success: true, status: 'completed', data: { products: [] } };
  };
  await client.getProductsLegacy({});
  assert.equal(sent.buying_mode, 'wholesale');
});

test('getProducts requires account for the seller account contract', async () => {
  const { client, calls } = clientWithCapabilities(
    capabilities({ account: { require_operator_auth: true, required_for_products: true } })
  );
  await assert.rejects(client.getProducts({ brief: 'sports' }), error => {
    assert.ok(error instanceof AccountRequiredError);
    assert.equal(error.accountModel, 'explicit');
    return true;
  });
  assert.equal(calls.length, 0);
  await client.getProducts({ brief: 'sports', account: { account_id: 'acc-1' } });
  assert.deepEqual(calls[0].account, { account_id: 'acc-1' });
});

test('operator auth alone does not require an account for product discovery', async () => {
  const { client, calls } = clientWithCapabilities(
    capabilities({ account: { require_operator_auth: true, required_for_products: false } })
  );
  await client.getProducts({ brief: 'sports' });
  assert.equal(calls.length, 1);
});

test('resolveAccount selects a singleton and never guesses among multiple accounts', async () => {
  const { client } = clientWithCapabilities(capabilities({ account: { require_operator_auth: true } }));
  const rows = [
    { account_id: 'acc-1', status: 'active', brand: { domain: 'one.example' } },
    { account_id: 'acc-2', status: 'active', brand: { domain: 'two.example' } },
  ];
  client.listAccounts = async () => ({ success: true, status: 'completed', data: { accounts: rows } });
  await assert.rejects(client.resolveAccount(), AccountAmbiguousError);
  assert.deepEqual(await client.resolveAccount({ brand: { domain: 'two.example' } }), { account_id: 'acc-2' });
  assert.deepEqual(await client.resolveAccount({ select: 'acc-1' }), { account_id: 'acc-1' });
  await assert.rejects(client.resolveAccount({ select: 'unlisted' }), AccountRequiredError);
  rows.pop();
  assert.deepEqual(await client.resolveAccount(), { account_id: 'acc-1' });
});

test('AgentClient resolveAccount retains the nested task context without reusing another task id', async () => {
  const wrapper = new AgentClient({
    id: 'seller',
    name: 'Seller',
    agent_uri: 'https://seller.example/mcp',
    protocol: 'mcp',
  });
  wrapper.currentContextId = 'old-context';
  wrapper.pendingTask = { taskId: 'stale-list-task', contextId: 'old-context', taskName: 'list_accounts' };
  wrapper.client.resolveAccount = async (_hints, options, onTaskResult) => {
    assert.equal(options.contextId, 'old-context');
    assert.equal(options.taskId, undefined);
    onTaskResult({ metadata: { status: 'completed', contextId: 'new-context', taskName: 'sync_accounts' } });
    return { brand: { domain: 'brand.example' }, operator: 'agency.example' };
  };
  await wrapper.resolveAccount({ brand: { domain: 'brand.example' }, operator: 'agency.example' });
  assert.equal(wrapper.currentContextId, 'new-context');
  assert.equal(wrapper.pendingTask, undefined);
});

test('resolveAccount requires active status and matches the effective sandbox value', async () => {
  const { client } = clientWithCapabilities(capabilities({ account: { require_operator_auth: true } }));
  let rows = [{ account_id: 'acc-1', brand: { domain: 'brand.example' } }];
  client.listAccounts = async () => ({ success: true, status: 'completed', data: { accounts: rows } });
  await assert.rejects(client.resolveAccount(), AccountRequiredError);
  rows = [{ account_id: 'acc-1', status: 'active', brand: { domain: 'brand.example' } }];
  await assert.rejects(client.resolveAccount({ sandbox: true }), AccountRequiredError);
  assert.deepEqual(await client.resolveAccount({ sandbox: false }), { account_id: 'acc-1' });
  rows = [{ account_id: 'acc-2', status: 'active', sandbox: true, brand: { domain: 'brand.example' } }];
  assert.deepEqual(await client.resolveAccount({ sandbox: true }), { account_id: 'acc-2' });
  await assert.rejects(client.resolveAccount({ sandbox: false }), AccountRequiredError);
});

test('listed account selection defaults to production and matches country identity', () => {
  const accounts = [
    { account_id: 'sandbox', status: 'active', sandbox: true, brand: { domain: 'brand.example', countries: ['NL'] } },
    { account_id: 'germany', status: 'active', brand: { domain: 'brand.example', countries: ['DE'] } },
    { account_id: 'netherlands', status: 'active', brand: { domain: 'brand.example', countries: ['NL'] } },
  ];
  assert.deepEqual(selectListedAccount(accounts, { brand: { domain: 'brand.example', countries: ['NL'] } }), {
    account_id: 'netherlands',
  });
  assert.deepEqual(
    selectListedAccount(accounts, { brand: { domain: 'brand.example', countries: ['NL'] }, sandbox: true }),
    {
      account_id: 'sandbox',
    }
  );
});

test('listed account selection honors introspected task authorization when requested', () => {
  const accounts = [
    { account_id: 'audit', status: 'active', authorization: { allowed_tasks: ['get_media_buys'] } },
    { account_id: 'buyer', status: 'active', authorization: { allowed_tasks: ['create_media_buy'] } },
  ];
  assert.deepEqual(selectListedAccount(accounts, { forTask: 'create_media_buy' }), { account_id: 'buyer' });
});

test('resolveAccount examines every account page before selecting a singleton', async () => {
  const { client } = clientWithCapabilities(capabilities({ account: { require_operator_auth: true } }));
  client.listAccounts = async params =>
    params.pagination?.cursor
      ? {
          success: true,
          status: 'completed',
          data: {
            accounts: [{ account_id: 'acc-2', status: 'active', brand: { domain: 'two.example' } }],
            pagination: { has_more: false },
          },
        }
      : {
          success: true,
          status: 'completed',
          data: {
            accounts: [{ account_id: 'acc-1', status: 'active', brand: { domain: 'one.example' } }],
            pagination: { has_more: true, cursor: 'next' },
          },
        };
  await assert.rejects(client.resolveAccount(), AccountAmbiguousError);
  assert.deepEqual(await client.resolveAccount({ brand: { domain: 'two.example' } }), { account_id: 'acc-2' });
});

test('resolveAccount syncs an implicit natural key before returning it', async () => {
  const { client } = clientWithCapabilities(
    capabilities({ account: { require_operator_auth: false, supported_billing: ['operator'] } })
  );
  let synced;
  client.syncAccounts = async params => {
    synced = params;
    return {
      success: true,
      status: 'completed',
      data: {
        accounts: [
          {
            brand: { domain: 'brand.example' },
            operator: 'agency.example',
            billing: 'operator',
            action: 'created',
            status: 'active',
          },
        ],
      },
    };
  };
  await assert.rejects(client.resolveAccount({ brand: { domain: 'brand.example' } }), AccountRequiredError);
  const account = await client.resolveAccount({ brand: { domain: 'brand.example' }, operator: 'agency.example' });
  assert.deepEqual(account, { brand: { domain: 'brand.example' }, operator: 'agency.example' });
  assert.deepEqual(synced.accounts, [
    { brand: { domain: 'brand.example' }, operator: 'agency.example', billing: 'operator' },
  ]);
});

test('resolveAccount preserves every buyer-selected natural-key field', async () => {
  const { client } = clientWithCapabilities(
    capabilities({
      versions: ['3.2.0-rc.7'],
      account: {
        require_operator_auth: false,
        supported_billing: ['operator'],
        supported_account_currency_modes: ['fixed'],
        timezone: {
          mode: 'account_fixed',
          account_selection: 'buyer_selected',
          supported_timezones: ['America/New_York'],
        },
      },
    })
  );
  const hints = {
    brand: { domain: 'brand.example' },
    operator: 'agency.example',
    operatorUnit: { id: 'seat-1' },
    currency: 'USD',
    timezone: 'America/New_York',
    sandbox: true,
  };
  let synced;
  client.syncAccounts = async params => {
    synced = params;
    return {
      success: true,
      status: 'completed',
      data: {
        accounts: [
          {
            brand: hints.brand,
            operator: hints.operator,
            operator_unit: hints.operatorUnit,
            currency: hints.currency,
            timezone: hints.timezone,
            sandbox: true,
            action: 'created',
            status: 'active',
          },
        ],
      },
    };
  };
  const expected = {
    brand: hints.brand,
    operator: hints.operator,
    operator_unit: hints.operatorUnit,
    currency: hints.currency,
    timezone: hints.timezone,
    sandbox: true,
  };
  assert.deepEqual(await client.resolveAccount(hints), expected);
  assert.deepEqual(synced.accounts, [{ ...expected, billing: 'operator' }]);
  await assert.rejects(client.resolveAccount({ ...hints, timezone: undefined }), AccountRequiredError);
  await assert.rejects(client.resolveAccount({ ...hints, currency: undefined }), AccountRequiredError);
});

test('resolveAccount rejects 3.2-only natural-key fields for a 3.1 seller', async () => {
  const { client } = clientWithCapabilities(
    capabilities({ account: { require_operator_auth: false, supported_billing: ['operator'] } })
  );
  let called = false;
  client.syncAccounts = async () => {
    called = true;
  };
  await assert.rejects(
    client.resolveAccount({ brand: { domain: 'brand.example' }, operator: 'agency.example', currency: 'USD' }),
    AccountRequiredError
  );
  assert.equal(called, false);
});

test('resolveAccount does not return an implicit key after a failed account row', async () => {
  const { client } = clientWithCapabilities(
    capabilities({ account: { require_operator_auth: false, supported_billing: ['operator'] } })
  );
  client.syncAccounts = async () => ({
    success: true,
    status: 'completed',
    data: {
      accounts: [{ brand: { domain: 'brand.example' }, operator: 'agency.example', action: 'failed' }],
    },
  });
  await assert.rejects(
    client.resolveAccount({ brand: { domain: 'brand.example' }, operator: 'agency.example' }),
    AccountRequiredError
  );
});

test('resolveAccount surfaces pending approval with the provisional account reference', async () => {
  const { client } = clientWithCapabilities(
    capabilities({ account: { require_operator_auth: false, supported_billing: ['operator'] } })
  );
  client.syncAccounts = async () => ({
    success: true,
    status: 'completed',
    data: {
      accounts: [
        {
          account_id: 'acc-pending',
          brand: { domain: 'brand.example' },
          operator: 'agency.example',
          action: 'created',
          status: 'pending_approval',
        },
      ],
    },
  });
  await assert.rejects(
    client.resolveAccount({ brand: { domain: 'brand.example' }, operator: 'agency.example' }),
    error => {
      assert.ok(error instanceof AccountPendingApprovalError);
      assert.equal(error.accountId, 'acc-pending');
      assert.deepEqual(error.account, { brand: { domain: 'brand.example' }, operator: 'agency.example' });
      return true;
    }
  );
});

test('resolveAccount does not guess a billing party when several are supported', async () => {
  const { client } = clientWithCapabilities(
    capabilities({ account: { require_operator_auth: false, supported_billing: ['operator', 'advertiser'] } })
  );
  let called = false;
  client.syncAccounts = async () => {
    called = true;
  };
  await assert.rejects(
    client.resolveAccount({ brand: { domain: 'brand.example' }, operator: 'agency.example' }),
    AccountRequiredError
  );
  assert.equal(called, false);
});

test('media-buy storyboard delegates declared account contracts to the public resolver', async () => {
  let passedHints;
  const resolved = await resolveAccountForMediaBuy(
    { brand: { domain: 'brand.example' } },
    ['list_accounts'],
    async () => {
      throw new Error('legacy list callback must not run');
    },
    { requireOperatorAuth: true },
    async hints => {
      passedHints = hints;
      return { account_id: 'acc-1' };
    }
  );
  assert.deepEqual(passedHints, { brand: { domain: 'brand.example' }, forTask: 'create_media_buy' });
  assert.deepEqual(resolved.accountRef, { account_id: 'acc-1' });
  assert.equal(resolved.steps[0].passed, true);
});
