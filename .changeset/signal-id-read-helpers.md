---
"@adcp/sdk": minor
---

Add `getSignalId` and `getSignalIssuer` read helpers for `SignalID`

`SignalID` is a discriminated union (`source: 'catalog' | 'agent'`). Callers that need just the segment identifier or the issuer domain/URL previously had to narrow the union manually or risk reaching for non-existent fields like `sid.catalog_id`.

Two new exports from `@adcp/sdk`:

- `getSignalId(sid)` — returns `sid.id` (the canonical segment identifier, present on both variants)
- `getSignalIssuer(sid)` — returns `sid.data_provider_domain` (catalog) or `sid.agent_url` (agent), with an exhaustiveness guard for future union variants

Complements the existing `signalId.catalog()` / `signalId.agent()` write-path factories.
