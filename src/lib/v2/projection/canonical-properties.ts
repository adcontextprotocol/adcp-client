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
import path from 'path';
import type { CanonicalFormatKind } from './types';
import { BETA_VERSIONS_TO_TRY } from './cache-versions';
import { getSchemaDataRoots } from '../../internal/schema-data-roots';

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
  const file = path.join(cacheRoot, 'formats', 'canonical', `${kind}.json`);
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
  // Within both, versions are tried in `BETA_VERSIONS_TO_TRY` order:
  // current pin/bundle wins; older prereleases survive for adopters who
  // haven't synced; `latest` is last-resort and skipped in dist (the symlink
  // is intentionally not copied — adopters pinned to 3.0.x GA hit the
  // throw below rather than silently picking up a v3.0 cache that
  // lacks canonical-format schemas).
  const { builtSchemasDataRoot, sourceSchemasCacheRoot } = getSchemaDataRoots();
  const candidates = [
    ...BETA_VERSIONS_TO_TRY.map(v => path.join(builtSchemasDataRoot, v)),
    ...BETA_VERSIONS_TO_TRY.map(v => path.join(sourceSchemasCacheRoot, v)),
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
