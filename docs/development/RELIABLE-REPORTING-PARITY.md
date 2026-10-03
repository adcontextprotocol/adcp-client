# Reliable Reporting Python/TypeScript parity

This is the release gate for cross-SDK Reliable Reporting parity. It compares
the TypeScript SDK to `adcp-client-python` at `5fd54334` (audited 2026-09-25).
The implementations intentionally use language-native API shapes; parity means
the same wire behavior, durability guarantees, failure semantics, and
production capability truth, not identical class names.

At that audited Python commit, the TypeScript SDK is a safe superset on the
buyer side: Python implements the seller adjustment ledger, while TypeScript
also independently verifies post-official adjustments and persists adjustment
receipt checkpoints. Exact buyer-adjustment parity remains a Python-side
follow-up; the rows below distinguish shared proof from TypeScript-only proof
instead of treating an unimplemented peer capability as verified.

## 2026-09-27 interoperability checkpoint

The [published Python `adcp==8.0.0b16` wheel](https://pypi.org/project/adcp/8.0.0b16/) (SHA-256
`7589a546cacdddce3a7a827adaa11d4ccab34768c558689b1c6850b85cd098b1`)
passes all seven shared canonical JSON vectors byte-for-byte. The published
TypeScript `@adcp/sdk@14.0.0-rc.48` reference-seller run against the Python
`v8.0.0-beta.16` source revision was **partial**: 30 steps passed, 11 failed,
and 155 were skipped. Most failures arise because the Python example seller
advertises `canonical_creatives=false` under AdCP 3.2. The [workflow run](https://github.com/adcontextprotocol/adcp-client/actions/runs/36349220286)
is green only because the Python row is advisory.
Python beta.16 speaks AdCP rc.6, so a TypeScript rc.7 candidate against that
seller is a version-skew probe, not matching-release qualification.

That storyboard is a general reference-seller smoke test. The installed,
PostgreSQL-backed reporting matrix remains tracked in
[Python issue #1199](https://github.com/adcontextprotocol/adcp-client-python/issues/1199);
this checkpoint does not qualify its untested status, receipt, or replay flows.

## 2026-09-28 Python beta.18 checkpoint

The [published `adcp==8.0.0b18` wheel](https://pypi.org/project/adcp/8.0.0b18/)
(SHA-256 `3eabf30fbdae298111f3bbb4f4efb36f193dd08d7845217948ed211d7476e2c3`)
reports AdCP `3.2.0-rc.7` and passes all seven shared canonical JSON vectors
when imported from its installed wheel. Its source tag is
[`v8.0.0-beta.18`](https://github.com/adcontextprotocol/adcp-client-python/releases/tag/v8.0.0-beta.18)
at `4d066171cdda2a802a71d4776c1c51132d5baff7`.

The published `@adcp/sdk@14.0.0-rc.49` CLI against the beta.18 Python example
seller now negotiates rc.7 and executes two partial tracks: 30 steps passed,
11 failed, and 155 skipped. The 11 failures center on the example seller's
`canonical_creatives=false` advertisement under AdCP 3.2. The CI workflow
uploads the full `storyboard-result-python.json` artifact. This general seller
storyboard remains advisory.

The independent, installed-artifact PostgreSQL reporting gate passed on
integrated Python `main` commit `7549e425ae1804da2a0cb5b746132605865e2a2e`:
Core **4/4** and full lifecycle **4/4**. Its exact 2×2 used published Python
`8.0.0b16` / `8.0.0b18` and published TypeScript `14.0.0-rc.47` /
`14.0.0-rc.48` against the signed `3.2.0-rc.7` protocol bundle. Each full
cell exercised Managed Delivery, Reconciled Billing, exact revision reads,
accepted receipts, and signed webhook retry/replay in fresh PostgreSQL state.
See the [#1199 acceptance record](https://github.com/adcontextprotocol/adcp-client-python/issues/1199#issuecomment-5868029489).

That matrix does not include the current TypeScript `rc.49` artifact, the
strict controller fix, or the final AdCP 3.2 bundle. Final SDK 14 release
qualification must rerun the installed-artifact matrix on the exact release
candidate and the Python release-PR merge commit. Python #1199 remains open
for that final gate.

| Contract | Python implementation | TypeScript implementation | Shared proof |
| --- | --- | --- | --- |
| Canonical JSON and fingerprints | `reporting.canonical_json` | `reporting/source/manifest.ts` | `test/fixtures/reporting-interop/canonical-json-v1.json` |
| Source execution, staging, replay identity | source, inline source, materializer capture | `reporting/source` executor, manifests, inline staging | source replay and manifest conformance tests |
| Immutable Core ledger | reporting ledger memory/PostgreSQL stores | `PostgresReportingLedgerStore` | real-PostgreSQL ledger, migration, cursor, and lifecycle tests |
| Account-qualified generation identity | account/config/version keys | account/config/version keys | multi-account isolation and generation immutability tests |
| Frozen currency, timezone, coverage | trusted account context | trusted `resolveCurrency`, `resolveSource`, `resolveCoverage` | service conformance and calendar-day tests |
| Fair bounded planning and worker recovery | leased configuration/obligation workers | durable global planning cursor plus fenced `SKIP LOCKED` claims | starvation, crash-boundary, and lease tests |
| Core status and exact revision reads | status handler and snapshot projection | Core/Managed status handlers and exact revision reads | schema validation and stable-snapshot pagination tests |
| Managed Delivery | production/materializer stores and workers | managed store/runtime and destination adapter | real-PostgreSQL authorization, verification, revocation, and retention tests |
| Reconciled Billing receipts | receipt capture/handler/store | transactional receipt batches and `sync_reporting_receipts` | idempotency, evidence, conflict, and replay tests |
| Ledger/status/readiness notifications | notification outboxes and workers | transactional activity outbox plus persistent signed webhook runtime | all three schema-valid event tests and retry recovery tests |
| Webhook activity | scoped activity stores and account projection | reserved-before-I/O activity store and batched `list_accounts` projection | principal isolation, sanitization, bounded reads, retention, and projection tests |
| Production composition | `ReliableReportingService.postgres` and extensions | `createPostgresReliableReportingProductionService` | migration/probe/policy barrier test |
| Buyer reconciliation | consumer and reconcile helpers for revision receipts; seller adjustment ledger primitives | Core and Managed/Reconciled inspection/reconciliation, including post-official adjustments | shared manifest, rows, digest, revision-receipt, and snapshot-change proof; TypeScript adjustment-receipt tests pending Python adoption |
| Durable buyer loop | revision checkpoints/change cursors | PostgreSQL revision and adjustment checkpoints, pending status, notification dedupe, leases | shared restart, CAS, lease-fencing, and revision duplicate/conflict proof; TypeScript adjustment-checkpoint tests pending Python adoption |
| Authenticated notification hints | scoped consumer notification handling | seller/principal scoped durable dedupe and reconcile trigger | ambiguous-account and replay tests |

## Capability-publication invariant

The production TypeScript composer publishes only after migrations have been
applied and every participating store has passed its probe. It then persists
and verifies the Managed Delivery policy before returning capabilities. A
failure in any notification, activity, Core, Managed, or receipt dependency
prevents the caller from obtaining an advertising platform.

The complete production composer owns these claims:

- Core configuration/status/read capability;
- Managed Delivery when its adapter and offering are compatible;
- Reconciled Billing only for receipt offerings with a compatible verification profile and consumer resolver;
- `reporting.ledger_changed`, `reporting.status_changed`, and `reporting.delivery_ready`;
- principal-scoped `list_accounts` webhook activity.

Adopters must not merge manual reporting capability overrides into this
object. A declaration without the corresponding handler is a release blocker.

## Deliberate API differences

Python separates more persistence roles into packages such as `projection`,
`outbox`, `materializer`, and `receipts`. TypeScript composes those roles behind
the Core ledger, Managed Delivery store, persistent notification runtime, and
production service. This is packaging, not a protocol difference.

Python can run synchronous provider calls in a worker thread. TypeScript
adapters are promise-based and must impose provider deadlines themselves. In
both SDKs, a provider call needs an upstream timeout; cancellation cannot make
an already-accepted remote operation disappear.

## Cross-SDK change rule

Any change to canonical bytes, identifiers, cursor scope, reconciliation
selection, event payloads, receipt evidence, or status semantics must:

1. add a language-neutral fixture or protocol storyboard;
2. run it in both SDKs;
3. add an upgrade note when retained state or worker compatibility changes;
4. keep old readers safe until all writers have crossed the documented fence.

An SDK-local unit test alone is insufficient for a cross-language identity.
