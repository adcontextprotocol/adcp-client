// Focused buyer-side client runtime.
//
// Unlike `@adcp/sdk/client`, this entrypoint deliberately does not re-export
// the package root. Keep runtime exports limited to the modules required to
// construct and operate AdCP clients so cold consumers do not also evaluate
// server, compliance, testing, and unrelated protocol surfaces.
// `scripts/check-client-entry-graph.mjs` (run by the unit suite) fails if this
// entry point's module graph reaches `server/` or `testing/`.

export {
  SingleAgentClient,
  WebhookDispatchError,
  createSingleAgentClient,
  UnsupportedFeatureError,
  type CapabilityEvidenceScope,
  type CapabilityEvidenceSnapshot,
  type ClientProductPropertyPolicy,
  type CreativeDeliveryTaskOptions,
  type SingleAgentClientConfig,
  type SyncCreativesTaskOptions,
  type VerifyAndParseWebhookOptions,
  type WebhookHandlerAdapter,
  type WebhookHandlerRequest,
  type WebhookRequestContext,
  type WebhookParseErrorCode,
  type WebhookParseFailure,
  type WebhookParseResult,
  type WebhookParseSuccess,
  type WebhookVerificationConfig,
} from '../core/SingleAgentClient';
export {
  AgentClient,
  CapabilityPreflightError,
  type AdcpTaskName,
  type CanonicalGetProductsResponse,
  type CanonicalProjectionTaskOptions,
  type CapabilityPreflightContext,
  type CapabilityPreflightErrorCode,
  type CapabilityPreflightLoader,
  type InProcessAgentClientConfig,
  type ProposalRefinementTaskOptions,
  type TaskRequestFor,
  type TaskRequestTypeMap,
  type TaskResponseTypeMap,
} from '../core/AgentClient';
export {
  ADCPMultiAgentClient,
  createADCPMultiAgentClient,
  type MultiAgentWebhookHandlerAdapter,
} from '../core/ADCPMultiAgentClient';
export {
  CreativeAgentClient,
  createCreativeAgentClient,
  STANDARD_CREATIVE_AGENTS,
  type CreativeAgentClientConfig,
  type CreativeAgentListTaskOptions,
  type LegacyCreativeFormat,
} from '../core/CreativeAgentClient';
export { ConfigurationManager } from '../core/ConfigurationManager';
export {
  InMemoryWebhookRegistrationStore,
  type InMemoryWebhookRegistrationStoreOptions,
  type WebhookAuthenticationMode,
  type WebhookRegistration,
  type WebhookRegistrationStore,
} from '../core/webhook-registration';
export { createInMemoryAgentDiscoveryCache } from '../core/agent-discovery-cache';
export type {
  AgentDiscoveryCache,
  AgentDiscoveryCacheConfig,
  AgentDiscoveryEntry,
  InMemoryAgentDiscoveryCache,
  InMemoryAgentDiscoveryCacheOptions,
} from '../core/agent-discovery-cache';
// Task status vocabulary and the task-executor errors a caller can catch. These
// modules are already part of the client graph, so exporting them adds nothing
// to what this entry point loads.
export { ADCP_STATUS, type ADCPStatus } from '../core/ProtocolResponseParser';
export {
  InputRequiredError,
  DeferredSettlementOwnershipError,
  DirectContinuationRecoveryError,
  type DirectContinuationRecoveryFailure,
} from '../core/TaskExecutor';
export type {
  ConversationConfig,
  ConversationContext,
  InputHandler,
  InputHandlerResponse,
  InputRequest,
  Message,
  TaskInfo,
  TaskOptions,
  TrackTaskRequest,
  TrackedTask,
  SubmittedContinuation,
  TaskResult,
  TaskResultCompleted,
  TaskResultFailure,
  TaskResultIntermediate,
  TaskResultMetadata,
} from '../core/ConversationTypes';
export type { AgentConfig } from '../types/adcp';
export type { ResolveAccountOptions, ResolveAccountResult, ListedAccount } from '../core/account-resolution';
export type { CreativeFormatWireMode } from '../v2/projection/creative-delivery';
