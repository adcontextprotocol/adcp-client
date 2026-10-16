const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { REPORTING_LEDGER_MIGRATION, PostgresReportingLedgerStore } = require('@adcp/reporting-storage');
const { REPORTING_NOTIFICATION_ACTIVITY_MIGRATION } = require('@adcp/reporting-storage/notifications');

describe('Reliable Reporting migrations', () => {
  test('exports one idempotent migration for the complete store surface', () => {
    for (const table of [
      'configurations',
      'obligations',
      'revisions',
      'adjustments',
      'consumer_statuses',
      'issues',
      'snapshots',
      'checkpoints',
    ]) {
      assert.match(REPORTING_LEDGER_MIGRATION, new RegExp(`CREATE TABLE IF NOT EXISTS adcp_reporting_${table}`));
    }
    assert.match(
      REPORTING_NOTIFICATION_ACTIVITY_MIGRATION,
      /CREATE TABLE IF NOT EXISTS "adcp_reporting_notification_activity"/
    );
  });

  test('the store lists its ledger migration for service.setup.migrations', () => {
    const store = new PostgresReportingLedgerStore(
      { query: async () => ({ rows: [] }), connect: async () => ({}) },
      {
        acknowledgeIsolatedDatabase: true,
      }
    );
    assert.deepEqual(store.migrations, [REPORTING_LEDGER_MIGRATION]);
    assert.equal(Object.isFrozen(store.migrations), true);
  });
});
