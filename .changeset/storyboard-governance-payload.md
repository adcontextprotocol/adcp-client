---
'@adcp/sdk': patch
---

Evaluate routed storyboard capability gates against the default agent when set, keeping route-specific applicability without a default, match governance task modes as subsets, and keep AdCP 3.2 governed requests identical to the payload approved by check_governance. The approved payload now includes the wire version envelope, fixture bindings, and run-scoped brand and sandbox fields. Governed requests use the raw wire route and bypass buyer normalization, creative wire hints, and seller-schema field stripping after approval; a missing approved idempotency key fails its storyboard step before dispatch. AdCP 3.1 governance retains its existing runner defaults. Routed storyboard applicability can change when governance steps use a separate agent.
