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
import { BETA_VERSIONS_TO_TRY } from './cache-versions';

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
 * Load the registry from a known schema-cache version. Tries `3.1.0-beta.2`
 * first (current beta), then `3.1.0-beta.1`, then `3.1.0-beta.0`, then the
 * `latest` symlink — whichever ships `registries/v1-canonical-mapping.json`
 * is the source of truth. The pin floats deliberately so the registry tracks
 * whichever 3.1+ cache the workspace has synced.
 *
 * Memoized — the registry is small and immutable per version.
 */
export function loadRegistry(cacheRoot?: string): CanonicalMappingRegistry {
  if (cached) return cached;
  const candidates = cacheRoot
    ? [path.join(cacheRoot, 'registries', 'v1-canonical-mapping.json')]
    : BETA_VERSIONS_TO_TRY.map(v =>
        path.join(__dirname, '..', '..', '..', '..', 'schemas', 'cache', v, 'registries', 'v1-canonical-mapping.json')
      );
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
 * Forward registry lookup (v1 → v2). Given a v1 `format_id.id`, find
 * the registry entry whose `format_id_glob` matches and return the
 * canonical + parameters. Used by `projectV1ProductToV2` resolution
 * step 2.
 *
 * Glob `*` matches any non-`/` segment (the same minimal-glob shape
 * the v2→v1 prototype's matcher used). Returns the first matching
 * entry — registry order is authoritative per the spec ("Ordered list
 * of v1 → v2 mappings. SDKs apply mappings in order and use the first
 * match.").
 */
export interface ForwardGlobMatch {
  canonical: CanonicalFormatKind;
  parameters: Record<string, unknown>;
  notes?: string;
}

export function forwardLookupByGlob(formatIdId: string): ForwardGlobMatch | undefined {
  const registry = loadRegistry();
  for (const m of registry.mappings) {
    if (m.deprecated) continue;
    const glob = m.v1_pattern.format_id_glob;
    if (!glob) continue;
    if (globMatches(glob, formatIdId)) {
      return {
        canonical: m.v2.canonical as CanonicalFormatKind,
        parameters: (m.v2.parameters ?? {}) as Record<string, unknown>,
        notes: m.notes,
      };
    }
  }
  return undefined;
}

function globMatches(glob: string, value: string): boolean {
  // Anchor both ends; '*' matches one or more non-`/` chars.
  const re = new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]+') + '$');
  return re.test(value);
}

/**
 * Forward structural lookup (v1 → v2). Given a v1 format definition's
 * declared assets + version constraints, find the first registry
 * entry whose `structural` pattern matches. Used by
 * `projectV1ProductToV2` resolution step 3 — the fallback when no
 * explicit `canonical` annotation and no glob match are available.
 */
export interface ForwardStructuralInput {
  asset_types?: string[];
  vast_versions?: string[];
  daast_versions?: string[];
}

export function forwardLookupByStructural(input: ForwardStructuralInput): ForwardGlobMatch | undefined {
  const registry = loadRegistry();
  for (const m of registry.mappings) {
    if (m.deprecated) continue;
    const struct = m.v1_pattern.structural;
    if (!struct) continue;
    if (struct.asset_types && input.asset_types) {
      const required = new Set(struct.asset_types);
      const have = new Set(input.asset_types);
      let allPresent = true;
      for (const t of required) {
        if (!have.has(t)) {
          allPresent = false;
          break;
        }
      }
      if (!allPresent) continue;
    }
    // Loose-match VAST / DAAST version arrays: any overlap.
    if (struct.vast_versions && input.vast_versions) {
      const overlap = input.vast_versions.some(v => struct.vast_versions!.includes(v));
      if (!overlap) continue;
    }
    if (struct.daast_versions && input.daast_versions) {
      const overlap = input.daast_versions.some(v => struct.daast_versions!.includes(v));
      if (!overlap) continue;
    }
    return {
      canonical: m.v2.canonical as CanonicalFormatKind,
      parameters: (m.v2.parameters ?? {}) as Record<string, unknown>,
      notes: m.notes,
    };
  }
  return undefined;
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
