---
"@adcp/sdk": minor
---

feat(server): Account v3 wire alignment — billing_entity, lifecycle and reporting fields

The framework's `Account<TCtxMeta>` interface and `toWireAccount` projection lagged the AdCP 3.0 wire schema. Adopters returning `Account<TCtxMeta>` from `accounts.resolve` / `accounts.list` could not populate spec-required commercial fields, and the framework silently dropped them on emit — most visibly, the `setup` payload that drives the `pending_approval` → `active` lifecycle was lost between adopter and buyer.

`Account<TCtxMeta>` now carries the wire-aligned optional fields:

- `billing_entity` — business entity for B2B invoicing (`legal_name`, `vat_id`, `tax_id`, `registration_number`, `address`, `contacts`, write-only `bank`)
- `rate_card` — applied rate-card identifier
- `payment_terms` — `net_15` / `net_30` / `net_45` / `net_60` / `net_90` / `prepay`
- `credit_limit` — `{ amount, currency }`
- `setup` — `{ url?, message, expires_at? }` for `pending_approval` accounts
- `account_scope` — `operator` / `brand` / `operator_brand` / `agent`
- `governance_agents` — registered governance agent endpoints
- `reporting_bucket` — offline reporting delivery configuration

`toWireAccount` projects each field unchanged, with one exception: `billing_entity.bank` is stripped on emit. The wire schema marks bank coordinates as MUST NOT be echoed in responses (`BusinessEntity.bank` is write-only — included in `sync_accounts` requests, omitted from any response payload). Adopters who load and return a full entity from their store no longer leak bank details to buyers.

`SyncAccountsResultRow` (returned by adopter `accounts.upsert` implementations) is extended in parallel with the same wire-aligned fields and projected through `toWireSyncAccountRow` before emit. The same `billing_entity.bank` strip applies on this path — adopters returning a row literal that spreads a DB record carrying bank coordinates (e.g., `{ ...db.findByBrand(r.brand), action: 'updated' }`) no longer leak bank details to buyers.

`Account.governance_agents` elements are projected to `{ url, categories }` only on emit. The schema notes governance auth credentials are write-only and the codegen'd type already excludes them, but TS is erased at runtime — explicit projection prevents adopters using JS or `as any` from smuggling a `credentials` field straight to the wire.

When `billing_entity` carries only `bank` (no other fields), the projection omits the entire entity rather than emitting an empty object — `BusinessEntity` requires `legal_name` per the wire schema, so the empty case would fail downstream validation.

All additions are optional — adopters who don't set the new fields see no behavior change. Closes #1256.
