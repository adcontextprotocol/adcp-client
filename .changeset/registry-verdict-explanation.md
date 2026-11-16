---
'@adcp/sdk': patch
---

Refresh the registry OpenAPI snapshot and generated types for the published storyboard verdict explanation (adcontextprotocol/adcp#8576): `verdict_explanation` on storyboard results, with the new `StoryboardVerdictExplanation` and `StoryboardVerdictContributor` schemas. It explains why a storyboard failed when no counted step did, and is populated only for owners and operators. The field is nullable and the change is additive.
