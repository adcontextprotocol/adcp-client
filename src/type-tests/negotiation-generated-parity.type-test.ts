import type {
  CanonicalDeliveryForecast as RootCanonicalDeliveryForecast,
  CanonicalForecastPoint as RootCanonicalForecastPoint,
  CanonicalProposal,
  ProposalPurchase,
} from '../lib';
import type {
  CanonicalDeliveryForecast as TypesCanonicalDeliveryForecast,
  CanonicalForecastPoint as TypesCanonicalForecastPoint,
} from '../lib/types';
import type {
  CanonicalProposal as GeneratedCanonicalProposal,
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

// The forecast supporting type is reachable from both documented barrels.
type _RootForecastExport = Assert<Equal<RootCanonicalDeliveryForecast, TypesCanonicalDeliveryForecast>>;
type _RootForecastPointExport = Assert<Equal<RootCanonicalForecastPoint, TypesCanonicalForecastPoint>>;

const purchaseWithSchemaFields: ProposalPurchase = {
  product_id: 'product-1',
  pricing_option_id: 'pricing-1',
  budget: 10_000,
  pacing: 'even',
};

declare const proposal: CanonicalProposal;
const forecast: RootCanonicalDeliveryForecast | undefined = proposal.forecast;
const budgetGuidance: { currency: string } | undefined = proposal.total_budget_guidance;

void purchaseWithSchemaFields;
void forecast;
void budgetGuidance;
