---
'@adcp/sdk': patch
---

Evaluate routed storyboard capability gates against the default agent or any discovered agent when no default is set, match governance task modes as subsets, and keep governed requests identical to the payload approved by check_governance. The approved payload now includes the wire version envelope, fixture bindings, and run-scoped brand and sandbox fields. Governed requests bypass buyer normalization, creative wire hints, and seller-schema field stripping after approval; a missing approved idempotency key fails its storyboard step before dispatch. Routed storyboard applicability can change when governance steps use a separate agent.
