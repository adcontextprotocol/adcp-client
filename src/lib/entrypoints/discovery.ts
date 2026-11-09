// `@adcp/sdk/discovery`: adagents.json validation, agent-property resolution,
// publisher property selectors, the property index, the network consistency
// checker, and the agent directory, without loading the package root.
//
// `PropertyCrawler` is not here: it drives `SingleAgentClient` and would pull the
// whole client graph into an entry point that is otherwise a few dozen modules.
// Import it from `@adcp/sdk`.
//
// Mirrors the root's other discovery exports name for name, including the alias
// `AdAgentsPublisherPropertySelector` (the root's bare `PublisherPropertySelector`
// is the registry's flat shape, exported from `@adcp/sdk/registry`). Add a name
// here only when the root exports it under the same name
// (`test/lib/runtime-subpaths.test.js` enforces this).

export {
  PropertyIndex,
  getPropertyIndex,
  resetPropertyIndex,
  type PropertyMatch,
  type AgentAuthorization,
} from '../discovery/property-index';
export {
  NetworkConsistencyChecker,
  type NetworkConsistencyCheckerConfig,
  type NetworkCheckReport,
  type CheckSummary,
  type CheckProgress,
  type OrphanedPointer,
  type StalePointer,
  type MissingPointer,
  type SchemaError,
  type AgentHealthResult,
  type DomainDetail,
  type DomainStatus,
} from '../discovery/network-consistency-checker';
export type {
  Property,
  PropertyIdentifier,
  PropertyIdentifierType,
  PropertyType,
  AdAgentsJson,
  AuthorizedAgent,
  AuthorizationType,
  // Aliased: the registry types also export a `PublisherPropertySelector`
  // (registry-flat shape with no `selection_type` discriminator). The
  // adagents.json schema's variant is a discriminated union, so we
  // expose it under a distinct name to avoid clobbering the registry
  // type that's been part of the public API longer.
  PublisherPropertySelector as AdAgentsPublisherPropertySelector,
  SinglePublisherPropertySelector,
  CompactPublisherPropertySelector,
} from '../discovery/types';
export {
  parsePublisherPropertySelector,
  expandPublisherPropertySelector,
  expandPublisherPropertySelectors,
  isCompactPublisherPropertySelector,
  publisherDomainsCoveredBySelectors,
  PublisherPropertySelectorParseError,
  type PublisherPropertySelectorError,
} from '../discovery/publisher-property-selector';
export {
  resolveAgentProperties,
  listAgentPropertyMap,
  getAllProperties,
  canonicalizeAgentUrl,
  type ResolvedAgentScope,
  type ResolveUnresolvableReason,
} from '../discovery/resolve-agent-properties';
export {
  resolveInlinePublisherProperties,
  resolveSingularInline,
  detectInlineFederatedDivergence,
  type InlineResolutionResult,
  type InlineFederatedDivergence,
} from '../discovery/inline-publisher-properties';
export {
  fetchAgentAuthorizationsFromDirectory,
  type AgentAuthorizationsIterator,
  type FetchAgentAuthorizationsOptions,
  type DirectoryLookupPage,
  type DirectoryPublisherEntry,
  type DirectoryDiscoveryMethod,
  type DirectoryPublisherStatus,
} from '../discovery/agent-directory';
export {
  validateAdAgents,
  parseManagerDomain,
  type DiscoveryMethod,
  type AdAgentsValidationResult,
  type ValidateAdAgentsOptions,
} from '../discovery/validate-adagents';
export type {
  AuthorizationCollectionSelector,
  ProductCollectionSelector,
  CollectionDistribution,
  DiscoveryCollection,
} from '../discovery/types';
