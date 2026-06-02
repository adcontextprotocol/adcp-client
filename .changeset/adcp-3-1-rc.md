---
'@adcp/sdk': minor
---

Update the SDK schema pin and generated surfaces to AdCP 3.1.0-rc.2.

Regenerates TypeScript/Zod schemas, docs, registry types, manifest-derived
constants, and wire field allowlists from the 3.1 RC protocol bundle. Preserves
`SignalCatalogType` compatibility aliases across generated type, schema, and
enum entrypoints while adopting the renamed `SignalAvailabilityType` surface.
