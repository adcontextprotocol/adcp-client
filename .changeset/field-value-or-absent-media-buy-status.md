---
"@adcp/sdk": patch
---

fix(storyboard): treat flat MCP envelope `status: "completed"` as absent for media-buy legacy status tolerance (#1961)

`field_value_or_absent` now distinguishes the AdCP 3.1 task-envelope `status` from the deprecated media-buy body `status` when `media_buy_status` is present. This lets `pending_creatives_to_start` pass for sellers that correctly emit `media_buy_status: "pending_creatives"` without the deprecated legacy field, while preserving failures for actual mismatched legacy media-buy statuses and leaving `envelope_field_*` checks unchanged.
