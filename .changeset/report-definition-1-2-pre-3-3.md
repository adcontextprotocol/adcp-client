---
'@adcp/sdk': patch
---

Reliable Reporting serves 1.2 report definitions to AdCP 3.3 callers only (adcp-client#3709, adcontextprotocol/adcp#8983).

AdCP 3.3 adds report-definition `contract_version` 1.2, and callers pinned below 3.3 accept only 1.0 and 1.1 (`core/reporting-report-definition.json` `x-adcp-validation.package_dimension`). An offering pins its definition by URI and SHA-256 only, so `createReliableReportingService` takes a new option, `reportDefinitionVersions`, mapping each lowercase-hex `report_definition_sha256` to `'1.0'`, `'1.1'` or `'1.2'`. A 1.2 offering is published as `platform.reporting.adcp33OnlyOfferingIds`, and `createAdcpServerFromPlatform` then:

- drops it from `get_adcp_capabilities` for callers pinned below 3.3, and drops `media_buy.reporting_delivery` and its experimental feature id when no offering is left;
- refuses those callers' `sync_accounts` `reporting_delivery_configs` naming it, per account entry, with `UNSUPPORTED_FEATURE` (`field: "reporting_delivery_configs"`, `recovery: "correctable"`, `details: { offering_id, delivery_config_id }`), before `accounts.upsert` runs;
- refuses to start a server pinned below 3.3 that has one.

"Pinned below 3.3" compares `MAJOR.MINOR`, so every 3.3 prerelease counts as 3.3, and a request with no served release is the SDK's pinned release.

An offering the map does not declare keeps today's behavior: it is served to every caller as a 1.0 or 1.1 definition, and the service warns once at construction with the entry to add. Set `undeclaredReportDefinitions: 'withhold_from_pre_3_3'` to serve undeclared offerings to 3.3 callers only. `installConfiguration` accepts an optional `servedAdcpVersion` (pass `ctx.servedAdcpVersion`) so a `sync_accounts` handler supplied outside `accounts.upsert` gets the same refusal. `createAdcpServer` takes the matching `capabilities.reportingAdcp33OnlyOfferingIds`. `get_reporting_status` and the account readback are unchanged. Products are the seller's own catalog: filter 1.2 offering ids out of `reporting_delivery_offering_ids` in products served to pre-3.3 callers. The Python SDK applies the same rule (adcp-client-python#1906).
