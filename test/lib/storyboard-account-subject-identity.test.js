/**
 * Storyboard runner: account-subject identity survives the run-brand invariant.
 *
 * Regression for the hybrid account reference the test kit put on the wire.
 * A run whose buying brand is `acmeoutdoor.example` provisions a *different*
 * account through `sync_accounts` (`brand: test.example`, `operator:
 * test.example`, `sandbox: true`). `applyBrandInvariant` then merged the run
 * brand into the resolved natural key of the follow-up reads, shipping
 * `{brand: acmeoutdoor.example, operator: test.example}`: schema-valid, and
 * nobody's account. A correct seller answers `accounts: []` / `total_count: 0`
 * and a strict account-aware controller refuses the state transition, so the
 * account phase of the deterministic-testing storyboard could never pass.
 *
 * A natural-key AccountReference is a composite identity (see
 * `core/account-ref.json`: the natural-key arm requires `brand` AND
 * `operator`). `list_accounts.account` is specified as an "exact account
 * filter". Replacing half of a composite identity re-addresses the request,
 * it does not re-scope it.
 */

const { describe, test, it } = require('node:test');
const assert = require('node:assert/strict');
const { z } = require('zod');

const {
  applyBrandInvariant,
  runStoryboard,
  ACCOUNT_SUBJECT_TASKS,
  ACCOUNT_SUBJECT_CONTROLLER_SCENARIOS,
} = require('../../dist/lib/testing/storyboard/runner.js');

const RUN_BRAND = { domain: 'acmeoutdoor.example' };
const TEST_BRAND = { domain: 'test.example', brand_id: 'deterministic' };
const TEST_ACCOUNT = { brand: TEST_BRAND, operator: 'test.example', sandbox: true };

// ────────────────────────────────────────────────────────────
// Unit: the exception itself
// ────────────────────────────────────────────────────────────

describe('applyBrandInvariant: account-subject requests keep the resolved identity', () => {
  test('list_accounts keeps a resolved natural key verbatim instead of shipping a hybrid', () => {
    const result = applyBrandInvariant(
      { account: { ...TEST_ACCOUNT }, sandbox: true },
      { brand: RUN_BRAND, sandbox: true },
      'list_accounts'
    );
    assert.deepEqual(result.account, TEST_ACCOUNT);
    assert.equal(result.account.brand.domain, 'test.example');
    assert.equal(result.account.brand.brand_id, 'deterministic', 'authored brand_id must survive');
  });

  test('list_accounts preserves nested brand metadata the run brand does not carry', () => {
    const richBrand = { domain: 'test.example', brand_id: 'deterministic', countries: ['BE', 'DE', 'NL'] };
    const result = applyBrandInvariant(
      { account: { brand: richBrand, operator: 'agency.example', sandbox: true } },
      { brand: RUN_BRAND },
      'list_accounts'
    );
    assert.deepEqual(result.account.brand, richBrand);
    assert.equal(result.account.operator, 'agency.example');
  });

  test('the exception holds when the run brand comes from brand_manifest', () => {
    const result = applyBrandInvariant(
      { account: { ...TEST_ACCOUNT } },
      {
        brand_manifest: { name: 'Acme', url: 'https://acmeoutdoor.example' },
      },
      'list_accounts'
    );
    assert.deepEqual(result.account, TEST_ACCOUNT);
  });

  test('force_account_status keeps the account whose state machine it drives', () => {
    const result = applyBrandInvariant(
      {
        account: { ...TEST_ACCOUNT },
        scenario: 'force_account_status',
        params: { account_id: 'acct_1', status: 'suspended' },
      },
      { brand: RUN_BRAND },
      'comply_test_controller'
    );
    assert.deepEqual(result.account, TEST_ACCOUNT);
  });

  test('an account_id-namespace reference stays exact on account-subject requests', () => {
    for (const task of ['list_accounts', 'comply_test_controller']) {
      const result = applyBrandInvariant(
        { account: { account_id: 'acct_upstream_1' }, scenario: 'force_account_status' },
        { brand: RUN_BRAND },
        task
      );
      assert.deepEqual(result.account, { account_id: 'acct_upstream_1' }, task);
    }
  });

  test('the sets are exported so adopters can see what the exception covers', () => {
    assert.equal(ACCOUNT_SUBJECT_TASKS.has('list_accounts'), true);
    assert.equal(ACCOUNT_SUBJECT_CONTROLLER_SCENARIOS.has('force_account_status'), true);
  });
});

describe('applyBrandInvariant: the exception adds, it never repairs', () => {
  test('a brand-less natural key still gets the run brand (documented scaffolding)', () => {
    const result = applyBrandInvariant(
      { account: { operator: 'test.example', sandbox: true } },
      { brand: RUN_BRAND },
      'list_accounts'
    );
    assert.deepEqual(result.account, { operator: 'test.example', sandbox: true, brand: RUN_BRAND });
  });

  test('a missing operator is defaulted from the PRESERVED brand, not the run brand (#1419)', () => {
    const result = applyBrandInvariant(
      { account: { brand: TEST_BRAND, sandbox: true } },
      { brand: RUN_BRAND },
      'list_accounts'
    );
    assert.deepEqual(result.account, { brand: TEST_BRAND, operator: 'test.example', sandbox: true });
  });

  for (const [label, malformed] of [
    ['null brand', null],
    ['string brand', 'test.example'],
    ['array brand', []],
    ['brand object without the required domain', {}],
  ]) {
    test(`a malformed ${label} is left for the seller to refuse, not substituted`, () => {
      const result = applyBrandInvariant(
        { account: { brand: malformed, operator: 'test.example', sandbox: true } },
        { brand: RUN_BRAND },
        'list_accounts'
      );
      assert.deepEqual(result.account, { brand: malformed, operator: 'test.example', sandbox: true });
      assert.notDeepEqual(result.account.brand, RUN_BRAND);
    });
  }

  test('a non-object account is still left alone', () => {
    for (const account of [null, []]) {
      const result = applyBrandInvariant({ account }, { brand: RUN_BRAND }, 'list_accounts');
      assert.equal(result.account, account);
    }
  });

  test('does not mutate the caller-supplied request or account', () => {
    const account = { ...TEST_ACCOUNT };
    const request = { account, sandbox: true };
    applyBrandInvariant(request, { brand: RUN_BRAND }, 'list_accounts');
    assert.deepEqual(request, { account: TEST_ACCOUNT, sandbox: true });
    assert.deepEqual(account, TEST_ACCOUNT);
  });
});

describe('applyBrandInvariant: ordinary run-brand behavior is untouched', () => {
  test('buying tools still converge a conflicting account.brand on the run brand (#579)', () => {
    const result = applyBrandInvariant(
      { account: { brand: TEST_BRAND, operator: 'test.example' } },
      { brand: RUN_BRAND },
      'get_media_buys'
    );
    assert.deepEqual(result.account.brand, RUN_BRAND);
    assert.equal(result.account.operator, 'test.example');
  });

  test('operation-scoped controller scenarios keep the run buying context', () => {
    for (const scenario of ['force_create_media_buy_arm', 'simulate_delivery', 'seed_account']) {
      const result = applyBrandInvariant(
        { account: { brand: TEST_BRAND, operator: 'test.example', sandbox: true }, scenario },
        { brand: RUN_BRAND },
        'comply_test_controller'
      );
      assert.deepEqual(result.account.brand, RUN_BRAND, scenario);
    }
  });

  test('a controller request with no scenario string keeps the run buying context', () => {
    const result = applyBrandInvariant(
      { account: { brand: TEST_BRAND, operator: 'test.example', sandbox: true } },
      { brand: RUN_BRAND },
      'comply_test_controller'
    );
    assert.deepEqual(result.account.brand, RUN_BRAND);
  });

  test('an unfiltered list_accounts still enumerates every visible account', () => {
    const request = { sandbox: true, pagination: { max_results: 2 } };
    const result = applyBrandInvariant(request, { brand: RUN_BRAND, sandbox: true }, 'list_accounts');
    assert.deepEqual(result, request);
    assert.equal('account' in result, false);
  });

  test('omit_account still ships an account-subject request exactly as authored', () => {
    const request = { account: { ...TEST_ACCOUNT } };
    const result = applyBrandInvariant(request, { brand: RUN_BRAND }, 'list_accounts', { omit_account: true });
    assert.deepEqual(result.account, TEST_ACCOUNT);
    const omitted = applyBrandInvariant({ sandbox: true }, { brand: RUN_BRAND }, 'list_accounts', {
      omit_account: true,
    });
    assert.equal('account' in omitted, false);
  });

  test('the synthetic default account is still the run brand for tools that need one', () => {
    const result = applyBrandInvariant({}, { brand: RUN_BRAND, sandbox: true }, 'get_media_buys');
    assert.deepEqual(result.account, { brand: RUN_BRAND, operator: RUN_BRAND.domain, sandbox: true });
  });

  test('request_account stays brand-subject', () => {
    const authored = { idempotency_key: 'k', brand: TEST_BRAND, operator: 'test.example' };
    assert.deepEqual(applyBrandInvariant(authored, { brand: RUN_BRAND }, 'request_account'), authored);
  });
});

// ────────────────────────────────────────────────────────────
// Integration: strict persisted-ownership seller, real wire
// ────────────────────────────────────────────────────────────

/**
 * A seller that stores the natural key it was provisioned with and answers
 * only exact matches — the behavior that turns the hybrid reference into a
 * visible failure rather than a silent one. `list_accounts.account` is an
 * exact filter (strictAccountReferences: true keeps the framework from
 * resolving it as the request's own account), and the controller refuses a
 * transition whose account scope does not own `params.account_id`.
 *
 * Requests and responses are validated against the selected AdCP 3.1
 * schemas in both directions; nothing here relaxes validation or invents a
 * fallback payload.
 */
const ADCP_WIRE_VERSION = '3.1.31';

function naturalKey(ref) {
  return JSON.stringify({
    domain: ref?.brand?.domain ?? null,
    brand_id: ref?.brand?.brand_id ?? null,
    operator: ref?.operator ?? null,
    sandbox: ref?.sandbox === true,
  });
}

function createStrictAccountSeller() {
  const { createAdcpServer } = require('../../dist/lib/server/create-adcp-server.js');
  const { ADCP_CAPABILITIES, getSdkServer } = require('../../dist/lib/server/adcp-server.js');
  const { TOOL_INPUT_SHAPE, toMcpResponse } = require('../../dist/lib/server/test-controller.js');
  const { InMemoryStateStore } = require('../../dist/lib/server/state-store.js');
  const { createIdempotencyStore, memoryBackend } = require('../../dist/lib/server/idempotency/index.js');

  const store = new Map();
  const wire = [];
  let nextId = 1;

  const persist = entry => {
    const key = naturalKey(entry);
    for (const row of store.values()) if (naturalKey(row) === key) return { row, action: 'unchanged' };
    const row = {
      account_id: `acct_${nextId++}`,
      name: `${entry.brand?.domain ?? 'unknown'} via ${entry.operator ?? 'unknown'}`,
      status: 'active',
      brand: entry.brand,
      operator: entry.operator,
      ...(entry.sandbox !== undefined && { sandbox: entry.sandbox }),
      billing: entry.billing ?? 'operator',
    };
    store.set(row.account_id, row);
    return { row, action: 'created' };
  };

  // The run's own buying account exists too: later steps must still address
  // it, which is what proves the exception did not leak across the run.
  persist({ brand: RUN_BRAND, operator: RUN_BRAND.domain, sandbox: true });

  const lookup = ref => {
    if (ref == null || typeof ref !== 'object' || Array.isArray(ref)) return undefined;
    if (typeof ref.account_id === 'string') return store.get(ref.account_id);
    const key = naturalKey(ref);
    for (const row of store.values()) if (naturalKey(row) === key) return row;
    return undefined;
  };

  const server = createAdcpServer({
    name: 'strict-account-owner-seller',
    version: '1.0.0',
    adcpVersion: ADCP_WIRE_VERSION,
    validation: { requests: 'strict', responses: 'strict' },
    strictAccountReferences: true,
    stateStore: new InMemoryStateStore(),
    idempotency: createIdempotencyStore({ backend: memoryBackend({ sweepIntervalMs: 0 }) }),
    resolveIdempotencyPrincipal: () => 'account-subject-regression-buyer',
    resolveAccount: async ref => lookup(ref) ?? null,
    accounts: {
      syncAccounts: async params => {
        wire.push({ tool: 'sync_accounts', params });
        return {
          accounts: params.accounts.map(entry => {
            const { row, action } = persist(entry);
            return {
              account_id: row.account_id,
              brand: row.brand,
              operator: row.operator,
              ...(row.sandbox !== undefined && { sandbox: row.sandbox }),
              action,
              status: row.status,
              billing: row.billing,
            };
          }),
        };
      },
      listAccounts: async params => {
        wire.push({ tool: 'list_accounts', params });
        // `account` is an EXACT filter: a reference that matches no persisted
        // owner selects nothing. No brand-only / operator-only fuzzy fallback.
        const rows = params.account ? [lookup(params.account)].filter(Boolean) : [...store.values()];
        const visible = params.sandbox === undefined ? rows : rows.filter(r => (r.sandbox === true) === params.sandbox);
        return { accounts: visible, pagination: { has_more: false, total_count: visible.length } };
      },
    },
    mediaBuy: {
      getMediaBuys: async params => {
        wire.push({ tool: 'get_media_buys', params });
        return { media_buys: [] };
      },
    },
  });

  server[ADCP_CAPABILITIES].compliance_testing = { scenarios: ['force_account_status'] };

  getSdkServer(server).registerTool(
    'comply_test_controller',
    {
      description: 'Strict account-aware state machine for this regression.',
      inputSchema: { ...TOOL_INPUT_SHAPE, brand: z.record(z.string(), z.unknown()).optional() },
    },
    async input => {
      wire.push({ tool: 'comply_test_controller', params: input });
      if (input.scenario === 'list_scenarios') {
        return toMcpResponse({ status: 'completed', success: true, scenarios: ['force_account_status'] });
      }
      if (input.scenario !== 'force_account_status') {
        return toMcpResponse({ status: 'completed', success: false, error: 'UNKNOWN_SCENARIO' });
      }
      const target = store.get(input.params?.account_id);
      const scope = lookup(input.account);
      if (!target) {
        return toMcpResponse({ status: 'completed', success: false, error: 'NOT_FOUND', message: 'unknown account' });
      }
      if (!scope || scope.account_id !== target.account_id) {
        // The hybrid reference lands here: a scope that owns nothing, or that
        // owns a different account than the one being transitioned.
        return toMcpResponse({
          status: 'completed',
          success: false,
          error: 'NOT_FOUND',
          message: `account scope ${JSON.stringify(input.account)} does not own ${input.params?.account_id}`,
        });
      }
      const previous = target.status;
      target.status = input.params.status;
      return toMcpResponse({
        status: 'completed',
        success: true,
        previous_state: previous,
        current_state: target.status,
      });
    }
  );

  return { server, store, wire, lookup };
}

const ACCOUNT_LIFECYCLE_STORYBOARD = {
  id: 'account_subject_identity_lifecycle',
  version: '1.0.0',
  title: 'Account-subject identity survives a different run brand',
  category: 'compliance',
  summary: '',
  narrative: '',
  agent: { interaction_model: '*', capabilities: [] },
  caller: { role: 'buyer_agent' },
  phases: [
    {
      id: 'account_state',
      title: 'Provision, read back, and drive one account through its state machine',
      steps: [
        {
          id: 'provision_test_account',
          title: 'Provision the deterministic test account',
          task: 'sync_accounts',
          sample_request: {
            accounts: [{ brand: TEST_BRAND, operator: 'test.example', sandbox: true, billing: 'operator' }],
          },
          validations: [{ check: 'field_present', path: 'accounts[0].account_id', description: '' }],
        },
        {
          id: 'read_test_account',
          title: 'Read exactly that account back',
          task: 'list_accounts',
          sample_request: { account: '$context.account', sandbox: true },
          validations: [{ check: 'field_present', path: 'accounts[0].account_id', description: '' }],
        },
        {
          id: 'suspend_test_account',
          title: 'Suspend it',
          task: 'comply_test_controller',
          sample_request: {
            account: { sandbox: true },
            scenario: 'force_account_status',
            params: { account_id: '$context.account_id', status: 'suspended' },
          },
          validations: [
            { check: 'field_value', path: 'success', allowed_values: [true], description: '' },
            { check: 'field_value', path: 'current_state', allowed_values: ['suspended'], description: '' },
          ],
        },
        {
          id: 'reactivate_test_account',
          title: 'Reactivate it',
          task: 'comply_test_controller',
          sample_request: {
            account: { sandbox: true },
            scenario: 'force_account_status',
            params: { account_id: '$context.account_id', status: 'active' },
          },
          validations: [
            { check: 'field_value', path: 'success', allowed_values: [true], description: '' },
            { check: 'field_value', path: 'current_state', allowed_values: ['active'], description: '' },
          ],
        },
        {
          // Isolation control: an ordinary buying read authored against a
          // third brand must still converge on the RUN brand (#579). The
          // account-subject exception must not leak into it, and the account
          // phase's `test.example` identity must not follow it either.
          id: 'run_brand_resource_read',
          title: 'A later buying read still converges on the run brand',
          task: 'get_media_buys',
          sample_request: {
            account: { brand: { domain: 'third-party.example' }, operator: 'acmeoutdoor.example', sandbox: true },
          },
          validations: [{ check: 'field_present', path: 'media_buys', description: '' }],
        },
      ],
    },
  ],
};

describe('runStoryboard: account-subject identity on the wire', () => {
  it('provisions, reads back and drives one account while the run brand is someone else', async t => {
    const { serve } = require('../../dist/lib/index.js');

    const { server, store, wire } = createStrictAccountSeller();
    const http = serve(() => server, {
      port: 0,
      authenticate: () => ({ principal: 'account-subject-regression-buyer' }),
      onListening: () => {},
    });
    await new Promise((resolve, reject) => {
      if (http.listening) return resolve();
      http.once('listening', resolve);
      http.once('error', reject);
    });
    t.after(async () => {
      http.closeAllConnections();
      await new Promise((resolve, reject) => http.close(error => (error ? reject(error) : resolve())));
      await server.close();
    });
    const url = `http://127.0.0.1:${http.address().port}/mcp`;
    const agentTools = ['sync_accounts', 'list_accounts', 'comply_test_controller', 'get_media_buys'];

    const result = await runStoryboard(url, ACCOUNT_LIFECYCLE_STORYBOARD, {
      protocol: 'mcp',
      allow_http: true,
      brand: RUN_BRAND,
      sandbox: true,
      adcpVersion: ADCP_WIRE_VERSION,
      skip_controller_seeding: true,
      agentTools,
    });

    assert.equal(result.overall_passed, true, JSON.stringify(result, null, 2));
    assert.equal(result.failed_count, 0, JSON.stringify(result, null, 2));

    const listCall = wire.find(c => c.tool === 'list_accounts');
    assert.ok(listCall, 'list_accounts never reached the seller');
    assert.deepEqual(
      listCall.params.account,
      { brand: TEST_BRAND, operator: 'test.example', sandbox: true },
      'the exact provisioned natural key must reach the wire, not a run-brand hybrid'
    );

    const transitions = wire.filter(c => c.tool === 'comply_test_controller');
    assert.equal(transitions.length, 2);
    for (const call of transitions) {
      assert.deepEqual(
        { brand: call.params.account.brand, operator: call.params.account.operator },
        { brand: TEST_BRAND, operator: 'test.example' },
        'the controller scope must be the account whose state machine it drives'
      );
    }

    const buyingRead = wire.find(c => c.tool === 'get_media_buys');
    assert.ok(buyingRead, 'get_media_buys never reached the seller');
    assert.deepEqual(
      buyingRead.params.account,
      { brand: RUN_BRAND, operator: RUN_BRAND.domain, sandbox: true },
      'ordinary buying reads must still travel on the run brand'
    );

    const provisioned = [...store.values()].find(row => row.brand?.domain === 'test.example');
    assert.ok(provisioned, 'the seller never persisted the test account');
    assert.equal(provisioned.status, 'active', 'suspend then reactivate must land back on the persisted owner');
    assert.equal(store.size, 2, 'no phantom hybrid account was provisioned along the way');
  });
});
