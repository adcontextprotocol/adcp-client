---
'@adcp/sdk': minor
---

Add unified product, proposal, and live MediaBuy action assessment, portable change-constraint preflight, canonical task routing, and an explicit seller change-right resolver. Preserve opaque legacy references and unknown conditions without granting negotiated rights. Add a tree-shakeable browser entry point at `@adcp/sdk/media-buy/actions` and retain existing legacy preflight compatibility.

Existing `preflightUpdateMediaBuy` now enforces accepted change terms when that snapshot is supplied, including unmapped-field and whole-request task checks. An explicitly empty `available_actions` array takes precedence over legacy `valid_actions` hints. The public action union includes canonical and rc.3 actions, and mode recovery adds `waitForTask` for `seller_managed`; exhaustive consumers should handle the additive variants.

The existing update facade can subsume advertised compact tasks, including atomic mixed targeting and assignment changes; explicitly attempted compact tasks must still match. Seller package lifecycle projections narrow mixed scopes to packages whose current state supports the action.

Compatibility preflight also rejects unknown sibling mutations and unknown structured modes, and honors explicit package scopes and compact route restrictions without an accepted snapshot. Separately supplied proposal snapshots require accepted status and a current MediaBuy/proposal identity link.

Flat legacy `update_name` hints no longer authorize metadata changes; sellers must advertise explicit structured live authority for naming updates.
