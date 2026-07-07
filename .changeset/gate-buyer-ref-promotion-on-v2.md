---
'@adcp/sdk': patch
---

Client: stop injecting a deprecated top-level `packages[].buyer_ref` on `create_media_buy` / `update_media_buy` requests to v3 sellers. The request normalizer previously copied `context.buyer_ref` up to a top-level `buyer_ref` on every call, unconditionally — before the version gate ran. Spec-compliant v3 receivers (which validate strictly against the 3.0 package schema that removed the top-level field) rejected the request with `INVALID_REQUEST: packages.0.buyer_ref: Extra inputs are not permitted`. The promotion has been moved into the v2.5 adapter (`adaptCreateMediaBuyRequestForV2`), which is already gated on `serverVersion !== 'v3'`, so legacy servers still receive the top-level field they expect while v3 sellers see the correct wire shape.
