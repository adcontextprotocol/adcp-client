// Typed factory helpers for `build_creative` return values. Five shapes:
//   1. bare `CreativeManifest`            — auto-wrapped as `{ creative_manifest }`
//   2. bare `CreativeManifest[]`          — auto-wrapped as `{ creative_manifests }`
//   3. shaped `BuildCreativeSuccess`      — passthrough
//   4. shaped `BuildCreativeMultiSuccess` — passthrough multi-format
//   5. shaped `BuildCreativeVariantSuccess` — passthrough multiplicity
//
// Adopters writing the shaped envelope by hand consistently miss the
// distinction between single (`creative_manifest`) and multi
// (`creative_manifests`) field names. SHAPE-GOTCHAS §5.

import type { BuildCreativeSuccess, BuildCreativeMultiSuccess, CreativeManifest } from '../types/core.generated';
import type { BuildCreativeVariantSuccess } from '../types/tools.generated';

type SingleEnvelopeFields = Omit<BuildCreativeSuccess, 'creative_manifest'> & { manifest: CreativeManifest };
type MultiEnvelopeFields = Omit<BuildCreativeMultiSuccess, 'creative_manifests'> & { manifests: CreativeManifest[] };

/** Bare single-format manifest. Framework wraps as `{ creative_manifest }`. */
export function singleBuildCreativeReturn(manifest: CreativeManifest): CreativeManifest {
  return manifest;
}

/** Bare multi-format manifest array. Framework wraps as `{ creative_manifests }`. */
export function multiBuildCreativeReturn(manifests: CreativeManifest[]): CreativeManifest[] {
  return manifests;
}

/** Shaped `BuildCreativeSuccess`. `manifest` field renamed to `creative_manifest` on wire. */
export function singleEnvelopedBuildCreativeReturn(fields: SingleEnvelopeFields): BuildCreativeSuccess {
  const { manifest, ...rest } = fields;
  return { ...rest, creative_manifest: manifest };
}

/** Shaped `BuildCreativeMultiSuccess`. `manifests` renamed to `creative_manifests` on wire. */
export function multiEnvelopedBuildCreativeReturn(fields: MultiEnvelopeFields): BuildCreativeMultiSuccess {
  const { manifests, ...rest } = fields;
  if (manifests.length === 0) {
    throw new Error('multiEnvelopedBuildCreativeReturn requires at least one creative manifest');
  }
  return { ...rest, creative_manifests: manifests as [CreativeManifest, ...CreativeManifest[]] };
}

/** Shaped multiplicity response. Passed through with its top-level `creatives` array intact. */
export function variantEnvelopedBuildCreativeReturn(fields: BuildCreativeVariantSuccess): BuildCreativeVariantSuccess {
  return fields;
}

/** Grouped accessor for the five `build_creative` return shapes. */
export const buildCreativeReturn = {
  single: singleBuildCreativeReturn,
  multi: multiBuildCreativeReturn,
  singleEnveloped: singleEnvelopedBuildCreativeReturn,
  multiEnveloped: multiEnvelopedBuildCreativeReturn,
  variantEnveloped: variantEnvelopedBuildCreativeReturn,
} as const;
