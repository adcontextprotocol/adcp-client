/**
 * Read structural properties off the canonical format schemas at
 * `schemas/cache/<version>/formats/canonical/<kind>.json`. The
 * projection layer needs `v1_translatable` per canonical to honor the
 * normative rule from `v1-canonical-mapping.json`:
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
  // Track whichever 3.1+ cache the workspace has synced. `latest` is the
  // last-resort candidate because in workspaces pinned to a 3.0.x GA it
  // points at a cache that lacks canonical-format schemas — the loader
  // would silently return `true` for every v1_translatable check and miss
  // the 4 inherently-v2 canonicals.
  const versionsToTry = ['3.1.0-beta.2', '3.1.0-beta.1', '3.1.0-beta.0', 'latest'];
  const candidates = versionsToTry.map(v => path.join(__dirname, '..', '..', '..', '..', 'schemas', 'cache', v));
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `No 3.1+ schema cache found. Run \`npm run sync-schemas\` for a 3.1+ AdCP version. ` +
      `Looked in: ${candidates.join(', ')}.`
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
