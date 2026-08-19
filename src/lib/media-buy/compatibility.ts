import { createHash, randomBytes } from 'node:crypto';
import type { AgentClient, CanonicalProjectionTaskOptions, ProposalRefinementTaskOptions } from '../core/AgentClient';
import type { InputHandler, TaskOptions, TaskResult } from '../core/ConversationTypes';
import { generateIdempotencyKey, isValidIdempotencyKey, type MutatingRequestInput } from '../utils/idempotency';
import { canonicalize } from '../utils/jcs';
import { assertValidIdempotencyReplayTtlSeconds, type AdcpCapabilities } from '../utils/capabilities';
import { TOOL_REQUEST_SCHEMAS } from '../utils/tool-request-schemas';
import type {
  AcceptProposalRequest,
  AcceptProposalResponse,
  BuyProductsRequest,
  BuyProductsResponse,
  ControlMediaBuyRequest,
  ControlMediaBuyResponse,
  CreateMediaBuyResponse,
  DeclineProposalsRequest,
  GetMediaBuyDeliveryRequest,
  GetMediaBuyDeliveryResponse,
  GetMediaBuysRequest,
  GetMediaBuysResponse,
  ListProductsRequest,
  RequestProposalsRequest,
  UpdateMediaBuyResponse,
} from '../types/tools.generated';
import type {
  CanonicalCreateMediaBuyRequest,
  CanonicalGetProductsRequest,
  CanonicalUpdateMediaBuyRequest,
} from '../v2/projection/creative-delivery';
import type { RefineProposalsInput } from '../negotiation/types';
import { isStrictDateTime, proposalTermsDigest } from '../negotiation/verification';
import { isAdcpOperationSuccess } from '../utils/response-unwrapper';

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

export type CompatibilityTaskResult<T> = TaskResult<T> & { compatibility: MediaBuyCompatibilityReport };

export interface CompatibleProductsResponse {
  /** Present only when the seller returned product rows (conditional reads may return only `unchanged`). */
  products?: unknown[];
  proposals?: unknown[];
  feed_version?: string;
  pricing_version?: string;
  unchanged?: true;
  /** Lifecycle-neutral cursor for the next page. */
  next_cursor?: string;
  pagination?: unknown;
  cache_scope?: 'public' | 'account';
  errors?: unknown[];
  context?: unknown;
  /** SDK-returned source object, retained for fields outside the stable compatibility view. */
  raw: Record<string, unknown>;
}

export interface CompatibleProposalResponse {
  /** Present only when the seller returned a proposal collection or proposal object. */
  proposals?: unknown[];
  products?: unknown[];
  errors?: unknown[];
  context?: unknown;
  /** SDK-returned source object; no digest or proposal state is synthesized. */
  raw: Record<string, unknown>;
}

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
  prerelease?: string;
}

function parseRelease(value: string): ParsedRelease | undefined {
  const match = /^v?(\d+)\.(\d+)(?:\.\d+)?(?:-([A-Za-z0-9.-]+))?(?:\+[A-Za-z0-9.-]+)?$/.exec(value.trim());
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    ...(match[3] !== undefined && { prerelease: match[3] }),
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
  return a.major - b.major || a.minor - b.minor || comparePrerelease(a.prerelease, b.prerelease);
}

function isCompactRelease(value: string): boolean {
  const release = parseRelease(value);
  return release !== undefined && (release.major > 3 || (release.major === 3 && release.minor >= 2));
}

function negotiatedVersion(capabilities: AdcpCapabilities, clientVersion: string): string {
  if (capabilities.version === 'v2') return '2.5';
  if (capabilities.servedVersion && parseRelease(capabilities.servedVersion)) return capabilities.servedVersion;
  const candidates = capabilities.supportedVersions?.filter(
    version => parseRelease(version) !== undefined && compareRelease(version, clientVersion) <= 0
  );
  if (candidates?.length) return [...candidates].sort(compareRelease).at(-1)!;
  if (
    capabilities.buildVersion &&
    parseRelease(capabilities.buildVersion) &&
    compareRelease(capabilities.buildVersion, clientVersion) <= 0
  ) {
    return capabilities.buildVersion;
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

function attachCompatibility<T>(
  result: TaskResult<T>,
  report: MediaBuyCompatibilityReport
): CompatibilityTaskResult<T> {
  return Object.assign(result, { compatibility: report });
}

function projectProducts(data: unknown, lifecycle: MediaBuyLifecycle): CompatibleProductsResponse {
  const source = record(data);
  const feedVersion = optionalString(lifecycle === 'compact' ? source.feed_version : source.wholesale_feed_version);
  const pricingVersion = optionalString(source.pricing_version);
  const nextCursor = optionalString(lifecycle === 'compact' ? source.next_cursor : record(source.pagination).cursor);
  return {
    ...(Array.isArray(source.products) && { products: source.products }),
    ...(Array.isArray(source.proposals) && { proposals: source.proposals }),
    ...(feedVersion && { feed_version: feedVersion }),
    ...(pricingVersion && { pricing_version: pricingVersion }),
    ...((source.unchanged === true || source.outcome === 'unchanged') && { unchanged: true as const }),
    ...(nextCursor && { next_cursor: nextCursor }),
    ...(source.pagination !== undefined && { pagination: source.pagination }),
    ...((source.cache_scope === 'public' || source.cache_scope === 'account') && {
      cache_scope: source.cache_scope,
    }),
    ...(Array.isArray(source.errors) && { errors: source.errors }),
    ...(source.context !== undefined && { context: source.context }),
    raw: source,
  };
}

function projectProposals(data: unknown): CompatibleProposalResponse {
  const source = record(data);
  const proposals: unknown[] = [];
  let sawProposalContainer = false;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      sawProposalContainer = true;
      value.forEach(visit);
      return;
    }
    const candidate = record(value);
    if (optionalString(candidate.proposal_id)) {
      sawProposalContainer = true;
      proposals.push(candidate);
    }
    for (const key of ['proposals', 'proposal', 'results']) {
      if (candidate[key] !== undefined) visit(candidate[key]);
    }
  };
  visit(source.proposals ?? source.results ?? source.proposal);
  const projected: CompatibleProposalResponse = {
    ...(Array.isArray(source.products) && { products: source.products }),
    ...(Array.isArray(source.errors) && { errors: source.errors }),
    ...(source.context !== undefined && { context: source.context }),
    raw: source,
  };
  if (sawProposalContainer) projected.proposals = proposals;
  return projected;
}

interface AcceptanceReservation {
  state: 'in-flight' | 'retryable' | 'retired';
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
}

interface ProposalSnapshotStore {
  entries: Map<string, ProposalSnapshotEntry>;
  retiredAcceptanceBits?: Uint8Array;
  retiredAcceptanceSalt?: Uint8Array;
  bytes: number;
}

interface SafeProposalSnapshot {
  proposal: Record<string, unknown>;
  canonicalTermsDigest?: string;
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

const proposalSnapshotStores = new WeakMap<AgentClient, ProposalSnapshotStore>();
const acceptanceReservationOwners = new WeakMap<AcceptanceReservation, MediaBuyLifecycleCoordinator>();

function proposalSnapshotStoreFor(agent: AgentClient): ProposalSnapshotStore {
  const existing = proposalSnapshotStores.get(agent);
  if (existing) return existing;
  const created: ProposalSnapshotStore = {
    entries: new Map(),
    bytes: 0,
  };
  proposalSnapshotStores.set(agent, created);
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
  private readonly pendingProposalTasks = new Map<string, { accountScope?: string }>();
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
  private acceptanceTaskUnsubscribe?: () => void;
  private readonly idempotencyReplayTtlMs?: number;
  private static readonly MAX_PROPOSAL_SNAPSHOTS = 256;
  private static readonly MAX_PROPOSAL_SNAPSHOT_BYTES = 256 * 1024;
  private static readonly MAX_PROPOSAL_SNAPSHOT_TOTAL_BYTES = 4 * 1024 * 1024;
  private static readonly MAX_PRINCIPAL_SCOPE_BYTES = 256;
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
    this.proposalSnapshotStore = proposalSnapshotStoreFor(agent);
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

  private selectLifecycle(compactTool: string): MediaBuyLifecycle {
    if (this.preferredLifecycle === 'established') {
      const establishedTool = ESTABLISHED_TOOL_FOR_COMPACT[compactTool as CompactLifecycleToolName];
      if (
        isCompactRelease(this.negotiated_version) &&
        this.tools.has(compactTool) &&
        !this.tools.has(establishedTool)
      ) {
        throw this.unsupported(
          compactTool,
          'established_lifecycle_not_advertised',
          `The seller advertises ${compactTool} but provides no evidence that ${establishedTool} is callable. ` +
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
    return 'established';
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
    if (existing) this.proposalSnapshotStore.bytes -= existing.bytes;
    this.proposalSnapshotStore.entries.delete(key);
  }

  private isRetiredAcceptanceKey(key: string): boolean {
    const bits = this.proposalSnapshotStore.retiredAcceptanceBits;
    const salt = this.proposalSnapshotStore.retiredAcceptanceSalt;
    if (!bits || !salt) return false;
    return retiredAcceptancePositions(key, salt, bits.length * 8).every(position => {
      const mask = 1 << (position & 7);
      return (bits[position >> 3]! & mask) !== 0;
    });
  }

  private markRetiredAcceptanceKey(key: string): void {
    const bits = (this.proposalSnapshotStore.retiredAcceptanceBits ??= new Uint8Array(256 * 1024));
    const salt = (this.proposalSnapshotStore.retiredAcceptanceSalt ??= randomBytes(16));
    for (const position of retiredAcceptancePositions(key, salt, bits.length * 8)) {
      bits[position >> 3] = bits[position >> 3]! | (1 << (position & 7));
    }
  }

  private enforceProposalSnapshotLimits(): void {
    while (
      this.proposalSnapshotStore.entries.size > MediaBuyLifecycleCoordinator.MAX_PROPOSAL_SNAPSHOTS ||
      this.proposalSnapshotStore.bytes > MediaBuyLifecycleCoordinator.MAX_PROPOSAL_SNAPSHOT_TOTAL_BYTES
    ) {
      const oldest = [...this.proposalSnapshotStore.entries].find(
        ([, entry]) => entry.acceptance?.state !== 'in-flight'
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
    preserveScope = false
  ): void {
    if (!this.principalScope) return;
    const wanted = new Set(proposalIds);
    for (const [key, entry] of [...this.proposalSnapshotStore.entries]) {
      if (entry.principalScope !== this.principalScope) continue;
      if (!wanted.has(String(entry.proposal.proposal_id))) continue;
      if (accountScope !== undefined && entry.accountScope !== accountScope) continue;
      if (entry.acceptance) continue;
      if (preserveScope && entry.accountScope) {
        this.removeProposalSnapshot(key);
        const proposal = { proposal_id: entry.proposal.proposal_id };
        const bytes = new TextEncoder().encode(`${key}${JSON.stringify(proposal)}`).byteLength;
        this.proposalSnapshotStore.entries.set(key, {
          proposal,
          bytes,
          principalScope: entry.principalScope,
          executable: false,
          accountScope: entry.accountScope,
        });
        this.proposalSnapshotStore.bytes += bytes;
      } else {
        this.removeProposalSnapshot(key);
      }
    }
  }

  private proposalIdsIn(data: unknown): string[] {
    const ids = new Set<string>();
    const seen = new WeakSet<object>();
    const visit = (value: unknown): void => {
      if (value === null || typeof value !== 'object' || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      const candidate = record(value);
      const proposalId = optionalString(candidate.proposal_id);
      if (proposalId) ids.add(proposalId);
      for (const key of ['proposals', 'proposal', 'results']) {
        if (candidate[key] !== undefined) visit(candidate[key]);
      }
    };
    visit(data);
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
    const visit = (value: unknown): void => {
      if (wanted.size === 0 || value === null || typeof value !== 'object' || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) {
        for (const item of value) {
          visit(item);
          if (wanted.size === 0) break;
        }
        return;
      }
      const candidate = record(value);
      const proposalId = optionalString(candidate.proposal_id);
      if (proposalId && wanted.delete(proposalId)) found.push(proposalId);
      for (const key of ['proposals', 'proposal', 'results']) {
        if (candidate[key] !== undefined) visit(candidate[key]);
      }
    };
    visit(data);
    return found;
  }

  private safeProposalPayload(data: unknown): { snapshots: SafeProposalSnapshot[] } | undefined {
    const snapshots = new Map<string, { snapshot: SafeProposalSnapshot; bytes: number } | null>();
    const seen = new WeakSet<object>();
    let bytes = 0;
    let overflowed = false;
    const visit = (value: unknown): void => {
      if (overflowed) return;
      if (value === null || typeof value !== 'object' || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) {
        for (const item of value) {
          visit(item);
          if (overflowed) break;
        }
        return;
      }
      const candidate = record(value);
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
      for (const key of ['proposals', 'proposal', 'results']) {
        if (candidate[key] !== undefined) visit(candidate[key]);
        if (overflowed) break;
      }
    };
    try {
      visit(data);
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
    adapt: (result: TaskResult<T>) => U
  ): Promise<U> {
    const captured = new Map<
      string,
      | {
          kind: 'success';
          proposalIds: string[];
          payload?: { snapshots: SafeProposalSnapshot[] };
          bytes: number;
        }
      | { kind: 'failure'; proposalIds: string[]; bytes: number }
    >();
    let capturedPayloadBytes = 0;
    let captureOverflowed = false;
    const unsubscribe = this.agent.onTaskUpdate(task => {
      if (['pending', 'running', 'working', 'submitted'].includes(task.status)) return;
      const success =
        task.status === 'completed' && task.result !== undefined && isAdcpOperationSuccess(task.result, task.taskType);
      const safe = success ? this.safeProposalPayload(task.result) : undefined;
      const proposalIds = task.result === undefined ? [] : this.cachedProposalIdsIn(task.result, accountScope);
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
        success
          ? { kind: 'success', proposalIds, ...(retainSafe && { payload: safe }), bytes }
          : { kind: 'failure', proposalIds, bytes }
      );
      capturedPayloadBytes += bytes;
      while (capturedPayloadBytes > MediaBuyLifecycleCoordinator.MAX_PROPOSAL_SNAPSHOT_TOTAL_BYTES) {
        const oldestWithPayload = [...captured].find(([, entry]) => entry.kind === 'success' && entry.payload);
        if (!oldestWithPayload) break;
        const [taskId, entry] = oldestWithPayload;
        capturedPayloadBytes -= entry.bytes;
        captured.set(taskId, { kind: 'success', proposalIds: entry.proposalIds, bytes: 0 });
      }
      while (captured.size > 32) {
        const oldest = captured.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        capturedPayloadBytes -= captured.get(oldest)?.bytes ?? 0;
        captured.delete(oldest);
        captureOverflowed = true;
      }
    });
    return dispatch()
      .then(
        result => {
          const racedCompletion = captured.get(result.metadata.taskId);
          if (racedCompletion?.kind === 'success') {
            this.invalidateProposalSnapshots(racedCompletion.proposalIds, accountScope);
            if (racedCompletion.payload) {
              for (const snapshot of racedCompletion.payload.snapshots) {
                this.rememberSafeProposalSnapshot(snapshot, accountScope);
              }
            }
          } else if (racedCompletion?.kind === 'failure') {
            this.invalidateProposalSnapshots(racedCompletion.proposalIds, accountScope);
          } else if (captureOverflowed) {
            // The dispatch task ID is not knowable until dispatch returns. If
            // unrelated terminal events overflow the bounded correlation map,
            // a missing match might be the evicted task. Retire every mutable
            // snapshot in scope rather than leave stale execution evidence.
            this.invalidateProposalSnapshots(this.cachedProposalIds(accountScope), accountScope);
          }
          // adaptProjectedResult installs the long-lived watcher, when needed,
          // before this pre-dispatch listener is released.
          const output = adapt(result);
          if (racedCompletion || captureOverflowed) this.forgetProposalTask(result.metadata.taskId);
          return output;
        },
        error => {
          // A terminal event can beat a transport failure. Without the
          // dispatch result there is no trustworthy task ID for correlation,
          // so any captured terminal evidence makes every mutable snapshot in
          // this scope unsafe to reuse.
          if (captured.size > 0 || captureOverflowed) {
            this.invalidateProposalSnapshots(this.cachedProposalIds(accountScope), accountScope);
          }
          throw error;
        }
      )
      .finally(unsubscribe);
  }

  private watchProposalTask(taskId: string | undefined, accountScope: string | undefined): void {
    if (!taskId || !this.principalScope) return;
    this.pendingProposalTasks.delete(taskId);
    this.pendingProposalTasks.set(taskId, { accountScope });
    const priorTimer = this.pendingProposalTaskTimers.get(taskId);
    if (priorTimer) clearTimeout(priorTimer);
    const timer = setTimeout(
      () => this.forgetProposalTask(taskId),
      MediaBuyLifecycleCoordinator.PROPOSAL_TASK_WATCH_TTL_MS
    );
    timer.unref?.();
    this.pendingProposalTaskTimers.set(taskId, timer);
    while (this.pendingProposalTasks.size > MediaBuyLifecycleCoordinator.MAX_PROPOSAL_SNAPSHOTS) {
      const oldest = this.pendingProposalTasks.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.forgetProposalTask(oldest);
    }
    const handleUpdate = (task: import('../core/ConversationTypes').TaskInfo): void => {
      const pending = this.pendingProposalTasks.get(task.taskId);
      if (!pending) return;
      if (
        task.status === 'completed' &&
        task.result !== undefined &&
        isAdcpOperationSuccess(task.result, task.taskType)
      ) {
        this.rememberProposals(task.result, pending.accountScope);
      } else if (['pending', 'running', 'working', 'submitted'].includes(task.status)) {
        return;
      } else {
        if (task.result !== undefined) {
          this.invalidateProposalSnapshots(this.proposalIdsIn(task.result), pending.accountScope);
        }
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
    return this.proposalSnapshotStore.entries.get(snapshotKey) === snapshot && snapshot.acceptance === reservation;
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
    this.releaseAcceptanceOwnership(reservation);
    delete snapshot.acceptance;
    snapshot.executable = true;
  }

  private retireAcceptance(
    snapshotKey: string,
    snapshot: ProposalSnapshotEntry,
    reservation: AcceptanceReservation
  ): void {
    if (!this.ownsAcceptance(snapshotKey, snapshot, reservation) || reservation.state === 'retired') return;
    reservation.state = 'retired';
    snapshot.executable = false;
    this.releaseAcceptanceOwnership(reservation);
    this.removeProposalSnapshot(snapshotKey);
    this.markRetiredAcceptanceKey(snapshotKey);
  }

  private preserveAmbiguousAcceptance(
    snapshotKey: string,
    snapshot: ProposalSnapshotEntry,
    reservation: AcceptanceReservation,
    taskId?: string
  ): void {
    if (!this.ownsAcceptance(snapshotKey, snapshot, reservation) || reservation.state !== 'in-flight') return;
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
    if (result.status === 'input-required' || result.status === 'auth-required') {
      this.preserveAmbiguousAcceptance(snapshotKey, snapshot, reservation, result.metadata.taskId);
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
    if (result.status === 'working' || result.status === 'submitted' || result.status === 'deferred') {
      this.watchAcceptanceTask(result.metadata.taskId, snapshotKey, snapshot, reservation);
      return;
    }
    this.retireAcceptance(snapshotKey, snapshot, reservation);
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
    if (['input-required', 'auth-required', 'needs_input'].includes(task.status)) {
      this.preserveAmbiguousAcceptance(snapshotKey, snapshot, reservation, watchedTaskId);
      return;
    }
    if (['pending', 'running', 'working', 'submitted', 'deferred'].includes(task.status)) return;
    if (task.status === 'completed') {
      if (isAdcpOperationSuccess(task.result, task.taskType)) {
        this.retireAcceptance(snapshotKey, snapshot, reservation);
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
      if (reservation.state === 'in-flight') this.retireAcceptance(snapshotKey, snapshot, reservation);
      this.forgetAcceptanceTask(taskId, reservation);
    }, MediaBuyLifecycleCoordinator.PROPOSAL_TASK_WATCH_TTL_MS);
    timer.unref?.();
    this.pendingAcceptanceTaskTimers.set(taskId, timer);
    const handleUpdate = (task: import('../core/ConversationTypes').TaskInfo): void => {
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
    const localTaskId = result.metadata.taskId;
    this.transitionAcceptanceResult(result, snapshotKey, snapshot, reservation);
    if (result.submitted) {
      const submitted = result.submitted;
      (result as { submitted?: unknown }).submitted = {
        ...submitted,
        track: async (transport?: import('../protocols').TransportOptions) => {
          try {
            const task = await submitted.track(transport);
            this.transitionAcceptanceTask(task, snapshotKey, snapshot, reservation, localTaskId);
            return task;
          } catch (error) {
            this.preserveAmbiguousAcceptance(snapshotKey, snapshot, reservation, localTaskId);
            throw error;
          }
        },
        waitForCompletion: async (pollInterval?: number, signal?: AbortSignal) => {
          try {
            const completed = await submitted.waitForCompletion(pollInterval, signal);
            this.transitionAcceptanceResult(completed, snapshotKey, snapshot, reservation);
            return completed;
          } catch (error) {
            this.preserveAmbiguousAcceptance(snapshotKey, snapshot, reservation, localTaskId);
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
            const resumed = await deferred.resume(input);
            this.transitionAcceptanceResult(resumed, snapshotKey, snapshot, reservation);
            return resumed;
          } catch (error) {
            this.preserveAmbiguousAcceptance(snapshotKey, snapshot, reservation, localTaskId);
            throw error;
          }
        },
      };
    }
    return result;
  }

  dispose(): void {
    for (const taskId of [...this.pendingProposalTasks.keys()]) this.forgetProposalTask(taskId);
    this.proposalTaskUnsubscribe?.();
    this.proposalTaskUnsubscribe = undefined;
    for (const [reservation, pending] of [...this.ownedAcceptanceReservations]) {
      this.retireAcceptance(pending.snapshotKey, pending.snapshot, reservation);
      this.releaseAcceptanceOwnership(reservation);
    }
    this.acceptanceTaskUnsubscribe?.();
    this.acceptanceTaskUnsubscribe = undefined;
  }

  private rememberProposals(data: unknown, accountScope?: string): void {
    if (!this.principalScope) return;
    const seen = new WeakSet<object>();
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        if (seen.has(value)) return;
        seen.add(value);
        value.forEach(visit);
        return;
      }
      const candidate = record(value);
      if (Object.keys(candidate).length === 0 || seen.has(candidate)) return;
      seen.add(candidate);
      const proposalId = optionalString(candidate.proposal_id);
      if (proposalId) {
        const key = this.snapshotKey(proposalId, accountScope);
        if (this.isRetiredAcceptanceKey(key)) return;
        if (this.proposalSnapshotStore.entries.get(key)?.acceptance) return;
        // A newly observed seller representation supersedes the prior one.
        // Invalidate first so an unsafe, oversized, or unserializable
        // replacement cannot leave stale executable terms behind.
        this.removeProposalSnapshot(key);
        try {
          const safeSnapshot = safeProposalSnapshot(candidate);
          if (!safeSnapshot) return;
          this.rememberSafeProposalSnapshot(safeSnapshot, accountScope);
        } catch {
          // Seller responses must be JSON. An unserializable proposal is not a
          // safe immutable acceptance snapshot, so leave it out of the cache.
        }
      }
      for (const key of ['proposals', 'proposal', 'results']) {
        if (candidate[key] !== undefined) visit(candidate[key]);
      }
    };
    visit(data);
  }

  private rememberSafeProposalSnapshot(snapshot: SafeProposalSnapshot, accountScope?: string): void {
    if (!this.principalScope) return;
    const proposalId = optionalString(snapshot.proposal.proposal_id);
    if (!proposalId) return;
    const key = this.snapshotKey(proposalId, accountScope);
    if (this.isRetiredAcceptanceKey(key) || this.proposalSnapshotStore.entries.get(key)?.acceptance) return;
    this.removeProposalSnapshot(key);
    const bytes = new TextEncoder().encode(`${key}${JSON.stringify(snapshot)}`).byteLength;
    if (bytes > MediaBuyLifecycleCoordinator.MAX_PROPOSAL_SNAPSHOT_BYTES) return;
    const retained = structuredClone(snapshot);
    this.proposalSnapshotStore.entries.set(key, {
      proposal: retained.proposal,
      bytes,
      principalScope: this.principalScope,
      executable: true,
      ...(accountScope && { accountScope }),
      ...(retained.canonicalTermsDigest && { canonicalTermsDigest: retained.canonicalTermsDigest }),
    });
    this.proposalSnapshotStore.bytes += bytes;
    this.enforceProposalSnapshotLimits();
  }

  private adaptProjectedResult<T, U>(
    result: TaskResult<T>,
    report: MediaBuyCompatibilityReport,
    project: (data: T) => U,
    accountScope?: string,
    retainProposals = false
  ): CompatibilityTaskResult<U> {
    const localTaskId = result.metadata.taskId;
    const adapt = (current: TaskResult<T>): CompatibilityTaskResult<U> => {
      if (
        current.success &&
        current.status === 'completed' &&
        isAdcpOperationSuccess(current.data, current.metadata.taskName)
      ) {
        if (retainProposals) this.rememberProposals(current.data, accountScope);
        (current as TaskResult<unknown>).data = project(current.data);
      } else if (retainProposals && current.data !== undefined) {
        this.invalidateProposalSnapshots(this.proposalIdsIn(current.data), accountScope);
      }
      if (retainProposals && ['working', 'submitted'].includes(current.status)) {
        this.watchProposalTask(localTaskId, accountScope);
      } else if (retainProposals) {
        this.forgetProposalTask(localTaskId);
      }

      const output = current as unknown as TaskResult<U>;
      if (current.submitted) {
        const submitted = current.submitted;
        (output as { submitted?: unknown }).submitted = {
          ...submitted,
          track: async (transport?: import('../protocols').TransportOptions) => {
            const task = await submitted.track(transport);
            if (
              task.status === 'completed' &&
              task.result !== undefined &&
              isAdcpOperationSuccess(task.result, task.taskType)
            ) {
              if (retainProposals) this.rememberProposals(task.result, accountScope);
              task.result = project(task.result as T);
              if (retainProposals) this.forgetProposalTask(localTaskId);
            } else if (retainProposals && !['pending', 'running', 'working', 'submitted'].includes(task.status)) {
              if (task.result !== undefined) {
                this.invalidateProposalSnapshots(this.proposalIdsIn(task.result), accountScope);
              }
              this.forgetProposalTask(localTaskId);
            }
            return task;
          },
          waitForCompletion: async (pollInterval?: number, signal?: AbortSignal) =>
            adapt(await submitted.waitForCompletion(pollInterval, signal)),
        };
      }
      if (current.deferred) {
        const deferred = current.deferred;
        (output as { deferred?: unknown }).deferred = {
          ...deferred,
          resume: async (input: unknown) => adapt(await deferred.resume(input)),
        };
      }
      return attachCompatibility(output, report);
    };
    return adapt(result);
  }

  async listProducts(
    params: ListProductsRequest,
    inputHandler?: InputHandler,
    options?: CanonicalProjectionTaskOptions
  ): Promise<CompatibilityTaskResult<CompatibleProductsResponse>> {
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
      ...(compareRelease(this.negotiated_version, '3.0') >= 0 && {
        pagination: {
          ...(input.cursor !== undefined && { cursor: input.cursor }),
          max_results: input.max_results ?? 25,
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
  ): Promise<CompatibilityTaskResult<CompatibleProposalResponse>> {
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
            projectProposals,
            accountScope,
            true
          )
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
          projectProposals,
          accountScope,
          true
        )
    );
  }

  async refineProposals(
    params: RefineProposalsInput,
    inputHandler?: InputHandler,
    options?: ProposalRefinementTaskOptions
  ): Promise<CompatibilityTaskResult<CompatibleProposalResponse>> {
    const lifecycle = this.selectLifecycle('refine_proposals');
    this.assertValidCompactRequest('refine_proposals', params, lifecycle, true);
    if (lifecycle === 'compact') {
      const proposalIds = params.refinements.map(refinement => refinement.proposal_id);
      const scopes = this.proposalScopes(proposalIds);
      const accountScope = scopes.length === 1 ? scopes[0] : undefined;
      this.invalidateProposalSnapshots(proposalIds, undefined, true);
      return this.captureProposalDispatch(
        accountScope,
        () => this.agent.refineProposals(params, inputHandler, options),
        result =>
          this.adaptProjectedResult(
            result,
            this.makeReport(lifecycle, ['refine_proposals'], []),
            projectProposals,
            accountScope,
            true
          )
      );
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
    const request: CanonicalGetProductsRequest = {
      buying_mode: 'refine',
      refine: legacyRefine as CanonicalGetProductsRequest['refine'],
      ...(optionalString(params.idempotency_key)
        ? { idempotency_key: optionalString(params.idempotency_key) }
        : !options?.skipIdempotencyAutoInject
          ? { idempotency_key: generateIdempotencyKey() }
          : {}),
      ...(params.push_notification_config !== undefined && {
        push_notification_config:
          params.push_notification_config as unknown as CanonicalGetProductsRequest['push_notification_config'],
      }),
      ...(params.context !== undefined && { context: params.context as CanonicalGetProductsRequest['context'] }),
    };
    const proposalIds = params.refinements.map(refinement => refinement.proposal_id);
    const scopes = this.proposalScopes(proposalIds);
    const accountScope = scopes.length === 1 ? scopes[0] : undefined;
    this.invalidateProposalSnapshots(proposalIds, undefined, true);
    return this.captureProposalDispatch(
      accountScope,
      () => this.agent.getProducts(request, inputHandler, options),
      result =>
        this.adaptProjectedResult(
          result,
          this.makeReport(lifecycle, ['get_products'], []),
          projectProposals,
          accountScope,
          true
        )
    );
  }

  async declineProposals(
    params: MutatingRequestInput<DeclineProposalsRequest>,
    inputHandler?: InputHandler,
    options?: CanonicalProjectionTaskOptions
  ): Promise<CompatibilityTaskResult<CompatibleProposalResponse>> {
    const input = record(params);
    const lifecycle = this.selectLifecycle('decline_proposals');
    if (lifecycle === 'compact') {
      this.assertValidCompactRequest('decline_proposals', params, lifecycle, true);
      const result = await this.agent.declineProposals(params, inputHandler, options);
      return this.adaptProjectedResult(result, this.makeReport(lifecycle, ['decline_proposals'], []), projectProposals);
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
    const request: CanonicalGetProductsRequest = {
      buying_mode: 'refine',
      refine: declines as CanonicalGetProductsRequest['refine'],
      ...(optionalString(input.idempotency_key)
        ? { idempotency_key: optionalString(input.idempotency_key) }
        : !options?.skipIdempotencyAutoInject
          ? { idempotency_key: generateIdempotencyKey() }
          : {}),
      ...(input.push_notification_config !== undefined && {
        push_notification_config:
          input.push_notification_config as CanonicalGetProductsRequest['push_notification_config'],
      }),
      ...(input.context !== undefined && { context: input.context as CanonicalGetProductsRequest['context'] }),
    };
    this.assertValidCompactRequest('decline_proposals', params, lifecycle, true);
    const result = await this.agent.getProducts(request, inputHandler, options);
    return this.adaptProjectedResult(
      result,
      this.makeReport(lifecycle, ['get_products'], losses, [
        'Legacy proposal omit is not a seller-confirmed terminal decline.',
        'Legacy proposal omit cannot forward the compact decline reason or detail.',
      ]),
      projectProposals
    );
  }

  async buyProducts(
    params: MutatingRequestInput<BuyProductsRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<CompatibilityTaskResult<BuyProductsResponse | CreateMediaBuyResponse>> {
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
    const input = record(params);
    const lifecycle = this.selectLifecycle('accept_proposal');
    this.assertLegacyReferenceShapes('acceptProposal', input);
    if (lifecycle === 'compact') {
      const { established_fallback: _fallback, ...compactInput } = input;
      this.assertValidCompactRequest('accept_proposal', compactInput, lifecycle, true);
      const result = await this.agent.acceptProposal(
        compactInput as MutatingRequestInput<AcceptProposalRequest>,
        inputHandler,
        options
      );
      return this.adaptProjectedResult(result, this.makeReport(lifecycle, ['accept_proposal'], []), data => data);
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
    const accountScope = this.accountScope(input.account);
    const snapshotKey = accountScope ? this.snapshotKey(proposalId, accountScope) : undefined;
    const snapshot = snapshotKey ? this.proposalSnapshotStore.entries.get(snapshotKey) : undefined;
    const retryableAcceptance = snapshot?.acceptance?.state === 'retryable' ? snapshot.acceptance : undefined;
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
      state: 'in-flight',
      requestFingerprint: fingerprint,
      skipIdempotencyAutoInject:
        retryableAcceptance?.skipIdempotencyAutoInject ?? Boolean(options?.skipIdempotencyAutoInject),
      ...(acceptanceIdempotencyKey && { idempotencyKey: acceptanceIdempotencyKey }),
      ...(retryDeadlineMs !== undefined && { retryDeadlineMs }),
    };
    snapshot.executable = false;
    snapshot.acceptance = reservation;
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
    if (compareRelease(this.negotiated_version, '3.0') < 0) {
      throw this.unsupported(
        'getMediaBuys',
        'media_buy_readback',
        `The negotiated ${this.negotiated_version} seller has no get_media_buys tool.`
      );
    }
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
    if (compareRelease(this.negotiated_version, '3.0') < 0) {
      throw this.unsupported(
        'getMediaBuyDelivery',
        'media_buy_delivery_readback',
        `The negotiated ${this.negotiated_version} delivery request cannot safely represent the compact account-scoped readback.`
      );
    }
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
