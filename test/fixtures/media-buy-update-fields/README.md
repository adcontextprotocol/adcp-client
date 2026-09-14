# media-buy update_fields generator fixtures

Verbatim copies of the two upstream schemas that carry the
`update_media_buy` action -> field binding (`enumMetadata`), taken from the
AdCP protocol PR bundle for adcontextprotocol/adcp#7449:

- protocol commit `9e2bf6a949de2adc8d2835e44cb73c820ee69d99`
- bundle `https://adcontextprotocol.org/protocol/pr/9e2bf6a949de2adc8d2835e44cb73c820ee69d99/latest.tgz`
- bundle SHA-256 `e2804ae31fc4400c0c98af492365d915195e84faed49d72fb7c0757a8f381f46`
- bundle `published_version` `3.2.0-rc.2` (the cut rc.2 release predates the
  merge; the first release to include these files is expected to be rc.3)

`merged/` holds both files so `test/lib/media-buy-update-fields-generator.test.js`
can exercise `scripts/generate-media-buy-update-fields.ts` against the
post-#7449 shape (structured-only `update_media_buy_frequency_cap` in
`core/media-buy-available-action-id.json`) regardless of which AdCP version
the repo's `ADCP_VERSION` pin currently points at. The legacy-only and
conflict cases are derived from these files at test time.

Refresh by copying the files out of `schemas/cache/<version>/` once the
pin moves to a release that ships `core/media-buy-available-action-id.json`.
