---
'@adcp/client': patch
---

Two response-layer fixes for agents built from partial skill coverage:

**`buildCreativeResponse` / `buildCreativeMultiResponse` no longer crash on missing fields.** The default summary previously dereferenced `data.creative_manifest.format_id.id` without guards — handlers that drop `format_id` (required by `creative-manifest.json`) crashed the dispatcher with `Cannot read properties of undefined (reading 'id')`, swallowing the real schema violation behind an opaque `SERVICE_UNAVAILABLE`. Now the summary optional-chains through the field chain and falls back to a generic string, so the response reaches wire-level validation and the buyer sees the actual missing-field error.

**`replayed: false` is no longer injected on fresh executions.** `protocol-envelope.json` permits the field to be "omitted when the request was executed fresh"; emitting `false` violates strict task response schemas that declare `additionalProperties: false` (`create-property-list-response`, etc.). Fresh responses now drop any prior `replayed` marker; replays still carry `replayed: true`. The existing `test/lib/idempotency-client.test.js` "replayed omitted is surfaced as undefined" test aligns with this shift.

Surfaced by matrix v10: six `creative_generative` pairs crashed with the dereference, and every `property_lists` pair hit the `additionalProperties` violation.
