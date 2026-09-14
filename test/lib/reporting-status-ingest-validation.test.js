const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  ReportingConsumerStatusV1Schema,
  ReportingConsumerStatusConflictError,
  SyncReportingStatusRequestV1Schema,
  createSyncReportingStatusHandler,
} = require('../../dist/lib/reporting/ledger/index.js');
const { validateSyncReportingStatusEnvelope } = require('../../dist/lib/validation/sync-reporting-status-envelope.js');

function consumerStatus(overrides = {}) {
  return {
    reporting_status_id: 'reporting_status_0001',
    delivery_config_id: 'delivery_config_0001',
    delivery_config_version: 1,
    report_definition_id: 'report_definition_0001',
    period: {
      start: '2026-09-01T00:00:00Z',
      end: '2026-09-02T00:00:00Z',
      source_timezone: 'UTC',
    },
    consumer_status: 'obligation_missing',
    status_as_of: '2026-09-03T00:00:00Z',
    ...overrides,
  };
}

describe('reporting consumer status validation', () => {
  test('keeps the envelope placeholder and 0/100/101 item boundaries aligned with the published schema', () => {
    const envelope = count => ({
      account: { account_id: 'account-1' },
      idempotency_key: 'reporting-status-envelope-boundary',
      statuses: Array.from({ length: count }, (_, index) =>
        consumerStatus({
          reporting_status_id: `reporting_status_${String(index + 1).padStart(4, '0')}`,
          // The envelope validator deliberately ignores item-level evidence.
          consumer_status: 'received',
        })
      ),
    });
    assert.equal(validateSyncReportingStatusEnvelope(envelope(0)).valid, false);
    assert.equal(validateSyncReportingStatusEnvelope(envelope(1)).valid, true);
    assert.equal(validateSyncReportingStatusEnvelope(envelope(100)).valid, true);
    assert.equal(validateSyncReportingStatusEnvelope(envelope(101)).valid, false);
    assert.equal(validateSyncReportingStatusEnvelope(envelope(1), '3.0.25').valid, false);
  });

  test('whole-request validation applies the consumer-only status refinements', () => {
    const malformed = consumerStatus({
      reporting_obligation_id: undefined,
      reporting_revision_id: undefined,
      observed_revision_content_sha256: undefined,
      recorded_at: '2026-09-03T00:00:00Z',
    });
    assert.equal(
      SyncReportingStatusRequestV1Schema.safeParse({
        account: { account_id: 'account-1' },
        idempotency_key: 'reporting-status-validation',
        statuses: [malformed],
      }).success,
      false
    );
  });

  test('returns an item-local field for malformed status recovery', async () => {
    const handler = createSyncReportingStatusHandler(
      {
        getConsumerStatusBatchReplay: async () => undefined,
        listConfigurations: async () => [],
        syncConsumerStatusBatch: async ({ entries }) =>
          entries.map(entry => ({
            inserted: false,
            reporting_status_id: entry.status?.reporting_status_id ?? entry.reporting_status_id,
            errorCode: 'VALIDATION_ERROR',
            safeMessage: entry.validationError,
            errorField: entry.validationField,
            errorKeyword: entry.validationKeyword,
          })),
      },
      { resolveConsumerId: () => 'consumer-1' }
    );
    const result = await handler(
      {
        account: { account_id: 'account-1' },
        idempotency_key: 'reporting-status-field-0001',
        statuses: [consumerStatus({ recorded_at: '2026-09-03T00:00:00Z' })],
      },
      { account: { id: 'account-1' } }
    );
    assert.equal(result.results[0].result, 'failed');
    assert.equal(result.results[0].errors[0].field, 'statuses[0].recorded_at');
    assert.deepEqual(result.results[0].errors[0].issues, [
      {
        pointer: '/statuses/0/recorded_at',
        message: 'Reporting consumer status request is invalid',
        keyword: 'allOf',
      },
    ]);
    assert.equal(result.results[0].errors[0].recovery, 'correctable');
  });

  test('omits an oversized malformed-property pointer from stored and returned diagnostics', async () => {
    const oversizedProperty = `oversized_${'x'.repeat(70_000)}`;
    let storedField;
    const handler = createSyncReportingStatusHandler(
      {
        getConsumerStatusBatchReplay: async () => undefined,
        listConfigurations: async () => [],
        syncConsumerStatusBatch: async ({ entries }) => {
          storedField = entries[0].validationField;
          return [
            {
              inserted: false,
              reporting_status_id: entries[0].reporting_status_id,
              errorCode: 'VALIDATION_ERROR',
              safeMessage: entries[0].validationError,
              errorField: entries[0].validationField,
            },
          ];
        },
      },
      { resolveConsumerId: () => 'consumer-1' }
    );
    const result = await handler(
      {
        account: { account_id: 'account-1' },
        idempotency_key: 'reporting-status-oversized-field-0001',
        statuses: [{ ...consumerStatus(), [oversizedProperty]: true }],
      },
      { account: { id: 'account-1' } }
    );
    assert.equal(storedField, undefined);
    assert.equal(result.results[0].result, 'failed');
    assert.equal(result.results[0].errors[0].field, undefined);
    assert.equal(result.results[0].errors[0].issues, undefined);
  });

  test('omits database-unsafe malformed-property pointers without failing valid siblings', async () => {
    for (const unsafeProperty of ['unsafe\u0000key', `unsafe${String.fromCharCode(0xd800)}key`]) {
      let storedField = 'not-called';
      const handler = createSyncReportingStatusHandler(
        {
          getConsumerStatusBatchReplay: async () => undefined,
          listConfigurations: async () => [],
          syncConsumerStatusBatch: async ({ entries }) => {
            storedField = entries[0].validationField;
            return entries.map(entry => ({
              inserted: false,
              reporting_status_id: entry.status?.reporting_status_id ?? entry.reporting_status_id,
              errorCode: 'VALIDATION_ERROR',
              safeMessage: entry.validationError,
              errorField: entry.validationField,
              errorKeyword: entry.validationKeyword,
            }));
          },
        },
        { resolveConsumerId: () => 'consumer-1' }
      );
      const result = await handler(
        {
          account: { account_id: 'account-1' },
          idempotency_key: 'reporting-status-unsafe-pointer-0001',
          statuses: [{ ...consumerStatus(), [unsafeProperty]: true }],
        },
        { account: { id: 'account-1' } }
      );
      assert.equal(storedField, undefined);
      assert.equal(result.results[0].result, 'failed');
      assert.equal(result.results[0].errors[0].field, undefined);
      assert.equal(result.results[0].errors[0].issues, undefined);
    }
  });

  test('rejects prototype-named properties that Zod cannot copy through safely', async () => {
    let storedEntry;
    const handler = createSyncReportingStatusHandler(
      {
        getConsumerStatusBatchReplay: async () => undefined,
        listConfigurations: async () => [],
        syncConsumerStatusBatch: async ({ entries }) => {
          [storedEntry] = entries;
          return [
            {
              inserted: false,
              reporting_status_id: entries[0].reporting_status_id,
              errorCode: 'VALIDATION_ERROR',
              safeMessage: entries[0].validationError,
              errorField: entries[0].validationField,
            },
          ];
        },
      },
      { resolveConsumerId: () => 'consumer-1' }
    );
    const rawStatus = consumerStatus();
    Object.defineProperty(rawStatus, '__proto__', { value: {}, enumerable: true });
    const result = await handler(
      {
        account: { account_id: 'account-1' },
        idempotency_key: 'reporting-status-prototype-key-0001',
        statuses: [rawStatus],
      },
      { account: { id: 'account-1' } }
    );
    assert.equal(storedEntry.validationField, '/statuses/0/__proto__');
    assert.equal(result.results[0].errors[0].field, 'statuses[0].__proto__');
  });

  test('bounds request bytes before parsing, hashing, or invoking the store', async () => {
    let storeCalled = false;
    const handler = createSyncReportingStatusHandler(
      {
        getConsumerStatusBatchReplay: async () => {
          storeCalled = true;
        },
      },
      { resolveConsumerId: () => 'consumer-1' }
    );
    const result = await handler(
      {
        account: { account_id: 'account-1' },
        idempotency_key: 'reporting-status-byte-bound-0001',
        statuses: [consumerStatus({ ext: { 'example.invalid': 'x'.repeat(8 * 1024 * 1024) } })],
      },
      { account: { id: 'account-1' } }
    );
    assert.equal(storeCalled, false);
    assert.equal(result.results[0].result, 'failed');
    assert.equal(result.results[0].errors[0].code, 'VALIDATION_ERROR');

    const escapedSurrogateResult = await handler(
      {
        account: { account_id: 'account-1' },
        idempotency_key: 'reporting-status-escaped-surrogate-bound-0001',
        statuses: [consumerStatus({ ext: { 'example.invalid': '\ud800'.repeat(1_500_000) } })],
      },
      { account: { id: 'account-1' } }
    );
    assert.equal(storeCalled, false);
    assert.equal(escapedSurrogateResult.results[0].result, 'failed');
    assert.equal(escapedSurrogateResult.results[0].errors[0].code, 'VALIDATION_ERROR');
  });

  test('does not expose custom-store conflict messages', async () => {
    const handler = createSyncReportingStatusHandler(
      {
        getConsumerStatusBatchReplay: async () => {
          throw new ReportingConsumerStatusConflictError('postgres://secret@internal.example/reporting');
        },
      },
      { resolveConsumerId: () => 'consumer-1' }
    );
    const result = await handler(
      {
        account: { account_id: 'account-1' },
        idempotency_key: 'reporting-status-safe-conflict-0001',
        statuses: [consumerStatus()],
      },
      { account: { id: 'account-1' } }
    );
    assert.equal(result.results[0].errors[0].message, 'Reporting status idempotency conflict');
    assert.doesNotMatch(JSON.stringify(result), /secret|internal\.example/);
  });

  test('rejects date-time extensions unsupported by reporting instant arithmetic', () => {
    assert.equal(
      ReportingConsumerStatusV1Schema.safeParse(consumerStatus({ status_as_of: '2026-09-03T00:00:00+0530' })).success,
      false
    );
  });

  test('keeps the nested period closed and half-open', () => {
    const extra = consumerStatus();
    extra.period.extra = 'not-on-the-wire';
    assert.equal(ReportingConsumerStatusV1Schema.safeParse(extra).success, false);
    assert.equal(
      ReportingConsumerStatusV1Schema.safeParse(
        consumerStatus({
          period: {
            start: '2026-09-02T00:00:00Z',
            end: '2026-09-01T00:00:00Z',
            source_timezone: 'UTC',
          },
        })
      ).success,
      false
    );
  });

  test('fails a deeply nested request as data instead of throwing', async () => {
    let nested = {};
    for (let index = 0; index < 3000; index += 1) nested = { nested };
    const handler = createSyncReportingStatusHandler(
      {
        getConsumerStatusBatchReplay: async () => undefined,
      },
      { resolveConsumerId: () => 'consumer-1' }
    );
    const result = await handler(
      {
        account: { account_id: 'account-1' },
        idempotency_key: 'reporting-status-depth-0001',
        statuses: [
          { ...consumerStatus({ reporting_status_id: 'reporting_status_depth_0001' }), ext: nested },
          consumerStatus({ reporting_status_id: 'reporting_status_depth_0002' }),
        ],
      },
      { account: { id: 'account-1' } }
    );
    assert.deepEqual(
      result.results.map(item => item.reporting_status_id),
      ['reporting_status_depth_0001', 'reporting_status_depth_0002']
    );
    assert.equal(result.results[0].result, 'failed');
    assert.equal(result.results[0].errors[0].code, 'VALIDATION_ERROR');
  });

  test('fails an excessively wide request before invoking the store', async () => {
    let storeCalled = false;
    const handler = createSyncReportingStatusHandler(
      {
        getConsumerStatusBatchReplay: async () => {
          storeCalled = true;
        },
      },
      { resolveConsumerId: () => 'consumer-1' }
    );
    const result = await handler(
      {
        account: { account_id: 'account-1' },
        idempotency_key: 'reporting-status-width-0001',
        statuses: [{ ...consumerStatus(), ext: Array.from({ length: 10_001 }, () => null) }],
      },
      { account: { id: 'account-1' } }
    );
    assert.equal(storeCalled, false);
    assert.equal(result.results[0].result, 'failed');
    assert.equal(result.results[0].errors[0].code, 'VALIDATION_ERROR');
  });

  test('permits repeated object references when the input graph is acyclic', async () => {
    const sharedPeriod = consumerStatus().period;
    const handler = createSyncReportingStatusHandler(
      {
        getConsumerStatusBatchReplay: async () => undefined,
        listConfigurations: async () => [],
        syncConsumerStatusBatch: async ({ entries }) =>
          entries.map(entry => ({
            inserted: false,
            reporting_status_id: entry.status?.reporting_status_id ?? entry.reporting_status_id,
            errorCode: 'VALIDATION_ERROR',
            safeMessage: 'Reporting consumer status does not match the seller ledger',
          })),
      },
      { resolveConsumerId: () => 'consumer-1' }
    );
    const result = await handler(
      {
        account: { account_id: 'account-1' },
        idempotency_key: 'reporting-status-shared-period-0001',
        statuses: [
          consumerStatus({ reporting_status_id: 'reporting_status_0002', period: sharedPeriod }),
          consumerStatus({ reporting_status_id: 'reporting_status_0003', period: sharedPeriod }),
        ],
      },
      { account: { id: 'account-1' } }
    );
    assert.equal(result.results.length, 2);
    assert.deepEqual(
      result.results.map(value => value.reporting_status_id),
      ['reporting_status_0002', 'reporting_status_0003']
    );
  });

  test('accepts externally expanded 23/25-hour days and a calendar month without inventing obligations', async () => {
    const boundaries = [
      {
        version: 1,
        start: '2026-03-08T05:00:00Z',
        end: '2026-03-09T04:00:00Z',
        milliseconds: 82_800_000,
      },
      {
        version: 2,
        start: '2026-11-01T04:00:00Z',
        end: '2026-11-02T05:00:00Z',
        milliseconds: 90_000_000,
      },
      {
        version: 3,
        start: '2026-02-01T05:00:00Z',
        end: '2026-03-01T05:00:00Z',
        milliseconds: 2_419_200_000,
      },
    ];
    const configurations = boundaries.map(boundary => ({
      configurationId: `calendar-boundary-${boundary.version}`,
      account: { account_id: 'calendar-fixture-account' },
      delivery_config_id: 'calendar-boundary',
      delivery_config_version: boundary.version,
      report_definition_id: 'calendar-delivery-v1',
      sourceTimezone: 'America/New_York',
      requiredFinality: 'snapshot',
      installedAt: boundary.start,
      supersededAt: boundary.end,
      schedule: {
        anchor: boundary.start,
        periodMilliseconds: boundary.milliseconds,
        deliverySlaMilliseconds: 3_600_000,
      },
    }));
    const store = {
      getConsumerStatusBatchReplay: async () => undefined,
      listConfigurations: async () => configurations,
      getObligation: async () => {
        throw new Error('obligation_missing must not invent or load an obligation');
      },
      getRevisionMetadata: async () => null,
      readSnapshotPage: async () => {
        throw new Error('snapshot provenance was not supplied');
      },
      syncConsumerStatusBatch: async ({ entries }) =>
        entries.map(entry => ({
          inserted: true,
          value: { ...entry.status, recorded_at: '2026-11-03T00:00:00Z' },
        })),
    };
    const handler = createSyncReportingStatusHandler(store, {
      resolveConsumerId: () => 'calendar-fixture-consumer',
      now: () => new Date('2026-11-03T00:00:00Z'),
    });

    for (const boundary of boundaries) {
      const result = await handler(
        {
          account: { account_id: 'calendar-fixture-account' },
          idempotency_key: `calendar-boundary-batch-${boundary.version}`,
          statuses: [
            {
              reporting_status_id: `calendar-boundary-status-${boundary.version}`,
              delivery_config_id: 'calendar-boundary',
              delivery_config_version: boundary.version,
              report_definition_id: 'calendar-delivery-v1',
              period: {
                start: boundary.start,
                end: boundary.end,
                source_timezone: 'America/New_York',
              },
              consumer_status: 'obligation_missing',
              status_as_of: new Date(Date.parse(boundary.end) + 3_600_000).toISOString(),
            },
          ],
        },
        { account: { id: 'calendar-fixture-account' } }
      );
      assert.equal(result.results[0].result, 'recorded', JSON.stringify(result));
    }
  });

  test('rejects configurations returned outside the authenticated account scope', async () => {
    let synchronized = false;
    const handler = createSyncReportingStatusHandler(
      {
        getConsumerStatusBatchReplay: async () => undefined,
        listConfigurations: async accountId => {
          assert.equal(accountId, 'account-1');
          return [
            {
              account: { account_id: 'account-2' },
              delivery_config_id: 'delivery_config_0001',
              delivery_config_version: 1,
              report_definition_id: 'report_definition_0001',
            },
          ];
        },
        syncConsumerStatusBatch: async ({ entries }) => {
          synchronized = true;
          return entries.map(entry => ({
            inserted: false,
            reporting_status_id: entry.status?.reporting_status_id ?? entry.reporting_status_id,
            errorCode: 'VALIDATION_ERROR',
            safeMessage: 'Reporting consumer status does not match the seller ledger',
          }));
        },
      },
      { resolveConsumerId: () => 'consumer-1', now: () => new Date('2026-09-03T00:00:00Z') }
    );

    const result = await handler(
      {
        account: { account_id: 'account-1' },
        idempotency_key: 'reporting-status-foreign-configuration-0001',
        statuses: [consumerStatus()],
      },
      { account: { id: 'account-1' } }
    );
    assert.equal(synchronized, true);
    assert.equal(result.results[0].result, 'failed');
    assert.equal(result.results[0].errors[0].code, 'VALIDATION_ERROR');
  });

  test('rejects snapshot provenance returned for another account', async () => {
    const configuration = {
      configurationId: 'snapshot-account-configuration',
      account: { account_id: 'account-1' },
      delivery_config_id: 'delivery_config_0001',
      delivery_config_version: 1,
      report_definition_id: 'report_definition_0001',
      sourceTimezone: 'UTC',
      requiredFinality: 'snapshot',
      installedAt: '2026-09-01T00:00:00Z',
      schedule: {
        anchor: '2026-09-01T00:00:00Z',
        periodMilliseconds: 86_400_000,
        deliverySlaMilliseconds: 0,
      },
    };
    const handler = createSyncReportingStatusHandler(
      {
        getConsumerStatusBatchReplay: async () => undefined,
        listConfigurations: async () => [configuration],
        readSnapshotPage: async () => ({
          snapshot: {
            query: {
              account_id: 'account-2',
              consumer_id: 'consumer-1',
              view: 'periods',
              period: { start: '2026-09-01T00:00:00Z', end: '2026-09-02T00:00:00Z' },
            },
            ledgerAsOf: '2026-09-03T00:00:00Z',
            configurations: [configuration],
            obligations: [],
            revisions: [],
          },
        }),
        syncConsumerStatusBatch: async ({ entries }) =>
          entries.map(entry => ({
            inserted: false,
            reporting_status_id: entry.status?.reporting_status_id ?? entry.reporting_status_id,
            errorCode: 'VALIDATION_ERROR',
            safeMessage: entry.validationError,
          })),
      },
      { resolveConsumerId: () => 'consumer-1', now: () => new Date('2026-09-03T00:00:00Z') }
    );
    const result = await handler(
      {
        account: { account_id: 'account-1' },
        idempotency_key: 'reporting-status-foreign-snapshot-0001',
        statuses: [
          consumerStatus({
            seller_ledger_snapshot_id: 'snapshot-foreign-account',
            seller_ledger_as_of: '2026-09-03T00:00:00Z',
          }),
        ],
      },
      { account: { id: 'account-1' } }
    );
    assert.equal(result.results[0].result, 'failed');
    assert.equal(result.results[0].errors[0].code, 'VALIDATION_ERROR');
  });
});
