import type { BuyProductsRequest } from '../lib/types';
import type { TargetingOverlay as ToolTargetingOverlay } from '../lib/types/tools.generated';
import type {
  AcceptanceContext as RootAcceptanceContext,
  CanonicalDeliveryForecast as RootCanonicalDeliveryForecast,
  CanonicalForecastPoint as RootCanonicalForecastPoint,
  CanonicalProposal,
  MediaBuyFrequencyCap as RootMediaBuyFrequencyCap,
  OutcomeTarget as RootOutcomeTarget,
  ProposalDiscoveryCriteria,
  ProposalPurchase,
  ProductMediaBuySupportRequirements as RootProductMediaBuySupportRequirements,
  ReviseProposalRefinement,
} from '../lib';
import type {
  AcceptanceContext as TypesAcceptanceContext,
  CanonicalDeliveryForecast as TypesCanonicalDeliveryForecast,
  CanonicalForecastPoint as TypesCanonicalForecastPoint,
  MediaBuyFrequencyCap as TypesMediaBuyFrequencyCap,
  OutcomeTarget as TypesOutcomeTarget,
  ProductMediaBuySupportRequirements as TypesProductMediaBuySupportRequirements,
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
type _RootFrequencyCapExport = Assert<Equal<RootMediaBuyFrequencyCap, TypesMediaBuyFrequencyCap>>;
type _RootMediaBuySupportExport = Assert<
  Equal<RootProductMediaBuySupportRequirements, TypesProductMediaBuySupportRequirements>
>;
type _RootOutcomeTargetExport = Assert<Equal<RootOutcomeTarget, TypesOutcomeTarget>>;
type _RootAcceptanceContextExport = Assert<Equal<RootAcceptanceContext, TypesAcceptanceContext>>;

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

// Request targeting and effective snapshots are distinct on newer pins. Removing only top-level clear commands must recover the same
// known dimension shapes; nested input values must not be weakened.
type RequestTargeting = NonNullable<BuyProductsRequest['purchases'][number]['targeting_overlay']>;
type SnapshotTargeting = NonNullable<ProposalPurchase['targeting_overlay']>;
type KnownDimensions<T> = {
  [K in keyof T as string extends K ? never : number extends K ? never : K]: Exclude<T[K], null>;
};
type _ResolvedInputFitsSnapshot = AssertAssignable<SnapshotTargeting, KnownDimensions<RequestTargeting>>;
type _SnapshotFitsInput = AssertAssignable<RequestTargeting, SnapshotTargeting>;
type _SameResolvedDimensions = Assert<Equal<KnownDimensions<RequestTargeting>, KnownDimensions<SnapshotTargeting>>>;

type _ToolAndCoreTargetingAgree = Assert<
  Equal<KnownDimensions<ToolTargetingOverlay>, KnownDimensions<SnapshotTargeting>>
>;

type DimensionKeys = keyof KnownDimensions<SnapshotTargeting>;
type _SnapshotHasNoClearCommands = Assert<
  Equal<
    {
      [K in DimensionKeys]-?: null extends SnapshotTargeting[K] ? K : never;
    }[DimensionKeys],
    never
  >
>;
type _InputClearCommandsAreUniform = Assert<
  Equal<
    {
      [K in DimensionKeys]-?: null extends RequestTargeting[K] ? true : false;
    }[DimensionKeys],
    null extends RequestTargeting['geo_countries'] ? true : false
  >
>;

const omittedTargeting: SnapshotTargeting = {};
const nonemptyTargeting: SnapshotTargeting = { geo_countries: ['US', 'GB'] };
// @ts-expect-error A clear command is not effective targeting.
const clearSnapshot: SnapshotTargeting = { geo_countries: null };
// @ts-expect-error The schema requires at least one country.
const emptyCountries: SnapshotTargeting = { geo_countries: [] };
// @ts-expect-error Country elements must be strings.
const invalidCountry: RequestTargeting = { geo_countries: [42] };

void omittedTargeting;
void nonemptyTargeting;
void clearSnapshot;
void emptyCountries;
void invalidCountry;
