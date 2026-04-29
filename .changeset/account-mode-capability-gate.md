---
"@adcp/client": patch
---

Add account-mode capability gate in storyboard runner: `sync_accounts` and `list_accounts` steps now skip with `not_applicable` (instead of `missing_tool`) when the seller's declared `require_operator_auth` capability indicates the opposite account mode applies. Also threads `_profile` into `runStoryboardStep` so the gate fires on standalone step calls too.
