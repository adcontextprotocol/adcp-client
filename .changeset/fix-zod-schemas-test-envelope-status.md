---
'@adcp/sdk': patch
---

fix(test): add envelope `status: 'completed'` to zod-schemas test fixtures

`test/lib/zod-schemas.test.js` is part of the `prepublishOnly` gate (one of the 3 test files the publish script runs). Its fixtures predate AdCP 3.1.0-beta.2's envelope-`status`-required change, so they fail to validate against the regenerated `*ResponseSchema` Zod schemas. This blocks `8.1.0-beta.0` from publishing.

8 fixtures (across `GetProductsResponse`, `GetMediaBuysResponse`, `GetMediaBuyDeliveryResponse`, `GetSignalsResponse`) now carry `status: 'completed'` as the first field. No other test logic changes.
