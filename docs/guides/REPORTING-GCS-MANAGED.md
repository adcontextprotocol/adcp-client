# Managed reporting delivery on GCS

`@adcp/sdk/reporting/gcs` supplies a complete `ReportingManagedDeliveryAdapterV1` for private GCS file transfer. It supports `manifest_checksums` and `canonical_digest` by uploading deterministic JSONL and manifest bytes, then inspecting actual provider bytes and digest-pinned private contracts. The managed runtime owns materialization settlement, cleanup leases, retries and capability publication. Verification is attributed to the producer; independent buyer qualification is a separate gate.

Install the optional official `@google-cloud/storage` peer. Use 7.22.x on Node 20.19 or later; Storage 8.2.x requires Node 22 or later. The default SDK import does not load Google Storage. Supply a host-owned official Storage client using ADC, workload identity or short-lived impersonation. Never persist credentials in reporting descriptors, contract URIs, `ctx_metadata`, inventory or error envelopes.

Apply `REPORTING_LEDGER_MIGRATION`, the applicable Core writer-fence migration, `REPORTING_MANAGED_DELIVERY_MIGRATION`, `REPORTING_OBJECT_WRITE_MIGRATION`, then `REPORTING_OBJECT_WRITE_AUTHORITY_MIGRATION` from `@adcp/sdk/reporting/ledger`. The last migration requires PostgreSQL 13 or later and creates one persistent installation UUID per isolated schema. Reapplying it preserves the UUID. Keep that row in backups and restores. **Never run delivery or cleanup from an independently writable clone of live authorization, inventory or materialization tables.** Such a clone would still address the original objects. Start a fresh isolated schema with a distinct deployment namespace and installation UUID, provision new destination grants, and import only the needed immutable Core facts. A restored replica of the same authority keeps its identity. Do not replace an identity while old write plans still exist. The adapter combines the UUID with your stable deployment namespace to avoid collisions between isolated schemas sharing a bucket.

Core and managed stores must share the exact same PostgreSQL pool, and Core must enable `managedDelivery: true`. The factory probes both stores and the provider policy before returning an adapter. Hosts supply pool acquisition/connect timeouts; transactions started with a signal additionally limit lock and statement waits. Readiness is bounded by the operation deadline, at most 60 seconds.

```typescript
import { Storage } from '@google-cloud/storage';
import { createGcsReportingManagedDeliveryAdapterV1 } from '@adcp/sdk/reporting/gcs';
import { createReportingManagedDeliveryRuntime } from '@adcp/sdk/reporting/ledger';

const adapter = await createGcsReportingManagedDeliveryAdapterV1({
  storage: new Storage(), // ADC/workload identity; no keys in reporting state
  coreStore,
  store: managedStore,
  bucket: dedicatedReportingBucket,
  namespace: stableDeploymentNamespace,
  acknowledgeDedicatedFreshBucket: true,
  // Both callbacks use authenticated saved host configuration.
  resolveExpectedPeriod: (input, context) => contracts.expectedPeriod(input.binding, context),
  resolveContractReader: (input, context) => contracts.privateReader(input.binding, context),
});
const runtime = await createReportingManagedDeliveryRuntime({
  coreStore,
  store: managedStore,
  adapter,
  offerings,
  automatedRecoveryWindowSeconds,
  statusRetentionDays,
  resourceRetentionDays,
  authorizationRevocationSeconds,
  resolveConsumerId,
});
```

The bucket must have been dedicated and safe before reporting bytes existed, with uniform access, enforced public-access prevention, explicit zero soft-delete retention, and no versioning, lifecycle, retention locks or object holds. The explicit acknowledgment is a host deployment assertion, not an SDK audit of historical recoverable bytes. Exclusively control bucket policy and object mutation through the trusted host. Follow [the fence policy and drift runbook](REPORTING-GCS-FENCE.md); the SDK refuses cleanup under incompatible policies rather than claiming that recoverable historical versions have been fenced. Preserve tombstones and write inventory indefinitely while stale requests may execute. Keep access to saved old bucket bindings through deployment changes.

Contract callbacks must independently select `ExpectedReportingPeriod` from the saved configuration and return `GcsReportingReaderOptionsV1` for that account, destination and current authorization generation. Pin report definition, row schema and canonicalization hashes when accepting the configuration. Save the exact private contract bucket and prefix separately from returned producer URIs. Report definitions and canonicalization documents require their protocol vendor MIME types; row schemas use `application/schema+json`. All documents still pass strict UTF-8/JSON, digest and existing schema safety checks.

For a buyer, `createGcsReportingResourceReaderV1` and `createGcsReportingReferenceResolverV1` accept a saved scope `{principal_id, account_id, destination_ref, generation}`, bucket, trailing-slash object prefix, an `authorize` callback and `getStorage`. The callback must verify principal ownership, account and destination generation, and exact bucket/prefix ownership. `storage.googleapis.com` origin alone is insufficient. Object keys may use letters, digits, slash, underscore, dot and hyphen; encoded paths, traversal, queries, fragments, userinfo and cross-prefix targets are refused before storage I/O. A manifest may select only simple sibling object references. Private contract failures redact refused URIs to avoid echoing credentials.

Readers authorize before obtaining an official client and again after buffering bytes. They select an exact provider generation, enforce configured byte caps and deadlines, and refuse revocation tombstones. Private document resolutions bypass every cache, including caller-supplied caches, so a previously resolved contract cannot bypass a closed grant. The generic canonical-reference API also exposes an optional `CanonicalDocumentReader` for host-authenticated transports; supplying it bypasses caches and HTTP fallback while preserving all existing validation. It is the transport's responsibility to bind credentials and authorization to the saved destination.

A repeated logical delivery reuses its frozen object plan and checks bytes after a create-only conflict. The adapter binds reads to the durable plan, manifest hash and native generation. Keep the deployment namespace stable while any write plans exist; rotating it requires a fresh authority and new grants. Set the adapter's `minimumResourceRetentionDays` to the runtime's value. Retention is extended after successful inspection with a deadline-sized settlement allowance; authoritative SQL settlement still refuses a resource under the strongest durable retention promise. An already-issued provider request can finish after a caller deadline. Follow-on work stops, inventory remains durable, and tombstones block late create-only writes. Do not treat timeout as rollback or successful cleanup.

The host passes authenticated ledger/configuration facts to the adapter. Its methods are infrastructure ports, not public buyer authorization endpoints. Expose reads and receipts through the existing account/principal-bound runtime and official MCP/A2A clients. No public capability is advertised until the runtime is fully wired and its policies adopted.

The buyer pins bucket and prefix through its authenticated destination-provisioning control plane before reading producer descriptors. A host destination grant can carry non-secret `{principal_id, account_id, destination_ref, generation, bucket, object_prefix}`; persist that grant as buyer configuration. Provisioning must obtain the prefix from the trusted provider binding and installation authority, never parse it from a returned resource URI. This SDK supplies readers for such grants; it does not implement your host's destination-provisioning endpoint. Row bytes use create-only keys and manifest hashes; the native generation selects the manifest, while each row object is independently hash-bound. Generic object MIME types do not relax JSONL decoding or integrity checks.

Choose payload limits that fit your measured network throughput: a delivery uploads and rereads its bytes, and a retry may reread them again. The 64 MiB ceiling is an upper bound, not a throughput promise. Apply host admission/concurrency and inventory quotas. Host contract callback failures use `HOST_CALLBACK_FAILED`; state and provider errors remain generic and secret-free.

Keep host clocks close to the database clock: resource expiry is proposed using the host clock, while SQL alone authorizes retention and reads. Clock lag beyond the settlement allowance fails delivery closed. Limit concurrent deliveries per account: the reused Core status reader admits 16 simultaneous lookups per account, and admission failures consume managed retry attempts. On large inventories, provision and monitor cleanup throughput against the advertised revocation window; SDK read gates close immediately at the authoritative grant, while direct provider readers lose each object when its tombstone is installed.
