/**
 * The managed Reliable Reporting service serves local-day offerings (adcp-client#3574):
 * `account_timezone` days on the subscription path, each account in its own zone, and
 * `source_timezone` days in zones whose DST change skips local midnight (America/Santiago).
 * A day whose midnight a DST gap swallows starts at the instant midnight advances to
 * (`core/reporting-schedule.json` `period_generation`), so it is 23 hours long, and the
 * seller's periods must equal the buyer's.
 */
const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

process.env.NODE_ENV = 'test';

const { createReportingTestKit, offerings } = require('../../dist/lib/testing/reporting/index.js');
const { createReliableReportingService } = require('../../dist/lib/reporting/service/index.js');
const {
  redactedReportingSourceOfferingV1,
  redactedReportingSourceRequestV1,
} = require('../../dist/lib/reporting/source/index.js');
const { MemoryLedgerStore } = require('../helpers/memory-reporting-ledger-store.js');

// Santiago springs forward at local midnight on 2026-09-06 (00:00 -04 -> 01:00 -03).
const START = '2026-09-03T00:00:00.000Z';
const END = '2026-09-23T00:00:00.000Z';
const analyticsDaily = {
  subscription_id: 'analytics-daily',
  scope: { all_authorized_accounts: true },
  selector: { feed_purpose: 'analytics', period_duration: 'P1D', required_finality: 'snapshot' },
  reconciliation_mode: 'delivery_only',
};

function localDaysKit() {
  return createReportingTestKit({
    start: START,
    offerings: [offerings.dailyAnalytics({ alignment: 'account_timezone' })],
    accounts: [
      { account_id: 'acc_ny', timezone: 'America/New_York', grants: ['agency-x'] },
      { account_id: 'acc_scl', timezone: 'America/Santiago', grants: ['agency-x'] },
    ],
    buys: ['acc_ny', 'acc_scl'].map(account_id => ({
      media_buy_id: `mb_${account_id}`,
      account_id,
      confirmed_at: START,
      start_time: START,
      end_time: END,
    })),
  });
}

/** A source and delivery offering pair over the redacted reference source, as the issue's repro. */
function adapterFor(schedule, sourceTimezone) {
  const { cadence, ...base } = structuredClone(redactedReportingSourceOfferingV1);
  const sourceOffering = {
    ...base,
    sourceTimezone: { ...base.sourceTimezone, ianaTimezone: sourceTimezone },
    publicationClass: 'AUTHORITATIVE',
    revisionSemantics: 'official_with_declared_correction_policy',
    finalization: {
      schedule: { sourceLocalReadyTime: '00:00', daysAfterPeriodEnd: 0 },
      expectedAvailabilityLag: 'PT0S',
      worstCaseAvailabilityLag: 'PT0S',
      triggerSupport: cadence.triggerSupport,
      correctionWindow: 'P1D',
      correctionPolicy: 'none',
    },
  };
  if (sourceTimezone === undefined) delete sourceOffering.sourceTimezone.ianaTimezone;
  const contract = sourceOffering.contract;
  const deliveryOffering = {
    ...offerings.dailyAnalytics(),
    offering_id: sourceOffering.offeringId,
    report_definition_id: contract.report_definition_id,
    schedule: { period_duration: 'P1D', delivery_sla: 'PT6H', ...schedule },
    supported_finality: ['official'],
  };
  return {
    sourceOffering,
    deliveryOffering,
    fetchSlice: slice => ({
      reporting_period: { start: slice.start_date, end: slice.end_date },
      currency: 'USD',
      reporting_rows: [],
    }),
  };
}

function service(adapter, extra = {}) {
  return createReliableReportingService({
    store: new MemoryLedgerStore(),
    adapters: { a: adapter },
    contact: { name: 'Reporting operations', email: 'reporting@example.com' },
    automatedRecoveryWindowSeconds: 86_400,
    statusRetentionDays: 30,
    resolveSource: () => ({ adapterId: 'a', sourceScope: {}, sourceTimezone: 'America/Santiago' }),
    resolveCurrency: () => 'USD',
    resolveCoverage: () => ({ constituents: [] }),
    ...extra,
  });
}

describe('managed local-day reporting offerings', () => {
  test('account_timezone days follow each account, across a Santiago midnight DST gap', async () => {
    const kit = localDaysKit();
    assert.deepEqual(
      kit.service.capabilities.offerings.map(offering => offering.schedule),
      [{ period_duration: 'P1D', alignment: 'account_timezone', delivery_sla: 'PT0S' }],
      'account_timezone carries no period_timezone on the wire'
    );
    const buyer = kit.buyer('agency-x');
    assert.equal((await buyer.reporting.subscribe(analyticsDaily)).action, 'created');
    await kit.clock.advanceTo('2026-09-09T00:00:00.000Z');

    const report = await buyer.reporting.reconcile({ now: kit.clock.now() });
    const periods = account =>
      report.periods
        .filter(line => line.account_id === account)
        .map(line => [line.period.start, line.period.end, line.status]);
    // New York: local midnight is 04:00Z all week.
    assert.deepEqual(periods('acc_ny'), [
      ['2026-09-03T04:00:00.000Z', '2026-09-04T04:00:00.000Z', 'delivered'],
      ['2026-09-04T04:00:00.000Z', '2026-09-05T04:00:00.000Z', 'delivered'],
      ['2026-09-05T04:00:00.000Z', '2026-09-06T04:00:00.000Z', 'delivered'],
      ['2026-09-06T04:00:00.000Z', '2026-09-07T04:00:00.000Z', 'delivered'],
      ['2026-09-07T04:00:00.000Z', '2026-09-08T04:00:00.000Z', 'delivered'],
    ]);
    // Santiago: 2026-09-06 starts at 01:00 local (04:00Z), the instant its skipped midnight
    // advances to, and ends at the next local midnight (03:00Z): a 23-hour day.
    assert.deepEqual(periods('acc_scl'), [
      ['2026-09-03T04:00:00.000Z', '2026-09-04T04:00:00.000Z', 'delivered'],
      ['2026-09-04T04:00:00.000Z', '2026-09-05T04:00:00.000Z', 'delivered'],
      ['2026-09-05T04:00:00.000Z', '2026-09-06T04:00:00.000Z', 'delivered'],
      ['2026-09-06T04:00:00.000Z', '2026-09-07T03:00:00.000Z', 'delivered'],
      ['2026-09-07T03:00:00.000Z', '2026-09-08T03:00:00.000Z', 'delivered'],
    ]);
    await kit.assertAgreement('agency-x');
  });

  test('an account-level install of an account_timezone offering names the subscription path', async () => {
    const kit = localDaysKit();
    const request = redactedReportingSourceRequestV1();
    const { currency: _currency, ...sourceSettings } = request.sourceSettings;
    const [offering] = kit.service.capabilities.offerings;
    await assert.rejects(
      kit.service.installConfiguration(
        {
          delivery_config_id: 'account-level',
          delivery_config_version: 1,
          offeringId: offering.offering_id,
          report_definition_id: offering.report_definition_id,
          feedPurpose: 'analytics',
          requiredFinality: 'snapshot',
          requestedMetrics: request.requestedMetrics,
          requestedDimensions: request.requestedDimensions,
          schedule: {
            anchor: '2026-09-03T04:00:00.000Z',
            periodMilliseconds: 86_400_000,
            deliverySlaMilliseconds: 0,
            recoveryWindowMilliseconds: 86_400_000,
          },
          sourceSettings,
        },
        { account: { id: 'acc_ny', ctx_metadata: {} } }
      ),
      /served only through reporting subscriptions/
    );
  });

  test('construction refuses account_timezone without a subscription path or with a pinned source zone', () => {
    assert.throws(
      () => service(adapterFor({ alignment: 'account_timezone' }, undefined)),
      /'account_timezone' period alignment only on the subscription path/
    );
    const kit = localDaysKit();
    const subscriptions = kit.service.subscriptionWiring;
    assert.throws(
      () => service(adapterFor({ alignment: 'account_timezone' }, 'America/New_York'), { subscriptions }),
      /timezone is resolved per account/
    );
  });

  test('a source_timezone P1D offering is accepted in zones whose DST change skips local midnight', () => {
    for (const zone of ['America/New_York', 'America/Santiago', 'America/Havana', 'Africa/Cairo']) {
      assert.doesNotThrow(
        () =>
          service(
            adapterFor({ alignment: 'source_timezone', period_timezone_policy: 'fixed', period_timezone: zone }, zone)
          ),
        zone
      );
    }
  });
});
