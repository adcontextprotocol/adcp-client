---
'@adcp/sdk': major
---

Adopt the signed AdCP 3.3.0-beta.0 bundle for SDK 17 beta, regenerating public types, runtime schemas and tool metadata. Add typed `listCollections` and `listProposals` client and server APIs, exact advertised-preview negotiation, and fail-closed account resolution on served 3.3 routes. Retain stable AdCP 3.2.7, 3.1.29 and 3.0.25 schema/compliance bundles. SDK 17 previews publish under `beta`; npm `latest` remains on SDK 16. Identity/Web Bot Auth and reporting storage retain their experimental policies. See `docs/migration-16-to-17.md` for the protocol and creative migration.

The standalone commercial-terms verifier enforces the 3.3 collection-list reference uniqueness rules and fails closed on definition-pin flows that need current-source verification. Until that verification is implemented, use the seller-served stable 3.2.7 contract for those snapshot-verification flows. Default preview servers advertise their exact supported release window, and the new synchronous discovery tools suppress automatic task webhook registration.

Capability discovery uses a version-neutral probe for preview clients so stable sellers can advertise their supported releases before ordinary requests negotiate a downgrade. Standalone reporting status and consumer-status handlers preserve the selected wire release on replies, including failure envelopes, instead of stamping the SDK primary preview on stable callers.

Refuse canonical inline-markup creatives with `macro_declarations` when targeting legacy HTML delivery, preserving macro resolution semantics through an explicit projection error instead of silently dropping declarations.
