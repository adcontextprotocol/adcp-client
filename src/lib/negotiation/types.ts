/** Public AdCP proposal-negotiation types (introduced by the 3.2 contract). */

import type {
  AcceptanceContext,
  CanonicalInstallmentReference,
  CanonicalProposal as GeneratedCanonicalProposal,
  MediaBuyFrequencyCap,
  OutcomeTarget,
  ProductMediaBuySupportRequirements,
  ProductPurchase as GeneratedProductPurchase,
  ResponseCollection,
} from '../types/core.generated';

export type {
  AcceptanceContext,
  CanonicalDeliveryForecast,
  CanonicalForecastPoint,
  MediaBuyFrequencyCap,
  OutcomeTarget,
  ProductMediaBuySupportRequirements,
} from '../types/core.generated';

export const PROPOSAL_REFINEMENT_DIMENSIONS = [
  'total_budget',
  'cpm',
  'impressions',
  'flight',
  'product_changes',
  'installment_changes',
  'alternatives',
  'criteria',
] as const;

export type ProposalRefinementDimension = (typeof PROPOSAL_REFINEMENT_DIMENSIONS)[number];

export interface ProposalRefinementCapabilities {
  supported_dimensions: readonly ProposalRefinementDimension[];
  max_alternatives?: number;
  /**
   * Experimental, AdCP 3.3 only (`media_buy.hold_extension`). Whether the
   * seller accepts `action: "extend_hold"`. Buyers must not send it unless this
   * is `true`. A seller that sets it must also list `media_buy.hold_extension`
   * in `experimental_features`. It is not projected to AdCP 3.2 callers.
   */
  hold_extension?: boolean;
}

/** Typed view of the seller's compact proposal-lifecycle discovery fields. */
export interface ProposalRefinementSupport {
  /** Whether `media_buy.lifecycle_tools` explicitly includes `refine_proposals`. */
  supported: boolean;
  /** Present only when the seller advertises `media_buy.proposal_refinement`. */
  capabilities?: ProposalRefinementCapabilities;
}

export interface ProposalBudgetConstraint {
  currency: string;
  min?: number;
  max?: number;
}

export interface ProposalCpmConstraint {
  max: number;
  currency: string;
}

export interface ProposalImpressionsConstraint {
  min: number;
}

export interface ProposalFlightConstraint {
  start_no_later_than?: string;
  end_no_earlier_than?: string;
}

export interface ProposalConstraints {
  total_budget?: ProposalBudgetConstraint;
  cpm?: ProposalCpmConstraint;
  impressions?: ProposalImpressionsConstraint;
  flight?: ProposalFlightConstraint;
}

export type ProposalProductChange = 'include' | 'omit';
export type ProposalProductChanges = Record<string, ProposalProductChange>;

/**
 * Experimental AdCP 3.3 installment-level refinement entry
 * (`media_buy.installment_refinement`). Entries are unique by
 * `(product_id, installment_ref)`.
 */
export interface ProposalInstallmentChange {
  product_id: string;
  installment_ref: CanonicalInstallmentReference;
  action: ProposalProductChange;
}

/** A requested installment change the seller did not satisfy, with its reason. */
export interface ProposalUnsatisfiedInstallmentChange extends ProposalInstallmentChange {
  reason: string;
}

/**
 * AdCP 3.2 structured discovery criteria. Referenced offer/overlay objects
 * retain forward-compatible value typing, while the closed top-level and
 * catalog-selector vocabularies remain type-safe today.
 */
export interface ProposalDiscoveryCriteria {
  product_ids?: string[];
  offer_filters?: Record<string, unknown>;
  targeting_overlay?: Record<string, unknown>;
  media_buy_frequency_cap?: MediaBuyFrequencyCap;
  required_overlay_support?: Record<string, unknown>;
  required_media_buy_support?: ProductMediaBuySupportRequirements;
  outcome_target?: OutcomeTarget;
  acceptance_context?: AcceptanceContext;
  catalog?: ProposalDiscoveryCatalogCriteria;
  policy_ids?: string[];
  ext?: Record<string, unknown>;
}

export type ProposalDiscoveryCatalogType =
  | 'offering'
  | 'product'
  | 'inventory'
  | 'store'
  | 'promotion'
  | 'hotel'
  | 'flight'
  | 'job'
  | 'vehicle'
  | 'real_estate'
  | 'education'
  | 'destination'
  | 'app';

export interface ProposalDiscoveryCatalogCriteria {
  catalog_id: string;
  type?: ProposalDiscoveryCatalogType;
  ids?: string[];
  gtins?: string[];
  category?: string;
  tags?: string[];
  query?: string;
}

export interface ReviseProposalRefinement {
  proposal_id: string;
  action: 'revise';
  change_kind?: 'amendment' | 'cancellation';
  constraints?: ProposalConstraints;
  product_changes?: ProposalProductChanges;
  /** Experimental, AdCP 3.3 only (`media_buy.installment_refinement`). */
  installment_changes?: ProposalInstallmentChange[];
  alternatives?: { count: number };
  ask?: string;
  criteria?: ProposalDiscoveryCriteria;
  remove_media_buy_frequency_cap?: true;
  /** Vendor extension point; opaque to the protocol. */
  ext?: Record<string, unknown>;
}

export interface FinalizeProposalRefinement {
  proposal_id: string;
  action: 'finalize';
  /** Vendor extension point; opaque to the protocol. */
  ext?: Record<string, unknown>;
}

/**
 * Experimental, AdCP 3.3 only (`media_buy.hold_extension`). Extends the hold
 * on a committed, unexpired proposal. A successful extension returns
 * `outcome: "finalized"` with a new committed successor that keeps the
 * source's `commercial_terms`, `terms_digest`, `hold_policy` and
 * `hold_placed_at`, and carries a later `expires_at`. Like finalize, it changes
 * no terms, and a batch containing it contains only `extend_hold` entries.
 */
export interface ExtendHoldProposalRefinement {
  proposal_id: string;
  action: 'extend_hold';
  /** Vendor extension point; opaque to the protocol. */
  ext?: Record<string, unknown>;
}

export type ProposalRefinement = ReviseProposalRefinement | FinalizeProposalRefinement | ExtendHoldProposalRefinement;

export type Adcp32Version = '3.2' | `3.2-${string}`;

/** Supported proposal-refinement release pins; patches belong to schema pins. */
export type ProposalRefinementVersion = Adcp32Version | '3.3' | `3.3-${string}`;

export interface RefineProposalsRequest {
  idempotency_key: string;
  refinements: ProposalRefinement[];
  context_id?: string;
  context?: Record<string, unknown>;
  governance_context?: string;
  push_notification_config?: Record<string, unknown>;
  /**
   * Experimental, AdCP 3.3 only (`media_buy.collection_cards`). Asks the seller
   * to return the response-level `collections` array. Send it only to a seller
   * that lists `media_buy.collection_cards` in `experimental_features`.
   */
  include_collections?: boolean;
  /** Vendor extension point; opaque to the protocol. */
  ext?: Record<string, unknown>;
  adcp_version: ProposalRefinementVersion;
  adcp_major_version: 3;
}

export type RefineProposalsInput = Omit<
  RefineProposalsRequest,
  'idempotency_key' | 'adcp_version' | 'adcp_major_version'
> & {
  idempotency_key?: string;
  adcp_version?: ProposalRefinementVersion;
  adcp_major_version?: 3;
};

export interface ProposalResolvedPricing {
  pricing_option_id: string;
  pricing_model: string;
  currency: string;
  fixed_price?: number;
  floor_price?: number;
  min_spend_per_package?: number;
  commission_rate?: number;
}

/**
 * A purchase inside proposal commercial terms. Every field comes from the
 * generated `ProductPurchase` wire type, so fields the pinned schemas add reach
 * this type without edits here. Only `pricing` is widened.
 */
export interface ProposalPurchase extends Omit<GeneratedProductPurchase, ProposalPurchaseOverriddenKey> {
  /** Resolved pricing is required in accepted snapshots but optional on direct-purchase inputs. */
  pricing?: ProposalResolvedPricing | GeneratedProductPurchase['pricing'];
}

/** Generated `ProductPurchase` fields whose SDK type is intentionally wider. */
type ProposalPurchaseOverriddenKey = 'pricing';

export interface ProposalCommercialTerms<TPurchase extends ProposalPurchase = ProposalPurchase> {
  /** Keep the legacy open object while accepting the generated compact BrandKey. */
  brand: Record<string, unknown> | GeneratedCanonicalProposal['commercial_terms']['brand'];
  purchases: TPurchase[];
  start_time: string;
  end_time: string;
  total_budget?: { amount: number; currency: string };
}

/**
 * A canonical proposal snapshot. Every field comes from the generated
 * `CanonicalProposal` wire type (including fields such as `hold_policy` and
 * `hold_placed_at` once the pinned schemas define them), so the SDK type tracks
 * spec revisions without edits here. Only two fields are re-declared:
 * `commercial_terms` is generic over the caller's terms type and `insertion_order` keeps the
 * legacy open object.
 */
export interface CanonicalProposal<TTerms extends ProposalCommercialTerms = ProposalCommercialTerms> extends Omit<
  GeneratedCanonicalProposal,
  CanonicalProposalOverriddenKey
> {
  commercial_terms: TTerms;
  insertion_order?: Record<string, unknown> | GeneratedCanonicalProposal['insertion_order'];
}

/** Generated `CanonicalProposal` fields whose SDK type is intentionally re-declared. */
type CanonicalProposalOverriddenKey = 'commercial_terms' | 'insertion_order';

export type ProposalRefinementReason =
  | 'commercially_declined'
  | 'constraint_unsatisfiable'
  | 'unsupported_dimension'
  | 'uninterpreted'
  | 'alternatives_unavailable'
  | 'source_unavailable'
  | 'hold_unavailable'
  | 'batch_aborted';

export interface RefinedProposalResult<TProposal extends CanonicalProposal = CanonicalProposal> {
  source_proposal_id: string;
  outcome: 'revised';
  proposals: TProposal[];
  ext?: Record<string, unknown>;
}

export interface PartialProposalResult<TProposal extends CanonicalProposal = CanonicalProposal> {
  source_proposal_id: string;
  outcome: 'partial';
  proposals: TProposal[];
  reason_code: ProposalRefinementReason;
  reason: string;
  unsatisfied_constraints?: string[];
  unsatisfied_product_changes?: ProposalProductChanges;
  unsatisfied_installment_changes?: ProposalUnsatisfiedInstallmentChange[];
  suggestions?: string[];
  targeting_resolution?: Record<string, unknown>;
  ext?: Record<string, unknown>;
}

export interface UnableProposalResult {
  source_proposal_id: string;
  outcome: 'unable';
  reason_code: ProposalRefinementReason;
  reason: string;
  unsatisfied_constraints?: string[];
  unsatisfied_product_changes?: ProposalProductChanges;
  unsatisfied_installment_changes?: ProposalUnsatisfiedInstallmentChange[];
  suggestions?: string[];
  ext?: Record<string, unknown>;
}

export interface FinalizedProposalResult<TProposal extends CanonicalProposal = CanonicalProposal> {
  source_proposal_id: string;
  outcome: 'finalized';
  proposal: TProposal;
  ext?: Record<string, unknown>;
}

export type ProposalRefinementResult<TProposal extends CanonicalProposal = CanonicalProposal> =
  | RefinedProposalResult<TProposal>
  | PartialProposalResult<TProposal>
  | UnableProposalResult
  | FinalizedProposalResult<TProposal>;

export interface ProposalAdvisoryError {
  code: string;
  message: string;
  [key: string]: unknown;
}

interface RefineProposalsResponseEnvelope {
  adcp_version?: string;
  replayed?: true;
  context?: Record<string, unknown>;
  ext?: Record<string, unknown>;
  errors?: ProposalAdvisoryError[];
}

export interface RefineProposalsCompletedResponse<
  TProposal extends CanonicalProposal = CanonicalProposal,
  TProduct = Record<string, unknown>,
> extends RefineProposalsResponseEnvelope {
  status?: 'completed';
  results: ProposalRefinementResult<TProposal>[];
  products: TProduct[];
  /**
   * Experimental, AdCP 3.3 only (`media_buy.collection_cards`). Full collection
   * objects for collections the returned products reference. Present only when
   * the request set `include_collections: true`. Convenience copies, never
   * authorization evidence.
   */
  collections?: ResponseCollection[];
  message?: string;
}

/** Compact async acknowledgement; terminal proposal fields arrive with task completion. */
export interface RefineProposalsSubmittedResponse extends RefineProposalsResponseEnvelope {
  status: 'submitted';
  task_id: string;
  /**
   * AdCP 3.3 only. Seller's estimate of when a finalize-only or
   * extend_hold-only request resolves. An estimate, not an expiry: schedule a
   * status check for it and do not treat a passed timestamp as failure.
   */
  expected_confirmation_at?: string;
  message?: string;
}

export type RefineProposalsResponse<
  TProposal extends CanonicalProposal = CanonicalProposal,
  TProduct = Record<string, unknown>,
> = RefineProposalsCompletedResponse<TProposal, TProduct> | RefineProposalsSubmittedResponse;

export interface UnsupportedRefinementDimensionDetails {
  unsupported_dimension: string;
  supported_dimensions: string[];
  [key: string]: unknown;
}

export interface ProposalVerificationIssue {
  code:
    | 'result_count'
    | 'result_order'
    | 'shape'
    | 'outcome'
    | 'lineage'
    | 'proposal_identity'
    | 'proposal_status'
    | 'hold_expired'
    | 'hold_extension'
    | 'alternative_count'
    | 'duplicate_terms'
    | 'duplicate_digest'
    | 'terms_digest'
    | 'constraint'
    | 'unsatisfied_subset'
    | 'partial_invariant';
  path: string;
  message: string;
}

export interface ProposalVerificationResult {
  ok: boolean;
  issues: ProposalVerificationIssue[];
}

export type ProposalCommercialTermsMismatch =
  | {
      kind: 'digest_mismatch';
      path: '/terms_digest';
      message: string;
    }
  | {
      kind: 'invalid_terms';
      subject: 'proposal' | 'expected';
      path: string;
      keyword?: string;
      message: string;
    }
  | {
      kind: 'missing' | 'unexpected' | 'changed';
      path: string;
      message: string;
    }
  | {
      kind: 'schema_unavailable' | 'unsupported_schema';
      path: '/commercial_terms';
      message: string;
    };

export interface ProposalCommercialTermsVerificationResult {
  ok: boolean;
  /** Exact release declared by the selected bundle, when it could be loaded. */
  schemaVersion?: string;
  /** True when diagnostics reached the bounded mismatch-reporting limit. */
  truncated?: boolean;
  mismatches: ProposalCommercialTermsMismatch[];
}

export interface VerifyProposalCommercialTermsOptions {
  /**
   * Schema bundle used to define binding commercial-term fields. Defaults to
   * the SDK pin. Pass the seller-served release when verifying another line.
   */
  adcpVersion?: string;
}
