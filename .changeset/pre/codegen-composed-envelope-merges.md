---
'@adcp/sdk': patch
---

Zod codegen no longer hard-codes the layout of `core/compact-task-submitted.json` (#3512). The `postProcessCompactTaskSubmittedEnvelope` pass is removed. The generic object-intersection rewrite now proves each `A.and(B)` → `A.merge(B)` exact on its own:

- it recognizes narrowings (a literal inside the envelope's union, a required field over an optional one, a string with extra refinements);
- it compares unknown-key policies and never merges a `.strict()` operand;
- it follows merge chains;
- after the last refinement pass, it reruns with propagation, so schemas composed from composed schemas also merge.

`CompactTaskSubmittedSchema` and `RefineProposalsAsyncSubmittedSchema` therefore stay ZodObjects for the current 3.3.0-beta.2 layout and for the adcp#8547 layout, where every task response composes the protocol envelope and `core/task-submitted.json`. Generation from an adcp#8547 bundle previously failed with `expected the generated envelope intersection`.

A few more generated schemas now merge into ZodObjects instead of intersections. Validation is the same, and they gain `.shape` / `.extend()`. They are `GetProductsRejectedSchema`, `MediaBuyFrequencyCapSchema`, `ProposalOfferedWebhookSchema`, and nested references to `FrequencyCap`, `OpportunityContext`, `RightsConstraint`, `ReportingAdjustmentReceipt`, `CollectionPayload`, `PackageRequest`, `DemographicAgeRange` and `CanonicalMediaBuyActionFields`. `ProposalOfferedWebhook_NotificationTypeValues` and `GetProductsRejected_StatusValues` are now exported.
