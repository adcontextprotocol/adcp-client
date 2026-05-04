/**
 * ProposalManager — primitives for the two-platform composition.
 *
 * Splits proposal assembly (`get_products`, refine, finalize) from media-buy
 * execution (`create_media_buy`, lifecycle), mirroring `adcp-client-python`'s
 * v1.5 ProposalManager. Either side can be mock-backed independently.
 *
 * **Status**: primitives only (v1 + v1.5 types and storage). Framework
 * dispatch wiring (the five seams that intercept `getProducts`,
 * `createMediaBuy`, `updateMediaBuy`, `getMediaBuyDelivery`) lands in a
 * follow-up PR alongside the lifecycle helpers.
 *
 * @public
 * @packageDocumentation
 */

export type {
  ProposalManager,
  ProposalCapabilities,
  ProposalSalesSpecialism,
  Recipe,
  CapabilityOverlap,
  FinalizeProposalRequest,
  FinalizeProposalSuccess,
} from './types';

export { validateProposalCapabilities } from './types';

export type { ProposalState, ProposalRecord, ProposalStore, InMemoryProposalStoreOptions } from './store';

export { InMemoryProposalStore } from './store';

export { MockProposalManager } from './mock-manager';
export type { MockProposalManagerOptions } from './mock-manager';

export {
  enforceProposalExpiry,
  validateCapabilityOverlap,
  validateOverlapSubsetOfWire,
  detectFinalizeAction,
  setProposalLifecycleLogger,
  logDraftPersisted,
  logFinalizeSucceeded,
  logExpired,
  logConsumed,
} from './lifecycle';
export type { FinalizeActionRef, ProposalLifecycleLogger } from './lifecycle';

export {
  maybeInterceptFinalize,
  maybePersistDraftAfterGetProducts,
  maybeReserveProposalForCreateMediaBuy,
  finalizeProposalConsumption,
  releaseProposalReservation,
  maybeHydrateRecipesForMediaBuyId,
} from './dispatch';
export type { FinalizeInterceptResult, ReservedProposal } from './dispatch';
