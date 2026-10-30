const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.NODE_ENV = 'test';

const {
  InMemoryStateStore,
  createPersistentNotificationRuntime,
  createPrincipalLifecycle,
  createPrincipalStateStore,
  expandReportingSubscriptionPathTemplate,
  principalNotificationSubscriptionStore,
} = require('../../dist/lib/server/index.js');
const { validateRequest, validateResponse } = require('../../dist/lib/validation/schema-validator.js');
const { principalOptionOffTranscript } = require('../helpers/principal-option-off-transcript.js');

const SCOPE = { tenantId: 't', principalId: 'p' };
// Served at the release the SDK pins, so every response is valid against its schemas.
const CTX = {
  callerMutationScope: { tenant_id: 't', principal_id: 'p', principal_kind: 'buyer_agent' },
  servedAdcpVersion: '3.3.0-beta.1',
};
const CTX_UNPINNED = { callerMutationScope: CTX.callerMutationScope };

function assertSchemaValid(toolName, response) {
  const outcome = validateResponse(toolName, response, '3.3.0-beta.1');
  assert.equal(outcome.valid, true, JSON.stringify(outcome.issues));
}

function setup({ support = {}, clock } = {}) {
  const store = createPrincipalStateStore({ store: new InMemoryStateStore() });
  const emitted = [];
  const notifications = createPersistentNotificationRuntime({
    store: principalNotificationSubscriptionStore(store),
    proofAdapter: { prove: async () => ({ proved: true }) },
    validateDestination: async () => ({ allowed: true }),
    authorizeDelivery: async () => ({ authorized: true }),
    checkpointDeliveryAttempt: async () => {},
    createEmitter: () => ({
      forTenantScope() {
        return this;
      },
      async emit(params) {
        emitted.push(params);
        return {
          delivery_id: params.delivery_id,
          idempotency_key: params.delivery_id,
          attempts: 1,
          delivered: true,
          terminal: true,
          errors: [],
        };
      },
      async emitRecovered(params) {
        return this.emit(params);
      },
    }),
  });
  let version = 0;
  let ref = 0;
  const time = clock ?? { now: new Date('2026-11-01T12:00:00.000Z') };
  const replacements = [];
  const lifecycle = createPrincipalLifecycle({
    store,
    notifications,
    agentUrl: 'https://seller.example/mcp',
    resolvePrincipal: ctx => ctx.callerMutationScope,
    issuePrincipalId: scope => `record-${scope.tenantId}-${scope.principalId}`,
    issueConfigurationVersion: () => `cfg-${++version}`,
    issueDestinationRef: () => `dest-ref-${++ref}`,
    now: () => time.now,
    prepareReportingDestination: ({ destination }) => ({
      state: 'validating',
      configuration: structuredClone(destination),
    }),
    reportingSubscriptions: {
      listDeliveryConfigIds: () => ['acme-pacing'],
      replaceAccountConfigs: input => {
        replacements.push(input);
      },
      ...support,
    },
  });
  return { lifecycle, store, notifications, emitted, time, replacements };
}

function destination(id = 'archive', extra = {}) {
  return {
    pattern: 'file_transfer',
    destination_id: id,
    active: true,
    provider: { domain: 'storage.example' },
    transport: 's3',
    location: `s3://bucket/${id}`,
    accepted_formats: ['jsonl'],
    accepted_verification_profiles: ['manifest_checksums'],
    ...extra,
  };
}

function subscription(extra = {}) {
  return {
    subscription_id: 'analytics-daily',
    subscription_version: 1,
    active: true,
    scope: { all_authorized_accounts: true },
    selector: {
      feed_purpose: 'analytics',
      period_duration: 'P1D',
      required_finality: 'official',
      dimensions: ['package', 'creative'],
    },
    reconciliation_mode: 'delivery_only',
    destination: { destination_id: 'archive', path_template: 'analytics/{account_id}/{period_start}' },
    ...extra,
  };
}

let keyCounter = 0;
function sync(lifecycle, configuration, extra = {}) {
  keyCounter += 1;
  return lifecycle.protocol.syncPrincipal(
    { idempotency_key: `idem-key-${String(keyCounter).padStart(6, '0')}`, configuration, ...extra },
    CTX
  );
}

function errorOf(response) {
  assert.equal(response.result.kind, 'failed', JSON.stringify(response));
  return response.result.errors[0];
}

describe('sync_principal reporting_subscriptions (option off)', () => {
  test('is byte-for-byte unchanged from the runtime before subscriptions existed', async () => {
    const golden = require(
      path.join(__dirname, '..', 'fixtures', 'reporting-subscriptions', 'principal-option-off-golden.json')
    );
    assert.deepEqual(JSON.parse(JSON.stringify(await principalOptionOffTranscript())), golden);
  });
});

describe('sync_principal reporting_subscriptions (option on)', () => {
  test('accepts, versions and reads back a subscription', async () => {
    const { lifecycle, time } = setup();
    const created = await sync(lifecycle, {
      reporting_destinations: [destination()],
      reporting_subscriptions: [subscription()],
    });
    assert.equal(created.result.kind, 'applied', JSON.stringify(created));
    assertSchemaValid('sync_principal', created);
    const [state] = created.result.configuration.reporting_subscriptions;
    assert.equal(state.subscription_id, 'analytics-daily');
    assert.equal(state.subscription_version, 1);
    assert.equal(state.state, 'active');
    assert.equal(state.accepted_at, '2026-11-01T12:00:00.000Z');
    assert.equal(state.destination_ref, created.result.configuration.reporting_destinations[0].destination_ref);
    assert.equal(state.prior_versions, undefined);

    // A resend changes nothing, including accepted_at.
    time.now = new Date('2026-11-02T00:00:00.000Z');
    const resent = await sync(lifecycle, {
      reporting_destinations: [destination()],
      reporting_subscriptions: [subscription()],
    });
    assert.equal(resent.result.action, 'unchanged');
    assert.equal(resent.result.configuration.reporting_subscriptions[0].accepted_at, '2026-11-01T12:00:00.000Z');

    // A semantic change without a new version is refused.
    const reused = await sync(lifecycle, {
      reporting_subscriptions: [subscription({ exclude_account_ids: ['acct_x'] })],
    });
    assert.equal(errorOf(reused).code, 'INVALID_REQUEST');
    assert.match(errorOf(reused).message, /reused with different content/);

    // A new version records the cutover and keeps the prior version readable.
    time.now = new Date('2026-11-04T12:00:00.000Z');
    const v2 = await sync(lifecycle, {
      reporting_subscriptions: [subscription({ subscription_version: 2, exclude_account_ids: ['acct_x'] })],
    });
    assertSchemaValid('sync_principal', v2);
    const next = v2.result.configuration.reporting_subscriptions[0];
    assert.equal(next.subscription_version, 2);
    assert.equal(next.accepted_at, '2026-11-04T12:00:00.000Z');
    assert.deepEqual(next.prior_versions, [
      { subscription_version: 1, accepted_at: '2026-11-01T12:00:00.000Z', superseded_at: '2026-11-04T12:00:00.000Z' },
    ]);

    // Versions cannot regress.
    const regress = await sync(lifecycle, { reporting_subscriptions: [subscription()] });
    assert.match(errorOf(regress).message, /cannot regress/);

    // History keeps the configuration the readback no longer carries.
    const { history } = await lifecycle.listReportingSubscriptions(SCOPE);
    assert.equal(history[0].versions.length, 2);
    assert.deepEqual(history[0].versions[0].configuration.exclude_account_ids, undefined);
    assert.deepEqual(history[0].versions[0].destinationMethod, { pattern: 'file_transfer', transport: 's3' });
    assert.deepEqual(await lifecycle.reportingSubscriptionIds(SCOPE), ['analytics-daily']);
  });

  test('deactivation, omission and reactivation are recorded as cutovers', async () => {
    const { lifecycle, time } = setup();
    await sync(lifecycle, { reporting_destinations: [destination()], reporting_subscriptions: [subscription()] });
    time.now = new Date('2026-11-04T12:00:00.000Z');
    const off = await sync(lifecycle, { reporting_subscriptions: [subscription({ active: false })] });
    assertSchemaValid('sync_principal', off);
    const state = off.result.configuration.reporting_subscriptions[0];
    assert.equal(state.state, 'inactive');
    assert.equal(state.deactivated_at, '2026-11-04T12:00:00.000Z');
    assert.equal(state.configuration.active, false);

    time.now = new Date('2026-11-06T12:00:00.000Z');
    const on = await sync(lifecycle, { reporting_subscriptions: [subscription()] });
    assert.equal(on.result.configuration.reporting_subscriptions[0].state, 'active');
    assert.equal(on.result.configuration.reporting_subscriptions[0].deactivated_at, undefined);
    const { history } = await lifecycle.listReportingSubscriptions(SCOPE);
    assert.deepEqual(history[0].inactiveIntervals, [
      { from: '2026-11-04T12:00:00.000Z', until: '2026-11-06T12:00:00.000Z' },
    ]);
    // The readback lists inactive_intervals (adcontextprotocol/adcp#8585) only to callers served
    // a release whose bundle defines it (3.3.0-beta.1's closed state schema does not), and never
    // to a response without a served release; the internal state carries it.
    const { states } = await lifecycle.listReportingSubscriptions(SCOPE);
    assert.deepEqual(states[0].inactive_intervals, [
      { deactivated_at: '2026-11-04T12:00:00.000Z', reactivated_at: '2026-11-06T12:00:00.000Z' },
    ]);
    assert.equal(on.result.configuration.reporting_subscriptions[0].inactive_intervals, undefined);
    const unpinned = await lifecycle.protocol.getPrincipal({}, CTX_UNPINNED);
    assert.equal(unpinned.result.configuration.reporting_subscriptions[0].inactive_intervals, undefined);

    time.now = new Date('2026-11-08T00:00:00.000Z');
    const omitted = await sync(lifecycle, { reporting_subscriptions: [] });
    const retained = omitted.result.configuration.reporting_subscriptions[0];
    assert.equal(retained.state, 'inactive', 'omission deactivates but keeps the subscription readable');
    assert.equal(retained.deactivated_at, '2026-11-08T00:00:00.000Z');
    assertSchemaValid('sync_principal', omitted);
    const closed = (await lifecycle.listReportingSubscriptions(SCOPE)).states;
    assert.deepEqual(closed[0].inactive_intervals, [
      { deactivated_at: '2026-11-04T12:00:00.000Z', reactivated_at: '2026-11-06T12:00:00.000Z' },
      { deactivated_at: '2026-11-08T00:00:00.000Z' },
    ]);
  });

  test('omission refuses to open a 65th inactive interval, as active: false does', async () => {
    const { lifecycle, time } = setup();
    await sync(lifecycle, { reporting_destinations: [destination()], reporting_subscriptions: [subscription()] });
    let at = Date.parse('2026-11-02T00:00:00.000Z');
    for (let index = 0; index < 64; index += 1) {
      time.now = new Date((at += 3_600_000));
      assert.equal(
        (await sync(lifecycle, { reporting_subscriptions: [subscription({ active: false })] })).result.kind,
        'applied'
      );
      time.now = new Date((at += 3_600_000));
      assert.equal((await sync(lifecycle, { reporting_subscriptions: [subscription()] })).result.kind, 'applied');
    }
    assert.equal((await lifecycle.listReportingSubscriptions(SCOPE)).history[0].inactiveIntervals.length, 64);
    time.now = new Date((at += 3_600_000));
    const explicit = errorOf(await sync(lifecycle, { reporting_subscriptions: [subscription({ active: false })] }));
    const omitted = errorOf(await sync(lifecycle, { reporting_subscriptions: [] }));
    assert.match(omitted.message, /64 inactive intervals/);
    assert.deepEqual(
      { code: omitted.code, message: omitted.message },
      { code: explicit.code, message: explicit.message },
      'the same error on both paths'
    );
    const [state] = (await lifecycle.listReportingSubscriptions(SCOPE)).states;
    assert.equal(state.state, 'active', 'nothing was written');
  });

  test('validates the cross-field rules of reporting-subscription.json', async () => {
    const { lifecycle } = setup();
    await sync(lifecycle, { reporting_destinations: [destination(), destination('shared')] });
    const cases = [
      [subscription({ scope: { all_authorized_accounts: true, account_ids: ['a'] } }), /exactly one/],
      [subscription({ scope: { account_ids: ['a'] }, exclude_account_ids: ['b'] }), /exclude_account_ids/],
      [
        subscription({
          scope: { account_ids: ['a', 'b'] },
          selector: { ...subscription().selector, period_timezone: 'America/New_York' },
        }),
        /period_timezone/,
      ],
      [
        subscription({
          selector: { ...subscription().selector, feed_purpose: 'billing', required_finality: 'snapshot' },
        }),
        /official/,
      ],
      [subscription({ selector: { ...subscription().selector, feed_purpose: 'billing' } }), /consumer_receipt/],
      [subscription({ reconciliation_mode: 'consumer_receipt', destination: undefined }), /requires a destination/],
      [
        subscription({ destination: { destination_id: 'missing', path_template: 'x/{account_id}' } }),
        /not in reporting_destinations/,
      ],
      [subscription({ destination: { destination_id: 'archive', path_template: 'analytics/all' } }), /\{account_id\}/],
      [subscription({ destination: { destination_id: 'archive' } }), /required for a file_transfer/],
      [
        subscription({ destination: { destination_id: 'archive', path_template: 'a/../{account_id}' } }),
        /relative path/,
      ],
      [
        subscription({ destination: { destination_id: 'archive', path_template: 'a/{buyer}/{account_id}' } }),
        /unknown placeholder/,
      ],
      [
        subscription({ destination: { destination_id: 'archive', path_template: 'a/{{account_id}}' } }),
        /unbalanced brace/,
      ],
      [
        subscription({ destination: { destination_id: 'archive', path_template: 'a/{account_id' } }),
        /unbalanced brace/,
      ],
      [
        subscription({ destination: { destination_id: 'archive', path_template: 'a/account_id}/{account_id}' } }),
        /unbalanced brace/,
      ],
      [subscription({ subscription_id: 'acme-pacing' }), /delivery_config_id/],
      [subscription({ subscription_id: '..' }), /subscription_id/],
    ];
    for (const [entry, pattern] of cases) {
      const response = await sync(lifecycle, { reporting_subscriptions: [JSON.parse(JSON.stringify(entry))] });
      const error = errorOf(response);
      assert.equal(error.code, 'INVALID_REQUEST', pattern.toString());
      assert.match(error.message, pattern);
    }
    // A single-account subscription may omit {account_id} and set period_timezone.
    const single = await sync(lifecycle, {
      reporting_subscriptions: [
        subscription({
          scope: { account_ids: ['acct_1'] },
          selector: { ...subscription().selector, period_timezone: 'America/New_York' },
          destination: { destination_id: 'archive', path_template: 'acct_1/{period_start}' },
        }),
      ],
    });
    assert.equal(single.result.kind, 'applied', JSON.stringify(single));
  });

  test('refuses duplicates, same-level overlap and ambiguous shared destinations', async () => {
    const { lifecycle } = setup();
    await sync(lifecycle, { reporting_destinations: [destination()] });
    const duplicate = await sync(lifecycle, { reporting_subscriptions: [subscription(), subscription()] });
    assert.match(errorOf(duplicate).message, /Duplicate subscription_id/);

    const overlap = await sync(lifecycle, {
      reporting_subscriptions: [
        subscription(),
        subscription({
          subscription_id: 'analytics-2',
          destination: { destination_id: 'archive', path_template: 'b/{account_id}' },
        }),
      ],
    });
    assert.match(errorOf(overlap).message, /both apply/);

    // Disjoint operator domains, or account_ids versus all-accounts, are allowed.
    const disjoint = await sync(lifecycle, {
      reporting_subscriptions: [
        subscription({ operator_domains: ['one.example'] }),
        subscription({
          subscription_id: 'analytics-2',
          operator_domains: ['two.example'],
          destination: { destination_id: 'archive', path_template: 'b/{account_id}' },
        }),
        subscription({
          subscription_id: 'analytics-acct',
          scope: { account_ids: ['acct_1'] },
          destination: { destination_id: 'archive', path_template: 'c/{account_id}' },
        }),
      ],
    });
    assert.equal(disjoint.result.kind, 'applied', JSON.stringify(disjoint));

    const sameTemplate = await sync(lifecycle, {
      reporting_subscriptions: [
        subscription({ operator_domains: ['one.example'] }),
        subscription({ subscription_id: 'analytics-2', operator_domains: ['two.example'] }),
      ],
    });
    assert.match(errorOf(sameTemplate).message, /can expand to the same path/);
  });

  test('a destination still named by an active subscription cannot be removed', async () => {
    const { lifecycle } = setup();
    await sync(lifecycle, { reporting_destinations: [destination()], reporting_subscriptions: [subscription()] });
    const removed = await sync(lifecycle, { reporting_destinations: [] });
    assert.equal(errorOf(removed).code, 'INVALID_REQUEST');
    const together = await sync(lifecycle, { reporting_destinations: [], reporting_subscriptions: [] });
    assert.equal(together.result.kind, 'applied', JSON.stringify(together));
  });

  test('honours dry_run and expected_configuration_version', async () => {
    const { lifecycle } = setup();
    const dry = await sync(
      lifecycle,
      { reporting_destinations: [destination()], reporting_subscriptions: [subscription()] },
      { dry_run: true }
    );
    assert.deepEqual(dry.result, { kind: 'validated', action: 'would_update', dry_run: true });
    assert.deepEqual(await lifecycle.listReportingSubscriptions(SCOPE), { states: [], history: [] });
    const invalidDry = await sync(lifecycle, { reporting_subscriptions: [subscription()] }, { dry_run: true });
    assert.equal(errorOf(invalidDry).code, 'INVALID_REQUEST');

    await sync(lifecycle, { reporting_destinations: [destination()], reporting_subscriptions: [subscription()] });
    const stale = await sync(
      lifecycle,
      { reporting_subscriptions: [subscription({ active: false })] },
      { expected_configuration_version: 'cfg-0' }
    );
    assert.equal(errorOf(stale).code, 'CONFLICT');
  });

  test('applies replace_account_configs once per version, after commit', async () => {
    const { lifecycle, replacements, time } = setup();
    await sync(lifecycle, {
      reporting_destinations: [destination()],
      reporting_subscriptions: [subscription({ replace_account_configs: true })],
    });
    assert.deepEqual(replacements, [
      {
        scope: SCOPE,
        subscriptionId: 'analytics-daily',
        subscriptionVersion: 1,
        feedPurpose: 'analytics',
        at: '2026-11-01T12:00:00.000Z',
      },
    ]);
    await sync(lifecycle, { reporting_subscriptions: [subscription({ replace_account_configs: true })] });
    assert.equal(replacements.length, 1, 'a resend does not reapply');
    time.now = new Date('2026-11-03T00:00:00.000Z');
    await sync(lifecycle, {
      reporting_subscriptions: [subscription({ subscription_version: 2, replace_account_configs: true })],
    });
    assert.equal(replacements.length, 2, 'a new version applies again');
    await sync(lifecycle, {
      reporting_subscriptions: [subscription({ subscription_version: 2, replace_account_configs: false })],
    });
    await sync(lifecycle, {
      reporting_subscriptions: [subscription({ subscription_version: 2, replace_account_configs: true })],
    });
    assert.equal(replacements.length, 3, 'turning the flag back on applies again');

    const { lifecycle: without } = setup({ support: { replaceAccountConfigs: undefined } });
    const refused = await sync(without, {
      reporting_destinations: [destination()],
      reporting_subscriptions: [subscription({ replace_account_configs: true })],
    });
    assert.equal(errorOf(refused).code, 'UNSUPPORTED_FEATURE');
  });

  test('a failed replace_account_configs hook is retried, and marked applied only after it succeeds', async () => {
    let failures = 1;
    const calls = [];
    const { lifecycle } = setup({
      support: {
        replaceAccountConfigs: input => {
          calls.push(input);
          if (failures-- > 0) throw new Error('host temporarily unavailable');
        },
      },
    });
    await assert.rejects(
      sync(lifecycle, {
        reporting_destinations: [destination()],
        reporting_subscriptions: [subscription({ replace_account_configs: true })],
      }),
      /temporarily unavailable/
    );
    let { history } = await lifecycle.listReportingSubscriptions(SCOPE);
    assert.equal(history[0].replaceAppliedVersion, undefined);
    assert.equal(history[0].replacePending.subscriptionVersion, 1);
    // The identical resend is unchanged, but still retries the pending replacement.
    const resent = await sync(lifecycle, {
      reporting_subscriptions: [subscription({ replace_account_configs: true })],
    });
    assert.equal(resent.result.action, 'unchanged');
    assert.equal(calls.length, 2);
    ({ history } = await lifecycle.listReportingSubscriptions(SCOPE));
    assert.equal(history[0].replaceAppliedVersion, 1);
    assert.equal(history[0].replacePending, undefined);
    await sync(lifecycle, { reporting_subscriptions: [subscription({ replace_account_configs: true })] });
    assert.equal(calls.length, 2, 'applied once');
  });

  test('engine readback never advances configuration_version, so a guarded write does not conflict', async () => {
    const { lifecycle } = setup();
    const created = await sync(lifecycle, {
      reporting_destinations: [destination()],
      reporting_subscriptions: [subscription()],
    });
    const version = created.result.configuration_version;
    assert.equal(
      await lifecycle.recordReportingSubscriptionCoverage(SCOPE, [
        {
          subscriptionId: 'analytics-daily',
          accountsWithExceptions: [{ account_id: 'acct_2', reasons: ['capacity'] }],
          accountsUnauthorized: [],
        },
      ]),
      true
    );
    const guarded = await sync(
      lifecycle,
      { reporting_subscriptions: [subscription({ active: false })] },
      { expected_configuration_version: version }
    );
    assert.equal(guarded.result.kind, 'applied', JSON.stringify(guarded));
    await assert.rejects(
      lifecycle.recordReportingSubscriptionCoverage(SCOPE, [
        {
          subscriptionId: 'analytics-daily',
          accountsWithExceptions: Array.from({ length: 1001 }, (_, index) => ({
            account_id: `acct_${index}`,
            reasons: ['capacity'],
          })),
          accountsUnauthorized: [],
        },
      ]),
      /more than 1000/,
      'the readback is never silently cut'
    );
  });

  test('a destination changing pattern or transport under an active subscription needs a new version', async () => {
    const { lifecycle } = setup();
    await sync(lifecycle, { reporting_destinations: [destination()], reporting_subscriptions: [subscription()] });
    const moved = destination('archive', { transport: 'gcs', location: 'gs://bucket/archive' });
    const refused = await sync(lifecycle, { reporting_destinations: [moved] });
    assert.equal(errorOf(refused).code, 'INVALID_REQUEST');
    assert.match(errorOf(refused).message, /increment its subscription_version/);
    const sameVersion = await sync(lifecycle, {
      reporting_destinations: [moved],
      reporting_subscriptions: [subscription()],
    });
    assert.match(errorOf(sameVersion).message, /increment its subscription_version/);
    const bumped = await sync(lifecycle, {
      reporting_destinations: [moved],
      reporting_subscriptions: [subscription({ subscription_version: 2 })],
    });
    assert.equal(bumped.result.kind, 'applied', JSON.stringify(bumped));
    const { history } = await lifecycle.listReportingSubscriptions(SCOPE);
    assert.deepEqual(history[0].versions.at(-1).destinationMethod, { pattern: 'file_transfer', transport: 'gcs' });
  });

  test('templates that can expand to the same path are refused', async () => {
    const { lifecycle } = setup();
    await sync(lifecycle, { reporting_destinations: [destination()] });
    const colliding = await sync(lifecycle, {
      reporting_subscriptions: [
        subscription({
          subscription_id: 'x',
          operator_domains: ['one.example'],
          destination: { destination_id: 'archive', path_template: '{account_id}/{subscription_id}' },
        }),
        subscription({
          subscription_id: 'y',
          operator_domains: ['two.example'],
          destination: { destination_id: 'archive', path_template: '{account_id}/x' },
        }),
      ],
    });
    assert.match(errorOf(colliding).message, /can expand to the same path/);
  });

  test('accepts dimension values outside the published vocabulary', async () => {
    const { lifecycle } = setup();
    await sync(lifecycle, { reporting_destinations: [destination()] });
    const request = {
      idempotency_key: 'unknown-dimension-0001',
      configuration: {
        reporting_subscriptions: [
          subscription({ selector: { ...subscription().selector, dimensions: ['package', 'placement'] } }),
        ],
      },
    };
    // reporting-dimension.json is extensible: receivers MUST accept unknown values.
    const outcome = validateRequest('sync_principal', request, '3.3.0-beta.1');
    assert.equal(outcome.valid, true, JSON.stringify(outcome.issues));
    const applied = await lifecycle.protocol.syncPrincipal(request, CTX);
    assert.equal(applied.result.kind, 'applied', JSON.stringify(applied));
  });

  test('prior versions keep their configuration in the readback', async () => {
    const { lifecycle, time } = setup();
    await sync(lifecycle, { reporting_destinations: [destination()], reporting_subscriptions: [subscription()] });
    time.now = new Date('2026-11-04T12:00:00.000Z');
    await sync(lifecycle, {
      reporting_subscriptions: [subscription({ subscription_version: 2, exclude_account_ids: ['acct_x'] })],
    });
    const { states } = await lifecycle.listReportingSubscriptions(SCOPE);
    assert.equal(states[0].prior_versions[0].configuration.subscription_version, 1);
    assert.equal(states[0].prior_versions[0].configuration.exclude_account_ids, undefined);
    // Served at 3.3.0-beta.1, whose prior_versions items are closed, the field is omitted.
    const served = await lifecycle.protocol.getPrincipal({}, CTX);
    assert.equal(served.result.configuration.reporting_subscriptions[0].prior_versions[0].configuration, undefined);
    assertSchemaValid('get_principal', served);
  });

  test('with the option off, a row written with subscriptions on serves no reporting_subscriptions', async () => {
    const { lifecycle, store, notifications } = setup();
    await sync(lifecycle, { reporting_destinations: [destination()], reporting_subscriptions: [subscription()] });
    const off = createPrincipalLifecycle({
      store,
      notifications,
      agentUrl: 'https://seller.example/mcp',
      resolvePrincipal: ctx => ctx.callerMutationScope,
      prepareReportingDestination: ({ destination: value }) => ({
        state: 'validating',
        configuration: structuredClone(value),
      }),
    });
    const read = await off.protocol.getPrincipal({}, CTX);
    assert.equal(read.result.configuration.reporting_subscriptions, undefined);
    assertSchemaValid('get_principal', read);
  });

  test('the delivery_config_id clash check is required while account configurations are served', () => {
    assert.throws(
      () => setup({ support: { listDeliveryConfigIds: undefined } }),
      /requires listDeliveryConfigIds unless accountConfigurations is false/
    );
    assert.doesNotThrow(() => setup({ support: { listDeliveryConfigIds: undefined, accountConfigurations: false } }));
  });

  test('a destination needing action moves the subscription to action_required and notifies', async () => {
    const { lifecycle, emitted } = setup();
    const created = await sync(lifecycle, {
      notification_configs: [
        { subscriber_id: 'events', url: 'https://buyer.example/events', event_types: ['principal.changed'] },
      ],
      reporting_destinations: [destination()],
      reporting_subscriptions: [subscription()],
    });
    const ref = created.result.configuration.reporting_destinations[0].destination_ref;
    const configuration = await lifecycle.transitionDestination(SCOPE, {
      destinationId: 'archive',
      destinationRef: ref,
      state: 'action_required',
      setup: { action: 'grant_access' },
    });
    const state = configuration.reporting_subscriptions[0];
    assert.equal(state.state, 'action_required');
    assert.equal(state.issues[0].code, 'DESTINATION_NOT_READY');
    const reasons = emitted.map(event => event.payload.reason);
    assert.ok(reasons.includes('reporting_subscription_changed'), JSON.stringify(reasons));
    const read = await lifecycle.protocol.getPrincipal({}, CTX);
    assertSchemaValid('get_principal', read);
  });

  test('records engine-maintained readback and notifies only on change', async () => {
    const { lifecycle, emitted } = setup();
    await sync(lifecycle, {
      notification_configs: [
        { subscriber_id: 'events', url: 'https://buyer.example/events', event_types: ['principal.changed'] },
      ],
      reporting_destinations: [destination()],
      reporting_subscriptions: [subscription()],
    });
    const update = [
      {
        subscriptionId: 'analytics-daily',
        accountsWithExceptions: [{ account_id: 'acct_2', reasons: ['capacity'] }],
        accountsUnauthorized: [
          {
            account_id: 'acct_9',
            unauthorized_at: '2026-11-05T06:00:00.000Z',
            last_owed_period_end: '2026-11-05T00:00:00.000Z',
            withheld_period_count: 1,
          },
        ],
      },
    ];
    assert.equal(await lifecycle.recordReportingSubscriptionCoverage(SCOPE, update), true);
    assert.equal(await lifecycle.recordReportingSubscriptionCoverage(SCOPE, update), false);
    assert.equal(emitted.filter(event => event.payload.reason === 'reporting_subscription_changed').length, 1);
    const read = await lifecycle.protocol.getPrincipal({}, CTX);
    assertSchemaValid('get_principal', read);
    const state = read.result.configuration.reporting_subscriptions[0];
    assert.deepEqual(state.accounts_with_exceptions, update[0].accountsWithExceptions);
    assert.deepEqual(state.accounts_unauthorized, update[0].accountsUnauthorized);
    // A caller write keeps engine-maintained readback.
    const resent = await sync(lifecycle, {
      reporting_subscriptions: [subscription({ replace_account_configs: false })],
    });
    assert.deepEqual(
      resent.result.configuration.reporting_subscriptions[0].accounts_unauthorized,
      update[0].accountsUnauthorized
    );
  });
});

describe('expandReportingSubscriptionPathTemplate', () => {
  test('fills one percent-encoded segment per value', () => {
    assert.equal(
      expandReportingSubscriptionPathTemplate('a/{account_id}/{subscription_id}/{offering_id}/{period_start}', {
        account_id: 'acct/../x',
        subscription_id: '..',
        offering_id: 'off_1',
        period_start: '2026-11-03T00:00:00Z',
      }),
      'a/acct%2F..%2Fx/%2E%2E/off_1/2026-11-03T00:00:00Z'
    );
  });
});
