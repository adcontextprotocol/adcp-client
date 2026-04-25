// Discriminated union of creative asset instances — what a buyer DELIVERS
// inside `creative_manifest.assets`. Distinct from the asset slots that a
// publisher declares in `Format.assets[]` (see `format-asset-slots.ts`).
//
// The per-asset-type interfaces (`ImageAsset`, `VideoAsset`, …) already
// exist in `tools.generated.ts` and each carries an `asset_type` literal
// discriminator. What was missing was the union itself: a canonical
// `AssetInstance` you can use as a parameter or return type so TypeScript
// narrows correctly on the discriminator and won't accept an asset
// without one.
//
// Why this matters: handlers that returned a plain
// `{ url: '...', width: 1920, height: 1080 }` typed against
// `Record<string, unknown>` slipped through without `asset_type`. The
// schema validator caught it at runtime; with a strict union as the
// declared parameter / return type, the same error surfaces at compile
// time. PR #945's `videoAsset({...})` width/height GA tightening came
// out of this same drift class.
//
// Source of truth: schemas/cache/{version}/creative/asset-types/index.json
// (registry) and schemas/cache/{version}/core/assets/*-asset.json (per-type).

import type {
  ImageAsset,
  VideoAsset,
  AudioAsset,
  TextAsset,
  HTMLAsset,
  URLAsset,
  CSSAsset,
  JavaScriptAsset,
  MarkdownAsset,
  VASTAsset,
  DAASTAsset,
  BriefAsset,
  CatalogAsset,
  WebhookAsset,
} from './tools.generated';

/**
 * Discriminated union of every creative asset instance recognised by the
 * AdCP creative protocol. Narrow by `asset_type` to access the per-type
 * fields:
 *
 * ```ts
 * function describe(asset: AssetInstance): string {
 *   switch (asset.asset_type) {
 *     case 'image':
 *       return `${asset.width}x${asset.height} @ ${asset.url}`;
 *     case 'video':
 *       return `${asset.duration_ms ?? 0}ms ${asset.container_format ?? ''}`;
 *     case 'html':
 *       return `${asset.content.length}B inline HTML`;
 *     // ...all branches required — exhaustiveness is enforced
 *   }
 * }
 * ```
 *
 * This is the type to use for `creative_manifest.assets[<key>]` values.
 * The `assets` map itself is `Record<string, AssetInstance>` — keys come
 * from the format's declared asset slot ids; values are these instances.
 */
export type AssetInstance =
  | ImageAsset
  | VideoAsset
  | AudioAsset
  | TextAsset
  | HTMLAsset
  | URLAsset
  | CSSAsset
  | JavaScriptAsset
  | MarkdownAsset
  | VASTAsset
  | DAASTAsset
  | BriefAsset
  | CatalogAsset
  | WebhookAsset;

/**
 * The discriminator value (`asset_type`) of every variant in
 * {@link AssetInstance}. Useful for runtime branching and exhaustive
 * switch-case helpers.
 */
export type AssetInstanceType = AssetInstance['asset_type'];
