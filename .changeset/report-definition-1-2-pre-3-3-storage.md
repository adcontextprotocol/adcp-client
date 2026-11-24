---
'@adcp/reporting-storage': patch
---

`createPostgresReliableReportingProductionService` accepts the core service's new `reportDefinitionVersions` and `undeclaredReportDefinitions` options and forwards `adcp33OnlyOfferingIds` on its platform, so a production seller's 1.2 report definitions are served to AdCP 3.3 callers only (adcp-client#3709).
