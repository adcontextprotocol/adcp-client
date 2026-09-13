# Reporting Source Executor

`@adcp/sdk/reporting/source` is the seller-side adapter boundary for Reliable Reporting Core. A publisher, seller adapter, or SSP implements one executor without taking dependencies on a particular scheduler, database, or provider SDK.

The existing buyer-side `reconcileReporting` API is unchanged.

## Day 1: register an executor

Implement `ReportingSourceExecutorV1` and `ReportingSourceStagedObjectReaderV1`. Keep `sourceScope` opaque: the caller defines and freezes it, while the executor echoes it and uses it to scope immutable staged-object reads.

Never place credentials, tokens, personal data, or raw source payloads in `sourceScope`. It is copied into durable manifest evidence. Store only stable non-secret routing identifiers and re-derive credentials per request, following the same boundary described in [ctx_metadata Safety](./CTX-METADATA-SAFETY.md).

```ts
import type {
  ReportingSourceExecutorV1,
  ReportingSourceStagedObjectReaderV1,
} from '@adcp/sdk/reporting/source';

export const source: ReportingSourceExecutorV1 & ReportingSourceStagedObjectReaderV1 = {
  capabilities,
  async execute(request, { signal, heartbeat }) {
    // Read exactly request.period.start <= event time < request.period.end.
    // Return PARTIAL_RESULT instead of completing a requested full-coverage slice.
    return executeBoundedSourceRead(request, { signal, heartbeat });
  },
  async read(object) {
    // Authorize every identity and enforce object.maxBytes while streaming.
    return readGenerationPinnedObject(object);
  },
};
```

Treat `sourceExecutionKey` as an idempotency key. Replays return the identical manifest bytes and generation-pinned objects. On abort, cancel owned source work and await its settlement before `execute` returns.

`logicalSliceFingerprint` is caller-owned planning lineage, not an adapter-computed checksum. The adapter treats it as opaque; conformance verifies that responses, manifests, replays, and revision lineage echo the frozen value.

The object reader MUST authorize and confine every `objectRef` to the supplied `sourceScope`, account, delivery configuration, report definition, and obligation tuple. The harness supplies scope from the frozen request, never from the manifest. Its default pre-read budget is 512 MiB per object and 2 GiB per slice; pass `objectReadLimits` to conformance when a declared adapter format legitimately needs different bounds.

Call the optional host-supplied `heartbeat` after meaningful source progress while a leased worker owns the slice. It is a synchronous liveness signal, not reporting evidence.

## Pick offering defaults

Start with one atomic offering per publication class and semantic contract. Choose `basic` when the adapter can prove identity, object hashes, coverage, finality, and terminal completeness. Choose `evidenced` when it also retains every source page/request ID, async-job poll, retry attempt, and usage count.

Conservative first defaults are a single source-day window, scheduled polling with polling fallback, no async jobs unless the source requires them, and `basic` manifest support. Declare only metrics, dimensions, formats, and attribution settings the adapter can satisfy exactly.

`null` and missing data are not zero delivery. A complete zero-row source result uses `explicitZero: true`; an unavailable full-coverage result returns `PARTIAL_RESULT` or `NOT_READY`.

All reporting periods and `eventTimeRange` values use half-open `[start, end)` semantics. `eventTimeRange.end === period.end` means rows were observed up to the exclusive period boundary; it never admits an event at that instant.

## Day 2: run conformance

Use the redacted fixtures to bring up the harness, then substitute a deterministic sandbox request for the real adapter.

```ts
import {
  redactedReportingSourceCapabilitiesV1,
  redactedReportingSourceRequestV1,
  redactedReportingSourceResultV1,
  runReportingSourceReplayConformanceV1,
  validateReportingRevisionSequenceV1,
} from '@adcp/sdk/reporting/source';

const request = redactedReportingSourceRequestV1();
const fixture = redactedReportingSourceResultV1('basic', request);
const fixtureSource = {
  capabilities: redactedReportingSourceCapabilitiesV1,
  execute: async () => fixture.result,
};

const first = await runReportingSourceReplayConformanceV1({
  level: 'basic',
  executor: fixtureSource,
  request,
  objectReader: fixture.objectReader,
});

validateReportingRevisionSequenceV1([first]);
```

Run the harness once for every level an offering declares. It verifies capability binding, half-open windows, fail-closed coverage, canonical manifest bytes, SHA-256 object bindings, terminal pagination/jobs, deadline cancellation, replay, and non-regressing revision freshness.

Use `buildReportingSourceManifestV1()` to derive the publication ID, object-set hash, coverage hash, content hash, canonical bytes, and reference in the required order. This avoids hand-assembling digest-dependent fields.

Published schemas are available under `@adcp/sdk/reporting/source/schemas/*.json`. They describe the transport shape; cross-field refinements such as fingerprint equality, coverage truth, and temporal ordering are enforced by the conformance functions because JSON Schema cannot express them portably. The exported `canonicalJsonUtf8V1GoldenVectors` are the byte-for-byte TypeScript/Python/Go parity anchor.

Contract URIs receive a structural public-HTTPS check only. If an application dereferences them, it must also apply DNS resolution and redirect-aware SSRF controls.
