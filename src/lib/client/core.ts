// Focused buyer-side client runtime.
//
// Unlike `@adcp/sdk/client`, this entrypoint deliberately does not re-export
// the package root. Keep runtime exports limited to the modules required to
// construct and operate AdCP clients so cold consumers do not also evaluate
// server, compliance, testing, and unrelated protocol surfaces.

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
export type {
  ConversationConfig,
  ConversationContext,
  InputHandler,
  InputHandlerResponse,
  InputRequest,
  Message,
  TaskInfo,
  TaskOptions,
  TaskResult,
  TaskResultCompleted,
  TaskResultFailure,
  TaskResultIntermediate,
  TaskResultMetadata,
} from '../core/ConversationTypes';
export type { AgentConfig } from '../types/adcp';
