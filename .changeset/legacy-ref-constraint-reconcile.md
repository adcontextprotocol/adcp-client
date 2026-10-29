---
'@adcp/sdk': patch
---

Fix a 17.0.0-beta.5 regression in legacy-wire `sync_creatives` projection: a creative assigned to several packages is no longer refused when the packages' legacy refs differ only because some leave width/height or duration unstated. The SDK now reconciles the per-package refs by constraint satisfaction. A package that leaves a constraint open accepts the value another package states, the shared `format_id` omits size when no package states one, and projection refuses only when packages state different values, naming the conflicting constraint and packages in the message and in `CreativeFormatProjectionError.details.conflicts`. Canonical-wire delivery is unchanged.

`creativeFormatProjection.playerSizedRefs` is deprecated. It is still accepted and keeps its beta.5 meaning only for VAST packages that state different player sizes; mixed sized and unsized packages now project the stated size with or without it.
