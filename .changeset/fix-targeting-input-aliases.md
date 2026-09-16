---
'@adcp/sdk': minor
---

Separate nullable targeting input aliases from strict targeting state during type generation. All schema-defined input clears are accepted by TypeScript, while proposal snapshots reject clear commands. Preserve array cardinality and construct the starter's accepted purchase from its supported fields after rejecting targeting overlays.

This corrects the existing AdCP 3.2.0-rc.3 contract, with a minor changeset for its public typing and validation impact. `ProposalPurchase['targeting_overlay']` no longer permits `null` for `geo_metros`, `language`, `keyword_targets`, or `negative_keywords`; downstream code assigning those clear commands to proposal snapshots must change. The root `TargetingOverlay` export was already strict and remains so. Put clears in the request-side `TargetingOverlayInput` or `BuyProductsRequest` types. `TargetingOverlayInputSchema` from `@adcp/sdk/schemas` accepts these schema-valid null inputs. Both public targeting Zod schemas now enforce the pinned protocol's cardinality, scalar, and nested-object constraints, so previously accepted but wire-invalid targeting values may be rejected. Persist and echo resolved targeting state, without clear commands.
