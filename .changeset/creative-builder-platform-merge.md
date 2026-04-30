---
'@adcp/sdk': minor
---

Merge `CreativeTemplatePlatform` and `CreativeGenerativePlatform` into a single `CreativeBuilderPlatform` interface. The two v6 preview archetypes had no meaningful interface distinction — `buildCreative` had identical signatures, and the only difference was whether `refineCreative` was supported. The merged shape makes both `previewCreative` and `refineCreative` optional, reflecting the actual implementation surface across template-driven (Bannerflow, Celtra) and brief-to-creative AI (Pencil, Omneky, AdCreative.ai) platforms.

**Both `creative-template` and `creative-generative` specialism IDs now map to `CreativeBuilderPlatform`** in `RequiredPlatformsFor<S>`. Buyer-side discovery distinction is preserved (the IDs remain separate for buyer filtering), but adopters implement one interface regardless of which IDs they claim.

`CreativeAdServerPlatform` is unchanged — library + tag generation + delivery reporting remain a distinct archetype with `listCreatives` + `getCreativeDelivery` that builders don't have. Multi-archetype omni agents (rare in practice — most "AI-native ad platforms" are builders that hand off to traditional ad servers) front each archetype as a separate tenant via `TenantRegistry`.

**Source compatibility**: `CreativeTemplatePlatform` and `CreativeGenerativePlatform` remain as `@deprecated` type aliases pointing at `CreativeBuilderPlatform` for one-release migration. Both still resolve and adopter code that imported them continues to compile. Will be removed in a future release.

Surfaced by training-agent v6 spike (F13).
