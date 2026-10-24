/**
 * Prepared fixture state: binding coherence, every-lookup authority, and
 * full/standalone reuse.
 *
 * This boundary is deliberately tested on its own, separately from the
 * protected-namespace funnel. Namespace immutability stops a value being
 * overwritten; it says nothing about whether the caller was allowed to read
 * the pinned graph at all. Neither substitutes for the other, so neither is
 * allowed to make the other's assertions pass.
 *
 * What is NOT claimed here: the SDK does not implement a grant service. It
 * mandates an authorizer hook, refuses opaque references without one, and
 * re-asks on every lookup. Resolving principals from sessions and storing
 * revocations stay host duties.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  isTrustedPreparedFixtures,
  PREPARED_FIXTURES_CONTRACT_VERSION,
  PreparedFixturesDeniedError,
  PreparedStoryboardFixtures,
  prepareStoryboardFixtures,
  runStoryboard,
  runStoryboardStep,
  withPreparedFixtures,
} = require('../../dist/lib/testing/index.js');

const CAPS = {
  status: 'completed',
  adcp: { major_versions: [3], supported_versions: ['3.2'], idempotency: { supported: false } },
  supported_protocols: ['media_buy'],
  media_buy: { buying_modes: ['brief', 'wholesale'] },
};
const TOOLS = ['get_adcp_capabilities', 'get_products', 'create_media_buy'];
const ENDPOINT = 'https://prepared-fixtures-test.example/mcp';
const OTHER_ENDPOINT = 'https://prepared-fixtures-other.example/mcp';

function product(id, extra = {}) {
  return {
    product_id: id,
    name: 'Catalog offer',
    description: 'Prepared-state probe offer.',
    publisher_properties: [{ publisher_domain: 'publisher.example', selection_type: 'all' }],
    channels: ['ctv'],
    delivery_type: 'non_guaranteed',
    format_options: [{ format_option_id: 'video', format_kind: 'video_hosted', params: { duration_ms_exact: 30000 } }],
    pricing_options: [
      {
        pricing_option_id: 'seller-price',
        pricing_model: 'cpm',
        currency: 'EUR',
        fixed_price: 24,
        min_spend_per_package: 5000,
      },
    ],
    collections: [{ publisher_domain: 'owner.example', collection_ids: ['news', 'music'] }],
    reporting_capabilities: {
      available_reporting_frequencies: ['daily'],
      expected_delay_minutes: 0,
      timezone: 'UTC',
      supports_webhooks: false,
      available_metrics: ['impressions', 'spend'],
      date_range_support: 'date_range',
    },
    ...extra,
  };
}

function transport(catalog, overrides = {}) {
  // `overrides.transportFailure` makes the fetch itself reject, so a test
  // can exercise the transport arm without a response ever existing.
  if (overrides.transportFailure) {
    const wire = [];
    const calls = [];
    return {
      calls,
      wire,
      options: {
        adcpVersion: '3.2.5',
        timeout_ms: 5000,
        profile: { tools: TOOLS, raw_capabilities: CAPS, supported_protocols: ['media_buy'] },
        transport: {
          trustedFetchFn: async (_input, init = {}) => {
            const message = JSON.parse(init.body);
            wire.push(message.method);
            if (message.method === 'tools/call' && message.params?.name === 'get_products') {
              throw new Error('synthetic transport failure: connection reset');
            }
            return originalTransport(catalog).options.transport.trustedFetchFn(_input, init);
          },
        },
      },
    };
  }
  return originalTransport(catalog, overrides);
}

function originalTransport(catalog, overrides = {}) {
  const calls = [];
  // Every seller endpoint interaction, including official-client
  // initialization and tool discovery — not just the mutating calls. A gate
  // that merely precedes `create_media_buy` is not a gate that precedes
  // seller contact.
  const wire = [];
  const trustedFetchFn = async (_input, init = {}) => {
    // Match network scheduling so Response buffers can be reclaimed between calls.
    await new Promise(resolve => setImmediate(resolve));
    const message = JSON.parse(init.body);
    wire.push(message.method);
    let result;
    if (message.method === 'initialize') {
      result = {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'prepared-fixtures-test', version: '1' },
      };
    } else if (message.method.startsWith('notifications/')) {
      return new Response(null, { status: 202 });
    } else if (message.method === 'tools/list') {
      result = {
        tools: TOOLS.map(name => ({
          name,
          description: name,
          inputSchema: { type: 'object', additionalProperties: true },
        })),
      };
    } else if (message.method === 'tools/call') {
      const { name, arguments: request } = message.params;
      calls.push({ task: name, request });
      if (name === 'get_products' && overrides.protocolFailure) {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    overrides.protocolPayload ?? {
                      status: 'failed',
                      adcp_error: {
                        code: 'INVALID_REQUEST',
                        message: 'Seller refused discovery',
                        recovery: 'terminal',
                      },
                    }
                  ),
                },
              ],
            },
          }),
          { headers: { 'content-type': 'application/json' } }
        );
      }
      let data;
      if (name === 'get_adcp_capabilities') data = overrides.capabilities?.() ?? CAPS;
      else if (name === 'get_products')
        data = overrides.read?.(request) ?? {
          status: 'completed',
          products: catalog,
          cache_scope: 'account',
          wholesale_feed_version: 'v1',
        };
      else if (name === 'comply_test_controller' && overrides.controller) data = overrides.controller(request);
      else if (name === 'create_media_buy')
        data = {
          status: 'completed',
          media_buy_id: 'seller-buy',
          revision: 1,
          confirmed_at: '2026-10-19T00:00:00Z',
          packages: [],
        };
      else throw new Error(`Unexpected tool ${name}`);
      result = { content: [{ type: 'text', text: JSON.stringify(data) }] };
    } else {
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }),
        { headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  return {
    calls,
    wire,
    options: {
      adcpVersion: '3.2.5',
      timeout_ms: 5000,
      profile: { tools: TOOLS, raw_capabilities: CAPS, supported_protocols: ['media_buy'] },
      transport: { trustedFetchFn },
    },
  };
}

function board({ steps } = {}) {
  return {
    id: 'prepared_fixtures/selection',
    version: '1.0.0',
    category: 'media_buy_seller',
    title: 'Prepared fixture reuse',
    summary: 'Full and standalone consumers share one preparation.',
    narrative: 'Exercises the public preparation contract.',
    agent: { interaction_model: 'media_buy_seller', capabilities: ['sells_media'] },
    caller: { role: 'buyer_agent' },
    fixtures: {
      products: [product('authored-product', { collection_targeting_allowed: true })],
      pricing_options: [{ product_id: 'authored-product', pricing_option_id: 'authored-price', pricing_model: 'cpm' }],
    },
    fixture_resolution: {
      products: [
        {
          handle: 'authored-product',
          strategies: ['discover'],
          match: [
            {
              path: '',
              operator: 'collection_selection_satisfies',
              value: { collection_targeting: 'selectable', minimum_pairs: 2 },
            },
          ],
          context_outputs: [
            { key: '__adcp_fixture_product_id', path: 'product_id' },
            { key: '__adcp_fixture_subset', witness: 'strict_subset' },
          ],
        },
      ],
      pricing_options: [
        {
          handle: 'authored-price',
          product_handle: 'authored-product',
          strategies: ['discover'],
          match: [{ path: '/pricing_model', operator: 'equals', value: 'cpm' }],
          context_outputs: [
            { key: '__adcp_fixture_currency', path: 'currency' },
            { key: '__adcp_fixture_min_spend', path: 'min_spend_per_package' },
          ],
        },
      ],
    },
    phases: [
      {
        id: 'exercise',
        title: 'Exercise',
        steps: steps ?? [
          {
            id: 'create',
            title: 'Buy the pinned offer',
            task: 'create_media_buy',
            stateful: true,
            sample_request: {
              brand: { domain: 'acmeoutdoor.example' },
              start_time: 'asap',
              end_time: '2099-06-30T23:59:59Z',
              currency: '$context.__adcp_fixture_currency',
              packages: [
                {
                  product_id: '$context.__adcp_fixture_product_id',
                  pricing_option_id: 'authored-price',
                  budget: '$context.__adcp_fixture_min_spend',
                  targeting_overlay: {
                    collection_selection: { mode: 'selected', collections: '$context.__adcp_fixture_subset' },
                  },
                },
              ],
            },
            validations: [{ check: 'field_present', path: 'media_buy_id', description: 'The buy succeeds' }],
          },
        ],
      },
    ],
  };
}

const SELECTED = product('a-selected', { collection_targeting_allowed: true });

/** Reuse requires an authorizer; cases not testing refusal use this one. */
const ALLOW = () => ({ authorized: true });

// Synthetic userinfo, assembled rather than written as a literal URL
// with embedded credentials. Secret scanners match that shape on sight,
// and these fixtures carry nothing real — the point of
// the tests below is that two routes differing ONLY in userinfo must not
// collapse into one binding, and that a host's own error text never
// reaches the refused caller.
const SYNTHETIC_USERINFO = { A: 'SYNTHETIC-ROUTE-A', B: 'SYNTHETIC-ROUTE-B', C: 'SYNTHETIC-HOST-DSN' };
const synthetic = (scheme, user, slot) => `${scheme}://${user}:${SYNTHETIC_USERINFO[slot]}`;
const routeWithUserinfo = (user, slot) => `${synthetic('https', user, slot)}@seller.example/mcp`;

/**
 * Invoke an entry point that may be REFUSED, and capture both outcomes.
 *
 * Under the Option 1 contract a refused caller gets a typed denial and no
 * result at all; the complete, unredacted record goes to the host's
 * authorized audit sink. So `record` is the real result when the call is
 * authorized and the AUDIT copy when it is denied — which is what almost
 * every assertion here wants to look at either way.
 */
async function runWithAudit(invoke) {
  let captured;
  const sink = record => {
    captured = record;
  };
  try {
    return { denial: undefined, record: await invoke(sink) };
  } catch (error) {
    if (!(error instanceof PreparedFixturesDeniedError)) throw error;
    return { denial: error, record: captured };
  }
}

async function prepare(extra = {}) {
  const io = transport([SELECTED]);
  const state = await prepareStoryboardFixtures(ENDPOINT, board(), { ...io.options, ...extra });
  return { io, state, options: io.options };
}

// ────────────────────────────────────────────────────────────
// Preparation contract
// ────────────────────────────────────────────────────────────

describe('prepareStoryboardFixtures', () => {
  test('resolves the graph once and exposes pinned identities and captures', async () => {
    const { io, state } = await prepare();
    assert.equal(state.disposition.status, 'resolved');
    assert.deepEqual(
      state.selections.map(selection => [selection.handle, selection.seller_ids.product_id]),
      [
        ['authored-product', 'a-selected'],
        ['authored-price', 'a-selected'],
      ]
    );
    assert.equal(state.captures.__adcp_fixture_product_id, 'a-selected');
    assert.equal(state.captures.__adcp_fixture_currency, 'EUR');
    assert.equal(state.captures.__adcp_fixture_min_spend, 5000);
    assert.equal(io.calls.filter(call => call.task === 'get_products').length, 1);
    assert.equal(
      io.calls.some(call => call.task === 'create_media_buy'),
      false,
      'preparation performs no mutation'
    );
  });

  test('the binding records artifact identity, scope and run, and never a credential', async () => {
    const { state } = await prepare({
      prepared_fixtures_principal: 'tenant-a/runner',
      auth: { type: 'bearer', token: 'super-secret-token' },
      prepared_fixtures_run_id: 'run-1',
    });
    const binding = state.binding;
    assert.equal(binding.storyboard_id, 'prepared_fixtures/selection');
    assert.match(binding.storyboard_digest, /^[0-9a-f]{64}$/);
    assert.deepEqual(binding.agent_urls, [ENDPOINT]);
    assert.equal(binding.contract_version, PREPARED_FIXTURES_CONTRACT_VERSION);
    assert.equal(binding.schema_artifact.adcp_version, '3.2.5');
    assert.match(binding.schema_artifact.digest, /^[0-9a-f]{64}$/);
    assert.equal(binding.principal, 'tenant-a/runner');
    assert.equal(binding.run_id, 'run-1');
    assert.match(binding.credential_fingerprint, /^[0-9a-f]{32}$/);
    const serialized = JSON.stringify(binding);
    assert.equal(serialized.includes('super-secret-token'), false, 'no credential may appear in binding evidence');
  });

  test('the credential fingerprint is per-process and changes with the credential', async () => {
    const a = await prepare({ auth: { type: 'bearer', token: 'token-a' } });
    const b = await prepare({ auth: { type: 'bearer', token: 'token-b' } });
    const again = await prepare({ auth: { type: 'bearer', token: 'token-a' } });
    assert.notEqual(a.state.binding.credential_fingerprint, b.state.binding.credential_fingerprint);
    assert.equal(a.state.binding.credential_fingerprint, again.state.binding.credential_fingerprint);
  });

  test('every credential dimension is fingerprinted, not just Authorization', async () => {
    // The SDK documents `headers` with `x-api-key` / `x-org-id` as the
    // canonical tenant-scoping example. Cherry-picking `Authorization` would
    // give two tenants identical bindings that compare equal.
    const a = await prepare({ headers: { 'x-api-key': 'key-a', 'x-org-id': 'org-a' } });
    const b = await prepare({ headers: { 'x-api-key': 'key-b', 'x-org-id': 'org-b' } });
    assert.notEqual(a.state.binding.credential_fingerprint, b.state.binding.credential_fingerprint);

    // Absence is an explicit sentinel, never an omitted field: "prepared with
    // no credential" must not compare equal to "prepared with one".
    const none = await prepare();
    assert.match(none.state.binding.credential_fingerprint, /^[0-9a-f]{32}$/);
    assert.notEqual(none.state.binding.credential_fingerprint, a.state.binding.credential_fingerprint);
  });

  test('a header-scoped tenant cannot consume another header-scoped tenant\u2019s state', async () => {
    const tenantA = await prepare({ headers: { 'x-org-id': 'org-a' } });
    const io = transport([SELECTED]);
    const { denial, record: result } = await runWithAudit(sink =>
      runStoryboardStep(ENDPOINT, board(), 'create', {
        ...io.options,
        headers: { 'x-org-id': 'org-b' },
        prepared_fixtures: tenantA.state,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: ALLOW,
      })
    );
    assert.equal(result.passed, false, JSON.stringify(result));
    assert.match(result.error, /credential_fingerprint/);
    assert.equal(
      io.calls.some(call => call.task === 'create_media_buy'),
      false
    );
  });

  test('accessors hand back detached copies, not the pinned state', async () => {
    const { state } = await prepare();
    const first = state.resolutions;
    first[0].handle = 'mutated';
    assert.equal(state.resolutions[0].handle, 'authored-product');
    const binding = state.binding;
    binding.storyboard_id = 'mutated';
    assert.equal(state.binding.storyboard_id, 'prepared_fixtures/selection');
  });

  test('an unsatisfied graph is returned with its terminal disposition, not thrown', async () => {
    const io = transport([product('fixed-only')]);
    const state = await prepareStoryboardFixtures(ENDPOINT, board(), io.options);
    assert.equal(state.disposition.status, 'unsatisfied');
    assert.deepEqual(state.captures, {}, 'an unresolved graph publishes no captures');
  });

  test('a schema-invalid catalog is a terminal failure, not an applicability gap', async () => {
    const io = transport([{ product_id: 'broken' }]);
    const state = await prepareStoryboardFixtures(ENDPOINT, board(), io.options);
    assert.equal(state.disposition.status, 'failed');
    assert.deepEqual(state.captures, {});
  });
});

// ────────────────────────────────────────────────────────────
// Reuse: full and standalone
// ────────────────────────────────────────────────────────────

describe('prepared-state reuse', () => {
  test('the standalone runner executes against the pinned graph instead of literal handles', async () => {
    const { state, options } = await prepare();
    const io = transport([SELECTED]);
    const { denial, record: result } = await runWithAudit(sink =>
      runStoryboardStep(ENDPOINT, board(), 'create', {
        ...io.options,
        prepared_fixtures: state,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: ALLOW,
      })
    );
    assert.equal(result.passed, true, JSON.stringify(result));
    assert.equal(
      io.calls.some(call => call.task === 'get_products'),
      false,
      'reuse performs no rediscovery'
    );
    const request = io.calls.find(call => call.task === 'create_media_buy').request;
    assert.equal(request.packages[0].product_id, 'a-selected');
    assert.equal(request.packages[0].pricing_option_id, 'seller-price');
    assert.equal(request.currency, 'EUR');
    assert.equal(request.packages[0].budget, 5000);
    assert.deepEqual(request.packages[0].targeting_overlay.collection_selection.collections, [
      { publisher_domain: 'owner.example', collection_ids: ['music'] },
    ]);
  });

  test('the full runner reuses the same prepared state without re-resolving', async () => {
    const { state } = await prepare();
    const io = transport([SELECTED]);
    const { denial, record: result } = await runWithAudit(sink =>
      runStoryboard(ENDPOINT, board(), {
        ...io.options,
        prepared_fixtures: state,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: ALLOW,
      })
    );
    assert.equal(result.overall_passed, true, JSON.stringify(result));
    assert.equal(
      io.calls.some(call => call.task === 'get_products'),
      false
    );
    assert.equal(io.calls.find(call => call.task === 'create_media_buy').request.packages[0].product_id, 'a-selected');
  });

  test('full and standalone produce the same pinned request from one preparation', async () => {
    const { state } = await prepare();
    const fullIo = transport([SELECTED]);
    const { denial, record: _ignored1 } = await runWithAudit(sink =>
      runStoryboard(ENDPOINT, board(), {
        ...fullIo.options,
        prepared_fixtures: state,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: ALLOW,
      })
    );
    const stepIo = transport([SELECTED]);
    const { denial: denial2, record: _ignored2 } = await runWithAudit(sink =>
      runStoryboardStep(ENDPOINT, board(), 'create', {
        ...stepIo.options,
        prepared_fixtures: state,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: ALLOW,
      })
    );
    assert.deepEqual(
      fullIo.calls.find(call => call.task === 'create_media_buy').request.packages[0],
      stepIo.calls.find(call => call.task === 'create_media_buy').request.packages[0]
    );
  });

  test('a terminal preparation outcome is carried forward, not re-discovered', async () => {
    const emptyIo = transport([product('fixed-only')]);
    const state = await prepareStoryboardFixtures(ENDPOINT, board(), emptyIo.options);
    assert.equal(state.disposition.status, 'unsatisfied');
    // The retry transport WOULD now satisfy the graph. Reuse must not launder
    // the earlier failure into a fresh selection.
    const retryIo = transport([SELECTED]);
    const { denial, record: result } = await runWithAudit(sink =>
      runStoryboardStep(ENDPOINT, board(), 'create', {
        ...retryIo.options,
        prepared_fixtures: state,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: ALLOW,
      })
    );
    assert.equal(result.skipped, true);
    assert.equal(result.skip_reason, 'fixture_unsatisfied');
    assert.equal(
      retryIo.calls.some(call => call.task === 'create_media_buy'),
      false
    );
    assert.equal(
      retryIo.calls.some(call => call.task === 'get_products'),
      false
    );
  });
});

// ────────────────────────────────────────────────────────────
// Binding coherence
// ────────────────────────────────────────────────────────────

describe('binding coherence', () => {
  async function expectRefusal(options, pattern) {
    const io = transport([SELECTED]);
    const { denial: denial2, record: result } = await runWithAudit(sink =>
      runStoryboardStep(ENDPOINT, board(), 'create', {
        ...io.options,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: ALLOW,
        ...options,
      })
    );
    assert.equal(result.passed, false, JSON.stringify(result));
    assert.match(result.error, pattern);
    assert.equal(
      io.calls.some(call => call.task === 'create_media_buy'),
      false,
      'no wire call before the gate passes'
    );
    return result;
  }

  test('a different route refuses the prepared state', async () => {
    const { state } = await prepare();
    const io = transport([SELECTED]);
    const { denial, record: result } = await runWithAudit(sink =>
      runStoryboardStep(OTHER_ENDPOINT, board(), 'create', {
        ...io.options,
        prepared_fixtures: state,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: ALLOW,
      })
    );
    assert.equal(result.passed, false);
    assert.match(result.error, /agent_urls/);
  });

  test('a different account scope refuses the prepared state', async () => {
    const { state } = await prepare();
    await expectRefusal({ prepared_fixtures: state, brand: { domain: 'other-brand.example' } }, /account_scope/);
  });

  test('a different sandbox flag refuses the prepared state', async () => {
    const { state } = await prepare();
    await expectRefusal({ prepared_fixtures: state, disable_sandbox: true }, /sandbox/);
  });

  test('a different credential refuses the prepared state', async () => {
    const { state } = await prepare({ auth: { type: 'bearer', token: 'token-a' } });
    await expectRefusal(
      { prepared_fixtures: state, auth: { type: 'bearer', token: 'token-b' } },
      /credential_fingerprint/
    );
  });

  test('a different principal refuses the prepared state', async () => {
    const { state } = await prepare({ prepared_fixtures_principal: 'tenant-a' });
    await expectRefusal({ prepared_fixtures: state, prepared_fixtures_principal: 'tenant-b' }, /principal/);
  });

  test('a same-brand run with a different operator or unit refuses the prepared state', async () => {
    // `resolveAccount` derives `operator` from `brand.domain`, so a
    // brand-derived proxy would conflate these. The binding reads the same
    // account the discovery call uses, including operator and unit.
    const base = {
      brand: { domain: 'acmeoutdoor.example' },
      operator: 'pinnacle-agency.example',
      unit: 'scenario-a',
      sandbox: true,
    };
    const prepared = await prepare({ context: { account: base } });
    for (const changed of [
      { ...base, operator: 'other-agency.example' },
      { ...base, unit: 'scenario-b' },
      { ...base, account_id: 'acct-123' },
    ]) {
      const io = transport([SELECTED]);
      const { denial, record: result } = await runWithAudit(sink =>
        runStoryboardStep(ENDPOINT, board(), 'create', {
          ...io.options,
          context: { account: changed },
          prepared_fixtures: prepared.state,
          prepared_fixtures_audit_sink: sink,
          prepared_fixtures_authorizer: ALLOW,
        })
      );
      assert.equal(result.passed, false, JSON.stringify(changed));
      assert.match(result.error, /account_scope/);
      assert.equal(
        io.calls.some(call => call.task === 'create_media_buy'),
        false
      );
    }
  });

  test('a per-step auth directive changes the effective credential the authorizer sees', async () => {
    // `step.auth` is applied inside step execution, so a binding built from
    // run options alone would tell the authorizer nothing changed while the
    // step actually dispatches unauthenticated or with a deliberately
    // invalid key.
    const { state } = await prepare({ auth: { type: 'bearer', token: 'run-token' } });
    const seen = [];
    for (const directive of ['none', { type: 'api_key', value: 'probe-key' }]) {
      const probe = board();
      probe.phases[0].steps[0].auth = directive;
      const io = transport([SELECTED]);
      const { denial, record: result } = await runWithAudit(sink =>
        runStoryboardStep(ENDPOINT, probe, 'create', {
          ...io.options,
          auth: { type: 'bearer', token: 'run-token' },
          prepared_fixtures: state,
          prepared_fixtures_audit_sink: sink,
          prepared_fixtures_authorizer: lookup => {
            seen.push(lookup.current);
            return { authorized: true };
          },
        })
      );
      // The storyboard digest changes with the directive, so reuse refuses;
      // what matters is that the authorizer saw the step's EFFECTIVE
      // credential before any wire call.
      assert.equal(result.passed, false);
      assert.deepEqual(io.wire, []);
    }
    assert.equal(seen.length, 2);
    const stepPrints = seen.map(binding => binding.step_credential_fingerprint);
    for (const print of stepPrints) assert.match(print, /^[0-9a-f]{32}$/);
    assert.notEqual(stepPrints[0], stepPrints[1], 'auth: none and an api_key probe differ');
    // The run credential is unchanged by the directive, which is why the
    // step fingerprint is a separate field rather than folded into it.
    assert.equal(seen[0].credential_fingerprint, seen[1].credential_fingerprint);
    assert.equal(seen[0].credential_fingerprint, state.binding.credential_fingerprint);
    for (const print of stepPrints) assert.notEqual(print, state.binding.credential_fingerprint);
    // Nonsecret: the probe credential never reaches the authorizer payload.
    assert.equal(JSON.stringify(seen).includes('probe-key'), false);
  });

  test('a step with no auth directive exposes no step credential fingerprint', async () => {
    const { state } = await prepare();
    const seen = [];
    const io = transport([SELECTED]);
    const { denial, record: result } = await runWithAudit(sink =>
      runStoryboardStep(ENDPOINT, board(), 'create', {
        ...io.options,
        prepared_fixtures: state,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: lookup => {
          seen.push(lookup.current);
          return { authorized: true };
        },
      })
    );
    assert.equal(result.passed, true, JSON.stringify(result));
    assert.equal(seen[0].step_credential_fingerprint, undefined);
  });

  test('identical directive text with a different RESOLVED credential refuses reuse', async () => {
    // `auth: { type: 'api_key', from_test_kit: true }` is byte-identical in
    // both runs; the credential it resolves to is not. Binding only the
    // directive's syntax would let a rotated or swapped kit key reuse state
    // prepared under the old one.
    const kitA = { auth: { api_key: 'kit-key-a', probe_task: 'list_creatives' } };
    const kitB = { auth: { api_key: 'kit-key-b', probe_task: 'list_creatives' } };
    const probe = board();
    probe.phases[0].steps[0].auth = { type: 'api_key', from_test_kit: true };

    const preparedIo = transport([SELECTED]);
    const state = await prepareStoryboardFixtures(ENDPOINT, probe, { ...preparedIo.options, test_kit: kitA });
    assert.equal(state.disposition.status, 'resolved');

    const same = transport([SELECTED]);
    const { denial, record: ok } = await runWithAudit(sink =>
      runStoryboardStep(ENDPOINT, probe, 'create', {
        ...same.options,
        test_kit: kitA,
        prepared_fixtures: state,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: ALLOW,
      })
    );
    assert.equal(ok.passed, true, JSON.stringify(ok));

    const rotated = transport([SELECTED]);
    const { denial: denial2, record: denied } = await runWithAudit(sink =>
      runStoryboardStep(ENDPOINT, probe, 'create', {
        ...rotated.options,
        test_kit: kitB,
        prepared_fixtures: state,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: ALLOW,
      })
    );
    assert.equal(denied.passed, false, JSON.stringify(denied));
    assert.match(denied.error, /credential_fingerprint/);
    assert.deepEqual(rotated.wire, [], 'the mismatch is caught before any seller contact');
    // The kit key itself never appears in operator-visible text.
    assert.equal(JSON.stringify(denied).includes('kit-key-'), false);
  });

  test('a routed per-agent credential change refuses reuse', async () => {
    const agents = token => ({
      seller: { url: ENDPOINT, auth: { type: 'bearer', token } },
    });
    const preparedIo = transport([SELECTED]);
    const state = await prepareStoryboardFixtures('', board(), {
      ...preparedIo.options,
      agents: agents('route-token-a'),
    });
    const io = transport([SELECTED]);
    const { denial, record: result } = await runWithAudit(sink =>
      runStoryboard('', board(), {
        ...io.options,
        agents: agents('route-token-b'),
        prepared_fixtures: state,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: ALLOW,
      })
    );
    assert.equal(result.overall_passed, false, JSON.stringify(result));
    assert.deepEqual(io.wire, []);
    assert.equal(JSON.stringify(result).includes('route-token-'), false);
  });

  test('an authorization refusal carries the required_on_failure schema identity', async () => {
    // Required on EVERY failing validation, null outside response_schema.
    // The synthesized authority and protection kinds were omitting both.
    const { state } = await prepare();
    const io = transport([SELECTED]);
    const { denial, record: result } = await runWithAudit(sink =>
      runStoryboardStep(ENDPOINT, board(), 'create', {
        ...io.options,
        prepared_fixtures: state,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: () => ({ authorized: false, detail: 'denied' }),
      })
    );
    assert.equal(result.passed, false);
    const refusal = result.validations.find(v => v.check === 'prepared_fixtures_authorization');
    assert.ok(refusal, JSON.stringify(result.validations));
    assert.ok(Object.hasOwn(refusal, 'schema_id'));
    assert.ok(Object.hasOwn(refusal, 'schema_url'));
    assert.equal(refusal.schema_id, null);
    assert.equal(refusal.schema_url, null);
    // One description across all three gates: three spellings of one
    // check read to a report renderer as three kinds.
    assert.equal(refusal.description, 'Prepared fixture state is re-validated and re-authorized on every lookup');
  });

  test('the standalone entry gate identifies itself as a step lookup', async () => {
    // A host implementing the documented taxonomy gives a `step` lookup
    // the fine-grained check and a `pass` lookup the coarse one. The
    // standalone route fell through to the `'pass'` default, so the
    // hosted step entry point — the one this feature exists for — was
    // getting the WEAKER check.
    const { state } = await prepare();
    const io = transport([SELECTED]);
    const seen = [];
    const { denial, record: _ignored3 } = await runWithAudit(sink =>
      runStoryboardStep(ENDPOINT, board(), 'create', {
        ...io.options,
        prepared_fixtures: state,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: lookup => {
          seen.push({ gate: lookup.gate, step_id: lookup.step_id });
          return { authorized: true };
        },
      })
    );
    assert.deepEqual(seen, [{ gate: 'step', step_id: 'create' }]);
  });

  test('a step credential cannot be disguised by a delimiter inside its own value', async () => {
    // `key=value` joined on `;` collided: two different directives
    // rendered one string, so one fingerprint stood for both.
    const fingerprintFor = async auth => {
      const { state } = await prepare();
      const doc = board();
      doc.phases[0].steps[0].auth = auth;
      const io = transport([SELECTED]);
      let seen;
      const { denial, record: _ignored4 } = await runWithAudit(sink =>
        runStoryboardStep(ENDPOINT, doc, 'create', {
          ...io.options,
          prepared_fixtures: state,
          prepared_fixtures_audit_sink: sink,
          prepared_fixtures_authorizer: lookup => {
            seen = lookup.current.step_credential_fingerprint;
            return { authorized: true };
          },
        })
      );
      return seen;
    };
    const left = await fingerprintFor({ type: 'basic', password: 'a;username=b', username: 'c' });
    const right = await fingerprintFor({ type: 'basic', password: 'a', username: 'b;username=c' });
    assert.ok(left, 'the fingerprint is reported');
    assert.notEqual(left, right, 'two different step credentials must not share one fingerprint');
  });

  test('two routes differing only in a credential-bearing url are not one binding', async () => {
    // `fixture_agent_url` is REDACTED for the authorizer to read, so two
    // urls differing only in userinfo render identically there. The raw
    // positional route is folded into `agent_route_fingerprint` so the
    // diff still separates them.
    const prepIo = transport([SELECTED]);
    const state = await prepareStoryboardFixtures('', board(), {
      ...prepIo.options,
      agents: { seller: { url: routeWithUserinfo('alice', 'A') } },
    });
    assert.equal(state.disposition.status, 'resolved', JSON.stringify(state.disposition));
    const io = transport([SELECTED]);
    const { denial, record: result } = await runWithAudit(sink =>
      runStoryboard('', board(), {
        ...io.options,
        agents: { seller: { url: routeWithUserinfo('bob', 'B') } },
        prepared_fixtures: state,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: ALLOW,
      })
    );
    assert.equal(result.overall_passed, false, JSON.stringify(result));
    assert.deepEqual(io.wire, []);
    for (const slot of ['A', 'B']) {
      assert.equal(
        JSON.stringify(result).includes(SYNTHETIC_USERINFO[slot]),
        false,
        'no credential in operator-visible text'
      );
    }
  });

  test('a state pinned against one route is refused by a run routed to another', async () => {
    // `agent_urls` is sorted and `agent_route_fingerprint` sorts by key,
    // both deliberately order-insensitive — so two runs whose `agents`
    // maps differ only in insertion order produced byte-identical
    // bindings, while preparation (which contacts exactly one agent) had
    // read a DIFFERENT seller's catalog for each. Reuse across them sent
    // one seller's pinned product_id to the other.
    const A = 'https://seller-a.example/mcp';
    const B = 'https://seller-b.example/mcp';
    const onlyA = product('a-only', { collection_targeting_allowed: true });
    const onlyB = product('b-only', { collection_targeting_allowed: true });
    const boardFor = () => board();
    const prepIo = transport([onlyA]);
    const state = await prepareStoryboardFixtures('', boardFor(), {
      ...prepIo.options,
      agents: { seller: { url: A }, other: { url: B } },
    });
    assert.equal(state.disposition.status, 'resolved', JSON.stringify(state.disposition));

    const io = transport([onlyB]);
    const { denial, record: result } = await runWithAudit(sink =>
      runStoryboard('', boardFor(), {
        ...io.options,
        // Same SET of routes, same credentials — only the order differs, so
        // preparation would have contacted B rather than A.
        agents: { other: { url: B }, seller: { url: A } },
        prepared_fixtures: state,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: ALLOW,
      })
    );
    assert.equal(result.overall_passed, false, JSON.stringify(result));
    // The refusal names the differing FIELD, never the urls themselves.
    assert.match(JSON.stringify(result), /fixture_agent_url/);
    assert.deepEqual(io.wire, [], 'refused before any seller contact');
    assert.equal(JSON.stringify(result).includes('b-only'), false, 'no pinned identity crosses routes');
  });

  test('the authorizer payload carries no secret material from any source', async () => {
    const { state } = await prepare({
      headers: { 'x-api-key': 'header-secret', authorization: 'Bearer header-bearer' },
      auth: { type: 'bearer', token: 'run-secret' },
      test_kit: { auth: { api_key: 'kit-secret', probe_task: 'list_creatives' } },
    });
    const seen = [];
    const io = transport([SELECTED]);
    const { denial, record: _ignored5 } = await runWithAudit(sink =>
      runStoryboardStep(ENDPOINT, board(), 'create', {
        ...io.options,
        headers: { 'x-api-key': 'header-secret', authorization: 'Bearer header-bearer' },
        auth: { type: 'bearer', token: 'run-secret' },
        test_kit: { auth: { api_key: 'kit-secret', probe_task: 'list_creatives' } },
        prepared_fixtures: state,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: lookup => {
          seen.push(lookup);
          return { authorized: true };
        },
      })
    );
    assert.ok(seen.length >= 1);
    const serialized = JSON.stringify(seen);
    for (const secret of ['header-secret', 'header-bearer', 'run-secret', 'kit-secret']) {
      assert.equal(serialized.includes(secret), false, secret);
    }
    assert.match(seen[0].current.credential_fingerprint, /^[0-9a-f]{32}$/);
  });

  test('ambiguous credential components cannot collide', async () => {
    // Colon-joining made basic `{username: 'a:b', password: 'c'}` and
    // `{username: 'a', password: 'b:c'}` the same string while transmitting
    // different credentials. Every component is JSON-encoded now.
    const a = await prepare({ auth: { type: 'basic', username: 'a:b', password: 'c' } });
    const b = await prepare({ auth: { type: 'basic', username: 'a', password: 'b:c' } });
    assert.notEqual(a.state.binding.credential_fingerprint, b.state.binding.credential_fingerprint);

    // Two users who authorized the SAME OAuth application are distinct
    // principals; keying on client_id alone collapsed them onto one binding.
    const client = { client_id: 'shared-app' };
    const userA = await prepare({
      auth: { type: 'oauth', client, tokens: { access_token: 'A-access', refresh_token: 'A-refresh' } },
    });
    const userB = await prepare({
      auth: { type: 'oauth', client, tokens: { access_token: 'B-access', refresh_token: 'B-refresh' } },
    });
    assert.notEqual(userA.state.binding.credential_fingerprint, userB.state.binding.credential_fingerprint);

    // The access token rotates by design, so a refresh alone must NOT break
    // legitimate reuse.
    const userARotated = await prepare({
      auth: { type: 'oauth', client, tokens: { access_token: 'A-access-2', refresh_token: 'A-refresh' } },
    });
    assert.equal(userA.state.binding.credential_fingerprint, userARotated.state.binding.credential_fingerprint);
  });

  test('a storyboard edited after preparation refuses reuse, even in place', async () => {
    // The digest is deliberately not memoized by object identity: a
    // Storyboard is a mutable plain object, and caching would preserve the
    // authorized digest past the edit it exists to detect.
    const sb = board();
    const io = transport([SELECTED]);
    const state = await prepareStoryboardFixtures(ENDPOINT, sb, io.options);
    assert.equal(state.disposition.status, 'resolved');
    sb.phases[0].steps[0].sample_request.packages[0].budget = 1;
    const after = transport([SELECTED]);
    const { denial, record: result } = await runWithAudit(sink =>
      runStoryboardStep(ENDPOINT, sb, 'create', {
        ...after.options,
        prepared_fixtures: state,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: ALLOW,
      })
    );
    assert.equal(result.passed, false, JSON.stringify(result));
    assert.match(result.error, /storyboard_digest/);
    assert.deepEqual(after.wire, []);
  });

  test('a routed run reuses prepared state prepared under the same routes', async () => {
    // The outer gate projects `options.agents` exactly as preparation does;
    // comparing real routes against a positional '' refused every routed
    // reuse.
    const agents = { seller: { url: ENDPOINT, auth: { type: 'bearer', token: 'route-token' } } };
    const prepIo = transport([SELECTED]);
    const state = await prepareStoryboardFixtures('', board(), { ...prepIo.options, agents });
    assert.equal(state.disposition.status, 'resolved', JSON.stringify(state.disposition));
    assert.deepEqual(state.binding.agent_urls, [ENDPOINT]);
    const io = transport([SELECTED]);
    const { denial, record: result } = await runWithAudit(sink =>
      runStoryboard('', board(), {
        ...io.options,
        agents,
        prepared_fixtures: state,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: ALLOW,
      })
    );
    assert.equal(result.overall_passed, true, JSON.stringify(result));
    assert.equal(io.calls.find(call => call.task === 'create_media_buy').request.packages[0].product_id, 'a-selected');
  });

  test('a capture over the byte budget is rejected in UTF-8, not UTF-16 units', async () => {
    // Driven through the PUBLIC runner, not a module-private helper. The
    // earlier version required `describeUncapturableValue` off the dist
    // module, which is not exported, so the guard returned before every
    // assertion and the UTF-8-vs-UTF-16 fix had zero coverage.
    //
    // 200,000 three-byte CJK characters are ~586 KiB in UTF-8 and only
    // 200,000 UTF-16 code units, so a `String.length` check passes this
    // and a `Buffer.byteLength` check refuses it.
    const cjk = product('a-selected', { collection_targeting_allowed: true, description: '\u4e2d'.repeat(200000) });
    assert.ok(JSON.stringify(cjk).length < 600 * 1024, 'string length alone stays under the budget');
    assert.ok(Buffer.byteLength(JSON.stringify(cjk), 'utf8') > 512 * 1024, 'UTF-8 bytes exceed it');

    const b = board();
    b.fixture_resolution.products[0].context_outputs = [
      { key: '__adcp_fixture_product_id', path: 'product_id' },
      { key: '__adcp_fixture_entity', snapshot: 'selected_entity' },
    ];
    delete b.fixture_resolution.pricing_options;
    delete b.fixtures.pricing_options;
    b.phases[0].steps[0].sample_request = {
      brand: { domain: 'acmeoutdoor.example' },
      start_time: 'asap',
      end_time: '2099-06-30T23:59:59Z',
      currency: 'EUR',
      packages: [{ product_id: '$context.__adcp_fixture_product_id', budget: 5000 }],
    };
    const io = transport([cjk]);
    const result = await runStoryboard(ENDPOINT, b, io.options);
    assert.equal(result.overall_passed, false);
    const unbuildable = result.phases
      .flatMap(phase => phase.steps)
      .find(step => step.validations.some(v => v.check === 'fixture_capture_unbuildable'));
    assert.ok(unbuildable, JSON.stringify(result.phases.map(p => p.steps.map(s => s.step_id))));
    assert.match(unbuildable.error, /capture limit/);
  });

  test('an unbuildable capture carries the discovery exchange the contract requires on failure', async () => {
    // runner-output-contract.yaml makes request, response, schema_id and
    // schema_url required_on_failure, with null reserved for PRE-WIRE
    // failures. A capture that cannot be built from a pinned entity is
    // post-wire — the entity came off the wire — so omitting the records
    // reads as "no exchange happened" for an exchange that did.
    const b = board();
    b.fixture_resolution.products[0].context_outputs = [{ key: '__adcp_fixture_missing', path: 'ext.missing' }];
    delete b.fixture_resolution.pricing_options;
    delete b.fixtures.pricing_options;
    const io = transport([SELECTED]);
    const result = await runStoryboard(ENDPOINT, b, io.options);
    assert.equal(result.overall_passed, false);
    const failure = result.phases
      .flatMap(phase => phase.steps)
      .flatMap(step => step.validations)
      .find(v => v.check === 'fixture_capture_unbuildable');
    assert.ok(failure, JSON.stringify(result));
    assert.equal(failure.json_pointer, '/ext/missing');
    assert.equal(failure.schema_id, null);
    assert.equal(failure.schema_url, null);
    // The records are the REAL exchange, not a placeholder: the request is
    // the discovery call the runner issued and the response carries the
    // product the capture was attempted against.
    assert.equal(failure.request.transport, 'mcp');
    assert.equal(failure.request.operation, 'get_products');
    assert.equal(failure.request.payload.buying_mode, 'wholesale');
    assert.equal(failure.response.transport, 'mcp');
    assert.ok(
      failure.response.payload.products.some(entry => entry.product_id === 'a-selected'),
      'the response records the page that actually carried the pinned product'
    );
  });

  test('an edited storyboard refuses the prepared state', async () => {
    const { state } = await prepare();
    const edited = board();
    edited.phases[0].steps[0].sample_request.packages[0].budget = 1;
    const io = transport([SELECTED]);
    const { denial, record: result } = await runWithAudit(sink =>
      runStoryboardStep(ENDPOINT, edited, 'create', {
        ...io.options,
        prepared_fixtures: state,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: ALLOW,
      })
    );
    assert.equal(result.passed, false);
    assert.match(result.error, /storyboard_digest/);
  });
});

// ────────────────────────────────────────────────────────────
// Authority: trust, references, revocation
// ────────────────────────────────────────────────────────────

describe('prepared-state authority', () => {
  test('a JSON-rehydrated or cloned state is not trusted state', async () => {
    const { state } = await prepare();
    assert.equal(isTrustedPreparedFixtures(state), true);
    const rehydrated = JSON.parse(
      JSON.stringify({ binding: state.binding, captures: state.captures, disposition: state.disposition })
    );
    assert.equal(isTrustedPreparedFixtures(rehydrated), false);
    const io = transport([SELECTED]);
    const { denial, record: result } = await runWithAudit(sink =>
      runStoryboardStep(ENDPOINT, board(), 'create', {
        ...io.options,
        prepared_fixtures: rehydrated,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: ALLOW,
      })
    );
    assert.equal(result.passed, false);
    assert.match(result.error, /not produced by prepareStoryboardFixtures in this process/);
    assert.equal(
      io.calls.some(call => call.task === 'create_media_buy'),
      false
    );
  });

  test('a hand-built look-alike with the right public shape is not trusted state', async () => {
    const { state } = await prepare();
    const binding = state.binding;
    const impostor = {
      binding,
      captures: state.captures,
      captureProvenance: {},
      disposition: { status: 'resolved' },
      resolutions: state.resolutions,
      selections: state.selections,
      witnesses: {},
      bindingRegistry: undefined,
    };
    assert.equal(isTrustedPreparedFixtures(impostor), false);
    const io = transport([SELECTED]);
    const { denial, record: result } = await runWithAudit(sink =>
      runStoryboardStep(ENDPOINT, board(), 'create', {
        ...io.options,
        prepared_fixtures: impostor,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: ALLOW,
      })
    );
    assert.equal(result.passed, false);
    assert.match(result.error, /carries no preparation authority/);
  });

  test('the class cannot be constructed directly, so the trust registry is unforgeable', async () => {
    const { state } = await prepare();
    // The binding is nonsecret and publicly readable. Before the module-private
    // construction token, copying it onto a direct `new` produced a fully
    // trusted state whose binding was byte-identical to the legitimate one —
    // invisible to a host authorizer.
    assert.throws(
      () =>
        new PreparedStoryboardFixtures({
          binding: state.binding,
          resolutions: [],
          coverageGaps: [],
          captures: { __adcp_fixture_product_id: 'attacker-product' },
          captureProvenance: {},
          witnesses: {},
          disposition: { status: 'resolved' },
        }),
      /cannot be constructed directly/
    );
    class Forged extends PreparedStoryboardFixtures {}
    assert.throws(() => new Forged({ binding: state.binding }), /cannot be constructed directly/);
    assert.equal(isTrustedPreparedFixtures(Object.create(PreparedStoryboardFixtures.prototype)), false);
  });

  test('DIRECT state without an authorizer fails closed, with zero seller calls', async () => {
    // Object identity proves origin, not a current grant, and binding
    // coherence cannot observe revocation. A warning in place of a refusal
    // would ship an unenforced authorization boundary described as
    // every-lookup enforcement.
    const { state } = await prepare();
    const io = transport([SELECTED]);
    const { denial, record } = await runWithAudit(sink =>
      runStoryboardStep(ENDPOINT, board(), 'create', {
        ...io.options,
        prepared_fixtures: state,
        prepared_fixtures_audit_sink: sink,
      })
    );
    assert.equal(denial?.refusalCode, 'authorizer_required');
    assert.match(record.error, /requires prepared_fixtures_authorizer/);
    assert.deepEqual(io.wire, [], 'no seller contact of any kind, including capability discovery');
  });

  test('a full run with direct state and no authorizer also fails closed', async () => {
    const { state } = await prepare();
    const io = transport([SELECTED]);
    const { denial, record } = await runWithAudit(sink =>
      runStoryboard(ENDPOINT, board(), { ...io.options, prepared_fixtures: state, prepared_fixtures_audit_sink: sink })
    );
    assert.equal(denial?.refusalCode, 'authorizer_required');
    assert.equal(record.overall_passed, false);
    assert.deepEqual(io.wire, []);
  });

  test('a denied authorizer reaches the seller zero times in full, standalone and multi-pass', async () => {
    const { state } = await prepare();
    const deny = () => ({ authorized: false, detail: 'grant revoked' });
    const full = transport([SELECTED]);
    const { denial, record: fullResult } = await runWithAudit(sink =>
      runStoryboard(ENDPOINT, board(), {
        ...full.options,
        prepared_fixtures: state,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: deny,
      })
    );
    assert.equal(fullResult.overall_passed, false);
    assert.deepEqual(full.wire, []);

    const step = transport([SELECTED]);
    const { denial: denial2, record: stepResult } = await runWithAudit(sink =>
      runStoryboardStep(ENDPOINT, board(), 'create', {
        ...step.options,
        prepared_fixtures: state,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: deny,
      })
    );
    assert.equal(stepResult.passed, false);
    assert.deepEqual(step.wire, []);

    const multi = transport([SELECTED]);
    const { denial: denial3, record: multiResult } = await runWithAudit(sink =>
      runStoryboard(ENDPOINT, board(), {
        ...multi.options,
        instances: 2,
        prepared_fixtures: state,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: deny,
      })
    );
    assert.equal(multiResult.overall_passed, false);
    assert.deepEqual(multi.wire, [], 'multi-pass pre-seed discovers profiles; the gate must precede it');
  });

  test('a reference the host refuses to resolve reaches the seller zero times', async () => {
    await prepare();
    const io = transport([SELECTED]);
    const { denial, record: result } = await runWithAudit(sink =>
      runStoryboardStep(ENDPOINT, board(), 'create', {
        ...io.options,
        prepared_fixtures: { ref: 'unknown', resolve: () => undefined },
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: ALLOW,
      })
    );
    assert.equal(result.passed, false);
    assert.deepEqual(io.wire, []);
  });

  test('prepare-then-revoke fails the reuse with zero seller calls', async () => {
    const { state } = await prepare();
    let revoked = false;
    const first = transport([SELECTED]);
    const { denial, record: ok } = await runWithAudit(sink =>
      runStoryboardStep(ENDPOINT, board(), 'create', {
        ...first.options,
        prepared_fixtures: state,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: () => (revoked ? { authorized: false, detail: 'revoked' } : { authorized: true }),
      })
    );
    assert.equal(ok.passed, true, JSON.stringify(ok));
    revoked = true;
    const after = transport([SELECTED]);
    const { denial: denial2, record: denied } = await runWithAudit(sink =>
      runStoryboardStep(ENDPOINT, board(), 'create', {
        ...after.options,
        prepared_fixtures: state,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: () => (revoked ? { authorized: false, detail: 'revoked' } : { authorized: true }),
      })
    );
    assert.equal(denied.passed, false);
    assert.match(denied.error, /revoked/);
    assert.deepEqual(after.wire, []);
  });

  test('an opaque reference without an authorizer fails closed', async () => {
    const { state } = await prepare();
    const io = transport([SELECTED]);
    const { denial, record } = await runWithAudit(sink =>
      runStoryboardStep(ENDPOINT, board(), 'create', {
        ...io.options,
        prepared_fixtures: { ref: 'opaque-1', resolve: () => state },
        prepared_fixtures_audit_sink: sink,
      })
    );
    assert.equal(denial?.refusalCode, 'authorizer_required');
    assert.match(record.error, /opaque reference is never authorization/i);
    assert.equal(
      io.calls.some(call => call.task === 'create_media_buy'),
      false
    );
  });

  test('an opaque reference with an authorizer resolves and is authorized', async () => {
    const { state } = await prepare();
    const seen = [];
    const io = transport([SELECTED]);
    const { denial, record: result } = await runWithAudit(sink =>
      runStoryboardStep(ENDPOINT, board(), 'create', {
        ...io.options,
        prepared_fixtures: { ref: 'opaque-1', resolve: ref => (ref === 'opaque-1' ? state : undefined) },
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: lookup => {
          seen.push(lookup);
          return { authorized: true };
        },
      })
    );
    assert.equal(result.passed, true, JSON.stringify(result));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].reference, 'opaque-1');
    assert.equal(seen[0].step_id, 'create');
    // The authorizer sees nonsecret identity only: a per-process HMAC
    // fingerprint, never the credential it was derived from.
    assert.match(seen[0].binding.credential_fingerprint, /^[0-9a-f]{32}$/);
    assert.deepEqual(seen[0].current.agent_urls, [ENDPOINT]);
  });

  test('a reference the host cannot resolve fails closed', async () => {
    await prepare();
    const io = transport([SELECTED]);
    const { denial, record: result } = await runWithAudit(sink =>
      runStoryboardStep(ENDPOINT, board(), 'create', {
        ...io.options,
        prepared_fixtures: { ref: 'unknown', resolve: () => undefined },
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: () => ({ authorized: true }),
      })
    );
    assert.equal(result.passed, false);
    // Deliberately the SAME shape as a denial: distinguishing "no such
    // reference" from "not yours" hands an unauthorized caller a free
    // existence oracle over the host's reference store.
    assert.match(result.error, /refused by the configured authorizer/);
    assert.equal(result.validations[0].actual, 'authorizer_denied');
    assert.deepEqual(io.wire, []);
  });

  test('a denied authorizer refuses before any wire call or snapshot disclosure', async () => {
    const { state } = await prepare();
    const io = transport([SELECTED]);
    const { denial, record: result } = await runWithAudit(sink =>
      runStoryboardStep(ENDPOINT, board(), 'create', {
        ...io.options,
        prepared_fixtures: state,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: () => ({ authorized: false, detail: 'grant revoked' }),
      })
    );
    assert.equal(result.passed, false);
    assert.match(result.error, /grant revoked/);
    assert.equal(
      io.calls.some(call => call.task === 'create_media_buy'),
      false
    );
    assert.equal(
      Object.keys(result.context).some(key => key.startsWith('__adcp_fixture_')),
      false,
      'a refused lookup must not disclose the prepared snapshot'
    );
  });

  test('direct in-process reuse is re-authorized on EVERY lookup, not cached', async () => {
    const { state } = await prepare();
    let grants = 2;
    const lookups = [];
    const io = transport([SELECTED]);
    const authorizer = lookup => {
      lookups.push(lookup.step_id);
      grants -= 1;
      return grants >= 0 ? { authorized: true } : { authorized: false, detail: 'grant revoked after prior step' };
    };
    const { denial, record: first } = await runWithAudit(sink =>
      runStoryboardStep(ENDPOINT, board(), 'create', {
        ...io.options,
        prepared_fixtures: state,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: authorizer,
      })
    );
    assert.equal(first.passed, true, JSON.stringify(first));
    const { denial: denial2, record: second } = await runWithAudit(sink =>
      runStoryboardStep(ENDPOINT, board(), 'create', {
        ...io.options,
        prepared_fixtures: state,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: authorizer,
      })
    );
    assert.equal(second.passed, true, JSON.stringify(second));
    const { denial: denial3, record: third } = await runWithAudit(sink =>
      runStoryboardStep(ENDPOINT, board(), 'create', {
        ...io.options,
        prepared_fixtures: state,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: authorizer,
      })
    );
    assert.equal(third.passed, false);
    assert.match(third.error, /grant revoked after prior step/);
    assert.deepEqual(lookups, ['create', 'create', 'create']);
  });

  test('a revoked grant also blocks reuse in a multi-pass run before any seller contact', async () => {
    const { state } = await prepare();
    const io = transport([SELECTED]);
    const { denial, record: result } = await runWithAudit(sink =>
      runStoryboard(ENDPOINT, board(), {
        ...io.options,
        instances: 2,
        prepared_fixtures: state,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: () => ({ authorized: false, detail: 'grant revoked' }),
      })
    );
    assert.equal(result.overall_passed, false);
    assert.deepEqual(io.wire, [], 'multi-pass must authorize before discovering, resetting or seeding');
  });

  test('a grant revoked mid-run fails the next step of a full run', async () => {
    const { state } = await prepare();
    const multiStep = board({
      steps: [
        {
          id: 'first',
          title: 'First read',
          task: 'get_products',
          stateful: false,
          sample_request: { buying_mode: 'wholesale', ext: { adcp: { creative_wire: 'canonical' } } },
          validations: [{ check: 'response_schema', description: 'Schema holds' }],
        },
        {
          id: 'second',
          title: 'Second read',
          task: 'get_products',
          stateful: false,
          sample_request: { buying_mode: 'wholesale', ext: { adcp: { creative_wire: 'canonical' } } },
          validations: [{ check: 'response_schema', description: 'Schema holds' }],
        },
      ],
    });
    const prepIo = transport([SELECTED]);
    const multiState = await prepareStoryboardFixtures(ENDPOINT, multiStep, prepIo.options);
    assert.equal(multiState.disposition.status, 'resolved');

    const io = transport([SELECTED]);
    const seen = [];
    const { denial, record: result } = await runWithAudit(sink =>
      runStoryboard(ENDPOINT, multiStep, {
        ...io.options,
        prepared_fixtures: multiState,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: lookup => {
          seen.push(lookup.step_id);
          return lookup.step_id === 'second'
            ? { authorized: false, detail: 'grant revoked between steps' }
            : { authorized: true };
        },
      })
    );
    // Two run-level lookups — the entry-point gate that must precede all
    // seller contact, and the per-pass gate that re-gates each pass of a
    // multi-pass run — then one per step.
    assert.deepEqual(seen, [undefined, undefined, 'first', 'second']);
    const steps = result.phases.flatMap(phase => phase.steps);
    assert.equal(steps.find(step => step.step_id === 'first').passed, true);
    const second = steps.find(step => step.step_id === 'second');
    assert.equal(second.passed, false);
    assert.match(second.error, /grant revoked between steps/);
    // Bookkeeping, not just the step verdict: the original defect was a
    // `continue` that skipped phase grading and the failure count.
    assert.equal(result.overall_passed, false);
    assert.equal(result.failed_count, 1);
    assert.equal(
      result.phases.find(phase => phase.phase_id === 'exercise').passed,
      false,
      'a phase containing a refused step must not grade green'
    );
    // The CALLER got a typed denial and no result at all.
    assert.ok(denial, 'the refused caller is denied, not handed a report');
    assert.equal(denial.refusalCode, 'authorizer_denied');
    assert.equal(denial.code, 'PREPARED_FIXTURES_DENIED');
    // The denial carries the machine code and nothing derived from the
    // prepared graph.
    const denialText = `${denial.message} ${JSON.stringify(denial.details)}`;
    assert.equal(denialText.includes('a-selected'), false, denialText);
    assert.equal(denialText.includes('grant revoked between steps'), false, denialText);
    // The AUDIT record is the accountable copy: complete and unredacted,
    // including the resolutions with their seller ids.
    assert.ok(result.fixture_resolutions, 'the audit record keeps fixture_resolutions');
    assert.equal(
      result.fixture_resolutions.some(entry => entry.seller_ids),
      true
    );
    assert.equal(
      Object.keys(result.context).some(key => key.startsWith('__adcp_fixture_')),
      true,
      'the audit record keeps the reserved captures'
    );
  });

  test('the authorizer is consulted BEFORE the binding diff, so a guessed reference leaks nothing', async () => {
    // Tenant A prepares. Tenant B enumerates the opaque reference; the host
    // resolver answers for any ref it holds. Diffing first would hand tenant
    // B a mismatch report naming tenant A's principal and credential
    // fingerprint — and turn that fingerprint into a confirmation oracle.
    const victim = await prepare({
      prepared_fixtures_principal: 'tenant-a/alice',
      auth: { type: 'bearer', token: 'victim-token' },
    });
    const io = transport([SELECTED]);
    let authorizerCalled = false;
    const { denial, record: result } = await runWithAudit(sink =>
      runStoryboardStep(ENDPOINT, board(), 'create', {
        ...io.options,
        prepared_fixtures_principal: 'tenant-b/mallory',
        prepared_fixtures: { ref: 'guessed-ref', resolve: () => victim.state },
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: () => {
          authorizerCalled = true;
          return { authorized: false, detail: 'reference does not belong to this tenant' };
        },
      })
    );
    assert.equal(authorizerCalled, true, 'the authorizer must decide ownership first');
    assert.equal(result.passed, false);
    // The host's own `detail` is deliberately NOT echoed on the reference
    // path. A denial that reads "does not belong to this tenant" only ever
    // follows a reference that resolved, so echoing it would tell mallory
    // the guess hit a real row. The uniform sentence is the refusal.
    assert.equal(result.error, 'prepared fixture state was refused by the configured authorizer');
    assert.equal(result.validations[0].actual, 'authorizer_denied');
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes('tenant-a/alice'), false, 'no victim principal in the refusal');
    assert.equal(
      serialized.includes(victim.state.binding.credential_fingerprint),
      false,
      'no victim credential fingerprint in the refusal'
    );
  });

  test('a binding mismatch names fields only, never their values', async () => {
    const { state } = await prepare({
      prepared_fixtures_principal: 'tenant-a/alice',
      auth: { type: 'bearer', token: 'victim-token' },
    });
    const io = transport([SELECTED]);
    const { denial, record: result } = await runWithAudit(sink =>
      runStoryboardStep(ENDPOINT, board(), 'create', {
        ...io.options,
        prepared_fixtures_principal: 'tenant-b/mallory',
        auth: { type: 'bearer', token: 'other-token' },
        prepared_fixtures: state,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: ALLOW,
      })
    );
    assert.equal(result.passed, false);
    assert.match(result.error, /differing binding field\(s\): .*principal/);
    assert.equal(result.error.includes('tenant-a/alice'), false);
    assert.equal(result.error.includes(state.binding.credential_fingerprint), false);
  });

  test('a refused lookup does not keep echoing the pinned snapshot', async () => {
    const { state } = await prepare();
    const io = transport([SELECTED]);
    const { denial, record: result } = await runWithAudit(sink =>
      runStoryboardStep(ENDPOINT, board(), 'create', {
        ...io.options,
        prepared_fixtures: state,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: () => ({ authorized: false, detail: 'grant revoked' }),
      })
    );
    assert.equal(result.passed, false);
    assert.equal(
      Object.keys(result.context).some(key => key.startsWith('__adcp_fixture_')),
      false,
      'a revoked grant must stop disclosing the pinned identity and captured pricing'
    );
    assert.equal(JSON.stringify(result).includes('a-selected'), false);
  });

  test('nothing touches the seller before the gate — not even a controller reset', async () => {
    const { state } = await prepare();
    const io = transport([SELECTED]);
    const { denial, record: result } = await runWithAudit(sink =>
      runStoryboard(ENDPOINT, board(), {
        ...io.options,
        prepared_fixtures: state,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: () => ({ authorized: false, detail: 'grant revoked' }),
      })
    );
    assert.equal(result.overall_passed, false);
    // Zero seller contact of any kind: no capability discovery, no catalog
    // read, no seed_* mutation, no comply_test_controller reset.
    assert.deepEqual(io.wire, []);
  });

  test('no live internal state escapes any accessor', async () => {
    const { state } = await prepare();
    // Every accessor result is mutated, then the state is re-read. A private
    // constructor token stops forgery; it does not make the objects the
    // constructor was handed immutable or detached.
    const before = {
      binding: state.binding,
      disposition: state.disposition,
      resolutions: state.resolutions,
      coverageGaps: state.coverageGaps,
      selections: state.selections,
      captures: state.captures,
      captureProvenance: state.captureProvenance,
      witnesses: state.witnesses,
      phase: state.phase,
    };
    before.binding.storyboard_id = 'mutated';
    before.binding.agent_urls.push('https://attacker.example/mcp');
    before.disposition.status = 'failed';
    before.resolutions[0].seller_ids.product_id = 'mutated';
    before.coverageGaps.push({ reason: 'fixture_unsatisfied', detail: 'forged', fixtures: [] });
    before.selections[0].seller_ids.product_id = 'mutated';
    before.captures.__adcp_fixture_product_id = 'mutated';
    before.captureProvenance.__adcp_fixture_product_id = { source_step_id: 'forged', source_kind: 'convention' };
    before.witnesses['authored-product'].product_id = 'mutated';
    if (before.phase) {
      before.phase.passed = false;
      before.phase.steps.length = 0;
    }
    assert.equal(state.binding.storyboard_id, 'prepared_fixtures/selection');
    assert.deepEqual(state.binding.agent_urls, [ENDPOINT]);
    assert.equal(state.disposition.status, 'resolved');
    assert.equal(state.resolutions[0].seller_ids.product_id, 'a-selected');
    assert.deepEqual(state.coverageGaps, []);
    assert.equal(state.selections[0].seller_ids.product_id, 'a-selected');
    assert.equal(state.captures.__adcp_fixture_product_id, 'a-selected');
    assert.equal(state.captureProvenance.__adcp_fixture_product_id.source_kind, 'fixture_preparation');
    assert.equal(state.witnesses['authored-product'].product_id, 'a-selected');
    assert.equal(state.phase?.passed, true);
    assert.ok((state.phase?.steps.length ?? 0) > 0);

    // The binding registry is not on the public surface at all: it exposes
    // live registration that could re-point a pinned handle.
    assert.equal('bindingRegistry' in state, false);
    assert.equal(state.bindingRegistry, undefined);

    // Reuse after all that mutation still pins the original entity.
    const io = transport([SELECTED]);
    const { denial, record: result } = await runWithAudit(sink =>
      runStoryboardStep(ENDPOINT, board(), 'create', {
        ...io.options,
        prepared_fixtures: state,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: ALLOW,
      })
    );
    assert.equal(result.passed, true, JSON.stringify(result));
    assert.equal(io.calls.find(call => call.task === 'create_media_buy').request.packages[0].product_id, 'a-selected');
  });

  test('a failed preparation keeps its raw evidence detached too', async () => {
    const io = transport([{ product_id: 'broken' }]);
    const state = await prepareStoryboardFixtures(ENDPOINT, board(), io.options);
    assert.equal(state.disposition.status, 'failed');
    const disposition = state.disposition;
    disposition.status = 'resolved';
    disposition.detail = 'forged';
    const phase = state.phase;
    if (phase) phase.passed = true;
    assert.equal(state.disposition.status, 'failed');
    assert.notEqual(state.disposition.detail, 'forged');
    assert.equal(state.phase?.passed ?? false, false);
  });

  test('the constructor input objects are not retained by reference', async () => {
    const { state } = await prepare();
    // The caller keeps a live handle on whatever it passed in; the canonical
    // copy must not be that object.
    const phase = state.phase;
    assert.notStrictEqual(phase, state.phase);
    assert.deepEqual(phase, state.phase);
  });

  test('the contract version is pinned and recorded on every binding', async () => {
    const { state } = await prepare();
    assert.equal(state.binding.contract_version, PREPARED_FIXTURES_CONTRACT_VERSION);
    assert.match(PREPARED_FIXTURES_CONTRACT_VERSION, /^\d+\.\d+\.\d+$/);
  });

  test('prepared_fixtures_run_id identifies the preparation and is not re-compared', async () => {
    const { state } = await prepare({ prepared_fixtures_run_id: 'run-a' });
    assert.equal(state.binding.run_id, 'run-a');
    const io = transport([SELECTED]);
    // Reuse under a different run id must still work: later steps share the
    // preparation's run by design.
    const { denial, record: result } = await runWithAudit(sink =>
      runStoryboardStep(ENDPOINT, board(), 'create', {
        ...io.options,
        prepared_fixtures_run_id: 'run-b',
        prepared_fixtures: state,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: ALLOW,
      })
    );
    assert.equal(result.passed, true, JSON.stringify(result));
  });
});

// ────────────────────────────────────────────────────────────
// Lookup payload and refusal shape
// ────────────────────────────────────────────────────────────

describe('lookup payload and refusal shape', () => {
  test('brand scope is a binding dimension of its own, separate from the account', async () => {
    // `context.brand` wins over the account's brand in discovery, so two runs
    // can share an account identity byte-for-byte and still have been pinned
    // against different advertisers' catalogs. Without its own field the
    // authorizer would be handed two identical payloads.
    const account = { brand: { domain: 'acmeoutdoor.example' }, operator: 'pinnacle-agency.example' };
    const prepared = await prepare({ context: { account, brand: { domain: 'acmeoutdoor.example' } } });
    assert.equal(prepared.state.binding.brand_scope.includes('acmeoutdoor.example'), true);

    const io = transport([SELECTED]);
    const { denial, record: result } = await runWithAudit(sink =>
      runStoryboardStep(ENDPOINT, board(), 'create', {
        ...io.options,
        context: { account, brand: { domain: 'rival-brand.example' } },
        prepared_fixtures: prepared.state,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: ALLOW,
      })
    );
    assert.equal(result.passed, false, JSON.stringify(result));
    assert.match(result.error, /brand_scope/);
    assert.equal(
      result.error.includes('account_scope'),
      false,
      'the account is unchanged; naming it would misdirect the operator'
    );
    assert.deepEqual(io.wire, []);
  });

  test('an unresolvable reference and a denied one are byte-identical refusals', async () => {
    // Any divergence — message, machine code, or validation shape — is a free
    // existence oracle over the host's reference store.
    const { state } = await prepare();
    const results = [];
    for (const resolve of [() => undefined, () => state]) {
      const io = transport([SELECTED]);
      const probe = await runWithAudit(sink =>
        runStoryboardStep(ENDPOINT, board(), 'create', {
          ...io.options,
          prepared_fixtures: { ref: 'probe', resolve },
          prepared_fixtures_audit_sink: sink,
          prepared_fixtures_authorizer: () => ({ authorized: false }),
        })
      );
      // Both arms must deny identically — and the AUDIT records must match
      // too, since a host that logs them side by side would otherwise see
      // which reference resolved.
      results.push({ denial: probe.denial, record: probe.record });
      assert.deepEqual(io.wire, []);
    }
    assert.equal(results[0].denial.message, results[1].denial.message);
    assert.equal(results[0].denial.refusalCode, results[1].denial.refusalCode);
    assert.equal(results[0].record.error, results[1].record.error);
    assert.equal(results[0].record.validations[0].check, results[1].record.validations[0].check);
    assert.equal(results[0].record.validations[0].actual, results[1].record.validations[0].actual);
    assert.equal(results[0].record.validations[0].error, results[1].record.validations[0].error);
  });

  test('the authorizer is still consulted for a reference that does not resolve', async () => {
    // Short-circuiting on a miss would make the authorizer's own call count a
    // side channel even when the refusal text matches.
    const { state } = await prepare();
    for (const [resolve, expected] of [
      [() => undefined, 1],
      [() => state, 1],
    ]) {
      const io = transport([SELECTED]);
      let calls = 0;
      const { denial, record: _ignored7 } = await runWithAudit(sink =>
        runStoryboardStep(ENDPOINT, board(), 'create', {
          ...io.options,
          prepared_fixtures: { ref: 'probe', resolve },
          prepared_fixtures_audit_sink: sink,
          prepared_fixtures_authorizer: () => {
            calls += 1;
            return { authorized: false };
          },
        })
      );
      assert.equal(calls, expected);
    }
  });

  test('a resolver that throws is refused, not propagated', async () => {
    const io = transport([SELECTED]);
    const { denial, record: result } = await runWithAudit(sink =>
      runStoryboardStep(ENDPOINT, board(), 'create', {
        ...io.options,
        prepared_fixtures: {
          ref: 'probe',
          resolve: () => {
            throw new Error('host store down: pg://secret@10.0.0.4/grants');
          },
        },
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: ALLOW,
      })
    );
    assert.equal(result.passed, false);
    assert.equal(result.error.includes('10.0.0.4'), false, 'host infrastructure detail must not reach the report');
    assert.deepEqual(io.wire, []);
  });

  test('each gate identifies itself so an authorizer can scope by call site', async () => {
    const { state } = await prepare();
    const io = transport([SELECTED]);
    const gates = [];
    const { denial, record: run } = await runWithAudit(sink =>
      runStoryboard(ENDPOINT, board(), {
        ...io.options,
        prepared_fixtures: state,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: lookup => {
          gates.push(lookup.gate);
          return { authorized: true };
        },
      })
    );
    assert.equal(run.overall_passed, true, JSON.stringify(run.phases));
    assert.equal(gates.includes('run'), true, 'the entry-point gate precedes all seller contact');
    assert.equal(gates.includes('step'), true, 'every step re-asks');
    assert.equal(
      gates.every(gate => ['run', 'pass', 'step'].includes(gate)),
      true,
      JSON.stringify(gates)
    );
  });

  test('caller metadata carrying a reserved key is refused before any seller contact', async () => {
    const io = transport([SELECTED]);
    for (const [key, overrides] of [
      ['options.context', { context: { __adcp_fixture_product_id: 'forged' } }],
      ['options.context_provenance', { context_provenance: { __adcp_fixture_product_id: {} } }],
      [
        'options.response_derived_not_applicable_context_keys',
        { response_derived_not_applicable_context_keys: { __adcp_fixture_product_id: 'why' } },
      ],
      // `JSON.parse`, not a literal: `{ __proto__: … }` in source sets the
      // prototype and leaves no own key, which is exactly the shape a hosted
      // JSON route does NOT produce. The route's parser makes it an own key.
      ['options.context (parsed __proto__)', { context: JSON.parse('{"__proto__": {"polluted": true}}') }],
    ]) {
      const probe = transport([SELECTED]);
      const { denial, record } = await runWithAudit(sink =>
        runStoryboardStep(ENDPOINT, board(), 'create', {
          ...probe.options,
          ...overrides,
          prepared_fixtures_audit_sink: sink,
        })
      );
      assert.equal(denial?.refusalCode, 'unauthorized_metadata', key);
      assert.equal(record.passed, false, `${key}: ${JSON.stringify(record)}`);
      assert.equal(
        record.validations.some(v => v.actual === 'unauthorized_metadata'),
        true,
        JSON.stringify(record)
      );
      assert.deepEqual(probe.wire, [], `${key} must be screened before the first seller byte`);
    }
    assert.deepEqual(io.wire, []);
  });

  test('a revocation on any pass denies the whole multi-pass run', async () => {
    // The aggregate used to republish pass one's phases verbatim, which is
    // why it needed projecting. Under the Option 1 contract there is no
    // aggregate to hand back at all: the refused pass denies the run.
    const replicas = [ENDPOINT, ENDPOINT];
    const prepIo = transport([SELECTED]);
    const state = await prepareStoryboardFixtures(replicas, board(), prepIo.options);
    const io = transport([SELECTED]);
    let seenStepGate = 0;
    const { denial, record: result } = await runWithAudit(sink =>
      runStoryboard(replicas, board(), {
        ...io.options,
        multi_instance_strategy: 'multi-pass',
        prepared_fixtures: state,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: lookup => {
          if (lookup.gate !== 'step') return { authorized: true };
          seenStepGate += 1;
          return seenStepGate > 1 ? { authorized: false, detail: 'revoked between passes' } : { authorized: true };
        },
      })
    );
    assert.ok(denial, 'the caller is denied, not handed a partial aggregate');
    assert.equal(denial.refusalCode, 'authorizer_denied');
    // The grant really was valid for the first pass — otherwise the denial
    // proves nothing about a revocation observed partway through.
    assert.ok(seenStepGate > 1, 'the first pass ran under a valid grant');
    // What reaches the host's audit scope is the refusing PASS's own
    // complete record, not a half-built aggregate: the aggregate is never
    // assembled, because the pass throws before returning into it.
    assert.ok(result, 'the audit sink receives the refusing pass');
    assert.equal(result.passes, undefined, 'not an aggregate');
    assert.equal(
      result.phases
        .flatMap(phase => phase.steps)
        .flatMap(step => step.validations)
        .some(v => v.check === 'prepared_fixtures_authorization'),
      true
    );
  });
});

// ────────────────────────────────────────────────────────────
// Unbuildable captures
// ────────────────────────────────────────────────────────────

describe('refused caller gets a denial; the host gets the evidence', () => {
  /** A read step that injects the pinned id and fails an authored check. */
  function readBeforeStep() {
    return {
      id: 'read_before',
      title: 'Read before the grant is revoked',
      task: 'get_products',
      sample_request: {
        buying_mode: 'wholesale',
        ext: { pinned_id: '$context.__adcp_fixture_product_id' },
      },
      validations: [
        {
          check: 'field_value',
          path: 'cache_scope',
          expected: 'never',
          description: 'Intentional pre-revocation failure',
        },
      ],
    };
  }

  /** Prepare, then run with the grant revoked at the `create` step. */
  async function revokeMidRun(overrides = {}) {
    const doc = board({ steps: [readBeforeStep()] });
    doc.phases[0].steps.push(board().phases[0].steps[0]);
    const prepIo = transport([SELECTED]);
    const state = await prepareStoryboardFixtures(ENDPOINT, doc, prepIo.options);
    assert.equal(state.disposition.status, 'resolved', JSON.stringify(state.disposition));
    const io = transport([SELECTED], overrides);
    let revoked = false;
    const outcome = await runWithAudit(sink =>
      runStoryboard(ENDPOINT, doc, {
        ...io.options,
        prepared_fixtures: state,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: lookup => {
          if (lookup.step_id === 'create') revoked = true;
          return revoked ? { authorized: false, detail: 'live grant revoked' } : { authorized: true };
        },
      })
    );
    return { ...outcome, io };
  }

  test('the caller gets a typed denial carrying the refusal code and nothing else', async () => {
    const { denial, io } = await revokeMidRun();
    assert.ok(denial instanceof PreparedFixturesDeniedError, String(denial));
    assert.equal(denial.code, 'PREPARED_FIXTURES_DENIED');
    assert.equal(denial.refusalCode, 'authorizer_denied');
    // An authorization failure is an access-control error, not a grading
    // outcome: there is no result to inspect, partial or redacted. Every
    // identity the run touched must be absent from what the caller holds.
    const visible = `${denial.message} ${JSON.stringify(denial.details)} ${JSON.stringify(Object.entries(denial))}`;
    for (const secret of ['a-selected', 'authored-price', 'seller-buy', 'live grant revoked']) {
      assert.equal(visible.includes(secret), false, `${secret} must not reach the refused caller: ${visible}`);
    }
    // The step before the revocation really did run — otherwise there is
    // nothing the denial could have withheld.
    assert.ok(
      io.calls.some(call => call.task === 'get_products' && call.request.ext?.pinned_id === 'a-selected'),
      'the first read dispatched under a valid grant'
    );
    assert.equal(
      io.calls.some(call => call.task === 'create_media_buy'),
      false,
      'the revoked step never reached the seller'
    );
  });

  test('the audit record is complete and unredacted, with no [redacted] standing in', async () => {
    const { record } = await revokeMidRun();
    assert.ok(record, 'the host sink received the record');
    const step = record.phases.flatMap(phase => phase.steps).find(entry => entry.step_id === 'read_before');
    assert.ok(step, JSON.stringify(record));
    // Exact request and response records for the step that ran.
    assert.equal(step.request.transport, 'mcp');
    assert.equal(step.request.payload.ext.pinned_id, 'a-selected', 'the real dispatched value, not a marker');
    assert.equal(step.response_record.payload.cache_scope, 'account');
    // The prior authored failure keeps its own evidence.
    const authored = step.validations.find(v => v.check === 'field_value');
    assert.equal(authored.passed, false);
    assert.equal(authored.description, 'Intentional pre-revocation failure');
    // fixture_resolutions with seller_ids, and the reserved captures.
    assert.ok(record.fixture_resolutions?.length, 'fixture_resolutions is retained');
    assert.equal(
      record.fixture_resolutions.some(entry => entry.seller_ids?.product_id === 'a-selected'),
      true
    );
    assert.equal(record.context.__adcp_fixture_product_id, 'a-selected');
    // Nothing anywhere stands in for required evidence.
    assert.equal(JSON.stringify(record).includes('[redacted]'), false, 'no marker in the accountable copy');
  });

  test('the refusal check records explicit request and response nulls', async () => {
    const { record } = await revokeMidRun();
    const refusal = record.phases
      .flatMap(phase => phase.steps)
      .flatMap(step => step.validations)
      .find(v => v.check === 'prepared_fixtures_authorization');
    assert.ok(refusal, JSON.stringify(record));
    // Explicit nulls, not omission: a missing key cannot be told apart
    // from a runner that forgot to record one.
    for (const field of ['request', 'response', 'json_pointer', 'schema_id', 'schema_url']) {
      assert.ok(Object.hasOwn(refusal, field), `${field} key present`);
      assert.equal(refusal[field], null, field);
    }
    const step = record.phases.flatMap(phase => phase.steps).find(entry => entry.validations.includes(refusal));
    assert.equal(step.duration_ms, 0);
  });

  test('with no audit sink the record is produced to nobody', async () => {
    const doc = board();
    const prepIo = transport([SELECTED]);
    const state = await prepareStoryboardFixtures(ENDPOINT, doc, prepIo.options);
    const io = transport([SELECTED]);
    await assert.rejects(
      () =>
        runStoryboard(ENDPOINT, doc, {
          ...io.options,
          prepared_fixtures: state,
          prepared_fixtures_authorizer: () => ({ authorized: false, detail: 'denied' }),
        }),
      error => error instanceof PreparedFixturesDeniedError && error.refusalCode === 'authorizer_denied'
    );
    assert.deepEqual(io.wire, []);
  });

  test('a sink that throws does not turn a denial into a success or an oracle', async () => {
    const doc = board();
    const prepIo = transport([SELECTED]);
    const state = await prepareStoryboardFixtures(ENDPOINT, doc, prepIo.options);
    const io = transport([SELECTED]);
    await assert.rejects(
      () =>
        runStoryboard(ENDPOINT, doc, {
          ...io.options,
          prepared_fixtures: state,
          prepared_fixtures_audit_sink: () => {
            throw new Error('audit backend down: pg://10.0.0.7:5432');
          },
          prepared_fixtures_authorizer: () => ({ authorized: false, detail: 'denied' }),
        }),
      error =>
        error instanceof PreparedFixturesDeniedError &&
        // The sink's own failure is not reported to the refused caller:
        // it would be an oracle over host state.
        !error.message.includes('10.0.0.7')
    );
  });
});

describe('failed preparation keeps its producer evidence (#3385)', () => {
  /**
   * The four ways discovery can fail, each with the shape that produces
   * it. Transport never reaches a response; the other three do.
   */
  const FAILURE_MODES = {
    transport: { transportFailure: true },
    protocol: { protocolFailure: true },
    schema: { read: () => ({ status: 'completed', products: [{ product_id: 'malformed' }] }) },
    pagination: {
      read: () => ({
        status: 'completed',
        products: [SELECTED],
        cache_scope: 'account',
        wholesale_feed_version: 'v1',
        // has_more with no cursor: the seller promised another page and
        // gave the runner no way to ask for it.
        pagination: { has_more: true },
      }),
    },
  };

  /** Prepare against a seller that fails discovery in the named way. */
  async function prepareFailing(mode) {
    const io = transport([SELECTED], FAILURE_MODES[mode]);
    const state = await prepareStoryboardFixtures(ENDPOINT, board(), io.options);
    assert.equal(state.disposition.status, 'failed', `${mode}: ${JSON.stringify(state.disposition)}`);
    assert.ok(state.resolutions.length > 0, `${mode}: the producer recorded its handles`);
    return { state, io };
  }

  for (const mode of Object.keys(FAILURE_MODES)) {
    test(`${mode}: a full run reuse reports product discovery and keeps the producer records`, async () => {
      const { state } = await prepareFailing(mode);
      const io = transport([SELECTED]);
      const result = await runStoryboard(ENDPOINT, board(), {
        ...io.options,
        ...withPreparedFixtures(state, ALLOW),
      });
      assert.equal(result.overall_passed, false);
      assert.equal(result.failed_count, 1);
      assert.equal(result.skipped_count, 0, 'a failed preparation is a failure, never a skip');

      // The producer records survive into the consumer's result.
      assert.deepEqual(result.fixture_resolutions, state.resolutions);

      // The failure is named as product discovery, not capability discovery.
      const steps = result.phases.flatMap(phase => phase.steps);
      const synthetic = steps.find(step => step.step_id === 'prepared_fixtures_preparation_failed');
      assert.ok(synthetic, JSON.stringify(result.phases.map(p => p.phase_id)));
      assert.equal(synthetic.task, 'get_products', 'the real failing task, not a blank capability row');
      assert.equal(
        steps.some(step => step.step_id === 'discovery_failed'),
        false,
        'a failed preparation is not an agent capability-discovery failure'
      );
      const check = synthetic.validations.find(v => v.check === 'fixture_capture_unbuildable');
      assert.ok(check, JSON.stringify(synthetic.validations));
      assert.equal(check.actual, 'preparation_failed');

      // The producer's own phase, with its original context and error.
      const producer = result.fixture_preparation;
      assert.ok(producer, 'the producer phase is retained separately from consumer grading');
      assert.ok(
        producer.steps.some(step => step.passed === false),
        'with its failing step intact'
      );
      assert.equal(
        result.phases.flatMap(phase => phase.steps).filter(step => !step.passed && !step.skipped).length,
        result.failed_count
      );
      const { formatStoryboardResultsAsJUnit } = require('../../dist/lib/testing/storyboard/junit.js');
      assert.match(formatStoryboardResultsAsJUnit([result]), /failures="1"/);
      assert.deepEqual(
        producer.steps.map(step => step.error),
        state.phase.steps.map(step => step.error)
      );
    });

    test(`${mode}: a standalone reuse carries the same producer records`, async () => {
      const { state } = await prepareFailing(mode);
      const io = transport([SELECTED]);
      const result = await runStoryboardStep(ENDPOINT, board(), 'create', {
        ...io.options,
        ...withPreparedFixtures(state, ALLOW),
      });
      assert.equal(result.passed, false);
      assert.deepEqual(result.fixture_resolutions, state.resolutions);
      assert.ok(result.fixture_preparation);
      const check = result.validations.find(v => v.check === 'fixture_capture_unbuildable');
      assert.ok(check, JSON.stringify(result.validations));
      assert.equal(check.actual, 'preparation_failed');
      assert.equal(check.request, null);
      assert.equal(check.response, null);
      // No consumer exchange occurred, so none is invented.
      assert.equal(
        io.calls.some(call => call.task === 'create_media_buy'),
        false
      );
    });

    test(`${mode}: the producer step names get_products and never claims a controller seed`, async () => {
      const { state } = await prepareFailing(mode);
      const producerSteps = state.phase.steps;
      const failing = producerSteps.find(step => step.passed === false);
      assert.ok(failing, JSON.stringify(producerSteps.map(s => ({ id: s.step_id, passed: s.passed }))));
      assert.equal(failing.task, 'get_products', 'the wire call was get_products');
      assert.equal(
        producerSteps.some(step => step.task === 'comply_test_controller'),
        false,
        'no controller seed happened, so none may be claimed'
      );
    });
  }

  test('a failed discovery records the real request, and a response only when one arrived', async () => {
    for (const mode of Object.keys(FAILURE_MODES)) {
      const { state } = await prepareFailing(mode);
      const failing = state.phase.steps.find(step => step.passed === false);
      assert.ok(failing.request, `${mode}: the dispatched request is recorded`);
      assert.equal(failing.request.operation, 'get_products', mode);
      assert.equal(failing.request.payload.buying_mode, 'wholesale', mode);
      if (mode === 'transport') {
        assert.equal(failing.response_record, undefined, 'an SDK connection error is not a seller response');
        continue;
      }
      assert.ok(failing.response_record, `${mode}: an actual response is recorded`);
      assert.equal(failing.response_record.transport, 'mcp', mode);
    }
  });

  test('a schema failure carries a response_schema check with the schema identity', async () => {
    const { state } = await prepareFailing('schema');
    const failing = state.phase.steps.find(step => step.passed === false);
    const check = failing.validations.find(v => v.check === 'response_schema');
    assert.ok(check, JSON.stringify(failing.validations));
    assert.equal(check.passed, false);
    assert.equal(check.actual, 'schema_validation_failed');
    assert.equal(check.schema_id, '/schemas/3.2.5/media-buy/get-products-response.json');
    assert.equal(check.schema_url, 'https://adcontextprotocol.org/schemas/3.2.5/media-buy/get-products-response.json');
    assert.ok(check.request, 'the schema failure cites the request it graded');
    assert.ok(check.response, 'and the response it graded');
  });

  test('a real executor throw records a request without inventing a response', async () => {
    const { runControllerSeeding } = require('../../dist/lib/testing/storyboard/seeding.js');
    const dispatch = async () => {
      throw new Error('executor failed before any response');
    };
    const result = await runControllerSeeding(
      { getProducts: dispatch, getProductsLegacy: dispatch },
      board(),
      { ...transport([SELECTED]).options, agentTools: ['get_products'] },
      {}
    );
    const failing = result.phase.steps.find(step => !step.passed);
    assert.equal(failing.request.operation, 'get_products');
    assert.equal(failing.response_record, undefined);
  });

  test('A2A discovery evidence records the configured transport', async () => {
    const { runControllerSeeding } = require('../../dist/lib/testing/storyboard/seeding.js');
    const dispatch = async () => ({
      success: true,
      status: 'completed',
      data: {
        status: 'completed',
        products: [{ product_id: 'malformed' }],
      },
    });
    const result = await runControllerSeeding(
      { getProducts: dispatch, getProductsLegacy: dispatch },
      board(),
      { ...transport([SELECTED]).options, protocol: 'a2a', agentTools: ['get_products'] },
      {}
    );
    const failing = result.phase.steps.find(step => !step.passed);
    assert.equal(failing.request.transport, 'a2a');
    assert.equal(failing.response_record.transport, 'a2a');
  });

  test('protocol and pagination failures are not relabelled as schema failures', async () => {
    for (const mode of ['protocol', 'pagination']) {
      const { state } = await prepareFailing(mode);
      assert.equal(
        state.phase.steps.flatMap(step => step.validations).some(v => v.check === 'response_schema'),
        false,
        mode
      );
    }
  });

  test('the terminal failing page is retained even beyond the successful-page evidence budget', async () => {
    let pages = 0;
    const io = transport([], {
      read: () => {
        pages++;
        return pages <= 16
          ? {
              status: 'completed',
              products: [],
              cache_scope: 'account',
              wholesale_feed_version: 'v1',
              pagination: { has_more: true, cursor: `page-${pages + 1}` },
            }
          : { status: 'completed', products: [{ product_id: 'late-malformed' }] };
      },
    });
    const state = await prepareStoryboardFixtures(ENDPOINT, board(), io.options);
    assert.equal(state.disposition.status, 'failed');
    assert.equal(pages, 17);
    const failing = state.phase.steps.find(step => !step.passed);
    assert.equal(failing.request.payload.pagination.cursor, 'page-17');
    assert.match(JSON.stringify(failing.response_record.payload), /late-malformed/);
    assert.doesNotMatch(JSON.stringify(failing.response_record.payload), /response_not_retained/);
  });

  test('captured protocol text redacts secret fields before producer evidence is retained', async () => {
    const io = transport([], {
      protocolFailure: true,
      protocolPayload: {
        status: 'failed',
        adcp_error: {
          code: 'INVALID_REQUEST',
          message: 'Denied',
          recovery: 'terminal',
          details: { token: 'wire-secret-value', private_key: 'private-key-value', signature: 'signature-value' },
        },
      },
    });
    const state = await prepareStoryboardFixtures(ENDPOINT, board(), io.options);
    assert.equal(state.disposition.status, 'failed');
    assert.doesNotMatch(JSON.stringify(state.phase), /wire-secret-value|private-key-value|signature-value/);
    assert.match(JSON.stringify(state.phase), /redacted/);
  });

  test('A2A failed tasks retain the seller rejection without grading a product schema', async () => {
    const { runControllerSeeding } = require('../../dist/lib/testing/storyboard/seeding.js');
    const response = {
      jsonrpc: '2.0',
      id: 'a2a-error',
      result: {
        kind: 'task',
        id: 'failed-discovery',
        contextId: 'ctx',
        status: { state: 'failed' },
        artifacts: [
          {
            artifactId: 'error',
            parts: [
              {
                kind: 'data',
                data: {
                  adcp_error: { code: 'INVALID_REQUEST', message: 'Seller refused discovery', recovery: 'terminal' },
                },
              },
            ],
          },
        ],
      },
    };
    const dispatch = async () => ({
      success: false,
      error: 'Seller refused discovery',
      data: {},
      debug_logs: [{ message: 'A2A: Response received', response }],
    });
    const result = await runControllerSeeding(
      { getProducts: dispatch, getProductsLegacy: dispatch },
      board(),
      {
        ...transport([]).options,
        protocol: 'a2a',
        agentTools: ['get_products'],
      },
      {}
    );
    const failed = result.phase.steps.find(step => !step.passed);
    assert.equal(failed.task, 'get_products');
    assert.deepEqual(failed.response_record.payload, response);
    assert.equal(
      failed.validations.some(v => v.check === 'response_schema'),
      false
    );
  });

  test('schema diagnostics use the discovery route version and the terminal SDK trace', async () => {
    const { runControllerSeeding } = require('../../dist/lib/testing/storyboard/seeding.js');
    const malformed = { status: 'completed', products: [{ product_id: 'terminal-malformed' }] };
    const protocolResponse = { content: [{ type: 'text', text: JSON.stringify(malformed) }] };
    const dispatch = async () => ({
      success: false,
      error: 'validation failed',
      data: { products: [] },
      debug_logs: [
        {
          message: 'MCP: Tool get_products response received',
          response: { content: [{ type: 'text', text: '{"status":"submitted"}' }] },
        },
        { message: 'MCP: Tool get_products response received', response: protocolResponse },
      ],
    });
    const client = { getProducts: dispatch, getProductsLegacy: dispatch };
    const options = { ...transport([]).options, adcpVersion: '3.2.6', agentTools: ['get_products'] };
    const result = await runControllerSeeding(client, board(), options, {}, client, () => ({
      client,
      options: { ...options, adcpVersion: '3.2.5' },
    }));
    const failed = result.phase.steps.find(step => !step.passed);
    const check = failed.validations.find(v => v.check === 'response_schema');
    assert.equal(check.schema_id, '/schemas/3.2.5/media-buy/get-products-response.json');
    assert.equal(check.expected, check.schema_id);
    assert.deepEqual(failed.response_record.payload, protocolResponse);
  });

  test('SDK-projected errors without wire evidence are never graded as seller schema failures', async () => {
    const { runControllerSeeding } = require('../../dist/lib/testing/storyboard/seeding.js');
    const dispatch = async () => ({ success: false, error: 'connection failed', data: { products: [] } });
    const result = await runControllerSeeding(
      { getProducts: dispatch, getProductsLegacy: dispatch },
      board(),
      {
        ...transport([]).options,
        agentTools: ['get_products'],
      },
      {}
    );
    const failed = result.phase.steps.find(step => !step.passed);
    assert.equal(failed.response_record, undefined);
    assert.equal(
      failed.validations.some(v => v.check === 'response_schema'),
      false
    );
  });

  test('a partial graph keeps protected captures out of consumer context without duplicating failures', async () => {
    const doc = board();
    doc.fixtures.products.push(product('other-product'));
    doc.fixture_resolution.products.push({ handle: 'other-product', strategies: ['seed'] });
    const io = transport([SELECTED], { controller: () => ({ success: false, error: 'UPSTREAM_FAILURE' }) });
    const state = await prepareStoryboardFixtures(ENDPOINT, doc, {
      ...io.options,
      agentTools: [...TOOLS, 'comply_test_controller'],
    });
    assert.equal(state.disposition.status, 'failed', JSON.stringify(state.disposition));
    assert.ok(
      state.phase.steps.some(step => step.passed),
      'the graph must contain earlier successful producer work'
    );
    const runIo = transport([SELECTED]);
    const result = await runStoryboard(ENDPOINT, doc, { ...runIo.options, ...withPreparedFixtures(state, ALLOW) });
    assert.equal(result.failed_count, 1);
    assert.equal(result.phases.flatMap(phase => phase.steps).length, 1);
    assert.doesNotMatch(JSON.stringify(result.fixture_preparation.steps.map(step => step.context)), /__adcp_fixture_/);
    assert.deepEqual(
      result.fixture_preparation.steps.map(step => step.error),
      state.phase.steps.map(step => step.error)
    );
  });

  test('standalone denial retains failed producer evidence only in the private sink', async () => {
    const { state } = await prepareFailing('schema');
    const io = transport([SELECTED]);
    let audited;
    await assert.rejects(
      runStoryboardStep(ENDPOINT, board(), 'create', {
        ...io.options,
        prepared_fixtures: state,
        prepared_fixtures_authorizer: () => ({ authorized: false, detail: 'denied' }),
        prepared_fixtures_audit_sink: record => {
          audited = record;
        },
      }),
      error => {
        assert.ok(error instanceof PreparedFixturesDeniedError);
        assert.doesNotMatch(JSON.stringify(error), /malformed|authored-product/);
        return error.refusalCode === 'authorizer_denied';
      }
    );
    assert.deepEqual(audited.fixture_resolutions, state.resolutions);
    assert.deepEqual(audited.fixture_preparation, state.phase);
    assert.deepEqual(io.wire, []);
  });

  test('a denied caller still gets only the typed denial, with the record to the sink', async () => {
    const { state } = await prepareFailing('schema');
    const io = transport([SELECTED]);
    let audited;
    await assert.rejects(
      () =>
        runStoryboard(ENDPOINT, board(), {
          ...io.options,
          prepared_fixtures: state,
          prepared_fixtures_audit_sink: record => {
            audited = record;
          },
          prepared_fixtures_authorizer: () => ({ authorized: false, detail: 'denied' }),
        }),
      error => error instanceof PreparedFixturesDeniedError && error.refusalCode === 'authorizer_denied'
    );
    // A failed preparation does not downgrade the denial: the caller gets
    // no producer records, and the host's copy is complete.
    assert.ok(audited, 'the sink received the record');
    assert.deepEqual(audited.fixture_resolutions, state.resolutions);
    assert.deepEqual(audited.fixture_preparation, state.phase);
    assert.deepEqual(io.wire, []);
  });
});

describe('initial preparation is authorized before any seller contact', () => {
  /** Prepare with a supplied authorizer, capturing lookups and audit records. */
  async function prepareWith(decide, extra = {}) {
    const io = transport([SELECTED]);
    const lookups = [];
    const audited = [];
    let state;
    let denial;
    try {
      state = await prepareStoryboardFixtures(ENDPOINT, board(), {
        ...io.options,
        ...extra,
        prepared_fixtures_audit_sink: record => audited.push(record),
        prepared_fixtures_preparation_authorizer: lookup => {
          lookups.push(lookup);
          return decide(lookup, io);
        },
      });
    } catch (error) {
      if (!(error instanceof PreparedFixturesDeniedError)) throw error;
      denial = error;
    }
    return { io, lookups, audited, state, denial };
  }

  test('an allowing authorizer is asked exactly once, before the first byte, and preparation proceeds', async () => {
    const { io, lookups, state, denial } = await prepareWith((_lookup, currentIo) => {
      assert.deepEqual(currentIo.wire, [], 'authorization precedes even initialization');
      return { authorized: true };
    });
    assert.equal(denial, undefined);
    assert.equal(state.disposition.status, 'resolved', JSON.stringify(state?.disposition));
    // Exactly one lookup for the whole preparation, and it is the prepare
    // gate — not a run, pass or step gate borrowed to stand in for it.
    assert.equal(lookups.length, 1, JSON.stringify(lookups.map(l => l.gate)));
    assert.equal(lookups[0].gate, 'prepare');
    // Real preparation happened after the grant.
    assert.ok(io.wire.includes('initialize'));
    assert.ok(io.calls.some(call => call.task === 'get_products'));
  });

  test('the prepare lookup carries a truthful current binding and no stored one', async () => {
    const { lookups, state } = await prepareWith(() => ({ authorized: true }));
    const lookup = lookups[0];
    // No preparation has happened, so there is no recorded binding. The
    // field is absent rather than a copy of `current` pretending to match.
    assert.equal('binding' in lookup, false, JSON.stringify(Object.keys(lookup)));
    assert.ok(lookup.current, 'the observed binding is real');
    // SDK-owned identity the host can refuse on, none of it seller-derived.
    assert.equal(lookup.current.storyboard_id, 'prepared_fixtures/selection');
    assert.ok(lookup.current.storyboard_digest);
    assert.deepEqual(lookup.current.agent_urls, [ENDPOINT]);
    assert.ok(lookup.current.schema_artifact);
    assert.ok(lookup.current.credential_fingerprint);
    assert.equal(lookup.current.contract_version, PREPARED_FIXTURES_CONTRACT_VERSION);
    assert.deepEqual(lookup.current, state.binding);
  });

  test('the binding reflects the effective route, credential and account before contact', async () => {
    const account = { brand: { domain: 'acmeoutdoor.example' }, operator: 'pinnacle-agency.example' };
    const { lookups } = await prepareWith(() => ({ authorized: true }), {
      context: { account, brand: { domain: 'acmeoutdoor.example' } },
      auth: { type: 'bearer', token: 'prepare-bearer' },
    });
    const current = lookups[0].current;
    assert.match(current.account_scope, /pinnacle-agency\.example/);
    assert.match(current.brand_scope, /acmeoutdoor\.example/);
    // The credential is folded in as a per-process fingerprint, never the
    // token itself.
    assert.ok(current.credential_fingerprint);
    assert.equal(JSON.stringify(lookups[0]).includes('prepare-bearer'), false);
  });

  for (const [label, decide] of [
    ['denied', () => ({ authorized: false, detail: 'no grant' })],
    ['missing decision', () => undefined],
    ['malformed decision', () => ({ authorized: 'true' })],
    ['numeric decision', () => ({ authorized: 1 })],
    [
      'throwing',
      () => {
        throw new Error('host grant store down: pg://10.0.0.9/grants');
      },
    ],
    ['rejecting', () => Promise.reject(new Error('host grant store unreachable'))],
  ]) {
    test(`${label}: preparation is refused with zero seller contact`, async () => {
      const { io, lookups, audited, state, denial } = await prepareWith(decide);
      assert.equal(state, undefined, 'no prepared state is produced');
      assert.ok(denial instanceof PreparedFixturesDeniedError, String(denial));
      assert.equal(denial.code, 'PREPARED_FIXTURES_DENIED');
      assert.equal(denial.refusalCode, 'authorizer_denied');
      assert.equal(lookups.length, 1, 'still asked exactly once');
      // Zero bytes: not even transport initialization or tool discovery.
      assert.deepEqual(io.wire, []);
      assert.deepEqual(io.calls, []);
      // The host's own error text never reaches the refused caller.
      assert.equal(`${denial.message} ${JSON.stringify(denial.details)}`.includes('10.0.0.9'), false);
      // Canonical refused audit evidence, in the same shape every other
      // gate produces.
      assert.equal(audited.length, 1, 'the audit sink received the record');
      const check = audited[0].phases
        .flatMap(phase => phase.steps)
        .flatMap(step => step.validations)
        .find(v => v.check === 'prepared_fixtures_authorization');
      assert.ok(check, JSON.stringify(audited[0].phases));
      assert.equal(check.actual, 'authorizer_denied');
      assert.equal(check.request, null);
      assert.equal(check.response, null);
      assert.equal(check.schema_id, null);
      assert.equal(check.schema_url, null);
    });
  }

  test('caller metadata is screened first, and a bad body never reaches the authorizer', async () => {
    const io = transport([SELECTED]);
    const lookups = [];
    // Preparation screens the caller body BEFORE asking the host, so a
    // reserved key is never shown to an authorizer. Note the disposition
    // asymmetry this exposes, which is deliberate and documented: a
    // refused caller BODY is still returned as a failed preparation here,
    // while `runStoryboard` / `runStoryboardStep` deny it. Only the
    // authorization decision throws.
    const state = await prepareStoryboardFixtures(ENDPOINT, board(), {
      ...io.options,
      context: { __adcp_fixture_product_id: 'forged' },
      prepared_fixtures_preparation_authorizer: lookup => {
        lookups.push(lookup);
        return { authorized: true };
      },
    });
    assert.equal(state.disposition.status, 'failed');
    assert.match(state.disposition.detail, /reserved or prototype-sensitive key/);
    assert.deepEqual(lookups, [], 'a refused caller body is not shown to the host authorizer');
    assert.deepEqual(io.wire, [], 'and nothing reaches the seller');
  });

  test('preparation without an authorizer is unchanged', async () => {
    // Requiring one would refuse every preparation that exists today.
    const io = transport([SELECTED]);
    const state = await prepareStoryboardFixtures(ENDPOINT, board(), io.options);
    assert.equal(state.disposition.status, 'resolved');
    assert.ok(io.calls.some(call => call.task === 'get_products'));
  });

  test('the existing reuse-only authorizer is never called by preparation', async () => {
    const io = transport([SELECTED]);
    let calls = 0;
    const state = await prepareStoryboardFixtures(ENDPOINT, board(), {
      ...io.options,
      prepared_fixtures_authorizer: lookup => {
        calls++;
        assert.ok(lookup.binding.storyboard_digest);
        return { authorized: false, detail: 'reuse refused' };
      },
    });
    assert.equal(calls, 0);
    assert.equal(state.disposition.status, 'resolved');
  });

  test('when both hooks are supplied, only the preparation hook decides preparation', async () => {
    let reuseCalls = 0;
    const result = await prepareWith(() => ({ authorized: false, detail: 'private prepare detail' }), {
      prepared_fixtures_authorizer: () => {
        reuseCalls++;
        return { authorized: true };
      },
    });
    assert.equal(result.lookups.length, 1);
    assert.equal(reuseCalls, 0);
    assert.equal(result.denial.refusalCode, 'authorizer_denied');
    assert.doesNotMatch(result.denial.message, /private prepare detail/);
    assert.deepEqual(result.io.wire, []);
    const checks = result.audited[0].phases.flatMap(p => p.steps).flatMap(s => s.validations);
    assert.match(checks[0].description, /Fresh fixture preparation/);
  });

  test('routed authorization observes the scope later recorded in prepared state', async () => {
    const io = transport([SELECTED]);
    const lookups = [];
    const state = await prepareStoryboardFixtures('', board(), {
      ...io.options,
      agents: { seller: { url: ENDPOINT, auth: { type: 'bearer', token: 'route-credential' } } },
      auth: { type: 'bearer', token: 'default-credential' },
      prepared_fixtures_preparation_authorizer: lookup => {
        assert.deepEqual(io.wire, []);
        lookups.push(lookup);
        return { authorized: true };
      },
    });
    assert.equal(lookups.length, 1);
    assert.equal(state.disposition.status, 'resolved', JSON.stringify(state.disposition));
    assert.deepEqual(lookups[0].current, state.binding);
    assert.doesNotMatch(JSON.stringify(lookups), /route-credential|default-credential/);
  });

  test('changing identity during authorization refuses before contact', async () => {
    const account = { brand: { domain: 'test.example' }, operator: 'original.example' };
    const result = await prepareWith(
      () => {
        account.operator = 'changed.example';
        return { authorized: true };
      },
      { context: { account } }
    );
    assert.equal(result.denial?.refusalCode, 'binding_mismatch');
    assert.equal(result.state, undefined);
    assert.deepEqual(result.io.wire, []);
    assert.equal(result.audited.length, 1);
  });

  test('changing identity during discovery cannot mint a differently authorized state', async () => {
    const io = transport([SELECTED], {
      read: () => {
        account.operator = 'changed.example';
        return { status: 'completed', products: [SELECTED], cache_scope: 'account', wholesale_feed_version: 'v1' };
      },
    });
    const account = { brand: { domain: 'test.example' }, operator: 'original.example' };
    const audited = [];
    await assert.rejects(
      prepareStoryboardFixtures(ENDPOINT, board(), {
        ...io.options,
        context: { account },
        prepared_fixtures_preparation_authorizer: () => ({ authorized: true }),
        prepared_fixtures_audit_sink: record => audited.push(record),
      }),
      error => error instanceof PreparedFixturesDeniedError && error.refusalCode === 'binding_mismatch'
    );
    assert.equal(audited.length, 1);
    assert.ok(audited[0].fixture_resolutions.length);
    assert.ok(audited[0].phases.some(p => p.steps.some(s => s.task === 'get_products')));
  });

  test('scope drift during capability discovery refuses before catalog or controller contact', async () => {
    const account = { brand: { domain: 'test.example' }, operator: 'original.example' };
    const io = transport([SELECTED], {
      capabilities: () => {
        account.operator = 'changed.example';
        return CAPS;
      },
    });
    const { profile, ...options } = io.options;
    await assert.rejects(
      prepareStoryboardFixtures(ENDPOINT, board(), {
        ...options,
        context: { account },
        prepared_fixtures_preparation_authorizer: () => ({ authorized: true }),
      }),
      error => error instanceof PreparedFixturesDeniedError && error.refusalCode === 'binding_mismatch'
    );
    assert.ok(io.calls.some(call => call.task === 'get_adcp_capabilities'));
    assert.equal(
      io.calls.some(call => call.task === 'get_products' || call.task === 'comply_test_controller'),
      false
    );
  });

  test('later catalog pages keep the authorized account when caller inputs change during a request', async () => {
    const account = { brand: { domain: 'test.example' }, operator: 'original.example' };
    let pages = 0;
    const io = transport([], {
      read: () => {
        pages++;
        account.operator = 'changed.example';
        return {
          status: 'completed',
          products: pages === 1 ? [] : [SELECTED],
          cache_scope: 'account',
          wholesale_feed_version: 'v1',
          ...(pages === 1 && { pagination: { has_more: true, cursor: 'second' } }),
        };
      },
    });
    await assert.rejects(
      prepareStoryboardFixtures(ENDPOINT, board(), {
        ...io.options,
        context: { account },
        prepared_fixtures_preparation_authorizer: () => ({ authorized: true }),
      }),
      error => error instanceof PreparedFixturesDeniedError && error.refusalCode === 'binding_mismatch'
    );
    const reads = io.calls.filter(call => call.task === 'get_products');
    assert.equal(reads.length, 2);
    assert.deepEqual(
      reads.map(call => call.request.account.operator),
      ['original.example', 'original.example']
    );
  });

  test('later catalog pages keep the authorized brand when no context account is supplied', async () => {
    const brand = { domain: 'original.example' };
    let pages = 0;
    const io = transport([], {
      read: () => {
        pages++;
        brand.domain = 'changed.example';
        return {
          status: 'completed',
          products: pages === 1 ? [] : [SELECTED],
          cache_scope: 'account',
          wholesale_feed_version: 'v1',
          ...(pages === 1 && { pagination: { has_more: true, cursor: 'second' } }),
        };
      },
    });
    await assert.rejects(
      prepareStoryboardFixtures(ENDPOINT, board(), {
        ...io.options,
        brand,
        prepared_fixtures_preparation_authorizer: () => ({ authorized: true }),
      }),
      error => error instanceof PreparedFixturesDeniedError && error.refusalCode === 'binding_mismatch'
    );
    const reads = io.calls.filter(call => call.task === 'get_products');
    assert.equal(reads.length, 2);
    assert.deepEqual(
      reads.map(call => call.request.brand.domain),
      ['original.example', 'original.example']
    );
    assert.deepEqual(
      reads.map(call => call.request.account.brand.domain),
      ['original.example', 'original.example']
    );
  });

  test('a preparation grant never bypasses the required reuse authorizer', async () => {
    const { state } = await prepareWith(() => ({ authorized: true }));
    const io = transport([SELECTED]);
    await assert.rejects(
      runStoryboard(ENDPOINT, board(), { ...io.options, prepared_fixtures: state }),
      error => error instanceof PreparedFixturesDeniedError && error.refusalCode === 'authorizer_required'
    );
    assert.deepEqual(io.wire, []);
  });

  test('preparation refuses prepared state before asking the preparation hook', async () => {
    const { state } = await prepareWith(() => ({ authorized: true }));
    const io = transport([SELECTED]);
    let calls = 0;
    const refused = await prepareStoryboardFixtures(ENDPOINT, board(), {
      ...io.options,
      prepared_fixtures: state,
      prepared_fixtures_preparation_authorizer: () => {
        calls++;
        return { authorized: true };
      },
    });
    assert.equal(refused.disposition.status, 'failed');
    assert.equal(calls, 0);
    assert.deepEqual(io.wire, []);
  });

  for (const entry of ['run', 'step', 'comply']) {
    test(`${entry} refuses a preparation-only hook with zero seller contact`, async () => {
      const io = transport([SELECTED]);
      let calls = 0;
      const opts = {
        ...io.options,
        prepared_fixtures_preparation_authorizer: () => {
          calls++;
          return { authorized: true };
        },
      };
      const { comply } = require('../../dist/lib/testing/index.js');
      const call =
        entry === 'run'
          ? runStoryboard(ENDPOINT, board(), opts)
          : entry === 'step'
            ? runStoryboardStep(ENDPOINT, board(), 'create', opts)
            : comply(ENDPOINT, opts);
      await assert.rejects(call, /supported only by prepareStoryboardFixtures/);
      assert.equal(calls, 0);
      assert.deepEqual(io.wire, []);
    });
  }

  test('the prepare gate does not consume the reuse gates', async () => {
    // Preparation asks once; the run that reuses the state still makes its
    // own run, pass and step lookups.
    const prep = await prepareWith(() => ({ authorized: true }));
    assert.equal(prep.lookups.length, 1);
    const io = transport([SELECTED]);
    const reuse = [];
    const result = await runStoryboard(ENDPOINT, board(), {
      ...io.options,
      ...withPreparedFixtures(prep.state, lookup => {
        reuse.push(lookup.gate);
        return { authorized: true };
      }),
    });
    assert.equal(result.overall_passed, true, JSON.stringify(result));
    assert.deepEqual(reuse, ['run', 'pass', 'step']);
    // And every reuse lookup still carries the stored binding.
    assert.equal(reuse.length, 3, 'the prepare gate is additional to the reuse gates, not a replacement for one');
  });
});

describe('a capture the funnel refuses to detach', () => {
  /** A storyboard whose product fixture snapshots the whole pinned entity. */
  function snapshotBoard() {
    const b = board();
    b.fixture_resolution.products[0].context_outputs = [
      { key: '__adcp_fixture_product_id', path: 'product_id' },
      { key: '__adcp_fixture_entity', snapshot: 'selected_entity' },
    ];
    delete b.fixture_resolution.pricing_options;
    delete b.fixtures.pricing_options;
    b.phases[0].steps[0].sample_request = {
      brand: { domain: 'acmeoutdoor.example' },
      start_time: 'asap',
      end_time: '2099-06-30T23:59:59Z',
      currency: 'EUR',
      packages: [{ product_id: '$context.__adcp_fixture_product_id', budget: 5000 }],
    };
    return b;
  }

  /** Over the capture byte budget, so the snapshot cannot be detached. */
  const OVERSIZED = product('a-selected', {
    collection_targeting_allowed: true,
    description: 'x'.repeat(600 * 1024),
  });

  test('grades as a setup failure on the seed step, with a machine-readable check', async () => {
    const io = transport([OVERSIZED]);
    const result = await runStoryboard(ENDPOINT, snapshotBoard(), io.options);
    assert.equal(result.overall_passed, false);
    const unbuildable = result.phases
      .flatMap(phase => phase.steps)
      .filter(step => step.validations.some(v => v.check === 'fixture_capture_unbuildable'));
    assert.equal(unbuildable.length, 1, JSON.stringify(result.phases.map(p => p.steps.map(s => s.step_id))));
    assert.equal(unbuildable[0].validations[0].passed, false);
    // The task names where the pinned entity actually came from, so an
    // implementor reading the report looks at the right response. A
    // controller-seeded graph would say `comply_test_controller` here.
    assert.equal(unbuildable[0].task, 'get_products');
    assert.match(unbuildable[0].error, /capture limit/);
    // A refused commit publishes nothing — not even the siblings that fit.
    assert.equal(
      Object.keys(result.context).some(key => key.startsWith('__adcp_fixture_')),
      false
    );
    // And the step that depended on the capture is not silently executed
    // against an unresolved token — it is skipped as a prerequisite failure.
    const create = result.phases.flatMap(phase => phase.steps).find(step => step.step_id === 'create');
    assert.equal(create.skipped, true, JSON.stringify(create));
    assert.equal(create.skip_reason, 'controller_seeding_failed');
    assert.equal(
      io.calls.some(call => call.task === 'create_media_buy'),
      false,
      'an unpublished capture must not reach the seller as an unresolved token'
    );
  });

  test('multi-pass reports the one preparation failure once, not once per pass', async () => {
    const replicas = [ENDPOINT, ENDPOINT];
    const io = transport([OVERSIZED]);
    const result = await runStoryboard(replicas, snapshotBoard(), {
      ...io.options,
      multi_instance_strategy: 'multi-pass',
    });
    assert.equal(result.overall_passed, false);
    const unbuildable = (result.passes ?? []).flatMap(pass =>
      pass.phases.flatMap(phase =>
        phase.steps.filter(step => step.validations.some(v => v.check === 'fixture_capture_unbuildable'))
      )
    );
    assert.equal(unbuildable.length, 1, 'seeding is shared across passes; its failure is one result');
  });
});

// ────────────────────────────────────────────────────────────
// Hostile and malformed authorizer decisions
// ────────────────────────────────────────────────────────────

describe('authorizer callback robustness', () => {
  /** Every shape that is not literally `{ authorized: true }`. */
  const NOT_AUTHORIZED = [
    ['undefined', () => undefined],
    ['null', () => null],
    ['an empty object', () => ({})],
    ['a truthy string', () => ({ authorized: 'yes' })],
    ['a truthy number', () => ({ authorized: 1 })],
    [
      'a getter that throws',
      () =>
        Object.defineProperty({}, 'authorized', {
          get: () => {
            throw new Error('boom');
          },
        }),
    ],
    ['a rejected promise', () => Promise.reject(new Error('grant store down'))],
    [
      'a synchronous throw',
      () => {
        throw new Error('grant store down');
      },
    ],
  ];

  for (const [label, authorizer] of NOT_AUTHORIZED) {
    test(`direct reuse fails closed when the authorizer returns ${label}`, async () => {
      const { state } = await prepare();
      const io = transport([SELECTED]);
      const { denial, record: result } = await runWithAudit(sink =>
        runStoryboardStep(ENDPOINT, board(), 'create', {
          ...io.options,
          prepared_fixtures: state,
          prepared_fixtures_audit_sink: sink,
          prepared_fixtures_authorizer: authorizer,
        })
      );
      assert.equal(result.passed, false, JSON.stringify(result));
      assert.equal(result.validations[0].check, 'prepared_fixtures_authorization');
      assert.equal(result.validations[0].actual, 'authorizer_denied');
      assert.deepEqual(io.wire, [], 'a malformed decision must not be read as consent');
      assert.equal(
        Object.keys(result.context).some(key => key.startsWith('__adcp_fixture_')),
        false
      );
    });
  }

  test('a throwing authorizer does not leak the host error text', async () => {
    const { state } = await prepare();
    const io = transport([SELECTED]);
    const { denial, record: result } = await runWithAudit(sink =>
      runStoryboardStep(ENDPOINT, board(), 'create', {
        ...io.options,
        prepared_fixtures: state,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: () => {
          throw new Error(`grants db: ${synthetic('postgres', 'ops', 'C')}@10.0.0.4/grants`);
        },
      })
    );
    assert.equal(result.passed, false);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(SYNTHETIC_USERINFO.C), false);
    assert.equal(serialized.includes('10.0.0.4'), false);
  });

  test('the authorizer cannot mutate the state through its lookup payload', async () => {
    const { state } = await prepare();
    const io = transport([SELECTED]);
    const { denial, record: result } = await runWithAudit(sink =>
      runStoryboardStep(ENDPOINT, board(), 'create', {
        ...io.options,
        prepared_fixtures: state,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: lookup => {
          // Both payloads are detached clones, so widening them here must not
          // widen the binding the diff is about to run against.
          lookup.binding.agent_urls.push('https://attacker.example/mcp');
          lookup.binding.sandbox = !lookup.binding.sandbox;
          lookup.current.account_scope = 'forged';
          return { authorized: true };
        },
      })
    );
    assert.equal(result.passed, true, JSON.stringify(result));
    assert.deepEqual(state.binding.agent_urls, [ENDPOINT]);
  });

  test('the two lookup payloads are separate objects on the refusal path too', async () => {
    // A host that could observe `binding === current` would learn the
    // reference did not resolve — the oracle the uniform refusal closes.
    const { state } = await prepare();
    const identities = [];
    for (const resolve of [() => undefined, () => state]) {
      const io = transport([SELECTED]);
      const { denial, record: _ignored8 } = await runWithAudit(sink =>
        runStoryboardStep(ENDPOINT, board(), 'create', {
          ...io.options,
          prepared_fixtures: { ref: 'probe', resolve },
          prepared_fixtures_audit_sink: sink,
          prepared_fixtures_authorizer: lookup => {
            identities.push(lookup.binding === lookup.current);
            return { authorized: false };
          },
        })
      );
    }
    assert.deepEqual(identities, [false, false]);
  });
});

// ────────────────────────────────────────────────────────────
// Fingerprint exposure surface
// ────────────────────────────────────────────────────────────

describe('credential fingerprint exposure', () => {
  // Load-bearing for the CodeQL `js/insufficient-password-hash` disposition:
  // the keyed tag's threat model rests on it never leaving the process in a
  // durable artifact, so a report that carried it would change the analysis.
  test('never reaches a run result, a step result or any report surface', async () => {
    const { state } = await prepare({ auth: { type: 'bearer', token: 'run-token' } });
    const print = state.binding.credential_fingerprint;
    assert.match(print, /^[0-9a-f]{32}$/);

    const io = transport([SELECTED]);
    const { denial, record: run } = await runWithAudit(sink =>
      runStoryboard(ENDPOINT, board(), {
        ...io.options,
        auth: { type: 'bearer', token: 'run-token' },
        prepared_fixtures: state,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: ALLOW,
      })
    );
    assert.equal(run.overall_passed, true, JSON.stringify(run.phases));
    const serializedRun = JSON.stringify(run);
    assert.equal(serializedRun.includes(print), false, 'the fingerprint must not reach the run result');
    assert.equal(serializedRun.includes('run-token'), false, 'nor the credential it was derived from');

    const stepIo = transport([SELECTED]);
    const { denial: denial2, record: step } = await runWithAudit(sink =>
      runStoryboardStep(ENDPOINT, board(), 'create', {
        ...stepIo.options,
        auth: { type: 'bearer', token: 'run-token' },
        prepared_fixtures: state,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: ALLOW,
      })
    );
    const serializedStep = JSON.stringify(step);
    assert.equal(serializedStep.includes(print), false);
    assert.equal(serializedStep.includes('run-token'), false);
  });

  test('a different process key would produce a different tag for the same credential', async () => {
    // The tag is keyed, not a bare digest: the same credential text under a
    // different per-process key must not compare equal. Asserting the key is
    // actually mixed in is what distinguishes this from an unsalted hash.
    const { fingerprintCredential } = require('../../dist/lib/testing/storyboard/prepared-fixtures.js');
    const tag = fingerprintCredential(`bearer:${SYNTHETIC_USERINFO.C}`);
    assert.match(tag, /^[0-9a-f]{32}$/);
    // Same input, same process → stable.
    assert.equal(fingerprintCredential(`bearer:${SYNTHETIC_USERINFO.C}`), tag);
    // A bare SHA-256 of the same text would be a rainbow-table target; the
    // keyed tag must not equal it.
    const bare = require('node:crypto')
      .createHash('sha256')
      .update(`bearer:${SYNTHETIC_USERINFO.C}`)
      .digest('hex')
      .slice(0, 32);
    assert.notEqual(tag, bare);
    const bareHmacNoKey = require('node:crypto')
      .createHmac('sha256', '')
      .update(`bearer:${SYNTHETIC_USERINFO.C}`)
      .digest('hex')
      .slice(0, 32);
    assert.notEqual(tag, bareHmacNoKey);
  });
});

// ────────────────────────────────────────────────────────────
// Effective request identity
// ────────────────────────────────────────────────────────────

describe('effective request account', () => {
  /** A step whose own request authors an account that wins over the context. */
  function overrideBoard(account) {
    const b = board();
    b.phases[0].steps[0].sample_request.account = account;
    return b;
  }

  const CONTEXT_ACCOUNT = { brand: { domain: 'acmeoutdoor.example' }, operator: 'pinnacle-agency.example' };

  test('an authored step account is reported to the authorizer, not just the context one', async () => {
    // `resolveMediaBuyAccount` lets an authored `account_id`/`operator` win,
    // so `account_scope` alone would tell the authorizer an account the
    // request never uses.
    const override = { account_id: 'acct-step-override' };
    const prepIo = transport([SELECTED]);
    const state = await prepareStoryboardFixtures(ENDPOINT, overrideBoard(override), {
      ...prepIo.options,
      context: { account: CONTEXT_ACCOUNT },
    });
    const io = transport([SELECTED]);
    const seen = [];
    const { denial, record: result } = await runWithAudit(sink =>
      runStoryboardStep(ENDPOINT, overrideBoard(override), 'create', {
        ...io.options,
        context: { account: CONTEXT_ACCOUNT },
        prepared_fixtures: state,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: lookup => {
          seen.push(lookup.current);
          return { authorized: true };
        },
      })
    );
    assert.equal(result.passed, true, JSON.stringify(result));
    const current = seen.at(-1);
    assert.match(current.request_account_scope, /acct-step-override/);
    assert.match(current.account_scope, /pinnacle-agency\.example/);
    assert.notEqual(current.request_account_scope, current.account_scope);
    // And the seller really did receive the authored account.
    const create = io.calls.find(call => call.task === 'create_media_buy');
    assert.equal(create.request.account.account_id, 'acct-step-override');
  });

  test('the field carries the effective account even when the step authors no override', async () => {
    const { state } = await prepare({ context: { account: CONTEXT_ACCOUNT } });
    const io = transport([SELECTED]);
    const seen = [];
    const { denial, record: _ignored9 } = await runWithAudit(sink =>
      runStoryboardStep(ENDPOINT, board(), 'create', {
        ...io.options,
        context: { account: CONTEXT_ACCOUNT },
        prepared_fixtures: state,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: lookup => {
          seen.push(lookup.current);
          return { authorized: true };
        },
      })
    );
    // Not presence-vs-absence: the host is shown the account the request
    // ACTUALLY transacts under, every time. Tying the assertion to the
    // wire is what makes it meaningful — an echo of `account_scope` that
    // diverged from the dispatched account would fail here, where a mere
    // `undefined` check could not tell the two apart.
    const create = io.calls.find(call => call.task === 'create_media_buy');
    assert.ok(create, 'the step dispatched');
    assert.deepEqual(JSON.parse(seen.at(-1).request_account_scope), create.request.account);
  });

  test('an authored step account cannot be swapped without refusing reuse', async () => {
    // Defence in depth behind the digest: the authored account lives in the
    // storyboard body, so changing it changes `storyboard_digest`.
    const prepIo = transport([SELECTED]);
    const state = await prepareStoryboardFixtures(ENDPOINT, overrideBoard({ account_id: 'acct-a' }), prepIo.options);
    const io = transport([SELECTED]);
    const { denial, record: result } = await runWithAudit(sink =>
      runStoryboardStep(ENDPOINT, overrideBoard({ account_id: 'acct-b' }), 'create', {
        ...io.options,
        prepared_fixtures: state,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: ALLOW,
      })
    );
    assert.equal(result.passed, false, JSON.stringify(result));
    assert.match(result.error, /storyboard_digest/);
    assert.deepEqual(io.wire, []);
  });

  test('request_account_scope is not diffed, so a legitimate step still reuses', async () => {
    // Preparation has no step, so a diffed per-step field would refuse every
    // step that sets one.
    const override = { brand: { domain: 'acmeoutdoor.example' }, operator: 'other-agency.example' };
    const prepIo = transport([SELECTED]);
    const state = await prepareStoryboardFixtures(ENDPOINT, overrideBoard(override), prepIo.options);
    assert.equal(state.binding.request_account_scope, undefined, 'preparation binds no step');
    const io = transport([SELECTED]);
    const { denial, record: result } = await runWithAudit(sink =>
      runStoryboardStep(ENDPOINT, overrideBoard(override), 'create', {
        ...io.options,
        prepared_fixtures: state,
        prepared_fixtures_audit_sink: sink,
        prepared_fixtures_authorizer: ALLOW,
      })
    );
    assert.equal(result.passed, true, JSON.stringify(result));
  });
});
