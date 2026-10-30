---
'@adcp/sdk': patch
---

Add opt-in `collect_product_pages` storyboard steps for complete wholesale product reads. The runner requires fresh reads without an idempotency key, preserves the other authored request fields, validates every physical page and its invariants, follows stable feed cursors with bounded restarts and safety limits, and exposes an explicitly labelled logical product view alongside actual per-page evidence. The intrinsic `collect_product_pages_runner` requirement prevents older runners from silently grading only the first page.
