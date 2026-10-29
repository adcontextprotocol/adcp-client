---
'@adcp/sdk': patch
---

Fix a 17.0.0-beta.5 regression in legacy-wire `sync_creatives` projection: a creative assigned to several packages is no longer refused when the packages' legacy refs differ only because some leave width/height or duration unstated. The SDK now reconciles the per-package refs by constraint satisfaction. A package that leaves a constraint open accepts the value another package states, the shared `format_id` omits size when no package states one, and projection refuses only when packages state different values, naming the conflicting constraint and packages in the message and in `CreativeFormatProjectionError.details.conflicts`. Canonical-wire delivery is unchanged.

A package's declarations restrict a constraint to the values they state, even when its resolved ref is silent: a package declaring 640x360 and 940x529 accepts either but refuses a 300x250 another package states. The shared `format_id` takes size and duration from the resolved refs only, matching what each package resolves to on its own.

`creativeFormatProjection.playerSizedRefs` is deprecated and will be removed in 18.0.0. Until then it is still accepted and keeps its beta.5 meaning only for VAST packages that state different player sizes; mixed sized and unsized packages now project the stated size with or without it. Whether a stated VAST size is a hard requirement or a player hint belongs in the seller's format definition or the AdCP format params, not in host policy (adcontextprotocol/adcp#8583).
