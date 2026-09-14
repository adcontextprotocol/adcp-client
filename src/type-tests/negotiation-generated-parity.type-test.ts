import type {
  CanonicalDeliveryForecast as RootCanonicalDeliveryForecast,
  CanonicalForecastPoint as RootCanonicalForecastPoint,
  CanonicalProposal,
  ProposalDiscoveryCriteria,
  ProposalPurchase,
  ReviseProposalRefinement,
} from '../lib';
import type {
  CanonicalDeliveryForecast as TypesCanonicalDeliveryForecast,
  CanonicalForecastPoint as TypesCanonicalForecastPoint,
} from '../lib/types';
import type {
  CanonicalProposal as GeneratedCanonicalProposal,
  ProductDiscoveryCriteria as GeneratedProductDiscoveryCriteria,
  ProposalRefinement as GeneratedProposalRefinement,
  ProductPurchase as GeneratedProductPurchase,
} from '../lib/types/core.generated';

type Assert<T extends true> = T;
type AssertAssignable<Expected, Actual extends Expected> = true;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// The generated wire types must remain accepted by the backwards-compatible
// handwritten negotiation surface.
type _GeneratedProposalIsAssignable = AssertAssignable<CanonicalProposal, GeneratedCanonicalProposal>;
type _GeneratedPurchaseIsAssignable = AssertAssignable<ProposalPurchase, GeneratedProductPurchase>;

// Structural assignability ignores additional optional source properties, so
// explicitly fail typecheck when either generated peer gains an unmodeled key.
type _ProposalKeysStayComplete = Assert<
  Equal<Exclude<keyof GeneratedCanonicalProposal, keyof CanonicalProposal>, never>
>;
type _PurchaseKeysStayComplete = Assert<Equal<Exclude<keyof GeneratedProductPurchase, keyof ProposalPurchase>, never>>;

// Handwritten negotiation inputs retain their backwards-compatible optional
// fields while using the exact generated schema types for new 3.2 criteria.
type _FrequencyCapCriteriaParity = Assert<
  Equal<
    ProposalDiscoveryCriteria['media_buy_frequency_cap'],
    GeneratedProductDiscoveryCriteria['media_buy_frequency_cap']
  >
>;
type _MediaBuySupportCriteriaParity = Assert<
  Equal<
    ProposalDiscoveryCriteria['required_media_buy_support'],
    GeneratedProductDiscoveryCriteria['required_media_buy_support']
  >
>;
type _OutcomeTargetCriteriaParity = Assert<
  Equal<ProposalDiscoveryCriteria['outcome_target'], GeneratedProductDiscoveryCriteria['outcome_target']>
>;
type _AcceptanceContextCriteriaParity = Assert<
  Equal<ProposalDiscoveryCriteria['acceptance_context'], GeneratedProductDiscoveryCriteria['acceptance_context']>
>;
type DistributedProperty<T, K extends PropertyKey> = T extends unknown ? (K extends keyof T ? T[K] : never) : never;
type _RemoveFrequencyCapParity = Assert<
  Equal<
    ReviseProposalRefinement['remove_media_buy_frequency_cap'],
    DistributedProperty<GeneratedProposalRefinement, 'remove_media_buy_frequency_cap'>
  >
>;

// The forecast supporting type is reachable from both documented barrels.
type _RootForecastExport = Assert<Equal<RootCanonicalDeliveryForecast, TypesCanonicalDeliveryForecast>>;
type _RootForecastPointExport = Assert<Equal<RootCanonicalForecastPoint, TypesCanonicalForecastPoint>>;

const purchaseWithSchemaFields: ProposalPurchase = {
  product_id: 'product-1',
  pricing_option_id: 'pricing-1',
  budget: 10_000,
  pacing: 'even',
};

const legacyRevisionRemainsValid: ReviseProposalRefinement = {
  proposal_id: 'proposal-legacy',
  action: 'revise',
  ask: 'Keep the existing request shape valid',
};
const removeOnlyRevision: ReviseProposalRefinement = {
  proposal_id: 'proposal-remove-cap',
  action: 'revise',
  remove_media_buy_frequency_cap: true,
};
const invalidRemoveRevision: ReviseProposalRefinement = {
  proposal_id: 'proposal-keep-cap',
  action: 'revise',
  // @ts-expect-error The official schema permits only the literal true removal command.
  remove_media_buy_frequency_cap: false,
};

declare const proposal: CanonicalProposal;
const forecast: RootCanonicalDeliveryForecast | undefined = proposal.forecast;
const budgetGuidance: { currency: string } | undefined = proposal.total_budget_guidance;

void purchaseWithSchemaFields;
void legacyRevisionRemainsValid;
void removeOnlyRevision;
void invalidRemoveRevision;
void forecast;
void budgetGuidance;
