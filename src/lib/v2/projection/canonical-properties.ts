/**
 * Read structural properties off the canonical format schemas at
 * `dist/lib/schemas-data/<version>/formats/canonical/<kind>.json` in
 * published tarballs, or `schemas/cache/<version>/formats/canonical/...`
 * in a source checkout. The projection layer needs `v1_translatable`
 * per canonical to honor the normative rule from
 * `v1-canonical-mapping.json`:
 *
 *   > SDKs encountering `v1_translatable: false` on a canonical SHOULD
 *   > NOT emit `FORMAT_PROJECTION_FAILED` (which signals registry-
 *   > coverage gap) — instead surface the inherent v1-unreachability
 *   > as a different diagnostic or skip silently. The 4 inherently-v2
 *   > canonicals at 3.1 GA: `image_carousel`, `sponsored_placement`,
 *   > `responsive_creative`, `agent_placement`.
 *
 * Cached per canonical kind. Falls back to the `_base.json` default
 * (`true`) when a canonical doesn't override the field — matches the
 * spec's default semantics.
 */

import { readFileSync, existsSync } from 'fs';
import nodePath from 'path';
import type { CanonicalFormatKind } from './types';
import { SCHEMA_VERSIONS_TO_TRY } from './cache-versions';

interface CanonicalSchema {
  properties?: {
    v1_translatable?: {
      default?: boolean;
    };
  };
}

let cache: Map<CanonicalFormatKind, boolean> | null = null;
let baseDefault: boolean | null = null;

function loadCanonicalSchema(kind: CanonicalFormatKind, cacheRoot: string): CanonicalSchema | null {
  const file = nodePath.join(cacheRoot, 'formats', 'canonical', `${kind}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf-8')) as CanonicalSchema;
}

function findCacheRoot(): string {
  // Resolution order:
  //   1. Published-tarball path adjacent to the compiled loader —
  //      `dist/lib/schemas-data/<version>/`. Populated by
  //      `scripts/copy-schemas-to-dist.ts` during `build:lib`.
  //   2. Source-tree path `schemas/cache/<version>/` relative to the
  //      loader's source location. Used when running from a source
  //      checkout (e.g. `tsx`, vitest) before `build:lib`.
  //
  // Within both, versions are tried in `SCHEMA_VERSIONS_TO_TRY` order:
  // current pin/bundle wins; older prereleases survive for adopters who
  // haven't synced; `latest` is last-resort and skipped in dist (the symlink
  // is intentionally not copied — adopters pinned to 3.0.x GA hit the
  // throw below rather than silently picking up a v3.0 cache that
  // lacks canonical-format schemas).
  const candidates = [
    ...SCHEMA_VERSIONS_TO_TRY.map(v => nodePath.join(__dirname, '..', '..', 'schemas-data', v)),
    ...SCHEMA_VERSIONS_TO_TRY.map(v => nodePath.join(__dirname, '..', '..', '..', '..', 'schemas', 'cache', v)),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `No 3.1+ schema cache found. Looked in: ${candidates.join(', ')}. ` +
      `This indicates a corrupted @adcp/sdk install or an SDK packaging regression — ` +
      `please file an issue at https://github.com/adcontextprotocol/adcp-client/issues with ` +
      `your install method (npm/yarn/pnpm) and Node version. ` +
      `If you're working from a source checkout, run \`npm run sync-schemas\` then \`npm run build:lib\`.`
  );
}

/**
 * Returns true when this canonical has a v1 named-format equivalent;
 * false when v2-only. The 4 inherently-v2 canonicals at 3.1 GA are
 * `image_carousel`, `sponsored_placement`, `responsive_creative`,
 * `agent_placement`; everything else inherits `true` from
 * `formats/canonical/_base.json`'s default.
 *
 * `custom` returns `true` (the per-declaration `canonical_formats_only`
 * flag is the actual signal there — custom isn't a baked-in v1/v2
 * classification).
 */
export function isCanonicalV1Translatable(kind: CanonicalFormatKind): boolean {
  if (cache && cache.has(kind)) return cache.get(kind)!;

  if (cache === null) cache = new Map();

  if (kind === 'custom') {
    cache.set(kind, true);
    return true;
  }

  const cacheRoot = findCacheRoot();

  if (baseDefault === null) {
    const base = loadCanonicalSchema('_base' as CanonicalFormatKind, cacheRoot);
    const bd = base?.properties?.v1_translatable?.default;
    baseDefault = typeof bd === 'boolean' ? bd : true;
  }

  const schema = loadCanonicalSchema(kind, cacheRoot);
  const override = schema?.properties?.v1_translatable?.default;
  const value = typeof override === 'boolean' ? override : baseDefault;
  cache.set(kind, value);
  return value;
}

/** Test hook: reset the memoized canonical properties cache. */
export function _resetCanonicalPropertiesCache(): void {
  cache = null;
  baseDefault = null;
}

/** Runtime creative-fact checks. This module does not discover or fetch media. */
export type CreativeFitVerdict = 'fits' | 'fits_with_adaptation' | 'insufficient_facts' | 'does_not_fit';

export interface CreativeFitReason {
  code: string;
  path: string;
  expected?: string | number | boolean | readonly (string | number)[];
  actual?: string | number | boolean | readonly (string | number)[];
}

/** Caller-measured facts about one identified primary asset, using protocol units. */
export interface CreativePrimaryAssetFacts {
  asset_group_id?: string;
  width?: number;
  height?: number;
  pixel_ratio?: number;
  duration_ms?: number;
  codec?: string;
  video_codec?: string;
  audio_codec?: string;
  container_format?: string;
  mime_type?: string;
  format?: string;
  file_size_bytes?: number;
  bitrate_kbps?: number;
  video_bitrate_kbps?: number;
  audio_bitrate_kbps?: number;
  frame_rate?: number;
  sampling_rate_hz?: number;
  channels?: string;
  delivery_type?: 'tag_url' | 'inline_markup' | 'paired_redirect';
  vast_version?: string;
  delivery_method?: string;
}

export interface CreativeVastInlineFacts {
  creative_type: 'linear' | 'nonlinear';
  media_files?: readonly CreativePrimaryAssetFacts[];
}

type Json = Record<string, unknown>;
type Pair = { width: number; height: number };
type Interval = readonly [number, number];

/** @internal */
export interface NormalizedCreativeFitFacts {
  kind?: string;
  params: Json;
  primary: Json;
  primary_assets: readonly Json[];
  assets: Json;
  primary_asset_group_id?: string;
  problems: readonly CreativeFitReason[];
  vast_inline_creatives?: readonly CreativeVastInlineFacts[];
}

/** @internal */
export interface DeclaredCreativeFit {
  verdict: CreativeFitVerdict;
  reasons: readonly CreativeFitReason[];
  /** Concrete logical dimensions, when image density or a discrete size resolved them. */
  logical_size?: Pair;
  pixel_ratio?: number;
  pixel_ratios?: readonly number[];
}

/** @internal Preserve distinct diagnostics before applying the public budget. */
export function uniqueCreativeFitReasons(reasons: readonly CreativeFitReason[]): CreativeFitReason[] {
  const seen = new Set<string>();
  return reasons
    .filter(reason => {
      const key = JSON.stringify([reason.code, reason.path]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 32);
}

/** @internal Match the existing legacy size acceptor's allowance for rounded dimensions. */
export const CREATIVE_FIT_ASPECT_RATIO_TOLERANCE = 0.01;

const PRIMARY: Record<string, { slot: string; types: readonly string[] }> = {
  image: { slot: 'image_main', types: ['image'] },
  html5: { slot: 'html5_bundle', types: ['zip'] },
  display_tag: { slot: 'tag_url', types: ['display_tag', 'html', 'url'] },
  video_hosted: { slot: 'video_main', types: ['video'] },
  audio_hosted: { slot: 'audio_main', types: ['audio'] },
  video_vast: { slot: 'vast_tag', types: ['vast'] },
  audio_vast: { slot: 'vast_tag', types: ['vast'] },
};
const FACT_KEYS = [
  'width',
  'height',
  'pixel_ratio',
  'duration_ms',
  'codec',
  'video_codec',
  'audio_codec',
  'container_format',
  'mime_type',
  'format',
  'file_size_bytes',
  'bitrate_kbps',
  'video_bitrate_kbps',
  'audio_bitrate_kbps',
  'frame_rate',
  'sampling_rate_hz',
  'channels',
  'delivery_type',
  'vast_version',
] as const;

function record(value: unknown): Json | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
}
function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
function pair(value: unknown): Pair | undefined {
  const item = record(value);
  return item && positive(item.width) && positive(item.height) ? { width: item.width, height: item.height } : undefined;
}
function scalar(value: unknown): CreativeFitReason['actual'] {
  if (typeof value === 'string') return value.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ').slice(0, 120);
  if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean')
    return value as number | boolean;
  return undefined;
}
function reason(code: string, path: string, expected?: unknown, actual?: unknown): CreativeFitReason {
  return {
    code,
    path: String(scalar(path)),
    ...(scalar(expected) !== undefined && { expected: scalar(expected) }),
    ...(scalar(actual) !== undefined && { actual: scalar(actual) }),
  };
}

/** @internal */
export function normalizeCreativeFitFacts(
  creative: Json,
  measured?: CreativePrimaryAssetFacts,
  vastInline?: readonly CreativeVastInlineFacts[],
  legacyClaims?: Json
): NormalizedCreativeFitFacts {
  const kind = typeof creative.format_kind === 'string' ? creative.format_kind : undefined;
  const definition = kind ? PRIMARY[kind] : undefined;
  const assets = record(creative.assets) ?? {};
  const problems: CreativeFitReason[] = [];
  const entries = Object.entries(assets).flatMap(([key, value]) =>
    (Array.isArray(value) ? value : [value]).flatMap(item => {
      const asset = record(item);
      return asset && definition?.types.includes(String(asset.asset_type)) ? [{ key, asset }] : [];
    })
  );
  const requested = measured?.asset_group_id;
  const defaultEntries = entries.filter(entry => entry.key === definition?.slot);
  const selected =
    requested !== undefined
      ? entries.filter(entry => entry.key === requested)
      : defaultEntries.length > 0
        ? defaultEntries
        : entries.length === 1
          ? entries
          : [];
  if (requested !== undefined && selected.length === 0)
    problems.push(reason('primary_asset_not_found', 'primaryAssetFacts.asset_group_id'));
  if (selected.length === 0 && entries.length > 1) problems.push(reason('primary_asset_ambiguous', 'assets'));
  if (measured && selected.length > 1)
    problems.push(reason('primary_asset_ambiguous', 'primaryAssetFacts.asset_group_id'));
  const primary: Json = selected.length === 1 ? { ...selected[0]!.asset } : {};
  for (const key of FACT_KEYS) {
    const supplied = measured?.[key];
    if (supplied === undefined) continue;
    if (primary[key] !== undefined && primary[key] !== supplied)
      problems.push(reason('conflicting_facts', `primaryAssetFacts.${key}`, primary[key], supplied));
    else primary[key] = supplied;
  }
  if (kind === 'video_hosted' && primary.codec !== undefined) {
    if (primary.video_codec !== undefined && primary.video_codec !== primary.codec)
      problems.push(reason('conflicting_facts', 'primaryAssetFacts.codec'));
    else primary.video_codec = primary.codec;
  }
  if (kind === 'audio_hosted' && primary.audio_codec !== undefined) {
    if (primary.codec !== undefined && primary.codec !== primary.audio_codec)
      problems.push(reason('conflicting_facts', 'primaryAssetFacts.audio_codec'));
    else primary.codec = primary.audio_codec;
  }
  if (kind === 'display_tag' && primary.asset_type === 'url') {
    if (primary.url_type === 'ad_request') {
      if (primary.delivery_type !== undefined && primary.delivery_type !== 'tag_url')
        problems.push(reason('conflicting_facts', 'primaryAssetFacts.delivery_type'));
      else primary.delivery_type = 'tag_url';
    } else if (primary.url_type === undefined) problems.push(reason('display_tag_delivery_unproven', 'assets'));
    else problems.push(reason('invalid_fact', 'assets.url_type'));
  }
  const params = { ...(record(creative.format_parameters) ?? record(creative.params) ?? {}) };
  for (const key of ['width', 'height', 'duration_ms', 'pixel_ratio']) {
    if (legacyClaims?.[key] === undefined) continue;
    if (params[key] !== undefined && params[key] !== legacyClaims[key])
      problems.push(reason('conflicting_facts', `format_parameters.${key}`));
    else params[key] = legacyClaims[key];
  }
  if (
    params.pixel_ratio !== undefined &&
    primary.pixel_ratio !== undefined &&
    params.pixel_ratio !== primary.pixel_ratio
  )
    problems.push(reason('conflicting_facts', 'format_parameters.pixel_ratio'));
  for (const key of ['width', 'height', 'duration_ms', 'duration_ms_exact', 'pixel_ratio']) {
    if (params[key] !== undefined && !positive(params[key]))
      problems.push(reason('invalid_fact', `format_parameters.${key}`));
  }
  for (const key of ['width', 'height', 'duration_ms', 'pixel_ratio', 'file_size_bytes'] as const) {
    if (primary[key] !== undefined && !positive(primary[key]))
      problems.push(reason('invalid_fact', `primaryAssetFacts.${key}`));
  }
  for (const key of [
    'bitrate_kbps',
    'video_bitrate_kbps',
    'audio_bitrate_kbps',
    'frame_rate',
    'sampling_rate_hz',
  ] as const) {
    if (primary[key] !== undefined && !positive(primary[key]))
      problems.push(reason('invalid_fact', `primaryAssetFacts.${key}`));
  }
  const claimedDuration = params.duration_ms_exact ?? params.duration_ms;
  if (claimedDuration !== undefined && primary.duration_ms !== undefined && claimedDuration !== primary.duration_ms)
    problems.push(
      reason('conflicting_facts', 'format_parameters.duration_ms_exact', claimedDuration, primary.duration_ms)
    );
  if (claimedDuration === undefined && positive(primary.duration_ms) && params.duration_ms_range !== undefined) {
    const range = interval(params.duration_ms_range);
    if (!range) problems.push(reason('invalid_fact', 'format_parameters.duration_ms_range'));
    else if (primary.duration_ms < range[0] || primary.duration_ms > range[1])
      problems.push(reason('conflicting_facts', 'format_parameters.duration_ms_range'));
  }
  if (kind !== 'image' && kind !== 'video_vast' && kind !== 'audio_vast') {
    for (const key of ['width', 'height'] as const) {
      if (params[key] !== undefined && primary[key] !== undefined && params[key] !== primary[key])
        problems.push(reason('conflicting_facts', `format_parameters.${key}`, params[key], primary[key]));
    }
  }
  return {
    kind,
    params,
    primary,
    assets,
    primary_assets: selected.length === 1 ? [primary] : selected.map(entry => entry.asset),
    ...(selected[0] && { primary_asset_group_id: selected[0].key }),
    problems,
    ...(vastInline !== undefined && { vast_inline_creatives: vastInline }),
  };
}

function interval(value: unknown): Interval | undefined {
  if (!Array.isArray(value) || value.length !== 2 || value.every(item => item === null)) return undefined;
  if (!value.every(item => item === null || (typeof item === 'number' && Number.isFinite(item) && item >= 0)))
    return undefined;
  const low = value[0] === null ? -Infinity : (value[0] as number);
  const high = value[1] === null ? Infinity : (value[1] as number);
  return low <= high ? [low, high] : undefined;
}

/** @internal Known violations beat incomplete evidence within one declaration. */
export function evaluateDeclaredCreativeFit(
  facts: NormalizedCreativeFitFacts,
  declaration: Json,
  path = 'format_options',
  scope: 'canonical' | 'legacy_shape' | 'legacy_catalog_shape' = 'canonical'
): DeclaredCreativeFit {
  const failures: CreativeFitReason[] = [
    ...facts.problems.filter(item => item.code === 'conflicting_facts' || item.code === 'invalid_fact'),
  ];
  const missing: CreativeFitReason[] = [
    ...facts.problems.filter(item => item.code !== 'conflicting_facts' && item.code !== 'invalid_fact'),
  ];
  const params = record(declaration.params) ?? {};
  const handled = new Set<string>();
  const fail = (code: string, field: string, expected?: unknown, actual?: unknown) =>
    failures.push(reason(code, `${path}.params.${field}`, expected, actual));
  const unknown = (code: string, field: string) => missing.push(reason(code, `${path}.${field}`));
  if (!facts.kind) unknown('format_kind_missing', 'format_kind');
  else if (facts.kind !== declaration.format_kind)
    fail('format_kind_mismatch', 'format_kind', declaration.format_kind, facts.kind);
  if (scope === 'canonical' && declaration.technical_requirements_complete !== true)
    unknown('technical_requirements_incomplete', 'technical_requirements_complete');
  if (scope !== 'canonical') {
    // A legacy reference describes a bounded shape envelope, not the complete
    // canonical technical contract. Missing essentials cannot become wildcards.
    if (['image', 'html5', 'display_tag', 'video_hosted'].includes(String(facts.kind))) {
      for (const axis of ['width', 'height'])
        if (!positive(params[axis])) unknown('legacy_dimensions_unstated', `params.${axis}`);
    }
    if (['video_hosted', 'audio_hosted', 'video_vast', 'audio_vast'].includes(String(facts.kind))) {
      if (!positive(params.duration_ms_exact) && !interval(params.duration_ms_range))
        unknown('legacy_duration_unstated', 'params.duration_ms_exact');
    }
    if (facts.kind === 'display_tag' && params.supported_delivery_types === undefined)
      unknown('legacy_delivery_type_unproven', 'params.supported_delivery_types');
  }
  if (!facts.kind || !PRIMARY[facts.kind]) unknown('unsupported_format_kind', 'format_kind');
  if (declaration.format_schema !== undefined || facts.kind === 'custom')
    unknown('unresolved_format_schema', 'format_schema');
  if (facts.primary_assets.length === 0) unknown('primary_asset_missing', 'assets');
  if (
    facts.kind &&
    PRIMARY[facts.kind] &&
    facts.primary_asset_group_id !== PRIMARY[facts.kind]!.slot &&
    !Array.isArray(params.slots)
  )
    unknown('primary_slot_binding_unproven', 'assets');
  if (
    Array.isArray(params.slots) &&
    facts.primary_asset_group_id !== undefined &&
    !params.slots.some(value => {
      const slot = record(value);
      if (!slot) return false;
      return (
        slot?.asset_group_id === facts.primary_asset_group_id &&
        (slot.asset_type === undefined || facts.primary_assets.every(asset => asset.asset_type === slot.asset_type))
      );
    })
  )
    unknown('primary_slot_binding_unproven', 'params.slots');
  for (const field of ['locale_policy', 'tracker_execution_contract', 'macro_resolution_capabilities']) {
    if (declaration[field] !== undefined) unknown('unsupported_constraint', field);
  }

  const isVast = facts.kind === 'video_vast' || facts.kind === 'audio_vast';
  let logicalSize: Pair | undefined;
  let pixelRatio: number | undefined;
  const renditionDensities = new Set<number>();
  const sizeKeys = [
    'width',
    'height',
    'sizes',
    'min_width',
    'max_width',
    'min_height',
    'max_height',
    'aspect_ratio',
    'orientation',
  ];
  sizeKeys.forEach(key => handled.add(key));
  handled.add('pixel_ratios');
  const hasSize = sizeKeys.some(key => params[key] !== undefined);
  if (facts.kind !== 'image') {
    for (const axis of ['width', 'height']) {
      const actual = isVast ? facts.params[axis] : (facts.primary[axis] ?? facts.params[axis]);
      if (!positive(actual)) continue;
      if (positive(params[axis]) && actual !== params[axis]) fail('size_mismatch', axis, params[axis], actual);
      const low = params[`min_${axis}`],
        high = params[`max_${axis}`];
      if (positive(low) && actual < low) fail('size_mismatch', axis);
      if (positive(high) && actual > high) fail('size_mismatch', axis);
      if (Array.isArray(params.sizes) && params.sizes.every(value => record(value)?.[axis] !== actual))
        fail('size_mismatch', axis);
    }
  }
  for (const key of ['width', 'height', 'min_width', 'max_width', 'min_height', 'max_height']) {
    if (params[key] !== undefined && !positive(params[key])) unknown('invalid_declaration', `params.${key}`);
  }
  for (const axis of ['width', 'height']) {
    const low = params[`min_${axis}`],
      high = params[`max_${axis}`];
    if (typeof low === 'number' && typeof high === 'number' && low > high)
      unknown('invalid_declaration', `params.${axis}`);
  }
  const listed = Array.isArray(params.sizes) ? params.sizes.flatMap(value => (pair(value) ? [pair(value)!] : [])) : [];
  if (
    params.sizes !== undefined &&
    (listed.length === 0 || !Array.isArray(params.sizes) || listed.length !== params.sizes.length)
  )
    unknown('invalid_declaration', 'params.sizes');
  const sizeAccepts = (size: Pair): boolean => {
    if (typeof params.width === 'number' && size.width !== params.width) return false;
    if (typeof params.height === 'number' && size.height !== params.height) return false;
    if (listed.length > 0 && !listed.some(item => item.width === size.width && item.height === size.height))
      return false;
    for (const [key, actual, lower] of [
      ['min_width', size.width, true],
      ['max_width', size.width, false],
      ['min_height', size.height, true],
      ['max_height', size.height, false],
    ] as const) {
      const bound = params[key];
      if (typeof bound === 'number' && (lower ? actual < bound : actual > bound)) return false;
    }
    if (typeof params.aspect_ratio === 'string') {
      const parts = params.aspect_ratio.split(':').map(Number);
      if (
        parts.length !== 2 ||
        !parts.every(positive) ||
        Math.abs(size.width / size.height / (parts[0]! / parts[1]!) - 1) > CREATIVE_FIT_ASPECT_RATIO_TOLERANCE
      )
        return false;
    }
    if (typeof params.orientation === 'string') {
      const orientation = size.width === size.height ? 'square' : size.width > size.height ? 'horizontal' : 'vertical';
      if (params.orientation !== orientation) return false;
    }
    return true;
  };
  if (!isVast && facts.kind === 'image') {
    const slots = Array.isArray(params.slots)
      ? params.slots.flatMap(value => (record(value) ? [record(value)!] : []))
      : [];
    const primarySlot = slots.find(slot => slot.asset_group_id === (facts.primary_asset_group_id ?? 'image_main'));
    const slotRatios = primarySlot?.pixel_ratios;
    const topRatios =
      params.pixel_ratios === undefined
        ? Array.isArray(slotRatios)
          ? slotRatios.filter(positive)
          : [1]
        : Array.isArray(params.pixel_ratios)
          ? params.pixel_ratios.filter(positive)
          : [];
    const ratios = Array.isArray(slotRatios) ? topRatios.filter(value => slotRatios.includes(value)) : topRatios;
    const required = primarySlot?.required_pixel_ratios;
    if (
      topRatios.length === 0 ||
      (Array.isArray(params.pixel_ratios) && topRatios.length !== params.pixel_ratios.length)
    )
      unknown('invalid_declaration', 'params.pixel_ratios');
    if (ratios.length === 0) unknown('pixel_ratio_intersection_empty', 'params.pixel_ratios');
    if (facts.primary_assets.length === 0) unknown('primary_asset_missing', 'assets');
    for (const asset of facts.primary_assets) {
      const intrinsic = pair(asset);
      const assetRatio = asset.pixel_ratio ?? facts.params.pixel_ratio;
      if (!intrinsic) {
        const possibleRatios = ratios.filter(ratio => assetRatio === undefined || assetRatio === ratio);
        for (const axis of ['width', 'height']) {
          const measured = asset[axis];
          if (!positive(measured) || possibleRatios.length === 0) continue;
          if (
            possibleRatios.every(ratio => {
              const logical = measured / ratio;
              return (
                !Number.isInteger(logical) ||
                (positive(params[axis]) && params[axis] !== logical) ||
                (positive(params[`min_${axis}`]) && logical < (params[`min_${axis}`] as number)) ||
                (positive(params[`max_${axis}`]) && logical > (params[`max_${axis}`] as number)) ||
                (Array.isArray(params.sizes) && params.sizes.every(size => record(size)?.[axis] !== logical)) ||
                (positive(facts.params[axis]) && facts.params[axis] !== logical)
              );
            })
          )
            fail('size_mismatch', axis);
        }
        if (assetRatio !== undefined && possibleRatios.length === 0 && ratios.length > 0)
          fail('size_mismatch', 'pixel_ratios');
        unknown('primary_asset_dimensions_missing', 'primaryAssetFacts.width/height');
        continue;
      }
      if (!hasSize && assetRatio === undefined && ratios.some(ratio => ratio !== 1)) {
        unknown('pixel_ratio_not_inferable', 'primaryAssetFacts.pixel_ratio');
        continue;
      }
      const candidates = ratios.flatMap(ratio => {
        if (assetRatio !== undefined && ratio !== assetRatio) return [];
        const size = { width: intrinsic.width / ratio, height: intrinsic.height / ratio };
        if (!Number.isInteger(size.width) || !Number.isInteger(size.height) || !sizeAccepts(size)) return [];
        if (
          (typeof facts.params.width === 'number' && facts.params.width !== size.width) ||
          (typeof facts.params.height === 'number' && facts.params.height !== size.height)
        )
          return [];
        return [{ size, ratio }];
      });
      if (candidates.length === 0)
        fail(scope !== 'canonical' ? 'size_mismatch' : 'image_size_or_density_mismatch', 'sizes');
      else if (candidates.length > 1) unknown('pixel_ratio_ambiguous', 'primaryAssetFacts.pixel_ratio');
      else {
        logicalSize = candidates[0]!.size;
        pixelRatio = candidates[0]!.ratio;
        renditionDensities.add(pixelRatio);
      }
    }
    if (Array.isArray(required)) {
      const seen = new Set<number>();
      for (const asset of facts.primary_assets) {
        const size = pair(asset);
        const matches = size
          ? ratios.filter(
              ratio =>
                (asset.pixel_ratio === undefined || asset.pixel_ratio === ratio) &&
                sizeAccepts({ width: size.width / ratio, height: size.height / ratio })
            )
          : [];
        if (matches.length !== 1) {
          unknown('rendition_density_unresolved', 'assets');
          continue;
        }
        if (seen.has(matches[0]!)) fail('pixel_ratio_duplicate', 'slots.required_pixel_ratios');
        seen.add(matches[0]!);
      }
      if (required.some(ratio => !ratios.includes(ratio as number)))
        unknown('required_pixel_ratio_not_accepted', 'params.slots');
      if (required.some(ratio => !seen.has(ratio as number)))
        fail('required_pixel_ratio_missing', 'slots.required_pixel_ratios');
    }
  } else if (hasSize) {
    // VAST asset/rendition dimensions are not player dimensions. Only an
    // explicit creative player-size claim participates in this comparison.
    const size = isVast ? pair(facts.params) : (pair(facts.primary) ?? pair(facts.params));
    const supported = Array.isArray(facts.primary.sizes)
      ? facts.primary.sizes.flatMap(value => (pair(value) ? [pair(value)!] : []))
      : [];
    const possibilities = size ? [size] : supported;
    if (possibilities.length === 0 && !isVast) unknown('rendered_dimensions_missing', 'primaryAssetFacts.width/height');
    else if (possibilities.length === 0) {
      /* unstated VAST player size inherits placement */
    } else {
      const matches = possibilities.filter(sizeAccepts);
      if (matches.length === 0) fail('size_mismatch', 'sizes');
      else if (matches.length < possibilities.length) unknown('render_size_selection_unproven', 'assets.sizes');
      else if (matches.length === 1) logicalSize = matches[0];
    }
  }

  for (const key of ['duration_ms', 'duration_ms_exact', 'duration_ms_range']) handled.add(key);
  const declaredRange = interval(facts.params.duration_ms_range);
  const duration =
    facts.params.duration_ms_exact ??
    facts.params.duration_ms ??
    facts.primary.duration_ms ??
    (declaredRange?.[0] === declaredRange?.[1] ? declaredRange?.[0] : undefined);
  if (params.duration_ms_exact !== undefined) {
    if (!positive(params.duration_ms_exact)) unknown('invalid_declaration', 'params.duration_ms_exact');
    else if (duration === undefined) unknown('duration_missing', 'primaryAssetFacts.duration_ms');
    else if (duration !== params.duration_ms_exact)
      fail('duration_mismatch', 'duration_ms_exact', params.duration_ms_exact, duration);
  } else if (params.duration_ms_range !== undefined) {
    const accepted = interval(params.duration_ms_range);
    if (!accepted) unknown('invalid_declaration', 'params.duration_ms_range');
    else if (positive(duration)) {
      if (duration < accepted[0] || duration > accepted[1])
        fail('duration_out_of_range', 'duration_ms_range', undefined, duration);
    } else if (declaredRange) {
      if (declaredRange[0] < accepted[0] || declaredRange[1] > accepted[1])
        fail('duration_range_not_contained', 'duration_ms_range');
    } else unknown('duration_missing', 'primaryAssetFacts.duration_ms');
  }

  const checkSet = (key: string, actual: unknown) => {
    handled.add(key);
    const accepted = params[key];
    if (accepted === undefined) return;
    if (!Array.isArray(accepted) || accepted.length === 0) {
      unknown('invalid_declaration', `params.${key}`);
      return;
    }
    if (actual === undefined) {
      const fields: Record<string, string> = {
        video_codecs: 'video_codec',
        audio_codecs: facts.kind === 'audio_hosted' ? 'codec' : 'audio_codec',
        containers: 'container_format',
        mime_types: 'mime_type',
        image_formats: 'format',
        audio_sample_rates: 'sampling_rate_hz',
        audio_channels: 'channels',
        frame_rates: 'frame_rate',
        supported_delivery_types: 'delivery_type',
        vast_versions: 'vast_version',
      };
      unknown('fact_missing', `primaryAssetFacts.${fields[key] ?? key}`);
    } else if (!accepted.includes(actual)) fail('value_not_accepted', key, undefined, actual);
  };
  checkSet('video_codecs', facts.primary.video_codec);
  checkSet('audio_codecs', facts.kind === 'audio_hosted' ? facts.primary.codec : facts.primary.audio_codec);
  checkSet('containers', facts.primary.container_format);
  checkSet('mime_types', facts.primary.mime_type);
  checkSet('image_formats', facts.primary.format);
  checkSet('audio_sample_rates', facts.primary.sampling_rate_hz);
  checkSet('audio_channels', facts.primary.channels);
  checkSet('frame_rates', facts.primary.frame_rate);
  checkSet('supported_delivery_types', facts.primary.delivery_type);
  checkSet('vast_versions', facts.primary.vast_version);
  handled.add('vast_version');
  if (params.vast_version !== undefined) {
    if (facts.primary.vast_version === undefined) unknown('fact_missing', 'primaryAssetFacts.vast_version');
    else if (facts.primary.vast_version !== params.vast_version) fail('value_not_accepted', 'vast_version');
  }
  for (const [key, factKey, factor, lower] of [
    ['max_file_size_kb', 'file_size_bytes', 1000, false],
    ['max_file_size_mb', 'file_size_bytes', 1000000, false],
    ['min_bitrate_kbps', facts.kind === 'video_hosted' ? 'video_bitrate_kbps' : 'bitrate_kbps', 1, true],
    ['max_bitrate_kbps', facts.kind === 'video_hosted' ? 'video_bitrate_kbps' : 'bitrate_kbps', 1, false],
  ] as const) {
    handled.add(key);
    if (params[key] === undefined) continue;
    const bound = params[key],
      actual = facts.primary[factKey];
    if (!positive(bound)) unknown('invalid_declaration', `params.${key}`);
    else if (actual === undefined) unknown('fact_missing', `primaryAssetFacts.${factKey}`);
    else if (!positive(actual) || (lower ? actual < bound * factor : actual > bound * factor))
      fail('numeric_constraint_failed', key, bound * factor, actual);
  }

  handled.add('media_file_requirements');
  if (isVast && params.media_file_requirements !== undefined) {
    const requirements = record(params.media_file_requirements);
    const inline = facts.vast_inline_creatives;
    if (!requirements || inline === undefined) unknown('vast_rendition_evidence_missing', 'vastInlineCreatives');
    else {
      const linear = inline.filter(item => item.creative_type === 'linear');
      if (linear.length === 0) unknown('vast_linear_evidence_missing', 'vastInlineCreatives');
      for (const [index, item] of linear.entries()) {
        if (!item.media_files?.length) {
          unknown('vast_rendition_evidence_missing', `vastInlineCreatives[${index}].media_files`);
          continue;
        }
        const alternatives = item.media_files.map(media => evaluateMediaFile(media, requirements));
        if (alternatives.some(status => status === 'match')) continue;
        if (alternatives.some(status => status === 'unknown'))
          unknown('vast_rendition_evidence_missing', `vastInlineCreatives[${index}].media_files`);
        else fail('vast_media_file_mismatch', 'media_file_requirements');
      }
    }
  }
  // Slots/extensions require their own evidence. Never silently certify unknown acceptance.
  for (const key of Object.keys(params)) {
    if (handled.has(key)) continue;
    if (key === 'slots') {
      const slots = Array.isArray(params.slots) ? params.slots : [];
      if (!Array.isArray(params.slots)) unknown('invalid_declaration', 'params.slots');
      for (const value of slots) {
        const slot = record(value);
        if (!slot || typeof slot.asset_group_id !== 'string') {
          unknown('invalid_declaration', 'params.slots');
          continue;
        }
        for (const key of ['min', 'max']) {
          const count = slot[key];
          if (count !== undefined && (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0))
            unknown('invalid_declaration', `params.slots.${key}`);
        }
        if (typeof slot.min === 'number' && typeof slot.max === 'number' && slot.min > slot.max)
          unknown('invalid_declaration', 'params.slots');
        const raw = facts.assets[slot.asset_group_id];
        const items = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
        const unboundCatalogSlot = scope === 'legacy_catalog_shape' && raw === undefined;
        if ((slot.required === true || (typeof slot.min === 'number' && slot.min > 0)) && items.length === 0) {
          if (unboundCatalogSlot) unknown('legacy_slot_binding_unproven', 'params.slots');
          else fail('required_slot_missing', 'slots');
        }
        if (
          (typeof slot.min === 'number' && items.length < slot.min) ||
          (typeof slot.max === 'number' && items.length > slot.max)
        )
          if (unboundCatalogSlot) unknown('legacy_slot_binding_unproven', 'params.slots');
          else fail('slot_count_mismatch', 'slots');
        if (typeof slot.asset_type === 'string' && items.some(item => record(item)?.asset_type !== slot.asset_type))
          fail('slot_asset_type_mismatch', 'slots');
        if (
          (slot.pixel_ratios !== undefined || slot.required_pixel_ratios !== undefined) &&
          (facts.kind !== 'image' || slot.asset_group_id !== facts.primary_asset_group_id)
        ) {
          unknown('unsupported_constraint', 'params.slots.pixel_ratios');
        }
      }
      if (
        slots.some(value => {
          const slot = record(value);
          return (
            !slot ||
            Object.keys(slot).some(
              k =>
                ![
                  'asset_group_id',
                  'asset_type',
                  'required',
                  'min',
                  'max',
                  'pixel_ratios',
                  'required_pixel_ratios',
                ].includes(k)
            )
          );
        })
      )
        unknown('unsupported_constraint', `params.${key}`);
    } else unknown('unsupported_constraint', `params.${key}`);
  }
  if (declaration.serve_adaptations !== undefined) unknown('unsupported_adaptation_contract', 'serve_adaptations');
  return {
    verdict: failures.length > 0 ? 'does_not_fit' : missing.length > 0 ? 'insufficient_facts' : 'fits',
    reasons: uniqueCreativeFitReasons([...failures, ...missing]),
    ...(logicalSize && { logical_size: logicalSize }),
    ...(renditionDensities.size === 1 && pixelRatio !== undefined && { pixel_ratio: pixelRatio }),
    ...(renditionDensities.size > 0 && { pixel_ratios: [...renditionDensities].sort((a, b) => a - b) }),
  };
}

function evaluateMediaFile(media: CreativePrimaryAssetFacts, requirements: Json): 'match' | 'mismatch' | 'unknown' {
  let unknown = false;
  for (const [key, accepted] of Object.entries(requirements)) {
    const setKeys: Record<string, keyof CreativePrimaryAssetFacts> = {
      mime_types: 'mime_type',
      containers: 'container_format',
      codecs: 'codec',
      delivery_methods: 'delivery_method',
    };
    if (setKeys[key]) {
      const actual = media[setKeys[key]!];
      if (actual === undefined || !Array.isArray(accepted) || accepted.length === 0) unknown = true;
      else if (key === 'mime_types' && typeof actual === 'string') {
        if (
          !accepted.some(
            value => typeof value === 'string' && value.trim().toLowerCase() === actual.trim().toLowerCase()
          )
        )
          return 'mismatch';
      } else if (!accepted.includes(actual)) return 'mismatch';
      continue;
    }
    const numeric: Record<string, [keyof CreativePrimaryAssetFacts, boolean]> = {
      min_width: ['width', true],
      max_width: ['width', false],
      min_height: ['height', true],
      max_height: ['height', false],
      min_bitrate_kbps: ['bitrate_kbps', true],
      max_bitrate_kbps: ['bitrate_kbps', false],
      max_file_size_bytes: ['file_size_bytes', false],
    };
    const field = numeric[key];
    if (!field) {
      unknown = true;
      continue;
    }
    const actual = media[field[0]];
    if (typeof actual !== 'number' || !positive(accepted)) unknown = true;
    else if (!positive(actual) || (field[1] ? actual < accepted : actual > accepted)) return 'mismatch';
  }
  return unknown ? 'unknown' : 'match';
}
