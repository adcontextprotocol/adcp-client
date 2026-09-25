# Reliable Reporting Python/TypeScript parity

This is the release gate for cross-SDK Reliable Reporting parity. It compares
the TypeScript SDK to `adcp-client-python` at `c28907bb` (audited 2026-09-25).
The implementations intentionally use language-native API shapes; parity means
the same wire behavior, durability guarantees, failure semantics, and
production capability truth, not identical class names.

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
| Webhook activity | scoped activity stores and account projection | reserved-before-I/O activity store and `list_accounts` projection | principal isolation, sanitization, retention, and projection tests |
| Production composition | `ReliableReportingService.postgres` and extensions | `createPostgresReliableReportingProductionService` | migration/probe/policy barrier test |
| Buyer reconciliation | consumer and reconcile helpers | Core and Managed/Reconciled inspection/reconciliation | manifest, rows, digest, receipt, and snapshot-change tests |
| Durable buyer loop | consumer checkpoints/change cursors | PostgreSQL checkpoints, pending status, notification dedupe, leases | restart, CAS, lease fencing, and duplicate/conflict tests |
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
