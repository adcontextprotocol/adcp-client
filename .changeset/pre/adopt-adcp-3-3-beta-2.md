---
'@adcp/sdk': minor
---

**Beta-channel break:** this SDK advertises and negotiates only the AdCP `3.3-beta.2` preview and no longer packages or advertises `3.3-beta.1`. A buyer or seller still on beta.1 (SDK 17.0.0-beta.5 through beta.9) will not select the 3.3 preview with this release; the pair negotiates a shared stable release (3.2.7, 3.1.31 or 3.0.25) instead. Upgrade both sides together to keep exercising 3.3 preview features. An explicit `adcpVersion: '3.3.0-beta.1'` pin now fails with a configuration error.

Adopt the signed AdCP 3.3.0-beta.2 bundle, replacing 3.3.0-beta.1. Public types, Zod schemas, tool metadata and the packaged compliance corpus are regenerated from the beta.2 release.

**Removed from 3.3 (adcp#8537):** definition pins (`commercial_terms.definition_pins[]`, `DefinitionPin`, `DefinitionPinReferenceKind`, the `REFERENCE_DEFINITION_CHANGED` error code, the `definition_changed` refinement reason and `drifted_pins[]`), purchase rights (`purchases[].rights[]` and the `paid_amplification` / `content_reuse` right uses) and installment selection (`purchases[].installments[]`, `installment_changes`, `unsatisfied_installment_changes`). Code that builds or reads these no longer type-checks; remove it. The standalone commercial-terms verifier reads the selected schema, so against beta.2 it no longer fails closed on publisher format references or placement, collection and signal targeting, and rejects `definition_pins` and purchase `installments[]` as unknown commercial terms. It still fails closed on business-calendar SLA windows.

New in beta.2:

- `request_account` change requests accept `allow_separate_account`, and may resolve as `created` (a separate account, only with the opt-in) or `matched` (an account the caller already holds). The new correctable error code `ACCOUNT_CHANGE_REQUIRES_NEW_ACCOUNT` reports a change the seller would take only on a new account.
- Experimental seller offers (`proposal_initiator`, `offer_reason`, the `proposal.offered` notification type) and measurement provenance (`CollectionMechanism`, `counting_mechanisms`, `vendor_metric_provenance`).
- Reporting-subscription additions: offering `standard_dimensions` / `unmapped_dimensions`, per-offering `offering_id` on coverage exceptions, gaps and timezone cutovers, `previous_timezone`, `prior_versions[].configuration` and `inactive_intervals`.
- `principal_kind` / `expected_principal_kind` are deprecated in the generated types.

Fix (#3529): the ESM build's envelope-status check for `list_products` and `decline_proposals` used the CommonJS schema loader, so a schema root registered through the ESM loader (`registerExternalSchemaRoot`, `withExternalSchemaRoot`) was invisible to it. A release served from such a root then kept `status` on a response whose schema forbids it. The check now uses the loader of its own module format, and an unresolved release is no longer cached. The artifact-webhook validator in `SingleAgentClient` had the same hazard and now uses the statically imported loader.
