---
"@adcp/sdk": patch
---

fix(v2-adapter): emit buyer_ref in adaptCreateMediaBuyRequestForV2 (top-level + per-package)

v2.5 schema requires buyer_ref on both the top-level create_media_buy request and each package.
The adapter now derives top-level buyer_ref from idempotency_key, and per-package buyer_ref from
the package's own idempotency_key (falling back to `${idempotency_key}-${index}`). Both are stable
across replays, preserving idempotency semantics. Real v2.5.3+ sellers enforcing required-field
validation will no longer reject adapted requests.
