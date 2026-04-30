/**
 * Helpers for reading typed assets out of `creative_manifest.assets`.
 *
 * `creative_manifest.assets` is a keyed map (`{ [asset_id]: AssetInstance }`)
 * where each value is a discriminated union by `asset_type`. Adopters
 * narrowing per-call write the same null-check + discriminator-check
 * boilerplate over and over. These helpers replace that boilerplate
 * without compromising the discriminator-narrowing story.
 *
 * Status: Preview / 6.0.
 *
 * @public
 */

import type { CreativeManifest } from '../../types/tools.generated';
import type { AssetInstance, AssetInstanceType } from '../../types/asset-instances';
import { AdcpError } from './async-outcome';

/**
 * Type-narrowed asset accessor by asset_id and expected asset_type.
 *
 * Returns the asset narrowed to the matching variant, or `undefined` if the
 * asset is missing or the asset_type doesn't match. Use when you want a
 * silent skip for the wrong-type case (e.g., processing a heterogeneous
 * batch where some entries don't apply to your transform).
 *
 * ```ts
 * const audio = getAsset(req.creative_manifest, 'rendered_audio', 'audio');
 * // audio is `AudioAsset | undefined` — narrowed by the discriminator
 * if (audio) {
 *   const url = audio.url;             // typed access
 *   const ms = audio.duration_ms;
 * }
 * ```
 *
 * For the require-or-throw flavor, see {@link requireAsset}.
 */
export function getAsset<T extends AssetInstanceType>(
  manifest: CreativeManifest | undefined,
  assetId: string,
  assetType: T
): Extract<AssetInstance, { asset_type: T }> | undefined {
  const asset = manifest?.assets?.[assetId];
  if (!asset || asset.asset_type !== assetType) return undefined;
  return asset as Extract<AssetInstance, { asset_type: T }>;
}

/**
 * Same as {@link getAsset} but throws `AdcpError('INVALID_REQUEST')` when
 * the asset is missing or the wrong type. Use when the asset is required
 * for the platform method to proceed (the typical creative-template case).
 *
 * Throws with a precomposed `field` path so the buyer sees actionable
 * feedback. Customize the message via the `messageOverride` arg if the
 * default doesn't fit.
 *
 * ```ts
 * const script = requireAsset(req.creative_manifest, 'script', 'text');
 * // script is `TextAsset` — never undefined past this line
 * await audioStackClient.synthesize({ text: script.content });
 * ```
 */
export function requireAsset<T extends AssetInstanceType>(
  manifest: CreativeManifest | undefined,
  assetId: string,
  assetType: T,
  messageOverride?: string
): Extract<AssetInstance, { asset_type: T }> {
  const asset = manifest?.assets?.[assetId];
  if (!asset) {
    throw new AdcpError('INVALID_REQUEST', {
      recovery: 'correctable',
      message: messageOverride ?? `creative_manifest.assets.${assetId} is required`,
      field: `creative_manifest.assets.${assetId}`,
    });
  }
  if (asset.asset_type !== assetType) {
    throw new AdcpError('INVALID_REQUEST', {
      recovery: 'correctable',
      message:
        messageOverride ??
        `creative_manifest.assets.${assetId} must be a ${assetType} asset (got asset_type='${asset.asset_type}')`,
      field: `creative_manifest.assets.${assetId}.asset_type`,
    });
  }
  return asset as Extract<AssetInstance, { asset_type: T }>;
}
