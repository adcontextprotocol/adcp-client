const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Storage } = require('@google-cloud/storage');
const { createGcsReportingObjectFenceV1 } = require('../../dist/lib/reporting/gcs');
const { assertGcsReportingBucketPolicy } = require('../../dist/lib/reporting/gcs/bucket-policy');
const { reportingObjectWritePlanFingerprint } = require('../../dist/lib/reporting/ledger');

// Policy fields verified on the real, fresh, private GCS qualification bucket.
const safePolicy = require('../fixtures/reporting-gcs/bucket-policy.json');

test('policy guard rejects each recoverable-generation or access-policy drift', () => {
  assert.doesNotThrow(() => assertGcsReportingBucketPolicy(safePolicy));
  const unsafe = [
    { versioning: { enabled: true } },
    { softDeletePolicy: undefined },
    { softDeletePolicy: {} },
    { softDeletePolicy: { retentionDurationSeconds: '604800' } },
    { retentionPolicy: { retentionPeriod: '1' } },
    { defaultEventBasedHold: true },
    { objectRetention: { mode: 'Enabled' } },
    { lifecycle: { rule: [{ action: { type: 'Delete' }, condition: { age: 1 } }] } },
    { iamConfiguration: undefined },
    { iamConfiguration: { uniformBucketLevelAccess: { enabled: false }, publicAccessPrevention: 'enforced' } },
    { iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: 'inherited' } },
  ];
  for (const drift of unsafe) assert.throws(() => assertGcsReportingBucketPolicy({ ...safePolicy, ...drift }));
});

test('invalid inputs and caller cancellation fail before official client I/O', async () => {
  // No provider behavior or report data is substituted. Invalid input must never reach this real client.
  const fence = createGcsReportingObjectFenceV1({
    storage: new Storage(),
    store: {},
    bucket: 'owned-fixture-bucket',
    namespace: 'guard-test',
  });
  await assert.rejects(
    () => fence.write(null, 0, new Uint8Array()),
    error => error.code === 'INVALID_INPUT'
  );
  await assert.rejects(
    () => fence.revoke(null),
    error => error.code === 'INVALID_INPUT'
  );
  await assert.rejects(fence.register(null, 'delivery', [new Uint8Array()]), error => error.code === 'INVALID_INPUT');
  await assert.rejects(
    fence.register({ account_id: 'owner', destination_ref: 'destination', generation: 1 }, 'delivery', []),
    error => error.code === 'INVALID_INPUT'
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fence.probe({ signal: controller.signal }), error => error.code === 'ABORTED');
  await assert.rejects(
    fence.revoke({ account_id: 'owner', destination_ref: 'destination', generation: 1 }, { signal: controller.signal }),
    error => error.code === 'ABORTED'
  );
  assert.throws(() => reportingObjectWritePlanFingerprint(null));
});

test('error brands survive mixed CJS and ESM module instances', async () => {
  const cjs = require('../../dist/lib/reporting/ledger/object-writes');
  const esm = await import('../../dist/lib/reporting/ledger/object-writes.mjs');
  assert.equal(esm.isReportingObjectWriteConflictError(new cjs.ReportingObjectWriteConflictError()), true);
  assert.equal(cjs.isReportingObjectWriteConflictError(new esm.ReportingObjectWriteConflictError()), true);
  assert.equal(esm.isReportingObjectWriteNotRevokedError(new cjs.ReportingObjectWriteNotRevokedError()), true);
  assert.equal(cjs.isReportingObjectWriteNotRevokedError(new esm.ReportingObjectWriteNotRevokedError()), true);
  assert.equal(esm.isReportingObjectWriteConflictError(new Error('private backend details')), false);
});
