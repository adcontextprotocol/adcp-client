---
'@adcp/client': minor
---

Add typed factory helpers for creative asset construction that inject the `asset_type` discriminator: `imageAsset`, `videoAsset`, `audioAsset`, `textAsset`, `urlAsset`, `htmlAsset`, `javascriptAsset`, `cssAsset`, `markdownAsset`, `webhookAsset`, plus a grouped `Asset` namespace (`Asset.image({...})`) over the same functions.

Each helper takes the asset shape without `asset_type` and returns an object tagged with the canonical literal — `imageAsset({ url, width, height })` produces `{ url, width, height, asset_type: 'image' }` — eliminating the boilerplate at every construction site. The discriminator is written last in the returned object so a runtime bypass (cast that slips `asset_type` into the input) cannot overwrite it.

Return type is `Omit<T, 'asset_type'> & { asset_type: '<literal>' }` (intersection) rather than the raw generated interface, so the builders compile regardless of whether the generated TypeScript types currently carry the discriminator — a defensive choice that makes the helpers stable across schema regenerations.
