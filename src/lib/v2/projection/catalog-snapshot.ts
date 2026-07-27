import type { LegacyFormatConverter } from './v1-to-v2';
import type { V1FormatId, V2ProductFormatDeclaration } from './types';
import type { CanonicalFormatLegacyResolutionContext, CanonicalFormatLegacyResolver } from './v2-to-v1';
import { canonicalizeAgentUrl } from '../../discovery/resolve-agent-properties';
import { isCanonicalV1Translatable } from './canonical-properties';

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
  byFormatOptionRef: ReadonlyMap<string, readonly CompiledReverseRoute[]>;
}

interface CompiledReverseRoute {
  declaration: Readonly<V2ProductFormatDeclaration>;
  legacyRefs: readonly V1FormatId[];
}

interface ContextFormatOptionRef {
  format_option_id: string;
  publisher_domain?: string;
  format_kind?: string;
  params?: Readonly<Record<string, unknown>>;
}

const compiledSnapshotCache = new WeakMap<object, readonly CompiledProjectionCatalogSnapshot[]>();

/** Preserve protocol URL identity, including a distinct terminal slash. */
function normalizedAgentUrl(value: string): string {
  return canonicalizeAgentUrl(value) ?? value;
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

function normalizedPublisherDomain(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/\.$/, '');
}

function formatOptionRefKey(formatOptionId: string, publisherDomain?: string): string {
  return JSON.stringify([normalizedPublisherDomain(publisherDomain), formatOptionId]);
}

function formatOptionRefFromValue(value: unknown): { format_option_id: string; publisher_domain?: string } | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.format_option_id !== 'string' || record.format_option_id.length === 0) return undefined;
  if (record.scope === 'publisher' || (record.scope === undefined && typeof record.publisher_domain === 'string')) {
    if (typeof record.publisher_domain !== 'string' || record.publisher_domain.length === 0) return undefined;
    return { format_option_id: record.format_option_id, publisher_domain: record.publisher_domain };
  }
  return { format_option_id: record.format_option_id };
}

function semanticFields(value: Record<string, unknown>): Pick<ContextFormatOptionRef, 'format_kind' | 'params'> {
  return {
    ...(typeof value.format_kind === 'string' ? { format_kind: value.format_kind } : {}),
    ...(value.params !== null && typeof value.params === 'object' && !Array.isArray(value.params)
      ? { params: value.params as Record<string, unknown> }
      : {}),
  };
}

function collectFormatOptionRefs(value: unknown, seen = new WeakSet<object>()): ContextFormatOptionRef[] {
  if (value === null || typeof value !== 'object' || seen.has(value as object)) return [];
  seen.add(value as object);
  const record = value as Record<string, unknown>;
  const refs: ContextFormatOptionRef[] = [];
  const direct = formatOptionRefFromValue(record.format_option_ref);
  if (direct) refs.push({ ...direct, ...semanticFields(record) });
  for (const key of ['format_option_refs', 'format_options'] as const) {
    if (!Array.isArray(record[key])) continue;
    for (const item of record[key]) {
      const ref = formatOptionRefFromValue(item);
      const itemRecord = item !== null && typeof item === 'object' && !Array.isArray(item) ? item : record;
      if (ref) refs.push({ ...ref, ...semanticFields(itemRecord as Record<string, unknown>) });
    }
  }
  if (Array.isArray(record.selector_containers)) {
    for (const container of record.selector_containers) refs.push(...collectFormatOptionRefs(container, seen));
  }
  return refs;
}

function resolutionContextFormatOptionRefs(context: CanonicalFormatLegacyResolutionContext): ContextFormatOptionRef[] {
  if (context.source === 'product') {
    const declaration = context.declaration;
    if (typeof declaration.format_option_id !== 'string' || declaration.format_option_id.length === 0) return [];
    return [
      {
        format_option_id: declaration.format_option_id,
        ...(typeof declaration.publisher_domain === 'string' ? { publisher_domain: declaration.publisher_domain } : {}),
        format_kind: declaration.format_kind,
        params: declaration.params,
      },
    ];
  }
  if (context.source === 'creative') {
    const creativeRefs = collectFormatOptionRefs(context.creative);
    return creativeRefs.length > 0 ? creativeRefs : collectFormatOptionRefs(context.selector);
  }
  return collectFormatOptionRefs(context.selector);
}

function dataValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => dataValuesEqual(item, right[index]))
    );
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && dataValuesEqual(leftRecord[key], rightRecord[key]))
  );
}

function sharedParamsAgree(
  declarationParams: Readonly<Record<string, unknown>>,
  contextParams: Readonly<Record<string, unknown>> | undefined
): boolean {
  if (!contextParams) return true;
  return Object.keys(contextParams).every(
    key => !(key in declarationParams) || dataValuesEqual(declarationParams[key], contextParams[key])
  );
}

function routeMatchesContext(
  route: CompiledReverseRoute,
  ref: ContextFormatOptionRef,
  context: CanonicalFormatLegacyResolutionContext
): boolean {
  if (ref.format_kind !== undefined && ref.format_kind !== route.declaration.format_kind) return false;
  if (!sharedParamsAgree(route.declaration.params, ref.params)) return false;

  const records =
    context.source === 'creative'
      ? [context.creative, context.selector]
      : context.source === 'selector'
        ? [context.selector]
        : [];
  return records.every(record => {
    const fields = semanticFields(record as Record<string, unknown>);
    return (
      (fields.format_kind === undefined || fields.format_kind === route.declaration.format_kind) &&
      sharedParamsAgree(route.declaration.params, fields.params)
    );
  });
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
    const byFormatOptionRef = new Map<string, CompiledReverseRoute[]>();
    for (const sourceDeclaration of snapshot.formats) {
      const declaration = immutableClone(sourceDeclaration);
      if (
        declaration.canonical_formats_only === true ||
        !isCanonicalV1Translatable(declaration.format_kind) ||
        !Array.isArray(declaration.v1_format_ref) ||
        declaration.v1_format_ref.length === 0
      ) {
        continue;
      }

      const canonical = immutableClone(declarationWithoutLegacyIdentity(declaration, snapshot.publisher_domain));
      const legacyRefs = immutableClone([
        ...new Map(declaration.v1_format_ref.map(ref => [legacyRefKey(ref), { ...ref }])).values(),
      ]);
      // Repeating one alias on a declaration does not make it ambiguous. Two
      // distinct declarations at the same precedence tier still do.
      const declarationKeys = new Set(declaration.v1_format_ref.map(legacyRefKey));
      for (const key of declarationKeys) {
        const matches = byLegacyRef.get(key) ?? [];
        matches.push(canonical);
        byLegacyRef.set(key, matches);
      }
      if (
        typeof canonical.format_option_id === 'string' &&
        canonical.format_option_id.length > 0 &&
        typeof canonical.publisher_domain === 'string' &&
        canonical.publisher_domain.length > 0
      ) {
        const key = formatOptionRefKey(canonical.format_option_id, canonical.publisher_domain);
        const matches = byFormatOptionRef.get(key) ?? [];
        matches.push(Object.freeze({ declaration: canonical, legacyRefs }));
        byFormatOptionRef.set(key, matches);
      }
    }
    for (const matches of byLegacyRef.values()) Object.freeze(matches);
    for (const matches of byFormatOptionRef.values()) Object.freeze(matches);
    return Object.freeze({ byLegacyRef, byFormatOptionRef });
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

/**
 * Build the canonical → legacy half of an exact catalog-authored adapter.
 *
 * Only stable `format_option_id` references participate. Snapshot precedence
 * mirrors the forward projector, duplicate declarations at one tier fail
 * closed, and a multi-option selector is returned only when every option has
 * an exact mapping. This makes the resolver safe to use after canonical
 * objects have crossed a process or persistence boundary and lost the SDK's
 * private in-memory route metadata.
 */
export function canonicalFormatLegacyResolverFromCatalogSnapshots(
  snapshots: readonly ProjectionCatalogSnapshot[] | undefined,
  fallback?: CanonicalFormatLegacyResolver
): CanonicalFormatLegacyResolver | undefined {
  if (!snapshots || snapshots.length === 0) return fallback;
  const compiled = compileProjectionCatalogSnapshots(snapshots);
  return context => {
    const refs = resolutionContextFormatOptionRefs(context);
    if (refs.length === 0) return fallback?.(context);

    const resolved: V1FormatId[] = [];
    for (const ref of refs) {
      const key = formatOptionRefKey(ref.format_option_id, ref.publisher_domain);
      let matched: CompiledReverseRoute | undefined;
      for (const snapshot of compiled) {
        const matches = snapshot.byFormatOptionRef.get(key) ?? [];
        if (matches.length > 1) {
          throw new Error('projection catalog contains ambiguous canonical format option aliases');
        }
        if (matches.length === 1) {
          matched = matches[0];
          break;
        }
      }
      if (!matched) return fallback?.(context);
      if (!routeMatchesContext(matched, ref, context)) return fallback?.(context);
      resolved.push(...matched.legacyRefs.map(item => ({ ...item })));
    }

    return [...new Map(resolved.map(ref => [legacyRefKey(ref), ref])).values()];
  };
}

/** Client configuration generated from one bidirectional, owner-scoped catalog. */
export interface ProjectionCatalogAdapters {
  projectionCatalogs: readonly ProjectionCatalogSnapshot[];
  canonicalFormatLegacyResolver: CanonicalFormatLegacyResolver;
}

function assertBidirectionalProjectionCatalogs(snapshots: readonly ProjectionCatalogSnapshot[]): void {
  const routeByCanonicalOption = new Map<string, string>();
  const canonicalOptionByLegacyRoute = new Map<string, string>();
  for (const snapshot of snapshots) {
    const declarationsAtThisTier = new Set<string>();
    for (const declaration of snapshot.formats) {
      if (
        declaration.canonical_formats_only === true ||
        !Array.isArray(declaration.v1_format_ref) ||
        declaration.v1_format_ref.length === 0
      ) {
        continue;
      }
      if (!isCanonicalV1Translatable(declaration.format_kind)) {
        throw new Error('bidirectional projection adapters cannot downgrade a canonical-only format kind');
      }
      const canonical = declarationWithoutLegacyIdentity(declaration, snapshot.publisher_domain);
      if (typeof canonical.format_option_id !== 'string' || canonical.format_option_id.length === 0) {
        throw new Error('bidirectional projection adapters require a stable format_option_id');
      }
      if (typeof canonical.publisher_domain !== 'string' || canonical.publisher_domain.length === 0) {
        throw new Error('bidirectional projection adapters require publisher-scoped format options');
      }
      const uniqueLegacyKeys = new Set(declaration.v1_format_ref.map(legacyRefKey));
      if (uniqueLegacyKeys.size !== 1) {
        throw new Error(
          'bidirectional projection adapters require exactly one legacy route per canonical format option'
        );
      }
      const canonicalKey = formatOptionRefKey(canonical.format_option_id, canonical.publisher_domain);
      const legacyKey = [...uniqueLegacyKeys][0]!;
      const declarationKey = JSON.stringify([canonicalKey, legacyKey]);
      if (declarationsAtThisTier.has(declarationKey)) {
        throw new Error('bidirectional projection adapters contain duplicate declarations at one precedence tier');
      }
      declarationsAtThisTier.add(declarationKey);
      const existing = routeByCanonicalOption.get(canonicalKey);
      if (existing !== undefined && existing !== legacyKey) {
        throw new Error('bidirectional projection adapters contain conflicting reverse routes');
      }
      const existingCanonical = canonicalOptionByLegacyRoute.get(legacyKey);
      if (existingCanonical !== undefined && existingCanonical !== canonicalKey) {
        throw new Error('bidirectional projection adapters contain conflicting forward routes');
      }
      routeByCanonicalOption.set(canonicalKey, legacyKey);
      canonicalOptionByLegacyRoute.set(legacyKey, canonicalKey);
    }
  }
}

/**
 * Configure both discovery upgrade and legacy delivery downgrade from one
 * immutable catalog. Spread the result into `AgentClient` configuration.
 */
export function projectionAdaptersFromCatalogSnapshots(
  snapshots: readonly ProjectionCatalogSnapshot[],
  fallbackCanonicalResolver?: CanonicalFormatLegacyResolver
): ProjectionCatalogAdapters {
  assertBidirectionalProjectionCatalogs(snapshots);
  const canonicalFormatLegacyResolver = canonicalFormatLegacyResolverFromCatalogSnapshots(
    snapshots,
    fallbackCanonicalResolver
  );
  if (!canonicalFormatLegacyResolver) {
    throw new Error('projection adapters require at least one catalog snapshot or a fallback resolver');
  }
  return { projectionCatalogs: snapshots, canonicalFormatLegacyResolver };
}
