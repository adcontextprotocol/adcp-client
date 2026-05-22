---
'@adcp/sdk': minor
---

feat(preview-utils): adopt 3.1.0-beta.2 self-rendering `product_card` shape

AdCP 3.1.0-beta.2 changed `product_card` from a creative-agent-rendered shape (`{ format_id, manifest }`) to a self-contained visual card (`{ image, title, description, price_label, cta_label }`). The card IS the preview — no creative-agent round-trip required. (Schema note: "Receivers render the card directly from these fields.")

**Changes:**
- `batchPreviewProducts` rewritten: extracts `product_card.image?.url` directly from the inline card instead of round-tripping through `creativeAgent.previewCreative()`.
- `creativeAgentClient` and `options` parameters retained for signature compatibility (renamed to `_creativeAgentClient` / `_options` with the unused-args eslint pragma). Will be removed in 8.0 final or 9.0.
- `format_card` and `batchPreviewFormats` are **unchanged** — only `product_card` had this spec migration in 3.1.0-beta.2.

**Adopter migration:**
- Calls to `batchPreviewProducts(products, creativeAgent)` keep returning `PreviewResult[]` with `previewUrl` populated from the new inline `image.url`. No code change required.
- Direct field access (`product.product_card?.image?.url`) is now the recommended path; `batchPreviewProducts` is `@deprecated`.

Part of the #1902 8.0-beta sweep (5/5 structural breaks closed — **CI should now be green** on the foundation stack).
