---
'@adcp/client': patch
---

Skill pitfalls for Cycle D — two narrow drift classes matrix v15 surfaced after the 3.0 GA schema sync (#773):

- `get_media_buy_delivery /reporting_period/start` and `/end` are ISO 8601 **date-time** strings (`new Date().toISOString()` produces the canonical shape), not date-only. GA added strict `format: "date-time"` validation; `'2026-04-21'` now fails. Added to seller, retail-media, generative-seller, and creative-agent skill pitfall callouts.
- `videoAsset({...})` now requires `width` and `height` per GA (previously optional on `VideoAsset`). Mocks that passed `{url}` alone fail validation at `/creative_manifest/assets/<name>/width`. Added to creative-agent and generative-seller pitfalls with a concrete pixel-values example.

No SDK code change. Closes v15's two residual schema-drift classes. Residual failures after this land are storyboard-specific step expectations (generative quality grading, governance denial shape specifics) — the tight-loop per-pair phase.
