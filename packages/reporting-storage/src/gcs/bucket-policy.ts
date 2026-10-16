import type { BucketMetadata } from '@google-cloud/storage';

/** Pure policy guard shared by the real-provider probe and deterministic negative controls. */
export function assertGcsReportingBucketPolicy(metadata: BucketMetadata): void {
  if (
    !metadata ||
    metadata.versioning?.enabled ||
    metadata.softDeletePolicy?.retentionDurationSeconds === undefined ||
    Number(metadata.softDeletePolicy.retentionDurationSeconds) !== 0 ||
    Number(metadata.retentionPolicy?.retentionPeriod ?? 0) !== 0 ||
    metadata.defaultEventBasedHold === true ||
    metadata.objectRetention?.mode === 'Enabled' ||
    (metadata.lifecycle?.rule?.length ?? 0) > 0 ||
    metadata.iamConfiguration?.uniformBucketLevelAccess?.enabled !== true ||
    metadata.iamConfiguration?.publicAccessPrevention !== 'enforced'
  )
    throw new Error('Unsafe reporting GCS bucket policy');
}
