---
"@adcp/client": minor
---

Sync upstream AdCP schema: sandbox mode support and creative format filters

- Added `sandbox?: boolean` to `Account`, `MediaBuyFeatures`, and all task response types (`GetProductsResponse`, `CreateMediaBuySuccess`, `UpdateMediaBuySuccess`, `SyncCreativesSuccess`, `ListCreativesResponse`, `ListCreativeFormatsResponse`, `GetMediaBuyDeliveryResponse`, `ProvidePerformanceFeedbackSuccess`, `SyncEventSourcesSuccess`, `LogEventSuccess`, `SyncAudiencesSuccess`, `BuildCreativeSuccess`, `ActivateSignalSuccess`, `GetSignalsResponse`)
- Added `sandbox?: boolean` filter to `ListAccountsRequest` and `SyncAccountsRequest`
- Added `output_format_ids` and `input_format_ids` filter fields to `ListCreativeFormatsRequest`
- Added `input_format_ids` to `Format`
