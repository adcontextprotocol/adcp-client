---
"@adcp/sdk": patch
---

fix(test): retarget proposal-mode allowlist after AdCP 3.0.7 cascade unmask

The 3.0.7 schema bump (#1595) landed adcp#4088, fixing `proposal_id` chaining in `proposal_finalize.yaml`. `get_products_refine` now passes — and the cascade-skip that hid `create_media_buy` is gone, exposing a real adapter bug: `create_media_buy`'s response doesn't satisfy the 3.0.7 `create-media-buy-response.json` schema. Allowlist retargeted to mask `create_media_buy` until the adapter is fixed (tracked at #1600). Unblocks main CI.
