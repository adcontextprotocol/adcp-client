/**
 * Server-Side Adapters
 *
 * These adapters allow publishers/brands to plug in their business logic
 * when implementing AdCP servers. Each adapter provides a stub implementation
 * that can be extended or replaced.
 *
 * Usage:
 * - LegacyContentStandardsAdapter: Maintain raw content-standard integrations during migration
 * - PropertyListAdapter: Manage buyer-defined property lists
 * - SISessionManager: Handle Sponsored Intelligence conversational sessions
 * - InMemoryImplicitAccountStore: AccountStore for resolution: 'implicit' platforms
 */

// Content Standards
export {
  LegacyContentStandardsAdapter,
  type LegacyIContentStandardsAdapter,
  type LegacyContentEvaluationResult,
  LegacyContentStandardsErrorCodes,
  isLegacyContentStandardsError,
  legacyDefaultContentStandardsAdapter,
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

// Governance (seller-side committed checks)
export {
  GovernanceAdapter,
  defaultGovernanceAdapter,
  type IGovernanceAdapter,
  type GovernanceAdapterConfig,
  type GovernanceAdapterErrorCode,
  type CommittedCheckRequest,
  type LegacyCommittedCheckRequest,
  type ModernCommittedCheckRequest,
  GovernanceAdapterError,
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

// Derived AccountStore — Shape D factory for `resolution: 'derived'` agents
// fronting an upstream-managed account namespace (the upstream owns the
// roster; buyers discover ids via `list_accounts` and send `{ account_id }`).
// Verifies buyer-supplied ids against what the caller's credential can reach
// and wires `list_accounts` for both the credential-bound singleton
// (`toAccount`) and roster (`listAccounts`) shapes. Closes adcp-client#1462;
// reworked by adcp-client#1647.
export {
  createDerivedAccountStore,
  type DerivedAccountStoreOptions,
  type DerivedAccountStoreBaseOptions,
  type DerivedSingletonAccountStoreOptions,
  type DerivedRosterAccountStoreOptions,
} from './derived-account-store';
