---
'@adcp/client': patch
---

Fix: response-schema AJV validators now accept envelope fields (`replayed`, `context`, `ext`, and future envelope additions) at the response root on every tool.

The bundled JSON response schemas for the property-list family (`create_property_list`, `update_property_list`, `delete_property_list`, `get_property_list`, `list_property_lists`, `validate_property_delivery`) ship with `additionalProperties: false` at the root, which rejected `replayed: false` — even though security.mdx specifies `replayed` as a protocol-level envelope field that MAY appear on any response. That left a two-faced contract: the universal-idempotency storyboard requires `replayed: false` on the initial `create_media_buy`, but emitting the same envelope field on property-list tools tripped strict response validation.

`schema-loader` now flips `additionalProperties: false` to `true` at the response root (and at each direct `oneOf` / `anyOf` / `allOf` branch one level deep) when compiling response validators. Nested body objects stay strict so drift inside a `Product`, `Package`, or list body still fails validation. Request schemas remain strict so outgoing drift fails at the edge. Matches the envelope extensibility the Zod generator already expresses via `.passthrough()`. Fixes #774.
