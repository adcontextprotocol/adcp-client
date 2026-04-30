---
'@adcp/sdk': patch
---

`createAdcpServerFromPlatform` now projects `accounts.resolution: 'explicit'` (or the explicit `capabilities.requireOperatorAuth: true` flag) onto the wire `get_adcp_capabilities.account.require_operator_auth` block. Without this, the storyboard runner's account-mode capability gate never fired for v6 platforms — explicit-mode adopters who correctly didn't implement `sync_accounts` saw a `'missing_tool'` skip on every storyboard run instead of `'not_applicable'`. Surfaced by Snap migration spike (F9).
