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
 * A natural-key AccountReference is a composite identity: `core/account-ref.json`'s natural-key
 * arm is `required: [brand, operator]`, `additionalProperties: false`, in every supported release.
 * `list_accounts.account` is a filter over the account's own parties ("exact account filter" in
 * 3.1.31 / 3.2.8; 3.3.0-beta.3 relaxes multiplicity but keeps the natural key valid as a
 * `list_accounts` filter and returns `ACCOUNT_AMBIGUOUS` when several accounts match). Replacing
 * half of a composite identity re-addresses the request, it does not re-scope it.
 */

const { describe, test, it } = require('node:test');
const assert = require('node:assert/strict');
const { z } = require('zod');

const { applyBrandInvariant, runStoryboard } = require('../../dist/lib/testing/storyboard/runner.js');

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

  test('an account_id-namespace reference stays exact on an account-subject read', () => {
    const result = applyBrandInvariant(
      { account: { account_id: 'acct_upstream_1' }, sandbox: true },
      { brand: RUN_BRAND },
      'list_accounts'
    );
    assert.deepEqual(result.account, { account_id: 'acct_upstream_1' });
  });

  test('an account_id-namespace reference stays exact on an account-subject control', () => {
    // The shape the controller enricher actually produces: `{account_id}` plus the sandbox
    // assertion it stamps on every comply_test_controller request.
    const result = applyBrandInvariant(
      {
        account: { account_id: 'acct_upstream_1', sandbox: true },
        scenario: 'force_account_status',
        params: { account_id: 'acct_upstream_1', status: 'suspended' },
      },
      { brand: RUN_BRAND },
      'comply_test_controller'
    );
    assert.deepEqual(result.account, { account_id: 'acct_upstream_1', sandbox: true });
  });

  test('the other account-subject reads keep their resolved identity too', () => {
    // `get_account_financials.account` is "Account to query financials for. Must be an
    // operator-billed account" and `list_account_changes.account` binds the returned cursor to the
    // resolved account — both are the account the request is about, and both are fed
    // `context.account ?? resolveAccount(options)` by the request builder.
    for (const task of ['get_account_financials', 'list_account_changes']) {
      const result = applyBrandInvariant({ account: { ...TEST_ACCOUNT } }, { brand: RUN_BRAND }, task);
      assert.deepEqual(result.account, TEST_ACCOUNT, task);
    }
  });

  test('expire_account_change_cursor keeps the account whose cursor it invalidates', () => {
    // Belt-and-braces entry, exercised with a request the release actually accepts. 3.2.8 and
    // 3.3.0-beta.3 constrain this scenario's `account` to `required: [account_id]` (3.0.25 and
    // 3.1.31 do not define the scenario at all), so a pure natural key is not a legal carrier
    // here. The controller's `account` is an OPEN routing object (`required: [sandbox]`,
    // `additionalProperties: true`) and does not `$ref` the closed `core/account-ref.json` id
    // arm, so an id plus brand/operator routing metadata is valid — and that hybrid-shaped
    // carrier is the only shape where the carve-out can bite.
    const { getSchemaValidatorByRef } = require('../../dist/lib/validation/schema-loader.js');
    const carrier = { account_id: 'acct_luma_shared', sandbox: true, brand: TEST_BRAND, operator: 'test.example' };
    const request = {
      account: carrier,
      scenario: 'expire_account_change_cursor',
      params: { account_id: 'acct_luma_shared' },
    };
    const validate = getSchemaValidatorByRef('compliance/comply-test-controller-request.json', '3.2.8', undefined, {
      allErrors: true,
    });
    assert.equal(typeof validate, 'function', '3.2.8 controller request schema must be in the shipped bundle');
    assert.ok(validate(request), `carrier is not a valid 3.2.8 request: ${JSON.stringify(validate.errors)}`);

    const result = applyBrandInvariant(request, { brand: RUN_BRAND }, 'comply_test_controller');
    assert.deepEqual(result.account, carrier);
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

  test('simulate_budget_spend is deliberately not account-subject (dual-arm params)', () => {
    const result = applyBrandInvariant(
      {
        account: { brand: TEST_BRAND, operator: 'test.example', sandbox: true },
        scenario: 'simulate_budget_spend',
        params: { account_id: 'acct_2', spend_percentage: 50 },
      },
      { brand: RUN_BRAND },
      'comply_test_controller'
    );
    assert.deepEqual(result.account.brand, RUN_BRAND);
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
 * Validation is strict in both directions and comes from the selected release,
 * never from this file. The framework tools go through `createAdcpServer`'s
 * `validation: { requests: 'strict', responses: 'strict' }` pipeline.
 * `comply_test_controller` is a custom-registered tool and does NOT go through
 * that pipeline, so the handler binds the release's own controller validators
 * with `getSchemaValidatorByRef` and runs them on every dispatch — the input it
 * received and the `structuredContent` `toMcpResponse` actually produced,
 * refusal branches included. Nothing here relaxes a schema or invents a payload.
 */
const ADCP_WIRE_VERSION = '3.1.31';

/** The release's own controller schemas, from the shipped bundle. Not a local copy. */
function controllerValidators() {
  const { getSchemaDocumentByRef, getSchemaValidatorByRef } = require('../../dist/lib/validation/schema-loader.js');
  const bind = direction => {
    const ref = `compliance/comply-test-controller-${direction}.json`;
    const doc = getSchemaDocumentByRef(ref, ADCP_WIRE_VERSION);
    assert.ok(doc, `${ref} is not in the shipped ${ADCP_WIRE_VERSION} bundle`);
    assert.equal(
      doc.schema.$id,
      `/schemas/${ADCP_WIRE_VERSION}/${ref}`,
      'controller validation must bind the selected release, not another one'
    );
    assert.equal(doc.resolvedVersion, ADCP_WIRE_VERSION);
    const validate = getSchemaValidatorByRef(ref, ADCP_WIRE_VERSION, undefined, { allErrors: true });
    assert.equal(typeof validate, 'function', `${ref} did not compile`);
    return validate;
  };
  const request = bind('request');
  const response = bind('response');
  return {
    request: payload => {
      assert.ok(
        request(payload),
        `controller request violates ${ADCP_WIRE_VERSION}: ${JSON.stringify(request.errors)}`
      );
      return payload;
    },
    response: payload => {
      assert.ok(
        response(payload),
        `controller response violates ${ADCP_WIRE_VERSION}: ${JSON.stringify(response.errors)}`
      );
      return payload;
    },
  };
}

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

  const controller = controllerValidators();
  const violations = [];
  // An `assert` thrown inside an MCP tool callback becomes an isError CallToolResult, which the
  // runner reports as a generic step failure with the AJV output swallowed. Collect instead and
  // assert after the run so a schema violation names itself.
  const check = (direction, payload) => {
    try {
      controller[direction](payload);
    } catch (error) {
      violations.push(`${direction}: ${error.message}`);
    }
  };
  // Every dispatch, both directions. `reply` validates what `toMcpResponse` actually serialized,
  // not the object literal handed to it, so a refusal is held to the same contract as a success.
  const reply = payload => {
    const serialized = toMcpResponse(payload);
    check('response', JSON.parse(JSON.stringify(serialized.structuredContent)));
    return serialized;
  };

  getSdkServer(server).registerTool(
    'comply_test_controller',
    {
      description: 'Strict account-aware state machine for this regression.',
      // `brand` is an OBSERVER, not a schema relaxation. `registerTool` parses arguments with
      // `z.object(shape)`, which strips undeclared keys — so without this the test could never
      // see whether the runner put a top-level `brand` on the wire, and the commit's "stops
      // adding an undeclared top-level brand" claim would have no wire-level assertion. The
      // controller request root is `additionalProperties: true`, so carrying the field through is
      // still valid under the release's own schema, which every dispatch is validated against.
      inputSchema: { ...TOOL_INPUT_SHAPE, brand: z.unknown().optional() },
    },
    async input => {
      wire.push({ tool: 'comply_test_controller', params: input });
      check('request', JSON.parse(JSON.stringify(input)));
      if (input.scenario === 'list_scenarios') {
        return reply({ status: 'completed', success: true, scenarios: ['force_account_status'] });
      }
      if (input.scenario !== 'force_account_status') {
        return reply({ status: 'completed', success: false, error: 'UNKNOWN_SCENARIO' });
      }
      const target = store.get(input.params?.account_id);
      const scope = lookup(input.account);
      if (!target) {
        // Static message: an error string is wire-visible, so it must not reflect caller input.
        // Static reason only: this fixture gets copied into adopter code, and an error envelope
        // is the wrong place to echo caller-supplied input back onto the wire. The full request
        // and the store lookup are already captured locally for assertions.
        return reply({ status: 'completed', success: false, error: 'NOT_FOUND', message: 'Unknown target account' });
      }
      if (!scope || scope.account_id !== target.account_id) {
        // The hybrid reference lands here: a scope that owns nothing, or that
        // owns a different account than the one being transitioned.
        return reply({
          status: 'completed',
          success: false,
          error: 'NOT_FOUND',
          message: 'Account scope does not own the target account',
        });
      }
      const previous = target.status;
      target.status = input.params.status;
      return reply({
        status: 'completed',
        success: true,
        previous_state: previous,
        current_state: target.status,
      });
    }
  );

  return { server, store, wire, lookup, controller, violations };
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
          // Unknown-reference negative — NOT a credential-isolation proof. `competitor.example` is
          // simply unprovisioned on this seller; proving cross-tenant isolation would need a
          // second persisted owner outside the authenticated view, which this fixture's auth model
          // does not express. Before the fix the probe was un-writable at all: the runner rewrote
          // the authored brand to the run brand, so the step could never reach the seller with the
          // reference it names. Under `strictAccountReferences: true` the framework treats
          // `list_accounts.account` as a filter and never calls `resolveAccount` on it, so no
          // ACCOUNT_NOT_FOUND is raised ahead of the handler; the seller's own refusal is to match
          // nothing, which is 3.1.31's "exact account filter … returns only matching accounts
          // visible to the authenticated caller".
          id: 'unprovisioned_account_filter_matches_nothing',
          title: 'An unprovisioned account reference selects nothing',
          task: 'list_accounts',
          sample_request: {
            account: { brand: { domain: 'competitor.example' }, operator: 'competitor.example', sandbox: true },
            sandbox: true,
          },
          validations: [{ check: 'field_value', path: 'pagination.total_count', allowed_values: [0], description: '' }],
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
          // Causal refusal branch, exercised in the normal suite rather than only in the
          // fix-removed run: the scope names an unprovisioned account while `params` names the
          // real one. A strict account-aware controller must refuse rather than fall back to the
          // target's own owner.
          id: 'controller_scope_must_own_target',
          title: 'A controller scope that owns nothing cannot drive another account',
          task: 'comply_test_controller',
          expect_error: true,
          sample_request: {
            account: { sandbox: true, brand: { domain: 'competitor.example' }, operator: 'competitor.example' },
            scenario: 'force_account_status',
            params: { account_id: '$context.account_id', status: 'suspended' },
          },
          validations: [
            { check: 'field_value', path: 'success', allowed_values: [false], description: '' },
            { check: 'field_value', path: 'error', allowed_values: ['NOT_FOUND'], description: '' },
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

    const { server, store, wire, violations } = createStrictAccountSeller();
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

    assert.deepEqual(violations, [], 'every controller dispatch must satisfy the selected release');
    assert.equal(result.overall_passed, true, JSON.stringify(result, null, 2));
    assert.equal(result.failed_count, 0, JSON.stringify(result, null, 2));

    const listCall = wire.find(c => c.tool === 'list_accounts');
    assert.ok(listCall, 'list_accounts never reached the seller');
    assert.deepEqual(
      listCall.params.account,
      { brand: TEST_BRAND, operator: 'test.example', sandbox: true },
      'the exact provisioned natural key must reach the wire, not a run-brand hybrid'
    );

    const dispatches = wire.filter(c => c.tool === 'comply_test_controller');
    assert.equal(dispatches.length, 3, 'suspend, reactivate and the unowned-scope refusal');
    for (const call of dispatches) {
      // The published controller request declares `account`, not a top-level `brand`. Now that
      // the schema ships, `schemaAllowsTopLevelField` gates on it and the run-brand invariant
      // stops adding the undeclared field. The observer in `inputSchema` is what makes this
      // visible; without it Zod would strip the key and the assertion would pass vacuously.
      assert.equal(
        Object.hasOwn(call.params, 'brand'),
        false,
        `controller request carried an undeclared top-level brand: ${JSON.stringify(call.params.brand)}`
      );
    }
    const transitions = dispatches.filter(c => c.params.account.brand?.domain === 'test.example');
    assert.equal(transitions.length, 2);
    const refused = dispatches.find(c => c.params.account.brand?.domain === 'competitor.example');
    assert.ok(refused, 'the unowned controller scope never reached the seller as authored');
    assert.equal(refused.params.params.status, 'suspended');
    const stillActive = [...store.values()].find(row => row.brand?.domain === 'test.example');
    assert.equal(stillActive.status, 'active', 'a refused transition must not move the target account');
    for (const call of transitions) {
      assert.deepEqual(
        { brand: call.params.account.brand, operator: call.params.account.operator },
        { brand: TEST_BRAND, operator: 'test.example' },
        'the controller scope must be the account whose state machine it drives'
      );
    }

    const listCalls = wire.filter(c => c.tool === 'list_accounts');
    assert.equal(listCalls.length, 2, 'the exact read and the unprovisioned-reference negative');
    assert.deepEqual(listCalls[1].params.account, {
      brand: { domain: 'competitor.example' },
      operator: 'competitor.example',
      sandbox: true,
    });

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
