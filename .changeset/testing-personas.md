---
'@adcp/sdk': minor
---

Add canonical buyer-persona library at `@adcp/sdk/testing/personas`. Four typed `BuyerPersona` fixtures (DTC skincare, luxury auto, B2B SaaS, restaurant local) carry brand identity + account ID + brief + budget + channels — enough to drive `get_products` / `create_media_buy` against any seller without rolling per-adopter buyer fixtures. Three builder helpers (`buildAccountReference`, `buildBrandReference`, `buildGetProductsRequest`) construct wire-shaped requests in one line. Surfaces a `getPersonaById` lookup for storyboard fixture selection. Adopters extending the set should keep brand domains on `.example.com` (enforced by the test suite to prevent real-world branding leak). Surfaced by Snap migration spike round-6 — every adopter was rewriting buyer-persona fixtures locally.
