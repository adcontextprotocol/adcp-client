const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createReportingStatusHandler, createSyncReportingStatusHandler } = require('../../dist/lib/reporting/ledger');
const { ADCP_VERSION, toReleasePrecisionVersion } = require('../../dist/lib/version');
const { getValidator } = require('../../dist/lib/validation/schema-loader');
const { MemoryLedgerStore } = require('../helpers/memory-reporting-ledger-store');

for (const [requested, served, expected] of [
  ['3.2', undefined, '3.2'],
  [undefined, undefined, toReleasePrecisionVersion(ADCP_VERSION)],
  [toReleasePrecisionVersion(ADCP_VERSION), '3.2.7', '3.2'],
]) {
  test(`reporting helpers preserve the served contract: request=${requested}, context=${served}`, async () => {
    const store = new MemoryLedgerStore();
    const context = { account: { id: 'account-1' }, ...(served && { servedAdcpVersion: served }) };
    const envelope = requested ? { adcp_version: requested } : {};
    const read = await createReportingStatusHandler(store)(
      { ...envelope, account: { account_id: 'account-1' }, view: 'periods' },
      context
    );
    assert.equal(read.status, 'completed');
    assert.equal(read.adcp_version, expected);
    const readValidator = getValidator('get_reporting_status', 'sync', served ?? requested ?? ADCP_VERSION);
    assert.equal(readValidator(read), true, JSON.stringify(readValidator.errors));
    // The account-denial result is also a complete, versioned sync envelope.
    const write = await createSyncReportingStatusHandler(store, { resolveConsumerId: () => 'consumer' })(
      {
        ...envelope,
        account: { account_id: 'different-account' },
        idempotency_key: 'reporting-version-test',
        statuses: [{ reporting_status_id: 'status-1' }],
      },
      context
    );
    assert.equal(write.status, 'completed');
    assert.equal(write.results[0].errors[0].code, 'PERMISSION_DENIED');
    assert.equal(write.adcp_version, expected);
    const writeValidator = getValidator('sync_reporting_status', 'sync', served ?? requested ?? ADCP_VERSION);
    assert.equal(writeValidator(write), true, JSON.stringify(writeValidator.errors));
  });
}

test('an unavailable reporting release is refused before consumer resolution or writes', async () => {
  let resolutions = 0;
  const sync = createSyncReportingStatusHandler(new MemoryLedgerStore(), {
    resolveConsumerId: () => {
      resolutions++;
      return 'consumer';
    },
  });
  await assert.rejects(
    sync(
      {
        adcp_version: '3.9',
        account: { account_id: 'account-1' },
        idempotency_key: 'reporting-version-test',
        statuses: [{ reporting_status_id: 'status-1' }],
      },
      { account: { id: 'account-1' } }
    ),
    error => error.code === 'VERSION_UNSUPPORTED'
  );
  assert.equal(resolutions, 0);
});
