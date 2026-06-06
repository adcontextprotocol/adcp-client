---
'@adcp/sdk': patch
---

Repair local compliance bundles whose `latest` selector leaked into `ComplianceIndex.adcp_version` by deriving the
real AdCP version from the matching schema bundle before storyboard execution.
