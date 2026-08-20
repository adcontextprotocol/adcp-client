import { createHash, randomBytes } from 'node:crypto';
import type { AgentClient, CanonicalProjectionTaskOptions, ProposalRefinementTaskOptions } from '../core/AgentClient';
import type {
  InputHandler,
  TaskOptions,
  TaskResult,
  TaskResultCompleted,
  TaskResultFailure,
  TaskResultIntermediate,
} from '../core/ConversationTypes';
import { generateIdempotencyKey, isValidIdempotencyKey, type MutatingRequestInput } from '../utils/idempotency';
import { canonicalize } from '../utils/jcs';
import { assertValidIdempotencyReplayTtlSeconds, type AdcpCapabilities } from '../utils/capabilities';
import { TOOL_REQUEST_SCHEMAS } from '../utils/tool-request-schemas';
import type {
  AcceptProposalRequest,
  AcceptProposalResponse,
  BuyProductsRequest,
  BuyProductsResponse,
  CanonicalProduct,
  CanonicalProposal,
  ControlMediaBuyRequest,
  ControlMediaBuyResponse,
  CreateMediaBuyResponse,
  DeclineProposalsRequest,
  DeclineProposalsResponse,
  GetProductsResponse,
  GetMediaBuyDeliveryRequest,
  GetMediaBuyDeliveryResponse,
  GetMediaBuysRequest,
  GetMediaBuysResponse,
  ListProductsRequest,
  ListProductsResponse,
  Product,
  Proposal,
  RefineProposalsResponse,
  RequestProposalsRequest,
  RequestProposalsResponse,
  UpdateMediaBuyResponse,
} from '../types/tools.generated';
import type {
  CanonicalCreateMediaBuyRequest,
  CanonicalGetProductsRequest,
  CanonicalUpdateMediaBuyRequest,
} from '../v2/projection/creative-delivery';
import type { RefineProposalsInput } from '../negotiation/types';
import {
  assertRefineProposalsResponse,
  isStrictDateTime,
  proposalTermsDigest,
  validateRefineProposalsResponseShape,
} from '../negotiation/verification';
import { isAdcpOperationSuccess } from '../utils/response-unwrapper';
import { ConfigurationError } from '../errors';
import { formatIssues, validateResponse } from '../validation/schema-validator';

export type MediaBuyLifecycle = 'compact' | 'established';
export type MediaBuyCompatibility = 'native' | 'lossless_projection' | 'lossy_projection';
type CompactLifecycleToolName =
  | 'list_products'
  | 'request_proposals'
  | 'refine_proposals'
  | 'decline_proposals'
  | 'buy_products'
  | 'accept_proposal'
  | 'control_media_buy';

const LIST_PRODUCTS_FIELDS = new Set([
  'account',
  'adcp_major_version',
  'adcp_version',
  'brand',
  'context',
  'context_id',
  'criteria',
  'cursor',
  'fields',
  'governance_context',
  'idempotency_key',
  'if_feed_version',
  'if_pricing_version',
  'max_results',
  'push_notification_config',
]);
const REQUEST_PROPOSALS_FIELDS = new Set([
  'account',
  'adcp_major_version',
  'adcp_version',
  'brand',
  'brief',
  'context',
  'context_id',
  'criteria',
  'governance_context',
  'idempotency_key',
  'opportunity',
  'push_notification_config',
]);
const REFINE_PROPOSALS_FIELDS = new Set([
  'adcp_major_version',
  'adcp_version',
  'context',
  'context_id',
  'governance_context',
  'idempotency_key',
  'push_notification_config',
  'refinements',
]);
const DECLINE_PROPOSALS_FIELDS = new Set([
  'adcp_major_version',
  'adcp_version',
  'context',
  'context_id',
  'declines',
  'governance_context',
  'idempotency_key',
  'opportunity',
  'push_notification_config',
]);
const BUY_PRODUCTS_FIELDS = new Set([
  'account',
  'adcp_major_version',
  'adcp_version',
  'advertiser_industry',
  'agency_estimate_number',
  'bidding',
  'brand',
  'budget_allocation',
  'budget_cap_timezone',
  'context',
  'daily_budget_cap',
  'end_time',
  'ext',
  'feed_version',
  'governance_context',
  'idempotency_key',
  'invoice_recipient',
  'opportunity',
  'pacing',
  'paused',
  'pricing_version',
  'purchase_order_ref',
  'purchases',
  'push_notification_config',
  'reporting_webhook',
  'start_time',
  'total_budget',
]);
const ACCEPT_PROPOSAL_FIELDS = new Set([
  'account',
  'adcp_major_version',
  'adcp_version',
  'budget_cap_timezone',
  'context',
  'daily_budget_cap',
  'ext',
  'established_fallback',
  'governance_context',
  'idempotency_key',
  'io_acceptance',
  'opportunity',
  'proposal_id',
  'proposal_terms_digest',
  'purchase_order_ref',
  'push_notification_config',
  'reporting_webhook',
  'total_budget',
]);
const CONTROL_MEDIA_BUY_FIELDS = new Set([
  'account',
  'adcp_major_version',
  'adcp_version',
  'bidding',
  'budget_allocation',
  'budget_cap_timezone',
  'canceled',
  'cancellation_reason',
  'context',
  'daily_budget_cap',
  'ext',
  'governance_context',
  'idempotency_key',
  'media_buy_id',
  'pacing',
  'packages',
  'paused',
  'push_notification_config',
  'reporting_webhook',
  'revision',
  'total_budget',
]);
const V25_OFFER_FILTER_FIELDS = new Set([
  'budget_range',
  'channels',
  'countries',
  'delivery_type',
  'end_date',
  'is_fixed_price',
  'min_exposures',
  'standard_formats_only',
  'start_date',
]);
const V30_OFFER_FILTER_FIELDS = new Set([
  ...V25_OFFER_FILTER_FIELDS,
  'exclusivity',
  'required_performance_standards',
  'trusted_match',
]);
const V31_OFFER_FILTER_FIELDS = new Set([
  ...V30_OFFER_FILTER_FIELDS,
  'audio_distribution_types',
  'pricing_currencies',
  'required_metrics',
  'required_vendor_metrics',
  'social_placement_surfaces',
  'sponsored_placement_types',
  'video_placement_types',
]);
const V30_PURCHASE_FIELDS = new Set([
  'agency_estimate_number',
  'budget',
  'context',
  'end_time',
  'ext',
  'impressions',
  'pacing',
  'pricing_option_id',
  'product_id',
  'start_time',
  'targeting_overlay',
]);
const V25_PURCHASE_FIELDS = new Set([
  'budget',
  'ext',
  'impressions',
  'pacing',
  'pricing_option_id',
  'product_id',
  'targeting_overlay',
]);
const V31_PURCHASE_FIELDS = new Set([...V30_PURCHASE_FIELDS, 'format_option_refs']);
const V32_PURCHASE_FIELDS = new Set([
  ...V31_PURCHASE_FIELDS,
  'audience_evidence_pins',
  'audience_evidence_requirements',
  'bidding',
  'daily_budget_cap',
  'min_spend_target',
]);
const V30_TARGETING_FIELDS = new Set([
  'age_restriction',
  'audience_exclude',
  'audience_include',
  'axe_exclude_segment',
  'axe_include_segment',
  'collection_list',
  'collection_list_exclude',
  'daypart_targets',
  'device_platform',
  'device_type',
  'device_type_exclude',
  'frequency_cap',
  'geo_countries',
  'geo_countries_exclude',
  'geo_metros',
  'geo_metros_exclude',
  'geo_postal_areas',
  'geo_postal_areas_exclude',
  'geo_proximity',
  'geo_regions',
  'geo_regions_exclude',
  'keyword_targets',
  'language',
  'negative_keywords',
  'property_list',
  'store_catchments',
]);
const V31_TARGETING_FIELDS = new Set([...V30_TARGETING_FIELDS, 'signal_targeting', 'signal_targeting_groups']);
const V30_POSTAL_SYSTEMS = new Set([
  'us_zip',
  'us_zip_plus_four',
  'gb_outward',
  'gb_full',
  'ca_fsa',
  'ca_full',
  'de_plz',
  'fr_code_postal',
  'au_postcode',
  'ch_plz',
  'at_plz',
]);
const V30_METRO_SYSTEMS = new Set(['nielsen_dma', 'uk_itl1', 'uk_itl2', 'eurostat_nuts2', 'custom']);
const V31_TIME_GRANULARITIES = new Set(['hourly', 'daily', 'monthly']);
const V30_AVAILABLE_METRICS = new Set([
  'impressions',
  'spend',
  'clicks',
  'ctr',
  'video_completions',
  'completion_rate',
  'conversions',
  'conversion_value',
  'roas',
  'cost_per_acquisition',
  'new_to_brand_rate',
  'viewability',
  'engagement_rate',
  'views',
  'completed_views',
  'leads',
  'reach',
  'frequency',
  'grps',
  'quartile_data',
  'dooh_metrics',
  'cost_per_click',
]);
const V25_AVAILABLE_METRICS = new Set([
  'impressions',
  'spend',
  'clicks',
  'ctr',
  'video_completions',
  'completion_rate',
  'conversions',
  'viewability',
  'engagement_rate',
]);
const V31_AVAILABLE_METRICS = new Set([
  'impressions',
  'spend',
  'clicks',
  'ctr',
  'views',
  'completed_views',
  'completion_rate',
  'conversions',
  'conversion_value',
  'roas',
  'cost_per_acquisition',
  'new_to_brand_rate',
  'leads',
  'reach',
  'frequency',
  'grps',
  'engagements',
  'engagement_rate',
  'follows',
  'saves',
  'profile_visits',
  'viewability',
  'quartile_data',
  'dooh_metrics',
  'cost_per_click',
  'cost_per_completed_view',
  'cpm',
  'downloads',
  'units_sold',
  'new_to_brand_units',
  'plays',
  'incremental_sales_lift',
  'brand_lift',
  'foot_traffic',
  'conversion_lift',
  'brand_search_lift',
]);
const V30_PRODUCT_FIELDS = new Set([
  'product_id',
  'name',
  'description',
  'publisher_properties',
  'channels',
  'placements',
  'delivery_type',
  'exclusivity',
  'pricing_options',
  'forecast',
  'reporting_capabilities',
  'catalog_types',
  'max_optimization_goals',
  'catalog_match',
  'brief_relevance',
  'expires_at',
]);
const V31_PRODUCT_FIELDS = new Set([
  ...V30_PRODUCT_FIELDS,
  'video_placement_types',
  'audio_distribution_types',
  'sponsored_placement_types',
  'social_placement_surfaces',
  'format_options',
  'signal_targeting_allowed',
  'signal_targeting_rules',
]);
const LEGACY_REPORTING_DIMENSIONS = new Set(['geo', 'device_type', 'device_platform', 'audience', 'placement']);
const ESTABLISHED_TOOL_FOR_COMPACT: Readonly<Record<CompactLifecycleToolName, string>> = {
  list_products: 'get_products',
  request_proposals: 'get_products',
  refine_proposals: 'get_products',
  decline_proposals: 'get_products',
  buy_products: 'create_media_buy',
  accept_proposal: 'create_media_buy',
  control_media_buy: 'update_media_buy',
};

/** Guarantees that the established lifecycle cannot enforce atomically. */
export type MediaBuyCompatibilityLoss =
  | 'feed_version_not_atomic'
  | 'pricing_version_not_atomic'
  | 'proposal_terms_digest_not_enforced'
  | 'proposal_terms_digest_unavailable'
  | 'proposal_snapshot_not_immutable'
  | 'proposal_hold_not_verifiable'
  | 'revision_not_atomic'
  | 'proposal_decline_not_terminal'
  | 'proposal_decline_reason_not_forwarded';

export interface MediaBuyCompatibilityReport {
  negotiated_version: string;
  lifecycle: MediaBuyLifecycle;
  tools_used: string[];
  compatibility: MediaBuyCompatibility;
  warnings: string[];
  losses: MediaBuyCompatibilityLoss[];
}

type WithCompatibility<T> = T & { compatibility: MediaBuyCompatibilityReport };

export type CompatibilityDeferredContinuation<TCompleted, TWire> = Omit<
  NonNullable<TaskResultIntermediate<TWire>['deferred']>,
  'resume'
> & {
  resume: (input: unknown) => Promise<CompatibilityTaskResult<TCompleted, TWire>>;
};

export type CompatibilitySubmittedContinuation<TCompleted, TWire> = Omit<
  NonNullable<TaskResultIntermediate<TWire>['submitted']>,
  'waitForCompletion'
> & {
  waitForCompletion: (
    pollInterval?: number,
    signal?: AbortSignal
  ) => Promise<CompatibilityTaskResult<TCompleted, TWire>>;
};

type CompatibilityTaskResultIntermediate<TCompleted, TWire> = Omit<
  TaskResultIntermediate<TWire>,
  'deferred' | 'submitted'
> & {
  deferred?: CompatibilityDeferredContinuation<TCompleted, TWire>;
  submitted?: CompatibilitySubmittedContinuation<TCompleted, TWire>;
};

/**
 * A projected compatibility result is status-aware: completed success data is
 * the stable compatibility view, while non-terminal and failure data remains
 * the SDK-returned compact or canonical-established source shape until a
 * completed result can be projected.
 */
export type CompatibilityTaskResult<TCompleted, TWire = TCompleted> =
  | WithCompatibility<TaskResultCompleted<TCompleted>>
  | WithCompatibility<CompatibilityTaskResultIntermediate<TCompleted, TWire>>
  | WithCompatibility<TaskResultFailure<TWire>>;

export type CompatibleProduct = Product | CanonicalProduct;
export type CompatibleProposal = Proposal | CanonicalProposal;

type CompactRefinementResult = NonNullable<RefineProposalsResponse['results']>[number];
type CompactRevisedResult = Extract<CompactRefinementResult, { outcome: 'revised' }>;
type CompactPartialResult = Extract<CompactRefinementResult, { outcome: 'partial' }>;
type CompactFinalizedResult = Extract<CompactRefinementResult, { outcome: 'finalized' }>;
type CompactUnableResult = Extract<CompactRefinementResult, { outcome: 'unable' }>;

/**
 * Refine result with the canonical proposal base exposed at the coordinator
 * boundary. The generated response keeps the native outcome discriminants;
 * this compatibility view additionally makes the canonical proposal fields
 * explicit for callers on every proposal-bearing result arm.
 */
export type CompatibleRefinementResult =
  | (Omit<CompactRevisedResult, 'proposals'> & {
      proposals: (CanonicalProposal & { proposal_status: 'draft'; parent_proposal_id: string })[];
    })
  | (Omit<CompactPartialResult, 'proposals'> & {
      proposals: (CanonicalProposal & { proposal_status: 'draft'; parent_proposal_id: string })[];
    })
  | (Omit<CompactFinalizedResult, 'proposal'> & {
      proposal: CanonicalProposal & {
        proposal_status: 'committed';
        parent_proposal_id: string;
        expires_at: string;
      };
    })
  | CompactUnableResult;

export type CompatibleDeclineResult =
  | { proposal_id: string; outcome: 'declined' }
  | { proposal_id: string; outcome: 'unable'; reason: string };
export type CompatibleProjectedDeclineResult = {
  proposal_id: string;
  /** Legacy get_products omit is not a seller-confirmed terminal decline. */
  outcome: 'unconfirmed';
};

type CompatibleErrors =
  | NonNullable<GetProductsResponse['errors']>
  | NonNullable<RequestProposalsResponse['errors']>
  | NonNullable<RefineProposalsResponse['errors']>
  | NonNullable<DeclineProposalsResponse['errors']>;
type CompatibleContext =
  | NonNullable<GetProductsResponse['context']>
  | NonNullable<ListProductsResponse['context']>
  | NonNullable<RequestProposalsResponse['context']>
  | NonNullable<RefineProposalsResponse['context']>
  | NonNullable<DeclineProposalsResponse['context']>;

export interface CompatibleProductsResponse {
  /** Present only when the seller returned product rows (conditional reads may return only `unchanged`). */
  products?: CompatibleProduct[];
  proposals?: CompatibleProposal[];
  feed_version?: string;
  pricing_version?: string;
  unchanged?: true;
  /** Lifecycle-neutral cursor for the next page. */
  next_cursor?: string;
  pagination?: GetProductsResponse['pagination'];
  cache_scope?: 'public' | 'account';
  errors?: CompatibleErrors;
  context?: CompatibleContext;
  /** SDK-returned source object, retained for fields outside the stable compatibility view. */
  raw: ListProductsResponse | EstablishedProductsWireResponse;
}

interface CompatibleProposalResponseBase {
  proposals?: CompatibleProposal[];
  products?: CompatibleProduct[];
  errors?: CompatibleErrors;
  context?: CompatibleContext;
}

export interface CompatibleRequestProposalsResponse extends CompatibleProposalResponseBase {
  operation: 'request';
  /** `legacy_unavailable` never overstates an empty legacy response as a seller rejection. */
  outcome: 'proposed' | 'rejected' | 'legacy_unavailable';
  reason?: string;
  suggestions?: string[];
  raw: RequestProposalsResponse | EstablishedProductsWireResponse;
}

export interface CompatibleRefineProposalsResponse extends CompatibleProposalResponseBase {
  operation: 'refine';
  /** Native result arms remain available in `results`; legacy projection is explicitly named. */
  outcome: 'native_results' | 'legacy_projected' | 'legacy_unavailable';
  results?: CompatibleRefinementResult[];
  reason?: string;
  suggestions?: string[];
  raw: RefineProposalsResponse | EstablishedProductsWireResponse;
}

export interface CompatibleDeclineProposalsResponse extends CompatibleProposalResponseBase {
  operation: 'decline';
  outcome: 'native_results' | 'legacy_unconfirmed';
  results: (CompatibleDeclineResult | CompatibleProjectedDeclineResult)[];
  raw: DeclineProposalsResponse | EstablishedProductsWireResponse;
}

export type CompatibleProposalResponse =
  | CompatibleRequestProposalsResponse
  | CompatibleRefineProposalsResponse
  | CompatibleDeclineProposalsResponse;

type TaskResultData<TResult> = TResult extends TaskResult<infer TData> ? TData : never;
/** Canonical SDK source returned by established `get_products`, including projection diagnostics. */
export type EstablishedProductsWireResponse = TaskResultData<Awaited<ReturnType<AgentClient['getProducts']>>>;

/** SDK-returned source data retained before a completed list response is projected. */
export type CompatibleProductsWireResponse =
  | TaskResultData<Awaited<ReturnType<AgentClient['listProducts']>>>
  | EstablishedProductsWireResponse;
/** SDK-returned source data retained while a proposal request is non-terminal or failed. */
export type CompatibleRequestProposalsWireResponse =
  | TaskResultData<Awaited<ReturnType<AgentClient['requestProposals']>>>
  | EstablishedProductsWireResponse;
/** SDK-returned source data retained while proposal refinement is non-terminal or failed. */
export type CompatibleRefineProposalsWireResponse =
  | TaskResultData<Awaited<ReturnType<AgentClient['refineProposals']>>>
  | EstablishedProductsWireResponse;
/** SDK-returned source data retained while proposal decline is non-terminal or failed. */
export type CompatibleDeclineProposalsWireResponse =
  | TaskResultData<Awaited<ReturnType<AgentClient['declineProposals']>>>
  | EstablishedProductsWireResponse;

export interface MediaBuyLifecycleCoordinatorOptions {
  /** Prefer compact when advertised. Established is useful for a dual-surface test lane. */
  preferredLifecycle?: 'auto' | MediaBuyLifecycle;
  /** Named representational losses explicitly accepted for legacy mutations. */
  allowedLosses?: readonly MediaBuyCompatibilityLoss[];
  /**
   * Stable, non-secret, server-controlled identity for the authenticated
   * principal/tenant that owns this coordinator. Never derive it from buyer
   * request content. It salts proposal snapshots so multi-tenant runners
   * cannot reuse a snapshot across principals. Required for established
   * proposal acceptance; without it snapshots are not retained.
   */
  principalScope?: string;
}

/**
 * Inputs the established create_media_buy proposal path requires but the
 * compact accept_proposal request intentionally does not repeat. Callers may
 * supply this on every compatibility-facade acceptance: compact sellers ignore
 * it, while established sellers use it without pretending it came from the
 * seller's proposal snapshot.
 */
export interface EstablishedProposalAcceptanceFallback {
  brand: CanonicalCreateMediaBuyRequest['brand'];
  start_time: CanonicalCreateMediaBuyRequest['start_time'];
  end_time: CanonicalCreateMediaBuyRequest['end_time'];
}

/**
 * Compatibility-facade acceptance input. A digest remains mandatory on the
 * native compact lane. It is optional only for an established lane whose
 * missing digest/snapshot guarantees have been explicitly accepted.
 */
export type CompatibleAcceptProposalRequest = Omit<AcceptProposalRequest, 'proposal_terms_digest'> & {
  proposal_terms_digest?: string;
  established_fallback?: EstablishedProposalAcceptanceFallback;
};

export interface MediaBuyLifecycleCompatibilityErrorOptions {
  operation: string;
  negotiatedVersion: string;
  lifecycle: MediaBuyLifecycle;
  feature: string;
  message: string;
  losses?: readonly MediaBuyCompatibilityLoss[];
  recovery?: string;
  code?: 'UNSUPPORTED_FEATURE' | 'PROPOSAL_DIGEST_MISMATCH';
}

/** Structured preflight failure raised before an incompatible mutation is sent. */
export class MediaBuyLifecycleCompatibilityError extends Error {
  readonly name = 'MediaBuyLifecycleCompatibilityError';
  readonly code: 'UNSUPPORTED_FEATURE' | 'PROPOSAL_DIGEST_MISMATCH';
  readonly operation: string;
  readonly negotiatedVersion: string;
  readonly lifecycle: MediaBuyLifecycle;
  readonly feature: string;
  readonly losses: readonly MediaBuyCompatibilityLoss[];
  readonly recovery: string;

  constructor(options: MediaBuyLifecycleCompatibilityErrorOptions) {
    super(options.message);
    this.code = options.code ?? 'UNSUPPORTED_FEATURE';
    this.operation = options.operation;
    this.negotiatedVersion = options.negotiatedVersion;
    this.lifecycle = options.lifecycle;
    this.feature = options.feature;
    this.losses = options.losses ?? [];
    this.recovery =
      options.recovery ??
      'Remove the unsupported compact guarantee, select a compact-capable seller, or explicitly allow the named loss.';
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function safeDiagnostic(value: unknown, maxLength: number): string {
  const raw = String(value);
  const escaped = raw.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, character => {
    const code = character.codePointAt(0) ?? 0;
    return `\\u${code.toString(16).padStart(4, '0')}`;
  });
  return escaped.length > maxLength ? `${escaped.slice(0, maxLength - 1)}…` : escaped;
}

function requestFingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('base64url');
}

function retiredAcceptancePositions(key: string, salt: Uint8Array, bitCount: number): number[] {
  const digest = createHash('sha256').update(salt).update(key).digest();
  return [0, 4, 8, 12, 16, 20, 24, 28].map(offset => digest.readUInt32BE(offset) % bitCount);
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

const CREDENTIAL_SHAPED_KEYS = new Set([
  'authorization',
  'credential',
  'credentials',
  'token',
  'authtoken',
  'apikey',
  'password',
  'secret',
  'clientsecret',
  'refreshtoken',
  'accesstoken',
  'bearer',
  'sessiontoken',
  'privatekey',
  'signingkey',
  'jwt',
  'signature',
  'signedpayload',
  'cookie',
  'setcookie',
]);

function isCredentialShapedKey(key: string): boolean {
  return CREDENTIAL_SHAPED_KEYS.has(key.replace(/[-_]/g, '').toLowerCase());
}

function containsCredentialShapedKey(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some(item => containsCredentialShapedKey(item, seen));
  return Object.entries(value).some(
    ([key, nested]) => isCredentialShapedKey(key) || containsCredentialShapedKey(nested, seen)
  );
}

function containsPresignedUrl(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value === 'string') {
    try {
      const url = new URL(value);
      const sensitiveQueryKeys = new Set([
        'x-amz-credential',
        'x-amz-signature',
        'x-goog-credential',
        'x-goog-signature',
        'signature',
        'sig',
        'token',
        'access_token',
      ]);
      return [...url.searchParams.keys()].some(key => sensitiveQueryKeys.has(key.toLowerCase()));
    } catch {
      return false;
    }
  }
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some(nested => containsPresignedUrl(nested, seen));
}

interface ParsedRelease {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

function parseRelease(value: string): ParsedRelease | undefined {
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:-([A-Za-z0-9.-]+))?(?:\+[A-Za-z0-9.-]+)?$/.exec(value.trim());
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? 0),
    ...(match[4] !== undefined && { prerelease: match[4] }),
  };
}

function comparePrerelease(left: string | undefined, right: string | undefined): number {
  if (left === right) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  const leftParts = left.split('.');
  const rightParts = right.split('.');
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const a = leftParts[index];
    const b = rightParts[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return Number(a) - Number(b);
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a.localeCompare(b);
  }
  return 0;
}

function compareRelease(left: string, right: string): number {
  const a = parseRelease(left);
  const b = parseRelease(right);
  if (!a || !b) return 0;
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch || comparePrerelease(a.prerelease, b.prerelease);
}

function isCompactRelease(value: string): boolean {
  const release = parseRelease(value);
  return release !== undefined && (release.major > 3 || (release.major === 3 && release.minor >= 2));
}

function negotiatedVersion(capabilities: AdcpCapabilities, clientVersion: string): string {
  if (capabilities.version === 'v2') return '2.5';
  if (capabilities.servedVersion && parseRelease(capabilities.servedVersion)) {
    if (compareRelease(capabilities.servedVersion, clientVersion) > 0) {
      const displayedServedVersion = capabilities.servedVersion.slice(0, 64);
      throw new ConfigurationError(
        `The seller served AdCP ${displayedServedVersion}, which is newer than the client pin ${clientVersion}; the response cannot be interpreted safely.`
      );
    }
    return capabilities.servedVersion;
  }
  const advertisedVersions = capabilities.supportedVersions?.filter(version => parseRelease(version) !== undefined);
  const candidates = advertisedVersions?.filter(
    version => parseRelease(version) !== undefined && compareRelease(version, clientVersion) <= 0
  );
  if (candidates?.length) return [...candidates].sort(compareRelease).at(-1)!;
  if (advertisedVersions?.length) {
    throw new ConfigurationError(
      `The seller advertises only AdCP versions newer than the client pin ${clientVersion}; no compatible wire version can be negotiated.`
    );
  }
  if (capabilities._synthetic && capabilities.mediaBuyLifecycleTools?.length && isCompactRelease(clientVersion)) {
    // Compact tool names are authoritative wire evidence. A failed
    // capabilities call must not route a compact-only seller to aliases it
    // does not expose.
    return clientVersion;
  }
  // AdCP 3.0 predates release-precision capability metadata. A real v3
  // capability response with none of the fields above is therefore a 3.0
  // lane; reporting the client's newer pin would overstate the wire release.
  return '3.0';
}

const MAX_PROPOSAL_TRAVERSAL_NODES = 4096;
const COMPACT_REQUEST_PROPOSALS_RESPONSE_FIELDS = new Set([
  'adcp_version',
  'outcome',
  'reason',
  'suggestions',
  'proposals',
  'products',
  'targeting_resolution',
  'status',
  'task_id',
  'message',
  'errors',
  'context',
  'ext',
  'replayed',
]);
const COMPACT_DECLINE_PROPOSALS_RESPONSE_FIELDS = new Set([
  'adcp_version',
  'results',
  'status',
  'task_id',
  'message',
  'errors',
  'context',
  'ext',
  'replayed',
]);

function projectProducts(data: unknown, lifecycle: MediaBuyLifecycle): CompatibleProductsResponse {
  const source = compactWirePayload(data);
  const feedVersion = optionalString(lifecycle === 'compact' ? source.feed_version : source.wholesale_feed_version);
  const pricingVersion = optionalString(source.pricing_version);
  const nextCursor = optionalString(lifecycle === 'compact' ? source.next_cursor : record(source.pagination).cursor);
  return {
    ...(Array.isArray(source.products) && { products: source.products as CompatibleProduct[] }),
    ...(Array.isArray(source.proposals) && { proposals: source.proposals as CompatibleProposal[] }),
    ...(feedVersion && { feed_version: feedVersion }),
    ...(pricingVersion && { pricing_version: pricingVersion }),
    ...((source.unchanged === true || source.outcome === 'unchanged') && { unchanged: true as const }),
    ...(nextCursor && { next_cursor: nextCursor }),
    ...(source.pagination !== undefined && { pagination: source.pagination as GetProductsResponse['pagination'] }),
    ...((source.cache_scope === 'public' || source.cache_scope === 'account') && {
      cache_scope: source.cache_scope,
    }),
    ...(Array.isArray(source.errors) && { errors: source.errors as CompatibleErrors }),
    ...(source.context !== undefined && { context: source.context as CompatibleContext }),
    raw: source as ListProductsResponse | EstablishedProductsWireResponse,
  };
}

function proposalRows(source: Record<string, unknown>): CompatibleProposal[] | undefined {
  const proposals: CompatibleProposal[] = [];
  let sawProposalContainer = false;
  const roots: unknown[] = [];
  if (source.proposals !== undefined) roots.push(source.proposals);
  if (source.proposal !== undefined) roots.push(source.proposal);
  const results = array(source.results);
  if (results.length > MAX_PROPOSAL_TRAVERSAL_NODES) {
    throw new TypeError('proposal response exceeded the bounded traversal limit.');
  }
  for (const result of results) {
    const row = record(result);
    if (row.proposals !== undefined) roots.push(row.proposals);
    if (row.proposal !== undefined) roots.push(row.proposal);
  }
  const stack = roots.reverse();
  const seen = new WeakSet<object>();
  let visited = 0;
  while (stack.length > 0) {
    const value = stack.pop();
    if (value === null || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    visited += 1;
    if (visited > MAX_PROPOSAL_TRAVERSAL_NODES) {
      throw new TypeError('proposal response exceeded the bounded traversal limit.');
    }
    if (Array.isArray(value)) {
      sawProposalContainer = true;
      if (stack.length + value.length > MAX_PROPOSAL_TRAVERSAL_NODES) {
        throw new TypeError('proposal response exceeded the bounded traversal limit.');
      }
      for (let index = value.length - 1; index >= 0; index -= 1) stack.push(value[index]);
      continue;
    }
    const candidate = value as Record<string, unknown>;
    if (optionalString(candidate.proposal_id)) {
      sawProposalContainer = true;
      proposals.push(candidate as CompatibleProposal);
    }
    // Reverse push preserves the prior depth-first proposals-then-proposal order.
    if (candidate.proposal !== undefined) stack.push(candidate.proposal);
    if (candidate.proposals !== undefined) stack.push(candidate.proposals);
  }
  return sawProposalContainer ? proposals : undefined;
}

function proposalResponseBase(source: Record<string, unknown>): CompatibleProposalResponseBase {
  const proposals = proposalRows(source);
  return {
    ...(proposals !== undefined && { proposals }),
    ...(Array.isArray(source.products) && { products: source.products as CompatibleProduct[] }),
    ...(Array.isArray(source.errors) && { errors: source.errors as CompatibleErrors }),
    ...(source.context !== undefined && { context: source.context as CompatibleContext }),
  };
}

/**
 * Remove SDK-only response annotations before validating or exposing the
 * seller's wire payload. `_message` is synthesized by the response unwrapper
 * from MCP/A2A text parts after schema validation; it never crossed the AdCP
 * tool boundary and therefore must not be mistaken for an undeclared seller
 * field. Keep this allowlist deliberately narrow so seller-controlled
 * underscore fields still fail closed.
 */
function compactWirePayload(data: unknown): Record<string, unknown> {
  const source = record(data);
  if (!Object.hasOwn(source, '_message')) return source;
  const { _message: _sdkMessage, ...wire } = source;
  return wire;
}

function assertCompactRequestProposalsCompletion(source: Record<string, unknown>, negotiatedVersion: string): void {
  const unsupportedFields = Object.keys(source).filter(field => !COMPACT_REQUEST_PROPOSALS_RESPONSE_FIELDS.has(field));
  if (unsupportedFields.length > 0) {
    throw new TypeError(
      `request_proposals returned a malformed compact completion: undeclared fields ${unsupportedFields.join(', ')}.`
    );
  }
  const normalized = source.status === undefined ? { ...source, status: 'completed' } : source;
  if (normalized.status !== 'completed' || Object.hasOwn(normalized, 'task_id')) {
    throw new TypeError(
      'request_proposals returned a malformed compact completion: the completed sync arm must not contain submitted status or task_id.'
    );
  }
  const validation = validateResponse('request_proposals', normalized, negotiatedVersion);
  if (!validation.valid) {
    throw new TypeError(
      `request_proposals returned a malformed compact completion: ${formatIssues(validation.issues)}`
    );
  }
}

function projectRequestProposals(
  data: unknown,
  lifecycle: MediaBuyLifecycle,
  negotiatedVersion?: string
): CompatibleRequestProposalsResponse {
  const source = compactWirePayload(data);
  if (lifecycle === 'compact') assertCompactRequestProposalsCompletion(source, negotiatedVersion ?? '3.2');
  const base = proposalResponseBase(source);
  const nativeOutcome = source.outcome === 'proposed' || source.outcome === 'rejected' ? source.outcome : undefined;
  const outcome =
    nativeOutcome ??
    (lifecycle === 'established' && (base.proposals?.length ?? 0) > 0 ? 'proposed' : 'legacy_unavailable');
  return {
    ...base,
    operation: 'request',
    outcome,
    ...(typeof source.reason === 'string' && { reason: source.reason }),
    ...(Array.isArray(source.suggestions) && { suggestions: source.suggestions as string[] }),
    raw: source as RequestProposalsResponse | EstablishedProductsWireResponse,
  };
}

function projectRefineProposals(
  data: unknown,
  lifecycle: MediaBuyLifecycle,
  refinements: RefineProposalsInput['refinements']
): CompatibleRefineProposalsResponse {
  const source = compactWirePayload(data);
  const proposalIds = refinements.map(refinement => refinement.proposal_id);
  if (lifecycle === 'compact') {
    // Verify the complete response root before following any seller-controlled
    // proposal container or result branch.
    assertRefineProposalsResponse({ refinements }, source);
  }
  const base = proposalResponseBase(source);
  const sourceResults = array(source.results);
  if (lifecycle === 'compact') {
    if (sourceResults.length !== proposalIds.length) {
      throw new TypeError('refine_proposals returned a different result count than the requested refinement count.');
    }
    sourceResults.forEach((value, index) => {
      const result = record(value);
      const requestedProposalId = proposalIds[index];
      const sourceProposalId = optionalString(result.source_proposal_id);
      if (requestedProposalId === undefined || sourceProposalId !== requestedProposalId) {
        throw new TypeError(
          `refine_proposals result ${index} did not identify the corresponding source proposal from the request.`
        );
      }
      const children = [...array(result.proposals), ...(result.proposal === undefined ? [] : [result.proposal])];
      if (result.outcome === 'revised' || result.outcome === 'partial' || result.outcome === 'finalized') {
        const shape = validateRefineProposalsResponseShape({ results: [result], products: [] });
        if (!shape.ok) {
          throw new TypeError(`refine_proposals result ${index} did not contain complete canonical proposal data.`);
        }
        const expectedStatus = result.outcome === 'finalized' ? 'committed' : 'draft';
        if (children.some(child => record(child).proposal_status !== expectedStatus)) {
          throw new TypeError(
            `refine_proposals result ${index} returned a proposal with an invalid status for its ${String(result.outcome)} outcome.`
          );
        }
        if (result.outcome === 'finalized' && children.some(child => !isStrictDateTime(record(child).expires_at))) {
          throw new TypeError(`refine_proposals result ${index} returned a finalized proposal without a valid expiry.`);
        }
      }
      children.forEach(child => {
        if (optionalString(record(child).parent_proposal_id) !== sourceProposalId) {
          throw new TypeError(
            `refine_proposals result ${index} returned a proposal with invalid parent_proposal_id lineage.`
          );
        }
      });
    });
  }
  const nativeResults = Array.isArray(source.results) ? (sourceResults as CompatibleRefinementResult[]) : undefined;
  const outcome =
    lifecycle === 'compact'
      ? 'native_results'
      : (base.proposals?.length ?? 0) > 0
        ? 'legacy_projected'
        : 'legacy_unavailable';
  return {
    ...base,
    operation: 'refine',
    outcome,
    ...(nativeResults !== undefined && { results: nativeResults }),
    ...(typeof source.reason === 'string' && { reason: source.reason }),
    ...(Array.isArray(source.suggestions) && { suggestions: source.suggestions as string[] }),
    raw: source as RefineProposalsResponse | EstablishedProductsWireResponse,
  };
}

function projectDeclineProposals(
  data: unknown,
  lifecycle: MediaBuyLifecycle,
  proposalIds: readonly string[],
  negotiatedVersion?: string
): CompatibleDeclineProposalsResponse {
  const source = compactWirePayload(data);
  if (lifecycle === 'compact') {
    const unsupportedFields = Object.keys(source).filter(
      field => !COMPACT_DECLINE_PROPOSALS_RESPONSE_FIELDS.has(field)
    );
    if (unsupportedFields.length > 0) {
      throw new TypeError(
        `decline_proposals returned a malformed compact completion: undeclared fields ${unsupportedFields.join(', ')}.`
      );
    }
    const validation = validateResponse('decline_proposals', source, negotiatedVersion ?? '3.2');
    if (!validation.valid || validation.variant !== 'sync') {
      throw new TypeError(
        `decline_proposals returned a malformed compact completion: ${formatIssues(validation.issues)}`
      );
    }
  }
  const base = proposalResponseBase(source);
  const sourceResults = array(source.results);
  if (lifecycle === 'compact' && sourceResults.length !== proposalIds.length) {
    throw new TypeError('decline_proposals returned a different result count than the requested proposal count.');
  }
  const results =
    lifecycle === 'compact'
      ? sourceResults.map((result, index) => {
          const row = record(result);
          const requestedProposalId = proposalIds[index];
          const sellerProposalId = optionalString(row.proposal_id);
          if (requestedProposalId === undefined) {
            throw new TypeError('decline_proposals returned more result rows than requested proposals.');
          }
          if (Object.keys(row).some(key => !['proposal_id', 'outcome', 'reason'].includes(key))) {
            throw new TypeError(`decline_proposals result ${index} contained an undeclared field.`);
          }
          if (Object.hasOwn(row, 'proposal_id') && sellerProposalId === undefined) {
            throw new TypeError(`decline_proposals result ${index} contained an invalid proposal_id.`);
          }
          if (sellerProposalId !== undefined && sellerProposalId !== requestedProposalId) {
            throw new TypeError(
              `decline_proposals result ${index} identified a different proposal than the corresponding request.`
            );
          }
          if (row.outcome === 'declined') {
            if (Object.hasOwn(row, 'reason')) {
              throw new TypeError(`decline_proposals declined result ${index} must not contain a reason.`);
            }
            return { proposal_id: requestedProposalId, outcome: 'declined' as const };
          }
          if (row.outcome === 'unable') {
            const reason = optionalString(row.reason);
            if (!reason) {
              throw new TypeError(`decline_proposals unable result ${index} requires a non-empty reason.`);
            }
            return { proposal_id: requestedProposalId, outcome: 'unable' as const, reason };
          }
          throw new TypeError(`decline_proposals result ${index} contained an invalid outcome.`);
        })
      : proposalIds.map(proposal_id => ({ proposal_id, outcome: 'unconfirmed' as const }));
  return {
    ...base,
    operation: 'decline',
    outcome: lifecycle === 'compact' ? 'native_results' : 'legacy_unconfirmed',
    results,
    raw: source as DeclineProposalsResponse | EstablishedProductsWireResponse,
  };
}

interface AcceptanceReservation {
  kind: 'native' | 'established';
  state: 'in-flight' | 'retryable' | 'retired';
  retryKind?: 'paused' | 'commit-uncertain';
  requestFingerprint: string;
  idempotencyKey?: string;
  skipIdempotencyAutoInject: boolean;
  retryDeadlineMs?: number;
  taskId?: string;
}

interface ProposalSnapshotEntry {
  proposal: Record<string, unknown>;
  bytes: number;
  principalScope: string;
  executable: boolean;
  accountScope?: string;
  canonicalTermsDigest?: string;
  acceptance?: AcceptanceReservation;
  /** Synthetic entry used only to share a native acceptance fence. */
  nativeAcceptanceOnly?: boolean;
}

interface ProposalSnapshotStore {
  entries: Map<string, ProposalSnapshotEntry>;
  proposalAcceptances: Map<
    string,
    { snapshotKey: string; snapshot: ProposalSnapshotEntry; reservation: AcceptanceReservation }
  >;
  pendingDeclines: Set<PendingDeclineLease>;
  pendingDeclineProposalIdCount: number;
  pendingRefinements: Set<PendingRefinementLease>;
  pendingRefinementProposalIdCount: number;
  bytes: number;
  registry: ProposalSnapshotStoreRegistry;
  activeCoordinators: number;
}

interface ProposalSnapshotStoreRegistry {
  stores: Map<string, ProposalSnapshotStore>;
  retiredAcceptanceSegments?: Map<number, Uint8Array>;
  retiredAcceptanceSalt?: Uint8Array;
}

interface SafeProposalSnapshot {
  proposal: Record<string, unknown>;
  canonicalTermsDigest?: string;
}

type ProposalMutationState = 'in-flight' | 'paused' | 'commit-uncertain' | 'retired';

interface ProposalMutationReservation {
  proposalIds: readonly string[];
  state: ProposalMutationState;
  requestFingerprint: string;
  idempotencyKey?: string;
  skipIdempotencyAutoInject: boolean;
  /** Fixed from the seller's advertised replay TTL at the first dispatch. */
  readonly retryDeadlineMs?: number;
  attemptEpoch: number;
  owner: object;
  timer?: ReturnType<typeof setTimeout>;
}

interface PendingDeclineLease extends ProposalMutationReservation {
  operation: 'decline';
}

interface PendingRefinementLease extends ProposalMutationReservation {
  operation: 'refine';
  sources: readonly { key: string; entry: ProposalSnapshotEntry }[];
}

const SNAPSHOT_COMMERCIAL_TERM_FIELDS = [
  'brand',
  'start_time',
  'end_time',
  'total_budget',
  'daily_budget_cap',
  'budget_cap_timezone',
  'purchase_order_ref',
] as const;

function safeProposalSnapshot(candidate: Record<string, unknown>): SafeProposalSnapshot | null {
  if (containsCredentialShapedKey(candidate) || containsPresignedUrl(candidate)) return null;
  const proposalId = optionalString(candidate.proposal_id);
  if (!proposalId || proposalId.length > 255) return null;
  const proposal: Record<string, unknown> = { proposal_id: proposalId };
  const proposalStatus = candidate.proposal_status;
  if (proposalStatus !== undefined) {
    if (typeof proposalStatus !== 'string' || !['draft', 'committed', 'accepted'].includes(proposalStatus)) return null;
    proposal.proposal_status = proposalStatus;
  }
  const proposalKind = candidate.proposal_kind;
  if (proposalKind !== undefined) {
    if (
      typeof proposalKind !== 'string' ||
      !['new_media_buy', 'media_buy_update', 'media_buy_cancellation'].includes(proposalKind)
    )
      return null;
    proposal.proposal_kind = proposalKind;
  }
  const termsDigest = candidate.terms_digest;
  if (termsDigest !== undefined) {
    if (typeof termsDigest !== 'string' || !/^sha256:[A-Za-z0-9_-]{43}$/.test(termsDigest)) return null;
    proposal.terms_digest = termsDigest;
  }
  const expiresAt = candidate.expires_at;
  if (expiresAt !== undefined) {
    if (typeof expiresAt !== 'string' || !isStrictDateTime(expiresAt)) return null;
    proposal.expires_at = expiresAt;
  }
  const sourceTerms = record(candidate.commercial_terms);
  let canonicalTermsDigest: string | undefined;
  if (Object.keys(sourceTerms).length > 0) {
    // Inspect the complete seller payload before reducing it to the execution
    // allow-list. A secret in an otherwise unused field must make the proposal
    // ineligible for caching rather than merely disappearing from the snapshot.
    try {
      canonicalTermsDigest = proposalTermsDigest(sourceTerms);
    } catch {
      return null;
    }
    const safeTerms: Record<string, unknown> = {};
    for (const field of SNAPSHOT_COMMERCIAL_TERM_FIELDS) {
      if (sourceTerms[field] !== undefined) safeTerms[field] = sourceTerms[field];
    }
    proposal.commercial_terms = safeTerms;
  }
  return { proposal, ...(canonicalTermsDigest && { canonicalTermsDigest }) };
}

const proposalSnapshotStores = new WeakMap<AgentClient, ProposalSnapshotStoreRegistry>();
const acceptanceReservationOwners = new WeakMap<AcceptanceReservation, MediaBuyLifecycleCoordinator>();
const MAX_PRINCIPAL_STORES_PER_AGENT = 256;
const RETIRED_ACCEPTANCE_SEGMENT_COUNT = 256;
const RETIRED_ACCEPTANCE_SEGMENT_BYTES = 256 * 1024;

function proposalSnapshotStoreFor(agent: AgentClient, principalScope?: string): ProposalSnapshotStore {
  let registry = proposalSnapshotStores.get(agent);
  if (!registry) {
    registry = { stores: new Map() };
    proposalSnapshotStores.set(agent, registry);
  }
  const key = principalScope === undefined ? '\u0000unscoped' : `principal:${principalScope}`;
  const existing = registry.stores.get(key);
  if (existing) {
    existing.activeCoordinators += 1;
    return existing;
  }
  if (registry.stores.size >= MAX_PRINCIPAL_STORES_PER_AGENT) {
    for (const [candidateKey, candidate] of registry.stores) {
      if (
        candidate.activeCoordinators === 0 &&
        candidate.entries.size === 0 &&
        candidate.proposalAcceptances.size === 0 &&
        candidate.pendingDeclines.size === 0 &&
        candidate.pendingRefinements.size === 0
      ) {
        registry.stores.delete(candidateKey);
        break;
      }
    }
  }
  if (registry.stores.size >= MAX_PRINCIPAL_STORES_PER_AGENT) {
    throw new ConfigurationError(
      `Media-buy lifecycle principal partitions are limited to ${MAX_PRINCIPAL_STORES_PER_AGENT} per AgentClient. Dispose inactive coordinators or use a separate AgentClient.`,
      'mediaBuy.principalScope'
    );
  }
  const created: ProposalSnapshotStore = {
    entries: new Map(),
    proposalAcceptances: new Map(),
    pendingDeclines: new Set(),
    pendingDeclineProposalIdCount: 0,
    pendingRefinements: new Set(),
    pendingRefinementProposalIdCount: 0,
    bytes: 0,
    registry,
    activeCoordinators: 1,
  };
  registry.stores.set(key, created);
  return created;
}

/**
 * Negotiated compact-first media-buy facade.
 *
 * Every established projection is assembled field-by-field. Tool selection
 * is final before dispatch, so ambiguous failures never trigger a second
 * mutation through the other lifecycle.
 */
export class MediaBuyLifecycleCoordinator {
  readonly negotiated_version: string;
  readonly lifecycle: MediaBuyLifecycle;
  readonly tools: ReadonlySet<string>;

  private readonly allowedLosses: ReadonlySet<MediaBuyCompatibilityLoss>;
  private readonly preferredLifecycle: 'auto' | MediaBuyLifecycle;
  private readonly principalScope?: string;
  private readonly proposalSnapshotStore: ProposalSnapshotStore;
  private readonly pendingProposalTasks = new Map<
    string,
    {
      accountScope?: string;
      project?: (data: unknown) => unknown;
      retainProposals: boolean;
      onPause?: () => void;
      onAuthoritativeFailure?: () => void;
      authoritativeTaskNames?: ReadonlySet<string>;
      preserveAuthoritativeProposals?: boolean;
      onTerminalFailure?: () => void;
    }
  >();
  private readonly pendingProposalTaskTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private proposalTaskUnsubscribe?: () => void;
  private readonly pendingAcceptanceTasks = new Map<
    string,
    { snapshotKey: string; snapshot: ProposalSnapshotEntry; reservation: AcceptanceReservation }
  >();
  private readonly ownedAcceptanceReservations = new Map<
    AcceptanceReservation,
    { snapshotKey: string; snapshot: ProposalSnapshotEntry }
  >();
  private readonly pendingAcceptanceTaskTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly acceptanceRetryExpiryTimers = new Map<AcceptanceReservation, ReturnType<typeof setTimeout>>();
  private readonly proposalDispatchUnsubscribes = new Set<() => void>();
  private readonly declineLeaseOwner = {};
  private readonly refinementLeaseOwner = {};
  private acceptanceTaskUnsubscribe?: () => void;
  private disposed = false;
  private readonly idempotencyReplayTtlMs?: number;
  private static readonly MAX_PROPOSAL_SNAPSHOTS = 256;
  private static readonly MAX_PROPOSAL_SNAPSHOT_BYTES = 256 * 1024;
  private static readonly MAX_PROPOSAL_SNAPSHOT_TOTAL_BYTES = 4 * 1024 * 1024;
  private static readonly MAX_PRINCIPAL_SCOPE_BYTES = 256;
  private static readonly MAX_PENDING_DECLINES = 256;
  private static readonly MAX_PENDING_DECLINE_PROPOSAL_IDS = 1024;
  private static readonly MAX_PENDING_REFINEMENTS = 256;
  private static readonly MAX_PENDING_REFINEMENT_PROPOSAL_IDS = 1024;
  private static readonly PROPOSAL_TASK_WATCH_TTL_MS = 5 * 60 * 1000;

  private constructor(
    private readonly agent: AgentClient,
    capabilities: AdcpCapabilities,
    options: MediaBuyLifecycleCoordinatorOptions
  ) {
    this.negotiated_version = negotiatedVersion(capabilities, agent.getAdcpVersion());
    this.tools = new Set([...(capabilities.mediaBuyLifecycleTools ?? []), ...(capabilities.discoveredTools ?? [])]);
    this.preferredLifecycle = options.preferredLifecycle ?? 'auto';
    this.allowedLosses = new Set(options.allowedLosses ?? []);
    const replayTtlSeconds = capabilities.idempotency?.replayTtlSeconds;
    if (replayTtlSeconds !== undefined) {
      assertValidIdempotencyReplayTtlSeconds(replayTtlSeconds);
      this.idempotencyReplayTtlMs = replayTtlSeconds * 1000;
    }
    if (options.principalScope !== undefined) {
      if (typeof options.principalScope !== 'string' || options.principalScope.trim().length === 0) {
        throw new TypeError('Media-buy lifecycle principalScope must be a non-empty string when provided.');
      }
      const normalizedScope = options.principalScope.trim();
      if (/[\u0000-\u001f\u007f]/.test(normalizedScope)) {
        throw new TypeError('Media-buy lifecycle principalScope must not contain control characters.');
      }
      if (
        new TextEncoder().encode(normalizedScope).byteLength > MediaBuyLifecycleCoordinator.MAX_PRINCIPAL_SCOPE_BYTES
      ) {
        throw new TypeError(
          `Media-buy lifecycle principalScope must be at most ${MediaBuyLifecycleCoordinator.MAX_PRINCIPAL_SCOPE_BYTES} UTF-8 bytes.`
        );
      }
    }
    this.principalScope = options.principalScope?.trim();
    this.lifecycle = this.selectLifecycle('list_products');
    this.proposalSnapshotStore = proposalSnapshotStoreFor(agent, this.principalScope);
  }

  static async negotiate(
    agent: AgentClient,
    options: MediaBuyLifecycleCoordinatorOptions = {}
  ): Promise<MediaBuyLifecycleCoordinator> {
    return new MediaBuyLifecycleCoordinator(agent, await agent.getCapabilities(), options);
  }

  /** Initial negotiation report. Operation calls return their own exact tool report. */
  report(): MediaBuyCompatibilityReport {
    return this.makeReport(this.lifecycle, [], []);
  }

  private assertActive(operation: string): void {
    if (!this.disposed) return;
    throw new ConfigurationError(
      `Cannot call ${operation} after disposing the media-buy lifecycle coordinator. Negotiate a new coordinator.`,
      'mediaBuy.lifecycleCoordinator'
    );
  }

  private pendingDeclineRetryCandidate(proposalIds: readonly string[]): PendingDeclineLease | undefined {
    const wanted = new Set(proposalIds);
    const overlapping = [...this.proposalSnapshotStore.pendingDeclines].filter(
      lease => lease.state !== 'retired' && lease.proposalIds.some(proposalId => wanted.has(proposalId))
    );
    const candidate = overlapping.length === 1 ? overlapping[0] : undefined;
    return candidate &&
      candidate.proposalIds.length === wanted.size &&
      candidate.proposalIds.every(proposalId => wanted.has(proposalId)) &&
      (candidate.state === 'paused' || candidate.state === 'commit-uncertain')
      ? candidate
      : undefined;
  }

  private pendingRefinementRetryCandidate(proposalIds: readonly string[]): PendingRefinementLease | undefined {
    const wanted = new Set(proposalIds);
    const overlapping = [...this.proposalSnapshotStore.pendingRefinements].filter(
      lease => lease.state !== 'retired' && lease.proposalIds.some(proposalId => wanted.has(proposalId))
    );
    const candidate = overlapping.length === 1 ? overlapping[0] : undefined;
    return candidate &&
      candidate.proposalIds.length === wanted.size &&
      candidate.proposalIds.every(proposalId => wanted.has(proposalId)) &&
      (candidate.state === 'paused' || candidate.state === 'commit-uncertain')
      ? candidate
      : undefined;
  }

  private mutationAttemptIsCurrent(
    reservation: PendingDeclineLease | PendingRefinementLease,
    attemptEpoch: number
  ): boolean {
    return reservation.state !== 'retired' && reservation.attemptEpoch === attemptEpoch;
  }

  private scheduleProposalMutationTimer(
    reservation: PendingDeclineLease | PendingRefinementLease,
    attemptEpoch: number
  ): void {
    if (reservation.timer) clearTimeout(reservation.timer);
    reservation.timer = undefined;
    if (!this.mutationAttemptIsCurrent(reservation, attemptEpoch)) return;
    const now = Date.now();
    const deadline = reservation.retryDeadlineMs;
    if (reservation.state !== 'in-flight' && (deadline === undefined || deadline <= now)) {
      this.retireAmbiguousProposalMutation(reservation, attemptEpoch);
      return;
    }
    const delay =
      reservation.state === 'in-flight'
        ? Math.min(
            MediaBuyLifecycleCoordinator.PROPOSAL_TASK_WATCH_TTL_MS,
            deadline === undefined ? Number.POSITIVE_INFINITY : deadline - now
          )
        : deadline! - now;
    const timer = setTimeout(() => {
      if (!this.mutationAttemptIsCurrent(reservation, attemptEpoch) || reservation.timer !== timer) return;
      reservation.timer = undefined;
      if (reservation.state === 'in-flight' && deadline !== undefined && Date.now() < deadline) {
        reservation.state = 'commit-uncertain';
        this.scheduleProposalMutationTimer(reservation, attemptEpoch);
        return;
      }
      this.retireAmbiguousProposalMutation(reservation, attemptEpoch);
    }, delay);
    timer.unref?.();
    reservation.timer = timer;
  }

  private assertProposalMutationRetryWindow(
    reservation: PendingDeclineLease | PendingRefinementLease,
    operation: 'declineProposals' | 'refineProposals'
  ): void {
    if (reservation.idempotencyKey && reservation.retryDeadlineMs && reservation.retryDeadlineMs > Date.now()) return;
    this.retireAmbiguousProposalMutation(reservation, reservation.attemptEpoch);
    throw this.unsupported(
      operation,
      operation === 'declineProposals' ? 'proposal_decline_retry_window' : 'proposal_refinement_retry_window',
      'The seller no longer guarantees idempotent replay of this proposal mutation. Reconcile its outcome before any different mutation.'
    );
  }

  private beginProposalMutationRetry<T extends PendingDeclineLease | PendingRefinementLease>(
    reservation: T,
    owner: object,
    operation: 'declineProposals' | 'refineProposals'
  ): T {
    this.assertProposalMutationRetryWindow(reservation, operation);
    if (reservation.timer) clearTimeout(reservation.timer);
    reservation.timer = undefined;
    reservation.attemptEpoch += 1;
    reservation.state = 'in-flight';
    reservation.owner = owner;
    this.scheduleProposalMutationTimer(reservation, reservation.attemptEpoch);
    return reservation;
  }

  private preserveAmbiguousProposalMutation(
    reservation: PendingDeclineLease | PendingRefinementLease,
    attemptEpoch: number,
    state: 'paused' | 'commit-uncertain' = 'commit-uncertain'
  ): void {
    if (!this.mutationAttemptIsCurrent(reservation, attemptEpoch)) return;
    if (!reservation.idempotencyKey || !reservation.retryDeadlineMs || reservation.retryDeadlineMs <= Date.now()) {
      this.retireAmbiguousProposalMutation(reservation, attemptEpoch);
      return;
    }
    // Once an attempt is commit-uncertain, a later local pause cannot weaken
    // the fence back to merely paused.
    if (reservation.state !== 'commit-uncertain') reservation.state = state;
    this.scheduleProposalMutationTimer(reservation, attemptEpoch);
  }

  private retireAmbiguousProposalMutation(
    reservation: PendingDeclineLease | PendingRefinementLease,
    attemptEpoch: number
  ): void {
    if (!this.mutationAttemptIsCurrent(reservation, attemptEpoch)) return;
    reservation.proposalIds.forEach(proposalId => this.markCommitUncertainProposalMutation(proposalId));
    if (reservation.operation === 'decline') this.retirePendingDecline(reservation, attemptEpoch);
    else this.retirePendingRefinement(reservation, attemptEpoch);
  }

  private proposalMutationIdempotency(
    callerValue: unknown,
    retry: PendingDeclineLease | PendingRefinementLease | undefined,
    skipIdempotencyAutoInject: boolean
  ): { idempotencyKey?: string; skipIdempotencyAutoInject: boolean } {
    const callerKey = optionalString(callerValue);
    const retrySkip = retry?.skipIdempotencyAutoInject;
    const effectiveSkip = retrySkip ?? skipIdempotencyAutoInject;
    const idempotencyKey =
      callerKey ?? retry?.idempotencyKey ?? (!effectiveSkip && !retry ? generateIdempotencyKey() : undefined);
    return {
      ...(idempotencyKey && { idempotencyKey }),
      skipIdempotencyAutoInject: effectiveSkip,
    };
  }

  private beginPendingDecline(
    proposalIds: readonly string[],
    requestFingerprintValue: string,
    idempotencyKey: string | undefined,
    skipIdempotencyAutoInject: boolean
  ): PendingDeclineLease {
    const retainedProposalIds = [...new Set(proposalIds)];
    const retry = this.pendingDeclineRetryCandidate(retainedProposalIds);
    const hasPendingDecline = retainedProposalIds.some(proposalId => this.isProposalDeclinePending(proposalId));
    if (hasPendingDecline) {
      if (retry) this.assertProposalMutationRetryWindow(retry, 'declineProposals');
      if (
        retry &&
        retry.idempotencyKey !== undefined &&
        retry.requestFingerprint === requestFingerprintValue &&
        retry.idempotencyKey === idempotencyKey &&
        retry.skipIdempotencyAutoInject === skipIdempotencyAutoInject
      ) {
        return this.beginProposalMutationRetry(retry, this.declineLeaseOwner, 'declineProposals');
      }
      throw this.unsupported(
        'declineProposals',
        retry ? 'proposal_decline_retry' : 'proposal_decline_pending',
        retry
          ? 'A paused proposal decline may retry only the exact same request and idempotency key. No mutation was sent.'
          : 'A requested proposal already has an unresolved decline in this principal scope. Wait for it to finish before declining again.'
      );
    }
    if (retainedProposalIds.some(proposalId => this.isCommitUncertainProposalMutation(proposalId))) {
      throw this.unsupported(
        'declineProposals',
        'proposal_mutation_commit_uncertain',
        'A prior mutation of a requested proposal has an unreconciled outcome. No decline was sent.'
      );
    }
    if (
      retainedProposalIds.some(proposalId => {
        const reservation = this.proposalSnapshotStore.proposalAcceptances.get(proposalId)?.reservation;
        return (
          reservation?.state === 'in-flight' ||
          (reservation?.state === 'retryable' && reservation.retryKind !== 'paused')
        );
      })
    ) {
      throw this.unsupported(
        'declineProposals',
        'proposal_acceptance_pending',
        'A requested proposal has an in-flight or commit-uncertain acceptance in this principal scope. Reconcile or finish that acceptance before declining it.'
      );
    }
    if (retainedProposalIds.some(proposalId => this.isCommitUncertainProposal(proposalId))) {
      throw this.unsupported(
        'declineProposals',
        'proposal_acceptance_commit_uncertain',
        'A requested proposal has an acceptance whose commit outcome is unknown. Reconcile the media buy by natural key before sending a different mutation.'
      );
    }
    if (retainedProposalIds.some(proposalId => this.isAcceptedProposal(proposalId))) {
      throw this.unsupported(
        'declineProposals',
        'proposal_terminal',
        'A requested proposal has already been accepted in this principal scope. No decline was sent.'
      );
    }
    if (retainedProposalIds.some(proposalId => this.isProposalRefinementPending(proposalId))) {
      throw this.unsupported(
        'declineProposals',
        'proposal_refinement_pending',
        'A requested proposal has an unresolved refinement in this principal scope. Wait for that refinement to finish before declining it.'
      );
    }
    if (
      this.proposalSnapshotStore.pendingDeclines.size >= MediaBuyLifecycleCoordinator.MAX_PENDING_DECLINES ||
      this.proposalSnapshotStore.pendingDeclineProposalIdCount + retainedProposalIds.length >
        MediaBuyLifecycleCoordinator.MAX_PENDING_DECLINE_PROPOSAL_IDS
    ) {
      throw new ConfigurationError(
        'Too many media-buy proposal declines are still pending. Complete, cancel, or dispose outstanding decline tasks before dispatching another.',
        'mediaBuy.pendingDeclines'
      );
    }
    const lease: PendingDeclineLease = {
      operation: 'decline',
      proposalIds: retainedProposalIds,
      state: 'in-flight',
      requestFingerprint: requestFingerprintValue,
      ...(idempotencyKey && { idempotencyKey }),
      skipIdempotencyAutoInject,
      attemptEpoch: 1,
      owner: this.declineLeaseOwner,
    };
    if (this.idempotencyReplayTtlMs !== undefined) {
      Object.defineProperty(lease, 'retryDeadlineMs', {
        value: Date.now() + this.idempotencyReplayTtlMs,
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    this.proposalSnapshotStore.pendingDeclines.add(lease);
    this.proposalSnapshotStore.pendingDeclineProposalIdCount += retainedProposalIds.length;
    this.scheduleProposalMutationTimer(lease, lease.attemptEpoch);
    return lease;
  }

  private finishPendingDecline(lease: PendingDeclineLease, attemptEpoch = lease.attemptEpoch): void {
    if (!this.mutationAttemptIsCurrent(lease, attemptEpoch)) return;
    lease.state = 'retired';
    if (lease.timer) clearTimeout(lease.timer);
    lease.timer = undefined;
    this.proposalSnapshotStore.pendingDeclines.delete(lease);
    this.proposalSnapshotStore.pendingDeclineProposalIdCount -= lease.proposalIds.length;
  }

  private retirePendingDecline(lease: PendingDeclineLease, attemptEpoch = lease.attemptEpoch): void {
    if (!this.mutationAttemptIsCurrent(lease, attemptEpoch)) return;
    this.invalidateProposalSnapshots(lease.proposalIds, undefined, false, true);
    this.finishPendingDecline(lease, attemptEpoch);
  }

  private pausePendingDecline(lease: PendingDeclineLease, attemptEpoch = lease.attemptEpoch): void {
    this.preserveAmbiguousProposalMutation(lease, attemptEpoch, 'paused');
  }

  private preparePendingDeclineSettlement(
    lease: PendingDeclineLease,
    response: CompatibleDeclineProposalsResponse,
    attemptEpoch = lease.attemptEpoch
  ): () => void {
    const locallyTerminalIds = response.results
      .filter(result => result.outcome === 'declined' || result.outcome === 'unconfirmed')
      .map(result => result.proposal_id);
    return () => {
      if (!this.mutationAttemptIsCurrent(lease, attemptEpoch)) return;
      this.invalidateProposalSnapshots(locallyTerminalIds, undefined, false, true);
      this.finishPendingDecline(lease, attemptEpoch);
    };
  }

  private isProposalDeclinePending(proposalId: string): boolean {
    for (const lease of this.proposalSnapshotStore.pendingDeclines) {
      if (lease.state !== 'retired' && lease.proposalIds.includes(proposalId)) return true;
    }
    return false;
  }

  private beginPendingRefinement(
    proposalIds: readonly string[],
    rejectTerminalProposal: boolean,
    requestFingerprintValue: string,
    idempotencyKey: string | undefined,
    skipIdempotencyAutoInject: boolean
  ): PendingRefinementLease {
    const retainedProposalIds = [...new Set(proposalIds)];
    const retry = this.pendingRefinementRetryCandidate(retainedProposalIds);
    if (
      retainedProposalIds.some(
        proposalId => this.isProposalRefinementPending(proposalId) || this.isProposalDeclinePending(proposalId)
      )
    ) {
      if (retry) this.assertProposalMutationRetryWindow(retry, 'refineProposals');
      if (
        retry &&
        !retainedProposalIds.some(proposalId => this.isProposalDeclinePending(proposalId)) &&
        retry.idempotencyKey !== undefined &&
        retry.requestFingerprint === requestFingerprintValue &&
        retry.idempotencyKey === idempotencyKey &&
        retry.skipIdempotencyAutoInject === skipIdempotencyAutoInject
      ) {
        return this.beginProposalMutationRetry(retry, this.refinementLeaseOwner, 'refineProposals');
      }
      throw this.unsupported(
        'refineProposals',
        retry ? 'proposal_refinement_retry' : 'proposal_mutation_pending',
        retry
          ? 'A paused proposal refinement may retry only the exact same request and idempotency key. No mutation was sent.'
          : 'A requested proposal already has an unresolved refinement or decline in this principal scope. Wait for it to finish before refining again.'
      );
    }
    if (retainedProposalIds.some(proposalId => this.isCommitUncertainProposalMutation(proposalId))) {
      throw this.unsupported(
        'refineProposals',
        'proposal_mutation_commit_uncertain',
        'A prior mutation of a requested proposal has an unreconciled outcome. No refinement was sent.'
      );
    }
    if (retainedProposalIds.some(proposalId => this.proposalSnapshotStore.proposalAcceptances.has(proposalId))) {
      throw this.unsupported(
        'refineProposals',
        'proposal_acceptance_pending',
        'A requested proposal is already being accepted in this principal scope. No refinement was sent.'
      );
    }
    if (retainedProposalIds.some(proposalId => this.isCommitUncertainProposal(proposalId))) {
      throw this.unsupported(
        'refineProposals',
        'proposal_acceptance_commit_uncertain',
        'A requested proposal has an acceptance whose commit outcome is unknown. Reconcile the media buy by natural key before refining it.'
      );
    }
    if (
      rejectTerminalProposal &&
      retainedProposalIds.some(proposalId => this.isTerminalAcceptanceProposal(proposalId))
    ) {
      throw this.unsupported(
        'refineProposals',
        'proposal_terminal',
        'A requested proposal is terminal in this principal scope. Only a terminal decline remains safe; no refinement was sent.'
      );
    }
    const wanted = new Set(retainedProposalIds);
    const sources = [...this.proposalSnapshotStore.entries].flatMap(([key, entry]) =>
      entry.principalScope === this.principalScope && wanted.has(String(entry.proposal.proposal_id))
        ? [{ key, entry }]
        : []
    );
    if (sources.some(({ entry }) => entry.acceptance !== undefined)) {
      throw this.unsupported(
        'refineProposals',
        'proposal_acceptance_pending',
        'A requested proposal is already being accepted in this principal scope. No refinement was sent.'
      );
    }
    if (
      this.proposalSnapshotStore.pendingRefinements.size >= MediaBuyLifecycleCoordinator.MAX_PENDING_REFINEMENTS ||
      this.proposalSnapshotStore.pendingRefinementProposalIdCount + retainedProposalIds.length >
        MediaBuyLifecycleCoordinator.MAX_PENDING_REFINEMENT_PROPOSAL_IDS
    ) {
      throw new ConfigurationError(
        'Too many media-buy proposal refinements are still pending. Complete, cancel, or dispose outstanding refinement tasks before dispatching another.',
        'mediaBuy.pendingRefinements'
      );
    }
    const lease: PendingRefinementLease = {
      operation: 'refine',
      proposalIds: retainedProposalIds,
      sources,
      state: 'in-flight',
      requestFingerprint: requestFingerprintValue,
      ...(idempotencyKey && { idempotencyKey }),
      skipIdempotencyAutoInject,
      attemptEpoch: 1,
      owner: this.refinementLeaseOwner,
    };
    if (this.idempotencyReplayTtlMs !== undefined) {
      Object.defineProperty(lease, 'retryDeadlineMs', {
        value: Date.now() + this.idempotencyReplayTtlMs,
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    for (const { entry } of sources) entry.executable = false;
    this.proposalSnapshotStore.pendingRefinements.add(lease);
    this.proposalSnapshotStore.pendingRefinementProposalIdCount += retainedProposalIds.length;
    this.scheduleProposalMutationTimer(lease, lease.attemptEpoch);
    return lease;
  }

  private finishPendingRefinement(lease: PendingRefinementLease, attemptEpoch = lease.attemptEpoch): void {
    if (!this.mutationAttemptIsCurrent(lease, attemptEpoch)) return;
    lease.state = 'retired';
    if (lease.timer) clearTimeout(lease.timer);
    lease.timer = undefined;
    this.proposalSnapshotStore.pendingRefinements.delete(lease);
    this.proposalSnapshotStore.pendingRefinementProposalIdCount -= lease.proposalIds.length;
  }

  private restorePendingRefinement(lease: PendingRefinementLease, attemptEpoch = lease.attemptEpoch): void {
    if (!this.mutationAttemptIsCurrent(lease, attemptEpoch)) return;
    this.finishPendingRefinement(lease, attemptEpoch);
    for (const { key, entry } of lease.sources) {
      const proposalId = String(entry.proposal.proposal_id);
      if (
        this.proposalSnapshotStore.entries.get(key) === entry &&
        !this.isTerminalProposal(proposalId) &&
        !this.isCommitUncertainProposalMutation(proposalId)
      ) {
        entry.executable = true;
      }
    }
  }

  private retirePendingRefinement(lease: PendingRefinementLease, attemptEpoch = lease.attemptEpoch): void {
    if (!this.mutationAttemptIsCurrent(lease, attemptEpoch)) return;
    this.finishPendingRefinement(lease, attemptEpoch);
    this.invalidateProposalSnapshots(lease.proposalIds, undefined, false, true);
  }

  private pausePendingRefinement(lease: PendingRefinementLease, attemptEpoch = lease.attemptEpoch): void {
    this.preserveAmbiguousProposalMutation(lease, attemptEpoch, 'paused');
  }

  private settlePendingRefinement(
    lease: PendingRefinementLease,
    response: CompatibleRefineProposalsResponse,
    attemptEpoch = lease.attemptEpoch
  ): void {
    this.preparePendingRefinementSettlement(lease, response, attemptEpoch)();
  }

  private preparePendingRefinementSettlement(
    lease: PendingRefinementLease,
    response: CompatibleRefineProposalsResponse,
    attemptEpoch = lease.attemptEpoch
  ): () => void {
    const unableProposalIds = new Set(
      response.outcome === 'native_results'
        ? (response.results ?? [])
            .filter(result => result.outcome === 'unable')
            .map(result => result.source_proposal_id)
        : []
    );
    const replacementProposalIds = new Set(
      response.outcome === 'legacy_projected'
        ? (response.proposals ?? [])
            .map(proposal => optionalString(record(proposal).proposal_id))
            .filter((proposalId): proposalId is string => proposalId !== undefined)
        : []
    );
    return () => {
      if (!this.mutationAttemptIsCurrent(lease, attemptEpoch)) return;
      this.finishPendingRefinement(lease, attemptEpoch);
      const replacementSourceIds = lease.proposalIds.filter(proposalId => replacementProposalIds.has(proposalId));
      const terminalProposalIds = lease.proposalIds.filter(
        proposalId => !unableProposalIds.has(proposalId) && !replacementProposalIds.has(proposalId)
      );
      // A legacy exact replay after an ambiguous first attempt cannot prove
      // that a same-ID proposal row is a fresh immutable source rather than
      // the already-consumed pre-mutation snapshot. Keep that source retired;
      // distinct child proposal IDs returned by the replay are still cached.
      this.invalidateProposalSnapshots(replacementSourceIds, undefined, false, attemptEpoch > 1);
      this.invalidateProposalSnapshots(terminalProposalIds, undefined, false, true);
      for (const { key, entry } of lease.sources) {
        const proposalId = String(entry.proposal.proposal_id);
        if (
          unableProposalIds.has(proposalId) &&
          this.proposalSnapshotStore.entries.get(key) === entry &&
          !this.isTerminalProposal(proposalId)
        ) {
          entry.executable = true;
        }
      }
    };
  }

  private isProposalRefinementPending(proposalId: string): boolean {
    for (const lease of this.proposalSnapshotStore.pendingRefinements) {
      if (lease.state !== 'retired' && lease.proposalIds.includes(proposalId)) return true;
    }
    return false;
  }

  private selectLifecycle(compactTool: string): MediaBuyLifecycle {
    const establishedTool = ESTABLISHED_TOOL_FOR_COMPACT[compactTool as CompactLifecycleToolName];
    if (this.preferredLifecycle === 'established') {
      if (isCompactRelease(this.negotiated_version) && !this.tools.has(establishedTool)) {
        throw this.unsupported(
          compactTool,
          'established_lifecycle_not_advertised',
          `The seller provides no discovery evidence that ${establishedTool} is callable. ` +
            'The forced established diagnostic lane was not selected.',
          'compact'
        );
      }
      return 'established';
    }
    if (isCompactRelease(this.negotiated_version) && this.tools.has(compactTool)) return 'compact';
    if (this.preferredLifecycle === 'compact') {
      throw this.unsupported(
        compactTool,
        compactTool,
        `The negotiated ${this.negotiated_version} lifecycle does not advertise ${compactTool}.`
      );
    }
    if (isCompactRelease(this.negotiated_version) && !this.tools.has(establishedTool)) {
      throw this.unsupported(
        compactTool,
        'lifecycle_tool_not_advertised',
        `The seller advertises neither ${compactTool} nor its established counterpart ${establishedTool}. No request was sent.`,
        'compact'
      );
    }
    return 'established';
  }

  private assertSharedToolAdvertised(tool: 'get_media_buys' | 'get_media_buy_delivery'): void {
    if (!isCompactRelease(this.negotiated_version) || this.tools.has(tool)) return;
    throw this.unsupported(
      tool,
      'lifecycle_tool_not_advertised',
      `The negotiated ${this.negotiated_version} seller does not advertise ${tool}. No request was sent.`,
      this.lifecycle
    );
  }

  private makeReport(
    lifecycle: MediaBuyLifecycle,
    toolsUsed: string[],
    losses: MediaBuyCompatibilityLoss[],
    warnings: string[] = []
  ): MediaBuyCompatibilityReport {
    return {
      negotiated_version: this.negotiated_version,
      lifecycle,
      tools_used: toolsUsed,
      compatibility: lifecycle === 'compact' ? 'native' : losses.length ? 'lossy_projection' : 'lossless_projection',
      warnings,
      losses,
    };
  }

  private unsupported(
    operation: string,
    feature: string,
    message: string,
    lifecycle: MediaBuyLifecycle = 'established'
  ): MediaBuyLifecycleCompatibilityError {
    return new MediaBuyLifecycleCompatibilityError({
      operation,
      negotiatedVersion: this.negotiated_version,
      lifecycle,
      feature: safeDiagnostic(feature, 512),
      message: safeDiagnostic(message, 2048),
    });
  }

  private requireAllowed(operation: string, losses: MediaBuyCompatibilityLoss[]): void {
    const refused = losses.filter(loss => !this.allowedLosses.has(loss));
    if (!refused.length) return;
    throw new MediaBuyLifecycleCompatibilityError({
      operation,
      negotiatedVersion: this.negotiated_version,
      lifecycle: 'established',
      feature: refused.join(', '),
      losses: refused,
      message:
        `${operation} cannot preserve ${refused.join(', ')} on the established lifecycle. ` +
        `No mutation was sent. Opt in with allowedLosses only after accepting the named guarantee loss.`,
    });
  }

  private assertValidCompactRequest(
    tool: CompactLifecycleToolName,
    params: unknown,
    lifecycle: MediaBuyLifecycle,
    mutating = false
  ): void {
    const input = record(params);
    const candidate =
      mutating && !optionalString(input.idempotency_key)
        ? { ...input, idempotency_key: generateIdempotencyKey() }
        : input;
    const result = TOOL_REQUEST_SCHEMAS[tool]!.safeParse(candidate);
    if (result.success) return;
    const details = result.error.issues
      .slice(0, 5)
      .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw this.unsupported(
      tool,
      'compact_request_validation',
      `The compact ${tool} intent is invalid and was not projected: ${details}`,
      lifecycle
    );
  }

  private assertOnlyFields(operation: string, value: Record<string, unknown>, allowed: ReadonlySet<string>): void {
    const unsupportedFields = Object.keys(value).filter(key => !allowed.has(key));
    if (unsupportedFields.length === 0) return;
    throw this.unsupported(
      operation,
      unsupportedFields.join(','),
      `${operation} fields ${unsupportedFields.join(', ')} have no declared compatibility projection.`
    );
  }

  private assertCompactWireFieldsAbsent(
    operation: string,
    value: Record<string, unknown>,
    fields: readonly string[]
  ): void {
    if (isCompactRelease(this.negotiated_version)) return;
    const unsupportedFields = fields.filter(field => Object.hasOwn(value, field));
    if (unsupportedFields.length === 0) return;
    throw this.unsupported(
      operation,
      unsupportedFields.join(','),
      `The negotiated ${this.negotiated_version} established tool cannot represent compact fields ${unsupportedFields.join(
        ', '
      )}. No mutation was sent.`
    );
  }

  private assertLegacyReferenceShapes(operation: string, input: Record<string, unknown>): void {
    if (isCompactRelease(this.negotiated_version)) return;
    const rejectBrandCountries = (brand: unknown, path: string): void => {
      if (Object.hasOwn(record(brand), 'countries')) {
        throw this.unsupported(
          operation,
          `${path}.countries`,
          `The negotiated ${this.negotiated_version} BrandRef cannot represent compact country-qualified identity. No request was sent.`
        );
      }
    };
    if (input.brand !== undefined) rejectBrandCountries(input.brand, 'brand');
    if (input.account !== undefined) {
      const account = record(input.account);
      for (const field of ['operator_unit', 'currency', 'timezone']) {
        if (Object.hasOwn(account, field)) {
          throw this.unsupported(
            operation,
            `account.${field}`,
            `The negotiated ${this.negotiated_version} AccountRef cannot represent compact ${field} identity. No request was sent.`
          );
        }
      }
      if (account.brand !== undefined) rejectBrandCountries(account.brand, 'account.brand');
    }
  }

  private assertLegacyOfferFilterShapes(operation: string, offerFilters: Record<string, unknown>): void {
    if (isCompactRelease(this.negotiated_version)) return;
    if (offerFilters.is_fixed_price === false) {
      throw this.unsupported(
        operation,
        'criteria.offer_filters.is_fixed_price',
        'Legacy is_fixed_price=false also matches contingent pricing, while compact filtering excludes it. No request was sent.'
      );
    }
    for (const field of ['required_performance_standards', 'required_vendor_metrics']) {
      for (const [index, item] of array(offerFilters[field]).entries()) {
        if (Object.hasOwn(record(record(item).vendor), 'countries')) {
          throw this.unsupported(
            operation,
            `criteria.offer_filters.${field}[${index}].vendor.countries`,
            `The negotiated ${this.negotiated_version} vendor BrandRef cannot represent compact country-qualified identity. No request was sent.`
          );
        }
      }
    }
  }

  private assertLegacyTargetingOverlay(operation: string, value: unknown, path: string): void {
    if (value === undefined || isCompactRelease(this.negotiated_version)) return;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw this.unsupported(operation, path, `${path} must be an object. No request was sent.`);
    }
    const targeting = value as Record<string, unknown>;
    if (compareRelease(this.negotiated_version, '3.0') < 0) {
      if (Object.keys(targeting).length > 0) {
        throw this.unsupported(
          operation,
          path,
          `The negotiated ${this.negotiated_version} targeting field names are not compatible with compact targeting_overlay. No request was sent.`
        );
      }
      return;
    }
    const allowed = compareRelease(this.negotiated_version, '3.1') >= 0 ? V31_TARGETING_FIELDS : V30_TARGETING_FIELDS;
    const unsupported = Object.keys(targeting).filter(field => !allowed.has(field));
    if (unsupported.length > 0) {
      throw this.unsupported(
        operation,
        `${path}.${unsupported.join(',')}`,
        `The negotiated ${this.negotiated_version} targeting schema cannot represent ${unsupported.join(
          ', '
        )}. No request was sent.`
      );
    }
    for (const [index, language] of array(targeting.language).entries()) {
      if (typeof language !== 'string' || !/^[a-z]{2}$/.test(language)) {
        throw this.unsupported(
          operation,
          `${path}.language[${index}]`,
          `The negotiated ${this.negotiated_version} targeting schema accepts only two-letter lowercase language codes. No request was sent.`
        );
      }
    }
    if (compareRelease(this.negotiated_version, '3.1') >= 0) return;
    for (const field of ['geo_postal_areas', 'geo_postal_areas_exclude']) {
      for (const [index, areaValue] of array(targeting[field]).entries()) {
        const area = record(areaValue);
        if (Object.hasOwn(area, 'country') || !V30_POSTAL_SYSTEMS.has(String(area.system))) {
          throw this.unsupported(
            operation,
            `${path}.${field}[${index}]`,
            `The negotiated ${this.negotiated_version} postal targeting supports only legacy country-fused postal systems. No request was sent.`
          );
        }
      }
    }
  }

  private assertLegacyMetrics(operation: string, value: unknown, path: string): void {
    if (value === undefined || isCompactRelease(this.negotiated_version)) return;
    const supported =
      compareRelease(this.negotiated_version, '3.1') >= 0
        ? V31_AVAILABLE_METRICS
        : compareRelease(this.negotiated_version, '3.0') >= 0
          ? V30_AVAILABLE_METRICS
          : V25_AVAILABLE_METRICS;
    const unsupported = array(value).filter(metric => typeof metric !== 'string' || !supported.has(metric));
    if (unsupported.length === 0) return;
    throw this.unsupported(
      operation,
      path,
      `The negotiated ${this.negotiated_version} metric enum cannot represent ${unsupported.map(String).join(', ')}. No request was sent.`
    );
  }

  private assertLegacyReportingWebhook(operation: string, value: unknown, path = 'reporting_webhook'): void {
    if (value === undefined || isCompactRelease(this.negotiated_version)) return;
    this.assertLegacyMetrics(operation, record(value).requested_metrics, `${path}.requested_metrics`);
  }

  private assertLegacyPushNotification(operation: string, value: unknown): void {
    if (value === undefined || isCompactRelease(this.negotiated_version)) return;
    const config = record(value);
    if (compareRelease(this.negotiated_version, '3.0') < 0 && config.authentication === undefined) {
      throw this.unsupported(
        operation,
        'push_notification_config.authentication',
        `The negotiated ${this.negotiated_version} push notification schema requires explicit authentication. No request was sent.`
      );
    }
    if (compareRelease(this.negotiated_version, '3.1') < 0 && Object.hasOwn(config, 'operation_id')) {
      throw this.unsupported(
        operation,
        'push_notification_config.operation_id',
        `The negotiated ${this.negotiated_version} push notification registration cannot preserve compact operation_id correlation. No request was sent.`
      );
    }
  }

  private assertLegacyProductFields(operation: string, value: unknown): void {
    if (value === undefined || isCompactRelease(this.negotiated_version)) return;
    const supported = compareRelease(this.negotiated_version, '3.1') >= 0 ? V31_PRODUCT_FIELDS : V30_PRODUCT_FIELDS;
    const unsupported = array(value).filter(field => typeof field !== 'string' || !supported.has(field));
    if (unsupported.length === 0) return;
    throw this.unsupported(
      operation,
      'fields',
      `The negotiated ${this.negotiated_version} product field enum cannot represent ${unsupported
        .map(String)
        .join(', ')}. No request was sent.`
    );
  }

  private assertLegacyReportingDimensions(operation: string, value: unknown): void {
    if (value === undefined || isCompactRelease(this.negotiated_version)) return;
    const dimensions = record(value);
    const unsupported = Object.keys(dimensions).filter(field => !LEGACY_REPORTING_DIMENSIONS.has(field));
    if (unsupported.length > 0) {
      throw this.unsupported(
        operation,
        `reporting_dimensions.${unsupported.join(',')}`,
        `The negotiated ${this.negotiated_version} seller cannot represent reporting dimensions ${unsupported.join(
          ', '
        )}. No request was sent.`
      );
    }
    if (compareRelease(this.negotiated_version, '3.1') >= 0) return;
    const geo = record(dimensions.geo);
    const legacySystems =
      geo.geo_level === 'postal_area' ? V30_POSTAL_SYSTEMS : geo.geo_level === 'metro' ? V30_METRO_SYSTEMS : undefined;
    if (legacySystems && (Object.hasOwn(geo, 'country') || !legacySystems.has(String(geo.system)))) {
      throw this.unsupported(
        operation,
        'reporting_dimensions.geo',
        `The negotiated ${this.negotiated_version} delivery breakdown requires a valid legacy country-fused metro or postal system. No request was sent.`
      );
    }
  }

  private assertProposalLifecycleAvailable(operation: string): void {
    if (compareRelease(this.negotiated_version, '3.0') >= 0) return;
    throw this.unsupported(
      operation,
      'proposal_lifecycle',
      `The negotiated ${this.negotiated_version} seller has no proposal object or proposal-binding mutation. No request was sent.`
    );
  }

  private accountScope(account: unknown): string | undefined {
    const value = record(account);
    return Object.keys(value).length > 0 ? canonicalize(value) : undefined;
  }

  private snapshotKey(proposalId: string, accountScope: string | undefined): string {
    return `${this.principalScope ?? 'missing-principal-scope'}\u0000${accountScope ?? 'unscoped'}\u0000${proposalId}`;
  }

  private proposalScopes(proposalIds: readonly string[]): string[] {
    const wanted = new Set(proposalIds);
    const scopes = new Set<string>();
    for (const entry of this.proposalSnapshotStore.entries.values()) {
      if (
        entry.principalScope === this.principalScope &&
        entry.accountScope &&
        wanted.has(String(entry.proposal.proposal_id))
      ) {
        scopes.add(entry.accountScope);
      }
    }
    return [...scopes];
  }

  private removeProposalSnapshot(key: string): void {
    const existing = this.proposalSnapshotStore.entries.get(key);
    if (existing) {
      this.proposalSnapshotStore.bytes -= existing.bytes;
    }
    this.proposalSnapshotStore.entries.delete(key);
  }

  private retainProposalSnapshot(key: string, entry: ProposalSnapshotEntry): void {
    this.proposalSnapshotStore.entries.set(key, entry);
    this.proposalSnapshotStore.bytes += entry.bytes;
  }

  private isRetiredAcceptanceKey(key: string): boolean {
    const registry = this.proposalSnapshotStore.registry;
    const salt = registry.retiredAcceptanceSalt;
    if (!salt) return false;
    const segmentIndex =
      createHash('sha256')
        .update(salt)
        .update(this.principalScope ?? '\u0000unscoped')
        .digest()
        .readUInt32BE(0) % RETIRED_ACCEPTANCE_SEGMENT_COUNT;
    const bits = registry.retiredAcceptanceSegments?.get(segmentIndex);
    if (!bits) return false;
    return retiredAcceptancePositions(key, salt, bits.length * 8).every(position => {
      const mask = 1 << (position & 7);
      return (bits[position >> 3]! & mask) !== 0;
    });
  }

  private markRetiredAcceptanceKey(key: string): void {
    const registry = this.proposalSnapshotStore.registry;
    const salt = (registry.retiredAcceptanceSalt ??= randomBytes(16));
    const segmentIndex =
      createHash('sha256')
        .update(salt)
        .update(this.principalScope ?? '\u0000unscoped')
        .digest()
        .readUInt32BE(0) % RETIRED_ACCEPTANCE_SEGMENT_COUNT;
    const segments = (registry.retiredAcceptanceSegments ??= new Map());
    let bits = segments.get(segmentIndex);
    if (!bits) {
      bits = new Uint8Array(RETIRED_ACCEPTANCE_SEGMENT_BYTES);
      segments.set(segmentIndex, bits);
    }
    for (const position of retiredAcceptancePositions(key, salt, bits.length * 8)) {
      bits[position >> 3] = bits[position >> 3]! | (1 << (position & 7));
    }
  }

  private terminalProposalKey(proposalId: string): string {
    return `${this.principalScope ?? 'missing-principal-scope'}\u0000terminal-proposal\u0000${proposalId}`;
  }

  private isTerminalProposal(proposalId: string): boolean {
    return this.isRetiredAcceptanceKey(this.terminalProposalKey(proposalId));
  }

  private markTerminalProposal(proposalId: string): void {
    this.markRetiredAcceptanceKey(this.terminalProposalKey(proposalId));
  }

  private terminalAcceptanceProposalKey(proposalId: string): string {
    return `${this.principalScope ?? 'missing-principal-scope'}\u0000terminal-acceptance-proposal\u0000${proposalId}`;
  }

  private isTerminalAcceptanceProposal(proposalId: string): boolean {
    return this.isRetiredAcceptanceKey(this.terminalAcceptanceProposalKey(proposalId));
  }

  private markTerminalAcceptanceProposal(proposalId: string): void {
    this.markRetiredAcceptanceKey(this.terminalAcceptanceProposalKey(proposalId));
  }

  private acceptedProposalKey(proposalId: string): string {
    return `${this.principalScope ?? 'missing-principal-scope'}\u0000accepted-proposal\u0000${proposalId}`;
  }

  private isAcceptedProposal(proposalId: string): boolean {
    return this.isRetiredAcceptanceKey(this.acceptedProposalKey(proposalId));
  }

  private markAcceptedProposal(proposalId: string): void {
    this.markRetiredAcceptanceKey(this.acceptedProposalKey(proposalId));
  }

  private commitUncertainProposalKey(proposalId: string): string {
    return `${this.principalScope ?? 'missing-principal-scope'}\u0000commit-uncertain-proposal\u0000${proposalId}`;
  }

  private isCommitUncertainProposal(proposalId: string): boolean {
    return this.isRetiredAcceptanceKey(this.commitUncertainProposalKey(proposalId));
  }

  private markCommitUncertainProposal(proposalId: string): void {
    this.markRetiredAcceptanceKey(this.commitUncertainProposalKey(proposalId));
  }

  private commitUncertainProposalMutationKey(proposalId: string): string {
    return `${this.principalScope ?? 'missing-principal-scope'}\u0000commit-uncertain-proposal-mutation\u0000${proposalId}`;
  }

  private isCommitUncertainProposalMutation(proposalId: string): boolean {
    return this.isRetiredAcceptanceKey(this.commitUncertainProposalMutationKey(proposalId));
  }

  private markCommitUncertainProposalMutation(proposalId: string): void {
    this.markRetiredAcceptanceKey(this.commitUncertainProposalMutationKey(proposalId));
  }

  private enforceProposalSnapshotLimits(): void {
    while (
      this.proposalSnapshotStore.entries.size > MediaBuyLifecycleCoordinator.MAX_PROPOSAL_SNAPSHOTS ||
      this.proposalSnapshotStore.bytes > MediaBuyLifecycleCoordinator.MAX_PROPOSAL_SNAPSHOT_TOTAL_BYTES
    ) {
      const oldest = [...this.proposalSnapshotStore.entries].find(
        ([, entry]) =>
          entry.acceptance?.state !== 'in-flight' &&
          !this.isProposalRefinementPending(String(entry.proposal.proposal_id))
      );
      if (!oldest) break;
      const [key, entry] = oldest;
      if (entry.acceptance?.state === 'retryable') {
        this.retireAcceptance(key, entry, entry.acceptance);
      } else {
        this.removeProposalSnapshot(key);
      }
    }
  }

  private invalidateProposalSnapshots(
    proposalIds: readonly string[],
    accountScope?: string,
    preserveScope = false,
    retireAcceptances = false
  ): void {
    if (!this.principalScope) return;
    if (retireAcceptances) proposalIds.forEach(proposalId => this.markTerminalProposal(proposalId));
    const wanted = new Set(proposalIds);
    for (const [key, entry] of [...this.proposalSnapshotStore.entries]) {
      if (entry.principalScope !== this.principalScope) continue;
      if (!wanted.has(String(entry.proposal.proposal_id))) continue;
      if (accountScope !== undefined && entry.accountScope !== accountScope) continue;
      if (entry.acceptance) {
        if (retireAcceptances) this.retireAcceptance(key, entry, entry.acceptance);
        continue;
      }
      if (preserveScope && entry.accountScope) {
        this.removeProposalSnapshot(key);
        const proposal = { proposal_id: entry.proposal.proposal_id };
        const bytes = new TextEncoder().encode(`${key}${JSON.stringify(proposal)}`).byteLength;
        this.retainProposalSnapshot(key, {
          proposal,
          bytes,
          principalScope: entry.principalScope,
          executable: false,
          accountScope: entry.accountScope,
        });
      } else {
        this.removeProposalSnapshot(key);
      }
    }
  }

  private proposalIdsIn(data: unknown): string[] {
    const ids = new Set<string>();
    const seen = new WeakSet<object>();
    const stack = [data];
    let visited = 0;
    while (stack.length > 0) {
      const value = stack.pop();
      if (value === null || typeof value !== 'object' || seen.has(value)) continue;
      seen.add(value);
      visited += 1;
      if (visited > MAX_PROPOSAL_TRAVERSAL_NODES) return this.cachedProposalIds();
      if (Array.isArray(value)) {
        if (stack.length + value.length > MAX_PROPOSAL_TRAVERSAL_NODES) return this.cachedProposalIds();
        for (let index = value.length - 1; index >= 0; index -= 1) stack.push(value[index]);
        continue;
      }
      const candidate = value as Record<string, unknown>;
      const proposalId = optionalString(candidate.proposal_id);
      if (proposalId) ids.add(proposalId);
      if (candidate.results !== undefined) stack.push(candidate.results);
      if (candidate.proposal !== undefined) stack.push(candidate.proposal);
      if (candidate.proposals !== undefined) stack.push(candidate.proposals);
    }
    return [...ids];
  }

  private cachedProposalIds(accountScope?: string): string[] {
    if (!this.principalScope) return [];
    const ids = new Set<string>();
    for (const entry of this.proposalSnapshotStore.entries.values()) {
      if (entry.principalScope !== this.principalScope || entry.acceptance) continue;
      if (accountScope !== undefined && entry.accountScope !== accountScope) continue;
      ids.add(String(entry.proposal.proposal_id));
    }
    return [...ids];
  }

  private cachedProposalIdsIn(data: unknown, accountScope?: string): string[] {
    const wanted = new Set(this.cachedProposalIds(accountScope));
    if (wanted.size === 0) return [];
    const found: string[] = [];
    const seen = new WeakSet<object>();
    const stack = [data];
    let visited = 0;
    while (stack.length > 0 && wanted.size > 0) {
      const value = stack.pop();
      if (value === null || typeof value !== 'object' || seen.has(value)) continue;
      seen.add(value);
      visited += 1;
      if (visited > MAX_PROPOSAL_TRAVERSAL_NODES) return this.cachedProposalIds(accountScope);
      if (Array.isArray(value)) {
        if (stack.length + value.length > MAX_PROPOSAL_TRAVERSAL_NODES) {
          return this.cachedProposalIds(accountScope);
        }
        for (let index = value.length - 1; index >= 0; index -= 1) stack.push(value[index]);
        continue;
      }
      const candidate = value as Record<string, unknown>;
      const proposalId = optionalString(candidate.proposal_id);
      if (proposalId && wanted.delete(proposalId)) found.push(proposalId);
      if (candidate.results !== undefined) stack.push(candidate.results);
      if (candidate.proposal !== undefined) stack.push(candidate.proposal);
      if (candidate.proposals !== undefined) stack.push(candidate.proposals);
    }
    return found;
  }

  private safeProposalPayload(data: unknown): { snapshots: SafeProposalSnapshot[] } | undefined {
    const snapshots = new Map<string, { snapshot: SafeProposalSnapshot; bytes: number } | null>();
    const seen = new WeakSet<object>();
    let bytes = 0;
    let overflowed = false;
    const stack = [data];
    let visited = 0;
    try {
      while (stack.length > 0 && !overflowed) {
        const value = stack.pop();
        if (value === null || typeof value !== 'object' || seen.has(value)) continue;
        seen.add(value);
        visited += 1;
        if (visited > MAX_PROPOSAL_TRAVERSAL_NODES) {
          overflowed = true;
          break;
        }
        if (Array.isArray(value)) {
          if (stack.length + value.length > MAX_PROPOSAL_TRAVERSAL_NODES) {
            overflowed = true;
            break;
          }
          for (let index = value.length - 1; index >= 0; index -= 1) stack.push(value[index]);
          continue;
        }
        const candidate = value as Record<string, unknown>;
        const proposalId = optionalString(candidate.proposal_id);
        if (proposalId) {
          if (!snapshots.has(proposalId) && snapshots.size >= MediaBuyLifecycleCoordinator.MAX_PROPOSAL_SNAPSHOTS) {
            overflowed = true;
            return;
          }
          const prior = snapshots.get(proposalId);
          if (prior) bytes -= prior.bytes;
          const safe = safeProposalSnapshot(candidate);
          if (safe) {
            // Detach while this listener still owns the checked representation.
            // Later task-update listeners may mutate the shared TaskInfo object.
            const detached = structuredClone(safe);
            const candidateBytes = new TextEncoder().encode(JSON.stringify(detached.proposal)).byteLength;
            if (
              candidateBytes > MediaBuyLifecycleCoordinator.MAX_PROPOSAL_SNAPSHOT_BYTES ||
              bytes + candidateBytes > MediaBuyLifecycleCoordinator.MAX_PROPOSAL_SNAPSHOT_TOTAL_BYTES
            ) {
              overflowed = true;
              return;
            }
            snapshots.set(proposalId, { snapshot: detached, bytes: candidateBytes });
            bytes += candidateBytes;
          } else {
            // Preserve last-observation semantics: a later unsafe duplicate must
            // revoke an earlier safe representation of the same proposal ID.
            snapshots.set(proposalId, null);
          }
        }
        if (candidate.results !== undefined) stack.push(candidate.results);
        if (candidate.proposal !== undefined) stack.push(candidate.proposal);
        if (candidate.proposals !== undefined) stack.push(candidate.proposals);
      }
    } catch {
      return undefined;
    }
    if (overflowed) return undefined;
    const retained = [...snapshots.values()].flatMap(snapshot => (snapshot ? [snapshot.snapshot] : []));
    return retained.length > 0 ? { snapshots: retained } : undefined;
  }

  private captureProposalDispatch<T, U>(
    accountScope: string | undefined,
    dispatch: () => Promise<TaskResult<T>>,
    adapt: (result: TaskResult<T>) => U,
    projectCompletion?: (data: T) => unknown,
    onCompletionFailure?: () => void,
    retainCompletionProposals = true,
    prepareMatchedCompletion?: (projected: unknown) => () => void,
    onAuthoritativeFailure?: () => void
  ): Promise<U> {
    const captured = new Map<
      string,
      | {
          kind: 'success';
          proposalIds: string[];
          payload?: { snapshots: SafeProposalSnapshot[] };
          settle?: () => void;
          bytes: number;
        }
      | { kind: 'failure'; proposalIds: string[]; authoritative: boolean; bytes: number }
    >();
    let capturedPayloadBytes = 0;
    let captureOverflowed = false;
    const releaseTaskListener = this.agent.onTaskUpdate(task => {
      if (this.disposed) return;
      if (['pending', 'running', 'working', 'submitted'].includes(task.status)) return;
      const operationSucceeded =
        task.status === 'completed' && task.result !== undefined && isAdcpOperationSuccess(task.result, task.taskType);
      const authoritativeFailure =
        task.status === 'failed' ||
        task.status === 'governance-denied' ||
        (task.status === 'completed' &&
          task.result !== undefined &&
          !isAdcpOperationSuccess(task.result, task.taskType));
      let projectedResult = task.result;
      let projectionSucceeded = operationSucceeded;
      if (operationSucceeded && projectCompletion) {
        try {
          projectedResult = projectCompletion(task.result as T);
        } catch {
          projectionSucceeded = false;
        }
      }
      let settle: (() => void) | undefined;
      if (projectionSucceeded && prepareMatchedCompletion) {
        try {
          settle = prepareMatchedCompletion(projectedResult);
        } catch {
          projectionSucceeded = false;
        }
      }
      const safe =
        projectionSucceeded && retainCompletionProposals ? this.safeProposalPayload(projectedResult) : undefined;
      const proposalIds =
        retainCompletionProposals && projectedResult !== undefined
          ? this.cachedProposalIdsIn(projectedResult, accountScope)
          : [];
      const metadataBytes = new TextEncoder().encode(JSON.stringify(proposalIds)).byteLength;
      const safeBytes = safe ? new TextEncoder().encode(JSON.stringify(safe)).byteLength : 0;
      const retainSafe =
        safe !== undefined &&
        metadataBytes + safeBytes <= MediaBuyLifecycleCoordinator.MAX_PROPOSAL_SNAPSHOT_TOTAL_BYTES;
      const bytes = retainSafe ? safeBytes : 0;
      const replaced = captured.get(task.taskId);
      if (replaced) capturedPayloadBytes -= replaced.bytes;
      captured.delete(task.taskId);
      captured.set(
        task.taskId,
        projectionSucceeded
          ? {
              kind: 'success',
              proposalIds,
              ...(retainSafe && { payload: safe }),
              ...(settle && { settle }),
              bytes,
            }
          : { kind: 'failure', proposalIds, authoritative: authoritativeFailure, bytes }
      );
      capturedPayloadBytes += bytes;
      while (capturedPayloadBytes > MediaBuyLifecycleCoordinator.MAX_PROPOSAL_SNAPSHOT_TOTAL_BYTES) {
        const oldestWithPayload = [...captured].find(([, entry]) => entry.kind === 'success' && entry.payload);
        if (!oldestWithPayload) break;
        const [taskId, entry] = oldestWithPayload;
        if (entry.kind !== 'success') continue;
        capturedPayloadBytes -= entry.bytes;
        captured.set(taskId, {
          kind: 'success',
          proposalIds: entry.proposalIds,
          ...(entry.settle && { settle: entry.settle }),
          bytes: 0,
        });
      }
      while (captured.size > 32) {
        const oldest = captured.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        capturedPayloadBytes -= captured.get(oldest)?.bytes ?? 0;
        captured.delete(oldest);
        captureOverflowed = true;
      }
    });
    let released = false;
    const unsubscribe = (): void => {
      if (released) return;
      released = true;
      releaseTaskListener();
      this.proposalDispatchUnsubscribes.delete(unsubscribe);
    };
    this.proposalDispatchUnsubscribes.add(unsubscribe);
    let dispatched: Promise<TaskResult<T>>;
    try {
      dispatched = dispatch();
    } catch (error) {
      unsubscribe();
      return Promise.reject(error);
    }
    return dispatched
      .then(
        result => {
          this.assertActive('proposal dispatch completion');
          const racedCompletion = captured.get(result.metadata.taskId);
          if (racedCompletion?.kind === 'success') {
            racedCompletion.settle?.();
            this.invalidateProposalSnapshots(racedCompletion.proposalIds, accountScope);
            if (racedCompletion.payload) {
              for (const snapshot of racedCompletion.payload.snapshots) {
                this.rememberSafeProposalSnapshot(snapshot, accountScope);
              }
            }
          } else if (racedCompletion?.kind === 'failure') {
            if (racedCompletion.authoritative && onAuthoritativeFailure) {
              onAuthoritativeFailure();
            } else {
              this.invalidateProposalSnapshots(racedCompletion.proposalIds, accountScope);
              onCompletionFailure?.();
            }
          } else if (captureOverflowed) {
            // The dispatch task ID is not knowable until dispatch returns. If
            // unrelated terminal events overflow the bounded correlation map,
            // a missing match might be the evicted task. Retire every mutable
            // snapshot in scope rather than leave stale execution evidence.
            this.invalidateProposalSnapshots(this.cachedProposalIds(accountScope), accountScope);
            onCompletionFailure?.();
          }
          // adaptProjectedResult installs the long-lived watcher, when needed,
          // before this pre-dispatch listener is released.
          const output = adapt(result);
          if (racedCompletion || captureOverflowed) this.forgetProposalTask(result.metadata.taskId);
          return output;
        },
        error => {
          if (this.disposed) throw error;
          // A terminal event can beat a transport failure. Without the
          // dispatch result there is no trustworthy task ID for correlation,
          // so any captured terminal evidence makes every mutable snapshot in
          // this scope unsafe to reuse.
          if (captured.size > 0 || captureOverflowed) {
            this.invalidateProposalSnapshots(this.cachedProposalIds(accountScope), accountScope);
            onCompletionFailure?.();
          }
          throw error;
        }
      )
      .finally(unsubscribe);
  }

  private watchProposalTask(
    taskId: string | undefined,
    accountScope: string | undefined,
    project: ((data: unknown) => unknown) | undefined,
    retainProposals: boolean,
    onPause?: () => void,
    onTerminalFailure?: () => void,
    onAuthoritativeFailure?: () => void,
    preserveAuthoritativeProposals = false,
    authoritativeTaskNames: ReadonlySet<string> = new Set()
  ): void {
    if (!taskId || !this.principalScope) return;
    this.pendingProposalTasks.delete(taskId);
    this.pendingProposalTasks.set(taskId, {
      accountScope,
      ...(project && { project }),
      retainProposals,
      ...(onPause && { onPause }),
      ...(onAuthoritativeFailure && { onAuthoritativeFailure }),
      authoritativeTaskNames,
      ...(preserveAuthoritativeProposals && { preserveAuthoritativeProposals }),
      ...(onTerminalFailure && { onTerminalFailure }),
    });
    const priorTimer = this.pendingProposalTaskTimers.get(taskId);
    if (priorTimer) clearTimeout(priorTimer);
    const timer = setTimeout(() => {
      const pending = this.pendingProposalTasks.get(taskId);
      if (!pending || this.pendingProposalTaskTimers.get(taskId) !== timer) return;
      pending.onTerminalFailure?.();
      this.forgetProposalTask(taskId);
    }, MediaBuyLifecycleCoordinator.PROPOSAL_TASK_WATCH_TTL_MS);
    timer.unref?.();
    this.pendingProposalTaskTimers.set(taskId, timer);
    while (this.pendingProposalTasks.size > MediaBuyLifecycleCoordinator.MAX_PROPOSAL_SNAPSHOTS) {
      const oldest = this.pendingProposalTasks.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.forgetProposalTask(oldest);
    }
    const handleUpdate = (task: import('../core/ConversationTypes').TaskInfo): void => {
      if (this.disposed) return;
      const pending = this.pendingProposalTasks.get(task.taskId);
      if (!pending) return;
      if (
        task.status === 'completed' &&
        task.result !== undefined &&
        pending.authoritativeTaskNames?.has(task.taskType) &&
        isAdcpOperationSuccess(task.result, task.taskType)
      ) {
        try {
          const projected = pending.project ? pending.project(task.result) : task.result;
          if (pending.retainProposals) this.rememberProposals(projected, pending.accountScope);
        } catch {
          this.invalidateProposalSnapshots(this.proposalIdsIn(task.result), pending.accountScope);
          pending.onTerminalFailure?.();
        }
      } else if (['pending', 'running', 'working', 'submitted'].includes(task.status)) {
        return;
      } else if (task.status === 'input-required' || task.status === 'auth-required') {
        pending.onPause?.();
      } else if (
        (task.status === 'failed' || task.status === 'governance-denied' || task.status === 'completed') &&
        pending.authoritativeTaskNames?.has(task.taskType)
      ) {
        if (task.result !== undefined && !pending.preserveAuthoritativeProposals) {
          this.invalidateProposalSnapshots(this.proposalIdsIn(task.result), pending.accountScope);
        }
        pending.onAuthoritativeFailure?.();
      } else {
        if (task.result !== undefined) {
          this.invalidateProposalSnapshots(this.proposalIdsIn(task.result), pending.accountScope);
        }
        pending.onTerminalFailure?.();
      }
      this.forgetProposalTask(task.taskId);
    };
    if (!this.proposalTaskUnsubscribe) {
      this.proposalTaskUnsubscribe = this.agent.onTaskUpdate(handleUpdate);
    }
  }

  private forgetProposalTask(taskId: string): void {
    this.pendingProposalTasks.delete(taskId);
    const timer = this.pendingProposalTaskTimers.get(taskId);
    if (timer) clearTimeout(timer);
    this.pendingProposalTaskTimers.delete(taskId);
    if (this.pendingProposalTasks.size === 0) {
      this.proposalTaskUnsubscribe?.();
      this.proposalTaskUnsubscribe = undefined;
    }
  }

  private ownsAcceptance(
    snapshotKey: string,
    snapshot: ProposalSnapshotEntry,
    reservation: AcceptanceReservation
  ): boolean {
    const proposalId = String(snapshot.proposal.proposal_id);
    const global = this.proposalSnapshotStore.proposalAcceptances.get(proposalId);
    return (
      this.proposalSnapshotStore.entries.get(snapshotKey) === snapshot &&
      snapshot.acceptance === reservation &&
      global?.snapshotKey === snapshotKey &&
      global.snapshot === snapshot &&
      global.reservation === reservation
    );
  }

  private releaseAcceptanceOwnership(reservation: AcceptanceReservation): void {
    const owner = acceptanceReservationOwners.get(reservation);
    if (!owner) return;
    owner.ownedAcceptanceReservations.delete(reservation);
    if (reservation.taskId) owner.forgetAcceptanceTask(reservation.taskId, reservation);
    const retryExpiryTimer = owner.acceptanceRetryExpiryTimers.get(reservation);
    if (retryExpiryTimer) clearTimeout(retryExpiryTimer);
    owner.acceptanceRetryExpiryTimers.delete(reservation);
    acceptanceReservationOwners.delete(reservation);
  }

  private scheduleAcceptanceRetryExpiry(
    snapshotKey: string,
    snapshot: ProposalSnapshotEntry,
    reservation: AcceptanceReservation
  ): void {
    const deadline = reservation.retryDeadlineMs;
    if (deadline === undefined || deadline <= Date.now()) {
      this.retireAcceptance(snapshotKey, snapshot, reservation);
      return;
    }
    const priorTimer = this.acceptanceRetryExpiryTimers.get(reservation);
    if (priorTimer) clearTimeout(priorTimer);
    const timer = setTimeout(() => {
      this.retireAcceptance(snapshotKey, snapshot, reservation);
    }, deadline - Date.now());
    timer.unref?.();
    this.acceptanceRetryExpiryTimers.set(reservation, timer);
  }

  private assertAcceptanceRetryWindow(
    snapshotKey: string,
    snapshot: ProposalSnapshotEntry,
    reservation: AcceptanceReservation
  ): void {
    if (reservation.retryDeadlineMs !== undefined && reservation.retryDeadlineMs > Date.now()) return;
    this.retireAcceptance(snapshotKey, snapshot, reservation);
    throw this.unsupported(
      'acceptProposal',
      'proposal_acceptance_retry_window',
      'The seller no longer guarantees idempotent replay of this paused acceptance. Reconcile by natural key before any new mutation.'
    );
  }

  private restoreAcceptance(
    snapshotKey: string,
    snapshot: ProposalSnapshotEntry,
    reservation: AcceptanceReservation
  ): void {
    if (!this.ownsAcceptance(snapshotKey, snapshot, reservation) || reservation.state !== 'in-flight') return;
    this.proposalSnapshotStore.proposalAcceptances.delete(String(snapshot.proposal.proposal_id));
    this.releaseAcceptanceOwnership(reservation);
    delete snapshot.acceptance;
    if (snapshot.nativeAcceptanceOnly) this.removeProposalSnapshot(snapshotKey);
    else snapshot.executable = true;
  }

  private retireAcceptance(
    snapshotKey: string,
    snapshot: ProposalSnapshotEntry,
    reservation: AcceptanceReservation,
    disposition: 'terminal' | 'accepted' | 'commit-uncertain' = reservation.retryKind === 'commit-uncertain'
      ? 'commit-uncertain'
      : 'terminal'
  ): void {
    if (!this.ownsAcceptance(snapshotKey, snapshot, reservation) || reservation.state === 'retired') return;
    const proposalId = String(snapshot.proposal.proposal_id);
    if (disposition === 'commit-uncertain') {
      this.markCommitUncertainProposal(proposalId);
    } else {
      this.markTerminalAcceptanceProposal(proposalId);
      if (disposition === 'accepted') this.markAcceptedProposal(proposalId);
    }
    reservation.state = 'retired';
    snapshot.executable = false;
    this.proposalSnapshotStore.proposalAcceptances.delete(proposalId);
    this.releaseAcceptanceOwnership(reservation);
    this.markTerminalProposal(proposalId);
    for (const [key, sibling] of [...this.proposalSnapshotStore.entries]) {
      if (sibling.principalScope !== this.principalScope || sibling.proposal.proposal_id !== proposalId) continue;
      if (sibling.acceptance && sibling.acceptance !== reservation) {
        sibling.acceptance.state = 'retired';
        this.releaseAcceptanceOwnership(sibling.acceptance);
      }
      sibling.executable = false;
      this.removeProposalSnapshot(key);
      this.markRetiredAcceptanceKey(key);
    }
  }

  private preserveAmbiguousAcceptance(
    snapshotKey: string,
    snapshot: ProposalSnapshotEntry,
    reservation: AcceptanceReservation,
    taskId?: string,
    retryKind: 'paused' | 'commit-uncertain' = 'commit-uncertain'
  ): void {
    if (!this.ownsAcceptance(snapshotKey, snapshot, reservation) || reservation.state !== 'in-flight') return;
    reservation.retryKind = retryKind;
    if (!reservation.idempotencyKey || reservation.retryDeadlineMs === undefined) {
      this.retireAcceptance(snapshotKey, snapshot, reservation);
      return;
    }
    reservation.state = 'retryable';
    snapshot.executable = false;
    this.watchAcceptanceTask(
      taskId ?? `acceptance-retry:${generateIdempotencyKey()}`,
      snapshotKey,
      snapshot,
      reservation
    );
    this.scheduleAcceptanceRetryExpiry(snapshotKey, snapshot, reservation);
  }

  private transitionAcceptanceResult<T>(
    result: TaskResult<T>,
    snapshotKey: string,
    snapshot: ProposalSnapshotEntry,
    reservation: AcceptanceReservation
  ): void {
    if (!this.ownsAcceptance(snapshotKey, snapshot, reservation) || reservation.state !== 'in-flight') return;
    if (result.status === 'input-required' || result.status === 'auth-required' || result.status === 'deferred') {
      this.preserveAmbiguousAcceptance(snapshotKey, snapshot, reservation, result.metadata.taskId, 'paused');
      return;
    }
    if (
      result.status === 'completed' &&
      result.data !== undefined &&
      !isAdcpOperationSuccess(result.data, result.metadata.taskName)
    ) {
      this.restoreAcceptance(snapshotKey, snapshot, reservation);
      this.forgetAcceptanceTask(result.metadata.taskId, reservation);
      return;
    }
    if (!result.success) {
      if (result.metadata.taskName === 'unknown') {
        this.preserveAmbiguousAcceptance(snapshotKey, snapshot, reservation, result.metadata.taskId);
        return;
      }
      this.restoreAcceptance(snapshotKey, snapshot, reservation);
      this.forgetAcceptanceTask(result.metadata.taskId, reservation);
      return;
    }
    if (result.status === 'working' || result.status === 'submitted') {
      this.watchAcceptanceTask(result.metadata.taskId, snapshotKey, snapshot, reservation);
      return;
    }
    this.retireAcceptance(snapshotKey, snapshot, reservation, 'accepted');
    this.forgetAcceptanceTask(result.metadata.taskId, reservation);
  }

  private transitionAcceptanceTask(
    task: import('../core/ConversationTypes').TaskInfo,
    snapshotKey: string,
    snapshot: ProposalSnapshotEntry,
    reservation: AcceptanceReservation,
    watchedTaskId = task.taskId
  ): void {
    if (!this.ownsAcceptance(snapshotKey, snapshot, reservation) || reservation.state !== 'in-flight') return;
    if (['input-required', 'auth-required', 'needs_input', 'deferred'].includes(task.status)) {
      this.preserveAmbiguousAcceptance(snapshotKey, snapshot, reservation, watchedTaskId, 'paused');
      return;
    }
    if (['pending', 'running', 'working', 'submitted', 'deferred'].includes(task.status)) return;
    if (task.status === 'completed') {
      if (isAdcpOperationSuccess(task.result, task.taskType)) {
        this.retireAcceptance(snapshotKey, snapshot, reservation, 'accepted');
      } else {
        this.restoreAcceptance(snapshotKey, snapshot, reservation);
      }
    } else if (['failed', 'rejected', 'canceled', 'governance-denied'].includes(task.status)) {
      this.restoreAcceptance(snapshotKey, snapshot, reservation);
    } else {
      this.preserveAmbiguousAcceptance(snapshotKey, snapshot, reservation, watchedTaskId);
      return;
    }
    this.forgetAcceptanceTask(watchedTaskId, reservation);
  }

  private watchAcceptanceTask(
    taskId: string | undefined,
    snapshotKey: string,
    snapshot: ProposalSnapshotEntry,
    reservation: AcceptanceReservation
  ): void {
    if (!taskId) return;
    if (reservation.taskId && reservation.taskId !== taskId) {
      this.forgetAcceptanceTask(reservation.taskId, reservation);
    }
    reservation.taskId = taskId;
    this.pendingAcceptanceTasks.set(taskId, { snapshotKey, snapshot, reservation });
    const priorTimer = this.pendingAcceptanceTaskTimers.get(taskId);
    if (priorTimer) clearTimeout(priorTimer);
    const timer = setTimeout(() => {
      if (reservation.state === 'in-flight') {
        this.retireAcceptance(snapshotKey, snapshot, reservation, 'commit-uncertain');
      }
      this.forgetAcceptanceTask(taskId, reservation);
    }, MediaBuyLifecycleCoordinator.PROPOSAL_TASK_WATCH_TTL_MS);
    timer.unref?.();
    this.pendingAcceptanceTaskTimers.set(taskId, timer);
    const handleUpdate = (task: import('../core/ConversationTypes').TaskInfo): void => {
      if (this.disposed) return;
      const pending = this.pendingAcceptanceTasks.get(task.taskId);
      if (!pending) return;
      this.transitionAcceptanceTask(task, pending.snapshotKey, pending.snapshot, pending.reservation, task.taskId);
    };
    if (!this.acceptanceTaskUnsubscribe) {
      this.acceptanceTaskUnsubscribe = this.agent.onTaskUpdate(handleUpdate);
    }
  }

  private forgetAcceptanceTask(taskId: string, reservation?: AcceptanceReservation): void {
    const pending = this.pendingAcceptanceTasks.get(taskId);
    if (reservation && pending?.reservation !== reservation) return;
    this.pendingAcceptanceTasks.delete(taskId);
    const timer = this.pendingAcceptanceTaskTimers.get(taskId);
    if (timer) clearTimeout(timer);
    this.pendingAcceptanceTaskTimers.delete(taskId);
    if (this.pendingAcceptanceTasks.size === 0) {
      this.acceptanceTaskUnsubscribe?.();
      this.acceptanceTaskUnsubscribe = undefined;
    }
  }

  private attachAcceptanceTransitions<T>(
    result: TaskResult<T>,
    snapshotKey: string,
    snapshot: ProposalSnapshotEntry,
    reservation: AcceptanceReservation
  ): TaskResult<T> {
    this.assertActive('acceptance result projection');
    const localTaskId = result.metadata.taskId;
    this.transitionAcceptanceResult(result, snapshotKey, snapshot, reservation);
    if (result.submitted) {
      const submitted = result.submitted;
      (result as { submitted?: unknown }).submitted = {
        ...submitted,
        track: async (transport?: import('../protocols').TransportOptions) => {
          try {
            this.assertActive('acceptance track continuation');
            const task = await submitted.track(transport);
            this.assertActive('acceptance track continuation');
            this.transitionAcceptanceTask(task, snapshotKey, snapshot, reservation, localTaskId);
            return task;
          } catch (error) {
            if (!this.disposed) {
              this.preserveAmbiguousAcceptance(snapshotKey, snapshot, reservation, localTaskId);
            }
            throw error;
          }
        },
        waitForCompletion: async (pollInterval?: number, signal?: AbortSignal) => {
          try {
            this.assertActive('acceptance completion continuation');
            const completed = await submitted.waitForCompletion(pollInterval, signal);
            this.assertActive('acceptance completion continuation');
            this.transitionAcceptanceResult(completed, snapshotKey, snapshot, reservation);
            return completed;
          } catch (error) {
            if (!this.disposed) {
              this.preserveAmbiguousAcceptance(snapshotKey, snapshot, reservation, localTaskId);
            }
            throw error;
          }
        },
      };
    }
    if (result.deferred) {
      const deferred = result.deferred;
      (result as { deferred?: unknown }).deferred = {
        ...deferred,
        resume: async (input: unknown) => {
          try {
            this.assertActive('acceptance resume continuation');
            if (
              !this.ownsAcceptance(snapshotKey, snapshot, reservation) ||
              reservation.state !== 'retryable' ||
              reservation.retryKind !== 'paused'
            ) {
              throw this.unsupported(
                'acceptProposal',
                'proposal_acceptance_continuation_stale',
                'This deferred acceptance continuation no longer owns the shared reservation. No continuation was sent.'
              );
            }
            this.assertAcceptanceRetryWindow(snapshotKey, snapshot, reservation);
            if (reservation.taskId) this.forgetAcceptanceTask(reservation.taskId, reservation);
            const retryTimer = this.acceptanceRetryExpiryTimers.get(reservation);
            if (retryTimer) clearTimeout(retryTimer);
            this.acceptanceRetryExpiryTimers.delete(reservation);
            reservation.state = 'in-flight';
            delete reservation.retryKind;
            const resumed = await deferred.resume(input);
            this.assertActive('acceptance resume continuation');
            return this.attachAcceptanceTransitions(resumed, snapshotKey, snapshot, reservation);
          } catch (error) {
            if (!this.disposed) {
              this.preserveAmbiguousAcceptance(snapshotKey, snapshot, reservation, localTaskId);
            }
            throw error;
          }
        },
      };
    }
    return result;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const unsubscribe of [...this.proposalDispatchUnsubscribes]) unsubscribe();
    for (const decline of [...this.proposalSnapshotStore.pendingDeclines]) {
      if (decline.owner !== this.declineLeaseOwner) continue;
      this.preserveAmbiguousProposalMutation(decline, decline.attemptEpoch);
    }
    for (const refinement of [...this.proposalSnapshotStore.pendingRefinements]) {
      if (refinement.owner !== this.refinementLeaseOwner) continue;
      this.preserveAmbiguousProposalMutation(refinement, refinement.attemptEpoch);
    }
    for (const taskId of [...this.pendingProposalTasks.keys()]) this.forgetProposalTask(taskId);
    this.proposalTaskUnsubscribe?.();
    this.proposalTaskUnsubscribe = undefined;
    for (const [reservation, pending] of [...this.ownedAcceptanceReservations]) {
      this.retireAcceptance(
        pending.snapshotKey,
        pending.snapshot,
        reservation,
        reservation.state === 'in-flight' || reservation.retryKind === 'commit-uncertain'
          ? 'commit-uncertain'
          : 'terminal'
      );
      this.releaseAcceptanceOwnership(reservation);
    }
    this.acceptanceTaskUnsubscribe?.();
    this.acceptanceTaskUnsubscribe = undefined;
    this.proposalSnapshotStore.activeCoordinators -= 1;
  }

  private rememberProposals(data: unknown, accountScope?: string): void {
    if (this.disposed || !this.principalScope) return;
    const seen = new WeakSet<object>();
    const stack = [data];
    let visited = 0;
    while (stack.length > 0) {
      const value = stack.pop();
      if (value === null || typeof value !== 'object' || seen.has(value)) continue;
      seen.add(value);
      visited += 1;
      if (visited > MAX_PROPOSAL_TRAVERSAL_NODES) {
        this.invalidateProposalSnapshots(this.cachedProposalIds(accountScope), accountScope);
        return;
      }
      if (Array.isArray(value)) {
        if (stack.length + value.length > MAX_PROPOSAL_TRAVERSAL_NODES) {
          this.invalidateProposalSnapshots(this.cachedProposalIds(accountScope), accountScope);
          return;
        }
        for (let index = value.length - 1; index >= 0; index -= 1) stack.push(value[index]);
        continue;
      }
      const candidate = value as Record<string, unknown>;
      const proposalId = optionalString(candidate.proposal_id);
      if (proposalId) {
        if (this.isProposalRefinementPending(proposalId)) continue;
        const key = this.snapshotKey(proposalId, accountScope);
        if (this.isTerminalProposal(proposalId) || this.isRetiredAcceptanceKey(key)) continue;
        if (this.proposalSnapshotStore.entries.get(key)?.acceptance) continue;
        // A newly observed seller representation supersedes the prior one.
        // Invalidate first so an unsafe, oversized, or unserializable
        // replacement cannot leave stale executable terms behind.
        this.removeProposalSnapshot(key);
        try {
          const safeSnapshot = safeProposalSnapshot(candidate);
          if (!safeSnapshot) continue;
          this.rememberSafeProposalSnapshot(safeSnapshot, accountScope);
        } catch {
          // Seller responses must be JSON. An unserializable proposal is not a
          // safe immutable acceptance snapshot, so leave it out of the cache.
        }
      }
      if (candidate.results !== undefined) stack.push(candidate.results);
      if (candidate.proposal !== undefined) stack.push(candidate.proposal);
      if (candidate.proposals !== undefined) stack.push(candidate.proposals);
    }
  }

  private rememberSafeProposalSnapshot(snapshot: SafeProposalSnapshot, accountScope?: string): void {
    if (this.disposed || !this.principalScope) return;
    const proposalId = optionalString(snapshot.proposal.proposal_id);
    if (!proposalId) return;
    if (this.isProposalRefinementPending(proposalId)) return;
    const key = this.snapshotKey(proposalId, accountScope);
    if (
      this.isTerminalProposal(proposalId) ||
      this.isRetiredAcceptanceKey(key) ||
      this.proposalSnapshotStore.entries.get(key)?.acceptance
    ) {
      return;
    }
    this.removeProposalSnapshot(key);
    const bytes = new TextEncoder().encode(`${key}${JSON.stringify(snapshot)}`).byteLength;
    if (bytes > MediaBuyLifecycleCoordinator.MAX_PROPOSAL_SNAPSHOT_BYTES) return;
    const retained = structuredClone(snapshot);
    this.retainProposalSnapshot(key, {
      proposal: retained.proposal,
      bytes,
      principalScope: this.principalScope,
      executable: true,
      ...(accountScope && { accountScope }),
      ...(retained.canonicalTermsDigest && { canonicalTermsDigest: retained.canonicalTermsDigest }),
    });
    this.enforceProposalSnapshotLimits();
  }

  private adaptProjectedResult<T, U>(
    result: TaskResult<T>,
    report: MediaBuyCompatibilityReport,
    project: (data: T) => U,
    accountScope?: string,
    retainProposals = false,
    pendingDecline?: PendingDeclineLease,
    pendingRefinement?: PendingRefinementLease,
    mutationAttemptEpoch?: number
  ): CompatibilityTaskResult<U, T> {
    const localTaskId = result.metadata.taskId;
    const mutationReservation = pendingDecline ?? pendingRefinement;
    const attemptEpoch = mutationAttemptEpoch ?? mutationReservation?.attemptEpoch;
    const mutationAttemptIsCurrent = (): boolean =>
      !mutationReservation ||
      (attemptEpoch !== undefined && this.mutationAttemptIsCurrent(mutationReservation, attemptEpoch));
    const adapt = (current: TaskResult<T>): CompatibilityTaskResult<U, T> => {
      this.assertActive('lifecycle result projection');
      const attemptWasCurrent = mutationAttemptIsCurrent();
      const currentTaskIsAuthoritative = report.tools_used.includes(current.metadata.taskName);
      const currentAuthoritativeFailure =
        currentTaskIsAuthoritative &&
        (current.status === 'failed' ||
          current.status === 'governance-denied' ||
          (current.status === 'completed' && !isAdcpOperationSuccess(current.data, current.metadata.taskName)));
      if (
        current.success &&
        current.status === 'completed' &&
        isAdcpOperationSuccess(current.data, current.metadata.taskName)
      ) {
        let projected: U;
        try {
          projected = project(current.data);
        } catch (error) {
          if (retainProposals && attemptWasCurrent) {
            // A malformed replacement is still authoritative evidence that
            // the seller re-used this proposal ID. Revoke any older executable
            // snapshot before surfacing the projection error.
            this.invalidateProposalSnapshots(this.proposalIdsIn(current.data), accountScope);
          }
          throw error;
        }
        if (retainProposals && attemptWasCurrent) this.rememberProposals(projected, accountScope);
        (current as TaskResult<unknown>).data = projected;
      } else if (
        retainProposals &&
        mutationAttemptIsCurrent() &&
        current.data !== undefined &&
        !(pendingRefinement && currentAuthoritativeFailure)
      ) {
        this.invalidateProposalSnapshots(this.proposalIdsIn(current.data), accountScope);
      }
      if (
        mutationAttemptIsCurrent() &&
        (retainProposals || pendingDecline || pendingRefinement) &&
        ['working', 'submitted'].includes(current.status)
      ) {
        this.watchProposalTask(
          localTaskId,
          accountScope,
          data => project(data as T),
          retainProposals,
          () => {
            if (attemptEpoch === undefined) return;
            if (pendingDecline && !this.disposed) this.pausePendingDecline(pendingDecline, attemptEpoch);
            if (pendingRefinement && !this.disposed) this.pausePendingRefinement(pendingRefinement, attemptEpoch);
          },
          () => {
            if (attemptEpoch === undefined) return;
            if (pendingDecline && !this.disposed) this.preserveAmbiguousProposalMutation(pendingDecline, attemptEpoch);
            if (pendingRefinement && !this.disposed)
              this.preserveAmbiguousProposalMutation(pendingRefinement, attemptEpoch);
          },
          () => {
            if (attemptEpoch === undefined) return;
            if (pendingDecline && !this.disposed) this.retirePendingDecline(pendingDecline, attemptEpoch);
            if (pendingRefinement && !this.disposed) this.restorePendingRefinement(pendingRefinement, attemptEpoch);
          },
          pendingRefinement !== undefined,
          new Set(report.tools_used)
        );
      } else if (mutationAttemptIsCurrent() && (retainProposals || pendingDecline || pendingRefinement)) {
        this.forgetProposalTask(localTaskId);
      }

      const output = current as unknown as TaskResult<U>;
      if (current.submitted) {
        const submitted = current.submitted;
        (output as { submitted?: unknown }).submitted = {
          ...submitted,
          track: async (transport?: import('../protocols').TransportOptions) => {
            try {
              this.assertActive('lifecycle track continuation');
              const task = await submitted.track(transport);
              this.assertActive('lifecycle track continuation');
              const completedSuccessfully =
                task.status === 'completed' &&
                task.result !== undefined &&
                report.tools_used.includes(task.taskType) &&
                isAdcpOperationSuccess(task.result, task.taskType);
              const authoritativeFailure =
                report.tools_used.includes(task.taskType) &&
                (task.status === 'failed' ||
                  task.status === 'governance-denied' ||
                  (task.status === 'completed' &&
                    task.result !== undefined &&
                    !isAdcpOperationSuccess(task.result, task.taskType)));
              if (completedSuccessfully) {
                const continuationWasCurrent = mutationAttemptIsCurrent();
                let projected: U;
                try {
                  projected = project(task.result as T);
                } catch (error) {
                  if (retainProposals && continuationWasCurrent) {
                    this.invalidateProposalSnapshots(this.proposalIdsIn(task.result), accountScope);
                  }
                  throw error;
                }
                if (retainProposals && continuationWasCurrent) this.rememberProposals(projected, accountScope);
                task.result = projected;
                if (retainProposals && continuationWasCurrent) this.forgetProposalTask(localTaskId);
              } else if (
                retainProposals &&
                mutationAttemptIsCurrent() &&
                !(pendingRefinement && authoritativeFailure) &&
                !['pending', 'running', 'working', 'submitted'].includes(task.status)
              ) {
                if (task.result !== undefined) {
                  this.invalidateProposalSnapshots(this.proposalIdsIn(task.result), accountScope);
                }
                if (mutationAttemptIsCurrent()) this.forgetProposalTask(localTaskId);
              }
              if (
                pendingDecline &&
                !['pending', 'running', 'working', 'submitted', 'input-required', 'auth-required', 'deferred'].includes(
                  task.status
                )
              ) {
                if (attemptEpoch !== undefined) {
                  if (completedSuccessfully) this.finishPendingDecline(pendingDecline, attemptEpoch);
                  else this.retirePendingDecline(pendingDecline, attemptEpoch);
                }
              }
              if (
                pendingRefinement &&
                !completedSuccessfully &&
                !['pending', 'running', 'working', 'submitted', 'input-required', 'auth-required', 'deferred'].includes(
                  task.status
                )
              ) {
                if (attemptEpoch !== undefined) {
                  if (authoritativeFailure) this.restorePendingRefinement(pendingRefinement, attemptEpoch);
                  else this.preserveAmbiguousProposalMutation(pendingRefinement, attemptEpoch);
                }
              }
              if (task.status === 'input-required' || task.status === 'auth-required') {
                if (attemptEpoch !== undefined) {
                  if (pendingDecline) this.pausePendingDecline(pendingDecline, attemptEpoch);
                  if (pendingRefinement) this.pausePendingRefinement(pendingRefinement, attemptEpoch);
                }
                this.forgetProposalTask(localTaskId);
              }
              return task;
            } catch (error) {
              if (attemptEpoch !== undefined) {
                if (pendingDecline && !this.disposed)
                  this.preserveAmbiguousProposalMutation(pendingDecline, attemptEpoch);
                if (pendingRefinement && !this.disposed)
                  this.preserveAmbiguousProposalMutation(pendingRefinement, attemptEpoch);
              }
              throw error;
            }
          },
          waitForCompletion: async (pollInterval?: number, signal?: AbortSignal) => {
            try {
              this.assertActive('lifecycle completion continuation');
              return adapt(await submitted.waitForCompletion(pollInterval, signal));
            } catch (error) {
              if (attemptEpoch !== undefined) {
                if (pendingDecline && !this.disposed)
                  this.preserveAmbiguousProposalMutation(pendingDecline, attemptEpoch);
                if (pendingRefinement && !this.disposed)
                  this.preserveAmbiguousProposalMutation(pendingRefinement, attemptEpoch);
              }
              throw error;
            }
          },
        };
      }
      if (current.deferred) {
        const deferred = current.deferred;
        (output as { deferred?: unknown }).deferred = {
          ...deferred,
          resume: async (input: unknown) => {
            let resumedEpoch = attemptEpoch;
            try {
              this.assertActive('lifecycle resume continuation');
              if (mutationReservation) {
                if (
                  attemptEpoch === undefined ||
                  !this.mutationAttemptIsCurrent(mutationReservation, attemptEpoch) ||
                  mutationReservation.state !== 'paused'
                ) {
                  throw this.unsupported(
                    pendingDecline ? 'declineProposals' : 'refineProposals',
                    'proposal_mutation_continuation_stale',
                    'This deferred proposal-mutation continuation no longer owns the shared reservation. No continuation was sent.'
                  );
                }
                const operation = pendingDecline ? 'declineProposals' : 'refineProposals';
                const owner = pendingDecline ? this.declineLeaseOwner : this.refinementLeaseOwner;
                this.beginProposalMutationRetry(mutationReservation, owner, operation);
                resumedEpoch = mutationReservation.attemptEpoch;
              }
              const resumed = await deferred.resume(input);
              if (!mutationReservation) return adapt(resumed);
              return this.adaptProjectedResult(
                resumed,
                report,
                project,
                accountScope,
                retainProposals,
                pendingDecline,
                pendingRefinement,
                resumedEpoch
              );
            } catch (error) {
              if (resumedEpoch !== undefined) {
                if (pendingDecline && !this.disposed)
                  this.preserveAmbiguousProposalMutation(pendingDecline, resumedEpoch);
                if (pendingRefinement && !this.disposed)
                  this.preserveAmbiguousProposalMutation(pendingRefinement, resumedEpoch);
              }
              throw error;
            }
          },
        };
      }
      if (pendingDecline && current.status === 'completed') {
        if (attemptEpoch !== undefined) {
          if (isAdcpOperationSuccess(current.data, current.metadata.taskName))
            this.finishPendingDecline(pendingDecline, attemptEpoch);
          else this.retirePendingDecline(pendingDecline, attemptEpoch);
        }
      } else if (pendingDecline && (current.status === 'failed' || current.status === 'governance-denied')) {
        if (attemptEpoch !== undefined) this.retirePendingDecline(pendingDecline, attemptEpoch);
      }
      if (
        pendingRefinement &&
        ((current.status === 'completed' && !isAdcpOperationSuccess(current.data, current.metadata.taskName)) ||
          current.status === 'failed' ||
          current.status === 'governance-denied')
      ) {
        if (attemptEpoch !== undefined) {
          if (currentAuthoritativeFailure) this.restorePendingRefinement(pendingRefinement, attemptEpoch);
          else this.preserveAmbiguousProposalMutation(pendingRefinement, attemptEpoch);
        }
      }
      if (current.status === 'input-required' || current.status === 'auth-required' || current.status === 'deferred') {
        if (attemptEpoch !== undefined) {
          if (pendingDecline) this.pausePendingDecline(pendingDecline, attemptEpoch);
          if (pendingRefinement) this.pausePendingRefinement(pendingRefinement, attemptEpoch);
        }
      }
      return Object.assign(output, { compatibility: report }) as unknown as CompatibilityTaskResult<U, T>;
    };
    return adapt(result);
  }

  async listProducts(
    params: ListProductsRequest,
    inputHandler?: InputHandler,
    options?: CanonicalProjectionTaskOptions
  ): Promise<CompatibilityTaskResult<CompatibleProductsResponse, CompatibleProductsWireResponse>> {
    this.assertActive('listProducts');
    const input = record(params);
    const lifecycle = this.selectLifecycle('list_products');
    this.assertLegacyReferenceShapes('listProducts', input);
    if (lifecycle === 'compact') {
      this.assertValidCompactRequest('list_products', params, lifecycle);
      const result = await this.agent.listProducts(params, inputHandler, options);
      return this.adaptProjectedResult(result, this.makeReport(lifecycle, ['list_products'], []), data =>
        projectProducts(data, lifecycle)
      );
    }

    this.assertOnlyFields('listProducts', input, LIST_PRODUCTS_FIELDS);
    if (
      compareRelease(this.negotiated_version, '3.0') < 0 &&
      ['cursor', 'max_results', 'fields'].some(field => Object.hasOwn(input, field))
    ) {
      throw this.unsupported(
        'listProducts',
        'cursor,max_results,fields',
        `The negotiated ${this.negotiated_version} get_products request has no pagination or response-field selection. No request was sent.`
      );
    }
    if (
      compareRelease(this.negotiated_version, '3.1') < 0 &&
      ['if_feed_version', 'if_pricing_version'].some(field => Object.hasOwn(input, field))
    ) {
      throw this.unsupported(
        'listProducts',
        'if_feed_version,if_pricing_version',
        `The negotiated ${this.negotiated_version} get_products request cannot condition on feed or pricing versions. No request was sent.`
      );
    }
    this.assertLegacyProductFields('listProducts', input.fields);
    if (input.criteria !== undefined || input.governance_context !== undefined || input.context_id !== undefined) {
      throw this.unsupported(
        'listProducts',
        'criteria/governance_context/context_id',
        'Compact list_products criteria, governance context, and explicit context IDs have no general lossless established mapping.'
      );
    }
    if (input.push_notification_config !== undefined && compareRelease(this.negotiated_version, '3.1') < 0) {
      throw this.unsupported(
        'listProducts',
        'push_notification_config',
        `The negotiated ${this.negotiated_version} get_products request cannot carry push_notification_config.`
      );
    }
    const request: CanonicalGetProductsRequest = {
      buying_mode: 'wholesale',
      ...(input.idempotency_key !== undefined && { idempotency_key: input.idempotency_key as string }),
      ...(input.account !== undefined && { account: input.account as CanonicalGetProductsRequest['account'] }),
      ...(input.brand !== undefined && { brand: input.brand as CanonicalGetProductsRequest['brand'] }),
      ...(Array.isArray(input.fields) && { fields: input.fields as CanonicalGetProductsRequest['fields'] }),
      ...(compareRelease(this.negotiated_version, '3.0') >= 0 &&
        (input.cursor !== undefined || input.max_results !== undefined) && {
          pagination: {
            ...(input.cursor !== undefined && { cursor: input.cursor }),
            ...(input.max_results !== undefined && { max_results: input.max_results }),
          } as CanonicalGetProductsRequest['pagination'],
        }),
      ...(input.if_feed_version !== undefined && { if_wholesale_feed_version: input.if_feed_version as string }),
      ...(input.if_pricing_version !== undefined && { if_pricing_version: input.if_pricing_version as string }),
      ...(input.context !== undefined && { context: input.context as CanonicalGetProductsRequest['context'] }),
      ...(input.push_notification_config !== undefined && {
        push_notification_config:
          input.push_notification_config as CanonicalGetProductsRequest['push_notification_config'],
      }),
    };
    this.assertValidCompactRequest('list_products', params, lifecycle);
    const result = await this.agent.getProducts(request, inputHandler, options);
    return this.adaptProjectedResult(result, this.makeReport(lifecycle, ['get_products'], []), data =>
      projectProducts(data, lifecycle)
    );
  }

  async requestProposals(
    params: MutatingRequestInput<RequestProposalsRequest>,
    inputHandler?: InputHandler,
    options?: CanonicalProjectionTaskOptions
  ): Promise<CompatibilityTaskResult<CompatibleRequestProposalsResponse, CompatibleRequestProposalsWireResponse>> {
    this.assertActive('requestProposals');
    const input = record(params);
    const lifecycle = this.selectLifecycle('request_proposals');
    this.assertLegacyReferenceShapes('requestProposals', input);
    if (lifecycle === 'compact') {
      this.assertValidCompactRequest('request_proposals', params, lifecycle, true);
      const accountScope = this.accountScope(input.account);
      return this.captureProposalDispatch(
        accountScope,
        () => this.agent.requestProposals(params, inputHandler, options),
        result =>
          this.adaptProjectedResult(
            result,
            this.makeReport(lifecycle, ['request_proposals'], []),
            data => projectRequestProposals(data, lifecycle, this.negotiated_version),
            accountScope,
            true
          ),
        data => projectRequestProposals(data, lifecycle, this.negotiated_version)
      );
    }

    this.assertProposalLifecycleAvailable('requestProposals');
    this.assertOnlyFields('requestProposals', input, REQUEST_PROPOSALS_FIELDS);
    const criteria = record(input.criteria);
    this.assertOnlyFields(
      'requestProposals.criteria',
      criteria,
      new Set([
        'product_ids',
        'offer_filters',
        'targeting_overlay',
        'required_overlay_support',
        'catalog',
        'policy_ids',
        'ext',
      ])
    );
    this.assertCompactWireFieldsAbsent('requestProposals.criteria', criteria, [
      'targeting_overlay',
      'required_overlay_support',
    ]);
    if (!optionalString(input.brief)) {
      throw this.unsupported('requestProposals', 'brief', 'Proposal requests require a non-empty brief.');
    }
    if (
      criteria.ext !== undefined ||
      input.opportunity !== undefined ||
      input.governance_context !== undefined ||
      input.context_id !== undefined
    ) {
      throw this.unsupported(
        'requestProposals',
        'structured proposal context',
        'The established proposal request cannot losslessly carry compact ext, opportunity, or governance context.'
      );
    }
    if (input.push_notification_config !== undefined && compareRelease(this.negotiated_version, '3.1') < 0) {
      throw this.unsupported(
        'requestProposals',
        'push_notification_config',
        `The negotiated ${this.negotiated_version} get_products request cannot carry push_notification_config.`
      );
    }
    const offerFilters = record(criteria.offer_filters);
    this.assertLegacyOfferFilterShapes('requestProposals', offerFilters);
    this.assertLegacyMetrics(
      'requestProposals',
      offerFilters.required_metrics,
      'criteria.offer_filters.required_metrics'
    );
    if (criteria.product_ids !== undefined) {
      throw this.unsupported(
        'requestProposals',
        'criteria.product_ids',
        'Established get_products has no normative product-ID proposal filter.'
      );
    }
    if (criteria.catalog !== undefined) {
      throw this.unsupported(
        'requestProposals',
        'criteria.catalog',
        'Compact catalog selection omits the full legacy catalog metadata required by get_products. No request was sent.'
      );
    }
    const legacyOfferFilterFields =
      compareRelease(this.negotiated_version, '3.1') >= 0
        ? V31_OFFER_FILTER_FIELDS
        : compareRelease(this.negotiated_version, '3.0') >= 0
          ? V30_OFFER_FILTER_FIELDS
          : V25_OFFER_FILTER_FIELDS;
    this.assertOnlyFields('requestProposals.criteria.offer_filters', offerFilters, legacyOfferFilterFields);
    const filters = Object.fromEntries(
      Object.entries(offerFilters).filter(([key]) => legacyOfferFilterFields.has(key))
    );
    const request: CanonicalGetProductsRequest = {
      buying_mode: 'brief',
      brief: input.brief as string,
      ...(optionalString(input.idempotency_key)
        ? { idempotency_key: optionalString(input.idempotency_key) }
        : !options?.skipIdempotencyAutoInject
          ? { idempotency_key: generateIdempotencyKey() }
          : {}),
      ...(input.account !== undefined && { account: input.account as CanonicalGetProductsRequest['account'] }),
      ...(input.brand !== undefined && { brand: input.brand as CanonicalGetProductsRequest['brand'] }),
      ...(Object.keys(filters).length > 0 && {
        filters: filters as CanonicalGetProductsRequest['filters'],
      }),
      ...(criteria.targeting_overlay !== undefined && {
        targeting_overlay: criteria.targeting_overlay as CanonicalGetProductsRequest['targeting_overlay'],
      }),
      ...(criteria.required_overlay_support !== undefined && {
        required_overlay_support:
          criteria.required_overlay_support as CanonicalGetProductsRequest['required_overlay_support'],
      }),
      ...(criteria.catalog !== undefined && { catalog: criteria.catalog as CanonicalGetProductsRequest['catalog'] }),
      ...(Array.isArray(criteria.policy_ids) && { required_policies: criteria.policy_ids as string[] }),
      ...(input.push_notification_config !== undefined && {
        push_notification_config:
          input.push_notification_config as CanonicalGetProductsRequest['push_notification_config'],
      }),
      ...(input.context !== undefined && { context: input.context as CanonicalGetProductsRequest['context'] }),
    };
    this.assertValidCompactRequest('request_proposals', params, lifecycle, true);
    const accountScope = this.accountScope(input.account);
    return this.captureProposalDispatch(
      accountScope,
      () => this.agent.getProducts(request, inputHandler, options),
      result =>
        this.adaptProjectedResult(
          result,
          this.makeReport(lifecycle, ['get_products'], []),
          data => projectRequestProposals(data, lifecycle),
          accountScope,
          true
        ),
      data => projectRequestProposals(data, lifecycle)
    );
  }

  async refineProposals(
    params: RefineProposalsInput,
    inputHandler?: InputHandler,
    options?: ProposalRefinementTaskOptions
  ): Promise<CompatibilityTaskResult<CompatibleRefineProposalsResponse, CompatibleRefineProposalsWireResponse>> {
    this.assertActive('refineProposals');
    const lifecycle = this.selectLifecycle('refine_proposals');
    this.assertValidCompactRequest('refine_proposals', params, lifecycle, true);
    if (lifecycle === 'compact') {
      const proposalIds = params.refinements.map(refinement => refinement.proposal_id);
      const retry = this.pendingRefinementRetryCandidate(proposalIds);
      const identity = this.proposalMutationIdempotency(
        params.idempotency_key,
        retry,
        Boolean(options?.skipIdempotencyAutoInject)
      );
      const request: RefineProposalsInput = identity.idempotencyKey
        ? { ...params, idempotency_key: identity.idempotencyKey }
        : params;
      const scopes = this.proposalScopes(proposalIds);
      const accountScope = scopes.length === 1 ? scopes[0] : undefined;
      const pendingRefinement = this.beginPendingRefinement(
        proposalIds,
        true,
        requestFingerprint(request),
        identity.idempotencyKey,
        identity.skipIdempotencyAutoInject
      );
      const attemptEpoch = pendingRefinement.attemptEpoch;
      const dispatchOptions = retry
        ? { ...options, skipIdempotencyAutoInject: retry.skipIdempotencyAutoInject }
        : options;
      const projectOnly = (data: CompatibleRefineProposalsWireResponse) =>
        projectRefineProposals(data, lifecycle, params.refinements);
      const projectAndSettle = (data: CompatibleRefineProposalsWireResponse) => {
        try {
          const projected = projectOnly(data);
          this.settlePendingRefinement(pendingRefinement, projected, attemptEpoch);
          return projected;
        } catch (error) {
          if (!this.disposed) this.preserveAmbiguousProposalMutation(pendingRefinement, attemptEpoch);
          throw error;
        }
      };
      try {
        return await this.captureProposalDispatch(
          accountScope,
          () => this.agent.refineProposals(request, inputHandler, dispatchOptions),
          result =>
            this.adaptProjectedResult(
              result,
              this.makeReport(lifecycle, ['refine_proposals'], []),
              projectAndSettle,
              accountScope,
              true,
              undefined,
              pendingRefinement,
              attemptEpoch
            ),
          projectOnly,
          () => this.preserveAmbiguousProposalMutation(pendingRefinement, attemptEpoch),
          true,
          projected =>
            this.preparePendingRefinementSettlement(
              pendingRefinement,
              projected as CompatibleRefineProposalsResponse,
              attemptEpoch
            ),
          () => this.restorePendingRefinement(pendingRefinement, attemptEpoch)
        );
      } catch (error) {
        if (!this.disposed) this.preserveAmbiguousProposalMutation(pendingRefinement, attemptEpoch);
        throw error;
      }
    }

    this.assertProposalLifecycleAvailable('refineProposals');

    this.assertOnlyFields('refineProposals', record(params), REFINE_PROPOSALS_FIELDS);
    const legacyRefine: Record<string, unknown>[] = [];
    if (params.refinements.length === 0) {
      throw this.unsupported('refineProposals', 'refinements', 'Proposal refinement requires at least one entry.');
    }
    if (params.governance_context !== undefined) {
      throw this.unsupported(
        'refineProposals',
        'governance_context',
        'Established get_products refinement cannot carry compact governance_context.'
      );
    }
    if ((params as Record<string, unknown>).context_id !== undefined) {
      throw this.unsupported(
        'refineProposals',
        'context_id',
        'Established get_products refinement cannot carry an explicit compact context_id.'
      );
    }
    if (params.push_notification_config !== undefined && compareRelease(this.negotiated_version, '3.1') < 0) {
      throw this.unsupported(
        'refineProposals',
        'push_notification_config',
        `The negotiated ${this.negotiated_version} get_products request cannot carry push_notification_config.`
      );
    }
    for (const refinement of params.refinements) {
      const refinementInput = record(refinement);
      if (!optionalString(refinementInput.proposal_id)) {
        throw this.unsupported(
          'refineProposals',
          'proposal_id',
          'Every proposal refinement requires a real proposal_id.'
        );
      }
      if (refinement.action === 'finalize') {
        const unsupportedFields = Object.keys(refinementInput).filter(key => key !== 'proposal_id' && key !== 'action');
        if (unsupportedFields.length > 0) {
          throw this.unsupported(
            'refineProposals',
            `finalize.${unsupportedFields.join(',')}`,
            `Legacy finalize cannot carry additional compact refinement fields: ${unsupportedFields.join(', ')}.`
          );
        }
        legacyRefine.push({ scope: 'proposal', proposal_id: refinement.proposal_id, action: 'finalize' });
        continue;
      }
      if (refinement.action !== 'revise') {
        throw this.unsupported(
          'refineProposals',
          'action',
          `Unsupported compact proposal refinement action: ${String(refinementInput.action)}.`
        );
      }
      const reviseFields = new Set([
        'proposal_id',
        'action',
        'constraints',
        'product_changes',
        'alternatives',
        'ask',
        'criteria',
        'change_kind',
      ]);
      const unknownFields = Object.keys(refinementInput).filter(key => !reviseFields.has(key));
      if (unknownFields.length > 0) {
        throw this.unsupported(
          'refineProposals',
          `refinement.${unknownFields.join(',')}`,
          `Compact proposal refinement fields ${unknownFields.join(', ')} have no declared legacy projection.`
        );
      }
      if (refinement.constraints || refinement.alternatives || refinement.criteria || refinement.change_kind) {
        throw this.unsupported(
          'refineProposals',
          'structured proposal refinement',
          'Hard constraints, alternatives, criteria, and amendment kinds cannot be guaranteed by legacy refinement.'
        );
      }
      legacyRefine.push({
        scope: 'proposal',
        proposal_id: refinement.proposal_id,
        ...(refinement.ask !== undefined && { ask: refinement.ask }),
      });
      for (const [productId, action] of Object.entries(refinement.product_changes ?? {})) {
        if (action !== 'include' && action !== 'omit') {
          throw this.unsupported(
            'refineProposals',
            `product_changes.${productId}`,
            `Legacy product refinement supports only include or omit, not ${String(action)}.`
          );
        }
        legacyRefine.push({ scope: 'product', product_id: productId, action });
      }
    }
    const proposalIds = params.refinements.map(refinement => refinement.proposal_id);
    const retry = this.pendingRefinementRetryCandidate(proposalIds);
    const identity = this.proposalMutationIdempotency(
      params.idempotency_key,
      retry,
      Boolean(options?.skipIdempotencyAutoInject)
    );
    const request: CanonicalGetProductsRequest = {
      buying_mode: 'refine',
      refine: legacyRefine as CanonicalGetProductsRequest['refine'],
      ...(identity.idempotencyKey && { idempotency_key: identity.idempotencyKey }),
      ...(params.push_notification_config !== undefined && {
        push_notification_config:
          params.push_notification_config as unknown as CanonicalGetProductsRequest['push_notification_config'],
      }),
      ...(params.context !== undefined && { context: params.context as CanonicalGetProductsRequest['context'] }),
    };
    const scopes = this.proposalScopes(proposalIds);
    const accountScope = scopes.length === 1 ? scopes[0] : undefined;
    const pendingRefinement = this.beginPendingRefinement(
      proposalIds,
      true,
      requestFingerprint(request),
      identity.idempotencyKey,
      identity.skipIdempotencyAutoInject
    );
    const attemptEpoch = pendingRefinement.attemptEpoch;
    const dispatchOptions = retry
      ? { ...options, skipIdempotencyAutoInject: retry.skipIdempotencyAutoInject }
      : options;
    const projectOnly = (data: CompatibleRefineProposalsWireResponse) =>
      projectRefineProposals(data, lifecycle, params.refinements);
    const projectAndSettle = (data: CompatibleRefineProposalsWireResponse) => {
      try {
        const projected = projectOnly(data);
        this.settlePendingRefinement(pendingRefinement, projected, attemptEpoch);
        return projected;
      } catch (error) {
        if (!this.disposed) this.preserveAmbiguousProposalMutation(pendingRefinement, attemptEpoch);
        throw error;
      }
    };
    try {
      return await this.captureProposalDispatch(
        accountScope,
        () => this.agent.getProducts(request, inputHandler, dispatchOptions),
        result =>
          this.adaptProjectedResult(
            result,
            this.makeReport(lifecycle, ['get_products'], []),
            projectAndSettle,
            accountScope,
            true,
            undefined,
            pendingRefinement,
            attemptEpoch
          ),
        projectOnly,
        () => this.preserveAmbiguousProposalMutation(pendingRefinement, attemptEpoch),
        true,
        projected =>
          this.preparePendingRefinementSettlement(
            pendingRefinement,
            projected as CompatibleRefineProposalsResponse,
            attemptEpoch
          ),
        () => this.restorePendingRefinement(pendingRefinement, attemptEpoch)
      );
    } catch (error) {
      if (!this.disposed) this.preserveAmbiguousProposalMutation(pendingRefinement, attemptEpoch);
      throw error;
    }
  }

  async declineProposals(
    params: MutatingRequestInput<DeclineProposalsRequest>,
    inputHandler?: InputHandler,
    options?: CanonicalProjectionTaskOptions
  ): Promise<CompatibilityTaskResult<CompatibleDeclineProposalsResponse, CompatibleDeclineProposalsWireResponse>> {
    this.assertActive('declineProposals');
    const input = record(params);
    const lifecycle = this.selectLifecycle('decline_proposals');
    const projectOnly = (data: unknown, proposalIds: readonly string[]) =>
      projectDeclineProposals(data, lifecycle, proposalIds, this.negotiated_version);
    if (lifecycle === 'compact') {
      this.assertValidCompactRequest('decline_proposals', params, lifecycle, true);
      const proposalIds = array(input.declines)
        .map(value => optionalString(record(value).proposal_id))
        .filter((value): value is string => value !== undefined);
      const retry = this.pendingDeclineRetryCandidate(proposalIds);
      const identity = this.proposalMutationIdempotency(
        input.idempotency_key,
        retry,
        Boolean(options?.skipIdempotencyAutoInject)
      );
      const request = identity.idempotencyKey ? { ...params, idempotency_key: identity.idempotencyKey } : params;
      const pendingDecline = this.beginPendingDecline(
        proposalIds,
        requestFingerprint(request),
        identity.idempotencyKey,
        identity.skipIdempotencyAutoInject
      );
      const attemptEpoch = pendingDecline.attemptEpoch;
      const dispatchOptions = retry
        ? { ...options, skipIdempotencyAutoInject: retry.skipIdempotencyAutoInject }
        : options;
      const projectAndSettle = (data: unknown) => {
        try {
          const projected = projectOnly(data, proposalIds);
          this.preparePendingDeclineSettlement(pendingDecline, projected, attemptEpoch)();
          return projected;
        } catch (error) {
          if (!this.disposed) this.preserveAmbiguousProposalMutation(pendingDecline, attemptEpoch);
          throw error;
        }
      };
      try {
        return await this.captureProposalDispatch(
          undefined,
          () => this.agent.declineProposals(request, inputHandler, dispatchOptions),
          result =>
            this.adaptProjectedResult(
              result,
              this.makeReport(lifecycle, ['decline_proposals'], []),
              projectAndSettle,
              undefined,
              false,
              pendingDecline,
              undefined,
              attemptEpoch
            ),
          data => projectOnly(data, proposalIds),
          () => this.preserveAmbiguousProposalMutation(pendingDecline, attemptEpoch),
          false,
          projected =>
            this.preparePendingDeclineSettlement(
              pendingDecline,
              projected as CompatibleDeclineProposalsResponse,
              attemptEpoch
            )
        );
      } catch (error) {
        if (!this.disposed) this.preserveAmbiguousProposalMutation(pendingDecline, attemptEpoch);
        throw error;
      }
    }

    this.assertProposalLifecycleAvailable('declineProposals');

    this.assertOnlyFields('declineProposals', input, DECLINE_PROPOSALS_FIELDS);
    for (const [index, value] of array(input.declines).entries()) {
      this.assertOnlyFields(
        `declineProposals.declines[${index}]`,
        record(value),
        new Set(['proposal_id', 'reason', 'detail'])
      );
    }
    const losses: MediaBuyCompatibilityLoss[] = [
      'proposal_decline_not_terminal',
      'proposal_decline_reason_not_forwarded',
    ];
    this.requireAllowed('declineProposals', losses);
    if (input.opportunity !== undefined || input.governance_context !== undefined || input.context_id !== undefined) {
      throw this.unsupported(
        'declineProposals',
        'opportunity/governance_context/context_id',
        'Established proposal omit cannot preserve compact opportunity, governance, or explicit context-ID semantics.'
      );
    }
    if (input.push_notification_config !== undefined && compareRelease(this.negotiated_version, '3.1') < 0) {
      throw this.unsupported(
        'declineProposals',
        'push_notification_config',
        `The negotiated ${this.negotiated_version} get_products request cannot carry push_notification_config.`
      );
    }
    const declines = array(input.declines).map(item => {
      const decline = record(item);
      return { scope: 'proposal', proposal_id: decline.proposal_id, action: 'omit' };
    });
    const proposalIds = declines.map(decline => String(decline.proposal_id));
    const retry = this.pendingDeclineRetryCandidate(proposalIds);
    const identity = this.proposalMutationIdempotency(
      input.idempotency_key,
      retry,
      Boolean(options?.skipIdempotencyAutoInject)
    );
    const request: CanonicalGetProductsRequest = {
      buying_mode: 'refine',
      refine: declines as CanonicalGetProductsRequest['refine'],
      ...(identity.idempotencyKey && { idempotency_key: identity.idempotencyKey }),
      ...(input.push_notification_config !== undefined && {
        push_notification_config:
          input.push_notification_config as CanonicalGetProductsRequest['push_notification_config'],
      }),
      ...(input.context !== undefined && { context: input.context as CanonicalGetProductsRequest['context'] }),
    };
    this.assertValidCompactRequest('decline_proposals', params, lifecycle, true);
    const pendingDecline = this.beginPendingDecline(
      proposalIds,
      requestFingerprint(request),
      identity.idempotencyKey,
      identity.skipIdempotencyAutoInject
    );
    const attemptEpoch = pendingDecline.attemptEpoch;
    const dispatchOptions = retry
      ? { ...options, skipIdempotencyAutoInject: retry.skipIdempotencyAutoInject }
      : options;
    const projectAndSettle = (data: unknown) => {
      try {
        const projected = projectOnly(data, proposalIds);
        this.preparePendingDeclineSettlement(pendingDecline, projected, attemptEpoch)();
        return projected;
      } catch (error) {
        if (!this.disposed) this.preserveAmbiguousProposalMutation(pendingDecline, attemptEpoch);
        throw error;
      }
    };
    try {
      return await this.captureProposalDispatch(
        undefined,
        () => this.agent.getProducts(request, inputHandler, dispatchOptions),
        result =>
          this.adaptProjectedResult(
            result,
            this.makeReport(lifecycle, ['get_products'], losses, [
              'Legacy proposal omit is not a seller-confirmed terminal decline.',
              'Legacy proposal omit cannot forward the compact decline reason or detail.',
            ]),
            projectAndSettle,
            undefined,
            false,
            pendingDecline,
            undefined,
            attemptEpoch
          ),
        data => projectOnly(data, proposalIds),
        () => this.preserveAmbiguousProposalMutation(pendingDecline, attemptEpoch),
        false,
        projected =>
          this.preparePendingDeclineSettlement(
            pendingDecline,
            projected as CompatibleDeclineProposalsResponse,
            attemptEpoch
          )
      );
    } catch (error) {
      if (!this.disposed) this.preserveAmbiguousProposalMutation(pendingDecline, attemptEpoch);
      throw error;
    }
  }

  async buyProducts(
    params: MutatingRequestInput<BuyProductsRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<CompatibilityTaskResult<BuyProductsResponse | CreateMediaBuyResponse>> {
    this.assertActive('buyProducts');
    const input = record(params);
    const lifecycle = this.selectLifecycle('buy_products');
    this.assertLegacyReferenceShapes('buyProducts', input);
    if (lifecycle === 'compact') {
      this.assertValidCompactRequest('buy_products', params, lifecycle, true);
      const result = await this.agent.buyProducts(params, inputHandler, options);
      return this.adaptProjectedResult(result, this.makeReport(lifecycle, ['buy_products'], []), data => data);
    }

    this.assertOnlyFields('buyProducts', input, BUY_PRODUCTS_FIELDS);
    this.assertLegacyReportingWebhook('buyProducts', input.reporting_webhook);
    this.assertCompactWireFieldsAbsent('buyProducts', input, [
      'budget_allocation',
      'daily_budget_cap',
      'budget_cap_timezone',
      'pacing',
      'bidding',
      'governance_context',
      'opportunity',
      'total_budget',
    ]);
    if (compareRelease(this.negotiated_version, '3.0') < 0) {
      this.assertCompactWireFieldsAbsent('buyProducts', input, [
        'advertiser_industry',
        'agency_estimate_number',
        'invoice_recipient',
        'push_notification_config',
      ]);
    }
    this.assertLegacyPushNotification('buyProducts', input.push_notification_config);
    if (Object.hasOwn(input, 'paused') && compareRelease(this.negotiated_version, '3.1') < 0) {
      throw this.unsupported(
        'buyProducts',
        'paused',
        `The negotiated ${this.negotiated_version} create_media_buy request cannot represent paused.`
      );
    }
    if (!optionalString(input.feed_version)) {
      throw this.unsupported('buyProducts', 'feed_version', 'Compact buy_products requires a real feed_version.');
    }
    if (input.pricing_version !== undefined && !optionalString(input.pricing_version)) {
      throw this.unsupported(
        'buyProducts',
        'pricing_version',
        'When provided, compact pricing_version must be a non-empty seller version.'
      );
    }
    if (input.ext !== undefined) {
      throw this.unsupported('buyProducts', 'ext', 'Compact buy_products.ext has no declared legacy projection.');
    }
    const losses: MediaBuyCompatibilityLoss[] = ['feed_version_not_atomic'];
    if (input.pricing_version !== undefined) losses.push('pricing_version_not_atomic');
    this.requireAllowed('buyProducts', losses);
    for (const field of ['account', 'brand', 'start_time', 'end_time', 'purchases']) {
      if (input[field] === undefined) {
        throw this.unsupported('buyProducts', field, `Legacy create_media_buy requires ${field}.`);
      }
    }
    const purchases = array(input.purchases);
    if (purchases.length === 0) {
      throw this.unsupported('buyProducts', 'purchases', 'Legacy create_media_buy requires at least one purchase.');
    }
    const packageFields = isCompactRelease(this.negotiated_version)
      ? V32_PURCHASE_FIELDS
      : compareRelease(this.negotiated_version, '3.1') >= 0
        ? V31_PURCHASE_FIELDS
        : compareRelease(this.negotiated_version, '3.0') >= 0
          ? V30_PURCHASE_FIELDS
          : V25_PURCHASE_FIELDS;
    const packages = purchases.map((value, index) => {
      const purchase = record(value);
      const unsupportedFields = Object.keys(purchase).filter(key => !packageFields.has(key));
      if (unsupportedFields.length) {
        throw this.unsupported(
          'buyProducts',
          `purchases[${index}].${unsupportedFields.join(',')}`,
          `Compact purchase fields ${unsupportedFields.join(', ')} have no declared legacy package projection.`
        );
      }
      if (!optionalString(purchase.product_id) || !optionalString(purchase.pricing_option_id)) {
        throw this.unsupported(
          'buyProducts',
          `purchases[${index}]`,
          'Every purchase requires real product_id and pricing_option_id values from seller discovery.'
        );
      }
      this.assertLegacyTargetingOverlay(
        'buyProducts',
        purchase.targeting_overlay,
        `purchases[${index}].targeting_overlay`
      );
      return Object.fromEntries(Object.entries(purchase).filter(([key]) => packageFields.has(key)));
    });
    const request: MutatingRequestInput<CanonicalCreateMediaBuyRequest> = {
      account: input.account as CanonicalCreateMediaBuyRequest['account'],
      brand: input.brand as CanonicalCreateMediaBuyRequest['brand'],
      start_time: input.start_time as CanonicalCreateMediaBuyRequest['start_time'],
      end_time: input.end_time as CanonicalCreateMediaBuyRequest['end_time'],
      packages: packages as CanonicalCreateMediaBuyRequest['packages'],
      ...(input.idempotency_key !== undefined && { idempotency_key: input.idempotency_key as string }),
      ...(input.total_budget !== undefined && {
        total_budget: input.total_budget as CanonicalCreateMediaBuyRequest['total_budget'],
      }),
      ...(input.daily_budget_cap !== undefined && { daily_budget_cap: input.daily_budget_cap as number }),
      ...(input.budget_cap_timezone !== undefined && { budget_cap_timezone: input.budget_cap_timezone as string }),
      ...(input.budget_allocation !== undefined && {
        budget_allocation: input.budget_allocation as CanonicalCreateMediaBuyRequest['budget_allocation'],
      }),
      ...(input.pacing !== undefined && { pacing: input.pacing as CanonicalCreateMediaBuyRequest['pacing'] }),
      ...(input.bidding !== undefined && { bidding: input.bidding as CanonicalCreateMediaBuyRequest['bidding'] }),
      ...(input.paused !== undefined && { paused: input.paused as boolean }),
      ...(input.advertiser_industry !== undefined && {
        advertiser_industry: input.advertiser_industry as CanonicalCreateMediaBuyRequest['advertiser_industry'],
      }),
      ...(input.purchase_order_ref !== undefined && { po_number: input.purchase_order_ref as string }),
      ...(input.agency_estimate_number !== undefined && {
        agency_estimate_number: input.agency_estimate_number as string,
      }),
      ...(input.invoice_recipient !== undefined && {
        invoice_recipient: input.invoice_recipient as CanonicalCreateMediaBuyRequest['invoice_recipient'],
      }),
      ...(input.governance_context !== undefined && { governance_context: input.governance_context as string }),
      ...(input.opportunity !== undefined && {
        opportunity: input.opportunity as CanonicalCreateMediaBuyRequest['opportunity'],
      }),
      ...(input.reporting_webhook !== undefined && {
        reporting_webhook: input.reporting_webhook as CanonicalCreateMediaBuyRequest['reporting_webhook'],
      }),
      ...(input.push_notification_config !== undefined && {
        push_notification_config:
          input.push_notification_config as CanonicalCreateMediaBuyRequest['push_notification_config'],
      }),
      ...(input.context !== undefined && { context: input.context as CanonicalCreateMediaBuyRequest['context'] }),
    };
    this.assertValidCompactRequest('buy_products', params, lifecycle, true);
    const result = await this.agent.createMediaBuy(request, inputHandler, options);
    return this.adaptProjectedResult(
      result,
      this.makeReport(lifecycle, ['create_media_buy'], losses, [
        'The established mutation cannot atomically fence the selected feed/pricing snapshot.',
      ]),
      data => data
    );
  }

  async acceptProposal(
    params: MutatingRequestInput<CompatibleAcceptProposalRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<CompatibilityTaskResult<AcceptProposalResponse | CreateMediaBuyResponse>> {
    this.assertActive('acceptProposal');
    const input = record(params);
    const lifecycle = this.selectLifecycle('accept_proposal');
    this.assertLegacyReferenceShapes('acceptProposal', input);
    if (lifecycle === 'compact') {
      const proposalId = optionalString(input.proposal_id);
      if (proposalId && this.isProposalDeclinePending(proposalId)) {
        throw this.unsupported(
          'acceptProposal',
          'proposal_decline_pending',
          'The proposal has an unresolved decline in this principal scope. Wait for or reconcile that decline before accepting it.'
        );
      }
      if (proposalId && this.isProposalRefinementPending(proposalId)) {
        throw this.unsupported(
          'acceptProposal',
          'proposal_refinement_pending',
          'The proposal has an unresolved refinement in this principal scope. Wait for or reconcile that refinement before accepting it.'
        );
      }
      if (proposalId && this.isCommitUncertainProposalMutation(proposalId)) {
        throw this.unsupported(
          'acceptProposal',
          'proposal_mutation_commit_uncertain',
          'The proposal has a decline or refinement whose commit outcome is unknown. Reconcile it before sending an acceptance.'
        );
      }
      if (proposalId && this.isCommitUncertainProposal(proposalId)) {
        throw this.unsupported(
          'acceptProposal',
          'proposal_acceptance_commit_uncertain',
          'The proposal has an established acceptance whose commit outcome is unknown. Reconcile the media buy by natural key before sending another acceptance.'
        );
      }
      if (proposalId && this.isTerminalAcceptanceProposal(proposalId)) {
        throw this.unsupported(
          'acceptProposal',
          'proposal_terminal',
          'The proposal is terminal in this principal scope. No acceptance was sent.'
        );
      }
      if (proposalId && this.isTerminalProposal(proposalId)) {
        throw this.unsupported(
          'acceptProposal',
          'proposal_terminal',
          'The proposal was already consumed by a terminal lifecycle mutation in this principal scope. No acceptance was sent.'
        );
      }
      const { established_fallback: _fallback, ...compactInput } = input;
      this.assertValidCompactRequest('accept_proposal', compactInput, lifecycle, true);
      if (!proposalId) {
        throw this.unsupported('acceptProposal', 'proposal_id', 'Native proposal acceptance requires a proposal_id.');
      }
      const prior = this.proposalSnapshotStore.proposalAcceptances.get(proposalId);
      if (prior?.reservation.state === 'in-flight' || prior?.reservation.kind === 'established') {
        throw this.unsupported(
          'acceptProposal',
          'proposal_acceptance_pending',
          'The proposal already has an acceptance reservation in this principal scope. Wait for it to finish before retrying.'
        );
      }
      const retryable = prior?.reservation.state === 'retryable' ? prior.reservation : undefined;
      if (retryable) this.assertAcceptanceRetryWindow(prior!.snapshotKey, prior!.snapshot, retryable);
      const skipIdempotencyAutoInject =
        retryable?.skipIdempotencyAutoInject ?? Boolean(options?.skipIdempotencyAutoInject);
      const idempotencyKey =
        optionalString(compactInput.idempotency_key) ??
        retryable?.idempotencyKey ??
        (!skipIdempotencyAutoInject ? generateIdempotencyKey() : undefined);
      const request = {
        ...compactInput,
        ...(idempotencyKey && { idempotency_key: idempotencyKey }),
      } as MutatingRequestInput<AcceptProposalRequest>;
      const fingerprint = requestFingerprint(request);
      if (
        retryable &&
        (retryable.kind !== 'native' ||
          retryable.requestFingerprint !== fingerprint ||
          retryable.idempotencyKey !== idempotencyKey ||
          retryable.skipIdempotencyAutoInject !== skipIdempotencyAutoInject)
      ) {
        throw this.unsupported(
          'acceptProposal',
          'proposal_acceptance_retry',
          'A paused or commit-uncertain native acceptance may retry only the exact same request and idempotency key. No mutation was sent.'
        );
      }
      if (retryable?.taskId) this.forgetAcceptanceTask(retryable.taskId, retryable);
      if (retryable) this.releaseAcceptanceOwnership(retryable);
      const accountScope = this.accountScope(compactInput.account);
      const snapshotKey = prior?.snapshotKey ?? `${this.snapshotKey(proposalId, accountScope)}\u0000native-acceptance`;
      const snapshot =
        prior?.snapshot ??
        ({
          proposal: { proposal_id: proposalId },
          bytes: new TextEncoder().encode(snapshotKey).byteLength,
          principalScope: this.principalScope ?? '',
          executable: false,
          nativeAcceptanceOnly: true,
          ...(accountScope && { accountScope }),
        } satisfies ProposalSnapshotEntry);
      if (!prior) {
        this.retainProposalSnapshot(snapshotKey, snapshot);
        this.enforceProposalSnapshotLimits();
        if (this.proposalSnapshotStore.entries.get(snapshotKey) !== snapshot) {
          throw new ConfigurationError(
            'The media-buy proposal snapshot limit could not retain a native acceptance fence.',
            'mediaBuy.proposalSnapshots'
          );
        }
      }
      const retryDeadlineMs =
        retryable?.retryDeadlineMs ??
        (this.idempotencyReplayTtlMs !== undefined ? Date.now() + this.idempotencyReplayTtlMs : undefined);
      const reservation: AcceptanceReservation = {
        kind: 'native',
        state: 'in-flight',
        requestFingerprint: fingerprint,
        skipIdempotencyAutoInject,
        ...(idempotencyKey && { idempotencyKey }),
        ...(retryDeadlineMs !== undefined && { retryDeadlineMs }),
      };
      snapshot.executable = false;
      snapshot.acceptance = reservation;
      this.proposalSnapshotStore.proposalAcceptances.set(proposalId, { snapshotKey, snapshot, reservation });
      this.ownedAcceptanceReservations.set(reservation, { snapshotKey, snapshot });
      acceptanceReservationOwners.set(reservation, this);
      let result: TaskResult<AcceptProposalResponse>;
      try {
        result = await this.agent.acceptProposal(request, inputHandler, {
          ...options,
          skipIdempotencyAutoInject,
        });
      } catch (error) {
        this.preserveAmbiguousAcceptance(snapshotKey, snapshot, reservation);
        throw error;
      }
      const transitioned = this.attachAcceptanceTransitions(result, snapshotKey, snapshot, reservation);
      return this.adaptProjectedResult(transitioned, this.makeReport(lifecycle, ['accept_proposal'], []), data => data);
    }

    this.assertProposalLifecycleAvailable('acceptProposal');
    this.assertOnlyFields('acceptProposal', input, ACCEPT_PROPOSAL_FIELDS);
    this.assertLegacyReportingWebhook('acceptProposal', input.reporting_webhook);
    this.assertLegacyPushNotification('acceptProposal', input.push_notification_config);
    this.assertCompactWireFieldsAbsent('acceptProposal', input, [
      'daily_budget_cap',
      'budget_cap_timezone',
      'governance_context',
      'opportunity',
    ]);
    const suppliedDigest = optionalString(input.proposal_terms_digest);
    if (input.ext !== undefined) {
      throw this.unsupported('acceptProposal', 'ext', 'Compact accept_proposal.ext has no declared legacy projection.');
    }
    const proposalId = optionalString(input.proposal_id);
    if (!proposalId || input.account === undefined) {
      throw this.unsupported(
        'acceptProposal',
        'proposal_id/account',
        'Legacy proposal acceptance requires a real proposal_id and account.'
      );
    }
    if (!this.principalScope) {
      throw this.unsupported(
        'acceptProposal',
        'principal_scope',
        'Established proposal acceptance requires a stable, non-secret principalScope when negotiating the coordinator. No mutation was sent.'
      );
    }
    if (this.isProposalDeclinePending(proposalId)) {
      throw this.unsupported(
        'acceptProposal',
        'proposal_decline_pending',
        'The proposal has an unresolved decline in this principal scope. Wait for that decline to finish before accepting it.'
      );
    }
    if (this.isProposalRefinementPending(proposalId)) {
      throw this.unsupported(
        'acceptProposal',
        'proposal_refinement_pending',
        'The proposal has an unresolved refinement in this principal scope. Wait for that refinement to finish before accepting it.'
      );
    }
    const accountScope = this.accountScope(input.account);
    const snapshotKey = accountScope ? this.snapshotKey(proposalId, accountScope) : undefined;
    const globalAcceptance = this.proposalSnapshotStore.proposalAcceptances.get(proposalId);
    if (globalAcceptance && globalAcceptance.snapshotKey !== snapshotKey) {
      throw this.unsupported(
        'acceptProposal',
        'proposal_acceptance_pending',
        'The proposal already has an acceptance reservation in this principal scope. Reuse the original account scope for an exact retry.'
      );
    }
    if (globalAcceptance?.reservation.state === 'in-flight') {
      throw this.unsupported(
        'acceptProposal',
        'proposal_acceptance_pending',
        'The proposal already has an in-flight acceptance in this principal scope. Wait for it to finish before retrying.'
      );
    }
    const snapshot = snapshotKey ? this.proposalSnapshotStore.entries.get(snapshotKey) : undefined;
    const retryableAcceptance =
      globalAcceptance?.reservation.state === 'retryable' ? globalAcceptance.reservation : undefined;
    if (!snapshot || (!snapshot.executable && !retryableAcceptance)) {
      throw this.unsupported(
        'acceptProposal',
        'proposal_snapshot/account_scope',
        'No proposal snapshot is available in the supplied principal and account scope. Request/finalize it through this coordinator first.'
      );
    }
    if (retryableAcceptance) this.assertAcceptanceRetryWindow(snapshotKey!, snapshot, retryableAcceptance);
    const proposal = snapshot.proposal;
    if (proposal.proposal_status !== undefined && proposal.proposal_status !== 'committed') {
      throw this.unsupported(
        'acceptProposal',
        'proposal_status',
        `Legacy create_media_buy projection cannot accept a proposal in ${String(proposal.proposal_status)} status.`
      );
    }
    if (proposal.proposal_kind !== undefined && proposal.proposal_kind !== 'new_media_buy') {
      throw this.unsupported(
        'acceptProposal',
        'proposal_kind',
        `Legacy create_media_buy projection supports only new_media_buy proposals, not ${String(proposal.proposal_kind)}.`
      );
    }

    const losses = ['proposal_terms_digest_not_enforced'] as MediaBuyCompatibilityLoss[];
    const expiresAt = proposal.expires_at;
    if (expiresAt === undefined) {
      losses.push('proposal_hold_not_verifiable');
    } else {
      if (!isStrictDateTime(expiresAt)) {
        throw this.unsupported(
          'acceptProposal',
          'expires_at',
          'The proposal carries an invalid seller hold expiry. No mutation was sent.'
        );
      }
      const expiry = Date.parse(expiresAt);
      if (!retryableAcceptance && expiry <= Date.now()) {
        throw this.unsupported('acceptProposal', 'expires_at', 'The proposal is expired. No mutation was sent.');
      }
    }

    const sellerDigest = optionalString(proposal.terms_digest);
    const terms = record(proposal.commercial_terms);
    const digestBoundTerms = Boolean(sellerDigest && Object.keys(terms).length > 0);
    if (sellerDigest && snapshot.canonicalTermsDigest) {
      if (sellerDigest !== snapshot.canonicalTermsDigest) {
        throw new MediaBuyLifecycleCompatibilityError({
          operation: 'acceptProposal',
          negotiatedVersion: this.negotiated_version,
          lifecycle,
          feature: 'seller_proposal_terms_digest',
          code: 'PROPOSAL_DIGEST_MISMATCH',
          message: 'The seller digest is not bound to the cached commercial terms. No mutation was sent.',
        });
      }
      if (!suppliedDigest || suppliedDigest !== sellerDigest) {
        throw new MediaBuyLifecycleCompatibilityError({
          operation: 'acceptProposal',
          negotiatedVersion: this.negotiated_version,
          lifecycle,
          feature: 'proposal_terms_digest',
          code: 'PROPOSAL_DIGEST_MISMATCH',
          message: 'The proposal digest differs from the seller-provided snapshot. No mutation was sent.',
        });
      }
    } else {
      losses.push('proposal_terms_digest_unavailable', 'proposal_snapshot_not_immutable');
    }

    this.requireAllowed('acceptProposal', losses);
    const resolvedAcceptanceField = (field: string): unknown => {
      const termValue = terms[field];
      const inputValue = input[field];
      if (!digestBoundTerms || termValue === undefined) return inputValue;
      if (inputValue !== undefined) {
        let matches = false;
        try {
          matches = canonicalize(inputValue) === canonicalize(termValue);
        } catch {
          matches = false;
        }
        if (!matches) {
          throw new MediaBuyLifecycleCompatibilityError({
            operation: 'acceptProposal',
            negotiatedVersion: this.negotiated_version,
            lifecycle,
            feature: field,
            code: 'PROPOSAL_DIGEST_MISMATCH',
            message: `Acceptance field ${field} conflicts with the digest-bound seller terms. No mutation was sent.`,
          });
        }
      }
      return termValue;
    };
    const totalBudget = resolvedAcceptanceField('total_budget');
    const dailyBudgetCap = resolvedAcceptanceField('daily_budget_cap');
    const budgetCapTimezone = resolvedAcceptanceField('budget_cap_timezone');
    const purchaseOrderRef = resolvedAcceptanceField('purchase_order_ref');
    if (
      !isCompactRelease(this.negotiated_version) &&
      [dailyBudgetCap, budgetCapTimezone].some(value => value !== undefined)
    ) {
      throw this.unsupported(
        'acceptProposal',
        'commercial_terms.daily_budget_cap,budget_cap_timezone',
        `The negotiated ${this.negotiated_version} create_media_buy schema cannot represent compact budget-cap terms. No mutation was sent.`
      );
    }
    const fallback = record(input.established_fallback);
    const brand = terms.brand ?? fallback.brand;
    const startTime = terms.start_time ?? fallback.start_time;
    const endTime = terms.end_time ?? fallback.end_time;
    if (!brand || !startTime || !endTime) {
      throw this.unsupported(
        'acceptProposal',
        'established_fallback',
        'The proposal does not carry compact commercial terms. Supply established_fallback with the original brand and flight.'
      );
    }
    this.assertLegacyReferenceShapes('acceptProposal', { brand });
    if (
      input.idempotency_key !== undefined &&
      (typeof input.idempotency_key !== 'string' || !isValidIdempotencyKey(input.idempotency_key))
    ) {
      throw this.unsupported(
        'acceptProposal',
        'idempotency_key',
        'Established proposal acceptance requires a 16-255 character protocol idempotency key. No mutation was sent.'
      );
    }
    const callerIdempotencyKey = optionalString(input.idempotency_key);
    const acceptanceIdempotencyKey = retryableAcceptance
      ? (callerIdempotencyKey ?? retryableAcceptance.idempotencyKey)
      : (callerIdempotencyKey ?? (!options?.skipIdempotencyAutoInject ? generateIdempotencyKey() : undefined));
    const request: MutatingRequestInput<CanonicalCreateMediaBuyRequest> = {
      account: input.account as CanonicalCreateMediaBuyRequest['account'],
      brand: brand as CanonicalCreateMediaBuyRequest['brand'],
      start_time: startTime as CanonicalCreateMediaBuyRequest['start_time'],
      end_time: endTime as CanonicalCreateMediaBuyRequest['end_time'],
      proposal_id: proposalId,
      ...(acceptanceIdempotencyKey !== undefined && { idempotency_key: acceptanceIdempotencyKey }),
      ...(totalBudget !== undefined && {
        total_budget: totalBudget as CanonicalCreateMediaBuyRequest['total_budget'],
      }),
      ...(dailyBudgetCap !== undefined && { daily_budget_cap: dailyBudgetCap as number }),
      ...(budgetCapTimezone !== undefined && { budget_cap_timezone: budgetCapTimezone as string }),
      ...(purchaseOrderRef !== undefined && { po_number: purchaseOrderRef as string }),
      ...(input.io_acceptance !== undefined && {
        io_acceptance: input.io_acceptance as CanonicalCreateMediaBuyRequest['io_acceptance'],
      }),
      ...(input.governance_context !== undefined && { governance_context: input.governance_context as string }),
      ...(input.opportunity !== undefined && {
        opportunity: input.opportunity as CanonicalCreateMediaBuyRequest['opportunity'],
      }),
      ...(input.reporting_webhook !== undefined && {
        reporting_webhook: input.reporting_webhook as CanonicalCreateMediaBuyRequest['reporting_webhook'],
      }),
      ...(input.push_notification_config !== undefined && {
        push_notification_config:
          input.push_notification_config as CanonicalCreateMediaBuyRequest['push_notification_config'],
      }),
      ...(input.context !== undefined && { context: input.context as CanonicalCreateMediaBuyRequest['context'] }),
    };
    const fingerprint = requestFingerprint(request);
    if (retryableAcceptance && fingerprint !== retryableAcceptance.requestFingerprint) {
      throw this.unsupported(
        'acceptProposal',
        'proposal_acceptance_retry',
        'A paused established acceptance must retry the exact same request and idempotency key. No mutation was sent.'
      );
    }
    if (retryableAcceptance) this.assertAcceptanceRetryWindow(snapshotKey!, snapshot, retryableAcceptance);
    if (retryableAcceptance?.taskId) {
      this.forgetAcceptanceTask(retryableAcceptance.taskId, retryableAcceptance);
    }
    if (retryableAcceptance) this.releaseAcceptanceOwnership(retryableAcceptance);
    const retryDeadlineMs =
      retryableAcceptance?.retryDeadlineMs ??
      (this.idempotencyReplayTtlMs !== undefined ? Date.now() + this.idempotencyReplayTtlMs : undefined);
    // Acceptance is one-shot even though the established seller has no
    // compact proposal state transition. The in-map reservation prevents
    // concurrent rediscovery from reauthorizing the proposal. Only an exact
    // paused retry can reuse it; ambiguous outcomes remain fail-closed.
    const reservation: AcceptanceReservation = {
      kind: 'established',
      state: 'in-flight',
      requestFingerprint: fingerprint,
      skipIdempotencyAutoInject:
        retryableAcceptance?.skipIdempotencyAutoInject ?? Boolean(options?.skipIdempotencyAutoInject),
      ...(acceptanceIdempotencyKey && { idempotencyKey: acceptanceIdempotencyKey }),
      ...(retryDeadlineMs !== undefined && { retryDeadlineMs }),
    };
    snapshot.executable = false;
    snapshot.acceptance = reservation;
    this.proposalSnapshotStore.proposalAcceptances.set(proposalId, {
      snapshotKey: snapshotKey!,
      snapshot,
      reservation,
    });
    this.ownedAcceptanceReservations.set(reservation, { snapshotKey: snapshotKey!, snapshot });
    acceptanceReservationOwners.set(reservation, this);
    const dispatchOptions = retryableAcceptance
      ? { ...options, skipIdempotencyAutoInject: retryableAcceptance.skipIdempotencyAutoInject }
      : options;
    let result: TaskResult<CreateMediaBuyResponse>;
    try {
      result = await this.agent.createMediaBuy(request, inputHandler, dispatchOptions);
    } catch (error) {
      this.preserveAmbiguousAcceptance(snapshotKey!, snapshot, reservation);
      throw error;
    }
    const transitioned = this.attachAcceptanceTransitions(result, snapshotKey!, snapshot, reservation);
    return this.adaptProjectedResult(
      transitioned,
      this.makeReport(lifecycle, ['create_media_buy'], losses, [
        'The established seller accepted its ordinary proposal_id mutation without compact digest enforcement.',
        ...(losses.includes('proposal_terms_digest_unavailable')
          ? [
              'The seller supplied no terms digest or immutable compact commercial-terms snapshot; none was synthesized.',
            ]
          : []),
      ]),
      data => data
    );
  }

  async controlMediaBuy(
    params: MutatingRequestInput<ControlMediaBuyRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<CompatibilityTaskResult<ControlMediaBuyResponse | UpdateMediaBuyResponse>> {
    this.assertActive('controlMediaBuy');
    const input = record(params);
    const lifecycle = this.selectLifecycle('control_media_buy');
    this.assertLegacyReferenceShapes('controlMediaBuy', input);
    if (lifecycle === 'compact') {
      this.assertValidCompactRequest('control_media_buy', params, lifecycle, true);
      const result = await this.agent.controlMediaBuy(params, inputHandler, options);
      return this.adaptProjectedResult(result, this.makeReport(lifecycle, ['control_media_buy'], []), data => data);
    }

    this.assertOnlyFields('controlMediaBuy', input, CONTROL_MEDIA_BUY_FIELDS);
    this.assertLegacyReportingWebhook('controlMediaBuy', input.reporting_webhook);
    this.assertLegacyPushNotification('controlMediaBuy', input.push_notification_config);
    this.assertCompactWireFieldsAbsent('controlMediaBuy', input, [
      'total_budget',
      'daily_budget_cap',
      'budget_cap_timezone',
      'budget_allocation',
      'pacing',
      'bidding',
      'governance_context',
    ]);
    if (compareRelease(this.negotiated_version, '3.0') < 0) {
      this.assertCompactWireFieldsAbsent('controlMediaBuy', input, ['reporting_webhook']);
    }
    const losses: MediaBuyCompatibilityLoss[] = [];
    if (compareRelease(this.negotiated_version, '3.0') < 0) {
      if (Object.hasOwn(input, 'canceled') || Object.hasOwn(input, 'cancellation_reason')) {
        throw this.unsupported(
          'controlMediaBuy',
          'canceled,cancellation_reason',
          `The negotiated ${this.negotiated_version} update_media_buy request cannot represent cancellation.`
        );
      }
      losses.push('revision_not_atomic');
      this.requireAllowed('controlMediaBuy', losses);
    }
    if (
      input.account === undefined ||
      !optionalString(input.media_buy_id) ||
      !Number.isInteger(input.revision) ||
      (input.revision as number) < 1
    ) {
      throw this.unsupported(
        'controlMediaBuy',
        'account/media_buy_id/revision',
        'Legacy media-buy control requires a real account, media_buy_id, and positive compact revision.'
      );
    }
    if (input.ext !== undefined) {
      throw this.unsupported(
        'controlMediaBuy',
        'ext',
        'Compact control_media_buy.ext has no declared legacy projection.'
      );
    }
    let packages: CanonicalUpdateMediaBuyRequest['packages'] | undefined;
    if (input.packages !== undefined) {
      if (!Array.isArray(input.packages) || input.packages.length === 0) {
        throw this.unsupported(
          'controlMediaBuy',
          'packages',
          'Compact package controls must be a non-empty array when provided.'
        );
      }
      const packageControlFields = new Set([
        'package_id',
        'bidding',
        'budget',
        'canceled',
        'cancellation_reason',
        'daily_budget_cap',
        'impressions',
        'keyword_targets_add',
        'keyword_targets_remove',
        'min_spend_target',
        'negative_keywords_add',
        'negative_keywords_remove',
        'optimization_goals',
        'pacing',
        'paused',
        'targeting_overlay',
      ]);
      packages = input.packages.map((value, index) => {
        const packageControl = record(value);
        this.assertCompactWireFieldsAbsent(`controlMediaBuy.packages[${index}]`, packageControl, [
          'bidding',
          'daily_budget_cap',
          'min_spend_target',
        ]);
        if (compareRelease(this.negotiated_version, '3.0') < 0) {
          const v3OnlyFields = [
            'canceled',
            'cancellation_reason',
            'keyword_targets_add',
            'keyword_targets_remove',
            'negative_keywords_add',
            'negative_keywords_remove',
            'optimization_goals',
          ].filter(field => Object.hasOwn(packageControl, field));
          if (v3OnlyFields.length > 0) {
            throw this.unsupported(
              'controlMediaBuy',
              `packages[${index}].${v3OnlyFields.join(',')}`,
              `The negotiated ${this.negotiated_version} package update cannot represent ${v3OnlyFields.join(
                ', '
              )}. No mutation was sent.`
            );
          }
        }
        if (!isCompactRelease(this.negotiated_version) && Object.hasOwn(packageControl, 'optimization_goals')) {
          throw this.unsupported(
            'controlMediaBuy',
            `packages[${index}].optimization_goals`,
            `The negotiated ${this.negotiated_version} optimization goal union cannot represent every compact vendor_metric goal. No mutation was sent.`
          );
        }
        if (!isCompactRelease(this.negotiated_version) && packageControl.budget === null) {
          throw this.unsupported(
            'controlMediaBuy',
            `packages[${index}].budget`,
            `The negotiated ${this.negotiated_version} package update cannot represent compact budget=null. No mutation was sent.`
          );
        }
        const unsupportedFields = Object.keys(packageControl).filter(key => !packageControlFields.has(key));
        if (unsupportedFields.length > 0) {
          throw this.unsupported(
            'controlMediaBuy',
            `packages[${index}].${unsupportedFields.join(',')}`,
            `Compact package control fields ${unsupportedFields.join(', ')} have no declared legacy projection.`
          );
        }
        if (!optionalString(packageControl.package_id)) {
          throw this.unsupported(
            'controlMediaBuy',
            `packages[${index}].package_id`,
            'Every compact package control requires a real package_id.'
          );
        }
        this.assertLegacyTargetingOverlay(
          'controlMediaBuy',
          packageControl.targeting_overlay,
          `packages[${index}].targeting_overlay`
        );
        if (packageControl.canceled !== undefined && packageControl.canceled !== true) {
          throw this.unsupported(
            'controlMediaBuy',
            `packages[${index}].canceled`,
            'Compact package canceled may only be true when present.'
          );
        }
        if (Object.hasOwn(packageControl, 'cancellation_reason') && !Object.hasOwn(packageControl, 'canceled')) {
          throw this.unsupported(
            'controlMediaBuy',
            `packages[${index}].cancellation_reason`,
            'Compact package cancellation_reason requires canceled=true.'
          );
        }
        const keywordDeltaFields = [
          'keyword_targets_add',
          'keyword_targets_remove',
          'negative_keywords_add',
          'negative_keywords_remove',
        ];
        if (!isCompactRelease(this.negotiated_version)) {
          for (const field of ['keyword_targets_remove', 'negative_keywords_add', 'negative_keywords_remove']) {
            for (const [itemIndex, item] of array(packageControl[field]).entries()) {
              if (Object.hasOwn(record(item), 'bid_price')) {
                throw this.unsupported(
                  'controlMediaBuy',
                  `packages[${index}].${field}[${itemIndex}].bid_price`,
                  `The negotiated ${this.negotiated_version} ${field} item cannot represent compact bid_price. No mutation was sent.`
                );
              }
            }
          }
        }
        if (
          Object.hasOwn(packageControl, 'targeting_overlay') &&
          keywordDeltaFields.some(field => Object.hasOwn(packageControl, field))
        ) {
          throw this.unsupported(
            'controlMediaBuy',
            `packages[${index}].targeting_overlay`,
            'Compact package targeting_overlay cannot be combined with keyword deltas.'
          );
        }
        const canceledPackageConflicts = [
          'budget',
          'daily_budget_cap',
          'min_spend_target',
          'impressions',
          'pacing',
          'bidding',
          'paused',
          'targeting_overlay',
          ...keywordDeltaFields,
          'optimization_goals',
        ];
        if (
          Object.hasOwn(packageControl, 'canceled') &&
          canceledPackageConflicts.some(field => Object.hasOwn(packageControl, field))
        ) {
          throw this.unsupported(
            'controlMediaBuy',
            `packages[${index}].canceled`,
            'Compact package cancellation cannot be combined with other package controls.'
          );
        }
        return Object.fromEntries(
          Object.entries(packageControl).filter(([key]) => packageControlFields.has(key))
        ) as NonNullable<CanonicalUpdateMediaBuyRequest['packages']>[number];
      });
    }
    if (input.canceled !== undefined && input.canceled !== true) {
      throw this.unsupported(
        'controlMediaBuy',
        'canceled',
        'Compact media-buy canceled may only be true when present.'
      );
    }
    if (Object.hasOwn(input, 'cancellation_reason') && !Object.hasOwn(input, 'canceled')) {
      throw this.unsupported(
        'controlMediaBuy',
        'cancellation_reason',
        'Compact media-buy cancellation_reason requires canceled=true.'
      );
    }
    const canceledControlConflicts = [
      'paused',
      'total_budget',
      'daily_budget_cap',
      'budget_cap_timezone',
      'budget_allocation',
      'pacing',
      'bidding',
      'packages',
      'reporting_webhook',
    ];
    if (Object.hasOwn(input, 'canceled') && canceledControlConflicts.some(field => Object.hasOwn(input, field))) {
      throw this.unsupported(
        'controlMediaBuy',
        'canceled',
        'Compact media-buy cancellation cannot be combined with other operational controls.'
      );
    }
    const request: MutatingRequestInput<CanonicalUpdateMediaBuyRequest> = {
      account: input.account as CanonicalUpdateMediaBuyRequest['account'],
      media_buy_id: input.media_buy_id as string,
      ...(input.idempotency_key !== undefined && { idempotency_key: input.idempotency_key as string }),
      revision: input.revision as number,
      ...(input.paused !== undefined && { paused: input.paused as boolean }),
      ...(input.canceled !== undefined && { canceled: input.canceled as true }),
      ...(input.cancellation_reason !== undefined && { cancellation_reason: input.cancellation_reason as string }),
      ...(input.governance_context !== undefined && { governance_context: input.governance_context as string }),
      ...(input.total_budget !== undefined && {
        total_budget: input.total_budget as CanonicalUpdateMediaBuyRequest['total_budget'],
      }),
      ...(input.daily_budget_cap !== undefined && {
        daily_budget_cap: input.daily_budget_cap as CanonicalUpdateMediaBuyRequest['daily_budget_cap'],
      }),
      ...(input.budget_cap_timezone !== undefined && {
        budget_cap_timezone: input.budget_cap_timezone as CanonicalUpdateMediaBuyRequest['budget_cap_timezone'],
      }),
      ...(input.budget_allocation !== undefined && {
        budget_allocation: input.budget_allocation as CanonicalUpdateMediaBuyRequest['budget_allocation'],
      }),
      ...(input.pacing !== undefined && { pacing: input.pacing as CanonicalUpdateMediaBuyRequest['pacing'] }),
      ...(input.bidding !== undefined && { bidding: input.bidding as CanonicalUpdateMediaBuyRequest['bidding'] }),
      ...(packages !== undefined && { packages }),
      ...(input.reporting_webhook !== undefined && {
        reporting_webhook: input.reporting_webhook as CanonicalUpdateMediaBuyRequest['reporting_webhook'],
      }),
      ...(input.push_notification_config !== undefined && {
        push_notification_config:
          input.push_notification_config as CanonicalUpdateMediaBuyRequest['push_notification_config'],
      }),
      ...(input.context !== undefined && { context: input.context as CanonicalUpdateMediaBuyRequest['context'] }),
    };
    this.assertValidCompactRequest('control_media_buy', params, lifecycle, true);
    const result = await this.agent.updateMediaBuy(request, inputHandler, options);
    return this.adaptProjectedResult(
      result,
      this.makeReport(
        lifecycle,
        ['update_media_buy'],
        losses,
        losses.length ? ['The v2.5 update cannot atomically enforce the compact revision token.'] : []
      ),
      data => data
    );
  }

  async getMediaBuys(
    params: GetMediaBuysRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<CompatibilityTaskResult<GetMediaBuysResponse>> {
    this.assertActive('getMediaBuys');
    if (compareRelease(this.negotiated_version, '3.0') < 0) {
      throw this.unsupported(
        'getMediaBuys',
        'media_buy_readback',
        `The negotiated ${this.negotiated_version} seller has no get_media_buys tool.`
      );
    }
    this.assertSharedToolAdvertised('get_media_buys');
    const input = record(params);
    this.assertLegacyReferenceShapes('getMediaBuys', input);
    if (compareRelease(this.negotiated_version, '3.1') < 0) {
      this.assertCompactWireFieldsAbsent('getMediaBuys', input, ['include_webhook_activity', 'webhook_activity_limit']);
    }
    if (!isCompactRelease(this.negotiated_version)) {
      this.assertCompactWireFieldsAbsent('getMediaBuys', input, ['indicator_types']);
    }
    const result = await this.agent.getMediaBuys(params, inputHandler, options);
    return this.adaptProjectedResult(result, this.makeReport(this.lifecycle, ['get_media_buys'], []), data => data);
  }

  async getMediaBuyDelivery(
    params: GetMediaBuyDeliveryRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<CompatibilityTaskResult<GetMediaBuyDeliveryResponse>> {
    this.assertActive('getMediaBuyDelivery');
    if (compareRelease(this.negotiated_version, '3.0') < 0) {
      throw this.unsupported(
        'getMediaBuyDelivery',
        'media_buy_delivery_readback',
        `The negotiated ${this.negotiated_version} delivery request cannot safely represent the compact account-scoped readback.`
      );
    }
    this.assertSharedToolAdvertised('get_media_buy_delivery');
    const input = record(params);
    if (compareRelease(this.negotiated_version, '3.1') < 0) {
      this.assertCompactWireFieldsAbsent('getMediaBuyDelivery', input, [
        'include_window_breakdown',
        'time_granularity',
      ]);
    } else if (
      !isCompactRelease(this.negotiated_version) &&
      input.time_granularity !== undefined &&
      !V31_TIME_GRANULARITIES.has(String(input.time_granularity))
    ) {
      throw this.unsupported(
        'getMediaBuyDelivery',
        'time_granularity',
        `The negotiated ${this.negotiated_version} delivery request cannot represent compact time granularity ${String(input.time_granularity)}. No request was sent.`
      );
    }
    this.assertLegacyReportingDimensions('getMediaBuyDelivery', input.reporting_dimensions);
    this.assertLegacyReferenceShapes('getMediaBuyDelivery', input);
    const result = await this.agent.getMediaBuyDelivery(params, inputHandler, options);
    return this.adaptProjectedResult(
      result,
      this.makeReport(this.lifecycle, ['get_media_buy_delivery'], []),
      data => data
    );
  }
}

export function negotiateMediaBuyLifecycle(
  agent: AgentClient,
  options: MediaBuyLifecycleCoordinatorOptions = {}
): Promise<MediaBuyLifecycleCoordinator> {
  return MediaBuyLifecycleCoordinator.negotiate(agent, options);
}
