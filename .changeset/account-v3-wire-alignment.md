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

All additions are optional — adopters who don't set the new fields see no behavior change. Closes #1256.
