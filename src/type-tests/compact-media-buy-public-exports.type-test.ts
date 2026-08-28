import type {
  AcceptProposalRequest,
  AcceptProposalResponse,
  BuyProductsRequest,
  BuyProductsResponse,
  ControlMediaBuyRequest,
  ControlMediaBuyResponse,
  DeclineProposalsRequest,
  DeclineProposalsResponse,
  ListProductsRequest,
  ListProductsResponse,
  RefineProposalsRequest,
  RefineProposalsResponse,
  RequestProposalsRequest,
  RequestProposalsResponse,
} from '../lib/types';
import type {
  RefineProposalsRequest as RootRefineProposalsRequest,
  RefineProposalsResponse as RootRefineProposalsResponse,
} from '../lib';

type Assert<T extends true> = T;
type AssertFalse<T extends false> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// Every compact lifecycle tool is available from the documented
// `@adcp/sdk/types` barrel; adopters do not need generated deep imports.
type _ListProductsRequest = ListProductsRequest;
type _ListProductsResponse = ListProductsResponse;
type _RequestProposalsRequest = RequestProposalsRequest;
type _RequestProposalsResponse = RequestProposalsResponse;
type _RefineProposalsRequest = RefineProposalsRequest;
type _RefineProposalsResponse = RefineProposalsResponse;
type _DeclineProposalsRequest = DeclineProposalsRequest;
type _DeclineProposalsResponse = DeclineProposalsResponse;
type _BuyProductsRequest = BuyProductsRequest;
type _BuyProductsResponse = BuyProductsResponse;
type _AcceptProposalRequest = AcceptProposalRequest;
type _AcceptProposalResponse = AcceptProposalResponse;
type _ControlMediaBuyRequest = ControlMediaBuyRequest;
type _ControlMediaBuyResponse = ControlMediaBuyResponse;

// The public refine response must be the schema-faithful tool projection, not
// the weaker aggregate core projection. Completed branches require products,
// and every result preserves its source proposal identity.
type CompletedRefinement = Extract<RefineProposalsResponse, { results: unknown }>;
type RefinementResult = CompletedRefinement['results'][number];
type _CompletedProductsRequired = AssertFalse<undefined extends CompletedRefinement['products'] ? true : false>;
type _SourceProposalIdPreserved = Assert<Equal<RefinementResult['source_proposal_id'], string>>;

// The root barrel intentionally retains the hand-written negotiation request
// and response rather than becoming ambiguous with the wire-level types above.
type _RootRequestKeepsBrandedVersion = Assert<
  Equal<RootRefineProposalsRequest['adcp_version'], '3.2' | `3.2-${string}`>
>;
type _RootResponseKeepsGenericProposal = Assert<
  RootRefineProposalsResponse extends import('../lib/negotiation').RefineProposalsResponse ? true : false
>;
