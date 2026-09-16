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

### Adapt an existing delivery handler

`createInlineReportingSourceExecutor(fetch, offering)` is the shortest migration path for an existing synchronous or promise-returning `get_media_buy_delivery`-shaped fetch. It returns one object implementing both the executor and staged-object reader interfaces and emits a `basic` manifest.

```ts
import { createInlineReportingSourceExecutor } from '@adcp/sdk/reporting/source';

const source = createInlineReportingSourceExecutor(getMediaBuyDelivery, offering);
```

Return `null` while the report is not ready, `[]` for a real observed zero-row period, and rows for success. A `get_media_buy_delivery` response must include its exact `reporting_period`, matching `currency`, and either `reporting_rows` or `media_buy_deliveries`. An unclassified throw becomes retryable `SOURCE_TRANSIENT`; throw `InlineReportingSourceError` to retain a specific typed classification. Partial-data flags, unavailable counts, response errors, and unproved full constituent coverage fail closed with `PARTIAL_RESULT`.

When availability differs by metric, add the versioned `availability_evidence` envelope to the existing response object. The callback request supplies the frozen `constituents` mapping; use its `constituent_id` values rather than deriving manifest identities from media-buy IDs. Cells cover the exact requested constituent/metric matrix once each. The adapter supplies semantic-contract IDs and checksums from the offering.

```ts
const source = createInlineReportingSourceExecutor(async input => ({
  reporting_period: { start: input.start_date, end: input.end_date },
  currency: 'USD',
  reporting_rows: [
    { media_buy_id: input.constituents[0]!.media_buy_id, impressions: 10, clicks: 0 },
  ],
  availability_evidence: {
    version: '1.0',
    cells: [
      {
        constituent_id: input.constituents[0]!.constituent_id,
        metric: 'impressions',
        status: 'present',
        data_through: input.end_date,
      },
      {
        constituent_id: input.constituents[0]!.constituent_id,
        metric: 'clicks',
        status: 'explicit_zero',
        data_through: input.end_date,
      },
      {
        constituent_id: input.constituents[0]!.constituent_id,
        metric: 'viewability',
        status: 'delayed',
        reason: 'Provider processing is not closed',
      },
    ],
  },
}), offering);
```

`present` and `explicit_zero` require `data_through` and forbid a reason. `unsupported`, `delayed`, `partial`, `stale`, and `missing` require a bounded reason and may carry `data_through`. Reasons are retained in durable manifest evidence: use stable non-secret explanations, never credentials or raw provider payloads. A row must contain every metric marked `present`; when that constituent has rows, every row must also carry zero for a metric marked `explicit_zero`. A row proves every constituent that names its `media_buy_id`, so when several constituents share one media buy they are each held to their own cells against that same row. Rows cannot contain values for `unsupported`, `delayed`, or `missing` cells. Mixed cells roll up to existing manifest constituent and coverage states in the request's canonical constituent/metric order. A request for full coverage still returns `PARTIAL_RESULT` when the cell matrix proves only partial or no coverage, and an authoritative/final response cannot seal until every cell is present or explicit-zero through period end.

Malformed versions or cells, duplicates, missing cells, unrequested constituent/metric keys, invalid watermarks, and row/evidence contradictions fail with `INTEGRITY_FAILED` before objects are staged. Evidence with no rows may prove either that every cell is explicit-zero or that cells are unavailable; it cannot combine available and unavailable claims without rows. A row that repeats one metric both directly and under `totals` must repeat the same quantity; a contradictory second claim is `INTEGRITY_FAILED` rather than a silently preferred direct value. The two claims are compared as exact decimals, so a number printed in exponent notation matches the equivalent plain decimal (`1e-7` and `"0.0000001"` are one quantity), while a decimal string is read digit for digit and is never rounded onto a nearby number. The evidence envelope and each of its cells must carry only their own declared fields as plain own data properties, each within a bounded length that is checked before the value reaches validation -- a validator runs every one of its checks even once one has failed, so an unbounded value would otherwise be walked in full before being refused. The key set is checked against that allowlist before any descriptor is read, and an accessor-backed or inherited cell field is refused rather than invoked, so a cell cannot compute or inherit the `status` that proves it. Omitting `availability_evidence` retains the prior all-cells-derived behavior for row arrays and existing response objects, but the envelope must be supplied as a plain own data property: an accessor-backed or inherited `availability_evidence` slot is `INTEGRITY_FAILED` and is never read, because reading it is unsafe and ignoring it would silently downgrade the response to derived availability. That classification comes from one bounded descriptor observation, and the value captured by that same observation is what gets parsed, so a slot that presents itself differently each time it is examined cannot reach the downgrade either. A prototype chain that cannot be walked to an end -- cyclic, or regenerated on every hop -- is likewise `INTEGRITY_FAILED`.

`reporting_rows` and `media_buy_deliveries` are read through the ordinary property channel, so a class instance, a prototype-inherited value, and an accessor-backed slot are all accepted as before; each is read once and the collection that is validated is the collection that is staged. Each row inside them is likewise observed once: its `media_buy_id`, `currency`, `status`, and the direct and `totals` claim for every requested metric and dimension are captured in a single pass, and budgeting, validation, projection and the staged bytes all read that capture. A `totals` that aliases its own row addresses the same slot twice and is read once. Without `availability_evidence` a valid direct value settles its metric and `totals` is not consulted for it at all; with evidence both claims are read, because a duplicate claim must be reconciled rather than silently preferred. A requested metric or dimension named after one of the adapter's own row fields -- `media_buy_id`, `currency`, `status`, `partial_data`, `totals` -- resolves to that same single observation rather than taking a second one. A row's own `status` is settled before any other field of that row is observed -- `partial_data` included -- so a row its status already settles costs nothing beyond that one read. The same holds for the response envelope itself: `status` is read once and every verdict it decides -- reported failure, unavailable data, and the not-ready states -- is settled before anything else is touched at all, so a response that reports one of them beside a field or collection that throws on access keeps its retryable verdict. Each remaining response field is read at most once and only when a check actually needs it, so a field no check reaches is never observed: `notification_type` goes unread when `is_final` already proves finality. A `status` that is present but is not a string is an unreadable response rather than an absent status. `is_final`, `notification_type`, `partial_data`, `unavailable_count`, `errors`, `pagination`, `reporting_period`, `currency`, `data_through` and `observed_at` are then each read once, each period boundary included, so a period cannot be proven from one object and a currency from another. A control field that is present but malformed -- `unavailable_count: '5'`, `errors: 'boom'`, a non-string watermark -- is treated as the partial or invalid evidence it is, never narrowed into an absent one. Row collections are copied by index against the length they declare, never by spreading, and that length is observed once: a collection whose iterator or second answer disagrees with it cannot materialize more rows than the cap admits, nor have rows it delivered dropped from the staged object. A row whose fields answer differently when read again cannot be priced as one shape and processed as another -- the first answer is the only answer. Only `availability_evidence` is restricted to a plain own data property, because an evidence slot that reads as omitted changes which availability rules apply, whereas a row collection that reads as omitted is simply a failure.

The inline adapter narrows the supplied offering to `basic`, non-paginated `media_buy` execution. Every nonzero row must identify an admitted `media_buy_id` and contain each requested dimension; `media_buy_id` may also be requested as a metric, and the row identity proves it. Without `availability_evidence`, it must also contain every requested metric (directly or under `totals`); extra or unidentified rows are rejected. Only availability verification reads the auxiliary collection's claims, so without evidence its rows are observed for their `media_buy_id` alone -- enough to scope-check them -- and their metric and dimension fields are neither read nor billed. Only the identifier and requested evidence fields are retained. `[]` is the only implicit proof of an all-zero period. A response that omits both row collections is a failure, and unfinished pagination is partial. Authoritative publication additionally requires `is_final: true` or a `final`/`adjusted` notification. The fetch context carries the frozen source settings and semantic contract; group reads are rejected because this compatibility adapter cannot prove them. Each inline executor instance admits at most 100 retained executions and 32 MiB per caller scope, 1,000 executions and 256 MiB total, 16 concurrent fetches, 64 MiB per object, and 5,000,000 validation work units per response. One unit is one requested metric or one requested dimension checked against one row for one constituent, so the budget prices metric breadth, dimension breadth and constituent fanout together -- a row is checked against every constituent naming its `media_buy_id`, and sharing one media buy across many constituents spends the budget that many times over. A second budget caps the characters validation may scan while measuring and canonicalizing claims at one staged object's worth (64 MiB), counted per occurrence and per pass, so a long value reused across rows or restated under `totals` cannot buy an unbounded number of scans; a claim is scanned for its byte width, for the zero test and for the canonical decimal form behind a duplicate comparison, and each pass is charged and computed at most once. A number is charged the width it canonicalizes to, not one character, because exponent notation expands when the decimal point is shifted into plain form. A third bound holds the captured claims themselves to the per-object staging ceiling (64 MiB). Claims live in one value array and one flag array shared by every row, so what is held stays proportionate to what is written: with rows capped at 100,000 and the work budget capped at 5,000,000 units the widest admissible request holds about 48 MB, which makes this ceiling an assertion of that arithmetic rather than a limit adopters meet. It is deliberately not the per-scope limit, because the estimate is an upper bound on held bytes while that limit governs written bytes -- held against it, reports the staging cap admits were refused. All three are settled from counts before the work is attempted, so an over-budget request is refused rather than performed. Row status and row currency are decided in their own streaming passes ahead of that capture, so a response whose first row already settles the outcome does not pay to read the rest, and a status too long to be one the adapter recognizes is never case-folded. Capacity exhaustion is terminal for that instance; replace it with a durable executor when those bounded compatibility limits are too small.

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
