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

// Typed `AdcpError` subclasses — adopter convenience for the highest-traffic
// error codes. Each class encodes the canonical code/recovery/field shape.
// LLM-generated platforms get autocomplete on the import; humans skim the
// list to find the right class. See `errors-typed.ts`.
export {
  PackageNotFoundError,
  MediaBuyNotFoundError,
  ProductNotFoundError,
  CreativeNotFoundError,
  ProductUnavailableError,
  CreativeRejectedError,
  BudgetTooLowError,
  BudgetExhaustedError,
  IdempotencyConflictError,
  InvalidRequestError,
  InvalidStateError,
  BackwardsTimeRangeError,
  AuthRequiredError,
  PermissionDeniedError,
  RateLimitedError,
  ServiceUnavailableError,
  UnsupportedFeatureError,
  ComplianceUnsatisfiedError,
  GovernanceDeniedError,
  PolicyViolationError,
} from './errors-typed';

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
  ResolveContext,
  ResolvedAuthInfo,
} from './account';

export { AccountNotFoundError, refAccountId } from './account';

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
export type { DecisioningPlatform, RequiredPlatformsFor, RequiredCapabilitiesFor } from './platform';

// Specialism interfaces (v1.0)
export type {
  CreativeBuilderPlatform,
  BuildCreativeReturn,
  // Deprecated aliases — kept for one-release source compat. Both
  // resolve to CreativeBuilderPlatform; see specialisms/creative.ts.
  CreativeTemplatePlatform,
  CreativeGenerativePlatform,
  RefinementMessage,
  SyncCreativesRow,
} from './specialisms/creative';

export type { CreativeAdServerPlatform } from './specialisms/creative-ad-server';

export type { CampaignGovernancePlatform } from './specialisms/campaign-governance';

export type { ContentStandardsPlatform } from './specialisms/content-standards';

export type { PropertyListsPlatform, CollectionListsPlatform } from './specialisms/lists';

export type { SalesPlatform } from './specialisms/sales';

export type { AudiencePlatform, Audience, SyncAudiencesRow, AudienceStatus } from './specialisms/audiences';

export type { SignalsPlatform } from './specialisms/signals';

export type { BrandRightsPlatform } from './specialisms/brand-rights';

// Brand-rights wire types — re-exported from `@adcp/sdk/server/decisioning`
// because brand-rights is the only specialism whose wire types live in
// `core.generated` (not `tools.generated`), and the public `@adcp/sdk/types`
// barrel doesn't surface them. Adopters typing their own helper functions
// import these from here, NOT from the deep `core.generated` path.
export type {
  GetBrandIdentityRequest,
  GetBrandIdentitySuccess,
  GetRightsRequest,
  GetRightsSuccess,
  AcquireRightsRequest,
  AcquireRightsAcquired,
  AcquireRightsPendingApproval,
  AcquireRightsRejected,
  AcquireRightsError,
  RightUse,
  RightType,
  RightsConstraint,
  RightsTerms,
  RightsPricingOption,
  GenerationCredential,
} from '../../types/core.generated';

// Runtime (v6.0 alpha) — preview surface for adopters spiking against the
// new shape. Subject to change before 6.0 GA.
export {
  createAdcpServerFromPlatform,
  type CreateAdcpServerFromPlatformOptions,
  type DecisioningAdcpServer,
  type DecisioningObservabilityHooks,
} from './runtime/from-platform';
export { PlatformConfigError, validatePlatform } from './runtime/validate-platform';
export {
  createInMemoryTaskRegistry,
  type TaskRegistry,
  type TaskRecord,
  type TaskStatus,
} from './runtime/task-registry';
export {
  createPostgresTaskRegistry,
  getDecisioningTaskRegistryMigration,
  type CreatePostgresTaskRegistryOptions,
  type PgQueryable,
} from './runtime/postgres-task-registry';

// Multi-tenant deployment helper — wraps createAdcpServerFromPlatform with
// per-tenant config, health states (healthy/unverified/disabled), and JWKS
// validation. Composes with the existing serve() host-routing surface.
export {
  createTenantRegistry,
  createDefaultJwksValidator,
  type TenantRegistry,
  type TenantConfig,
  type TenantSigningKey,
  type TenantStatus,
  type TenantHealth,
  type TenantRegistryOptions,
  type JwksValidator,
  type JwksValidationResult,
} from './tenant-registry';

// Manifest helpers — typed accessors for creative_manifest.assets values.
// Save adopters from writing the same null-check + discriminator-check
// boilerplate per call.
export { getAsset, requireAsset } from './manifest-helpers';

// List helpers — wrap row arrays + pagination into the heavier wire shapes
// (today: list_creatives, which carries query_summary alongside the rows).
export { buildListCreativesResponse, type BuildListCreativesResponseOpts } from './list-helpers';

// Start-time helper — normalize the wire `start_time` union into a Date,
// with platform-aware ASAP lead-time injection.
export { resolveStartTime, type ResolveStartTimeOptions } from './start-time';

// Admin Express router for ops visibility into the TenantRegistry.
// Mount on a separate port/path with operator auth.
export {
  createTenantAdminRouter,
  createTenantAdminHandlers,
  mountTenantAdmin,
  type TenantAdminHandlers,
  type RouterLike,
} from './admin-router';

// Adopter helpers — batchPoll, validationError, upstreamError, RequestShape.
// All opt-in convenience; nothing in the framework calls these internally.
export { batchPoll, validationError, upstreamError } from './helpers';
export type { RequestShape } from './helpers';
