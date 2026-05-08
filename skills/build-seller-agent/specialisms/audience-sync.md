# Specialism: audience-sync

Companion to [`../SKILL.md`](../SKILL.md). The SKILL.md baseline applies; this file covers only the deltas for `audience-sync`.

**Fork target**: [`examples/hello_seller_adapter_social.ts`](../../../examples/hello_seller_adapter_social.ts) is the worked, passing reference for the audience surface — it already implements `syncAudiences` + `listAccounts` against an `AudiencePlatform` and a walled-garden mock upstream. Replace the `// SWAP:` markers with calls to your real backend. See [SHAPE-GOTCHAS.md](../../SHAPE-GOTCHAS.md) for response-shape pitfalls.

Storyboard: `audience_sync` (track `audiences`).

## What's different from the social baseline

`audience-sync` is the **audiences-only slice** of `sales-social` — same `AudiencePlatform` surface, no `SalesCorePlatform` (no `getProducts` / `createMediaBuy`). Single-specialism `audience-sync` adopters are typically identity providers / data onboarders that don't sell media inventory; they push hashed audiences upstream and report match rates.

If you also sell media (Snap, Meta, TikTok, retail media), claim **both** `audience-sync` and `sales-social` (or whichever sales specialism fits) and keep the full `SalesIngestionPlatform`.

## Tool surface (audience-only)

- `sync_audiences` — overloaded by request payload:
  - **Discovery**: empty/missing `audiences` array → return audiences already on the platform for the account.
  - **Add**: each audience entry has `add: [{ hashed_email } | { hashed_phone } | …]` — hashed identifiers to push.
  - **Delete**: each audience entry has `delete: true` (no separate `delete_audience` tool).
- `list_accounts` — buyer-side account discovery; supports `brand` filter.

## Identifier rules

Each `add` entry is a **single-identifier object** (`{hashed_email}` OR `{hashed_phone}`, never both in one entry). Values are SHA-256 of lowercased, trimmed input. Salting/normalization is out-of-band between buyer and platform — document your expected input format in your `capabilities.features`.

Drop entries that fail your validation rather than synthesize identifiers — see [SHAPE-GOTCHAS §6.3](../../SHAPE-GOTCHAS.md#63-hashed-identifier-requirement--read-eventuser_match-drop-on-empty) for the parallel pattern on `log_event`.

## Activation destinations

Destinations span `['dsp', 'retail_media', 'social', 'audio', 'pmax']`. Each has its own `activation_key` shape — see [SHAPE-GOTCHAS §1](../../SHAPE-GOTCHAS.md#1-activationkey-oneof--keyvalue-are-top-level-not-nested) for the flat-vs-nested gotcha and `skills/build-signals-agent/SKILL.md` for the broader activation-polling pattern (shared across signals and audience sync).
