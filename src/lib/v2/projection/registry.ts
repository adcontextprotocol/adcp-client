/**
 * Loader + reverse-lookup for the v1↔v2 canonical-format registry
 * (`schemas/cache/<version>/registries/v1-canonical-mapping.json`).
 *
 * The spec authors the registry **forward** — given a v1 named format,
 * find the v2 canonical. v2 → v1 projection needs the inverse direction,
 * which the registry doesn't directly support: there's no guarantee that
 * a given canonical shape has a v1 named-format with that exact
 * narrowing, and most don't.
 *
 * This module implements a best-effort reverse-lookup:
 *
 *   1. For `format_id_glob` registry entries with no `*`, the v1 `id` is
 *      a literal — those are *invertible* (canonical + params → exact id).
 *   2. Globbed entries and `structural` entries are NOT invertible to a
 *      specific v1 id — they describe families of v1 formats, not single
 *      ones. The projection layer treats them as evidence that "some" v1
 *      named format exists for this canonical, but can't pick one without
 *      additional information (e.g. the seller's `v1_format_ref`).
 *
 * Surfaces all three outcomes through the projection's diagnostic
 * channel so adopters see the difference between
 * "no v1 mapping exists" and "ambiguous v1 mapping exists."
 */

import { readFileSync, existsSync } from 'fs';
import path from 'path';
import type { CanonicalFormatKind, V1FormatId } from './types';

interface RegistryEntryV1Pattern {
  format_id_glob?: string;
  structural?: {
    asset_types?: string[];
    vast_versions?: string[];
    daast_versions?: string[];
    dimensions?: { width?: number; height?: number };
  };
}

interface RegistryEntry {
  v1_pattern: RegistryEntryV1Pattern;
  v2: {
    canonical: string;
    parameters?: Record<string, unknown>;
  };
  deprecated?: boolean;
  notes?: string;
}

interface CanonicalMappingRegistry {
  version: string;
  last_updated: string;
  mappings: RegistryEntry[];
}

let cached: CanonicalMappingRegistry | null = null;

/**
 * Load the registry from a known schema-cache version. Defaults to the
 * 3.1.0-beta.0 cache when present; falls back to the latest stable cache
 * directory that ships a registry (`registries/v1-canonical-mapping.json`).
 *
 * Memoized — the registry is small and immutable per version.
 */
export function loadRegistry(cacheRoot?: string): CanonicalMappingRegistry {
  if (cached) return cached;
  const candidates = cacheRoot
    ? [path.join(cacheRoot, 'registries', 'v1-canonical-mapping.json')]
    : [
        path.join(
          __dirname,
          '..',
          '..',
          '..',
          '..',
          'schemas',
          'cache',
          '3.1.0-beta.0',
          'registries',
          'v1-canonical-mapping.json'
        ),
        path.join(
          __dirname,
          '..',
          '..',
          '..',
          '..',
          'schemas',
          'cache',
          'latest',
          'registries',
          'v1-canonical-mapping.json'
        ),
      ];
  for (const file of candidates) {
    if (existsSync(file)) {
      cached = JSON.parse(readFileSync(file, 'utf-8')) as CanonicalMappingRegistry;
      return cached;
    }
  }
  throw new Error(
    `v1-canonical-mapping.json not found. Looked in: ${candidates.join(', ')}. ` +
      `Run \`npm run sync-schemas\` for a 3.1+ AdCP version.`
  );
}

/** Test hook: reset the memoized registry. */
export function _resetRegistryCache(): void {
  cached = null;
}

/**
 * Reverse-lookup outcome. Three buckets the projection algorithm acts on:
 *
 *   - `match`: registry has an invertible entry (literal `format_id_glob`
 *     with no `*`). Synthesize a v1 `format_id` and emit it.
 *   - `ambiguous`: registry has entries for this canonical, but none are
 *     invertible (all globs are wildcarded or structural). Caller knows
 *     "some v1 mapping exists" but can't pick one.
 *   - `none`: registry has no entries for this canonical. No v1 emit
 *     possible without an explicit `v1_format_ref`.
 */
export type ReverseLookupResult =
  | { kind: 'match'; v1: V1FormatId; viaRegistryNote?: string }
  | { kind: 'ambiguous'; matchedEntries: number; hint: string }
  | { kind: 'none' };

/**
 * Attempt to reverse-lookup a v2 declaration against the registry.
 *
 * `canonical` is the format_kind. `params` is the declaration's narrowed
 * parameters — used to disambiguate when the registry's IAB-named entries
 * carry exact dimensions.
 *
 * Returns the highest-confidence match. Picks an invertible entry when
 * dimensions / VAST versions / DAAST versions match exactly; otherwise
 * falls back to `ambiguous` when entries exist but none invert cleanly.
 *
 * Caveat surfaced by this projection in practice (recorded in the
 * findings): the spec's IAB-named globs use slashes (`iab/mrec_300x250`),
 * which the wire-level `format-id.json` pattern (`^[a-zA-Z0-9_-]+$`)
 * rejects. So even when a match exists, the synthesized id is NOT
 * wire-valid until upstream resolves that mismatch
 * (adcontextprotocol/adcp — flagged via the issue we filed earlier).
 * The reverse lookup still produces it because the projection layer's
 * job is to surface what the registry says — and surfacing the
 * inconsistency is more valuable than papering over it.
 */
export function reverseLookup(canonical: CanonicalFormatKind, params: Record<string, unknown>): ReverseLookupResult {
  const registry = loadRegistry();
  const matches = registry.mappings.filter(m => m.v2.canonical === canonical && !m.deprecated);
  if (matches.length === 0) return { kind: 'none' };

  // Invertible: literal format_id_glob with no `*`, and its parameters
  // narrow this declaration's params. For image canonicals the
  // dimensions are the disambiguator — match width/height exactly.
  for (const m of matches) {
    const glob = m.v1_pattern.format_id_glob;
    if (!glob || glob.includes('*')) continue;
    const regParams = (m.v2.parameters ?? {}) as Record<string, unknown>;
    if (!narrowsCompatibly(regParams, params)) continue;
    return {
      kind: 'match',
      v1: synthesizeFormatIdFromGlob(glob, regParams),
      viaRegistryNote: m.notes,
    };
  }

  // No invertible entry — but there ARE entries for this canonical
  // (structural matches or wildcarded globs). Caller surfaces this as
  // ambiguous: a v1 mapping exists in the family but can't be picked
  // mechanically.
  return {
    kind: 'ambiguous',
    matchedEntries: matches.length,
    hint:
      `Registry has ${matches.length} entry/entries matching canonical "${canonical}" but none are ` +
      `invertible (globs are wildcarded or structural). Add v1_format_ref to the declaration to ` +
      `make the projection deterministic.`,
  };
}

/**
 * Synthesize a v1 format_id from a literal glob and the registry's recorded params.
 * Uses the AAO canonical agent_url base form with trailing slash, matching the
 * seller-asserted fixtures in the spec's reference set
 * (`creative.adcontextprotocol.org/`).
 */
function synthesizeFormatIdFromGlob(glob: string, registryParams: Record<string, unknown>): V1FormatId {
  const out: V1FormatId = {
    agent_url: 'https://creative.adcontextprotocol.org/',
    id: glob,
  };
  if (typeof registryParams.width === 'number') out.width = registryParams.width;
  if (typeof registryParams.height === 'number') out.height = registryParams.height;
  if (typeof registryParams.duration_ms === 'number') {
    out.duration_ms = registryParams.duration_ms;
  }
  return out;
}

/**
 * Conservative check: does the v2 declaration's params narrow the registry
 * entry's params? Concretely: every key the registry entry pins must
 * appear in the declaration with an equal value. Extra keys in the
 * declaration are fine (it's narrowing, not equality).
 */
function narrowsCompatibly(registryParams: Record<string, unknown>, declParams: Record<string, unknown>): boolean {
  for (const [k, expected] of Object.entries(registryParams)) {
    const actual = declParams[k];
    if (actual === undefined) return false;
    if (typeof expected !== typeof actual) return false;
    if (expected !== actual) {
      // Loose array compare for vast_versions etc.
      if (Array.isArray(expected) && Array.isArray(actual)) {
        if (expected.length !== actual.length) return false;
        for (let i = 0; i < expected.length; i++) {
          if (expected[i] !== actual[i]) return false;
        }
        continue;
      }
      return false;
    }
  }
  return true;
}
