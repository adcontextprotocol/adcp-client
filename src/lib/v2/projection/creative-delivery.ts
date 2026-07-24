import type { CreativeAsset } from '../../types/tools.generated';
import { resolveCanonicalFormatKind } from './v1-to-v2';
import type { V1FormatId, V2ProductFormatDeclaration } from './types';

export type CreativeFormatWireMode = 'canonical' | 'legacy' | 'unknown';

export interface CreativeFormatSelectorContainer {
  package_id?: string;
  format_ids?: unknown[];
  formats?: unknown[];
  format_options?: unknown[];
  format_option_refs?: unknown[];
  format_kind?: unknown;
  params?: unknown;
  [key: string]: unknown;
}

export interface SyncCreativeFormatProjection {
  selectorContainers: ReadonlyArray<CreativeFormatSelectorContainer>;
  wireMode?: CreativeFormatWireMode;
}

export class CreativeFormatProjectionError extends Error {
  readonly code = 'ADCP_CREATIVE_FORMAT_PROJECTION_FAILED';

  constructor(
    readonly operation: string,
    readonly creativeId: string,
    reason: string
  ) {
    super(`${operation}: cannot select a valid creative wire shape for ${creativeId}: ${reason}`);
    this.name = 'CreativeFormatProjectionError';
  }
}

type LegacyCandidate = { ref: V1FormatId; formatKind?: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function legacyRef(value: unknown): V1FormatId | undefined {
  const candidate = record(value);
  if (!candidate || typeof candidate.agent_url !== 'string' || typeof candidate.id !== 'string') return undefined;
  if (candidate.agent_url.length === 0 || candidate.id.length === 0) return undefined;
  return {
    agent_url: candidate.agent_url,
    id: candidate.id,
    ...(typeof candidate.width === 'number' ? { width: candidate.width } : {}),
    ...(typeof candidate.height === 'number' ? { height: candidate.height } : {}),
    ...(typeof candidate.duration_ms === 'number' ? { duration_ms: candidate.duration_ms } : {}),
  };
}

function refsFromValue(value: unknown): V1FormatId[] {
  if (Array.isArray(value)) return value.flatMap(item => refsFromValue(item));
  const ref = legacyRef(value);
  return ref ? [ref] : [];
}

function candidatesFromContainer(container: CreativeFormatSelectorContainer): LegacyCandidate[] {
  const candidates: LegacyCandidate[] = [];
  const containerKind = typeof container.format_kind === 'string' ? container.format_kind : undefined;
  for (const key of ['format_ids', 'formats'] as const) {
    for (const ref of refsFromValue(container[key])) {
      candidates.push({ ref, formatKind: resolveCanonicalFormatKind(ref.id) ?? containerKind });
    }
  }
  for (const optionValue of Array.isArray(container.format_options) ? container.format_options : []) {
    const option = record(optionValue);
    if (!option) continue;
    const formatKind = typeof option.format_kind === 'string' ? option.format_kind : undefined;
    for (const ref of refsFromValue(option.v1_format_ref)) candidates.push({ ref, formatKind });
  }
  return uniqueCandidates(candidates);
}

function candidateKey(candidate: LegacyCandidate): string {
  const ref = candidate.ref;
  return [
    ref.agent_url.trim().toLowerCase(),
    ref.id.trim().toLowerCase(),
    ref.width ?? '',
    ref.height ?? '',
    ref.duration_ms ?? '',
  ].join('|');
}

function uniqueCandidates(candidates: LegacyCandidate[]): LegacyCandidate[] {
  return [...new Map(candidates.map(candidate => [candidateKey(candidate), candidate])).values()];
}

function refMatchesParams(ref: V1FormatId, paramsValue: unknown): boolean {
  const params = record(paramsValue);
  if (!params) return true;
  const sizes = Array.isArray(params.sizes) ? params.sizes.flatMap(size => (record(size) ? [record(size)!] : [])) : [];
  if (sizes.length === 1) {
    const size = sizes[0]!;
    if (typeof size.width === 'number' && ref.width !== size.width) return false;
    if (typeof size.height === 'number' && ref.height !== size.height) return false;
  }
  if (typeof params.width === 'number' && ref.width !== params.width) return false;
  if (typeof params.height === 'number' && ref.height !== params.height) return false;
  if (typeof params.duration_ms_exact === 'number' && ref.duration_ms !== params.duration_ms_exact) return false;
  return true;
}

function selectLegacyRef(
  creative: Record<string, unknown>,
  container: CreativeFormatSelectorContainer
): V1FormatId | undefined {
  const candidates = candidatesFromContainer(container);
  const creativeOptionRef = record(creative.format_option_ref);
  const selectedOptionRefs = Array.isArray(container.format_option_refs)
    ? container.format_option_refs.flatMap(value => (record(value) ? [record(value)!] : []))
    : [];
  if (
    creativeOptionRef &&
    selectedOptionRefs.length > 0 &&
    !selectedOptionRefs.some(
      selected =>
        selected.scope === creativeOptionRef.scope &&
        selected.format_option_id === creativeOptionRef.format_option_id &&
        selected.publisher_domain === creativeOptionRef.publisher_domain
    )
  ) {
    return undefined;
  }
  const existing = legacyRef(creative.format_id);
  if (existing) {
    const sameId = candidates.filter(
      candidate => candidate.ref.id.trim().toLowerCase() === existing.id.trim().toLowerCase()
    );
    const exact = sameId.filter(
      candidate =>
        candidate.ref.agent_url.trim().toLowerCase() === existing.agent_url.trim().toLowerCase() &&
        (existing.width === undefined || candidate.ref.width === existing.width) &&
        (existing.height === undefined || candidate.ref.height === existing.height) &&
        (existing.duration_ms === undefined || candidate.ref.duration_ms === existing.duration_ms)
    );
    if (exact.length === 1) return exact[0]!.ref;
    if (sameId.length === 1) return sameId[0]!.ref;
    return candidates.length === 0 ? existing : undefined;
  }

  if (typeof creative.format_kind !== 'string') return undefined;
  let matching = candidates.filter(candidate => candidate.formatKind === creative.format_kind);
  const constrained = matching.filter(candidate => refMatchesParams(candidate.ref, container.params));
  if (constrained.length > 0) matching = constrained;
  return matching.length === 1 ? matching[0]!.ref : undefined;
}

function projectCreative<T extends Record<string, unknown>>(creative: T, formatId: V1FormatId): T {
  const next: Record<string, unknown> = { ...creative };
  delete next.format_kind;
  delete next.format_option_ref;
  next.format_id = { ...formatId };
  return next as T;
}

export function projectCreativeForDelivery<T extends CreativeAsset>(
  creative: T,
  selectorContainer: CreativeFormatSelectorContainer,
  wireMode: CreativeFormatWireMode = 'canonical',
  operation = 'creative_delivery'
): T {
  const creativeRecord = creative as unknown as Record<string, unknown>;
  const formatId = selectLegacyRef(creativeRecord, selectorContainer);
  if (formatId) return projectCreative(creativeRecord, formatId) as unknown as T;

  if (typeof creativeRecord.format_kind === 'string') {
    const creativeId = typeof creativeRecord.creative_id === 'string' ? creativeRecord.creative_id : '(unknown)';
    const allCandidates = candidatesFromContainer(selectorContainer);
    let candidates = allCandidates.filter(candidate => candidate.formatKind === creativeRecord.format_kind);
    const constrained = candidates.filter(candidate => refMatchesParams(candidate.ref, selectorContainer.params));
    if (constrained.length > 0) candidates = constrained;
    if (candidates.length > 1) {
      throw new CreativeFormatProjectionError(
        operation,
        creativeId,
        `the seller advertised ${candidates.length} legacy refs for canonical kind ${creativeRecord.format_kind}`
      );
    }
    if (wireMode === 'canonical') return creative;
    const reason = 'the selected seller product did not provide one unambiguous legacy format reference';
    throw new CreativeFormatProjectionError(operation, creativeId, reason);
  }
  return creative;
}

export function projectMediaBuyCreativesForDelivery<T>(
  request: T,
  wireMode: CreativeFormatWireMode = 'canonical',
  operation: 'create_media_buy' | 'update_media_buy' = 'create_media_buy'
): T {
  const requestRecord = record(request);
  if (!requestRecord) return request;
  let changed = false;
  const next = { ...requestRecord };
  for (const key of ['packages', 'new_packages'] as const) {
    const packages = requestRecord[key];
    if (!Array.isArray(packages)) continue;
    next[key] = packages.map(packageValue => {
      const pkg = record(packageValue);
      if (!pkg || !Array.isArray(pkg.creatives)) return packageValue;
      const creatives = pkg.creatives.map(creativeValue => {
        const creative = record(creativeValue);
        if (!creative) return creativeValue;
        const projected = projectCreativeForDelivery(
          creative as unknown as CreativeAsset,
          pkg as CreativeFormatSelectorContainer,
          wireMode,
          operation
        );
        if (projected !== creativeValue) changed = true;
        return projected;
      });
      return { ...pkg, creatives };
    });
  }
  return (changed ? next : request) as T;
}

export function projectSyncCreativesForDelivery<T>(
  request: T,
  selectorContainers: ReadonlyArray<CreativeFormatSelectorContainer>,
  wireMode: CreativeFormatWireMode = 'canonical'
): T {
  const requestRecord = record(request);
  if (!requestRecord || !Array.isArray(requestRecord.creatives)) return request;
  const assignments = Array.isArray(requestRecord.assignments) ? requestRecord.assignments : [];
  let changed = false;
  const creatives = requestRecord.creatives.map(creativeValue => {
    const creative = record(creativeValue);
    if (!creative) return creativeValue;
    const assignedPackageIds = new Set(
      assignments.flatMap(assignmentValue => {
        const assignment = record(assignmentValue);
        if (!assignment || assignment.creative_id !== creative.creative_id) return [];
        return typeof assignment.package_id === 'string' ? [assignment.package_id] : [];
      })
    );
    const relevant =
      assignedPackageIds.size === 0
        ? selectorContainers
        : selectorContainers.filter(
            container => typeof container.package_id === 'string' && assignedPackageIds.has(container.package_id)
          );
    const combined: CreativeFormatSelectorContainer = {
      format_ids: relevant.flatMap(container => candidatesFromContainer(container).map(candidate => candidate.ref)),
      format_options: relevant.flatMap(
        container =>
          (Array.isArray(container.format_options) ? container.format_options : []) as V2ProductFormatDeclaration[]
      ),
    };
    const projected = projectCreativeForDelivery(
      creative as unknown as CreativeAsset,
      combined,
      wireMode,
      'sync_creatives'
    );
    if (projected !== creativeValue) changed = true;
    return projected;
  });
  return (changed ? { ...requestRecord, creatives } : request) as T;
}

function release(value: unknown): { major: number; minor: number } | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^v?(\d+)\.(\d+)(?:\.|-|$)/.exec(value.trim());
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : undefined;
}

export function resolveCreativeFormatWireMode(capabilities: unknown): CreativeFormatWireMode {
  const caps = record(capabilities);
  if (!caps) return 'unknown';
  const raw = record(caps._raw);
  const adcp = record(caps.adcp);
  const rawAdcp = record(raw?.adcp);
  const supported = [
    caps.supported_versions,
    caps.supportedVersions,
    adcp?.supported_versions,
    adcp?.supportedVersions,
    raw?.supported_versions,
    raw?.supportedVersions,
    rawAdcp?.supported_versions,
    rawAdcp?.supportedVersions,
  ]
    .flatMap(value => (Array.isArray(value) ? value : []))
    .flatMap(value => (typeof value === 'string' ? [release(value)] : []))
    .filter((value): value is { major: number; minor: number } => value !== undefined);
  if (supported.some(value => value.major > 3 || (value.major === 3 && value.minor >= 1))) return 'canonical';
  if (supported.length > 0) return 'legacy';
  const explicit = release(caps.version);
  if (explicit) return explicit.major > 3 || (explicit.major === 3 && explicit.minor >= 1) ? 'canonical' : 'legacy';
  if (caps._synthetic === true || caps.synthetic === true) return 'unknown';
  const majors = [
    caps.major_versions,
    caps.majorVersions,
    adcp?.major_versions,
    adcp?.majorVersions,
    rawAdcp?.major_versions,
    rawAdcp?.majorVersions,
  ]
    .flatMap(value => (Array.isArray(value) ? value : []))
    .map(value => (typeof value === 'number' ? value : Number.parseInt(String(value), 10)))
    .filter(Number.isInteger);
  if (majors.some(value => value >= 4)) return 'canonical';
  return majors.includes(3) ? 'legacy' : 'unknown';
}
