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
  PreviewCreativeRequest,
  PreviewCreativeResponse,
  Product,
  SyncCreativesRequest,
  SyncCreativesResponse,
  UpdateMediaBuyRequest,
  UpdateMediaBuyResponse,
} from '../../types/tools.generated';
import {
  canonicalDeclarationFromBareId,
  migratedFormatOptionId,
  projectV1ProductToV2,
  resolveCanonicalFormatKind,
  withDualEmissionLegacyRefs,
} from './v1-to-v2';
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
import type { UndeclaredFormatOptionSelector } from './legacy-routes';
import { canonicalize as canonicalizeJson } from '../../utils/jcs';
import { lookupUniqueV1FormatById, lookupV1Format, type V1FormatDefinition } from './catalog';
import { canonicalizeAgentUrl } from '../../discovery/resolve-agent-properties';
import { isLikelyPrivateUrl } from '../../net/address-guards';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, Extract<keyof T, K>> : never;

/**
 * Primary SDK creative shape. Spell out the named fields rather than using
 * `Omit`: the generated 3.2 type intentionally has an extension index
 * signature, and `Omit` would collapse its named properties to `unknown`.
 * Legacy creative identity remains a wire-adapter concern.
 */
type CanonicalCreativeAssetFields = {
  creative_id: CreativeAsset['creative_id'];
  name: CreativeAsset['name'];
  format_kind: CanonicalFormatKind;
  format_option_ref?: CreativeAsset['format_option_ref'];
  format_id?: never;
  assets: CreativeAsset['assets'];
  inputs?: CreativeAsset['inputs'];
  tags?: CreativeAsset['tags'];
  status?: CreativeAsset['status'];
  weight?: CreativeAsset['weight'];
  placement_refs?: CreativeAsset['placement_refs'];
  placement_ids?: CreativeAsset['placement_ids'];
  industry_identifiers?: CreativeAsset['industry_identifiers'];
  provenance?: CreativeAsset['provenance'];
  rights?: CreativeAsset['rights'];
};

export type CanonicalCreativeAsset = CanonicalCreativeAssetFields & {
  [key: string]: unknown;
  /** Localization is accepted only by sync_creatives, never inline in packages. */
  localization?: never;
};

/** Canonical creative accepted by sync_creatives, including sync-only localization metadata. */
export type CanonicalSyncCreativeAsset = CanonicalCreativeAssetFields & {
  [key: string]: unknown;
  localization?: NonNullable<SyncCreativesRequest['creatives']>[number]['localization'];
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
> &
  import('../../supply-path/products').ProductSupplyPathAnnotation & {
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
type CanonicalReportingWebhook = NonNullable<CanonicalCreateMediaBuyRequest['reporting_webhook']>;
/**
 * Client-facing form of a wire reporting webhook `W`. Every field is optional:
 * the SDK can supply the callback `url`, `reporting_frequency` and the
 * `authentication` block from client configuration.
 *
 * `authentication` is optional even with a caller-supplied `url`. AdCP 3.3
 * makes it optional on the wire when the seller signs webhooks under its
 * profile (`webhook_signing.supported`), and the experimental 3.3 client sends
 * the registration without it once it has negotiated that. Below 3.3 the wire
 * still requires it: with `webhookUrlTemplate` configured the client throws
 * rather than send a caller URL without credentials (it never pairs its own
 * `webhookSecret` with a caller-controlled host), and request validation
 * reports the missing field otherwise.
 *
 * Derived from `W` rather than restating its fields, so it accepts every
 * reporting webhook the pinned schemas generate, whether they declare
 * `authentication` required (3.2) or optional (3.3).
 *
 * Exported for the type tests only; not re-exported from the package root.
 */
export type ClientReportingWebhookInputFor<W extends { url: string; reporting_frequency: unknown }> = Omit<
  W,
  'url' | 'authentication' | 'reporting_frequency'
> & {
  url?: W['url'];
  reporting_frequency?: W['reporting_frequency'];
  /** Atomic: `schemes` and `credentials` always come from the same source. */
  authentication?: W extends { authentication?: infer A } ? (unknown extends A ? never : A) : never;
};
type ClientReportingWebhookInput = ClientReportingWebhookInputFor<CanonicalReportingWebhook>;
/**
 * Client-facing create request. The SDK may supply the reporting callback URL
 * and its complete authentication block from client configuration; the wire
 * request remains a strict {@link CanonicalCreateMediaBuyRequest}.
 */
export type CanonicalCreateMediaBuyInput = Omit<CanonicalCreateMediaBuyRequest, 'reporting_webhook'> & {
  reporting_webhook?: ClientReportingWebhookInput & { signing_profile?: 'adcp/webhook-signing/v1' | 'web-bot-auth' };
};
export type CanonicalUpdateMediaBuyRequest = Omit<
  CanonicalCreativeResponse<UpdateMediaBuyRequest>,
  'packages' | 'new_packages'
> & {
  packages?: CanonicalPackageUpdate[];
  new_packages?: CanonicalPackageRequest[];
};
export type CanonicalSyncCreativesRequest = Omit<CanonicalCreativeResponse<SyncCreativesRequest>, 'creatives'> & {
  creatives: CanonicalSyncCreativeAsset[];
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

type PreviewInput = NonNullable<PreviewCreativeRequest['inputs']>[number];
type PreviewBatchItem = NonNullable<PreviewCreativeRequest['requests']>[number];

type CanonicalPreviewRenderOptions = {
  inputs?: CanonicalCreativeResponse<PreviewInput>[];
  template_id?: PreviewCreativeRequest['template_id'];
  quality?: PreviewCreativeRequest['quality'];
  output_format?: PreviewCreativeRequest['output_format'];
  item_limit?: PreviewCreativeRequest['item_limit'];
};

type CanonicalPreviewSource =
  | {
      creative_manifest: CanonicalCreativeResponse<NonNullable<PreviewCreativeRequest['creative_manifest']>>;
      creative_id?: never;
    }
  | {
      creative_id: NonNullable<PreviewCreativeRequest['creative_id']>;
      creative_manifest?: never;
    };

type CanonicalPreviewBatchSource =
  | {
      creative_manifest: CanonicalCreativeResponse<NonNullable<PreviewBatchItem['creative_manifest']>>;
      creative_id?: never;
    }
  | {
      creative_id: NonNullable<PreviewBatchItem['creative_id']>;
      creative_manifest?: never;
    };

type CanonicalPreviewCreativeBatchItem = CanonicalPreviewRenderOptions &
  CanonicalPreviewBatchSource & {
    target_capability_id?: PreviewBatchItem['target_capability_id'];
    format_id?: never;
  };

type CanonicalPreviewRequestEnvelope = Pick<PreviewCreativeRequest, 'adcp_version' | 'adcp_major_version'> & {
  allow_async?: PreviewCreativeRequest['allow_async'];
  push_notification_config?: PreviewCreativeRequest['push_notification_config'];
  context?: PreviewCreativeRequest['context'];
  ext?: PreviewCreativeRequest['ext'];
  format_id?: never;
};

/** Primary preview request: a strict canonical union with no named-format identity at any depth. */
export type CanonicalPreviewCreativeRequest = CanonicalPreviewRequestEnvelope &
  (
    | (CanonicalPreviewRenderOptions &
        CanonicalPreviewSource & {
          request_type: 'single';
          target_capability_id?: PreviewCreativeRequest['target_capability_id'];
          requests?: never;
          variant_id?: never;
        })
    | (CanonicalPreviewRenderOptions & {
        request_type: 'batch';
        target_capability_id?: PreviewCreativeRequest['target_capability_id'];
        requests: CanonicalPreviewCreativeBatchItem[];
        creative_manifest?: never;
        creative_id?: never;
        variant_id?: never;
      })
    | {
        request_type: 'variant';
        variant_id: NonNullable<PreviewCreativeRequest['variant_id']>;
        creative_id?: PreviewCreativeRequest['creative_id'];
        creative_manifest?: never;
        target_capability_id?: never;
        requests?: never;
      }
  );
export type CanonicalPreviewCreativeResponse = CanonicalCreativeResponse<PreviewCreativeResponse>;

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
  : T extends string | number | boolean | bigint | symbol | null | undefined
    ? T
    : T extends readonly unknown[]
      ? { [K in keyof T]: CanonicalCreativeResponse<T[K]> }
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
    'audio_vast',
    'audio_daast',
    'sponsored_placement',
    'native_in_feed',
    'responsive_creative',
    'agent_placement',
    'seller_rendered_stateful_display',
    'coordinated_placements',
    'custom',
  ]);
  // `_message` is SDK-synthesized prose (the seller's text part) that may echo
  // a legacy identity, so it is dropped from canonical output like the
  // structured identity keys. It is NOT an identity source, though: its value
  // is a whole sentence, and tokenizing it would mask every diagnostic that
  // repeats the seller's text (e.g. `adcp_error.message`) — see #3060.
  const identityValueKey = (key: string): boolean => /(^|_)(?:format_ids?|v1_format_ref)($|_)/.test(key);
  const creativeIdentityKey = (key: string): boolean => key === '_message' || identityValueKey(key);
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
      // `_message` falls through to the structural walk: a plain string yields
      // no tokens, while any nested identity field would still be collected.
      if (identityValueKey(key)) collectStrings(child);
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
  /** Target product, used to recover seller declarations after serializing selectors. */
  product_id?: string;
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
  'audio_vast',
  'audio_daast',
  'sponsored_placement',
  'native_in_feed',
  'responsive_creative',
  'agent_placement',
  'seller_rendered_stateful_display',
  'coordinated_placements',
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
  const nativeOptions = Array.isArray(container.format_options) ? container.format_options : [];
  const formatOptions = [...nativeOptions, ...selectedFormatOptions(container)];
  const resolvedOptions = formatOptions.map(optionValue => {
    const option = record(optionValue);
    if (!option) return optionValue;
    const formatKind = typeof option.format_kind === 'string' ? option.format_kind : undefined;
    const formatOptionRef = optionReference(option);
    let refs = [...legacyFormatRefsForDeclaration(option)];
    if (refs.length > 0) return optionValue;
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
    return refs.length > 0 ? { ...option, v1_format_ref: refs } : optionValue;
  });
  // Explicit resolver routes (including restored sidecars) precede index
  // inference and can disprove the alignment for the whole product.
  const pairedOptions = [
    ...withDualEmissionLegacyRefs(resolvedOptions.slice(0, nativeOptions.length), container.format_ids),
    ...resolvedOptions.slice(nativeOptions.length),
  ];
  for (const optionValue of pairedOptions) {
    const option = record(optionValue);
    if (!option) continue;
    const formatKind = typeof option.format_kind === 'string' ? option.format_kind : undefined;
    const formatOptionRef = optionReference(option);
    for (const ref of legacyFormatRefsForDeclaration(option)) {
      candidates.push({ ref, formatKind, formatOptionRef, selectorParams: option.params ?? container.params });
    }
  }
  const linkedRefs = new Set(candidates.map(candidate => candidateKey({ ref: candidate.ref })));
  const containerKind = typeof container.format_kind === 'string' ? container.format_kind : undefined;
  for (const key of ['format_ids', 'formats'] as const) {
    for (const ref of refsFromValue(container[key])) {
      // A linked option already represents this reference with richer selector
      // evidence. Adding a bare copy would make an unpinned creative ambiguous.
      if (linkedRefs.has(candidateKey({ ref }))) continue;
      candidates.push({
        ref,
        formatKind: resolveCanonicalFormatKind(ref.id) ?? containerKind,
        selectorParams: container.params,
      });
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

interface CreativeFormatParameterConstraints {
  width?: number;
  height?: number;
  durationMs?: number;
}

/**
 * Asset types whose rendered size AdCP 3.3 carries on the asset itself
 * (`zip`, `html`, `display_tag`). Used only when the creative has no
 * `format_parameters`; one unambiguous size, or nothing.
 */
const SELF_SIZED_ASSET_TYPES = new Set(['zip', 'html', 'display_tag']);

/** Every typed asset object on a creative, flattening repeatable slots. */
function creativeAssetRecords(creative: Record<string, unknown>): Record<string, unknown>[] {
  return Object.values(record(creative.assets) ?? {}).flatMap(value =>
    (Array.isArray(value) ? value : [value]).flatMap(item => (record(item) ? [record(item)!] : []))
  );
}

function assetRenderedSizes(creative: Record<string, unknown>): CreativeFormatParameterConstraints[] {
  const sizes = new Set<string>();
  for (const asset of creativeAssetRecords(creative)) {
    if (!SELF_SIZED_ASSET_TYPES.has(String(asset.asset_type))) continue;
    if (typeof asset.width === 'number' && typeof asset.height === 'number')
      sizes.add(`${asset.width}x${asset.height}`);
    for (const entry of Array.isArray(asset.sizes) ? asset.sizes : []) {
      const size = record(entry);
      if (typeof size?.width === 'number' && typeof size.height === 'number') {
        sizes.add(`${size.width}x${size.height}`);
      }
    }
  }
  return [...sizes].map(size => {
    const [width, height] = size.split('x').map(Number);
    return { width, height };
  });
}

function assetRenderedSize(creative: Record<string, unknown>): CreativeFormatParameterConstraints | undefined {
  const sizes = assetRenderedSizes(creative);
  return sizes.length === 1 ? sizes[0] : undefined;
}

function creativeFormatParameterConstraints(
  creative: Record<string, unknown>
): CreativeFormatParameterConstraints | undefined {
  const params = record(creative.format_parameters);
  if (!params) return assetRenderedSize(creative);
  const width = typeof params.width === 'number' ? params.width : undefined;
  const height = typeof params.height === 'number' ? params.height : undefined;
  const durationMs =
    typeof params.duration_ms === 'number'
      ? params.duration_ms
      : typeof params.duration_ms_exact === 'number'
        ? params.duration_ms_exact
        : undefined;
  if (width === undefined && height === undefined && durationMs === undefined) return undefined;
  return { width, height, durationMs };
}

function legacyRefParameterConstraints(ref: V1FormatId): CreativeFormatParameterConstraints {
  // Catalog dimensions fill missing constraints without changing the seller's wire reference.
  const params =
    typeof ref.width !== 'number' || typeof ref.height !== 'number'
      ? record(canonicalDeclarationFromBareId(ref.id, { agentUrl: ref.agent_url })?.params)
      : undefined;
  return {
    width: typeof ref.width === 'number' ? ref.width : typeof params?.width === 'number' ? params.width : undefined,
    height:
      typeof ref.height === 'number' ? ref.height : typeof params?.height === 'number' ? params.height : undefined,
    durationMs: ref.duration_ms,
  };
}

function refContradictsConstraints(ref: V1FormatId, constraints: CreativeFormatParameterConstraints): boolean {
  const refConstraints = legacyRefParameterConstraints(ref);
  if (
    constraints.width !== undefined &&
    refConstraints.width !== undefined &&
    refConstraints.width !== constraints.width
  ) {
    return true;
  }
  if (
    constraints.height !== undefined &&
    refConstraints.height !== undefined &&
    refConstraints.height !== constraints.height
  ) {
    return true;
  }
  if (
    constraints.durationMs !== undefined &&
    typeof refConstraints.durationMs === 'number' &&
    refConstraints.durationMs !== constraints.durationMs
  ) {
    return true;
  }
  return false;
}

function refPinsConstraints(ref: V1FormatId, constraints: CreativeFormatParameterConstraints): boolean {
  const refConstraints = legacyRefParameterConstraints(ref);
  if (constraints.width !== undefined && refConstraints.width === undefined) return false;
  if (constraints.height !== undefined && refConstraints.height === undefined) return false;
  if (constraints.durationMs !== undefined && typeof refConstraints.durationMs !== 'number') return false;
  return true;
}

function legacyIdPinsDimensions(ref: V1FormatId): boolean | undefined {
  const declaration = canonicalDeclarationFromBareId(ref.id, { agentUrl: ref.agent_url });
  if (!declaration) return undefined;
  const params = record(declaration.params) ?? {};
  return (
    typeof params.width === 'number' ||
    typeof params.height === 'number' ||
    typeof params.duration_ms_exact === 'number' ||
    Array.isArray(params.sizes)
  );
}

function refConstraintKey(ref: V1FormatId): string {
  const constraints = legacyRefParameterConstraints(ref);
  return [
    agentIdentity(ref.agent_url),
    constraints.width ?? '',
    constraints.height ?? '',
    constraints.durationMs ?? '',
  ].join('|');
}

/**
 * Delivery types a `display_tag` creative uses: a display-tag asset's
 * `delivery_type`, or `tag_url` for a backward-compatible ad-request `url`.
 */
function creativeDisplayTagDeliveryTypes(creative: Record<string, unknown>): Set<string> | undefined {
  if (creative.format_kind !== 'display_tag') return undefined;
  const types = new Set<string>();
  for (const asset of creativeAssetRecords(creative)) {
    if (asset.asset_type === 'display_tag' && typeof asset.delivery_type === 'string') types.add(asset.delivery_type);
    else if (asset.asset_type === 'url' && asset.url_type === 'ad_request') types.add('tag_url');
  }
  return types.size > 0 ? types : undefined;
}

/**
 * Delivery types a `display_tag` legacy candidate accepts: the seller's
 * declaration, else the catalog-backed declaration for the legacy id, else the
 * canonical's `tag_url` default.
 */
function candidateDeliveryTypes(candidate: LegacyCandidate): unknown[] {
  const declared = record(candidate.selectorParams)?.supported_delivery_types;
  if (Array.isArray(declared)) return declared;
  const catalog = record(
    canonicalDeclarationFromBareId(candidate.ref.id, { agentUrl: candidate.ref.agent_url })?.params
  )?.supported_delivery_types;
  return Array.isArray(catalog) ? catalog : ['tag_url'];
}

/**
 * Most-constrained-wins for a canonical creative facing several legacy refs of
 * its kind. A `display_tag` creative first drops refs that do not accept its
 * delivery type (an inline-markup tag never matches a URL-only `display_js`). Compare explicit dimensions or the catalog-backed ID's dimensions
 * with the creative's own `format_parameters`. Drop contradictory refs,
 * prefer refs that pin them, and among refs imposing identical constraints (a
 * seller listing `display_html` at 300x250 next to `display_300x250_html`)
 * prefer the legacy id whose own declaration pins that size over a generic
 * parametrized id. No compatible ref, or refs that still differ in their
 * constraints, leave the caller failing closed.
 */
function preferMostConstrainedLegacyCandidates(
  candidates: LegacyCandidate[],
  creative: Record<string, unknown>
): LegacyCandidate[] {
  let remaining = candidates;
  const deliveryTypes = creativeDisplayTagDeliveryTypes(creative);
  if (deliveryTypes) {
    remaining = remaining.filter(candidate => {
      const accepted = candidateDeliveryTypes(candidate);
      return [...deliveryTypes].every(type => accepted.includes(type));
    });
  }
  if (!record(creative.format_parameters)) {
    const supportedSizes = assetRenderedSizes(creative);
    if (supportedSizes.length > 1)
      remaining = remaining.filter(candidate =>
        supportedSizes.some(size => !refContradictsConstraints(candidate.ref, size))
      );
  }
  const constraints = creativeFormatParameterConstraints(creative);
  if (constraints) {
    remaining = remaining.filter(candidate => !refContradictsConstraints(candidate.ref, constraints));
    const pinned = remaining.filter(candidate => refPinsConstraints(candidate.ref, constraints));
    if (pinned.length > 0) remaining = pinned;
  }
  if (remaining.length <= 1) return remaining;
  const constraintKeys = new Set(remaining.map(candidate => refConstraintKey(candidate.ref)));
  if (constraintKeys.size !== 1) return remaining;
  const specific = remaining.filter(candidate => legacyIdPinsDimensions(candidate.ref) === true);
  return specific.length > 0 && specific.length < remaining.length ? specific : remaining;
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
    // A legacy-only container carries bare legacy refs whose synthetic option
    // ids were minted from the same tuple at discovery time, so a pin can still
    // be matched exactly by re-deriving that id.
    candidates = candidates.filter(candidate =>
      candidate.formatOptionRef
        ? sameOptionReference(candidate.formatOptionRef, creativeOptionRef)
        : migratedFormatOptionId(candidate.ref) === creativeOptionRef.format_option_id
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
  matching = preferMostConstrainedLegacyCandidates(matching, creative);
  return matching.length === 1 ? matching[0]!.ref : undefined;
}

function projectLegacyAssetKeys(assetsValue: unknown, definition: V1FormatDefinition | undefined): unknown {
  const assets = record(assetsValue);
  if (!assets || !Array.isArray(definition?.assets)) return assetsValue;
  const slots = definition.assets.filter(slot => record(slot) !== undefined);
  // Group membership needs a separate mapping contract; never flatten it into
  // a standalone slot just because the asset types happen to agree.
  if (slots.some(slot => slot.item_type !== undefined && slot.item_type !== 'individual')) return assetsValue;
  const declaredIds = new Set(slots.map(slot => slot.asset_id));
  const availableSlots = slots.filter(
    slot =>
      (slot.item_type === undefined || slot.item_type === 'individual') &&
      typeof slot.asset_id === 'string' &&
      slot.asset_id.length > 0 &&
      !Object.hasOwn(assets, slot.asset_id)
  );
  const targetBySource = new Map<string, string>();
  const sourcesByTarget = new Map<string, string[]>();
  for (const [key, value] of Object.entries(assets)) {
    if (declaredIds.has(key)) continue;
    const asset = record(value);
    if (!asset || typeof asset.asset_type !== 'string') continue;
    const matches = availableSlots.filter(slot => {
      if (slot.asset_type !== asset.asset_type) return false;
      if (asset.asset_type === 'url') {
        return typeof asset.url_type === 'string' && asset.url_type === slot.requirements?.url_type;
      }
      if (asset.asset_type === 'pixel_tracker') {
        return (
          typeof asset.event === 'string' &&
          asset.event === slot.event &&
          (asset.event !== 'custom' ||
            (typeof asset.custom_event_name === 'string' && asset.custom_event_name === slot.custom_event_name))
        );
      }
      return true;
    });
    if (matches.length !== 1) continue;
    const target = matches[0]!.asset_id!;
    targetBySource.set(key, target);
    const sources = sourcesByTarget.get(target) ?? [];
    sources.push(key);
    sourcesByTarget.set(target, sources);
  }
  // Resolve against the original keys. Two assets competing for one slot must
  // both survive, and object insertion order must never choose a winner.
  for (const sources of sourcesByTarget.values()) {
    if (sources.length > 1) for (const source of sources) targetBySource.delete(source);
  }
  if (targetBySource.size === 0) return assetsValue;
  return Object.fromEntries(Object.entries(assets).map(([key, value]) => [targetBySource.get(key) ?? key, value]));
}

/**
 * Legacy HTML-markup formats (`display_html`, `display_WxH_html`) take markup
 * as an `html` asset; canonically it is a `display_tag` inline-markup asset
 * (adcontextprotocol/adcp#8339). Carry the bytes into the legacy `content`.
 * `delivery_type` and `markup_type` have no legacy field; declared macros must be refused.
 */
function renderedSizeFields(asset: Record<string, unknown>): Record<string, unknown> {
  // The 3.3 schema makes fixed dimensions and responsive sizes exclusive.
  // Historical assets can carry both; explicit dimensions take precedence.
  if (asset.width !== undefined || asset.height !== undefined)
    return {
      ...(asset.width !== undefined && { width: asset.width }),
      ...(asset.height !== undefined && { height: asset.height }),
    };
  return asset.sizes !== undefined ? { sizes: asset.sizes } : {};
}

function projectInlineMarkupToLegacyHtml(
  assetsValue: unknown,
  definition: V1FormatDefinition | undefined,
  operation: string,
  creativeId: string
): unknown {
  const assets = record(assetsValue);
  if (!assets || !Array.isArray(definition?.assets)) return assetsValue;
  const slots = definition.assets.filter(slot => record(slot) !== undefined);
  if (!slots.some(slot => slot.asset_type === 'html') || slots.some(slot => slot.asset_type === 'display_tag')) {
    return assetsValue;
  }
  let changed = false;
  const next = Object.fromEntries(
    Object.entries(assets).map(([key, value]) => {
      const asset = record(value);
      if (asset?.asset_type !== 'display_tag' || asset.delivery_type !== 'inline_markup') return [key, value];
      if (typeof asset.markup !== 'string') return [key, value];
      if (asset.macro_declarations !== undefined) {
        throw new CreativeFormatProjectionError(
          operation,
          creativeId,
          'legacy HTML cannot preserve macro_declarations; use canonical display_tag delivery for declared macros'
        );
      }
      changed = true;
      return [
        key,
        {
          asset_type: 'html',
          content: asset.markup,
          // Rendered dimensions select the legacy ref; they are not part of
          // the legacy HTML asset contract (introduced only in AdCP 3.3).
          ...(asset.provenance !== undefined && { provenance: asset.provenance }),
        },
      ];
    })
  );
  return changed ? next : assetsValue;
}

/** Slot ids a declaration fills with inline-markup `display_tag` assets. */
function inlineMarkupSlotIds(paramsValue: unknown): Set<string> {
  const params = record(paramsValue);
  const types = Array.isArray(params?.supported_delivery_types) ? params.supported_delivery_types : [];
  if (!types.includes('inline_markup') || !Array.isArray(params?.slots)) return new Set();
  return new Set(
    params.slots.flatMap(value => {
      const slot = record(value);
      return slot?.asset_type === 'display_tag' && typeof slot.asset_group_id === 'string' ? [slot.asset_group_id] : [];
    })
  );
}

/**
 * Legacy `html` markup read into an inline-markup `display_tag` slot, using
 * the `standard` default specified by adcontextprotocol/adcp#8357.
 */
function legacyHtmlToInlineMarkup(creative: Record<string, unknown>, paramsValue: unknown): void {
  const assets = record(creative.assets);
  const slotIds = inlineMarkupSlotIds(paramsValue);
  if (!assets || slotIds.size === 0) return;
  let changed = false;
  const next = Object.fromEntries(
    Object.entries(assets).map(([key, value]) => {
      const asset = record(value);
      if (!slotIds.has(key) || asset?.asset_type !== 'html' || typeof asset.content !== 'string') return [key, value];
      changed = true;
      return [
        key,
        {
          asset_type: 'display_tag',
          delivery_type: 'inline_markup',
          markup_type: 'standard',
          markup: asset.content,
          ...renderedSizeFields(asset),
          ...(asset.provenance !== undefined && { provenance: asset.provenance }),
        },
      ];
    })
  );
  if (changed) creative.assets = next;
}

function projectCreative<T extends Record<string, unknown>>(
  creative: T,
  formatId: V1FormatId,
  legacyFormatDefinitions?: readonly V1FormatDefinition[],
  operation = 'creative_delivery'
): T {
  const next: Record<string, unknown> = { ...creative };
  delete next.format_kind;
  delete next.format_option_ref;
  next.format_id = { ...formatId };
  const supplied = legacyFormatDefinitions?.filter(definition => {
    const ref = legacyRef(record(definition)?.format_id);
    return ref !== undefined && sameLegacyIdentity(ref, formatId);
  });
  const definition = supplied?.length ? (supplied.length === 1 ? supplied[0] : undefined) : lookupV1Format(formatId);
  let markupDefinition = definition;
  if (!markupDefinition && !supplied?.length && creative.format_kind === 'display_tag') {
    // Use the same guarded AAO-id alias as discovery, while keeping the
    // seller's original owner tuple on the emitted legacy format_id.
    const canonicalAgentUrl = canonicalizeAgentUrl(formatId.agent_url);
    if (
      canonicalAgentUrl !== null &&
      new URL(canonicalAgentUrl).protocol === 'https:' &&
      !isLikelyPrivateUrl(canonicalAgentUrl)
    ) {
      markupDefinition = lookupUniqueV1FormatById(formatId.id);
    }
  }
  if (Object.hasOwn(creative, 'assets')) {
    // A bare-id alias can establish markup representation, but only an exact
    // or caller-supplied definition establishes the seller's asset slot IDs.
    next.assets = projectLegacyAssetKeys(
      projectInlineMarkupToLegacyHtml(
        creative.assets,
        markupDefinition,
        operation,
        typeof creative.creative_id === 'string' ? creative.creative_id : '(unknown)'
      ),
      definition
    );
  }
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
          // Cannot convert this package's legacy format_ids to canonical format_option_refs.
          // Return the package unchanged rather than throwing so responses for existing
          // buys remain usable. These buys were created before canonical format_option_refs
          // were enforced at write time.
          return next;
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
        delete next.params;
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
    delete next.params;
  }

  return next;
}

function canonicalizeCreative<T extends Record<string, unknown>>(
  creative: T,
  selectorContainer: CreativeFormatSelectorContainer,
  operation: string,
  legacyFormatConverter?: LegacyFormatConverter,
  convertLegacyMarkup = false
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
    if (convertLegacyMarkup && candidate.formatKind === 'display_tag') {
      const declared = record(candidate.selectorParams);
      const types = declared?.supported_delivery_types;
      if (!Array.isArray(types) || types.includes('inline_markup')) {
        legacyHtmlToInlineMarkup(
          next,
          Array.isArray(declared?.slots)
            ? candidate.selectorParams
            : canonicalDeclarationFromBareId(existing.id, { agentUrl: existing.agent_url })?.params
        );
      }
    }
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
  if (convertLegacyMarkup) legacyHtmlToInlineMarkup(next, declaration.params);
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

/**
 * Project identity and asset keys for the selected wire mode. Optional
 * `legacyFormatDefinitions` override bundled definitions by exact format owner
 * and ID; ambiguous definitions leave asset keys unchanged.
 */
export function projectCreativeForDelivery<T extends CreativeAsset>(
  creative: T,
  selectorContainer: CreativeFormatSelectorContainer,
  wireMode?: 'canonical',
  operation?: string,
  legacyFormatConverter?: LegacyFormatConverter,
  canonicalFormatLegacyResolver?: CanonicalFormatLegacyResolver,
  legacyFormatDefinitions?: readonly V1FormatDefinition[]
): CanonicalProjectedCreative<T>;
export function projectCreativeForDelivery<T extends CreativeAsset>(
  creative: T,
  selectorContainer: CreativeFormatSelectorContainer,
  wireMode: 'legacy' | 'unknown',
  operation?: string,
  legacyFormatConverter?: LegacyFormatConverter,
  canonicalFormatLegacyResolver?: CanonicalFormatLegacyResolver,
  legacyFormatDefinitions?: readonly V1FormatDefinition[]
): LegacyProjectedCreative<T>;
export function projectCreativeForDelivery<T extends CreativeAsset>(
  creative: T,
  selectorContainer: CreativeFormatSelectorContainer,
  wireMode: CreativeFormatWireMode,
  operation?: string,
  legacyFormatConverter?: LegacyFormatConverter,
  canonicalFormatLegacyResolver?: CanonicalFormatLegacyResolver,
  legacyFormatDefinitions?: readonly V1FormatDefinition[]
): CanonicalProjectedCreative<T> | LegacyProjectedCreative<T>;
export function projectCreativeForDelivery<T extends CreativeAsset>(
  creative: T,
  selectorContainer: CreativeFormatSelectorContainer,
  wireMode: CreativeFormatWireMode = 'canonical',
  operation = 'creative_delivery',
  legacyFormatConverter?: LegacyFormatConverter,
  canonicalFormatLegacyResolver?: CanonicalFormatLegacyResolver,
  legacyFormatDefinitions?: readonly V1FormatDefinition[]
): CanonicalProjectedCreative<T> | LegacyProjectedCreative<T> {
  const inputRecord = creative as unknown as Record<string, unknown>;
  const originalLegacyRef = legacyRef(inputRecord.format_id);
  const creativeRecord = canonicalizeCreative(
    inputRecord,
    selectorContainer,
    operation,
    legacyFormatConverter,
    wireMode === 'canonical'
  );
  if (wireMode === 'canonical') return creativeRecord as unknown as CanonicalProjectedCreative<T>;
  if (originalLegacyRef) {
    const selectedOriginal = selectLegacyRef(inputRecord, selectorContainer, canonicalFormatLegacyResolver, operation);
    if (selectedOriginal) {
      return projectCreative(
        creativeRecord,
        selectedOriginal,
        legacyFormatDefinitions,
        operation
      ) as unknown as LegacyProjectedCreative<T>;
    }
    throw new CreativeFormatProjectionError(
      operation,
      typeof inputRecord.creative_id === 'string' ? inputRecord.creative_id : '(unknown)',
      'the original legacy format reference conflicts with the selected seller format identity or constraints'
    );
  }
  const formatId = selectLegacyRef(creativeRecord, selectorContainer, canonicalFormatLegacyResolver, operation);
  if (formatId)
    return projectCreative(
      creativeRecord,
      formatId,
      legacyFormatDefinitions,
      operation
    ) as unknown as LegacyProjectedCreative<T>;

  if (typeof creativeRecord.format_kind === 'string') {
    const creativeId = typeof creativeRecord.creative_id === 'string' ? creativeRecord.creative_id : '(unknown)';
    const allCandidates = candidatesFromContainer(selectorContainer, canonicalFormatLegacyResolver, operation);
    let candidates = allCandidates.filter(candidate => candidate.formatKind === creativeRecord.format_kind);
    const constrained = candidates.filter(candidate => refMatchesParams(candidate.ref, selectorContainer.params));
    if (constrained.length > 0) candidates = constrained;
    candidates = preferMostConstrainedLegacyCandidates(candidates, creativeRecord);
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
    if (resolved)
      return projectCreative(
        creativeRecord,
        resolved[0]!,
        legacyFormatDefinitions,
        operation
      ) as unknown as LegacyProjectedCreative<T>;
    const pinned = optionReference(creativeRecord.format_option_ref) !== undefined;
    if (candidates.length === 1 && !pinned) {
      return projectCreative(
        creativeRecord,
        candidates[0]!.ref,
        legacyFormatDefinitions,
        operation
      ) as unknown as LegacyProjectedCreative<T>;
    }
    if (candidates.length > 1) {
      throw new CreativeFormatProjectionError(
        operation,
        creativeId,
        `the seller advertised ${candidates.length} legacy refs for canonical kind ${creativeRecord.format_kind}` +
          (candidates.some(candidate => legacyIdPinsDimensions(candidate.ref) === true)
            ? '; set format_parameters.width/height or give the asset one rendered width/height to select one'
            : '')
      );
    }
    const reason = pinned
      ? 'the creative is pinned to a format option that names none of the selected seller product legacy format references'
      : describeUnmatchedLegacyCandidates(creativeRecord, allCandidates);
    throw new CreativeFormatProjectionError(operation, creativeId, reason);
  }
  return creative as unknown as LegacyProjectedCreative<T>;
}

/**
 * Why no legacy ref of the creative's canonical kind survived selection. Error
 * text only: selection itself is unchanged. The checks mirror
 * preferMostConstrainedLegacyCandidates, in order: kind, delivery type, size.
 */
function describeUnmatchedLegacyCandidates(
  creative: Record<string, unknown>,
  allCandidates: readonly LegacyCandidate[]
): string {
  const generic = 'the selected seller product did not provide one unambiguous legacy format reference';
  const kind = String(creative.format_kind);
  if (allCandidates.length === 0) return generic;
  const sameKind = allCandidates.filter(candidate => candidate.formatKind === kind);
  if (sameKind.length === 0) {
    const offered = [
      ...new Set(allCandidates.flatMap(candidate => (candidate.formatKind ? [candidate.formatKind] : []))),
    ];
    if (offered.length === 0) return generic;
    const htmlMarkupHint =
      kind === 'html5' && offered.includes('display_tag')
        ? '. HTML-markup formats (display_html, display_WxH_html) take display_tag inline markup since SDK 17; send HTML snippets as a display_tag asset with delivery_type inline_markup (docs/migration-16-to-17.md)'
        : '';
    return `the selected seller product offers legacy refs for canonical kind ${offered.join(', ')}, not ${kind}${htmlMarkupHint}`;
  }
  const deliveryTypes = creativeDisplayTagDeliveryTypes(creative);
  if (deliveryTypes) {
    const accepting = sameKind.filter(candidate => {
      const accepted = candidateDeliveryTypes(candidate);
      return [...deliveryTypes].every(type => accepted.includes(type));
    });
    if (accepting.length === 0) {
      const accepted = [...new Set(sameKind.flatMap(candidate => candidateDeliveryTypes(candidate).map(String)))];
      return `none of the seller's ${sameKind.length} ${kind} legacy refs accepts delivery_type ${[...deliveryTypes].join(', ')} (they accept ${accepted.join(', ')})`;
    }
  }
  const size = creativeFormatParameterConstraints(creative);
  if (size?.width !== undefined && size.height !== undefined) {
    return `none of the seller's ${sameKind.length} ${kind} legacy refs matches the creative's ${size.width}x${size.height} size`;
  }
  return generic;
}

export function projectMediaBuyCreativesForDelivery<T>(
  request: T,
  wireMode: 'canonical',
  operation?: 'create_media_buy' | 'update_media_buy',
  legacyFormatConverter?: LegacyFormatConverter,
  canonicalFormatLegacyResolver?: CanonicalFormatLegacyResolver,
  legacyFormatDefinitions?: readonly V1FormatDefinition[]
): ProjectedMediaBuyCreativeRequest<T, 'canonical'>;
export function projectMediaBuyCreativesForDelivery<T>(
  request: T,
  wireMode: 'legacy' | 'unknown',
  operation?: 'create_media_buy' | 'update_media_buy',
  legacyFormatConverter?: LegacyFormatConverter,
  canonicalFormatLegacyResolver?: CanonicalFormatLegacyResolver,
  legacyFormatDefinitions?: readonly V1FormatDefinition[]
): ProjectedMediaBuyCreativeRequest<T, 'legacy'>;
export function projectMediaBuyCreativesForDelivery<T>(
  request: T,
  wireMode: CreativeFormatWireMode,
  operation?: 'create_media_buy' | 'update_media_buy',
  legacyFormatConverter?: LegacyFormatConverter,
  canonicalFormatLegacyResolver?: CanonicalFormatLegacyResolver,
  legacyFormatDefinitions?: readonly V1FormatDefinition[]
): ProjectedMediaBuyCreativeRequest<T, 'canonical'> | ProjectedMediaBuyCreativeRequest<T, 'legacy'>;
export function projectMediaBuyCreativesForDelivery<T>(
  request: T,
  wireMode: CreativeFormatWireMode = 'canonical',
  operation: 'create_media_buy' | 'update_media_buy' = 'create_media_buy',
  legacyFormatConverter?: LegacyFormatConverter,
  canonicalFormatLegacyResolver?: CanonicalFormatLegacyResolver,
  legacyFormatDefinitions?: readonly V1FormatDefinition[]
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
              canonicalFormatLegacyResolver,
              legacyFormatDefinitions
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
  canonicalFormatLegacyResolver?: CanonicalFormatLegacyResolver,
  legacyFormatDefinitions?: readonly V1FormatDefinition[]
): ProjectedSyncCreativeRequest<T, 'canonical'>;
export function projectSyncCreativesForDelivery<T>(
  request: T,
  selectorContainers: ReadonlyArray<CreativeFormatSelectorContainer>,
  wireMode: 'legacy' | 'unknown',
  legacyFormatConverter?: LegacyFormatConverter,
  canonicalFormatLegacyResolver?: CanonicalFormatLegacyResolver,
  legacyFormatDefinitions?: readonly V1FormatDefinition[]
): ProjectedSyncCreativeRequest<T, 'legacy'>;
export function projectSyncCreativesForDelivery<T>(
  request: T,
  selectorContainers: ReadonlyArray<CreativeFormatSelectorContainer>,
  wireMode: CreativeFormatWireMode,
  legacyFormatConverter?: LegacyFormatConverter,
  canonicalFormatLegacyResolver?: CanonicalFormatLegacyResolver,
  legacyFormatDefinitions?: readonly V1FormatDefinition[]
): ProjectedSyncCreativeRequest<T, 'canonical'> | ProjectedSyncCreativeRequest<T, 'legacy'>;
export function projectSyncCreativesForDelivery<T>(
  request: T,
  selectorContainers: ReadonlyArray<CreativeFormatSelectorContainer>,
  wireMode: CreativeFormatWireMode = 'canonical',
  legacyFormatConverter?: LegacyFormatConverter,
  canonicalFormatLegacyResolver?: CanonicalFormatLegacyResolver,
  legacyFormatDefinitions?: readonly V1FormatDefinition[]
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
      canonicalFormatLegacyResolver,
      legacyFormatDefinitions
    );
    if (projected !== creativeValue) changed = true;
    return projected;
  });
  return (changed ? { ...requestRecord, creatives } : request) as
    | ProjectedSyncCreativeRequest<T, 'canonical'>
    | ProjectedSyncCreativeRequest<T, 'legacy'>;
}

export type { UndeclaredFormatOptionSelector } from './legacy-routes';

/**
 * Looks up a format option the SDK derived from a seller's legacy `format_ids`.
 * Returns undefined for options the seller declared in its own `format_options[]`.
 */
export type UndeclaredFormatOptionLookup = (
  ref: FormatOptionReference,
  productId: string | undefined
) => UndeclaredFormatOptionSelector | undefined;

function stripUndeclaredCreativeOptionRef(
  creativeValue: unknown,
  productId: string | undefined,
  operation: string,
  lookup: UndeclaredFormatOptionLookup
): unknown {
  const creative = record(creativeValue);
  const ref = creative ? optionReference(creative.format_option_ref) : undefined;
  if (!creative || !ref) return creativeValue;
  const selector = lookup(ref, productId);
  if (!selector) return creativeValue;
  if (selector.unrepresentable || creative.format_kind === 'custom') {
    throw new CreativeFormatProjectionError(
      operation,
      typeof creative.creative_id === 'string' ? creative.creative_id : '(unknown)',
      'the seller did not declare this format option and its schema identity cannot be expressed without a seller-declared format_option_ref'
    );
  }
  const next: Record<string, unknown> = { ...creative };
  delete next.format_option_ref;
  return next;
}

function directSelectorForUndeclaredOptions(
  pkg: Record<string, unknown>,
  operation: string,
  lookup: UndeclaredFormatOptionLookup
): Record<string, unknown> {
  const refs = Array.isArray(pkg.format_option_refs)
    ? pkg.format_option_refs.flatMap(value => {
        const ref = optionReference(value);
        return ref ? [ref] : [];
      })
    : [];
  const productId = typeof pkg.product_id === 'string' ? pkg.product_id : undefined;
  const selectors = refs.map(ref => lookup(ref, productId));
  if (!selectors.some(selector => selector !== undefined)) return pkg;
  if (
    refs.length !== (pkg.format_option_refs as unknown[]).length ||
    selectors.some(selector => selector?.unrepresentable)
  ) {
    throw new CreativeFormatProjectionError(
      operation,
      '(package selector)',
      'the selected undeclared format options cannot be expressed as a direct selector; custom formats require a seller-declared format option'
    );
  }
  const distinct = [
    ...new Map(
      selectors.map(selector => [
        selector ? canonicalizeJson({ format_kind: selector.format_kind, params: selector.params ?? null }) : '',
        selector,
      ])
    ).values(),
  ];
  const selector = distinct.length === 1 ? distinct[0] : undefined;
  if (!selector || pkg.format_kind !== undefined || pkg.params !== undefined) {
    throw new CreativeFormatProjectionError(
      operation,
      '(package selector)',
      'the seller did not declare the selected format options in its product format_options; select options that one format_kind + params selector can express'
    );
  }
  const next: Record<string, unknown> = { ...pkg, format_kind: selector.format_kind };
  delete next.format_option_refs;
  if (selector.params !== undefined) next.params = structuredClone(selector.params);
  return next;
}

/**
 * Canonical-wire counterpart to legacy downgrade for format options the seller
 * never declared. AdCP 3.x products may carry only legacy `format_ids`; the SDK
 * upgrades them for the buyer and mints the option ids itself. A seller only
 * resolves `format_option_refs` against its own `format_options[]`, so a
 * package selecting such options is sent as the equivalent `format_kind` +
 * `params` selector, and creative pins to them are dropped. A selection that
 * one direct selector cannot express fails closed before dispatch.
 */
export function projectUndeclaredFormatOptionSelectors<T>(
  request: T,
  operation: 'create_media_buy' | 'update_media_buy' | 'sync_creatives',
  lookup: UndeclaredFormatOptionLookup
): T {
  const requestRecord = record(request);
  if (!requestRecord) return request;
  let changed = false;
  const next: Record<string, unknown> = { ...requestRecord };
  for (const key of ['packages', 'new_packages'] as const) {
    const packages = requestRecord[key];
    if (!Array.isArray(packages)) continue;
    next[key] = packages.map(packageValue => {
      const pkg = record(packageValue);
      if (!pkg) return packageValue;
      const productId = typeof pkg.product_id === 'string' ? pkg.product_id : undefined;
      let projected = directSelectorForUndeclaredOptions(pkg, operation, lookup);
      if (Array.isArray(pkg.creatives)) {
        const creatives = pkg.creatives.map(creative =>
          stripUndeclaredCreativeOptionRef(creative, productId, operation, lookup)
        );
        if (creatives.some((creative, index) => creative !== (pkg.creatives as unknown[])[index])) {
          projected = { ...projected, creatives };
        }
      }
      if (projected !== pkg) changed = true;
      return projected;
    });
  }
  if (Array.isArray(requestRecord.creatives)) {
    const creatives = requestRecord.creatives.map(creative =>
      stripUndeclaredCreativeOptionRef(creative, undefined, operation, lookup)
    );
    if (creatives.some((creative, index) => creative !== (requestRecord.creatives as unknown[])[index])) {
      next.creatives = creatives;
      changed = true;
    }
  }
  return (changed ? next : request) as T;
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

/** @internal Product acceptance can refine an unknown wire decision only for a proven 3.1 peer. */
export function canUseProductOptionsForCreativeWire(capabilities: unknown, requestedVersion: string): boolean {
  const caps = record(capabilities);
  const negotiated = mutuallyServedRelease(caps, record(caps?._raw), requestedVersion);
  return negotiated?.major === 3 && negotiated.minor === 1;
}
