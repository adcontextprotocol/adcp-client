# Migrating AdCP 3.1.8 to 3.1.10

AdCP 3.1.10 adds Retina display mappings and splits Trusted Match identity responses into explicit provider→router and router→publisher shapes.

## Trusted Match response hops

Public SDK `identity_match` calls continue to represent the publisher-facing operation and now return `IdentityMatchResponseRouterPublisher`. Router implementations that call identity providers directly should validate those upstream responses with `IdentityMatchResponseProviderRouter`.

| Boundary | TMPX field | Allowed contents |
| --- | --- | --- |
| Provider → router | `tmpx_chunks` | One or two strict `{ slot_id, value }` entries |
| Router → publisher | `tmpx_providers` | Provider-ID keyed `{ chunks }` objects preserving attribution |

Both boundaries reject `context`, `ext`, and fields belonging to the opposite hop. `TMPXChunk` rejects extra fields so a provider cannot smuggle a publisher-local destination name.

## Provider registration and publisher mapping

Replace provider-authored `tmpx_macros` with provider-local `tmpx_slots`. Slot IDs are opaque identifiers; the publisher owns `PublisherTMPXMacroMapping`, which maps `(provider_id, slot_id)` to its local GAM key, VAST substitution, DOOH play-log field, or other destination.

Registrations must declare at least one of `context_match` or `identity_match`. Identity providers must also declare non-empty `countries` and `uid_types`; `tmpx_slots` contains one or two unique, pattern-valid IDs.

The deprecated `IdentityMatchResponse` type/schema aliases remain mapped to the router→publisher shape. The legacy `TmpxMacro` type/schema remains available for reading pre-3.1.10 payloads, but new responses must use `TMPXChunk`.

## Retina catalog mappings

The 3.1.10 registry adds standard display IDs for 2x-only and required 1x/2x rendition sets. The SDK preserves `pixel_ratios`, slot-level `pixel_ratios`, and `required_pixel_ratios` during v1→v2 projection. These fields remain forward-projection metadata for 3.2-aware consumers; the 3.1 SDK does not invent missing renditions or synthesize fallback creative data.
