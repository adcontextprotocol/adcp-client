# Breaking: reporting row storage field alignment

Reliable Reporting row storage now stores every value in the format AdCP
already defines for it, and `{period_date}` is the period's calendar date in its
`source_timezone` instead of UTC. This is one deliberate breaking change, made
before any deployment activated row storage in production. It ships in the
15.9.0 release.

Affected: anyone who applied `REPORTING_ROW_STORAGE_MIGRATION`, configured
`rowStorage`, or wrote a custom `ReportingRowObjectProviderV1`. Not affected:
the wire (`revision_content_sha256` and every other buyer-visible value is
unchanged), PostgreSQL-kind row storage behavior, and anyone who never installed
the row-storage tables.

## Upgrading

Apply the new `REPORTING_ROW_STORAGE_MIGRATION` before starting any binary that
contains this change, and stop older writers first: they read the old column
names and fail against the renamed tables. A new binary refuses to start row
storage against an un-migrated database (`probeReportingRowStorageSchemaV1`
names the missing columns). The migration takes a brief exclusive lock on the
row-storage tables, so apply it in a maintenance window. It is idempotent,
serialized by an advisory lock so concurrent appliers cannot race, runs on a
fresh install, and on an installed database it:

- renames the columns listed below in place, keeping every recorded location;
- replaces `encoding` with `format` and `algorithm`, backfilled to `jsonl` and
  `adcp_jcs_rows_v1` (the old column admitted exactly one value);
- adds the AdCP length checks (a database that already holds an out-of-bounds
  key fails the migration with a message naming the count, and rolls back);
- rewrites open write intents' `created_objects` from `objectKey` /
  `nativeVersion` to `object_ref` / `native_version_ref`.

If you installed the row-storage tables but never activated them, the in-place
migration is enough: there is nothing to preserve. Dropping the tables to start
clean also works, but it discards `adcp_persistence_installation`, so the new
installation ID changes every binding's `namespace_key` and with it the object
key prefix. Do not drop tables that contain row sets.

The migration does not rewrite object keys. Objects written before the upgrade
keep the key recorded in `object_ref`, rendered under the old UTC rule with a
`yyyy/MM/dd` layout. Reads, retention and deletes use the recorded key, so they
keep working. New writes render the new key, so a period re-written after the
upgrade may sit at a different key than its earlier objects, and an upload that
was in flight across the upgrade can leave its old-key object behind. Re-sync
instead of upgrading in place if you want every object under the new layout.

## Object key templates require `{revision_key}`

Every writable object binding's `keyTemplate` must now include
`{revision_key}`, not only when snapshot compaction is on, so no two row sets
can ever name the same object key. The default template already includes it.
The store throws `INVALID_INPUT` when a binding is configured and again in
`readyRowStorage` if a template omits it. A custom template without it must
add it, under a new binding ID (a binding's identity digest includes its
template).

Objects already written stay readable: reads use each chunk's recorded
`object_ref`, not a re-rendered key. Keep the old binding definition
configured while revisions reference it, and mark it `readOnly: true`; a
read-only binding is exempt from the requirement, is never chosen for new
writes, and is still used for reads and retirement (`readyRowStorage` still
probes it, so keep its location reachable). Compaction ignores read-only
bindings, because nothing can adopt through them. The
reference-checked deletes and the per-object lock are unchanged, because
header-only revisions still share chunks within an obligation.

## Renamed fields

| Before                                          | After                                       | AdCP definition                                           |
| ----------------------------------------------- | ------------------------------------------- | --------------------------------------------------------- |
| `adcp_reporting_row_chunks.object_key`          | `object_ref` (1 to 1024 characters)         | `reporting-file-object-ref.json`                          |
| `adcp_reporting_row_chunks.native_version`      | `native_version_ref` (1 to 1024 characters) | `reporting-native-version-ref.json`                       |
| `adcp_reporting_row_chunks.physical_byte_count` | `size_bytes`                                | `reporting-file-entry.json` `size_bytes`: stored size     |
| `adcp_reporting_row_chunks.byte_count`          | `canonical_size_bytes`                      | uncompressed canonical bytes; the digest-pinned manifest  |
| `adcp_reporting_row_sets.canonical_byte_count`  | `content_size_bytes`                        | size of the content `content_sha256` covers (the binding's byte count) |
| `adcp_reporting_row_sets.encoding`              | `format` = `jsonl`, `algorithm` = `adcp_jcs_rows_v1` | `reporting-file-manifest.json` `format`, `reporting-canonicalization-contract.json` `algorithm` |

`size_bytes` means what it means in the AdCP file manifest: the size of the
stored object, after compression. The uncompressed canonical size is a separate
value because chunk and segment digests, byte ranges and the binding verify
against it. A row set's `content_size_bytes` is a third quantity: the byte count of
the content `content_sha256` digests, which for a revision includes the
envelope, so it is not the sum of its chunks' `canonical_size_bytes`. Manifest JSON field names (`byte_count`, `byte_offset`) are
digest-pinned and did not change.

TypeScript and provider API:

- `ReportingRowChunkLocatorV1`: `objectKey` is `objectRef`, `nativeVersion` is
  `nativeVersionRef`, `physicalByteCount` is `sizeBytes`.
- `ReportingRowObjectProviderV1`: inputs take `objectRef` (was `key`) and
  `nativeVersionRef` (was `nativeVersion`); `putIfAbsent` returns
  `{ created, nativeVersionRef }`. Add the optional
  `stat({ objectRef, nativeVersionRef })` returning
  `{ nativeVersionRef, sizeBytes }` (the version it resolved, which must equal the
  one asked for, and the stored size) or `null`.
  The commit transaction uses it to prove an adopted object unchanged without
  re-downloading it under the account lock; a provider without `stat` falls back
  to the full read. Every bundled provider implements it, and
  `runReportingRowObjectProviderConformanceV1` checks it (new
  `version-pinned-stat` entry).
- `ReportingRowBindingSelectionInputV1.canonical_byte_count` is
  `content_size_bytes`; `ReportingRowSetHandleV1.canonicalByteCount` is
  `contentSizeBytes`.
- `ReportingRowSetPrepareInputV1` takes `sourceTimezone` next to `periodStart`;
  a `periodStart` without a usable `sourceTimezone` fails with `INVALID_INPUT`.
- `REPORTING_ROW_ENCODING_V1` is replaced by `REPORTING_ROW_FORMAT_V1`
  (`jsonl`) and `REPORTING_ROW_ALGORITHM_V1` (`adcp_jcs_rows_v1`);
  `encodeReportingRowsV1` returns `format` and `algorithm` instead of `encoding`.

## `{period_date}`

The placeholder name is unchanged. It now renders AdCP's `YYYY-MM-DD`: the
calendar date of the period start in the period's `source_timezone`, as one path
segment. A period starting `2026-10-02T07:00:00Z` in `America/Los_Angeles` is
`2026-10-02`; one starting `2026-10-01T15:00:00Z` in `Asia/Tokyo` is also
`2026-10-02`. The old rendering used the UTC date and split it into
`yyyy/MM/dd` directories. A missing, unknown or non-IANA timezone fails the
write rather than guessing a date. The default key template string did not
change, so existing binding identities remain valid.

If you built tooling that lists objects by `yyyy/MM/dd` directory, list by the
single `YYYY-MM-DD` segment, or read the recorded `object_ref` from
`adcp_reporting_row_chunks`.

## Digests

`adcp_jcs_rows_v1` names the per-row RFC 8785 canonicalization the stored rows
use. A revision's `content_sha256` is still the envelope digest
(`revision_envelope_v1`), not AdCP's array-shaped content digest; only an
adjustment's `rows_v1` digest has that shape. The format and algorithm tokens
label the encoding; they are not an input to any
chunk, segment, manifest or protocol digest. No digest changed. The shared
golden fixture `test/fixtures/reporting-row-storage-v1.json` replaced its
top-level `encoding` label with `format` and `algorithm`; every expected digest
and byte count is identical. Other SDKs sharing the fixture must adopt the new
labels and storage names but reproduce the same bytes.
