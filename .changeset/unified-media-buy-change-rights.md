---
'@adcp/sdk': minor
---

Add unified product, proposal, and live MediaBuy action assessment, portable change-constraint preflight, canonical task routing, and an explicit seller change-right resolver. Preserve opaque legacy references and unknown conditions without granting negotiated rights. Add a tree-shakeable browser entry point at `@adcp/sdk/media-buy/actions` and retain existing legacy preflight compatibility.

Existing `preflightUpdateMediaBuy` now enforces accepted change terms when that snapshot is supplied, including unmapped-field and whole-request task checks. An explicitly empty `available_actions` array takes precedence over legacy `valid_actions` hints. The public action union includes canonical and rc.3 actions, and mode recovery adds `waitForTask` for `seller_managed`; exhaustive consumers should handle the additive variants.

The existing update facade can subsume advertised compact tasks, including atomic mixed targeting and assignment changes; explicitly attempted compact tasks must still match. Seller package lifecycle projections narrow mixed scopes to packages whose current state supports the action.

Compatibility preflight also rejects unknown sibling mutations and unknown structured modes, and honors explicit package scopes and compact route restrictions without an accepted snapshot. Separately supplied proposal snapshots require accepted status and a current MediaBuy/proposal identity link.

Flat legacy `update_name` hints no longer authorize metadata changes; sellers must advertise explicit structured live authority for naming updates.

Explicit negotiated status scope can admit pause/resume while pending, including clearing a create-time hold. Existing packages default an omitted `paused` flag to false; missing packages, unknown lifecycle statuses, and terminal states remain unavailable. A structured naming grant no longer requires hydrating an accepted proposal snapshot, while supplied snapshot identities remain checked.

Direct and unified availability stay unknown for unmapped request fields, including opaque new-package extensions. Both preflight paths enforce the served-version ceiling for rc.3 shared caps and package scope, including legacy snapshots without embedded terms.

Known action IDs use closed canonical metadata. Readable live entries preserve unknown wire IDs as strings without granting them authority.
Accordingly, `getAvailableActions().actions` and preflight echoes expose readable string IDs, and action-context snapshots accept readonly arrays. Exhaustive consumers should handle unknown wire IDs and copy snapshots before mutating them.

Modern term-linked live entries require the accepted snapshot for preflight/assertion; missing terms cannot silently downgrade to legacy compatibility. Legacy opaque references retain the existing compatibility path.

Package holds operate independently on active or paused buys; pending buy states require explicit negotiated status scope.

Explicit local pending package status takes precedence over both pause-flag values. A live resume grant cannot override it in buyer assessment, either preflight, seller assertion, or seller projection; negotiated MediaBuy-level pending scope remains separate.

Legacy package controls also require current operational package and buy state, and unlinked structured grants must use a compatible canonical task. Served versions before 3.2.0-beta.9 cannot emit or execute modern term identities or seller-managed modes. Explicit current product policies constrain the final emitted processing SLA, including tighter seller-selected commitments.
