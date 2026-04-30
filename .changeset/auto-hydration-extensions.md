---
'@adcp/sdk': minor
---

feat(server): auto-hydration on `update_media_buy`, `provide_performance_feedback`, `activate_signal`, `acquire_rights`. Each mutating verb now auto-hydrates its primary resource(s) from the ctx_metadata store — handlers receive `req.media_buy`, `req.creative`, `req.signal`, `req.rights` populated with the wire shape + `ctx_metadata` blob from the prior discovery call (`get_media_buys`, `get_signals`, `get_rights`). Misses are silent; publishers fall back to their own DB.

Adds auto-store on `get_signals` (kind: `signal`) and `get_rights` (kind: `rights_grant`) returns to feed the hydration path.

Closes #1086.
