import type {
  CreativeAsset,
  CreateMediaBuyRequest,
  CreateMediaBuyResponse,
  FormatOptionReference,
  GetProductsRequest,
  GetProductsResponse,
  GetCreativeDeliveryResponse,
  GetMediaBuyDeliveryResponse,
  GetMediaBuysResponse,
  CreativeFilters,
  ListCreativesResponse,
  ListCreativesRequest,
  PackageRequest,
  PackageUpdate,
  Package,
  Placement,
  Product,
  SyncCreativesRequest,
  SyncCreativesResponse,
  UpdateMediaBuyRequest,
  UpdateMediaBuyResponse,
} from '../../types/tools.generated';
import { projectV1ProductToV2, resolveCanonicalFormatKind } from './v1-to-v2';
import type { LegacyFormatConverter } from './v1-to-v2';
import { CanonicalFormatLegacyResolutionError, resolveCanonicalFormatLegacyRefs } from './v2-to-v1';
import type { CanonicalFormatLegacyResolver } from './v2-to-v1';
import type { CanonicalFormatKind, ProjectionDiagnostic, V1FormatId } from './types';
import {
  legacyFormatRefsForDeclaration,
  selectedFormatOptions,
  transferLegacyCreativeMetadata,
} from './legacy-metadata';
import type { CanonicalFormatDeclaration } from './legacy-metadata';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, Extract<keyof T, K>> : never;

/** Primary SDK creative shape. Legacy creative identity is a wire-adapter concern. */
export type CanonicalCreativeAsset = Omit<CanonicalCreativeResponse<CreativeAsset>, 'format_kind'> & {
  format_kind: CanonicalFormatKind;
  format_id?: never;
};

/** Explicit compatibility-only creative shape used at a legacy wire boundary. */
export type LegacyCreativeAsset = Omit<CreativeAsset, 'format_id' | 'format_kind' | 'format_option_ref'> & {
  format_id: V1FormatId;
  format_kind?: never;
  format_option_ref?: never;
};

export type CanonicalPackageRequest = DistributiveOmit<
  CanonicalCreativeResponse<PackageRequest>,
  'creatives' | 'format_ids'
> & {
  creatives?: CanonicalCreativeAsset[];
  format_ids?: never;
};
export type NonEmptyCanonicalFormatDeclarations = [CanonicalFormatDeclaration, ...CanonicalFormatDeclaration[]];
export type CanonicalPlacement = Omit<CanonicalCreativeResponse<Placement>, 'format_ids' | 'format_options'> & {
  format_ids?: never;
  format_options?: NonEmptyCanonicalFormatDeclarations;
};
export type CanonicalProduct = Omit<
  CanonicalCreativeResponse<Product>,
  'format_ids' | 'format_options' | 'placements'
> & {
  product_id: string;
  format_ids?: never;
  format_options: NonEmptyCanonicalFormatDeclarations;
  placements?: CanonicalPlacement[];
};
type CanonicalGetProductsField = Exclude<NonNullable<GetProductsRequest['fields']>[number], 'format_ids'>;
/** Primary product discovery request cannot ask the SDK to expose legacy format IDs. */
export type CanonicalGetProductsRequest = Omit<GetProductsRequest, 'fields'> & {
  fields?: CanonicalGetProductsField[];
};
export type CanonicalGetProductsResponse = Omit<CanonicalCreativeResponse<GetProductsResponse>, 'products'> & {
  products: CanonicalProduct[];
  projection: { diagnostics: ProjectionDiagnostic[] };
};
export type CanonicalPackageUpdate = Omit<CanonicalCreativeResponse<PackageUpdate>, 'creatives'> & {
  creatives?: CanonicalCreativeAsset[];
};
export type CanonicalPackage = CanonicalCreativeResponse<Package>;
export type CanonicalCreateMediaBuyRequest = Omit<CanonicalCreativeResponse<CreateMediaBuyRequest>, 'packages'> & {
  packages?: CanonicalPackageRequest[];
};
export type CanonicalUpdateMediaBuyRequest = Omit<
  CanonicalCreativeResponse<UpdateMediaBuyRequest>,
  'packages' | 'new_packages'
> & {
  packages?: CanonicalPackageUpdate[];
  new_packages?: CanonicalPackageRequest[];
};
export type CanonicalSyncCreativesRequest = Omit<CanonicalCreativeResponse<SyncCreativesRequest>, 'creatives'> & {
  creatives: CanonicalCreativeAsset[];
};
export type CanonicalListedCreative = Omit<
  CanonicalCreativeResponse<ListCreativesResponse['creatives'][number]>,
  'format_id' | 'format_kind' | 'format_option_ref'
> & {
  format_kind: CanonicalFormatKind;
  format_option_ref?: FormatOptionReference;
  format_id?: never;
};
export type CanonicalListCreativesResponse = Omit<CanonicalCreativeResponse<ListCreativesResponse>, 'creatives'> & {
  creatives: CanonicalListedCreative[];
};
export type CanonicalCreateMediaBuyResponse = CanonicalCreativeResponse<CreateMediaBuyResponse>;
export type CanonicalUpdateMediaBuyResponse = CanonicalCreativeResponse<UpdateMediaBuyResponse>;
export type CanonicalSyncCreativesResponse = CanonicalCreativeResponse<SyncCreativesResponse>;
export type CanonicalGetMediaBuysResponse = CanonicalCreativeResponse<GetMediaBuysResponse>;
export type CanonicalGetMediaBuyDeliveryResponse = CanonicalCreativeResponse<GetMediaBuyDeliveryResponse>;
export type CanonicalGetCreativeDeliveryResponse = CanonicalCreativeResponse<GetCreativeDeliveryResponse>;

export type CanonicalCreativeFilters = Omit<CanonicalCreativeResponse<CreativeFilters>, 'format_ids'> & {
  format_ids?: never;
};

type CanonicalListCreativeField = Exclude<NonNullable<ListCreativesRequest['fields']>[number], 'format_id'>;

/** Primary list request: legacy named-format filters and response fields are migration-only. */
export type CanonicalListCreativesRequest = Omit<
  CanonicalCreativeResponse<ListCreativesRequest>,
  'filters' | 'fields'
> & {
  filters?: CanonicalCreativeFilters;
  fields?: CanonicalListCreativeField[];
};

type IsLegacyCreativeIdentityKey<K extends PropertyKey> = K extends string
  ? K extends '_message' | `${string}format_id${string}` | `${string}v1_format_ref${string}`
    ? true
    : false
  : false;

/** Recursively removes legacy creative routing identity from primary response types. */
export type CanonicalCreativeResponse<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer TItem)[]
    ? CanonicalCreativeResponse<TItem>[]
    : T extends object
      ? {
          [K in keyof T as IsLegacyCreativeIdentityKey<K> extends true ? never : K]: CanonicalCreativeResponse<T[K]>;
        }
      : T;

/** Runtime counterpart to {@link CanonicalCreativeResponse}. */
export function stripLegacyCreativeIdentity<T>(value: T): CanonicalCreativeResponse<T> {
  const legacyTokens = new Set<string>();
  const legacyUrlTokens = new Set<string>();
  const canonicalKinds = new Set<string>([
    'image',
    'html5',
    'display_tag',
    'image_carousel',
    'video_hosted',
    'video_vast',
    'audio_hosted',
    'audio_daast',
    'sponsored_placement',
    'native_in_feed',
    'responsive_creative',
    'agent_placement',
    'custom',
  ]);
  const creativeIdentityKey = (key: string): boolean =>
    key === '_message' || /(^|_)(?:format_ids?|v1_format_ref)($|_)/.test(key);
  const ownDataValue = (owner: Record<string, unknown>, key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  };
  const nonCreativeAgentContext = (key: string | undefined): boolean =>
    typeof key === 'string' &&
    !/(^|_)(?:creative|format|legacy)($|_)/.test(key) &&
    /(^|_)(?:agents?|agent_details|agent_info)($|_)/.test(key);
  const nonCreativeSignalContext = (owner: Record<string, unknown>, key: string | undefined): boolean =>
    ownDataValue(owner, 'source') === 'agent' && typeof key === 'string' && /(^|_)signal_ids?($|_)/.test(key);
  const nonCreativeListContext = (owner: Record<string, unknown>, key: string | undefined): boolean =>
    typeof ownDataValue(owner, 'list_id') === 'string' &&
    typeof key === 'string' &&
    /(^|_)(?:property_list|collection_list|list_ref)($|_)/.test(key);
  const explicitNonCreativeContextKey = (key: string | undefined): boolean =>
    nonCreativeAgentContext(key) ||
    (typeof key === 'string' && /(^|_)(?:signal_ids?|property_list|collection_list|list_ref)($|_)/.test(key));
  const standaloneLegacyTuple = (owner: Record<string, unknown>, ownerKey?: string): boolean => {
    if (
      nonCreativeAgentContext(ownerKey) ||
      nonCreativeSignalContext(owner, ownerKey) ||
      nonCreativeListContext(owner, ownerKey)
    ) {
      return false;
    }
    if (typeof ownDataValue(owner, 'agent_url') !== 'string' || typeof ownDataValue(owner, 'id') !== 'string') {
      return false;
    }
    return true;
  };
  const preservesNonCreativeAgentUrl = (key: string, owner: Record<string, unknown>, ownerKey?: string): boolean => {
    if (!/(^|_)agent_url($|_)/.test(key)) return false;
    if (key === 'agent_url') {
      return (
        nonCreativeAgentContext(ownerKey) ||
        nonCreativeSignalContext(owner, ownerKey) ||
        nonCreativeListContext(owner, ownerKey) ||
        (typeof ownDataValue(owner, 'id') === 'string' && !standaloneLegacyTuple(owner, ownerKey))
      );
    }
    return !/(^|_)(?:creative|format|legacy|offending|target|input|output)($|_)/.test(key);
  };
  const legacyKey = (key: string, owner: Record<string, unknown>, ownerKey?: string): boolean => {
    if (creativeIdentityKey(key)) return true;
    if (!/(^|_)agent_url($|_)/.test(key)) return false;
    if (preservesNonCreativeAgentUrl(key, owner, ownerKey)) return false;
    const value = ownDataValue(owner, key);
    // Composite agent URL fields are used by several non-creative protocol
    // domains. Remove them only when their value is known to belong to a
    // legacy creative identity collected elsewhere in this payload.
    return typeof value === 'string' && legacyTokens.has(value);
  };
  const collectStrings = (current: unknown, seen = new WeakSet<object>(), ownerKey?: string): void => {
    if (typeof current === 'string') {
      if (current.length > 1) {
        legacyTokens.add(current);
        if (ownerKey === 'agent_url' || /^https?:\/\//i.test(current)) legacyUrlTokens.add(current);
      }
      return;
    }
    if (current === null || typeof current !== 'object' || seen.has(current)) return;
    seen.add(current);
    if (Array.isArray(current)) {
      for (const child of current) collectStrings(child, seen, ownerKey);
      return;
    }
    for (const key of Reflect.ownKeys(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor || !('value' in descriptor)) continue;
      collectStrings(descriptor.value, seen, typeof key === 'string' ? key : ownerKey);
    }
  };
  const tokenSeenByContext = {
    default: new WeakSet<object>(),
    nonCreativeAgent: new WeakSet<object>(),
  };
  const collectLegacyTokens = (current: unknown, ownerKey?: string): void => {
    const seen = explicitNonCreativeContextKey(ownerKey)
      ? tokenSeenByContext.nonCreativeAgent
      : tokenSeenByContext.default;
    if (current === null || typeof current !== 'object' || seen.has(current)) return;
    seen.add(current);
    if (Array.isArray(current)) {
      for (const child of current) collectLegacyTokens(child, ownerKey);
      return;
    }
    const owner = current as Record<string, unknown>;
    if (standaloneLegacyTuple(owner, ownerKey)) collectStrings(owner, new WeakSet<object>(), ownerKey);
    for (const key of Object.getOwnPropertyNames(owner)) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (!descriptor || !('value' in descriptor)) continue;
      const child = descriptor.value;
      if (creativeIdentityKey(key)) collectStrings(child);
      else collectLegacyTokens(child, key);
    }
  };
  collectLegacyTokens(value);

  const sanitizeText = (text: string, ownerKey?: string): string => {
    const mentionsLegacyIdentity =
      /\b(?:format_id|format_ids|target_format_ids|input_format_ids|output_format_ids|v1_format_ref|agent_url)\b/.test(
        text
      );
    let safe = text;
    if (mentionsLegacyIdentity) {
      // Diagnostics sometimes repeat only the flattened identity and omit the
      // structured field that supplied it. Fail closed for those orphan
      // values while leaving unrelated URLs in ordinary messages untouched.
      safe = safe.replace(/\bhttps?:\/\/[^\s"'`<>]+/g, '[legacy creative identity]');
      safe = safe.replace(
        /(\b(?:format_ids?|v1_format_ref|agent_url)\b(?:\s+(?:was|is|from))?\s*[:=]?\s*["'`]?)\b[a-zA-Z0-9][a-zA-Z0-9_.-]{1,}/g,
        '$1[legacy creative identity]'
      );
    }
    safe = safe.replace(
      /\b(?:format_id|format_ids|target_format_ids|input_format_ids|output_format_ids|v1_format_ref|agent_url)\b/g,
      'legacy creative identity'
    );
    for (const token of [...legacyUrlTokens].sort((left, right) => right.length - left.length)) {
      safe = safe.split(token).join('[legacy creative identity]');
    }
    const diagnosticContext =
      mentionsLegacyIdentity ||
      (typeof ownerKey === 'string' &&
        /(^|_)(?:message|question|prompt|error|reason|summary|context|stack|diagnostic)($|_)/.test(ownerKey));
    if (diagnosticContext) {
      for (const token of [...legacyTokens].sort((left, right) => right.length - left.length)) {
        if (legacyUrlTokens.has(token) || canonicalKinds.has(token)) continue;
        if (token.length < 8 && !/[_:/. -]/.test(token)) continue;
        safe = safe.split(token).join('[legacy creative identity]');
      }
    }
    return safe;
  };

  // The same object can appear once under an explicit agent field and once
  // under an ambiguous extension field. Cache by policy context so an allowed
  // agent occurrence cannot make a later ambiguous tuple fail open (or vice
  // versa based on property order).
  const seenByContext = {
    default: new WeakMap<object, unknown>(),
    nonCreativeAgent: new WeakMap<object, unknown>(),
  };
  const hasCustomToJSON = (candidate: object): boolean => {
    let cursor: object | null = candidate;
    while (cursor) {
      const descriptor = Object.getOwnPropertyDescriptor(cursor, 'toJSON');
      if (descriptor) return !('value' in descriptor) || typeof descriptor.value === 'function';
      cursor = Object.getPrototypeOf(cursor) as object | null;
    }
    return false;
  };
  const strip = (current: unknown, ownerKey?: string): unknown => {
    if (typeof current === 'string') return sanitizeText(current, ownerKey);
    if (current === null || typeof current !== 'object') return current;
    const seen = explicitNonCreativeContextKey(ownerKey) ? seenByContext.nonCreativeAgent : seenByContext.default;
    const cached = seen.get(current);
    if (cached !== undefined) return cached;
    if (Array.isArray(current)) {
      const result: unknown[] = [];
      seen.set(current, result);
      const needsSafeToJSON = hasCustomToJSON(current);
      let changed = needsSafeToJSON || Object.getPrototypeOf(current) !== Array.prototype;
      for (const key of Reflect.ownKeys(current)) {
        if (key === 'length') continue;
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor) continue;
        if (!('value' in descriptor)) {
          changed = true;
          continue;
        }
        if (key === 'toJSON' && typeof descriptor.value === 'function') {
          changed = true;
          continue;
        }
        if (typeof key === 'string' && legacyKey(key, current as unknown as Record<string, unknown>, ownerKey)) {
          changed = true;
          continue;
        }
        const safe = strip(descriptor.value, typeof key === 'string' && !/^\d+$/.test(key) ? key : ownerKey);
        if (safe !== descriptor.value) changed = true;
        Object.defineProperty(result, key, { ...descriptor, value: safe });
      }
      result.length = current.length;
      if (!changed) {
        seen.set(current, current);
        return current;
      }
      if (needsSafeToJSON) {
        Object.defineProperty(result, 'toJSON', {
          configurable: true,
          enumerable: false,
          value: () => Array.from(result),
        });
      }
      transferLegacyCreativeMetadata(current, result);
      return result;
    }
    const prototype = Object.getPrototypeOf(current);
    const plain = prototype === Object.prototype || prototype === null;
    const safePrototype =
      prototype === null ? null : Error.prototype.isPrototypeOf(current) ? Error.prototype : Object.prototype;
    // Never retain an adopter-controlled prototype. Inherited getters and
    // methods are behavior, not inspected data, and can reveal legacy identity
    // after this boundary has supposedly been sanitized.
    const result: Record<string | symbol, unknown> = Object.create(safePrototype);
    seen.set(current, result);
    const owner = current as Record<string, unknown>;
    if (standaloneLegacyTuple(owner, ownerKey)) {
      const empty = {};
      seen.set(current, empty);
      return empty;
    }
    const needsSafeToJSON = hasCustomToJSON(current);
    let changed = !plain || needsSafeToJSON;
    const keys: Array<string | symbol> = Reflect.ownKeys(current);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor) continue;
      if (!('value' in descriptor)) {
        // Never reflect accessors across the canonical boundary. Evaluating a
        // retained getter later could reveal a legacy identity that was not
        // present while this object was inspected (and may run adopter code).
        changed = true;
        continue;
      }
      const child = descriptor.value;
      if (typeof key === 'symbol') {
        const safe = strip(child);
        if (safe !== child) changed = true;
        if (!plain) Object.defineProperty(result, key, { ...descriptor, value: safe });
        continue;
      }
      if (key === 'toJSON' && typeof child === 'function') {
        changed = true;
        continue;
      }
      if (legacyKey(key, owner, ownerKey)) {
        changed = true;
        continue;
      }
      const safe = preservesNonCreativeAgentUrl(key, owner, ownerKey) ? child : strip(child, key);
      if (safe !== child) changed = true;
      if (plain && typeof key === 'string' && descriptor.enumerable) result[key] = safe;
      else Object.defineProperty(result, key, { ...descriptor, value: safe });
    }
    if (!changed) {
      seen.set(current, current);
      return current;
    }
    if (needsSafeToJSON) {
      Object.defineProperty(result, 'toJSON', {
        configurable: true,
        enumerable: false,
        value: () => {
          const serialized: Record<string, unknown> = {};
          for (const key of Object.keys(result)) serialized[key] = result[key];
          return serialized;
        },
      });
    }
    transferLegacyCreativeMetadata(current, result);
    return result;
  };
  return strip(value) as CanonicalCreativeResponse<T>;
}

export type CanonicalProjectedCreative<T> = Omit<T, 'format_id' | 'format_kind'> & {
  format_kind: CanonicalFormatKind;
  format_id?: never;
};
export type LegacyProjectedCreative<T> = Omit<T, 'format_id' | 'format_kind' | 'format_option_ref'> & {
  format_id: V1FormatId;
  format_kind?: never;
  format_option_ref?: never;
};

type ProjectedCreativeArray<T, TMode extends 'canonical' | 'legacy'> =
  T extends ReadonlyArray<infer TCreative>
    ? Array<TMode extends 'canonical' ? CanonicalProjectedCreative<TCreative> : LegacyProjectedCreative<TCreative>>
    : T;
type ReplaceCreatives<T, TMode extends 'canonical' | 'legacy'> = T extends object
  ? 'creatives' extends keyof T
    ? Omit<T, 'creatives'> &
        (Record<never, never> extends Pick<T, 'creatives'>
          ? { creatives?: ProjectedCreativeArray<T['creatives'], TMode> }
          : { creatives: ProjectedCreativeArray<T['creatives'], TMode> })
    : T
  : T;
type ProjectedContainerArray<T, TMode extends 'canonical' | 'legacy'> =
  T extends ReadonlyArray<infer TContainer> ? Array<ReplaceCreatives<TContainer, TMode>> : T;
type ReplaceContainerKey<
  T,
  TKey extends 'packages' | 'new_packages',
  TMode extends 'canonical' | 'legacy',
> = TKey extends keyof T
  ? Record<never, never> extends Pick<T, TKey>
    ? { [K in TKey]?: ProjectedContainerArray<T[TKey], TMode> }
    : { [K in TKey]: ProjectedContainerArray<T[TKey], TMode> }
  : Record<never, never>;

export type ProjectedMediaBuyCreativeRequest<T, TMode extends 'canonical' | 'legacy'> = Omit<
  T,
  'packages' | 'new_packages'
> &
  ReplaceContainerKey<T, 'packages', TMode> &
  ReplaceContainerKey<T, 'new_packages', TMode>;
export type ProjectedSyncCreativeRequest<T, TMode extends 'canonical' | 'legacy'> = ReplaceCreatives<T, TMode>;

export type CreativeFormatWireMode = 'canonical' | 'legacy' | 'unknown';

export interface CreativeFormatSelectorContainer {
  package_id?: string;
  format_ids?: unknown[];
  formats?: unknown[];
  format_options?: unknown[];
  format_option_refs?: unknown[];
  format_kind?: unknown;
  params?: unknown;
  /** Internal composition seam used to preserve per-package selector constraints. */
  selector_containers?: ReadonlyArray<CreativeFormatSelectorContainer>;
  [key: string]: unknown;
}

/** Canonical package/product selectors accepted by the primary sync API. */
export interface CanonicalCreativeFormatSelectorContainer {
  package_id?: string;
  format_options?: ReadonlyArray<CanonicalFormatDeclaration>;
  format_option_refs?: ReadonlyArray<FormatOptionReference>;
  format_kind?: CanonicalFormatKind;
  params?: CanonicalFormatDeclaration['params'];
  selector_containers?: ReadonlyArray<CanonicalCreativeFormatSelectorContainer>;
}

export interface SyncCreativeFormatProjection {
  selectorContainers: ReadonlyArray<CanonicalCreativeFormatSelectorContainer>;
  legacyFormatConverter?: LegacyFormatConverter;
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

export class CreativeFormatCapabilityError extends Error {
  readonly code = 'ADCP_CREATIVE_FORMAT_CAPABILITY_CONTRADICTION';

  constructor(message: string) {
    super(message);
    this.name = 'CreativeFormatCapabilityError';
  }
}

const CANONICAL_FORMAT_KINDS = new Set<CanonicalFormatKind>([
  'image',
  'html5',
  'display_tag',
  'image_carousel',
  'video_hosted',
  'video_vast',
  'audio_hosted',
  'audio_daast',
  'sponsored_placement',
  'native_in_feed',
  'responsive_creative',
  'agent_placement',
  'custom',
]);

type LegacyCandidate = {
  ref: V1FormatId;
  formatKind?: string;
  formatOptionRef?: FormatOptionReference;
  selectorParams?: unknown;
};

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

type CanonicalFormatOptionReference = FormatOptionReference & { canonical_formats_only?: true };

function optionReference(value: unknown): CanonicalFormatOptionReference | undefined {
  const option = record(value);
  if (!option || typeof option.format_option_id !== 'string' || option.format_option_id.length === 0) return undefined;
  const canonicalOnly = option.canonical_formats_only === true ? { canonical_formats_only: true as const } : {};
  if (typeof option.publisher_domain === 'string') {
    return {
      scope: 'publisher',
      publisher_domain: option.publisher_domain,
      format_option_id: option.format_option_id,
      ...canonicalOnly,
    };
  }
  return { scope: 'product', format_option_id: option.format_option_id, ...canonicalOnly };
}

function sameOptionReference(left: FormatOptionReference, right: FormatOptionReference): boolean {
  return (
    left.scope === right.scope &&
    left.format_option_id === right.format_option_id &&
    (left.scope !== 'publisher' || (right.scope === 'publisher' && left.publisher_domain === right.publisher_domain))
  );
}

function selectedOptionReferences(container: CreativeFormatSelectorContainer): CanonicalFormatOptionReference[] {
  const direct = Array.isArray(container.format_option_refs)
    ? container.format_option_refs.flatMap(value => {
        const ref = optionReference(value);
        return ref ? [ref] : [];
      })
    : [];
  const nested = Array.isArray(container.selector_containers)
    ? container.selector_containers.flatMap(selectedOptionReferences)
    : [];
  return [...direct, ...nested];
}

function agentIdentity(value: string): string {
  try {
    // URL parsing normalizes the scheme/host (the case-insensitive pieces)
    // while preserving case-sensitive paths, queries, and fragments.
    return new URL(value).href;
  } catch {
    return value;
  }
}

function sameLegacyIdentity(left: V1FormatId, right: V1FormatId): boolean {
  return agentIdentity(left.agent_url) === agentIdentity(right.agent_url) && left.id === right.id;
}

function candidatesFromContainer(
  container: CreativeFormatSelectorContainer,
  canonicalFormatLegacyResolver?: CanonicalFormatLegacyResolver,
  operation = 'creative_delivery'
): LegacyCandidate[] {
  if (Array.isArray(container.selector_containers)) {
    return uniqueCandidates(
      container.selector_containers.flatMap(candidate =>
        candidatesFromContainer(candidate, canonicalFormatLegacyResolver, operation)
      )
    );
  }
  const candidates: LegacyCandidate[] = [];
  const containerKind = typeof container.format_kind === 'string' ? container.format_kind : undefined;
  for (const key of ['format_ids', 'formats'] as const) {
    for (const ref of refsFromValue(container[key])) {
      candidates.push({
        ref,
        formatKind: resolveCanonicalFormatKind(ref.id) ?? containerKind,
        selectorParams: container.params,
      });
    }
  }
  const formatOptions = [
    ...(Array.isArray(container.format_options) ? container.format_options : []),
    ...selectedFormatOptions(container),
  ];
  for (const optionValue of formatOptions) {
    const option = record(optionValue);
    if (!option) continue;
    const formatKind = typeof option.format_kind === 'string' ? option.format_kind : undefined;
    const formatOptionRef = optionReference(option);
    let refs = [...legacyFormatRefsForDeclaration(option)];
    if (refs.length === 0 && option.canonical_formats_only !== true && formatKind) {
      try {
        refs =
          resolveCanonicalFormatLegacyRefs(canonicalFormatLegacyResolver, {
            source: 'product',
            declaration: option as unknown as import('./types').V2ProductFormatDeclaration,
            productId: typeof container.product_id === 'string' ? container.product_id : '<selector>',
            field: formatOptionRef?.format_option_id ?? '(format option)',
          }) ?? [];
      } catch (error) {
        if (!(error instanceof CanonicalFormatLegacyResolutionError)) throw error;
        throw new CreativeFormatProjectionError(
          operation,
          '(format option)',
          'canonical format legacy resolver returned an invalid product mapping'
        );
      }
    }
    for (const ref of refs) {
      candidates.push({ ref, formatKind, formatOptionRef, selectorParams: option.params ?? container.params });
    }
  }
  return uniqueCandidates(candidates);
}

function containerOptsOutOfLegacy(
  container: CreativeFormatSelectorContainer,
  formatKind?: string,
  formatOptionRef?: FormatOptionReference
): boolean {
  if ((formatOptionRef as CanonicalFormatOptionReference | undefined)?.canonical_formats_only === true) return true;
  if (
    Array.isArray(container.selector_containers) &&
    container.selector_containers.some(candidate => containerOptsOutOfLegacy(candidate, formatKind, formatOptionRef))
  ) {
    return true;
  }
  const selectedRefs = selectedOptionReferences(container);
  if (
    selectedRefs.some(ref => {
      if (ref.canonical_formats_only !== true) return false;
      return formatOptionRef === undefined || sameOptionReference(ref, formatOptionRef);
    })
  ) {
    return true;
  }
  const formatOptions = [
    ...(Array.isArray(container.format_options) ? container.format_options : []),
    ...selectedFormatOptions(container),
  ];
  return formatOptions.some(value => {
    const option = record(value);
    if (!option || option.canonical_formats_only !== true) return false;
    if (formatKind && option.format_kind !== formatKind) return false;
    if (formatOptionRef) {
      const optionRef = optionReference(option);
      if (!optionRef || !sameOptionReference(optionRef, formatOptionRef)) return false;
    }
    return true;
  });
}

function candidateKey(candidate: LegacyCandidate): string {
  const ref = candidate.ref;
  return [
    agentIdentity(ref.agent_url),
    ref.id,
    ref.width ?? '',
    ref.height ?? '',
    ref.duration_ms ?? '',
    candidate.formatOptionRef?.scope ?? '',
    candidate.formatOptionRef?.format_option_id ?? '',
    candidate.formatOptionRef?.scope === 'publisher' ? candidate.formatOptionRef.publisher_domain : '',
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
  container: CreativeFormatSelectorContainer,
  canonicalFormatLegacyResolver?: CanonicalFormatLegacyResolver,
  operation = 'creative_delivery'
): V1FormatId | undefined {
  let candidates = candidatesFromContainer(container, canonicalFormatLegacyResolver, operation);
  const creativeOptionRef = optionReference(creative.format_option_ref);
  const selectedOptionRefs = Array.isArray(container.format_option_refs)
    ? container.format_option_refs.flatMap(value => {
        const ref = optionReference(value);
        return ref ? [ref] : [];
      })
    : [];
  if (creativeOptionRef) {
    if (selectedOptionRefs.length > 0 && !selectedOptionRefs.some(ref => sameOptionReference(ref, creativeOptionRef))) {
      return undefined;
    }
    candidates = candidates.filter(
      candidate => candidate.formatOptionRef && sameOptionReference(candidate.formatOptionRef, creativeOptionRef)
    );
  } else if (selectedOptionRefs.length > 0) {
    candidates = candidates.filter(
      candidate =>
        candidate.formatOptionRef &&
        selectedOptionRefs.some(ref => sameOptionReference(ref, candidate.formatOptionRef!))
    );
  }
  const existing = legacyRef(creative.format_id);
  if (existing) {
    const exact = candidates.filter(
      candidate =>
        sameLegacyIdentity(candidate.ref, existing) &&
        (existing.width === undefined || candidate.ref.width === existing.width) &&
        (existing.height === undefined || candidate.ref.height === existing.height) &&
        (existing.duration_ms === undefined || candidate.ref.duration_ms === existing.duration_ms)
    );
    if (exact.length === 1) return exact[0]!.ref;
    return candidates.length === 0 ? existing : undefined;
  }

  if (typeof creative.format_kind !== 'string') return undefined;
  let matching = candidates.filter(candidate => candidate.formatKind === creative.format_kind);
  const constrained = matching.filter(candidate => refMatchesParams(candidate.ref, candidate.selectorParams));
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

function dedupeLegacyRefs(refs: readonly V1FormatId[]): V1FormatId[] {
  return [...new Map(refs.map(ref => [candidateKey({ ref }), { ...ref }])).values()];
}

function projectPackageSelectors(
  pkg: Record<string | symbol, unknown>,
  wireMode: CreativeFormatWireMode,
  operation: string,
  legacyFormatConverter?: LegacyFormatConverter,
  canonicalFormatLegacyResolver?: CanonicalFormatLegacyResolver
): Record<string | symbol, unknown> {
  const next = { ...pkg };
  const optionRefs = Array.isArray(pkg.format_option_refs)
    ? pkg.format_option_refs.flatMap(value => {
        const ref = optionReference(value);
        return ref ? [ref] : [];
      })
    : [];
  const legacyRefs = refsFromValue(pkg.format_ids);
  const candidates = candidatesFromContainer(
    pkg as CreativeFormatSelectorContainer,
    wireMode === 'canonical' ? undefined : canonicalFormatLegacyResolver,
    operation
  );
  const canonicalKind = typeof pkg.format_kind === 'string' ? pkg.format_kind : undefined;

  if (wireMode === 'canonical') {
    if (optionRefs.length > 0) {
      // Rebuild the array before transport so SDK-private downgrade metadata
      // never crosses the canonical wire boundary.
      next.format_option_refs = optionRefs.map(ref => ({ ...ref }));
    }
    if (legacyRefs.length > 0) {
      let mappedRefs = legacyRefs.flatMap(legacy => {
        const matches = candidates.filter(candidate => sameLegacyIdentity(candidate.ref, legacy));
        if (matches.length !== 1 || !matches[0]!.formatOptionRef) return [];
        return [matches[0]!.formatOptionRef];
      });
      if (optionRefs.length === 0 && mappedRefs.length !== legacyRefs.length) {
        const productId = typeof pkg.product_id === 'string' ? pkg.product_id : '<package-selector>';
        const projected = projectV1ProductToV2(
          {
            product_id: productId,
            name: productId,
            description: 'legacy package selector normalization',
            format_ids: legacyRefs,
          },
          { legacyFormatConverter }
        );
        const projectedRefs = projected.v2.format_options.flatMap(option => {
          const ref = optionReference(option);
          return ref ? [ref] : [];
        });
        if (projected.diagnostics.length > 0 || projectedRefs.length !== legacyRefs.length) {
          throw new CreativeFormatProjectionError(
            operation,
            '(package selector)',
            'legacy package format_ids cannot be converted to stable canonical format_option_refs'
          );
        }
        mappedRefs = projectedRefs;
      }
      if (optionRefs.length === 0) next.format_option_refs = mappedRefs;
    }
    delete next.format_ids;
  } else {
    if (optionRefs.length > 0) {
      const selectedCandidates = candidates.filter(
        candidate =>
          candidate.formatOptionRef &&
          optionRefs.some(selected => sameOptionReference(selected, candidate.formatOptionRef!))
      );
      const everyOptionMapped = optionRefs.every(selected =>
        selectedCandidates.some(candidate =>
          candidate.formatOptionRef ? sameOptionReference(selected, candidate.formatOptionRef) : false
        )
      );
      if (!everyOptionMapped || selectedCandidates.length === 0) {
        let resolved: V1FormatId[] | undefined;
        try {
          if (!containerOptsOutOfLegacy(pkg as CreativeFormatSelectorContainer)) {
            resolved = resolveCanonicalFormatLegacyRefs(canonicalFormatLegacyResolver, {
              source: 'selector',
              selector: pkg as Record<string, unknown>,
              operation,
              field: '(package selector)',
            });
          }
        } catch (error) {
          if (!(error instanceof CanonicalFormatLegacyResolutionError)) throw error;
          throw new CreativeFormatProjectionError(
            operation,
            '(package selector)',
            'canonical format legacy resolver returned an invalid or ambiguous package mapping'
          );
        }
        if (!resolved) {
          throw new CreativeFormatProjectionError(
            operation,
            '(package selector)',
            'canonical format_option_refs have no complete legacy representation; re-run getProducts() or configure canonicalFormatLegacyResolver for persisted selections'
          );
        }
        next.format_ids = resolved;
        delete next.format_option_refs;
        delete next.format_kind;
        return next;
      }
      next.format_ids = dedupeLegacyRefs(selectedCandidates.map(candidate => candidate.ref));
      delete next.format_option_refs;
    } else if (canonicalKind) {
      const selectedCandidates = candidates.filter(candidate => candidate.formatKind === canonicalKind);
      if (selectedCandidates.length === 1) {
        next.format_ids = [{ ...selectedCandidates[0]!.ref }];
      } else {
        let resolved: V1FormatId[] | undefined;
        try {
          if (!containerOptsOutOfLegacy(pkg as CreativeFormatSelectorContainer, canonicalKind)) {
            resolved = resolveCanonicalFormatLegacyRefs(
              canonicalFormatLegacyResolver,
              {
                source: 'selector',
                selector: pkg as Record<string, unknown>,
                operation,
                field: '(package selector)',
              },
              true
            );
          }
        } catch (error) {
          if (!(error instanceof CanonicalFormatLegacyResolutionError)) throw error;
          throw new CreativeFormatProjectionError(
            operation,
            '(package selector)',
            'canonical format legacy resolver returned an invalid or ambiguous package mapping'
          );
        }
        if (resolved) {
          next.format_ids = resolved;
        } else {
          throw new CreativeFormatProjectionError(
            operation,
            '(package selector)',
            'canonical package format_kind has no unambiguous legacy representation; select a format_option_ref from the product before delivery'
          );
        }
      }
    }
    delete next.format_kind;
  }

  return next;
}

function canonicalizeCreative<T extends Record<string, unknown>>(
  creative: T,
  selectorContainer: CreativeFormatSelectorContainer,
  operation: string,
  legacyFormatConverter?: LegacyFormatConverter
): T {
  const creativeId = typeof creative.creative_id === 'string' ? creative.creative_id : '(unknown)';
  const hasCanonicalKind = typeof creative.format_kind === 'string';
  if (hasCanonicalKind && creative.format_id !== undefined) {
    throw new CreativeFormatProjectionError(
      operation,
      creativeId,
      'creative must not declare both canonical format_kind and legacy format_id'
    );
  }
  if (hasCanonicalKind && creative.format_id === undefined) {
    if (!CANONICAL_FORMAT_KINDS.has(creative.format_kind as CanonicalFormatKind)) {
      throw new CreativeFormatProjectionError(
        operation,
        creativeId,
        `unknown canonical format_kind ${creative.format_kind}`
      );
    }
    const creativeOptionRef = optionReference(creative.format_option_ref);
    const selectedRefs = selectedOptionReferences(selectorContainer);
    if (
      creativeOptionRef &&
      selectedRefs.length > 0 &&
      !selectedRefs.some(ref => sameOptionReference(ref, creativeOptionRef))
    ) {
      throw new CreativeFormatProjectionError(
        operation,
        creativeId,
        'creative format_option_ref conflicts with the package selected format_option_refs'
      );
    }
    return creative;
  }
  const existing = legacyRef(creative.format_id);
  if (!existing) {
    throw new CreativeFormatProjectionError(
      operation,
      creativeId,
      'creative must identify its format canonically with format_kind'
    );
  }

  const matchingCandidates = candidatesFromContainer(selectorContainer).filter(
    candidate =>
      sameLegacyIdentity(candidate.ref, existing) &&
      (existing.width === undefined || candidate.ref.width === existing.width) &&
      (existing.height === undefined || candidate.ref.height === existing.height) &&
      (existing.duration_ms === undefined || candidate.ref.duration_ms === existing.duration_ms)
  );
  if (matchingCandidates.length === 1 && matchingCandidates[0]!.formatKind) {
    const candidate = matchingCandidates[0]!;
    const next: Record<string, unknown> = { ...creative, format_kind: candidate.formatKind };
    delete next.format_id;
    if (candidate.formatOptionRef) next.format_option_ref = candidate.formatOptionRef;
    if (candidate.formatKind === 'custom' && !candidate.formatOptionRef) {
      throw new CreativeFormatProjectionError(
        operation,
        creativeId,
        'custom product format must provide format_option_id so the canonical creative retains a concrete identity'
      );
    }
    return next as T;
  }
  const selectorCandidates = candidatesFromContainer(selectorContainer);
  if (selectorCandidates.length > 0 && matchingCandidates.length !== 1) {
    throw new CreativeFormatProjectionError(
      operation,
      creativeId,
      matchingCandidates.length === 0
        ? 'legacy format reference conflicts with the selected seller format identity or constraints'
        : 'legacy format reference is ambiguous within the selected seller format options'
    );
  }

  const { v2, diagnostics } = projectV1ProductToV2(
    {
      product_id: `<creative:${creativeId}>`,
      name: creativeId,
      description: 'legacy creative normalization',
      format_ids: [existing],
    },
    { legacyFormatConverter }
  );
  const declaration = v2.format_options[0];
  if (!declaration) {
    const diagnostic = diagnostics[0];
    const failure =
      diagnostic?.code === 'FORMAT_PROJECTION_FAILED' ? diagnostic.error.details.resolution_failure : undefined;
    throw new CreativeFormatProjectionError(
      operation,
      creativeId,
      `legacy creative format has no canonical conversion${failure ? ` (${failure})` : ''}`
    );
  }
  const next: Record<string, unknown> = { ...creative, format_kind: declaration.format_kind };
  delete next.format_id;
  const candidateOptionRef =
    matchingCandidates.length === 1 && matchingCandidates[0]!.formatKind === declaration.format_kind
      ? matchingCandidates[0]!.formatOptionRef
      : undefined;
  const convertedOptionRef = optionReference(declaration) ?? candidateOptionRef;
  if (convertedOptionRef) next.format_option_ref = convertedOptionRef;
  if (declaration.format_kind === 'custom' && !convertedOptionRef) {
    throw new CreativeFormatProjectionError(
      operation,
      creativeId,
      'custom legacy conversion must provide format_option_id so the canonical creative retains a concrete identity'
    );
  }
  return next as T;
}

export function projectCreativeForDelivery<T extends CreativeAsset>(
  creative: T,
  selectorContainer: CreativeFormatSelectorContainer,
  wireMode?: 'canonical',
  operation?: string,
  legacyFormatConverter?: LegacyFormatConverter,
  canonicalFormatLegacyResolver?: CanonicalFormatLegacyResolver
): CanonicalProjectedCreative<T>;
export function projectCreativeForDelivery<T extends CreativeAsset>(
  creative: T,
  selectorContainer: CreativeFormatSelectorContainer,
  wireMode: 'legacy' | 'unknown',
  operation?: string,
  legacyFormatConverter?: LegacyFormatConverter,
  canonicalFormatLegacyResolver?: CanonicalFormatLegacyResolver
): LegacyProjectedCreative<T>;
export function projectCreativeForDelivery<T extends CreativeAsset>(
  creative: T,
  selectorContainer: CreativeFormatSelectorContainer,
  wireMode: CreativeFormatWireMode,
  operation?: string,
  legacyFormatConverter?: LegacyFormatConverter,
  canonicalFormatLegacyResolver?: CanonicalFormatLegacyResolver
): CanonicalProjectedCreative<T> | LegacyProjectedCreative<T>;
export function projectCreativeForDelivery<T extends CreativeAsset>(
  creative: T,
  selectorContainer: CreativeFormatSelectorContainer,
  wireMode: CreativeFormatWireMode = 'canonical',
  operation = 'creative_delivery',
  legacyFormatConverter?: LegacyFormatConverter,
  canonicalFormatLegacyResolver?: CanonicalFormatLegacyResolver
): CanonicalProjectedCreative<T> | LegacyProjectedCreative<T> {
  const inputRecord = creative as unknown as Record<string, unknown>;
  const originalLegacyRef = legacyRef(inputRecord.format_id);
  const creativeRecord = canonicalizeCreative(inputRecord, selectorContainer, operation, legacyFormatConverter);
  if (wireMode === 'canonical') return creativeRecord as unknown as CanonicalProjectedCreative<T>;
  if (originalLegacyRef) {
    const selectedOriginal = selectLegacyRef(inputRecord, selectorContainer, canonicalFormatLegacyResolver, operation);
    if (selectedOriginal) {
      return projectCreative(creativeRecord, selectedOriginal) as unknown as LegacyProjectedCreative<T>;
    }
    throw new CreativeFormatProjectionError(
      operation,
      typeof inputRecord.creative_id === 'string' ? inputRecord.creative_id : '(unknown)',
      'the original legacy format reference conflicts with the selected seller format identity or constraints'
    );
  }
  const formatId = selectLegacyRef(creativeRecord, selectorContainer, canonicalFormatLegacyResolver, operation);
  if (formatId) return projectCreative(creativeRecord, formatId) as unknown as LegacyProjectedCreative<T>;

  if (typeof creativeRecord.format_kind === 'string') {
    const creativeId = typeof creativeRecord.creative_id === 'string' ? creativeRecord.creative_id : '(unknown)';
    const allCandidates = candidatesFromContainer(selectorContainer, canonicalFormatLegacyResolver, operation);
    let candidates = allCandidates.filter(candidate => candidate.formatKind === creativeRecord.format_kind);
    const constrained = candidates.filter(candidate => refMatchesParams(candidate.ref, selectorContainer.params));
    if (constrained.length > 0) candidates = constrained;
    let resolved: V1FormatId[] | undefined;
    try {
      if (
        !containerOptsOutOfLegacy(
          selectorContainer,
          creativeRecord.format_kind,
          optionReference(creativeRecord.format_option_ref)
        )
      ) {
        resolved = resolveCanonicalFormatLegacyRefs(
          canonicalFormatLegacyResolver,
          {
            source: 'creative',
            creative: creativeRecord,
            selector: selectorContainer as Record<string, unknown>,
            operation,
            field: creativeId,
          },
          true
        );
      }
    } catch (error) {
      if (!(error instanceof CanonicalFormatLegacyResolutionError)) throw error;
      throw new CreativeFormatProjectionError(
        operation,
        creativeId,
        'canonical format legacy resolver returned an invalid or ambiguous creative mapping'
      );
    }
    if (resolved) return projectCreative(creativeRecord, resolved[0]!) as unknown as LegacyProjectedCreative<T>;
    if (candidates.length > 1) {
      throw new CreativeFormatProjectionError(
        operation,
        creativeId,
        `the seller advertised ${candidates.length} legacy refs for canonical kind ${creativeRecord.format_kind}`
      );
    }
    const reason = 'the selected seller product did not provide one unambiguous legacy format reference';
    throw new CreativeFormatProjectionError(operation, creativeId, reason);
  }
  return creative as unknown as LegacyProjectedCreative<T>;
}

export function projectMediaBuyCreativesForDelivery<T>(
  request: T,
  wireMode: 'canonical',
  operation?: 'create_media_buy' | 'update_media_buy',
  legacyFormatConverter?: LegacyFormatConverter,
  canonicalFormatLegacyResolver?: CanonicalFormatLegacyResolver
): ProjectedMediaBuyCreativeRequest<T, 'canonical'>;
export function projectMediaBuyCreativesForDelivery<T>(
  request: T,
  wireMode: 'legacy' | 'unknown',
  operation?: 'create_media_buy' | 'update_media_buy',
  legacyFormatConverter?: LegacyFormatConverter,
  canonicalFormatLegacyResolver?: CanonicalFormatLegacyResolver
): ProjectedMediaBuyCreativeRequest<T, 'legacy'>;
export function projectMediaBuyCreativesForDelivery<T>(
  request: T,
  wireMode: CreativeFormatWireMode,
  operation?: 'create_media_buy' | 'update_media_buy',
  legacyFormatConverter?: LegacyFormatConverter,
  canonicalFormatLegacyResolver?: CanonicalFormatLegacyResolver
): ProjectedMediaBuyCreativeRequest<T, 'canonical'> | ProjectedMediaBuyCreativeRequest<T, 'legacy'>;
export function projectMediaBuyCreativesForDelivery<T>(
  request: T,
  wireMode: CreativeFormatWireMode = 'canonical',
  operation: 'create_media_buy' | 'update_media_buy' = 'create_media_buy',
  legacyFormatConverter?: LegacyFormatConverter,
  canonicalFormatLegacyResolver?: CanonicalFormatLegacyResolver
): ProjectedMediaBuyCreativeRequest<T, 'canonical'> | ProjectedMediaBuyCreativeRequest<T, 'legacy'> {
  const requestRecord = record(request);
  if (!requestRecord) return request as ProjectedMediaBuyCreativeRequest<T, 'canonical'>;
  let changed = false;
  const next = { ...requestRecord };
  for (const key of ['packages', 'new_packages'] as const) {
    const packages = requestRecord[key];
    if (!Array.isArray(packages)) continue;
    next[key] = packages.map(packageValue => {
      const pkg = record(packageValue);
      if (!pkg) return packageValue;
      const creatives = Array.isArray(pkg.creatives)
        ? pkg.creatives.map(creativeValue => {
            const creative = record(creativeValue);
            if (!creative) return creativeValue;
            const projected = projectCreativeForDelivery(
              creative as unknown as CreativeAsset,
              pkg as CreativeFormatSelectorContainer,
              wireMode,
              operation,
              legacyFormatConverter,
              canonicalFormatLegacyResolver
            );
            if (projected !== creativeValue) changed = true;
            return projected;
          })
        : undefined;
      const projectedPackage = projectPackageSelectors(
        pkg,
        wireMode,
        operation,
        legacyFormatConverter,
        canonicalFormatLegacyResolver
      );
      if (projectedPackage !== packageValue) changed = true;
      return creatives ? { ...projectedPackage, creatives } : projectedPackage;
    });
  }
  return (changed ? next : request) as
    | ProjectedMediaBuyCreativeRequest<T, 'canonical'>
    | ProjectedMediaBuyCreativeRequest<T, 'legacy'>;
}

export function projectSyncCreativesForDelivery<T>(
  request: T,
  selectorContainers: ReadonlyArray<CreativeFormatSelectorContainer>,
  wireMode: 'canonical',
  legacyFormatConverter?: LegacyFormatConverter,
  canonicalFormatLegacyResolver?: CanonicalFormatLegacyResolver
): ProjectedSyncCreativeRequest<T, 'canonical'>;
export function projectSyncCreativesForDelivery<T>(
  request: T,
  selectorContainers: ReadonlyArray<CreativeFormatSelectorContainer>,
  wireMode: 'legacy' | 'unknown',
  legacyFormatConverter?: LegacyFormatConverter,
  canonicalFormatLegacyResolver?: CanonicalFormatLegacyResolver
): ProjectedSyncCreativeRequest<T, 'legacy'>;
export function projectSyncCreativesForDelivery<T>(
  request: T,
  selectorContainers: ReadonlyArray<CreativeFormatSelectorContainer>,
  wireMode: CreativeFormatWireMode,
  legacyFormatConverter?: LegacyFormatConverter,
  canonicalFormatLegacyResolver?: CanonicalFormatLegacyResolver
): ProjectedSyncCreativeRequest<T, 'canonical'> | ProjectedSyncCreativeRequest<T, 'legacy'>;
export function projectSyncCreativesForDelivery<T>(
  request: T,
  selectorContainers: ReadonlyArray<CreativeFormatSelectorContainer>,
  wireMode: CreativeFormatWireMode = 'canonical',
  legacyFormatConverter?: LegacyFormatConverter,
  canonicalFormatLegacyResolver?: CanonicalFormatLegacyResolver
): ProjectedSyncCreativeRequest<T, 'canonical'> | ProjectedSyncCreativeRequest<T, 'legacy'> {
  const requestRecord = record(request);
  if (!requestRecord || !Array.isArray(requestRecord.creatives)) {
    return request as ProjectedSyncCreativeRequest<T, 'canonical'>;
  }
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
      selector_containers: relevant,
    };
    const projected = projectCreativeForDelivery(
      creative as unknown as CreativeAsset,
      combined,
      wireMode,
      'sync_creatives',
      legacyFormatConverter,
      canonicalFormatLegacyResolver
    );
    if (projected !== creativeValue) changed = true;
    return projected;
  });
  return (changed ? { ...requestRecord, creatives } : request) as
    | ProjectedSyncCreativeRequest<T, 'canonical'>
    | ProjectedSyncCreativeRequest<T, 'legacy'>;
}

type CreativeProtocolRelease = { major: number; minor: number; label: string };

function release(value: unknown): CreativeProtocolRelease | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^v?(\d+)\.(\d+)(?:\.|-|$)/.exec(value.trim());
  return match ? { major: Number(match[1]), minor: Number(match[2]), label: value } : undefined;
}

function mutuallyServedRelease(
  caps: Record<string, unknown> | undefined,
  raw: Record<string, unknown> | undefined,
  requestedVersion: string | undefined
): CreativeProtocolRelease | undefined {
  const requested = release(requestedVersion);
  if (!requested) return undefined;
  const normalizedSupported = Array.isArray(caps?.supportedVersions) ? caps.supportedVersions : [];
  const directSupported = record(caps?.adcp)?.supported_versions;
  const rawSupported = record(raw?.adcp)?.supported_versions;
  const advertisedValues = [
    ...normalizedSupported,
    ...(Array.isArray(directSupported) ? directSupported : []),
    ...(Array.isArray(rawSupported) ? rawSupported : []),
  ];
  const advertised = advertisedValues.flatMap(value => {
    const parsed = release(value);
    return parsed ? [parsed] : [];
  });
  if (advertisedValues.length > 0 && advertised.length === 0) {
    throw new CreativeFormatCapabilityError(
      'Seller advertised supported AdCP versions, but none were valid release identifiers'
    );
  }
  if (advertised.length === 0) {
    // A buyer pin is an upper bound, not evidence that the seller serves the
    // same release. Legacy 3.0 sellers commonly omit supported_versions; that
    // omission must not turn a 3.2 buyer pin into a false canonical guarantee.
    return requested.major < 3 || (requested.major === 3 && requested.minor === 0) ? requested : undefined;
  }
  const mutuallyServed = advertised
    .filter(
      candidate =>
        candidate.major === requested.major &&
        (candidate.minor < requested.minor || candidate.minor === requested.minor)
    )
    .sort((left, right) => right.minor - left.minor)[0];
  if (!mutuallyServed) {
    const supported = [...new Set(advertised.map(candidate => candidate.label))].join(', ');
    throw new CreativeFormatCapabilityError(
      `No mutually supported AdCP release: client requested ${requestedVersion}, seller advertised ${supported}`
    );
  }
  return mutuallyServed;
}

export function resolveCreativeFormatWireMode(
  capabilities: unknown,
  negotiatedVersion?: string
): CreativeFormatWireMode {
  const caps = record(capabilities);
  const raw = record(caps?._raw);
  const features = record(caps?.features);
  const mediaBuyFeatures = record(record(caps?.media_buy)?.features);
  const rawMediaBuyFeatures = record(record(raw?.media_buy)?.features);
  const declarations = [
    features?.canonicalCreatives,
    mediaBuyFeatures?.canonical_creatives,
    rawMediaBuyFeatures?.canonical_creatives,
  ].filter((value): value is boolean => typeof value === 'boolean');
  if (declarations.includes(true) && declarations.includes(false)) {
    throw new CreativeFormatCapabilityError(
      'Seller capability response contains conflicting canonical_creatives declarations'
    );
  }
  const explicitCanonical = declarations[0];
  // `supported_versions` is the seller's wire-release contract. A newer
  // buyer can be downshifted within the same major, so a 3.2 client talking
  // to a 3.1-only seller must apply the 3.1 feature semantics rather than
  // assuming the 3.2 canonical guarantee. `build_version` is intentionally
  // absent here: the capability schema marks it advisory-only.
  const negotiated = mutuallyServedRelease(caps, raw, negotiatedVersion);
  if (caps?.version === 'v2') return 'legacy';
  if (negotiated && (negotiated.major > 3 || (negotiated.major === 3 && negotiated.minor >= 2))) {
    if (explicitCanonical === false) {
      throw new CreativeFormatCapabilityError(
        `AdCP ${negotiated.label} guarantees canonical creatives, but the seller advertised canonical_creatives: false`
      );
    }
    return 'canonical';
  }
  if (negotiated && (negotiated.major < 3 || (negotiated.major === 3 && negotiated.minor === 0))) {
    return 'legacy';
  }
  if (!caps) return 'unknown';
  if (explicitCanonical === true) return 'canonical';
  if (explicitCanonical === false) return 'legacy';
  return 'unknown';
}
