import type { CreativeAsset, PackageRequest } from '../types/tools.generated';
import {
  projectCreativeForDelivery,
  type CanonicalCreativeAsset,
  type CreativeFormatWireMode,
  type LegacyCreativeAsset,
} from '../v2/projection/creative-delivery';
import type { LegacyFormatConverter } from '../v2/projection/v1-to-v2';
import type { CanonicalFormatLegacyResolver } from '../v2/projection/v2-to-v1';
import { resolveCanonicalFormatKind } from '../v2/projection/v1-to-v2';

/**
 * Package-like input accepted by `inlineCreativesForPackages`.
 *
 * `PackageRequest` is the create-media-buy shape. Update-media-buy package
 * patches are narrower but carry the same `package_id` + `creatives` fields,
 * so the helper accepts both without depending on AgentClient.
 */
export type InlineCreativePackage = {
  package_id?: string;
  buyer_ref?: string;
  context?: NonNullable<PackageRequest['context']> & { buyer_ref?: string };
  creatives?: CanonicalCreativeAsset[];
  format_ids?: never;
  format_option_refs?: PackageRequest['format_option_refs'];
  format_kind?: PackageRequest['format_kind'];
  params?: PackageRequest['params'];
};

/**
 * Compatibility-only package shape accepted by
 * `inlineCreativesForPackagesLegacy`.
 *
 * @deprecated Legacy `format_ids` belong at an explicit compatibility
 * boundary. Prefer `InlineCreativePackage` and canonical format selectors.
 */
export type LegacyInlineCreativePackage = Omit<InlineCreativePackage, 'creatives' | 'format_ids'> & {
  creatives?: CreativeAsset[];
  format_ids?: PackageRequest['format_ids'];
};

/**
 * Assignment shape shared with `sync_creatives.assignments[]`, plus
 * `placement_refs` for callers already authoring the structured placement
 * form accepted by inline `CreativeAsset`.
 */
export interface InlineCreativeAssignment {
  creative_id: string;
  package_id: string;
  weight?: number;
  placement_ids?: string[];
  placement_refs?: unknown[];
}

interface InlineCreativesForPackagesBaseOptions<TPackage> {
  /**
   * Package-scoped assignment instructions. When supplied, only creatives
   * assigned to each package are inlined unless `includeUnassignedCreatives`
   * is true.
   */
  assignments?: ReadonlyArray<InlineCreativeAssignment>;

  /**
   * Include compatible creatives that have no assignment entry. Defaults to
   * false when assignments are supplied and true when no assignments exist.
   */
  includeUnassignedCreatives?: boolean;

  /**
   * Filter creatives by package format selectors (`format_option_refs` or
   * `format_kind`). The legacy helper also recognizes `format_ids`. Defaults
   * to true.
   */
  filterByFormat?: boolean;

  /**
   * Resolve the package identifier used to match assignment.package_id.
   * Defaults to `package_id`, then `context.buyer_ref`, then `buyer_ref`.
   */
  packageId?: (pkg: TPackage, index: number) => string | undefined;

  /**
   * Behavior when an assignment names a package not present in the package
   * list. Defaults to throw so package scoping mistakes do not broaden
   * delivery silently.
   */
  onUnmatchedAssignment?: 'throw' | 'ignore';

  /**
   * Behavior when an assignment names a creative not present in `creatives`.
   * Defaults to throw because inline payloads cannot reference library-only
   * creatives.
   */
  onMissingCreative?: 'throw' | 'ignore';

  /**
   * Behavior when an explicit assignment names a creative whose format cannot
   * satisfy the target package selectors. Defaults to throw so authoring
   * mistakes do not silently remove assigned delivery.
   */
  onIncompatibleAssignment?: 'throw' | 'ignore';
}

export interface InlineCreativesForPackagesOptions<
  TPackage extends InlineCreativePackage = InlineCreativePackage,
> extends InlineCreativesForPackagesBaseOptions<TPackage> {}

/**
 * Options for the explicit legacy inline-creative compatibility helper.
 *
 * @deprecated Prefer canonical selectors and `inlineCreativesForPackages`.
 */
export interface InlineCreativesForPackagesLegacyOptions<
  TPackage extends LegacyInlineCreativePackage = LegacyInlineCreativePackage,
> extends InlineCreativesForPackagesBaseOptions<TPackage> {
  /** Fail closed when the seller's legacy wire shape is not known. */
  creativeFormatWireMode?: 'legacy' | 'unknown';

  /** Convert custom legacy creative refs before matching/projecting. */
  legacyFormatConverter?: LegacyFormatConverter;

  /** Resolve canonical custom formats when no built-in or private legacy mapping exists. */
  canonicalFormatLegacyResolver?: CanonicalFormatLegacyResolver;
}

export type InlineCreativePackagePatch<
  TPackage extends InlineCreativePackage | LegacyInlineCreativePackage = InlineCreativePackage,
  TCreative = CanonicalCreativeAsset,
> = Omit<TPackage, 'creatives'> & {
  creatives?: TCreative[];
};

/**
 * Project library-scoped creative assets into package-scoped inline creative
 * payloads for `create_media_buy` or `update_media_buy`.
 *
 * The helper is pure: it performs no network calls, does not call
 * `sync_creatives`, and does not generate idempotency keys. Use
 * `supportsSyncCreatives(caps)` to decide whether the seller has a creative
 * library. When it does not, spread this helper's result into
 * `packages[].creatives` and use a fresh idempotency key for the enclosing
 * create/update media-buy call.
 *
 * @example
 * ```ts
 * const caps = await agent.getCapabilities();
 * if (supportsSyncCreatives(caps)) {
 *   await agent.syncCreatives({ account, creatives, assignments });
 * } else if (caps.features.inlineCreativeManagement) {
 *   await agent.createMediaBuy({
 *     account,
 *     idempotency_key: crypto.randomUUID(),
 *     packages: inlineCreativesForPackages(packages, creatives, { assignments }),
 *   });
 * } else {
 *   throw new Error('Seller supports neither creative library sync nor inline creative uploads.');
 * }
 * ```
 */
export function inlineCreativesForPackages<TPackage extends InlineCreativePackage>(
  packages: ReadonlyArray<TPackage>,
  creatives: ReadonlyArray<CanonicalCreativeAsset>,
  options: InlineCreativesForPackagesOptions<TPackage> = {}
): InlineCreativePackagePatch<TPackage, CanonicalCreativeAsset>[] {
  assertCanonicalInlineInputs(packages, creatives, options);
  return inlineCreativesForPackagesInternal(packages, creatives, options, 'canonical') as InlineCreativePackagePatch<
    TPackage,
    CanonicalCreativeAsset
  >[];
}

/**
 * Project creatives into the legacy inline package wire shape.
 *
 * @deprecated This is an explicit compatibility escape hatch for legacy
 * sellers. New integrations should use canonical package selectors with
 * `inlineCreativesForPackages`; the SDK client performs negotiated wire
 * projection at the transport boundary.
 */
export function inlineCreativesForPackagesLegacy<TPackage extends LegacyInlineCreativePackage>(
  packages: ReadonlyArray<TPackage>,
  creatives: ReadonlyArray<CreativeAsset>,
  options: InlineCreativesForPackagesLegacyOptions<TPackage> = {}
): InlineCreativePackagePatch<TPackage, LegacyCreativeAsset>[] {
  const { creativeFormatWireMode = 'legacy', ...sharedOptions } = options;
  return inlineCreativesForPackagesInternal(
    packages,
    creatives,
    {
      ...sharedOptions,
      legacyFormatConverter: options.legacyFormatConverter,
      canonicalFormatLegacyResolver: options.canonicalFormatLegacyResolver,
    },
    creativeFormatWireMode
  ) as InlineCreativePackagePatch<TPackage, LegacyCreativeAsset>[];
}

type InternalInlineCreativesOptions<TPackage extends LegacyInlineCreativePackage> =
  InlineCreativesForPackagesBaseOptions<TPackage> & {
    legacyFormatConverter?: LegacyFormatConverter;
    canonicalFormatLegacyResolver?: CanonicalFormatLegacyResolver;
  };

function inlineCreativesForPackagesInternal<TPackage extends LegacyInlineCreativePackage>(
  packages: ReadonlyArray<TPackage>,
  creatives: ReadonlyArray<CreativeAsset>,
  options: InternalInlineCreativesOptions<TPackage>,
  creativeFormatWireMode: CreativeFormatWireMode
): InlineCreativePackagePatch<TPackage, CreativeAsset>[] {
  const {
    assignments,
    includeUnassignedCreatives = assignments == null || assignments.length === 0,
    filterByFormat = true,
    packageId = defaultPackageId,
    onUnmatchedAssignment = 'throw',
    onMissingCreative = 'throw',
    onIncompatibleAssignment = 'throw',
    legacyFormatConverter,
    canonicalFormatLegacyResolver,
  } = options;

  const creativesById = new Map<string, CreativeAsset>();
  for (const creative of creatives) {
    if (typeof creative.creative_id === 'string') {
      creativesById.set(creative.creative_id, creative);
    }
  }

  const assignmentsByPackage = new Map<string, InlineCreativeAssignment[]>();
  const matchedPackageIds = new Set<string>();
  for (const assignment of assignments ?? []) {
    const creative = creativesById.get(assignment.creative_id);
    if (!creative) {
      if (onMissingCreative === 'throw') {
        throw new Error(
          `inlineCreativesForPackages assignment references unknown creative_id "${assignment.creative_id}"`
        );
      }
      continue;
    }
    const existing = assignmentsByPackage.get(assignment.package_id);
    if (existing) {
      existing.push(assignment);
    } else {
      assignmentsByPackage.set(assignment.package_id, [assignment]);
    }
  }

  const result = packages.map((pkg, index) => {
    const id = packageId(pkg, index);
    if (id) matchedPackageIds.add(id);
    const assigned = id ? (assignmentsByPackage.get(id) ?? []) : [];
    const assignedCreativeIds = new Set(assigned.map(a => a.creative_id));
    const inlined: CreativeAsset[] = [];

    for (const assignment of assigned) {
      const creative = creativesById.get(assignment.creative_id);
      if (!creative) continue;
      const sourceCompatible = !filterByFormat || creativeMatchesPackage(pkg, creative);
      if (!sourceCompatible) {
        if (onIncompatibleAssignment === 'throw') {
          throw new Error(
            `inlineCreativesForPackages assignment creative_id "${assignment.creative_id}" ` +
              `does not match package_id "${assignment.package_id}" format selectors`
          );
        }
        continue;
      }
      const projected = projectCreativeForDelivery(
        creative,
        pkg,
        creativeFormatWireMode,
        'inline_creatives',
        legacyFormatConverter,
        canonicalFormatLegacyResolver
      );
      const compatible = !filterByFormat || creativeMatchesPackage(pkg, projected);
      if (compatible) {
        inlined.push(applyAssignmentToCreative(projected, assignment));
      } else if (onIncompatibleAssignment === 'throw') {
        throw new Error(
          `inlineCreativesForPackages assignment creative_id "${assignment.creative_id}" ` +
            `does not match package_id "${assignment.package_id}" format selectors`
        );
      }
    }

    if (includeUnassignedCreatives) {
      for (const creative of creatives) {
        if (typeof creative.creative_id === 'string' && assignedCreativeIds.has(creative.creative_id)) continue;
        if (filterByFormat && !creativeMatchesPackage(pkg, creative)) continue;
        const projected = projectCreativeForDelivery(
          creative,
          pkg,
          creativeFormatWireMode,
          'inline_creatives',
          legacyFormatConverter,
          canonicalFormatLegacyResolver
        );
        if (!filterByFormat || creativeMatchesPackage(pkg, projected)) {
          inlined.push({ ...projected });
        }
      }
    }

    const next: Record<string, unknown> = { ...(pkg as Record<string, unknown>) };
    delete next.creatives;
    if (inlined.length > 0) {
      next.creatives = inlined;
    }
    return next as InlineCreativePackagePatch<TPackage, CreativeAsset>;
  });

  if (onUnmatchedAssignment === 'throw') {
    const unmatched = [...assignmentsByPackage.keys()].filter(package_id => !matchedPackageIds.has(package_id));
    if (unmatched.length > 0) {
      throw new Error(`inlineCreativesForPackages assignment references unknown package_id "${unmatched[0]}"`);
    }
  }

  return result;
}

function assertCanonicalInlineInputs(
  packages: ReadonlyArray<InlineCreativePackage>,
  creatives: ReadonlyArray<CanonicalCreativeAsset>,
  options: object
): void {
  const unsafeOptions = options as Record<string, unknown>;
  if (
    'creativeFormatWireMode' in unsafeOptions ||
    'legacyFormatConverter' in unsafeOptions ||
    'canonicalFormatLegacyResolver' in unsafeOptions
  ) {
    throw new Error(
      'inlineCreativesForPackages is canonical-only; use inlineCreativesForPackagesLegacy for legacy wire projection'
    );
  }

  for (const pkg of packages) {
    if ('format_ids' in (pkg as object)) {
      throw new Error(
        'inlineCreativesForPackages does not accept legacy package format_ids; use canonical format selectors or inlineCreativesForPackagesLegacy'
      );
    }
  }

  for (const creative of creatives) {
    if ('format_id' in (creative as object)) {
      throw new Error(
        'inlineCreativesForPackages does not accept legacy creative format_id; use canonical format_kind or inlineCreativesForPackagesLegacy'
      );
    }
  }
}

function defaultPackageId(pkg: LegacyInlineCreativePackage): string | undefined {
  if (typeof pkg.package_id === 'string') return pkg.package_id;
  if (typeof pkg.context?.buyer_ref === 'string') return pkg.context.buyer_ref;
  if (typeof pkg.buyer_ref === 'string') return pkg.buyer_ref;
  return undefined;
}

function applyAssignmentToCreative(creative: CreativeAsset, assignment: InlineCreativeAssignment): CreativeAsset {
  const next: Record<string, unknown> = { ...(creative as unknown as Record<string, unknown>) };
  delete next.weight;
  delete next.placement_ids;
  delete next.placement_refs;

  if (assignment.weight !== undefined) next.weight = assignment.weight;
  if (assignment.placement_refs !== undefined) {
    next.placement_refs = [...assignment.placement_refs];
  } else if (assignment.placement_ids !== undefined) {
    next.placement_ids = [...assignment.placement_ids];
  }
  return next as unknown as CreativeAsset;
}

function creativeMatchesPackage(pkg: LegacyInlineCreativePackage, creative: CreativeAsset): boolean {
  const packageFormatIds = arrayOfObjects(pkg.format_ids);
  const packageFormatOptionRefs = arrayOfObjects(pkg.format_option_refs);
  const packageFormatKind = typeof pkg.format_kind === 'string' ? pkg.format_kind : undefined;
  const packageParams = plainObject(pkg.params);

  const creativeRecord = creative as unknown as Record<string, unknown>;
  const creativeFormatId = plainObject(creativeRecord.format_id);
  const creativeFormatOptionRef = plainObject(creativeRecord.format_option_ref);

  if (packageFormatOptionRefs.length > 0) {
    if (creativeFormatOptionRef) {
      return packageFormatOptionRefs.some(formatOptionRef => deepEqual(formatOptionRef, creativeFormatOptionRef));
    }
    if (packageFormatIds.length === 0 && packageFormatKind === undefined) return false;
  }

  if (packageFormatKind !== undefined) {
    return (
      creativeRecord.format_kind === packageFormatKind &&
      paramsMatchCreative(packageParams, creativeFormatId ?? creativeParamsFromAssets(creativeRecord.assets))
    );
  }

  if (packageFormatIds.length > 0) {
    if (creativeFormatId !== undefined) {
      return packageFormatIds.some(formatId => formatIdMatches(formatId, creativeFormatId));
    }
    return packageFormatIds.some(
      formatId =>
        typeof formatId.id === 'string' &&
        resolveCanonicalFormatKind(formatId.id, {
          agentUrl: typeof formatId.agent_url === 'string' ? formatId.agent_url : undefined,
        }) === creativeRecord.format_kind
    );
  }

  return true;
}

function creativeParamsFromAssets(value: unknown): Record<string, unknown> | undefined {
  const assets = plainObject(value);
  if (!assets) return undefined;
  for (const assetValue of Object.values(assets)) {
    const candidates = Array.isArray(assetValue) ? assetValue : [assetValue];
    for (const candidate of candidates) {
      const asset = plainObject(candidate);
      if (!asset) continue;
      const params: Record<string, unknown> = {};
      if (typeof asset.width === 'number') params.width = asset.width;
      if (typeof asset.height === 'number') params.height = asset.height;
      if (typeof asset.duration_ms === 'number') params.duration_ms = asset.duration_ms;
      if (Object.keys(params).length > 0) return params;
    }
  }
  return undefined;
}

function arrayOfObjects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.flatMap(item => (plainObject(item) ? [item] : [])) : [];
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function formatIdMatches(expected: Record<string, unknown>, actual: Record<string, unknown>): boolean {
  const expectedId = expected.id;
  const actualId = actual.id;
  if (expectedId !== actualId) return false;

  const expectedAgentUrl = normalizeAgentUrl(expected.agent_url);
  const actualAgentUrl = normalizeAgentUrl(actual.agent_url);
  if (expectedAgentUrl !== undefined && actualAgentUrl !== undefined && expectedAgentUrl !== actualAgentUrl) {
    return false;
  }

  for (const key of ['width', 'height', 'duration_ms']) {
    if (expected[key] !== undefined && actual[key] !== undefined && expected[key] !== actual[key]) {
      return false;
    }
  }

  return true;
}

function paramsMatchCreative(
  packageParams: Record<string, unknown> | undefined,
  creativeFormatId: Record<string, unknown> | undefined
): boolean {
  if (!packageParams) return true;

  let constrained = false;
  const actualWidth = numberValue(creativeFormatId, 'width');
  const actualHeight = numberValue(creativeFormatId, 'height');
  const actualDuration =
    numberValue(creativeFormatId, 'duration_ms') ?? numberValue(creativeFormatId, 'duration_ms_exact');

  const sizes = Array.isArray(packageParams.sizes)
    ? packageParams.sizes.flatMap(size => (plainObject(size) ? [size] : []))
    : [];
  if (sizes.length > 0) {
    constrained = true;
    if (
      actualWidth === undefined ||
      actualHeight === undefined ||
      !sizes.some(size => numberValue(size, 'width') === actualWidth && numberValue(size, 'height') === actualHeight)
    ) {
      return false;
    }
  }

  const expectedWidth = numberValue(packageParams, 'width');
  if (expectedWidth !== undefined) {
    constrained = true;
    if (actualWidth !== expectedWidth) return false;
  }

  const expectedHeight = numberValue(packageParams, 'height');
  if (expectedHeight !== undefined) {
    constrained = true;
    if (actualHeight !== expectedHeight) return false;
  }

  const minWidth = numberValue(packageParams, 'min_width');
  if (minWidth !== undefined) {
    constrained = true;
    if (actualWidth === undefined || actualWidth < minWidth) return false;
  }

  const maxWidth = numberValue(packageParams, 'max_width');
  if (maxWidth !== undefined) {
    constrained = true;
    if (actualWidth === undefined || actualWidth > maxWidth) return false;
  }

  const minHeight = numberValue(packageParams, 'min_height');
  if (minHeight !== undefined) {
    constrained = true;
    if (actualHeight === undefined || actualHeight < minHeight) return false;
  }

  const maxHeight = numberValue(packageParams, 'max_height');
  if (maxHeight !== undefined) {
    constrained = true;
    if (actualHeight === undefined || actualHeight > maxHeight) return false;
  }

  const exactDuration = numberValue(packageParams, 'duration_ms_exact') ?? numberValue(packageParams, 'duration_ms');
  if (exactDuration !== undefined) {
    constrained = true;
    if (actualDuration !== exactDuration) return false;
  }

  const durationRange = numberRange(packageParams.duration_ms_range);
  if (durationRange) {
    constrained = true;
    const [minDuration, maxDuration] = durationRange;
    if (actualDuration === undefined) return false;
    if (minDuration !== undefined && actualDuration < minDuration) return false;
    if (maxDuration !== undefined && actualDuration > maxDuration) return false;
  }

  return constrained ? creativeFormatId !== undefined : true;
}

function numberValue(object: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = object?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function numberRange(value: unknown): [number | undefined, number | undefined] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [min, max] = value;
  const minValue = min === null ? undefined : typeof min === 'number' && Number.isFinite(min) ? min : undefined;
  const maxValue = max === null ? undefined : typeof max === 'number' && Number.isFinite(max) ? max : undefined;
  return minValue === undefined && maxValue === undefined ? undefined : [minValue, maxValue];
}

function normalizeAgentUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  const object = plainObject(value);
  if (!object) return value;
  return Object.fromEntries(
    Object.entries(object)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, sortKeys(v)])
  );
}
