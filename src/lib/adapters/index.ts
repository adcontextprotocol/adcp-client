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

// Sponsored Intelligence Sessions
export {
  SISessionManager,
  AISISessionManager,
  type ISISessionManager,
  type SISession,
  SIErrorCodes,
  defaultSISessionManager,
} from './si-session-manager';
