/**
 * DecisioningPlatform v1.0 — preview surface for the v6.0 architecture.
 *
 * Status: PREVIEW. Types only; not yet wired into the framework. Subject
 * to change before 6.0 ships. Don't build production adapters against this
 * yet — the framework still routes through the v5.x handler-style API.
 *
 * Design proposal: `.context/proposals/specialism-platform-interfaces-v3.md`
 *
 * @packageDocumentation
 */

// Adopter-facing structured-error primitive.
//
// `AdcpError` is the canonical throwable for structured rejection. Specialism
// methods return plain `T` for success or `throw new AdcpError(...)` to project
// to the wire `adcp_error` envelope.
//
// HITL is expressed in the type system via the dual-method shape on each
// spec-HITL tool (`xxx` for sync, `xxxTask` for HITL). No adopter-facing
// task primitives — the framework owns task lifecycle and dispatches the
// `*Task` method in the background.
export { type AdcpStructuredError, type ErrorCode, AdcpError } from './async-outcome';

// Cursor pagination
export type { CursorPage, CursorRequest } from './pagination';

// Status-change event bus — adopter-facing primitive for spec-native
// lifecycle channels (media_buy / creative / audience / signal / proposal /
// plan / rights_grant / delivery_report). Module-level so adopters can
// publish from webhook handlers, crons, in-process workers without holding
// a server reference.
export {
  publishStatusChange,
  setStatusChangeBus,
  getStatusChangeBus,
  createInMemoryStatusChangeBus,
  type StatusChange,
  type StatusChangeBus,
  type StatusChangeResourceType,
  type StatusChangeListener,
  type PublishStatusChangeOpts,
} from './status-changes';

// Capabilities (single source of truth for get_adcp_capabilities)
export type {
  DecisioningCapabilities,
  CreativeAgentRef,
  TargetingCapabilities,
  ReportingCapabilities,
} from './capabilities';

// Account model
export type {
  Account,
  AuthPrincipal,
  AccountStore,
  AccountFilter,
  SyncAccountsResultRow,
  AdcpAccountStatus,
} from './account';

export { AccountNotFoundError } from './account';

// Native status mapping
export type { StatusMappers, AdcpMediaBuyStatus, AdcpCreativeStatus, AdcpPlanStatus } from './status-mappers';
export { identityStatusMappers } from './status-mappers';

// Request context (state + resolve)
export type {
  RequestContext,
  WorkflowStateReader,
  ResourceResolver,
  WorkflowObjectType,
  WorkflowStep,
  Proposal,
  GovernanceContextJWS,
} from './context';

// Top-level platform + compile-time capability enforcement
export type { DecisioningPlatform, RequiredPlatformsFor } from './platform';

// Specialism interfaces (v1.0)
export type {
  CreativeTemplatePlatform,
  CreativeGenerativePlatform,
  CreativeReviewResult,
  RefinementMessage,
} from './specialisms/creative';

export type { SalesPlatform, MediaBuy, DeliveryActuals } from './specialisms/sales';

export type { AudiencePlatform, AudienceSyncResult, AudienceStatus } from './specialisms/audiences';

// Runtime (v6.0 alpha) — preview surface for adopters spiking against the
// new shape. Subject to change before 6.0 GA.
export {
  createAdcpServerFromPlatform,
  type CreateAdcpServerFromPlatformOptions,
  type DecisioningAdcpServer,
} from './runtime/from-platform';
export { PlatformConfigError, validatePlatform } from './runtime/validate-platform';
export { createInMemoryTaskRegistry, type TaskRegistry, type TaskRecord } from './runtime/task-registry';
