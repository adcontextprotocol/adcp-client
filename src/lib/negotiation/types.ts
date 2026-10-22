/** Public AdCP proposal-negotiation types (introduced by the 3.2 contract). */

import type {
  AcceptanceContext,
  CanonicalProposal as GeneratedCanonicalProposal,
  MediaBuyFrequencyCap,
  OutcomeTarget,
  ProductMediaBuySupportRequirements,
  ProductPurchase as GeneratedProductPurchase,
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
  'alternatives',
  'criteria',
] as const;

export type ProposalRefinementDimension = (typeof PROPOSAL_REFINEMENT_DIMENSIONS)[number];

export interface ProposalRefinementCapabilities {
  supported_dimensions: readonly ProposalRefinementDimension[];
  max_alternatives?: number;
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
  alternatives?: { count: number };
  ask?: string;
  criteria?: ProposalDiscoveryCriteria;
  remove_media_buy_frequency_cap?: true;
}

export interface FinalizeProposalRefinement {
  proposal_id: string;
  action: 'finalize';
}

export type ProposalRefinement = ReviseProposalRefinement | FinalizeProposalRefinement;

export type Adcp32Version = '3.2' | `3.2-${string}`;

/** AdCP 3 release pins; runtime validation enforces the 3.2 minimum. */
export type ProposalRefinementVersion = `3.${number}` | `3.${number}-${string}`;

export interface RefineProposalsRequest {
  idempotency_key: string;
  refinements: ProposalRefinement[];
  context_id?: string;
  context?: Record<string, unknown>;
  governance_context?: string;
  push_notification_config?: Record<string, unknown>;
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
}

export interface PartialProposalResult<TProposal extends CanonicalProposal = CanonicalProposal> {
  source_proposal_id: string;
  outcome: 'partial';
  proposals: TProposal[];
  reason_code: ProposalRefinementReason;
  reason: string;
  unsatisfied_constraints?: string[];
  unsatisfied_product_changes?: ProposalProductChanges;
  suggestions?: string[];
  targeting_resolution?: Record<string, unknown>;
}

export interface UnableProposalResult {
  source_proposal_id: string;
  outcome: 'unable';
  reason_code: ProposalRefinementReason;
  reason: string;
  unsatisfied_constraints?: string[];
  unsatisfied_product_changes?: ProposalProductChanges;
  suggestions?: string[];
}

export interface FinalizedProposalResult<TProposal extends CanonicalProposal = CanonicalProposal> {
  source_proposal_id: string;
  outcome: 'finalized';
  proposal: TProposal;
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
  message?: string;
}

/** Compact async acknowledgement; terminal proposal fields arrive with task completion. */
export interface RefineProposalsSubmittedResponse extends RefineProposalsResponseEnvelope {
  status: 'submitted';
  task_id: string;
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
