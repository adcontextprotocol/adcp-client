const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  ReportingConsumerStatusV1Schema,
  createSyncReportingStatusHandler,
} = require('../../dist/lib/reporting/ledger/index.js');

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
        statuses: [{ ...consumerStatus(), ext: nested }],
      },
      { account: { id: 'account-1' } }
    );
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
});
