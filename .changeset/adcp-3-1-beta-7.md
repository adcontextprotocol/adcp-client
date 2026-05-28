---
'@adcp/sdk': minor
---

Update the SDK schema pin and generated surfaces to AdCP 3.1.0-beta.7.

Regenerates TypeScript/Zod schemas, docs, manifest-derived constants, wire
field allowlists, and the 3.1 beta opt-in type surface from the beta.7
protocol bundle. The test-controller and `createComplyController` helpers now
recognize and advertise the new beta.7 compliance controller scenarios
(`force_creative_purge`, `seed_measurement_catalog`,
`query_provenance_audit_observations`), auto-seeded product/pricing fixtures
are projected through `compliance_testing.scenarios`, and the beta sync wrapper
preserves protocol-managed artifacts when the beta is also the primary pin.
