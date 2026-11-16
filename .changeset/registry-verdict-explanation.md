---
'@adcp/sdk': patch
---

Refresh the registry OpenAPI snapshot and generated types from the published registry spec:

- `verdict_explanation` on storyboard results, with the new `StoryboardVerdictExplanation` and `StoryboardVerdictContributor` schemas (adcontextprotocol/adcp#8576). It explains why a storyboard failed when no counted step did, and is populated only for owners and operators.
- `incomplete_bundle_ids` on the compliance summary.
- Updated descriptions for agent URL matching and publisher-pinned signing keys.

All additions are optional or nullable.
