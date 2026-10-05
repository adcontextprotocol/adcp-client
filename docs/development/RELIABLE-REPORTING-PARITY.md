# Reliable Reporting Python/TypeScript parity

This is the release gate for cross-SDK Reliable Reporting parity. It compares
the TypeScript SDK to `adcp-client-python` at `5fd54334` (audited 2026-09-25).
The implementations intentionally use language-native API shapes; parity means
the same wire behavior, durability guarantees, failure semantics, and
production capability truth, not identical class names.

At that original audit, TypeScript additionally verified buyer adjustments and
persisted adjustment receipt checkpoints. Published Python `8.0.0` now supplies
raw adjustment-evidence and receipt-construction primitives, plus a separate
durable mixed-receipt submission API. The gate below composes those installed APIs with a real TypeScript seller
in a bounded reference buyer, including durable adjustment submission and
process recovery. Python’s `reconcile_reporting` facade remains revision focused.

## Installed-artifact evidence and reverse runtime gate

`interop-python.yml` now blocks PR/release qualification on two additional
lanes: Node `20.19.0` (the package minimum) and Node `24`, with Python `3.10`
and PostgreSQL `16`. Each lane installs the packed TypeScript checkout and
the SHA-256-pinned published Python `adcp==8.0.0` wheel. Both installations
are verified member-by-member against their archives before tests run.

The [2026-10-05 local qualification record](reporting-evidence-qualification.json)
records eleven passing checks on both Node `20.19.0` and `24.19.0`, using Python
`3.10.21` and PostgreSQL `16.14`, plus 181 passing reporting/workflow tests and
65 passing PostgreSQL notification/activity tests, each with zero skips. It binds the
same rebuilt unpublished TypeScript working-tree archive in both runs; it does not
qualify the published `14.1.0` artifact or a future release artifact.

The gate exercises:

- all seven shared canonical JSON vectors;
- SDK canonical encoding of a pinned file manifest in each language, followed
  by independent manifest inspection in the other language against identical
  hash-pinned rows, schema, report definition, and canonicalization contract;
- accepted and rejected revision receipt construction;
- seven adjustment cases: integer delta, exact decimal beyond the JavaScript
  safe-integer range, negative zero, composed/decomposed Unicode, tampered
  digest, and supersession of a rejected receipt;
- a real PostgreSQL TypeScript Core producer/HTTP MCP server with an installed
  Python typed client and Core reconciler, independently for two accounts;
- TypeScript Managed Delivery and Reconciled Billing workers that materialize
  real JSONL and manifest files, with independent Python inspection, rejection
  of tampered delivered bytes, authoritative receipt repair after response loss,
  zero duplicate receipts, resource revocation, and retained revision metadata;
- TypeScript-signed `reporting.ledger_changed` requests verified by Python's
  published signature verifier, including a real 503 response, PostgreSQL
  recovery in a new sender process, stable canonical payload/event identities,
  fresh signatures, and rejection of tampered bodies, forged digests, wrong
  targets/origins, unknown or mis-purposed keys, and captured-signature replay;
  a shared Python PostgreSQL nonce store also rejects each captured signature
  in a fresh independent verifier process;
- a TypeScript ledger revision commit that atomically records notification
  activity, checks a persisted recipient checkpoint before the first send and
  a pending HTTP-attempt record before each send, retains a failed 503 attempt,
  and recovers delivery/projection in a new process; the two sanitized attempt
  records share logical identity and increment attempt numbers. The fixture
  checks tenant isolation for notification activity and principal isolation
  for HTTP-attempt records;
- a TypeScript seller / installed Python reference buyer that verifies the
  immutable official revision and decoded adjustment evidence, freezes a mixed
  receipt plan in PostgreSQL, and survives seven independent-process death
  boundaries; concurrent reservation and send controls retain one
  plan and one seller batch, and a later correction reopens then repairs the
  period without changing earlier evidence or accepted receipts;
- Python's standalone PostgreSQL mixed revision/adjustment receipt-submission
  API across ten process-death boundaries and a concurrent buyer race, using
  the pinned upstream controls and installed Python seller ingestion.

This closes shared adjustment-primitive fixture coverage and adds reverse Core,
Managed Delivery, and Reconciled Billing controls. The destination adapter is
an owned local file store, read through an origin-restricted, bounded Python
provider adapter. HTTPS locators identify those files; this does not qualify
network object-store authentication or provider integration. The historical
fixture gets a per-run recovery window so PostgreSQL's current clock does not
make an immutable report overdue before its receipt can be submitted.

The billing buyer drops the response after an actual receipt commit, closes its
client, and repairs through a fresh official client reading authoritative seller
state. The integrated adjustment control additionally composes Python's separate
`adcp.reporting.submissions` API with authenticated history reads, adjustment
capture/builders, and independent manifest inspection. Each crash control uses
its own authenticated consumer and buyer schema. The sender-observed canonical
arguments are checked against request chunks read directly from the persisted
PostgreSQL plan, with exact replay bodies and keys. A concurrent reservation
race starts both buyers before either reserves, then releases both sends
back-to-back. Final SQL inventory checks cover every consumer and correction
generation. The same database role owns these fixture schemas; least-privilege
role deployment is outside this proof. All eight fixture consumers have access
to the same sandbox account. The later correction reopens that shared period
for every consumer; the control then repairs the selected controller consumer.
The control relies on pinned adapter ingress, private plan bytes and SQL text
for instrumentation; those diagnostics are test internals.

This is a reference application combining installed public APIs. General
paginated selection, rejected-leaf policy, automatic facade integration,
consumer-status orchestration, and host/power-loss recovery remain separate
qualification work. Adjustment ingress uses the official MCP adapter's decoded
mapping before reporting model conversion. It preserves those supplied values;
original HTTP spelling and upstream duplicate-key detection are outside this
mapping evidence. The 1 MiB status check is an admission assertion after decode;
independent worker/process deadlines bound the complete control.

The notification receiver uses an owned loopback HTTP route for a fixed HTTPS
signing target and a trusted fixture JWK. Destination proof and delivery
authorization are trusted fixture adapters. It verifies the exact bytes emitted
by the SDK. Public TLS, DNS, key discovery, and provider authorization remain
unqualified. The shared PostgreSQL nonce store and ledger/activity outbox
composition are exercised with installed SDKs, including an initial recipient
checkpoint and per-attempt reservations before I/O, 503 recovery, and scoped activity projection through the `list_accounts`
projection helper. The HTTP `list_accounts` dispatch path is covered by the
separate production service tests. PostgreSQL JSONB changes member order on
recovery: raw body hashes can differ, while independently computed canonical
payload hashes and logical identities must match. The retry is signed afresh;
both deliveries pass the Python verifier, and a fresh verifier process rejects
each captured nonce. The fixture checks recipient checkpoint presence on retry;
it does not assert that the recipient timestamp advances for that retry. A green lane establishes these controls, with the stated
fixture and deployment limits.

Known permitted diagnostic difference: a tampered adjustment digest yields
`CANONICAL_ADJUSTMENT_DIGEST_MISMATCH` in TypeScript and
`ADJUSTMENT_DIGEST_MISMATCH` in Python. Both reject the same independently
computed evidence; the protocol permits SDK-defined rejection codes. Accepted
adjustment receipts match exactly. The fixture explicitly pins each rejected
receipt so a diagnostic change cannot silently pass. Callers must not assume
these SDK-defined strings are interchangeable.

The gate retains archive hashes, installed-member manifests, resolved Python
dependencies, the TypeScript installation lockfile, fixture identity, exact
outputs, process readiness proofs, sanitized logs, and aggregate results.
SDK archives and harness source are immutable inputs; dependency resolution
is recorded per run and currently is not a shared, hash-locked environment.
Harness scripts and tests execute from a fresh export with every file checked
against its pinned Git blob identity. SDK sources are excluded, Git replacement
objects are disabled, and pytest loads only the explicit asyncio plugin. The
PostgreSQL endpoint is an explicit single TCP host shared by both SDKs.
Each reverse run owns a fresh database and per-run credentials, then stops the
seller and drops the database.

Manifest inspection bounds asynchronous waits and checks its deadline during
synchronous work. JavaScript cannot preempt a synchronous custom decoder,
schema compiler, or row validator in the same process. Applications requiring
a hard CPU deadline must run inspection in an independently terminable worker
or process; `maxSchemaCompileMs` rejects an overrun after compilation returns.

Reproduce locally after building/packing and installing the SDK archives:

```sh
REPORTING_INTEROP_PG_URL=postgresql://localhost/postgres \
  node scripts/reporting-interop/run.mjs \
  /path/to/python-venv/bin/python /path/to/npm-install \
  /path/to/sdk.tgz /path/to/adcp-8.0.0-py3-none-any.whl \
  /path/to/pinned-python-checkout /path/to/new-evidence-directory
```

Use `scripts/reporting-interop/pins.json` for the wheel URL/hash and Python
harness commit. Install the wheel from that local path (not an editable source
tree), and install `psycopg[binary,pool]` in its environment. The npm installation
must include `pg`; the evidence output directory must not already exist.

## 2026-10-04 published SDK 14.1 qualification

The exact published TypeScript `14.1.0` archive was rerun against Python
`8.0.0`, with published TypeScript `14.0.0` as the compatibility control.
The Python-seller matrix passed **Core 4/4** and **full lifecycle 4/4**, with
fresh databases and seller processes and no cell isolation errors. Both
Python roles use the same GA wheel in separate environments. Node `22.12.0`,
Python `3.10.21`, and PostgreSQL `16.14` were used. Signed notification retry/replay is verified by the Python seller fixture;
this does not prove a TypeScript webhook consumer verifies those signatures.
The pinned upstream harness
is `68345b5043b1cd8bae973c3d2ba0c0e7e53b6294`; only its two artifact/protocol
input JSON files were repointed to the published inputs.

**The complete published-artifact gate fails.** Published `14.1.0` rejects the
shared named canonicalization vectors with `CANONICALIZATION_INVALID`. The
working-tree patch in this change fixes that defect. The Python-seller full
lifecycle harness constructs its receipt from producer verification evidence;
it does not independently inspect the delivered manifest and therefore cannot
qualify this missing behavior. The release needs this fix and a rerun against
the resulting published archive.

The [published-artifact record](reporting-14.1-published-qualification.json)
retains the actual archive identities, installed-member manifests, harness
hashes, passing runtime cells, and the separate failing manifest result.

## 2026-10-03 SDK 14.1 release candidate qualification

The installed-artifact PostgreSQL reporting harness passed **Core 4/4** and
**full lifecycle 4/4**, with no cell isolation errors, against the signed
AdCP **3.2.1 GA** bundle. The inputs were the published Python `adcp==8.0.0`
wheel, the published TypeScript `@adcp/sdk@14.0.0` archive, and an unpublished
`@adcp/sdk@14.1.0` archive packed from release PR #3101 head
`9687b459d594fca674cd224ce8d951d76a5ccb01`. Node 22.12.0, Python 3.10.21,
and PostgreSQL 16.14 were used.

Both Python roles use the same GA wheel, installed into separate environments.
Each cell owns a fresh database and seller process. This qualifies the GA
Python producer against the stable and candidate TypeScript consumers;
it does not establish Python version-skew support. The full lifecycle cells
exercise Managed Delivery, Reconciled Billing, exact revisions, accepted
receipts, and signed webhook retry/replay. The upstream harness source is
Python commit `63bfadb4e1b3ef7c20c24dc7ba5c654642ac9a1c`, with its artifact
and protocol input pins repointed to these actual inputs.

The [qualification record](reporting-14.1-qualification.json) retains archive
hashes, installed-member manifests, harness entrypoint hashes, and cell results.
Repeat this gate against the exact published 14.1.0 artifact after release.
Issue #3027 remains open for the reverse producer/consumer direction and shared
adjustment/receipt fixture work; this candidate qualification does not claim
complete bidirectional parity.

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
candidate and the Python release-PR merge commit. Python #1199 subsequently
closed after the rc1 merge-commit rerun, still using the prerelease inputs.

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
| Buyer reconciliation | consumer and reconcile helpers for revision receipts; seller adjustment ledger primitives | Core and Managed/Reconciled inspection/reconciliation, including post-official adjustments | shared manifest/adjustment primitives plus independent inspection and receipt construction in the cross-SDK reference buyer |
| Durable buyer loop | revision checkpoints/change cursors; separate PostgreSQL mixed-receipt submission intents | PostgreSQL revision and adjustment checkpoints, pending status, notification dedupe, leases | shared revision restart/CAS/lease-fencing proof, standalone Python submission controls, and integrated cross-SDK reference-buyer crash, reservation and send controls; facade orchestration remains separate |
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
