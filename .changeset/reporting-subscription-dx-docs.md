---
'@adcp/sdk': patch
'@adcp/reporting-storage': patch
---

Reporting subscriptions docs (AdCP 3.3, experimental):

- A README section.
- The seller and buyer guides (`docs/guides/REPORTING-SUBSCRIPTIONS-SELLER.md`, `REPORTING-SUBSCRIPTIONS-BUYER.md`), with titles and sections matching the Python SDK.
- A `reporting-subscriptions` skill with do/don't anti-patterns.
- The reporting guides and the `@adcp/reporting-storage` README now show `postgresStorage({ pool })` and `npx adcp-reporting-storage migrate` instead of the migration constants.

The generated `Agent` / `AgentCollection` `syncPrincipal` and `ADCPMultiAgentClient.syncPrincipal` TSDoc now start "Replaces each submitted section. To add a reporting subscription, use `client.reporting.subscribe`."
