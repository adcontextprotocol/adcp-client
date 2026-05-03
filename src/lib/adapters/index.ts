/**
 * Server-Side Adapters
 *
 * These adapters allow publishers/brands to plug in their business logic
 * when implementing AdCP servers. Each adapter provides a stub implementation
 * that can be extended or replaced.
 *
 * Usage:
 * - ContentStandardsAdapter: Implement brand safety/suitability evaluation
 * - PropertyListAdapter: Manage buyer-defined property lists
 * - ProposalManager: Generate and refine media plan proposals
 * - SISessionManager: Handle Sponsored Intelligence conversational sessions
 * - InMemoryImplicitAccountStore: AccountStore for resolution: 'implicit' platforms
 */

// Content Standards
export {
  ContentStandardsAdapter,
  type IContentStandardsAdapter,
  type ContentEvaluationResult,
  ContentStandardsErrorCodes,
  isContentStandardsError,
  defaultContentStandardsAdapter,
} from './content-standards-adapter';

// Property Lists
export {
  PropertyListAdapter,
  type IPropertyListAdapter,
  type ResolvedProperty,
  PropertyListErrorCodes,
  isPropertyListError,
  defaultPropertyListAdapter,
} from './property-list-adapter';

// Proposal Management
export {
  ProposalManager,
  AIProposalManager,
  type IProposalManager,
  type ProposalContext,
  ProposalErrorCodes,
  defaultProposalManager,
} from './proposal-manager';

// Governance (seller-side committed checks)
export {
  GovernanceAdapter,
  defaultGovernanceAdapter,
  type IGovernanceAdapter,
  type GovernanceAdapterConfig,
  type GovernanceAdapterErrorCode,
  type CommittedCheckRequest,
  GovernanceAdapterErrorCodes,
  isGovernanceAdapterError,
} from './governance-adapter';

// Sponsored Intelligence Sessions
export {
  SISessionManager,
  AISISessionManager,
  type ISISessionManager,
  type SISession,
  SIErrorCodes,
  defaultSISessionManager,
} from './si-session-manager';

// Implicit Account Store (resolution: 'implicit') — Shape A reference adapter.
export {
  InMemoryImplicitAccountStore,
  defaultImplicitKeyFn,
  type ImplicitAccountStoreOptions,
} from './implicit-account-store';

// OAuth pass-through resolver — closes adcp-client#1363. Shape B factory
// for adapters wrapping a vendor OAuth + ad-account API; replaces the ~30
// LOC of bearer-extract + listing-fetch + match-by-id boilerplate every
// such adapter re-derives by hand.
export { createOAuthPassthroughResolver, type OAuthPassthroughResolverOptions } from './oauth-passthrough-resolver';

// Roster-backed AccountStore — Shape C factory for `resolution: 'explicit'`
// publisher-curated platforms. Adopters bring their own roster source (admin-UI
// managed DB row, in-memory map, file); the helper provides AccountStore
// plumbing (resolve dispatch, optional list, ctx threading) with no opinion on
// where the roster lives.
export { createRosterAccountStore, type RosterAccountStoreOptions } from './roster-account-store';
