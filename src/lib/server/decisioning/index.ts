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

// Universal async pattern
export {
  type AsyncOutcome,
  type AsyncOutcomeSync,
  type AsyncOutcomeSubmitted,
  type AsyncOutcomeRejected,
  type AdcpStructuredError,
  type ErrorCode,
  type TaskHandle,
  type TaskUpdate,
  type TaskUpdateProgress,
  type TaskUpdateCompleted,
  type TaskUpdateFailed,
  ok,
  submitted,
  rejected,
  unimplemented,
} from './async-outcome';

// Cursor pagination
export type { CursorPage, CursorRequest } from './pagination';

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
