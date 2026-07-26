import type { LegacyFormatConverter } from './v1-to-v2';
import type { V1FormatId, V2ProductFormatDeclaration } from './types';
import { canonicalizeAgentUrl } from '../../discovery/resolve-agent-properties';

/** Provenance tier for a pre-resolved immutable format catalog snapshot. */
export type ProjectionCatalogSource = 'publisher' | 'aao_mirror' | 'agent_derived' | 'configured';

/**
 * Canonical catalog data resolved outside the pure projector.
 *
 * Network discovery deliberately does not happen inside projection. Callers
 * may resolve publisher/community catalogs asynchronously, then inject the
 * immutable result here for synchronous reads, writes, continuations, and
 * webhook handling. Array order is precedence order (most specific first).
 */
export interface ProjectionCatalogSnapshot {
  source: ProjectionCatalogSource;
  /** Canonical publisher scope applied when declarations omit it. */
  publisher_domain?: string;
  formats: readonly V2ProductFormatDeclaration[];
}

interface CompiledProjectionCatalogSnapshot {
  byLegacyRef: ReadonlyMap<string, readonly V2ProductFormatDeclaration[]>;
}

const compiledSnapshotCache = new WeakMap<object, readonly CompiledProjectionCatalogSnapshot[]>();

/**
 * Canonicalize the URL identity while treating a terminal slash as cosmetic.
 * WHATWG URL parsing normalizes scheme/host case, IDNs, dot segments, and
 * default ports. Path, query, and fragment contents remain case-sensitive.
 */
function normalizedAgentUrl(value: string): string {
  const canonical = canonicalizeAgentUrl(value);
  if (canonical !== null) {
    const url = new URL(canonical);
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    // canonicalizeAgentUrl already strips fragments and decodes percent-
    // encoded unreserved characters; reconstruct without reintroducing either.
    return `${url.protocol}//${url.host}${url.pathname}${url.search}`;
  }
  // Validated protocol values are URIs. Preserve deterministic behavior for
  // callers using the pure helper directly with an invalid fixture.
  return value.endsWith('/') ? value : `${value}/`;
}

function legacyRefKey(ref: V1FormatId): string {
  return JSON.stringify([
    normalizedAgentUrl(ref.agent_url),
    ref.id,
    ref.width ?? null,
    ref.height ?? null,
    ref.duration_ms ?? null,
  ]);
}

function immutableClone<T>(value: T): T {
  const clone = structuredClone(value);
  const freeze = (candidate: unknown, seen = new WeakSet<object>()): void => {
    if (candidate === null || typeof candidate !== 'object' || seen.has(candidate)) return;
    seen.add(candidate);
    for (const child of Object.values(candidate)) freeze(child, seen);
    Object.freeze(candidate);
  };
  freeze(clone);
  return clone;
}

function declarationWithoutLegacyIdentity(
  declaration: V2ProductFormatDeclaration,
  publisherDomain?: string
): V2ProductFormatDeclaration {
  const { v1_format_ref: _dropRefs, canonical_formats_only: _dropCanonicalOnly, ...canonical } = declaration;
  void _dropRefs;
  void _dropCanonicalOnly;
  return {
    ...canonical,
    ...(canonical.publisher_domain === undefined && publisherDomain ? { publisher_domain: publisherDomain } : {}),
  };
}

function compileProjectionCatalogSnapshots(
  snapshots: readonly ProjectionCatalogSnapshot[]
): readonly CompiledProjectionCatalogSnapshot[] {
  const cached = compiledSnapshotCache.get(snapshots);
  if (cached) return cached;

  const compiled = snapshots.map(snapshot => {
    const byLegacyRef = new Map<string, V2ProductFormatDeclaration[]>();
    for (const sourceDeclaration of snapshot.formats) {
      const declaration = immutableClone(sourceDeclaration);
      if (declaration.canonical_formats_only === true || !Array.isArray(declaration.v1_format_ref)) continue;

      const canonical = immutableClone(declarationWithoutLegacyIdentity(declaration, snapshot.publisher_domain));
      // Repeating one alias on a declaration does not make it ambiguous. Two
      // distinct declarations at the same precedence tier still do.
      const declarationKeys = new Set(declaration.v1_format_ref.map(legacyRefKey));
      for (const key of declarationKeys) {
        const matches = byLegacyRef.get(key) ?? [];
        matches.push(canonical);
        byLegacyRef.set(key, matches);
      }
    }
    for (const matches of byLegacyRef.values()) Object.freeze(matches);
    return Object.freeze({ byLegacyRef });
  });

  Object.freeze(compiled);
  compiledSnapshotCache.set(snapshots, compiled);
  return compiled;
}

/**
 * Convert exact, catalog-authored `v1_format_ref` aliases into the existing
 * converter seam. Canonical-only declarations never become legacy aliases,
 * and matching is always owner + id + dimensional discriminators—never ID
 * alone. Duplicate aliases at the same precedence tier fail closed.
 */
export function legacyFormatConverterFromCatalogSnapshots(
  snapshots: readonly ProjectionCatalogSnapshot[] | undefined,
  fallback?: LegacyFormatConverter
): LegacyFormatConverter | undefined {
  if (!snapshots || snapshots.length === 0) return fallback;
  const compiled = compileProjectionCatalogSnapshots(snapshots);
  return context => {
    const key = legacyRefKey(context.formatId);
    for (const snapshot of compiled) {
      const matches = snapshot.byLegacyRef.get(key) ?? [];
      if (matches.length > 1) {
        throw new Error('projection catalog contains ambiguous legacy aliases');
      }
      if (matches.length === 1) {
        return matches[0];
      }
    }
    return fallback?.(context);
  };
}
