---
'@adcp/sdk': patch
'@adcp/reporting-storage': patch
---

Reporting subscriptions (experimental, AdCP 3.3): a PostgreSQL production seller configured with `subscriptions.principal` now serves the same principal surface as the `memoryStorage()` seller. `createPostgresReliableReportingProductionService` builds the principal runtime with the `notification_configs` task (`syncAgentNotificationConfigs`) and marks it as service-built, so the service advertises `capability_changes` for it. Before, it served neither.
