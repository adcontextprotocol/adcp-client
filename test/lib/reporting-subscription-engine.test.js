const { describe, test } = require('node:test');
const PINNED = require('node:fs')
  .readFileSync(require('node:path').join(__dirname, '..', '..', 'ADCP_VERSION'), 'utf8')
  .trim();
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const { createTestPrincipalLifecycle } = require('../helpers/principal-runtime.js');
const {
  createInMemoryReportingSubscriptionEngineStoreV1,
  createReportingSubscriptionEngineV1,
} = require('../../dist/lib/reporting/advanced/index.js');
const { owedSubscriptionPeriodsV1 } = require('../../dist/lib/reporting/advanced/index.js');
const { validateResponse } = require('../../dist/lib/validation/schema-validator.js');

const SCOPE = { tenantId: 't', principalId: 'p' };
const CTX = { callerMutationScope: { tenant_id: 't', principal_id: 'p', principal_kind: 'buyer_agent' } };

const profile = {
  id: 'adcp.delivery.v1',
  version: '1.0.0',
  schema_uri: 'https://seller.example/schemas/delivery.json',
  schema_sha256: 'a'.repeat(64),
  schema_dialect: 'https://json-schema.org/draft/2020-12/schema',
  schema_ref_policy: 'local_fragment_only',
  grain: 'daily',
  primary_keys: ['account_id', 'package_id'],
};
function offering(id, dimensions) {
  return {
    offering_id: id,
    feed_purpose: 'analytics',
    report_definition_id: `rd_${id}`,
    report_definition_uri: `https://seller.example/report-definitions/${id}.json`,
    report_definition_sha256: 'b'.repeat(64),
    reporting_profile: profile,
    schedule: { period_duration: 'P1D', alignment: 'utc', delivery_sla: 'PT6H' },
    supported_finality: ['official'],
    reconciliation_mode: 'delivery_only',
    standard_dimensions: dimensions,
  };
}
const OFFERINGS = [
  offering('off_a_pkg', ['package']),
  offering('off_b_pkg_creative', ['package', 'creative']),
  offering('off_c_pkg_country', ['package', 'country']),
];
const ALL_IDS = OFFERINGS.map(item => item.offering_id);
const ACCOUNT_TZ_OFFERING = {
  ...offering('off_z_pkg_acct_tz', ['package']),
  schedule: { period_duration: 'P1D', alignment: 'account_timezone', delivery_sla: 'PT6H' },
};
OFFERINGS.push(ACCOUNT_TZ_OFFERING);

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
      dimensions: ['package'],
    },
    reconciliation_mode: 'delivery_only',
    ...extra,
  };
}

function buy(id, extra = {}) {
  return {
    media_buy_id: id,
    confirmed_at: '2026-11-02T15:00:00Z',
    start_time: '2026-11-03T00:00:00Z',
    end_time: '2026-11-10T00:00:00Z',
    packages: [{ package_id: `${id}_pkg`, reporting_delivery_offering_ids: ALL_IDS }],
    ...extra,
  };
}

/**
 * One seller (principal runtime + engine + host facts) and one buyer that keeps only what
 * it can observe: its own requests, get_principal readback, list_accounts authorized_at,
 * get_media_buys, and get_reporting_status subscription_coverage.
 */
function world({ maxAccounts, backfillOnRegrant = false } = {}) {
  const clock = { now: new Date('2026-11-01T12:00:00.000Z') };
  const { lifecycle, emitted } = createTestPrincipalLifecycle({ clock, reportingSubscriptions: {} });
  const host = {
    accounts: new Map(),
    buys: new Map(),
    configs: new Map(),
    revokedAt: new Map(),
    delivered: () => false,
  };
  const engineStore = createInMemoryReportingSubscriptionEngineStoreV1();
  const engine = createReportingSubscriptionEngineV1({
    principal: lifecycle,
    offerings: OFFERINGS,
    store: engineStore,
    statusRetentionDays: 30,
    ...(maxAccounts !== undefined ? { maxAccounts } : {}),
    backfillOnRegrant,
    now: () => clock.now,
    hooks: {
      listAuthorizedAccounts: () => ({ accounts: [...host.accounts.values()].map(item => structuredClone(item)) }),
      listAccountBuys: (_principal, accountId) => structuredClone(host.buys.get(accountId) ?? []),
      listAccountDeliveryConfigs: (_principal, accountId) => structuredClone(host.configs.get(accountId) ?? []),
      // The host records when it revoked authority; the engine never stamps reconcile time.
      resolveRevocationInstant: (_principal, accountId, input) => host.revokedAt.get(accountId) ?? input.observedAt,
      isPeriodDelivered: (_principal, period) => host.delivered(period),
    },
  });

  // Buyer-side records.
  const buyer = { sent: new Map(), grants: new Map(), timezones: new Map() };
  let key = 0;
  async function sync(subscriptions) {
    key += 1;
    const response = await lifecycle.protocol.syncPrincipal(
      {
        idempotency_key: `buyer-key-${String(key).padStart(6, '0')}`,
        configuration: {
          notification_configs: [
            { subscriber_id: 'events', url: 'https://buyer.example/events', event_types: ['principal.changed'] },
          ],
          reporting_subscriptions: subscriptions,
        },
      },
      CTX
    );
    assert.equal(response.result.kind, 'applied', JSON.stringify(response));
    for (const item of subscriptions)
      buyer.sent.set(`${item.subscription_id}@${item.subscription_version}`, structuredClone(item));
    return response;
  }
  function grant(accountId, at, extra = {}) {
    host.accounts.set(accountId, { account_id: accountId, authorized_at: at, timezone: 'America/New_York', ...extra });
  }
  function revoke(accountId, at) {
    host.accounts.delete(accountId);
    if (at !== undefined) host.revokedAt.set(accountId, at);
  }
  /** The buyer observes list_accounts and get_principal after each step. */
  async function observe() {
    // authorized_at is the start of the authorization chain (adcontextprotocol/adcp#8585): a
    // re-grant inside retention leaves it unchanged and continues the chain, and the seller's
    // gaps[] then says which periods the interruption removed. A different authorized_at is a
    // new chain.
    for (const account of host.accounts.values()) {
      buyer.timezones.set(account.account_id, account.timezone);
      const grants = buyer.grants.get(account.account_id) ?? [];
      const last = grants.at(-1);
      const chainStart = grants.filter(grant => grant.chain).at(-1)?.authorized_at;
      if (!last) grants.push({ authorized_at: account.authorized_at, chain: true });
      else if (last.unauthorized_at !== undefined) {
        if (account.authorized_at === chainStart) delete last.unauthorized_at;
        else grants.push({ authorized_at: account.authorized_at, chain: true });
      }
      buyer.grants.set(account.account_id, grants);
    }
    // Served at the pinned release the readback carries only fields that release defines and
    // is schema-valid.
    const served = await lifecycle.protocol.getPrincipal({}, { ...CTX, servedAdcpVersion: PINNED });
    const outcome = validateResponse('get_principal', served, PINNED);
    assert.equal(outcome.valid, true, JSON.stringify(outcome.issues));
    const read = await lifecycle.protocol.getPrincipal({}, CTX);
    for (const state of (await lifecycle.listReportingSubscriptions(SCOPE)).states) {
      for (const lost of state.accounts_unauthorized ?? []) {
        const grants = buyer.grants.get(lost.account_id) ?? [];
        const last = grants.at(-1);
        if (last && last.unauthorized_at === undefined) last.unauthorized_at = lost.unauthorized_at;
      }
    }
    return read;
  }
  async function step(at) {
    clock.now = new Date(at);
    await engine.reconcile(SCOPE);
    return observe();
  }
  /** What the buyer expects, from its observations only. */
  async function buyerExpected(accountId, now, subscriptionId = 'analytics-daily') {
    // The complete readback, from the internal state.
    const { states } = await lifecycle.listReportingSubscriptions(SCOPE);
    const state = states.find(item => item.subscription_id === subscriptionId);
    const versions = [...(state.prior_versions ?? [])].reverse().map(prior => ({
      subscription_version: prior.subscription_version,
      accepted_at: prior.accepted_at,
      superseded_at: prior.superseded_at,
      configuration: { ...buyer.sent.get(`${subscriptionId}@${prior.subscription_version}`), active: true },
    }));
    versions.push({
      subscription_version: state.subscription_version,
      accepted_at: state.accepted_at,
      ...(state.deactivated_at ? { deactivated_at: state.deactivated_at } : {}),
      configuration: buyer.sent.get(`${subscriptionId}@${state.subscription_version}`),
    });
    const coverage = (await engine.subscriptionCoverage(SCOPE, accountId)).find(
      item => item.subscription_id === subscriptionId
    );
    return owedSubscriptionPeriodsV1({
      subscription_id: subscriptionId,
      versions,
      ...(state.inactive_intervals ? { inactive_intervals: state.inactive_intervals } : {}),
      account: {
        account_id: accountId,
        timezone: buyer.timezones.get(accountId) ?? 'America/New_York',
        grants: (buyer.grants.get(accountId) ?? []).map(({ chain: _chain, ...grant }) => grant),
      },
      buys: host.buys.get(accountId) ?? [],
      offerings: OFFERINGS,
      ...(coverage ? { coverage } : {}),
      backfill_on_regrant: backfillOnRegrant,
      status_retention_days: 30,
      now,
    });
  }
  async function assertAgree(accountId, now, subscriptionId) {
    const seller = (await engine.owedPeriods(SCOPE, accountId, { now })).filter(
      item => subscriptionId === undefined || item.subscription_id === subscriptionId
    );
    const expected = await buyerExpected(accountId, now, subscriptionId);
    assert.deepEqual(seller, expected, `seller and buyer disagree for ${accountId} at ${now}`);
    return expected;
  }
  return {
    buyer,
    clock,
    lifecycle,
    engine,
    engineStore,
    host,
    sync,
    grant,
    revoke,
    step,
    observe,
    buyerExpected,
    assertAgree,
    emitted,
  };
}

const starts = rows =>
  rows.map(
    row => `${row.subscription_version}:${row.media_buy_id}:${row.offering_id}:${row.period_start.slice(0, 10)}`
  );

describe('reporting subscription engine conformance (buyer periods equal seller periods)', () => {
  test('a mid-period confirmed_at, cancellation mid-flight, and early completion', async () => {
    const w = world();
    w.grant('acct_1', '2026-10-01T00:00:00.000Z');
    w.host.buys.set('acct_1', [
      buy('mb_mid', { confirmed_at: '2026-11-03T10:00:00Z' }),
      buy('mb_cancel', { canceled_at: '2026-11-05T06:00:00Z' }),
      buy('mb_done', { completed_at: '2026-11-04T00:00:00Z' }),
    ]);
    await w.sync([subscription()]);
    await w.step('2026-11-02T00:00:00.000Z');
    const owed = await w.assertAgree('acct_1', '2026-11-12T00:00:00.000Z');
    assert.deepEqual(
      starts(owed)
        .filter(item => item.includes('mb_mid'))
        .map(item => item.slice(-10)),
      // adcp#8593: the period in which the buy is confirmed is owed in full.
      ['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09']
    );
    assert.deepEqual(
      starts(owed)
        .filter(item => item.includes('mb_cancel'))
        .map(item => item.slice(-10)),
      ['2026-11-03', '2026-11-04', '2026-11-05']
    );
    assert.deepEqual(
      starts(owed)
        .filter(item => item.includes('mb_done'))
        .map(item => item.slice(-10)),
      ['2026-11-03']
    );
    const grouped = await w.engine.owedObligations(SCOPE, 'acct_1', { now: '2026-11-12T00:00:00.000Z' });
    assert.deepEqual(grouped[0].media_buy_ids, ['mb_cancel', 'mb_done', 'mb_mid']);
  });

  test('a flight extension adds only unresolved periods', async () => {
    const w = world();
    w.grant('acct_1', '2026-10-01T00:00:00.000Z');
    w.host.buys.set('acct_1', [
      buy('mb_1', {
        end_time: '2026-11-08T00:00:00Z',
        prior_flights: [
          { replaced_at: '2026-11-07T12:00:00Z', start_time: '2026-11-03T00:00:00Z', end_time: '2026-11-06T00:00:00Z' },
        ],
      }),
    ]);
    await w.sync([subscription()]);
    await w.step('2026-11-02T00:00:00.000Z');
    const owed = await w.assertAgree('acct_1', '2026-11-12T00:00:00.000Z');
    assert.deepEqual(
      starts(owed).map(item => item.slice(-10)),
      ['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-07']
    );
  });

  test('a new subscription version is a cutover', async () => {
    const w = world();
    w.grant('acct_1', '2026-10-01T00:00:00.000Z');
    w.host.buys.set('acct_1', [buy('mb_1')]);
    await w.sync([subscription()]);
    await w.step('2026-11-02T00:00:00.000Z');
    w.clock.now = new Date('2026-11-05T12:00:00.000Z');
    await w.sync([subscription({ subscription_version: 2, selector: { ...subscription().selector, match: 'all' } })]);
    await w.step('2026-11-06T00:00:00.000Z');
    const owed = await w.assertAgree('acct_1', '2026-11-12T00:00:00.000Z');
    assert.deepEqual(
      starts(owed)
        .filter(item => item.startsWith('1:'))
        .map(item => item.slice(-10)),
      ['2026-11-03', '2026-11-04', '2026-11-05']
    );
    assert.equal(
      starts(owed).filter(item => item.startsWith('2:') && item.endsWith('2026-11-05')).length,
      0,
      'nothing owed twice'
    );
    assert.equal(
      starts(owed).filter(item => item.startsWith('2:')).length,
      3 * 4,
      'v2 match all: three offerings from 11-06'
    );
  });

  for (const backfillOnRegrant of [false, true]) {
    test(`revocation and re-grant ${backfillOnRegrant ? 'with' : 'without'} backfill_on_regrant`, async () => {
      const w = world({ backfillOnRegrant });
      w.grant('acct_1', '2026-10-01T00:00:00.000Z');
      w.host.buys.set('acct_1', [buy('mb_1')]);
      await w.sync([subscription()]);
      await w.step('2026-11-02T00:00:00.000Z');
      w.revoke('acct_1', '2026-11-05T05:00:00.000Z');
      // Delivered on time: due by period end + PT6H before the revocation.
      w.host.delivered = period => Date.parse(period.period_end) + 6 * 3_600_000 <= Date.parse('2026-11-05T05:00:00Z');
      const revoked = await w.step('2026-11-05T05:00:00.000Z');
      const lost = revoked.result.configuration.reporting_subscriptions[0].accounts_unauthorized;
      assert.equal(lost[0].account_id, 'acct_1');
      assert.equal(lost[0].unauthorized_at, '2026-11-05T05:00:00.000Z');
      assert.equal(lost[0].last_owed_period_end, '2026-11-05T00:00:00.000Z');
      assert.equal(lost[0].withheld_period_count, 1, 'the 11-04 period (due 11-05T06) was not yet due at revocation');
      assert.deepEqual(await w.engine.subscriptionCoverage(SCOPE, 'acct_1'), [], 'caller isolation is unchanged');
      // adcp#8607: revocation means no access, so there is no post-loss receipt window.
      assert.equal('acceptsReceipt' in w.engine, false);
      assert.ok(w.emitted.some(event => event.payload.reason === 'reporting_subscription_changed'));

      // The host keeps reporting the chain's authorized_at and reports when it re-granted.
      w.grant('acct_1', '2026-10-01T00:00:00.000Z', { granted_at: '2026-11-06T18:00:00.000Z' });
      const regranted = await w.step('2026-11-06T18:00:00.000Z');
      assert.equal(regranted.result.configuration.reporting_subscriptions[0].accounts_unauthorized, undefined);
      const coverage = await w.engine.subscriptionCoverage(SCOPE, 'acct_1');
      if (backfillOnRegrant) assert.equal(coverage[0].gaps, undefined);
      else
        assert.deepEqual(coverage[0].gaps, [
          { from: '2026-11-05T00:00:00.000Z', until: '2026-11-07T00:00:00.000Z', reason: 'unauthorized' },
        ]);
      const owed = await w.assertAgree('acct_1', '2026-11-12T00:00:00.000Z');
      assert.deepEqual(
        starts(owed).map(item => item.slice(-10)),
        backfillOnRegrant
          ? ['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09']
          : ['2026-11-03', '2026-11-04', '2026-11-07', '2026-11-08', '2026-11-09']
      );
    });
  }

  test('max_accounts excludes deterministically and reports capacity', async () => {
    const w = world({ maxAccounts: 2 });
    for (const id of ['acct_c', 'acct_a', 'acct_b']) {
      w.grant(id, '2026-10-01T00:00:00.000Z');
      w.host.buys.set(id, [buy(`mb_${id}`)]);
    }
    await w.sync([subscription()]);
    const read = await w.step('2026-11-02T00:00:00.000Z');
    assert.deepEqual(read.result.configuration.reporting_subscriptions[0].accounts_with_exceptions, [
      { account_id: 'acct_c', reasons: ['capacity'] },
    ]);
    const coverage = await w.engine.subscriptionCoverage(SCOPE, 'acct_c');
    assert.equal(coverage[0].status, 'excluded');
    assert.deepEqual(coverage[0].excluded, [{ reason: 'capacity', from: '2026-11-02T00:00:00.000Z' }]);
    for (const id of ['acct_a', 'acct_b', 'acct_c']) await w.assertAgree(id, '2026-11-12T00:00:00.000Z');
    assert.equal((await w.engine.owedPeriods(SCOPE, 'acct_c', { now: '2026-11-12T00:00:00.000Z' })).length, 0);
    // A served account keeps its slot when a lower id appears later.
    w.grant('acct_0', '2026-11-03T00:00:00.000Z');
    w.host.buys.set('acct_0', [buy('mb_acct_0')]);
    await w.step('2026-11-03T00:00:00.000Z');
    const zero = await w.engine.subscriptionCoverage(SCOPE, 'acct_0');
    assert.equal(zero[0].excluded[0].reason, 'capacity');
    assert.equal((await w.engine.receiptRoster('t', 'acct_a')).length, 1);
    assert.equal((await w.engine.receiptRoster('t', 'acct_c')).length, 0);
  });

  test('capacity across calendars with different boundaries is written per offering', async () => {
    const w = world({ maxAccounts: 1 });
    const both = [...ALL_IDS, ACCOUNT_TZ_OFFERING.offering_id];
    for (const id of ['acct_a', 'acct_b']) {
      w.grant(id, '2026-10-01T00:00:00.000Z');
      w.host.buys.set(id, [
        buy(`mb_${id}`, { packages: [{ package_id: `mb_${id}_pkg`, reporting_delivery_offering_ids: both }] }),
      ]);
    }
    // match all resolves the UTC offerings and the account-timezone one: two different calendars.
    await w.sync([subscription({ selector: { ...subscription().selector, match: 'all' } })]);
    await w.step('2026-11-02T12:00:00.000Z');
    const [coverage] = await w.engine.subscriptionCoverage(SCOPE, 'acct_b');
    const capacity = coverage.excluded.filter(entry => entry.reason === 'capacity');
    assert.ok(capacity.length > 1, JSON.stringify(coverage.excluded));
    assert.ok(capacity.every(entry => typeof entry.offering_id === 'string'));
    const byOffering = Object.fromEntries(capacity.map(entry => [entry.offering_id, entry.from]));
    assert.notEqual(byOffering.off_z_pkg_acct_tz, byOffering.off_a_pkg, 'each entry carries its own cutover');
    // The buyer computes the same owed set from the per-offering entries.
    await w.assertAgree('acct_b', '2026-11-12T00:00:00.000Z');

    // A release without excluded[].offering_id gets one entry cut at the latest of their instants.
    const {
      reportingSubscriptionCoverageForReleaseV1,
    } = require('../../dist/lib/server/reporting-subscription-release.js');
    const old = reportingSubscriptionCoverageForReleaseV1(coverage, {
      offeringDimensions: true,
      inactiveIntervals: true,
      priorVersionConfiguration: true,
      cutoverPreviousTimezone: true,
      perOfferingEntries: true,
      perOfferingExclusions: false,
      inactiveCoverageStatus: false,
    });
    const folded = old.excluded.filter(entry => entry.reason === 'capacity');
    assert.equal(folded.length, 1);
    assert.equal(folded[0].offering_id, undefined);
    assert.equal(
      folded[0].from,
      capacity
        .map(entry => entry.from)
        .sort()
        .at(-1)
    );
  });

  test("precedence: the caller's account-level configuration overrides the subscription", async () => {
    const w = world();
    w.grant('acct_1', '2026-10-01T00:00:00.000Z');
    w.host.buys.set('acct_1', [buy('mb_1')]);
    await w.sync([subscription()]);
    await w.step('2026-11-02T00:00:00.000Z');
    w.host.configs.set('acct_1', [
      { delivery_config_id: 'acme-analytics', feed_purpose: 'analytics', active_from: '2026-11-04T12:00:00.000Z' },
    ]);
    await w.step('2026-11-04T12:00:00.000Z');
    let coverage = await w.engine.subscriptionCoverage(SCOPE, 'acct_1');
    assert.deepEqual(coverage[0].excluded, [
      {
        reason: 'overridden',
        overridden_by: { delivery_config_id: 'acme-analytics' },
        from: '2026-11-05T00:00:00.000Z',
      },
    ]);
    w.host.configs.set('acct_1', []);
    await w.step('2026-11-06T12:00:00.000Z');
    coverage = await w.engine.subscriptionCoverage(SCOPE, 'acct_1');
    assert.equal(coverage[0].excluded[0].until, '2026-11-07T00:00:00.000Z');
    assert.equal(coverage[0].status, 'active');
    const owed = await w.assertAgree('acct_1', '2026-11-12T00:00:00.000Z');
    assert.deepEqual(
      starts(owed).map(item => item.slice(-10)),
      ['2026-11-03', '2026-11-04', '2026-11-07', '2026-11-08', '2026-11-09']
    );
  });

  test('precedence: an account_ids subscription overrides an all-accounts one', async () => {
    const w = world();
    w.grant('acct_1', '2026-10-01T00:00:00.000Z');
    w.grant('acct_2', '2026-10-01T00:00:00.000Z');
    w.host.buys.set('acct_1', [buy('mb_1')]);
    w.host.buys.set('acct_2', [buy('mb_2')]);
    await w.sync([
      subscription(),
      subscription({ subscription_id: 'analytics-acct1', scope: { account_ids: ['acct_1'] } }),
    ]);
    await w.step('2026-11-02T00:00:00.000Z');
    const coverage = await w.engine.subscriptionCoverage(SCOPE, 'acct_1');
    const all = coverage.find(item => item.subscription_id === 'analytics-daily');
    assert.deepEqual(all.excluded[0].overridden_by, { subscription_id: 'analytics-acct1' });
    for (const id of ['analytics-daily', 'analytics-acct1'])
      await w.assertAgree('acct_1', '2026-11-12T00:00:00.000Z', id);
    const owed = await w.engine.owedPeriods(SCOPE, 'acct_1', { now: '2026-11-12T00:00:00.000Z' });
    assert.ok(
      owed.every(item => item.subscription_id === 'analytics-acct1'),
      'one feed per account and purpose'
    );
    await w.assertAgree('acct_2', '2026-11-12T00:00:00.000Z', 'analytics-daily');
  });

  for (const [match, dimensions, expected] of [
    ['exact', ['package'], ['off_a_pkg']],
    ['finest', ['package'], ['off_b_pkg_creative']],
    ['all', ['package'], ['off_a_pkg', 'off_b_pkg_creative', 'off_c_pkg_country']],
    ['exact', ['package', 'country'], ['off_c_pkg_country']],
  ]) {
    test(`selector ${match} ${dimensions.join(' x ')}`, async () => {
      const w = world();
      w.grant('acct_1', '2026-10-01T00:00:00.000Z');
      w.host.buys.set('acct_1', [buy('mb_1', { end_time: '2026-11-04T00:00:00Z' })]);
      await w.sync([subscription({ selector: { ...subscription().selector, dimensions, match } })]);
      await w.step('2026-11-02T00:00:00.000Z');
      const owed = await w.assertAgree('acct_1', '2026-11-12T00:00:00.000Z');
      assert.deepEqual(
        owed.map(item => item.offering_id),
        expected
      );
    });
  }

  test('offering_unsupported and excluded_by_buyer are reported without removing owed periods elsewhere', async () => {
    const w = world();
    w.grant('acct_1', '2026-10-01T00:00:00.000Z');
    w.grant('acct_x', '2026-10-01T00:00:00.000Z');
    w.host.buys.set('acct_1', [
      buy('mb_1'),
      buy('mb_dooh', { packages: [{ package_id: 'dooh_pkg', reporting_delivery_offering_ids: [] }] }),
      buy('mb_mixed', {
        packages: [
          { package_id: 'ok_pkg', reporting_delivery_offering_ids: ['off_a_pkg'] },
          { package_id: 'bad_pkg', reporting_delivery_offering_ids: [] },
        ],
      }),
    ]);
    await w.sync([subscription({ exclude_account_ids: ['acct_x'] })]);
    const read = await w.step('2026-11-02T00:00:00.000Z');
    assert.deepEqual(read.result.configuration.reporting_subscriptions[0].accounts_with_exceptions, [
      { account_id: 'acct_1', reasons: ['offering_unsupported'] },
      { account_id: 'acct_x', reasons: ['excluded_by_buyer'] },
    ]);
    const coverage = await w.engine.subscriptionCoverage(SCOPE, 'acct_1');
    assert.equal(coverage[0].status, 'active');
    assert.deepEqual(
      coverage[0].excluded.map(item => [item.media_buy_id, item.package_ids]),
      [
        ['mb_dooh', undefined],
        ['mb_mixed', ['bad_pkg']],
      ]
    );
    const outcome = validateResponse(
      'get_reporting_status',
      { status: 'completed', view: 'summary', subscription_coverage: coverage },
      PINNED
    );
    assert.equal(
      outcome.issues?.some(issue => /subscription_coverage/.test(issue.pointer ?? issue.path ?? '')) ?? false,
      false,
      JSON.stringify(outcome.issues)
    );
    const owed = await w.assertAgree('acct_1', '2026-11-12T00:00:00.000Z');
    assert.deepEqual([...new Set(owed.map(item => item.media_buy_id))], ['mb_1', 'mb_mixed']);
    assert.equal((await w.engine.subscriptionCoverage(SCOPE, 'acct_x'))[0].status, 'excluded');
  });

  test('reactivation is a fresh start the buyer recomputes from inactive_intervals', async () => {
    const w = world();
    w.grant('acct_1', '2026-10-01T00:00:00.000Z');
    w.host.buys.set('acct_1', [buy('mb_1')]);
    await w.sync([subscription()]);
    await w.step('2026-11-02T00:00:00.000Z');
    w.clock.now = new Date('2026-11-04T12:00:00.000Z');
    await w.sync([subscription({ active: false })]);
    w.clock.now = new Date('2026-11-06T12:00:00.000Z');
    await w.sync([subscription()]);
    await w.step('2026-11-06T12:00:00.000Z');
    const { states } = await w.lifecycle.listReportingSubscriptions(SCOPE);
    assert.deepEqual(states[0].inactive_intervals, [
      { deactivated_at: '2026-11-04T12:00:00.000Z', reactivated_at: '2026-11-06T12:00:00.000Z' },
    ]);
    const owed = await w.assertAgree('acct_1', '2026-11-12T00:00:00.000Z');
    assert.deepEqual(
      starts(owed).map(item => item.slice(-10)),
      ['2026-11-03', '2026-11-04', '2026-11-07', '2026-11-08', '2026-11-09']
    );
  });

  test('a deactivated subscription reads inactive while it has retained obligations, then drops out', async () => {
    const w = world();
    w.grant('acct_1', '2026-10-01T00:00:00.000Z');
    w.host.buys.set('acct_1', [buy('mb_1')]);
    await w.sync([subscription()]);
    await w.step('2026-11-02T00:00:00.000Z');
    await w.step('2026-11-04T00:00:00.000Z');
    w.clock.now = new Date('2026-11-04T12:00:00.000Z');
    await w.sync([subscription({ active: false })]);
    await w.step('2026-11-05T00:00:00.000Z');
    // adcp#8613: never active once deactivated; deactivated_at is published with it.
    const [entry] = await w.engine.subscriptionCoverage(SCOPE, 'acct_1');
    assert.equal(entry.status, 'inactive');
    assert.equal(entry.deactivated_at, '2026-11-04T12:00:00.000Z');
    const {
      reportingSubscriptionCoverageForReleaseV1,
      reportingSubscriptionReleaseFieldsV1,
    } = require('../../dist/lib/server/reporting-subscription-release.js');
    const beta1 = reportingSubscriptionCoverageForReleaseV1(
      entry,
      reportingSubscriptionReleaseFieldsV1('3.3.0-beta.2')
    );
    assert.equal(beta1.status, 'active', 'a release without the inactive value sees the account-level state');
    assert.equal('deactivated_at' in beta1, false);
    assert.equal(
      reportingSubscriptionCoverageForReleaseV1(entry, {
        ...reportingSubscriptionReleaseFieldsV1(undefined),
        inactiveCoverageStatus: true,
      }).status,
      'inactive'
    );
    // The 11-04 period started before the deactivation and is retained for 30 days after it ends.
    w.clock.now = new Date('2026-12-04T23:00:00.000Z');
    assert.equal((await w.engine.subscriptionCoverage(SCOPE, 'acct_1')).length, 1);
    w.clock.now = new Date('2026-12-05T00:00:01.000Z');
    assert.deepEqual(await w.engine.subscriptionCoverage(SCOPE, 'acct_1'), [], 'omitted once nothing is retained');
  });

  test('an account timezone change publishes previous_timezone and the buyer agrees', async () => {
    const w = world();
    w.grant('acct_1', '2026-10-01T00:00:00.000Z');
    w.host.buys.set('acct_1', [
      buy('mb_1', {
        start_time: '2026-11-03T05:00:00Z',
        end_time: '2026-11-08T08:00:00Z',
        packages: [{ package_id: 'pkg_1', reporting_delivery_offering_ids: ['off_z_pkg_acct_tz'] }],
      }),
    ]);
    await w.sync([subscription({ selector: { ...subscription().selector, alignment: 'account_timezone' } })]);
    await w.step('2026-11-02T00:00:00.000Z');
    w.grant('acct_1', '2026-10-01T00:00:00.000Z', {
      timezone: 'America/Los_Angeles',
      timezone_changed_at: '2026-11-04T12:00:00.000Z',
    });
    await w.step('2026-11-04T12:00:00.000Z');
    const coverage = await w.engine.subscriptionCoverage(SCOPE, 'acct_1');
    assert.deepEqual(coverage[0].timezone_cutovers, [
      {
        effective_at: '2026-11-05T05:00:00.000Z',
        timezone: 'America/Los_Angeles',
        previous_timezone: 'America/New_York',
      },
    ]);
    const owed = await w.assertAgree('acct_1', '2026-11-12T00:00:00.000Z');
    assert.deepEqual(
      owed.map(row => row.period_start),
      [
        '2026-11-03T05:00:00.000Z',
        '2026-11-04T05:00:00.000Z',
        '2026-11-05T08:00:00.000Z',
        '2026-11-06T08:00:00.000Z',
        '2026-11-07T08:00:00.000Z',
      ]
    );
  });

  test('withdrawing an offering keeps the elapsed owed history', async () => {
    const w = world();
    w.grant('acct_1', '2026-10-01T00:00:00.000Z');
    w.host.buys.set('acct_1', [buy('mb_1', { end_time: '2026-12-31T00:00:00Z' })]);
    await w.sync([subscription()]);
    await w.step('2026-11-02T00:00:00.000Z');
    await w.step('2026-11-15T00:00:00.000Z');
    const before = await w.engine.owedPeriods(SCOPE, 'acct_1', { now: '2026-11-15T00:00:00.000Z' });
    assert.equal(before.length, 12, '11-03 through 11-14');
    // The seller withdraws the offering at 11-20 (kept, with withdrawn_at).
    const withdrawn = OFFERINGS.find(item => item.offering_id === 'off_a_pkg');
    withdrawn.withdrawn_at = '2026-11-20T00:00:00Z';
    try {
      await w.step('2026-11-21T00:00:00.000Z');
      const coverage = await w.engine.subscriptionCoverage(SCOPE, 'acct_1');
      const unsupported = coverage[0].excluded.find(item => item.reason === 'offering_unsupported');
      assert.equal(unsupported.from, '2026-11-20T00:00:00.000Z', 'opened at the E of the withdrawal, not accepted_at');
      const after = await w.engine.owedPeriods(SCOPE, 'acct_1', { now: '2026-11-25T00:00:00.000Z' });
      assert.deepEqual(
        after.map(item => item.period_start.slice(0, 10)),
        before
          .map(item => item.period_start.slice(0, 10))
          .concat(['2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19'])
      );
    } finally {
      delete withdrawn.withdrawn_at;
    }
  });

  test('a product dropping the offering mid-flight keeps the elapsed owed history', async () => {
    const w = world();
    w.grant('acct_1', '2026-10-01T00:00:00.000Z');
    w.host.buys.set('acct_1', [buy('mb_1', { end_time: '2026-12-31T00:00:00Z' })]);
    await w.sync([subscription()]);
    await w.step('2026-11-02T00:00:00.000Z');
    await w.step('2026-11-10T12:00:00.000Z');
    w.host.buys.set('acct_1', [
      buy('mb_1', {
        end_time: '2026-12-31T00:00:00Z',
        packages: [{ package_id: 'mb_1_pkg', reporting_delivery_offering_ids: [] }],
      }),
    ]);
    await w.step('2026-11-12T12:00:00.000Z');
    const coverage = await w.engine.subscriptionCoverage(SCOPE, 'acct_1');
    assert.equal(
      coverage[0].excluded.find(item => item.reason === 'offering_unsupported').from,
      '2026-11-13T00:00:00.000Z',
      'the product edit is observed at 11-12T12; E is the next boundary'
    );
    const owed = await w.engine.owedPeriods(SCOPE, 'acct_1', { now: '2026-11-20T00:00:00.000Z' });
    assert.deepEqual(
      owed.map(item => item.period_start.slice(0, 10)),
      [
        '2026-11-03',
        '2026-11-04',
        '2026-11-05',
        '2026-11-06',
        '2026-11-07',
        '2026-11-08',
        '2026-11-09',
        '2026-11-10',
        '2026-11-11',
        '2026-11-12',
      ]
    );
  });

  test('a product gaining the offering mid-flight owes periods from the edit, not retroactively', async () => {
    const w = world();
    w.grant('acct_1', '2026-10-01T00:00:00.000Z');
    const noOffering = [{ package_id: 'mb_1_pkg', reporting_delivery_offering_ids: [] }];
    w.host.buys.set('acct_1', [buy('mb_1', { end_time: '2026-12-31T00:00:00Z', packages: noOffering })]);
    await w.sync([subscription()]);
    await w.step('2026-11-02T00:00:00.000Z');
    await w.step('2026-11-10T12:00:00.000Z');
    w.host.buys.set('acct_1', [buy('mb_1', { end_time: '2026-12-31T00:00:00Z' })]);
    await w.step('2026-11-12T12:00:00.000Z');
    const owed = await w.engine.owedPeriods(SCOPE, 'acct_1', { now: '2026-11-16T00:00:00.000Z' });
    assert.deepEqual(
      owed.map(item => item.period_start.slice(0, 10)),
      ['2026-11-13', '2026-11-14', '2026-11-15']
    );
  });

  test('a subscription with more than 1000 readback accounts is isolated, not fatal', async () => {
    const w = world({ maxAccounts: 1 });
    for (let index = 0; index < 1002; index += 1) {
      w.grant(`acct_${String(index).padStart(4, '0')}`, '2026-10-01T00:00:00.000Z');
    }
    w.grant('acct_x', '2026-10-01T00:00:00.000Z');
    await w.sync([
      subscription(),
      subscription({ subscription_id: 'analytics-x', scope: { account_ids: ['acct_x'] } }),
    ]);
    {
      const result = await w.engine.reconcile(SCOPE);
      assert.deepEqual(
        result.readback_overflow.map(item => item.subscription_id),
        ['analytics-daily'],
        'every account past max_accounts carries capacity, more than the readback can list'
      );
      assert.ok(result.readback_overflow[0].accounts_with_exceptions > 1000);
    }
    // Other subscriptions keep updating.
    w.revoke('acct_x', '2026-11-03T00:00:00.000Z');
    w.clock.now = new Date('2026-11-03T12:00:00.000Z');
    const result = await w.engine.reconcile(SCOPE);
    assert.deepEqual(
      result.readback_overflow.map(item => item.subscription_id),
      ['analytics-daily']
    );
    const { states } = await w.lifecycle.listReportingSubscriptions(SCOPE);
    const x = states.find(item => item.subscription_id === 'analytics-x');
    assert.deepEqual(
      x.accounts_unauthorized.map(item => item.account_id),
      ['acct_x']
    );
    const daily = states.find(item => item.subscription_id === 'analytics-daily');
    assert.equal(daily.accounts_with_exceptions, undefined, 'the oversized list is never published cut');
  });

  test('pruning retained exceptions after status_retention_days never re-owes elapsed periods', async () => {
    const w = world({ maxAccounts: 1 });
    for (const id of ['acct_a', 'acct_b']) {
      w.grant(id, '2026-10-01T00:00:00.000Z');
      w.host.buys.set(id, [buy(`mb_${id}`, { end_time: '2026-12-31T00:00:00Z' })]);
    }
    await w.sync([subscription()]);
    await w.step('2026-11-02T00:00:00.000Z');
    // acct_a loses its slot's need: it leaves the roster, so acct_b takes a slot from 11-11.
    w.revoke('acct_a', '2026-11-10T12:00:00.000Z');
    await w.step('2026-11-11T00:00:00.000Z');
    const owedBefore = await w.engine.owedPeriods(SCOPE, 'acct_b', { now: '2026-11-12T00:00:00.000Z' });
    assert.deepEqual(
      owedBefore.map(item => item.period_start.slice(0, 10)),
      ['2026-11-11']
    );
    // Long after status_retention_days (30), the closed capacity exception is pruned.
    for (const day of ['2026-11-20', '2026-12-05', '2026-12-20']) await w.step(`${day}T00:00:00.000Z`);
    const coverage = await w.engine.subscriptionCoverage(SCOPE, 'acct_b');
    assert.equal(coverage[0].excluded.length, 0, 'the closed capacity entry left the wire');
    const owedAfter = await w.engine.owedPeriods(SCOPE, 'acct_b', { now: '2026-11-12T00:00:00.000Z' });
    assert.deepEqual(
      owedAfter,
      owedBefore.filter(item => Date.parse(item.period_end) + 30 * 86_400_000 > Date.parse('2026-12-20T00:00:00Z'))
    );
    const later = await w.engine.owedPeriods(SCOPE, 'acct_b', { now: '2026-12-20T00:00:00.000Z' });
    assert.ok(
      later.every(item => item.period_start >= '2026-11-11'),
      'periods refused under capacity never become owed'
    );
  });

  test("an override closes at the configuration's own active_until, not when the engine notices", async () => {
    const w = world();
    w.grant('acct_1', '2026-10-01T00:00:00.000Z');
    w.host.buys.set('acct_1', [buy('mb_1', { end_time: '2026-11-20T00:00:00Z' })]);
    await w.sync([subscription()]);
    await w.step('2026-11-02T00:00:00.000Z');
    w.host.configs.set('acct_1', [
      { delivery_config_id: 'acme-analytics', feed_purpose: 'analytics', active_from: '2026-11-04T12:00:00.000Z' },
    ]);
    await w.step('2026-11-04T12:00:00.000Z');
    // replace_account_configs ended it at 11-10T12; the engine reconciles only at 11-12T03.
    w.host.configs.set('acct_1', [
      {
        delivery_config_id: 'acme-analytics',
        feed_purpose: 'analytics',
        active_from: '2026-11-04T12:00:00.000Z',
        active_until: '2026-11-10T12:00:00.000Z',
        schedule: { period_duration: 'P1D', alignment: 'utc' },
      },
    ]);
    await w.step('2026-11-12T03:00:00.000Z');
    const coverage = await w.engine.subscriptionCoverage(SCOPE, 'acct_1');
    assert.equal(coverage[0].excluded[0].until, '2026-11-11T00:00:00.000Z');
    const owed = await w.engine.owedPeriods(SCOPE, 'acct_1', { now: '2026-11-14T00:00:00.000Z' });
    assert.deepEqual(
      owed.map(item => item.period_start.slice(0, 10)),
      ['2026-11-03', '2026-11-04', '2026-11-11', '2026-11-12', '2026-11-13']
    );
  });

  test('capacity first observed after coverage began opens at the coverage start', async () => {
    const w = world({ maxAccounts: 1 });
    for (const id of ['acct_a', 'acct_b']) {
      w.grant(id, '2026-10-01T00:00:00.000Z');
      w.host.buys.set(id, [buy(`mb_${id}`)]);
    }
    await w.sync([subscription()]);
    // The first reconcile runs days after acceptance.
    await w.step('2026-11-05T00:00:00.000Z');
    const coverage = await w.engine.subscriptionCoverage(SCOPE, 'acct_b');
    assert.deepEqual(coverage[0].excluded, [{ reason: 'capacity', from: '2026-11-02T00:00:00.000Z' }]);
    assert.deepEqual(await w.engine.owedPeriods(SCOPE, 'acct_b', { now: '2026-11-10T00:00:00.000Z' }), []);
  });

  test('an unobserved revocation followed by a new chain closes the old chain when it ended', async () => {
    const w = world();
    w.grant('acct_1', '2026-10-01T00:00:00.000Z');
    w.host.buys.set('acct_1', [buy('mb_1', { end_time: '2026-11-20T00:00:00Z' })]);
    await w.sync([subscription()]);
    await w.step('2026-11-02T00:00:00.000Z');
    // Between reconciles: revoked 11-04T06, re-granted after retention as a new chain at 11-08.
    w.host.revokedAt.set('acct_1', '2026-11-04T06:00:00.000Z');
    w.grant('acct_1', '2026-11-08T00:00:00.000Z');
    await w.step('2026-11-09T00:00:00.000Z');
    const state = await w.engine.inspect(SCOPE);
    assert.deepEqual(state.accounts.acct_1.account.grants, [
      { authorized_at: '2026-10-01T00:00:00.000Z', unauthorized_at: '2026-11-04T06:00:00.000Z' },
      { authorized_at: '2026-11-08T00:00:00.000Z' },
    ]);
    const owed = await w.engine.owedPeriods(SCOPE, 'acct_1', { now: '2026-11-11T00:00:00.000Z' });
    assert.ok(
      owed.every(item => item.period_start < '2026-11-05' || item.period_start >= '2026-11-08'),
      'the revoked interval is not owed'
    );
  });

  test('every hook the engine needs is required', () => {
    const w = world();
    assert.throws(
      () =>
        createReportingSubscriptionEngineV1({
          principal: w.lifecycle,
          offerings: OFFERINGS,
          statusRetentionDays: 30,
          hooks: { listAuthorizedAccounts: () => ({ accounts: [] }), listAccountBuys: () => [] },
        }),
      /isPeriodDelivered/
    );
    // resolveRevocationInstant is optional: a revocation is then dated when it was observed.
    assert.doesNotThrow(() =>
      createReportingSubscriptionEngineV1({
        principal: w.lifecycle,
        offerings: OFFERINGS,
        statusRetentionDays: 30,
        hooks: {
          listAuthorizedAccounts: () => ({ accounts: [] }),
          listAccountBuys: () => [],
          isPeriodDelivered: () => false,
        },
      })
    );
  });

  test('an unfinished account roster fails closed instead of reading as revocations', async () => {
    const w = world();
    w.grant('acct_1', '2026-10-01T00:00:00.000Z');
    w.host.buys.set('acct_1', [buy('mb_1')]);
    await w.sync([subscription()]);
    await w.step('2026-11-02T00:00:00.000Z');
    const before = await w.engine.inspect(SCOPE);
    let page = 0;
    const endless = createReportingSubscriptionEngineV1({
      principal: w.lifecycle,
      offerings: OFFERINGS,
      statusRetentionDays: 30,
      now: () => w.clock.now,
      store: w.engineStore,
      hooks: {
        listAuthorizedAccounts: () => ({ accounts: [], nextCursor: `page-${++page}` }),
        listAccountBuys: () => [],
        resolveRevocationInstant: (_principal, _account, input) => input.observedAt,
        isPeriodDelivered: () => false,
      },
    });
    await assert.rejects(endless.reconcile(SCOPE), /partial roster/);
    assert.deepEqual(await w.engine.inspect(SCOPE), before, 'no account was marked unauthorized');
  });

  test('last_owed_period_end is the latest frozen period end, whatever the storage order', async () => {
    const w = world();
    w.grant('acct_1', '2026-10-01T00:00:00.000Z');
    w.host.buys.set('acct_1', [buy('mb_1')]);
    await w.sync([subscription()]);
    await w.step('2026-11-02T00:00:00.000Z');
    await w.step('2026-11-05T01:00:00.000Z');
    // Frozen periods are appended across reconciles and offerings, so storage order is not end
    // order. Read them back reversed to prove the readback never trusts the last entry.
    const get = w.engineStore.get.bind(w.engineStore);
    w.engineStore.get = async (scope, key) => {
      const row = await get(scope, key);
      for (const target of Object.values(row?.value?.subscriptions ?? {})) target.frozen?.periods?.reverse();
      return row;
    };
    // Revoked, and its buys are no longer visible, so no calendar resolves at the revocation.
    w.revoke('acct_1', '2026-11-05T05:00:00.000Z');
    w.host.buys.set('acct_1', []);
    const revoked = await w.step('2026-11-05T05:00:00.000Z');
    const [lost] = revoked.result.configuration.reporting_subscriptions[0].accounts_unauthorized;
    assert.equal(lost.last_owed_period_end, '2026-11-05T00:00:00.000Z');
  });

  test('a changed pending action refreshes the open action_required entry and notifies', async () => {
    const w = world();
    const action = extra => ({
      waiting_on: 'buyer',
      kind: 'accept_terms',
      message: 'Accept reporting terms',
      url: 'https://seller.example/terms',
      ...extra,
    });
    w.grant('acct_1', '2026-10-01T00:00:00.000Z', { pending_action: action() });
    w.host.buys.set('acct_1', [buy('mb_1')]);
    await w.sync([subscription()]);
    await w.step('2026-11-02T00:00:00.000Z');
    const [before] = await w.engine.subscriptionCoverage(SCOPE, 'acct_1');
    const opened = before.excluded.find(entry => entry.reason === 'action_required');
    const notified = w.emitted.length;
    // The seller moves the required step to a new page with a new message.
    w.grant('acct_1', '2026-10-01T00:00:00.000Z', {
      pending_action: action({ message: 'Accept the revised terms', url: 'https://seller.example/terms/v2' }),
    });
    await w.step('2026-11-03T00:00:00.000Z');
    const [after] = await w.engine.subscriptionCoverage(SCOPE, 'acct_1');
    assert.equal(after.status, 'action_required');
    assert.equal(after.pending_action.url, 'https://seller.example/terms/v2');
    assert.equal(after.pending_action.message, 'Accept the revised terms');
    const refreshed = after.excluded.find(entry => entry.reason === 'action_required');
    assert.equal(refreshed.from, opened.from, 'the open entry keeps its from');
    assert.equal(refreshed.until, undefined);
    assert.ok(w.emitted.length > notified, 'the change fires principal.changed');
    assert.equal(w.emitted.at(-1).payload.reason, 'reporting_subscription_changed');
  });

  test('the grant journal continues a chain inside retention and starts a new one after it', async () => {
    const w = world();
    w.grant('acct_1', '2026-10-01T00:00:00.000Z');
    w.host.buys.set('acct_1', [buy('mb_1')]);
    await w.sync([subscription()]);
    await w.step('2026-11-02T00:00:00.000Z');
    const served = async at => {
      w.clock.now = new Date(at);
      return (await w.engine.observeGrants(SCOPE, [{ account_id: 'acct_1' }])).get('acct_1');
    };
    assert.equal(await served('2026-11-02T00:00:00.000Z'), '2026-10-01T00:00:00.000Z');
    // Pushed: revoked on 11-05, re-granted on 11-20, inside the 30-day retention: the chain continues.
    // Listings agree with what was pushed.
    const push = async (at, authorized, hostFacts) => {
      w.clock.now = new Date(at);
      if (hostFacts) w.grant('acct_1', hostFacts.authorized_at, hostFacts.extra ?? {});
      else w.host.accounts.delete('acct_1');
      await w.engine.authorizationChanged(SCOPE, 'acct_1', { authorized, at });
    };
    await push('2026-11-05T00:00:00.000Z', false);
    await push('2026-11-20T00:00:00.000Z', true, {
      authorized_at: '2026-10-01T00:00:00.000Z',
      extra: { granted_at: '2026-11-20T00:00:00.000Z' },
    });
    assert.equal(await served('2026-11-20T00:00:00.000Z'), '2026-10-01T00:00:00.000Z');
    // Revoked again on 11-21, re-granted on 12-30, after retention: a new chain starts then.
    await push('2026-11-21T00:00:00.000Z', false);
    await push('2026-12-30T00:00:00.000Z', true, { authorized_at: '2026-12-30T00:00:00.000Z' });
    assert.equal(await served('2026-12-30T00:00:00.000Z'), '2026-12-30T00:00:00.000Z');
    // Observed by a listing: revoked on 12-31, first seen again on 2027-02-15, after retention.
    await push('2026-12-31T00:00:00.000Z', false);
    assert.equal(await served('2027-02-15T00:00:00.000Z'), '2027-02-15T00:00:00.000Z');
  });

  test('a pending account action is an account-level action_required exception', async () => {
    const w = world();
    w.grant('acct_1', '2026-10-01T00:00:00.000Z', {
      pending_action: {
        waiting_on: 'buyer',
        kind: 'accept_terms',
        message: 'Accept reporting terms',
        url: 'https://seller.example/terms',
      },
    });
    w.host.buys.set('acct_1', [buy('mb_1')]);
    await w.sync([subscription()]);
    await w.step('2026-11-02T00:00:00.000Z');
    const coverage = await w.engine.subscriptionCoverage(SCOPE, 'acct_1');
    assert.equal(coverage[0].status, 'action_required');
    assert.equal(coverage[0].pending_action.kind, 'accept_terms');
    await w.assertAgree('acct_1', '2026-11-12T00:00:00.000Z');
  });
});
