# Durable GCS reporting write fence

`@adcp/sdk/reporting/gcs` provides a provider write-fence primitive backed by the existing PostgreSQL destination authority. It is a building block for a managed delivery adapter; it does not advertise Managed Delivery or Reconciled Billing capabilities or implement `ReportingManagedDeliveryAdapterV1`.

Install the optional official Google client with `npm install @google-cloud/storage@^7.22.0` for Node 20 or Node 22+. Google client `^8.2.0` is also supported on Node 22+. This peer is required when compiling or using the GCS subpath, including its public types; other SDK subpaths remain independent. Apply `REPORTING_LEDGER_MIGRATION`, `REPORTING_MANAGED_DELIVERY_MIGRATION`, then the additive `REPORTING_OBJECT_WRITE_MIGRATION` from `@adcp/sdk/reporting/ledger` in the same isolated tenant schema. Apply the final migration to a fresh object-write schema if experimenting with earlier, unpublished versions of these tables: `CREATE TABLE IF NOT EXISTS` does not upgrade incompatible prerelease tables.

```typescript
import { Storage } from '@google-cloud/storage';
import { createGcsReportingObjectFenceV1 } from '@adcp/sdk/reporting/gcs';

const fence = createGcsReportingObjectFenceV1({
  storage: new Storage({ retryOptions: { totalTimeout: 60, maxRetries: 3 } }), // Host-owned ADC; retry timeout is in seconds.
  store, // PostgresReportingManagedDeliveryStore in the tenant's isolated schema.
  bucket: hostConfiguredBucket,
  namespace: deploymentNamespace,
});
const plan = await fence.register(scope, immutableDeliveryId, [rowsBytes, manifestBytes]);
await fence.write(plan, 0, rowsBytes, { signal });
await fence.write(plan, 1, manifestBytes, { signal });
```

The host derives `scope` (`account_id`, `destination_ref`, `generation`), delivery identity, bucket and namespace from authenticated, saved configuration. These are trusted server methods, not an authorization API for buyer-supplied identifiers. Bucket names currently accept lowercase letters, digits, dots and hyphens; underscores are outside this primitive’s accepted input subset. Use a deployment namespace unique across isolated databases sharing a bucket. Identities are hashed into deterministic object names; credentials, signed URLs, resumable session URIs and other secrets never belong in plans or namespaces.

Registration freezes every writable object name and byte hash under the same account/destination advisory locks as `revokeDestination`. It binds the bucket and namespace digest immutably to that authorization generation. Changes require a new generation. Each plan allows at most 128 objects and 64 MiB in aggregate. Writes use `ifGenerationMatch: 0`; retries inspect and hash the exact existing generation, and refuse tombstones or different content.

Commit the existing durable destination revocation before provider cleanup:

```typescript
await store.revokeDestination({ ...scope, revoked_at: new Date().toISOString() });
let complete = false;
while (!complete) {
  ({ complete } = await fence.revoke(scope, { signal, maxObjects: 10 }));
}
```

The default `maxObjects` page is 10. Choose a small page for remote providers. If cleanup exceeds its deadline, catch `DEADLINE_EXCEEDED` and resume in another worker tick with a fresh signal; previously recorded progress remains durable. Never interpret a thrown timeout as completed cleanup.

Cleanup routes through the stored provider binding even if the host's current factory namespace or bucket changes. The bucket policy is probed even when inventory is already fully fenced, so keep the bucket and credentials available until the cleanup lease has completed. Alert on repeated `PROVIDER_UNAVAILABLE` for a scope: one failing object can prevent the page from progressing, and provider permissions or an excluded external writer require administrator remediation. The injected Google client must retain access to every old bound bucket until cleanup completes. A page replaces each registered name, including pending uploads, with a persistent empty tombstone using a generation precondition, verifies the tombstone, and records progress. The first recorded tombstone generation is immutable. A new worker can resume after a provider write succeeds but SQL recording fails. `complete` means the closed inventory has no unfenced names, not that the host has completed a managed-delivery cleanup lease; that integration remains the adapter's responsibility.

The bucket must have uniform access and enforced public access prevention, explicitly disabled soft delete, disabled versioning, no retention policy, no default event hold, no enabled object retention and no lifecycle rules. `probe()` fails closed for incompatible policies; `storage.buckets.get`, `storage.objects.get`, `storage.objects.create` and `storage.objects.delete` are required: replacing existing bytes with a tombstone needs delete permission as well as create permission. Metadata-update permission alone cannot overwrite an object. This lists operational requirements, not a least-privilege deployment qualification; see [Google upload permissions](https://docs.cloud.google.com/storage/docs/uploading-objects). Provision these settings before any report bytes are stored. Disabling soft delete or versioning later does not erase existing recoverable generations. Use a dedicated fresh bucket, with policy and metadata changes restricted to trusted host administrators. The primitive cannot fence an administrator who changes policy, restores old bytes, deletes tombstones or writes without the create-only contract.

If a probe reports `UNSAFE_BUCKET`, stop new deliveries, preserve inventory and report incomplete revocation. Restore the original safe bucket settings under the host administrator’s control, inspect archived or soft-deleted generations created during drift, remove their consumer access with provider administration, then resume cleanup and verify old-version denial. The primitive refuses to claim complete fencing while policy makes old bytes recoverable; restoring settings alone cannot establish that those old generations are gone.

Retain write inventory and tombstones for as long as any stale request can execute. Do not prune them, expire them with lifecycle rules, or delete then recreate an object. Required audit bytes belong in a separate owner-only archive unavailable to revoked consumers; archival retention is not implemented here.

Operations have a deadline of at most 60 seconds and accept caller cancellation. Expiry stops new follow-on operations initiated by this primitive and destroys active verification streams. An already-issued Google client operation can continue its internal retries after expiry; configure `retryOptions.totalTimeout` (seconds) and `maxRetries` to bound that work. An already-issued upload or database commit can have an unknown outcome after expiry. See the [Google retry strategy](https://docs.cloud.google.com/storage/docs/retry-strategy). Retry from the frozen plan or closed inventory; never assume timeout proves that nothing was written. PostgreSQL methods honor cancellation between queries and before commit, with five-second lock and ten-second statement timeouts when a signal is provided. Configure a finite connection acquisition timeout in the host's pool. Rollback and connection release still run after cancellation.

`ReportingGcsFenceError.code` is stable (`INVALID_INPUT`, `UNSAFE_BUCKET`, `REVOKED`, `NOT_REVOKED`, `CONTENT_CONFLICT`, `ABORTED`, `DEADLINE_EXCEEDED`, `PROVIDER_UNAVAILABLE`, `STATE_UNAVAILABLE`). `NOT_REVOKED` includes a missing generation: commit the durable revocation before cleanup. All operations reject a promise on failure; switch on `code` rather than cross-module `instanceof` checks. Signals must be native Node `AbortSignal` instances. Public errors omit raw provider/store causes. Upload success still needs physical report verification and generation-fenced availability settlement through the existing managed delivery runtime; this primitive supplies neither contract reads nor buyer credentials.

The live worker at `scripts/reporting-interop/gcs-fence.cjs` exercises real resumable uploads finishing after expiry/revocation, committed old-generation denial, process recovery, namespace rotation, deadline cancellation and error privacy against an installed candidate package, real PostgreSQL and a private temporary GCS bucket. Its pinned report fixtures are test evidence, not production data. Qualification of this primitive does not establish a complete adapter, independent Python buyer verification, or least-privilege production deployment.

Provider guarantees: [request preconditions](https://docs.cloud.google.com/storage/docs/request-preconditions), [consistency](https://docs.cloud.google.com/storage/docs/consistency), and [bucket policy fields](https://docs.cloud.google.com/storage/docs/json_api/v1/buckets).
