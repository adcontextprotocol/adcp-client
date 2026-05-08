---
'@adcp/sdk': minor
---

Five new typed-factory namespaces for discriminator-injecting builders, mirroring the asset-builders / render-builders pattern. Each prevents a discriminator-missing wire-shape mistake at write time:

- `activationKey.{segment, keyValue}` — `ActivationKey` `oneOf` on `type` (SHAPE-GOTCHAS §1)
- `signalId.{catalog, agent}` — `SignalID` `oneOf` on `source` (SHAPE-GOTCHAS §2)
- `buildCreativeReturn.{single, multi, singleEnveloped, multiEnveloped}` — `BuildCreativeReturn` 4-arm union (SHAPE-GOTCHAS §5)
- `previewCreativeResponse.{single, batch, variant}` — `PreviewCreativeResponse` 3-arm `oneOf` on `response_type` (SHAPE-GOTCHAS §4)
- `mediaBuyDeliveryNotification.{scheduled, final, delayed, adjusted, windowUpdate}` — webhook `notification_type` discriminator on `GetMediaBuyDeliveryResponse`

Reference adapters (`examples/hello_creative_adapter_*.ts`, `hello_signals_adapter_marketplace.ts`, `signals-agent.ts`) migrated to use the new factories. The deprecated v5 helper `previewCreativeResponse` is no longer re-exported from the top-level `@adcp/sdk` entry; it remains available via `@adcp/sdk/server`.

Closes #1386.
