---
'@adcp/client': patch
---

Option B (structural) groundwork — stop treating response shapes as hand-written forever:

- `generate-agent-docs.ts` now extracts response schemas and emits a `_Response (success branch):_` block under every tool in `docs/TYPE-SUMMARY.md`. For tools whose response is a `oneOf` success/error discriminator (e.g., `update_media_buy`), the generator picks the success arm (no `errors` required field) so builders see the happy-path shape. `_Request:_` and `_Response_` are now visually separated.
- `TYPE-SUMMARY.md` is regenerated; every tool now carries both sides of the wire.
- Seller + creative skills: added explicit top-level `currency` in `getMediaBuyDelivery` and `getCreativeDelivery` examples. The response schemas require it; the old examples omitted it and fresh-Claude agents built under those skills failed `/currency: must have required property` validation.

Builders can now cross-reference hand-written skill examples against an auto-updating TYPE-SUMMARY response block. When the spec adds a required field, the generated doc updates immediately while the skill example may lag — that's the drift-detection signal.

Next logical step (not in this PR): replace the hand-written `**tool** — Response Shape` blocks in skills with direct `See [TYPE-SUMMARY.md § tool](…)` pointers so the skill narrative focuses on logic and the shape stays generated.
