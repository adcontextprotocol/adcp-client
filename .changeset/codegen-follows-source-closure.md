---
'@adcp/sdk': patch
---

The Zod schema generator now follows each source schema's `additionalProperties` instead of assuming the schema is closed. This prepares the SDK for the AdCP 3.3.0-rc.0 bundle, which opens the schemas that were closed by accident (adcontextprotocol/adcp#8866).

Before, the generator required `additionalProperties: false` on the `get_reporting_status` `scope`, `scope.delivery_config_generations[]`, `obligation_counts` and `pagination` objects, and failed generation when the source opened them. Several other post-processors closed objects without reading the source:

- the reporting evidence schemas, such as `ReportingCoverage`, `ReportingReceipt` and `ReportingVerification`
- `ReportingConsumerStatus` and its `period`, and the `sync_reporting_status` request
- the Trusted Match `TMPXChunk`, `TMPProviderRegistration` and `PublisherTMPXMacroMapping` schemas, and the router `tmpx_providers` entries
- `TargetingKvs`, which was closed only because the context-match request pass also rewrote the export that follows it
- `CompatibilityPurchaseCoordinatorInput`

Each of these is now strict only while its source closes it, and passes unknown keys through once the source opens it. Objects the source still closes keep their strict behaviour, including the Trusted Match request privacy boundaries, the placement presentation document and the canonical metric qualifier. Generated output for the current 3.3.0-beta.5 bundle is unchanged.
