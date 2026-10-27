---
'@adcp/sdk': major
---

Preserve AdCP 3.2+ account identity fields in `accounts.upsert` responses: `account`, `operator_unit`, `revision`, `identity_change`, `identity_change_preview`, `currency`, and `timezone` (#3466). Add these fields to `SyncAccountsResultRow`, allow settings-update results anchored by `account` without a flat brand/operator pair, and allow unresolved failed rows without an invented lifecycle status.

Keep the entire request-only `destination_billing_entity` out of framework and raw response-builder output, including replay-cached responses. Current `billing_entity` metadata still passes through with write-only bank details stripped.

`SyncAccountsResultRow` now distinguishes the two identity anchors and requires lifecycle status for successful rows. Consumers reading a result must narrow its identity and check failed rows before assuming `brand`, `operator`, or `status` are present.

Validate nested account/operator identity objects before emission so accidentally retained internal fields cannot enter responses or replay caches when whole-response validation is off.

This result-type change belongs to the SDK 17 major preview migration. Adopters extending the former interface should use an intersection alias (`type MyRow = SyncAccountsResultRow & { upstreamId?: string }`). Identity snapshots are detached before validation/emission; raw response builders also strip top-level framework auth and context metadata.
