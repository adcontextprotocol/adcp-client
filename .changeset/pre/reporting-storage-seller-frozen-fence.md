---
'@adcp/reporting-storage': patch
---

The GCS managed-delivery fence now refuses, with `CONTENT_CONFLICT`, an expected period whose membership is `{ kind: 'media_buy_ids', packageCoverage: 'seller_frozen' }`. The fence binds a delivery to an exact buy set and exact coverage, and a seller-frozen expectation pins only the buys, so it has no package coverage to bind. Before, such an expectation reached the coverage comparison and was refused only because its buy-only coverage happened not to match. Expectations without `packageCoverage` behave as before.
