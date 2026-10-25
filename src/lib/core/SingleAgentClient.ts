import { withMCPConnectionPolicy } from '../protocols/mcp-connection-policy';
import { hasUnsignedCapabilityBootstrap } from '../signing/protocol-methods';
import { normalizeGetProductsResponse } from '../utils/pricing-adapter';
import { normalizeMediaBuyResponse } from '../utils/creative-adapter';
import { normalizeFormatsResponse } from '../utils/format-renders';
import {
  isIdentity33SchemaScope,
  withIdentity33SchemaScope,
  bindIdentity33SchemaScope,
} from '../validation/schema-loader';
function loadWebBotAuth(): typeof import('../signing/web-bot-auth') {
  return require('../signing/web-bot-auth') as typeof import('../signing/web-bot-auth');
}
import { canonicalAgentOrigin } from '../signing/agent-resolver/canonicalize';
import {
  annotateProductsSupplyPaths,
  type ListProductsResponseWithSupplyPath,
  type ProductSupplyPathOptions,
} from '../supply-path/products';
// Main ADCP Client - Type-safe conversation-aware client for AdCP agents

import { createHash, randomUUID, scryptSync } from 'node:crypto';
const SKIP_PRODUCT_CACHE = Symbol('adcp.skipProductCache');
const SKIP_ACCOUNT_REGISTRY_OBSERVATION = Symbol('adcp.skipAccountRegistryObservation');
import type { AccountReference, AgentConfig } from '../types';
import { accountKeySites, naturalAccountKey, reducedFields, valueAt, withReducedKeyAt } from './account-reduction';
import { ADCP_ENVELOPE_FIELDS } from '../types/adcp';
import { parseAdcpMajorVersion, toReleasePrecisionVersion, type AdcpVersion } from '../version';
import {
  isAdcpVersionSupported,
  isAdcpVersionAtLeast,
  isPre31AdcpVersion,
  isPre32AdcpVersion,
  resolveAdcpVersion,
} from '../utils/adcp-version-config';
import { beta6ReportingRequestIssue, type Beta6DeliveryRequestIssue } from '../media-buy/reporting-version';
import {
  convertRequest,
  convertResponse,
  getVersionAdapter,
  isNegotiationFailure,
  negotiateAdcpRelease,
  parseAdcpRelease,
  releaseDefinesTool,
  resolveAdapterKey,
  type AccountIdentityDowngrade,
  type NegotiatedAdcpRelease,
} from '../adapters/version';
import {
  isExternalSchemaRootActive,
  schemaAllowsTopLevelField,
  toReleasePrecisionWire,
} from '../validation/schema-loader';
import type {
  GetProductsRequest,
  GetProductsResponse,
  ListProductsRequest,
  ListCollectionsRequest,
  ListCollectionsResponse,
  ListProposalsRequest,
  ListProposalsResponse,
  PropertyListReference,
  ListCreativeFormatsRequest,
  ListCreativeFormatsResponse,
  ListTransformersRequest,
  ListTransformersResponse,
  CreateMediaBuyRequest,
  CreateMediaBuyResponse,
  UpdateMediaBuyRequest,
  UpdateMediaBuyResponse,
  SyncCreativesRequest,
  SyncCreativesResponse,
  ListCreativesRequest,
  ListCreativesResponse,
  GetMediaBuysRequest,
  GetMediaBuysResponse,
  GetMediaBuyDeliveryRequest,
  GetMediaBuyDeliveryResponse,
  GetCreativeDeliveryRequest,
  GetCreativeDeliveryResponse,
  ProvidePerformanceFeedbackRequest,
  ProvidePerformanceFeedbackResponse,
  GetSignalsRequest,
  GetSignalsResponse,
  ActivateSignalRequest,
  ActivateSignalResponse,
  PreviewCreativeRequest,
  PreviewCreativeResponse,
  BuildCreativeRequest,
  BuildCreativeResponse,
  Format,
  GetAdCPCapabilitiesRequest,
  GetAdCPCapabilitiesResponse,
  ListAccountChangesRequest,
  ListAccountChangesResponse,
  ListAccountsRequest,
  ListAccountsResponse,
  SyncAccountsRequest,
  SyncAccountsResponse,
  SyncAudiencesRequest,
  SyncAudiencesResponse,
  CreatePropertyListRequest,
  CreatePropertyListResponse,
  GetPropertyListRequest,
  GetPropertyListResponse,
  UpdatePropertyListRequest,
  UpdatePropertyListResponse,
  ListPropertyListsRequest,
  ListPropertyListsResponse,
  DeletePropertyListRequest,
  DeletePropertyListResponse,
  ListContentStandardsRequest,
  ListContentStandardsResponse,
  GetContentStandardsRequest,
  GetContentStandardsResponse,
  CalibrateContentRequest,
  CalibrateContentResponse,
  ValidateContentDeliveryRequest,
  ValidateContentDeliveryResponse,
  SIGetOfferingRequest,
  SIGetOfferingResponse,
  SIInitiateSessionRequest,
  SIInitiateSessionResponse,
  SISendMessageRequest,
  SISendMessageResponse,
  SITerminateSessionRequest,
  SITerminateSessionResponse,
  SyncPlansRequest,
  SyncPlansResponse,
  GetPlanAuditLogsRequest,
  GetPlanAuditLogsResponse,
  GetPrincipalRequest,
  GetPrincipalResponse,
  SyncPrincipalRequest,
  SyncPrincipalResponse,
  OutcomeType,
} from '../types/tools.generated';
import { type MutatingRequestInput, generateIdempotencyKey, requestUsesIdempotency } from '../utils/idempotency';

import type { MCPWebhookPayload, AdCPAsyncResponseData, TaskStatus } from '../types/core.generated';
import type { Client as A2AClient } from '@a2a-js/sdk/client';
import { createA2AClientFromCardUrl } from '../protocols/a2a';
type A2ATask = Record<string, any>;
type TaskStatusUpdateEvent = Record<string, any>;

import {
  TaskExecutor,
  DEFERRED_SETTLEMENT_ACK,
  acknowledgeDeferredSettlement,
  rejectDeferredSettlement,
  hasCompletionHandlerAlreadyPublished,
  markCompletionHandlerAlreadyPublished,
  AfterProtocolDispatchHookError,
  BeforeProtocolDispatchHookError,
  type BeforeProtocolDispatchHook,
  type ExternalTaskSettlementObservation,
  type ExternalTaskStatusResult,
} from './TaskExecutor';
import { attachMatch } from './match';
import {
  assertNativeRequestProposalsResult,
  assertNativeRequestProposalsTask,
  guardNativeRequestProposalsCompletion,
} from './request-proposals-guard';
import { childTaskOptions, getTaskOperationId, withTaskDeadline } from './task-deadline';
import { createMCPRequestHeaders } from '../auth';
import { isAbortOrTimeoutError } from '../protocols/abort';
import { getSignedRequestRejection } from '../protocols/signedRequestRejection';
import { withAmbientIdentityHeaders } from '../protocols/mcp-call-context';
import { ProtocolClient, normalizeTransportOptions } from '../protocols';
import {
  AuthenticationCredentialsRejectedError,
  AuthenticationRequiredError,
  ConfigurationError,
  FeatureUnsupportedError,
  ProtocolFeatureUnsupportedError,
  TaskTimeoutError,
  VersionUnsupportedError,
  is401Error,
} from '../errors';
import { createAgentTransportFetch, isLikelyPrivateUrl } from '../net';
import {
  discoverAuthorizationRequirements,
  hasValidatedMcpAuthorizationRequirements,
  NeedsAuthorizationError,
  probeAuthChallenge,
} from '../auth/oauth/authorization-required';
import { discoverOAuthMetadata } from '../auth/oauth/discovery';
import type {
  InputHandler,
  Message,
  TaskOptions,
  TaskResult,
  ConversationConfig,
  TaskInfo,
  TaskState,
  WebhookUrlTemplate,
  DirectPauseRecoveryRequest,
  TrackTaskRequest,
  TrackedTask,
} from './ConversationTypes';
import type { AdcpTaskName, TaskRequestFor, TaskResponseTypeMap } from './AgentClient';
import type { DeferredTaskStorage } from '../storage/interfaces';
import type { Activity, AsyncHandlerConfig, WebhookMetadata } from './AsyncHandler';
import {
  AsyncHandler,
  WebhookDedupClaimRetentionError,
  WebhookDedupConflictError,
  WebhookDedupInputError,
} from './AsyncHandler';
import { verifyWebhookRequest, type WebhookHeaderValue, type WebhookHeadersLike } from '../webhooks';
import {
  canonicalDelegatedOperatorAuthorization,
  InMemoryWebhookRegistrationStore,
  parseWebhookRegistration,
  deliveryWebhookRegistrationId,
  sameWebhookRegistration,
  WebhookRegistrationIntegrityError,
  type WebhookRegistration,
  type WebhookRegistrationStore,
  validateWebhookRegistrationAuthorization,
} from './webhook-registration';
import {
  InMemoryReplayStore,
  type ReplayStore,
  InMemoryRevocationStore,
  type RevocationStore,
  type JwksResolver,
  type DelegatedOperatorAuthorizationContext,
  WebhookSignatureError,
  type WebhookSignatureErrorCode,
  verifyWebhookSignature as verifyRfc9421WebhookSignature,
  ResolvedAgentJwksResolver,
  type ResolvedAgentJwksResolverOptions,
  canonicalTargetUri,
} from '../signing/server';
import { AgentResolverError } from '../signing/agent-resolver/errors';
import { RequestSigningErrorCodeMetadata } from '../types/enums.generated';
import { unwrapProtocolResponse } from '../utils/response-unwrapper';
import { getLatestA2ADataPartFromTask } from '../utils/a2a-artifacts';
import { extractAdcpTaskStatusFromPayload, isAdcpStatus } from './task-status';
import { responseParser } from './ProtocolResponseParser';
import {
  isWellKnownAgentCardUrl as isWellKnownCardUrl,
  buildCardUrls,
  stripAgentCardPath,
  stripTransportSuffix,
} from '../utils/a2a-discovery';
import * as crypto from 'crypto';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  createTimeoutError,
  resolveClientRequestTimeoutMs,
  resolveRequestTimeoutMs,
  throwIfAborted,
  withAbortSignal,
} from '../protocols/abort';

function presentedStaticTransportCredential(
  authToken: string | undefined,
  headers: Record<string, string> | undefined,
  authProvider?: object
): boolean {
  if (authProvider) return false;
  if (authToken) return true;
  return Object.keys(headers ?? {}).some(key => {
    const normalized = key.toLowerCase();
    return normalized === 'authorization' || normalized === 'x-adcp-auth';
  });
}

// v3.0 compatibility utilities
import type { AdcpCapabilities, ToolInfo, FeatureName } from '../utils/capabilities';
import {
  agentDiscoveryCacheKey,
  MAX_AGENT_DISCOVERY_TTL_MS,
  resolveAgentDiscoveryTtlMs,
  validateAgentDiscoveryCacheConfig,
  type AgentDiscoveryCacheConfig,
  type AgentDiscoveryEntry,
} from './agent-discovery-cache';
import {
  buildSyntheticV3Capabilities,
  augmentCapabilitiesFromTools,
  looksLikeV3Capabilities,
  parseCapabilitiesResponse,
  resolveFeature,
  listDeclaredFeatures,
  TASK_FEATURE_MAP,
  assertValidIdempotencyReplayTtlSeconds,
  supportsBuyingMode,
} from '../utils/capabilities';
import {
  AccountPendingApprovalError,
  AccountRequiredError,
  AccountNotProvisionedError,
  AccountNotFoundError,
  AccountSetupRequiredError,
  AccountPaymentRequiredError,
  UnsupportedBuyingModeError,
} from '../errors';
import { BuyerAccountRegistry, type AccountPolicy, type BuyerAccountStorage } from './buyer-account-registry';
import type { ProductCache } from './product-cache';
import {
  sameCountrySet,
  selectListedAccount,
  type ResolveAccountOptions,
  type ResolveAccountResult,
} from './account-resolution';

import { normalizeRequestParams } from '../utils/request-normalizer';
import { globalAsyncLocalStorage } from '../utils/global-async-local-storage';
import { validateUserAgent } from '../utils/validate-user-agent';
import { resolveWebhookUrl, selectWebhookTemplate } from './webhook-url';
import {
  ProductPropertyPolicyError,
  validateProductsAgainstPropertyPolicy,
  isSupportedPropertyIdentifierType,
  normalizeDomainForPropertyPolicy,
  type BuyerPropertyPolicy,
  type ProductPolicyResolvedProperty,
  type ProductPolicyProductLike,
  type ProductPropertyPolicyDiagnostic,
  type ProductPropertyPolicyMode,
  type ProductPropertyPolicyValidationResult,
} from '../media-buy/property-policy';
import { resolvePropertyList, type ResolveListOptions } from '../server/targeting-helpers';
import {
  CreativeFormatCapabilityError,
  CreativeFormatProjectionError,
  canUseProductOptionsForCreativeWire,
  projectMediaBuyCreativesForDelivery,
  projectCreativeForDelivery,
  projectSyncCreativesForDelivery,
  projectUndeclaredFormatOptionSelectors,
  resolveCreativeFormatWireMode,
  stripLegacyCreativeIdentity,
  type CanonicalCreateMediaBuyInput,
  type CanonicalCreateMediaBuyRequest,
  type CanonicalCreativeResponse,
  type CanonicalGetProductsRequest,
  type CanonicalGetProductsResponse,
  type CanonicalListCreativesRequest,
  type CanonicalListCreativesResponse,
  type CanonicalPreviewCreativeRequest,
  type CanonicalPreviewCreativeResponse,
  type CanonicalSyncCreativesRequest,
  type CanonicalUpdateMediaBuyRequest,
  type CreativeFormatWireMode,
  type CreativeFormatSelectorContainer,
  type SyncCreativeFormatProjection,
  type UndeclaredFormatOptionSelector,
} from '../v2/projection/creative-delivery';
import type { LegacyFormatConverter } from '../v2/projection/v1-to-v2';
import {
  formatOptionOriginFromRoutes,
  sameFormatOptionRef,
  sellerDeclaredFormatOptionRefs,
  undeclaredFormatOptionSelector,
  type FormatOptionOrigin,
} from '../v2/projection/legacy-routes';
import {
  legacyFormatConverterFromCatalogSnapshots,
  type ProjectionCatalogSnapshot,
} from '../v2/projection/catalog-snapshot';
import type { CanonicalFormatLegacyResolutionContext, CanonicalFormatLegacyResolver } from '../v2/projection/v2-to-v1';
import { toCanonicalOnlyResponse } from '../v2/projection/augment-response';
import {
  legacyFormatRefsForDeclaration,
  isSynthesizedFormatOption,
  selectedFormatOptions,
  rememberSellerFormatEvidence,
  sellerFormatEvidence,
  type SellerFormatEvidence,
  rememberSellerDeclaredFormatOption,
  sellerDeclaredFormatOption,
  structuredCloneWithLegacyCreativeMetadata,
} from '../v2/projection/legacy-metadata';
import { isProjectionProductInput, type V1FormatId, type V1Product } from '../v2/projection/types';
import { canonicalize as canonicalizeJson } from '../utils/jcs';

type ReadRequestOptions = Pick<TaskOptions, 'signal' | 'transport'>;
type CapabilityProbeRequestOptions = Pick<
  TaskOptions,
  'signal' | 'transport' | 'disableWebhook' | 'delegatedOperatorAuthorization' | 'versionEnvelope'
>;
type ToolSchemaMap = Map<string, Record<string, unknown>>;
// Complete documents share the property map's scope and lifetime, without
// changing the property-map contract used by adaptive request filtering.
const toolInputSchemasByProperties = new WeakMap<ToolSchemaMap, ToolSchemaMap>();
type CapabilityDiscoveryContext = {
  toolSchemas?: ToolSchemaMap;
  capabilities?: AdcpCapabilities;
};
const CAPABILITY_DISCOVERY_CONTEXT = Symbol('capabilityDiscoveryContext');
type InternalReadRequestOptions = ReadRequestOptions & {
  [CAPABILITY_DISCOVERY_CONTEXT]?: CapabilityDiscoveryContext;
};
type UnprojectedPreDispatchHook<T> = BeforeProtocolDispatchHook<T>;

function a2aUrlString(input: string | URL | Request): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
}

function a2aScopedHeaders(
  input: string | URL | Request,
  requestHeaders: HeadersInit | undefined,
  configuredAgentUrl: string,
  agentHeaders: Record<string, string> | undefined,
  authToken: string | undefined
): Record<string, string> {
  const normalized: Record<string, string> = {};
  new Headers(requestHeaders).forEach((value, key) => {
    normalized[key] = value;
  });
  const sameOrigin = new URL(a2aUrlString(input)).origin === new URL(configuredAgentUrl).origin;
  if (!sameOrigin) {
    for (const key of Object.keys(normalized)) {
      if (!['accept', 'content-type', 'a2a-version', 'a2a-extensions'].includes(key.toLowerCase())) {
        delete normalized[key];
      }
    }
    return normalized;
  }
  return {
    ...normalized,
    ...agentHeaders,
    ...(authToken && {
      Authorization: `Bearer ${authToken}`,
      'x-adcp-auth': authToken,
    }),
  };
}

function sameA2AProtocolVersion(left: unknown, right: unknown): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const normalize = (value: string) => value.split('.').slice(0, 2).join('.');
  return normalize(left) === normalize(right);
}

function selectA2AJsonRpcUrl(agentCard: any, protocolVersion: string, configuredAgentUrl: string): string | undefined {
  const interfaces = Array.isArray(agentCard?.supportedInterfaces)
    ? agentCard.supportedInterfaces.filter(
        (candidate: any) => candidate?.protocolBinding === 'JSONRPC' && typeof candidate?.url === 'string'
      )
    : [];
  const selected =
    interfaces.find((candidate: any) => sameA2AProtocolVersion(candidate.protocolVersion, protocolVersion)) ??
    interfaces.find((candidate: any) => sameA2AProtocolVersion(candidate.protocolVersion, '1.0')) ??
    interfaces[0];
  if (!selected) return undefined;
  const resolved = new URL(selected.url, configuredAgentUrl);
  if (resolved.origin !== new URL(configuredAgentUrl).origin) {
    throw new Error(
      `A2A Agent Card selected a cross-origin JSON-RPC endpoint (${resolved.origin}); ` +
        `configure that endpoint explicitly before sending credentials`
    );
  }
  return resolved.toString();
}

function hasMediaBuyCreativeFormatData(request: unknown): boolean {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) return false;
  const record = request as Record<string, unknown>;
  return ['packages', 'new_packages'].some(key => {
    const packages = record[key];
    return (
      Array.isArray(packages) &&
      packages.some(pkg => {
        if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) return false;
        const packageRecord = pkg as Record<string, unknown>;
        return (
          Array.isArray(packageRecord.creatives) ||
          Array.isArray(packageRecord.format_option_refs) ||
          Array.isArray(packageRecord.format_ids) ||
          typeof packageRecord.format_kind === 'string' ||
          Object.getOwnPropertySymbols(packageRecord).length > 0
        );
      })
    );
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function legacyCreativeIdentityPath(value: unknown, path = '$', seen = new WeakSet<object>()): string | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  if (seen.has(value)) return `${path} (cycle)`;
  seen.add(value);
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || (Array.isArray(value) && key === 'length')) continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable) continue;
      const childPath = Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`;
      if (/(^|_)(?:format_ids?|v1_format_ref)($|_)/.test(key)) return childPath;
      if (!('value' in descriptor)) return `${childPath} (accessor)`;
      const nested = legacyCreativeIdentityPath(descriptor.value, childPath, seen);
      if (nested) return nested;
    }
    return undefined;
  } finally {
    seen.delete(value);
  }
}

const CANONICAL_CREATIVE_ACTIVITY_TASKS = new Set([
  'get_products',
  'create_media_buy',
  'update_media_buy',
  'sync_creatives',
  'list_creatives',
  'get_media_buys',
  'get_media_buy_delivery',
  'get_creative_delivery',
]);

// Missing legacy-HMAC registrations are safe only for tools that cannot
// mutate seller state. `get_products` is intentionally absent because its
// legacy proposal-finalization variant is state-changing.
const RECORDLESS_HMAC_READ_ONLY_TASKS = new Set([
  'get_adcp_capabilities',
  'list_products',
  'list_collections',
  'list_proposals',
  'list_creative_formats',
  'preview_creative',
  'list_transformers',
  'list_creatives',
  'get_media_buys',
  'get_media_buy_delivery',
  'media_buy_delivery',
  'get_creative_delivery',
  'get_signals',
  'list_account_changes',
  'list_accounts',
  'get_property_list',
  'list_property_lists',
  'list_content_standards',
  'get_content_standards',
  'si_get_offering',
  'get_plan_audit_logs',
]);

/**
 * Bound task/context state retained for async creative projection and policy.
 *
 * A creative task can contribute several aliases (operation, client task,
 * server task, and conversation context IDs). Ten thousand aliases covers
 * thousands of concurrent tasks while keeping abandoned tasks from growing a
 * long-lived client without limit. Associations retain only converters and a
 * frozen account/package routing projection—never creative assets or webhook
 * credentials. Map insertion order provides LRU eviction.
 */
const TASK_SCOPED_STATE_LIMIT = 10_000;

/**
 * Automatic seller-key resolvers are cheap to recreate, so bound tuple-aware
 * cache cardinality for long-lived shared clients. Map insertion order is the
 * LRU order; successful lookups move their entry to the newest position.
 */
const WEBHOOK_JWKS_RESOLVER_LIMIT = 1_024;

interface CanonicalCreativeTaskAssociation {
  taskType: string;
  legacyFormatConverter?: LegacyFormatConverter;
  routingSnapshot?: CanonicalCreativeRoutingSnapshot;
}

interface ProductPolicyRequestState {
  request?: Readonly<Record<string, unknown>>;
}

type CanonicalLegacyOptionRef =
  | { scope: 'product'; format_option_id: string }
  | { scope: 'publisher'; publisher_domain: string; format_option_id: string };

type CanonicalLegacyRoute =
  | {
      kind: 'product';
      accountScope: string;
      productId: string;
      optionRef: CanonicalLegacyOptionRef;
      refs: readonly V1FormatId[];
      /** Seller-authored declaration, retained for request-local 3.1 wire selection. */
      declaration?: Readonly<Record<string, unknown>>;
      /** Present when the seller's own product did not declare this option. */
      undeclaredSelector?: UndeclaredFormatOptionSelector;
    }
  | {
      kind: 'package';
      accountScope: string;
      packageId: string;
      refs: readonly V1FormatId[];
    };

/** Match routing identity/slots and known dimensions; the seller still validates its full creative contract. */
function creativeMatchesProductOption(
  creative: Record<string, unknown>,
  declaration: Readonly<Record<string, unknown>>
): boolean {
  const params = isPlainRecord(declaration.params) ? declaration.params : {};
  const assets = isPlainRecord(creative.assets) ? creative.assets : {};
  const slots = Array.isArray(params.slots) ? params.slots : [];
  if (
    !slots.every(slot => {
      if (!isPlainRecord(slot) || typeof slot.asset_group_id !== 'string') return false;
      const value = assets[slot.asset_group_id];
      const entries = value === undefined ? [] : Array.isArray(value) ? value : [value];
      const minimum = Math.max(typeof slot.min === 'number' ? slot.min : 0, slot.required === true ? 1 : 0);
      if (entries.length < minimum || (typeof slot.max === 'number' && entries.length > slot.max)) return false;
      return entries.every(
        asset => isPlainRecord(asset) && (typeof slot.asset_type !== 'string' || asset.asset_type === slot.asset_type)
      );
    })
  )
    return false;
  const formatParams = isPlainRecord(creative.format_parameters) ? creative.format_parameters : {};
  const kind = String(creative.format_kind);
  const mediaType = kind.startsWith('image')
    ? 'image'
    : kind.startsWith('video')
      ? 'video'
      : kind.startsWith('audio')
        ? 'audio'
        : kind === 'html5'
          ? 'html'
          : undefined;
  const assetTypes =
    mediaType === 'video'
      ? ['video', 'vast']
      : mediaType === 'audio'
        ? ['audio', 'vast', 'daast']
        : mediaType === 'html'
          ? ['html', 'zip']
          : mediaType
            ? [mediaType]
            : ['image', 'video', 'audio', 'html', 'zip', 'vast', 'daast'];
  const requiredMediaSlots = slots.filter(
    slot =>
      isPlainRecord(slot) &&
      (slot.required === true || (typeof slot.min === 'number' && slot.min > 0)) &&
      assetTypes.includes(String(slot.asset_type))
  );
  const preferredGroups = mediaType ? [`${mediaType}_main`, mediaType, kind, ...assetTypes] : [];
  const primaryGroup =
    (requiredMediaSlots.length === 1 ? String(requiredMediaSlots[0].asset_group_id) : undefined) ??
    preferredGroups.find(group => assets[group] !== undefined);
  const sourceAssets = primaryGroup ? [assets[primaryGroup]] : Object.values(assets);
  const dimensionalAssets = sourceAssets
    .flatMap(value => (Array.isArray(value) ? value : [value]))
    .filter(
      (value): value is Record<string, unknown> => isPlainRecord(value) && assetTypes.includes(String(value.asset_type))
    );
  // Ambiguous multi-asset inputs must all agree; object key order never chooses a rendition.
  return (dimensionalAssets.length > 0 ? dimensionalAssets : [{}]).every(asset => {
    const actual = { ...asset, ...formatParams };
    for (const key of ['width', 'height'] as const) {
      if (typeof params[key] === 'number' && actual[key] !== params[key]) return false;
      const min = params[`min_${key}`];
      const max = params[`max_${key}`];
      if (typeof min === 'number' && (typeof actual[key] !== 'number' || actual[key] < min)) return false;
      if (typeof max === 'number' && (typeof actual[key] !== 'number' || actual[key] > max)) return false;
    }
    if (
      Array.isArray(params.sizes) &&
      !params.sizes.some(size => isPlainRecord(size) && size.width === actual.width && size.height === actual.height)
    )
      return false;
    const duration = actual.duration_ms ?? actual.duration_ms_exact;
    const exact = params.duration_ms_exact ?? params.duration_ms;
    if (typeof exact === 'number' && duration !== exact) return false;
    if (typeof exact !== 'number' && Array.isArray(params.duration_ms_range)) {
      const [min, max] = params.duration_ms_range;
      if (
        typeof duration !== 'number' ||
        (typeof min === 'number' && duration < min) ||
        (typeof max === 'number' && duration > max)
      )
        return false;
    }
    return true;
  });
}

interface CanonicalPackageRouteSelectorSnapshot {
  readonly package_id?: string;
  readonly product_id?: string;
  readonly format_option_refs?: readonly CanonicalLegacyOptionRef[];
}

interface CanonicalCreativeRoutingSnapshot {
  readonly account: Readonly<Record<string, unknown>>;
  readonly packages?: readonly CanonicalPackageRouteSelectorSnapshot[];
  readonly new_packages?: readonly CanonicalPackageRouteSelectorSnapshot[];
}

interface DeferredClientFinalizationContext {
  readonly kind: 'single-agent';
  readonly taskType: string;
  readonly handlerName?: keyof AsyncHandlerConfig;
  readonly canonical: boolean;
  readonly serverVersion?: 'v2' | 'v3';
  readonly serverVersionSynthetic?: boolean;
  /** Older release negotiated for the call; responses are converted up from it. */
  readonly negotiatedAdcpVersion?: string;
  readonly productPolicyRequest: Readonly<Record<string, unknown>>;
  readonly projectionCatalogs?: readonly ProjectionCatalogSnapshot[];
  readonly routingSnapshot?: CanonicalCreativeRoutingSnapshot;
  readonly optionTaskId?: string;
  readonly optionContextId?: string;
  readonly skipStatusHandlers?: boolean;
  readonly accountRegistry?: {
    scope: string;
    refs?: AccountReference[];
    dryRun?: boolean;
    knownOnly?: boolean;
    observationEpoch?: number;
  };
}

function isDeferredClientFinalizationContext(value: unknown): value is DeferredClientFinalizationContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const context = value as Record<string, unknown>;
  return (
    context.kind === 'single-agent' &&
    typeof context.taskType === 'string' &&
    typeof context.canonical === 'boolean' &&
    !!context.productPolicyRequest &&
    typeof context.productPolicyRequest === 'object' &&
    !Array.isArray(context.productPolicyRequest) &&
    (context.serverVersion === undefined || context.serverVersion === 'v2' || context.serverVersion === 'v3') &&
    (context.serverVersionSynthetic === undefined || typeof context.serverVersionSynthetic === 'boolean') &&
    (context.negotiatedAdcpVersion === undefined || typeof context.negotiatedAdcpVersion === 'string') &&
    (context.projectionCatalogs === undefined || Array.isArray(context.projectionCatalogs)) &&
    (context.handlerName === undefined || typeof context.handlerName === 'string') &&
    (context.skipStatusHandlers === undefined || typeof context.skipStatusHandlers === 'boolean')
  );
}

const MAX_REMEMBERED_NEGOTIATED_RELEASES = 1024;
const CANONICAL_PACKAGE_ROUTE_TASKS = new Set(['create_media_buy', 'update_media_buy', 'get_media_buys']);
const canonicalCreativeRoutingSnapshots = new WeakSet<object>();

function canonicalAccountRoutingSnapshot(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const account = value as Record<string, unknown>;
  if (typeof account.account_id === 'string') return Object.freeze({ account_id: account.account_id });
  if (
    !account.brand ||
    typeof account.brand !== 'object' ||
    Array.isArray(account.brand) ||
    typeof account.operator !== 'string'
  ) {
    return undefined;
  }
  const sourceBrand = account.brand as Record<string, unknown>;
  if (typeof sourceBrand.domain !== 'string') return undefined;
  const brand = Object.freeze({
    domain: sourceBrand.domain,
    ...(typeof sourceBrand.brand_id === 'string' ? { brand_id: sourceBrand.brand_id } : {}),
    ...(Array.isArray(sourceBrand.countries) && sourceBrand.countries.every(country => typeof country === 'string')
      ? { countries: Object.freeze([...sourceBrand.countries].sort()) }
      : {}),
  });
  const operatorUnit = account.operator_unit;
  const unitId =
    operatorUnit && typeof operatorUnit === 'object' && !Array.isArray(operatorUnit)
      ? (operatorUnit as Record<string, unknown>).id
      : undefined;
  return Object.freeze({
    brand,
    operator: account.operator,
    ...(typeof unitId === 'string' ? { operator_unit: Object.freeze({ id: unitId }) } : {}),
    ...(typeof account.currency === 'string' ? { currency: account.currency } : {}),
    ...(typeof account.timezone === 'string' ? { timezone: account.timezone } : {}),
    sandbox: account.sandbox === true,
  });
}

function canonicalOptionRefRoutingSnapshot(value: unknown): CanonicalLegacyOptionRef | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const ref = value as Record<string, unknown>;
  if (typeof ref.format_option_id !== 'string') return undefined;
  if (ref.scope === 'publisher' || typeof ref.publisher_domain === 'string') {
    if (typeof ref.publisher_domain !== 'string') return undefined;
    return Object.freeze({
      scope: 'publisher' as const,
      publisher_domain: ref.publisher_domain,
      format_option_id: ref.format_option_id,
    });
  }
  return Object.freeze({ scope: 'product' as const, format_option_id: ref.format_option_id });
}

function canonicalPackageRouteSelectorSnapshot(value: unknown): CanonicalPackageRouteSelectorSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const selector = value as Record<string, unknown>;
  const formatOptionRefs = Array.isArray(selector.format_option_refs)
    ? selector.format_option_refs
        .map(canonicalOptionRefRoutingSnapshot)
        .filter((ref): ref is CanonicalLegacyOptionRef => ref !== undefined)
    : [];
  const snapshot = {
    ...(typeof selector.package_id === 'string' ? { package_id: selector.package_id } : {}),
    ...(typeof selector.product_id === 'string' ? { product_id: selector.product_id } : {}),
    ...(formatOptionRefs.length > 0 ? { format_option_refs: Object.freeze(formatOptionRefs) } : {}),
  };
  return Object.keys(snapshot).length > 0 ? Object.freeze(snapshot) : undefined;
}

function canonicalCreativeRoutingSnapshot(
  taskType: string,
  request: unknown
): CanonicalCreativeRoutingSnapshot | undefined {
  if (
    !CANONICAL_PACKAGE_ROUTE_TASKS.has(taskType) ||
    !request ||
    typeof request !== 'object' ||
    Array.isArray(request)
  ) {
    return undefined;
  }
  if (canonicalCreativeRoutingSnapshots.has(request)) {
    return request as CanonicalCreativeRoutingSnapshot;
  }
  const record = request as Record<string, unknown>;
  const account = canonicalAccountRoutingSnapshot(record.account);
  if (!account) return undefined;
  const packageSnapshots = (key: 'packages' | 'new_packages'): readonly CanonicalPackageRouteSelectorSnapshot[] =>
    Object.freeze(
      (Array.isArray(record[key]) ? record[key] : [])
        .map(canonicalPackageRouteSelectorSnapshot)
        .filter((selector): selector is CanonicalPackageRouteSelectorSnapshot => selector !== undefined)
    );
  const packages = packageSnapshots('packages');
  const newPackages = packageSnapshots('new_packages');
  const snapshot = Object.freeze({
    account,
    ...(packages.length > 0 ? { packages } : {}),
    ...(newPackages.length > 0 ? { new_packages: newPackages } : {}),
  });
  canonicalCreativeRoutingSnapshots.add(snapshot);
  return snapshot;
}

const canonicalCreativeExecutionStorage = globalAsyncLocalStorage<{
  taskType: string;
  canonical: boolean;
  legacyFormatConverter?: LegacyFormatConverter;
  canonicalRequest?: unknown;
}>('canonicalCreativeExecution');

function isCanonicalCreativeExecution(taskType: string | undefined): boolean {
  if (!taskType) return false;
  if (CANONICAL_CREATIVE_ACTIVITY_TASKS.has(taskType)) return true;
  const active = canonicalCreativeExecutionStorage.getStore();
  return active?.canonical === true && active.taskType === taskType;
}

/**
 * Snapshot semantic payloads without executing adopter-controlled behavior.
 * Plain data retains identity when unchanged (including private WeakMap format
 * metadata); class instances are flattened to enumerable own data.
 */
function prepareCanonicalCreativePayload(
  value: unknown,
  taskType: string,
  active = new WeakSet<object>(),
  prepared = new WeakMap<object, unknown>()
): unknown {
  if (value === null || typeof value !== 'object') return value;
  for (let owner: object | null = value; owner !== null; owner = Object.getPrototypeOf(owner)) {
    const toJSON = Object.getOwnPropertyDescriptor(owner, 'toJSON');
    if (toJSON && (!('value' in toJSON) || typeof toJSON.value === 'function')) {
      throw new CreativeFormatProjectionError(
        taskType,
        '(response:toJSON)',
        'custom or accessor toJSON hooks cannot cross the canonical creative boundary safely'
      );
    }
  }
  if (active.has(value)) {
    throw new CreativeFormatProjectionError(
      taskType,
      '(response:cycle)',
      'cyclic values cannot cross the canonical creative boundary'
    );
  }
  const cached = prepared.get(value);
  if (cached !== undefined) return cached;

  active.add(value);
  try {
    const isArray = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    const plain = isArray ? prototype === Array.prototype : prototype === Object.prototype || prototype === null;
    const output: Record<string | symbol, unknown> | unknown[] = isArray
      ? []
      : Object.create(prototype === null ? null : Object.prototype);
    prepared.set(value, output);
    let changed = !plain;
    for (const key of Reflect.ownKeys(value)) {
      if (isArray && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) continue;
      if (!('value' in descriptor)) {
        throw new CreativeFormatProjectionError(
          taskType,
          `(response:${String(key)})`,
          'accessors cannot cross the canonical creative boundary safely'
        );
      }
      if (!descriptor.enumerable) continue;
      const safe = prepareCanonicalCreativePayload(descriptor.value, taskType, active, prepared);
      if (safe !== descriptor.value) changed = true;
      Object.defineProperty(output, key, { ...descriptor, value: safe });
    }
    if (!changed) {
      prepared.set(value, value);
      return value;
    }
    return output;
  } finally {
    active.delete(value);
  }
}

function projectPreparedCanonicalCreativeResponseValue(
  value: unknown,
  taskType: string,
  legacyFormatConverter: LegacyFormatConverter | undefined,
  selectorContainer: CreativeFormatSelectorContainer = {}
): unknown {
  if (Array.isArray(value)) {
    return value.map(item =>
      projectPreparedCanonicalCreativeResponseValue(item, taskType, legacyFormatConverter, selectorContainer)
    );
  }
  if (!value || typeof value !== 'object') return value;

  let projected = value as Record<string, unknown>;
  if (isProjectionProductInput(projected)) {
    const canonical = toCanonicalOnlyResponse({ products: [projected] }, { legacyFormatConverter });
    if (canonical.diagnostics.length > 0 || canonical.response.products.length !== 1) {
      throw new CreativeFormatProjectionError(
        taskType,
        `(product:${String(projected.product_id)})`,
        'legacy product formats in the response have no complete canonical representation'
      );
    }
    projected = canonical.response.products[0] as unknown as Record<string, unknown>;
  } else if (
    (typeof projected.package_id === 'string' || typeof projected.product_id === 'string') &&
    Array.isArray(projected.format_ids)
  ) {
    projected = (
      projectMediaBuyCreativesForDelivery(
        { packages: [projected] },
        'canonical',
        taskType === 'update_media_buy' ? 'update_media_buy' : 'create_media_buy',
        legacyFormatConverter
      ) as { packages: Record<string, unknown>[] }
    ).packages[0]!;
  }

  if (
    typeof projected.creative_id === 'string' &&
    (projected.format_id !== undefined || typeof projected.format_kind === 'string')
  ) {
    projected = projectCreativeForDelivery(
      projected as unknown as import('../types/tools.generated').CreativeAsset,
      selectorContainer,
      'canonical',
      taskType,
      legacyFormatConverter
    ) as unknown as Record<string, unknown>;
  }

  const nextSelector =
    Array.isArray(projected.format_ids) ||
    Array.isArray(projected.format_options) ||
    Array.isArray(projected.format_option_refs)
      ? (projected as CreativeFormatSelectorContainer)
      : selectorContainer;
  let changed = projected !== value;
  const next: Record<string, unknown> = { ...projected };
  for (const [key, child] of Object.entries(projected)) {
    const childProjected = projectPreparedCanonicalCreativeResponseValue(
      child,
      taskType,
      legacyFormatConverter,
      nextSelector
    );
    if (childProjected !== child) {
      next[key] = childProjected;
      changed = true;
    }
  }
  return changed ? next : projected;
}

function projectCanonicalCreativeResponseValue(
  value: unknown,
  taskType: string,
  legacyFormatConverter: LegacyFormatConverter | undefined,
  selectorContainer: CreativeFormatSelectorContainer = {}
): unknown {
  return projectPreparedCanonicalCreativeResponseValue(
    prepareCanonicalCreativePayload(value, taskType),
    taskType,
    legacyFormatConverter,
    selectorContainer
  );
}

function projectCanonicalCreativeAncillaryValue(
  value: unknown,
  taskType: string,
  legacyFormatConverter: LegacyFormatConverter | undefined
): unknown {
  try {
    return stripLegacyCreativeIdentity(projectCanonicalCreativeResponseValue(value, taskType, legacyFormatConverter));
  } catch (error) {
    if (!(error instanceof CreativeFormatProjectionError)) throw error;
    return { omitted: true, reason: 'canonical creative payload unavailable' };
  }
}

/** Keep legacy creative identity confined to the transport adapter. */
function canonicalCreativeActivity(activity: Activity): Activity {
  const active = canonicalCreativeExecutionStorage.getStore();
  const effectiveTaskType = active?.taskType && active.canonical ? active.taskType : activity.task_type;
  if (!isCanonicalCreativeExecution(effectiveTaskType) || activity.payload === undefined) {
    return activity;
  }
  const converter = active?.taskType === effectiveTaskType ? active.legacyFormatConverter : undefined;
  const source =
    activity.type === 'protocol_request' &&
    active?.taskType === effectiveTaskType &&
    active.canonicalRequest !== undefined
      ? { params: active.canonicalRequest }
      : activity.payload;
  try {
    return {
      ...activity,
      payload: stripLegacyCreativeIdentity(projectCanonicalCreativeResponseValue(source, effectiveTaskType, converter)),
    };
  } catch (error) {
    if (!(error instanceof CreativeFormatProjectionError)) throw error;
    return { ...activity, payload: { omitted: true, reason: 'canonical creative payload unavailable' } };
  }
}

function canonicalCreativeDiagnosticBody(body: string | undefined, taskType: string): string | undefined {
  if (body === undefined) return undefined;
  try {
    const active = canonicalCreativeExecutionStorage.getStore();
    const converter = active?.taskType === taskType ? active.legacyFormatConverter : undefined;
    return JSON.stringify(
      stripLegacyCreativeIdentity(projectCanonicalCreativeResponseValue(JSON.parse(body), taskType, converter))
    );
  } catch {
    // Truncated JSON and streaming envelopes cannot be projected reliably.
    // Omitting them keeps the canonical public boundary deterministic.
    return '[canonical creative payload omitted]';
  }
}

/** Prevent transport observability from becoming a backdoor to legacy creative identity. */
function canonicalCreativeTransportActivity(
  event: import('../protocols').TransportActivity
): import('../protocols').TransportActivity {
  const active = canonicalCreativeExecutionStorage.getStore();
  const taskType = active?.taskType && active.canonical ? active.taskType : (event.taskType ?? event.tool);
  if (!taskType || !isCanonicalCreativeExecution(taskType)) return event;
  return {
    ...event,
    ...(event.requestBody !== undefined && {
      requestBody: canonicalCreativeDiagnosticBody(event.requestBody, taskType),
    }),
    ...(event.responseBody !== undefined && {
      responseBody: canonicalCreativeDiagnosticBody(event.responseBody, taskType),
    }),
  };
}

/** Clone a typed error without retaining legacy identity in reflective own fields. */
function canonicalCreativeErrorInstance<T extends Error>(error: T, legacySource?: unknown): T {
  const own: Record<string, unknown> = {};
  const descriptors = Object.getOwnPropertyDescriptors(error);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    // Invoking an adopter-defined accessor while sanitizing is unsafe. Prototype
    // accessors remain available; reflective own accessors are omitted.
    if ('value' in descriptor) own[key] = descriptor.value;
  }
  const { legacySource: _dropLegacySource, own: safeOwn } = stripLegacyCreativeIdentity({ own, legacySource }) as {
    own: Record<string, unknown>;
    legacySource?: unknown;
  };
  void _dropLegacySource;

  const clone = Object.create(Object.getPrototypeOf(error)) as T;
  for (const [key, value] of Object.entries(safeOwn)) {
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor)) continue;
    Object.defineProperty(clone, key, { ...descriptor, value });
  }
  // Symbol-keyed data is not traversed by JSON projection, but it is visible
  // through reflection. Sanitize its value independently and omit accessors.
  for (const symbol of Object.getOwnPropertySymbols(error)) {
    const descriptor = Object.getOwnPropertyDescriptor(error, symbol);
    if (!descriptor || !('value' in descriptor)) continue;
    const safe = stripLegacyCreativeIdentity({ value: descriptor.value, legacySource }) as {
      value: unknown;
    };
    Object.defineProperty(clone, symbol, { ...descriptor, value: safe.value });
  }
  return stripLegacyCreativeIdentity(clone) as T;
}

export type CreativeDeliveryTaskOptions = TaskOptions & {
  legacyFormatConverter?: LegacyFormatConverter;
  /** Pre-resolved exact-owner publisher/community catalogs, highest precedence first. */
  projectionCatalogs?: readonly ProjectionCatalogSnapshot[];
  /** Resolver for persisted canonical selections that need a seller-specific legacy wire identity. */
  canonicalFormatLegacyResolver?: CanonicalFormatLegacyResolver;
};

export type CanonicalReadTaskOptions = TaskOptions & {
  legacyFormatConverter?: LegacyFormatConverter;
  /** Pre-resolved exact-owner publisher/community catalogs, highest precedence first. */
  projectionCatalogs?: readonly ProjectionCatalogSnapshot[];
};

export type SyncCreativesTaskOptions = CreativeDeliveryTaskOptions & {
  creativeFormatProjection?: SyncCreativeFormatProjection;
};

function snapshotTaskOptions<T extends TaskOptions | undefined>(options: T): T {
  if (!options) return options;
  return {
    ...options,
    ...(options.transport !== undefined && { transport: { ...options.transport } }),
    ...(options.metadata !== undefined && { metadata: structuredClone(options.metadata) }),
    ...(options.delegatedOperatorAuthorization !== undefined && {
      delegatedOperatorAuthorization: { ...options.delegatedOperatorAuthorization },
    }),
    ...(options.durableContinuationRecovery !== undefined && {
      durableContinuationRecovery: { ...options.durableContinuationRecovery },
    }),
  } as T;
}

function assertRawMethodForGovernedPayload(taskType: string, options?: TaskOptions): void {
  if (options?.preserveGovernedPayload) {
    throw new ConfigurationError(
      `Governed ${taskType} requires the raw legacy task method; canonical creative projection can reshape approved arguments.`
    );
  }
}

const PRIMARY_ADCP_TASK_NAMES = {
  get_products: true,
  list_products: true,
  list_collections: true,
  list_proposals: true,
  request_proposals: true,
  refine_proposals: true,
  decline_proposals: true,
  buy_products: true,
  accept_proposal: true,
  control_media_buy: true,
  create_media_buy: true,
  update_media_buy: true,
  sync_creatives: true,
  list_creatives: true,
  get_media_buys: true,
  get_media_buy_delivery: true,
  get_reporting_status: true,
  sync_reporting_status: true,
  sync_reporting_receipts: true,
  get_creative_delivery: true,
  provide_performance_feedback: true,
  get_signals: true,
  activate_signal: true,
  get_adcp_capabilities: true,
  list_account_changes: true,
  list_accounts: true,
  sync_accounts: true,
  sync_audiences: true,
  create_property_list: true,
  get_property_list: true,
  update_property_list: true,
  list_property_lists: true,
  delete_property_list: true,
  si_get_offering: true,
  si_initiate_session: true,
  si_send_message: true,
  si_terminate_session: true,
  get_brand_identity: true,
  sync_plans: true,
  check_governance: true,
  report_plan_outcome: true,
  report_plan_adjustment: true,
  get_plan_audit_logs: true,
  sync_agent_notification_configs: true,
  get_principal: true,
  sync_principal: true,
  context_match: true,
  identity_match: true,
} satisfies Record<AdcpTaskName, true>;

const STANDARD_ADCP_TASK_NAMES = new Set<string>([
  ...Object.keys(PRIMARY_ADCP_TASK_NAMES),
  'list_creative_formats',
  'list_transformers',
  'preview_creative',
  'build_creative',
  // These standard protocol tools still carry legacy creative `format_id`
  // identity through artifacts, manifests, standards, or rights constraints.
  // They are available only through explicitly named *Legacy APIs until a
  // lossless canonical projection exists.
  'list_content_standards',
  'get_content_standards',
  'create_content_standards',
  'update_content_standards',
  'calibrate_content',
  'validate_content_delivery',
  'get_media_buy_artifacts',
  'get_creative_features',
  'get_rights',
  'acquire_rights',
  'update_rights',
]);

const PRINCIPAL_IDENTITY_INPUT_FIELDS = ['buyer_agent_url', 'agent_url', 'principal_id', 'connection_id'] as const;

function assertNoPrincipalIdentityInput(taskType: string, params: unknown): void {
  if (
    (taskType !== 'get_principal' && taskType !== 'sync_principal') ||
    params === null ||
    typeof params !== 'object' ||
    Array.isArray(params)
  ) {
    return;
  }
  for (const field of PRINCIPAL_IDENTITY_INPUT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(params, field)) {
      throw new TypeError(
        `${taskType} refuses caller-supplied ${field}; principal identity must come from authenticated transport state.`
      );
    }
  }
}

/**
 * Error class for v3 feature compatibility issues
 *
 * Note: The library no longer throws this error for get_products calls with
 * unsupported v3 features. Instead, it returns an empty result (semantically
 * "no products match this filter"). This error class is exported for use in
 * custom validation logic or other scenarios.
 *
 * @example
 * ```typescript
 * // Custom validation before making requests
 * const capabilities = await client.getCapabilities();
 * if (params.property_list && !capabilities.features.propertyListFiltering) {
 *   throw new UnsupportedFeatureError('property_list', capabilities.version);
 * }
 * ```
 */
export class UnsupportedFeatureError extends Error {
  constructor(
    public readonly feature: string,
    public readonly serverVersion: 'v2' | 'v3',
    message?: string
  ) {
    super(message || `Feature '${feature}' requires AdCP v3 but server is ${serverVersion}`);
    this.name = 'UnsupportedFeatureError';
  }
}

/** AgentConfig with internal flags for lazy discovery */
type InternalAgentConfig = AgentConfig & {
  _needsDiscovery?: boolean;
  _needsCanonicalUrl?: boolean;
};

type NormalizedWebhookPayload = {
  operation_id: string;
  task_id: string;
  task_type: string;
  status: TaskStatus;
  context_id?: string;
  result?: AdCPAsyncResponseData;
  message?: string;
  timestamp?: string;
  idempotency_key?: string;
  notification_id?: string;
  protocol?: 'mcp' | 'a2a';
};

export interface ClientProductPropertyPolicy extends BuyerPropertyPolicy {
  /** Resolve a complete publisher catalog for app/CTV selector matching. Failures follow unknownSelectorBehavior. */
  resolvePublisherProperties?: (
    publisherDomain: string,
    options?: { signal?: AbortSignal }
  ) => Promise<readonly ProductPolicyResolvedProperty[] | undefined>;
  /** Maximum distinct catalog lookups per response. Overflow follows unknownSelectorBehavior. Default: 100. */
  maxPublisherLookups?: number;
  /** Per-catalog timeout. The hook receives an abort signal. Default: 10 seconds. */
  publisherLookupTimeoutMs?: number;
  /** Total catalog-lookup budget per response. Unfinished lookups stay unknown. Default: 10 seconds. */
  publisherLookupBudgetMs?: number;
  /**
   * Enforcement mode for completed `get_products` responses.
   *
   * - `filter` (default): remove rejected products before handlers/callers see them
   * - `reject_response`: fail the task when any product violates the policy
   * - `audit`: keep products but attach diagnostics
   */
  mode?: ProductPropertyPolicyMode;
  /**
   * Resolve `filters.property_list` (AdCP 3.2) or deprecated `property_list`
   * as an allow-list. Conflicting references fail closed. Defaults to true.
   */
  enforceRequestPropertyList?: boolean;
  /**
   * Resolver options for request-derived property-list validation. The default
   * uses the SDK's process-local resolved-list cache.
   */
  propertyListResolveOptions?: ResolveListOptions;
  /**
   * Message surfaced in debug logs and failed results when the policy rejects
   * products.
   *
   * @default 'Property list not adhered to'
   */
  message?: string;
}

export type WebhookParseErrorCode =
  | WebhookSignatureErrorCode
  | 'webhook_signature_invalid'
  | 'webhook_timestamp_invalid'
  | 'webhook_unsupported_payload'
  | 'webhook_envelope_invalid'
  | 'webhook_result_invalid'
  /**
   * The receiver has no trusted registration or legacy HMAC configuration, so
   * no authentication check can be selected safely.
   */
  | 'webhook_unverifiable'
  | 'webhook_registration_not_found'
  | 'webhook_registration_mismatch'
  | 'webhook_verification_context_missing'
  | 'webhook_registration_store_unavailable'
  | 'webhook_durable_settlement_unavailable'
  | 'webhook_publication_in_progress'
  | 'webhook_idempotency_conflict'
  | 'webhook_verification_unavailable';

export interface WebhookVerificationConfig {
  webBotAuth?: {
    directory: import('../signing/web-bot-auth').SignatureDirectoryResolver;
    /**
     * Seller origin revocation, checked after verification. A revoked key is
     * refused; unknown status is retryable; a seller that serves no list is
     * accepted (webhooks do not spend). Usually an `OriginRevocationResolver`.
     */
    revocation?: {
      status(origin: string, keyid: string): Promise<import('../identity-3.3/revocation').OriginRevocationStatus>;
    };
    /** @deprecated Use `revocation`. Conservative: a seller that serves no list is refused. */
    isRevoked?: (origin: string, keyid: string) => Promise<boolean>;
  };
  /** Applicable pins from persisted media-buy records. Reuse refresh callbacks bound to the seller/publisher/tenant across deliveries to share their cooldown. Never use webhook payload fields. */
  publisherPins?: (
    registration: Readonly<WebhookRegistration>
  ) => Promise<readonly import('../signing/publisher-pins').PublisherSigningKeyPin[]>;
  /** Local diagnostics for request_signature_* discovery causes. */
  onKeyResolutionError?: (error: unknown) => void;
  /** Deterministic/custom key source. Defaults to resolveAgent brand.json discovery. */
  jwks?: JwksResolver;
  /** Shared nonce replay store. Defaults to one process-local store per client. */
  replayStore?: ReplayStore;
  /** Key revocation source. Defaults to one process-local store per client. */
  revocationStore?: RevocationStore;
  /** Clock in epoch seconds. */
  now?: () => number;
  /** Safe discovery/cache tuning for the default seller-pinned JWK resolver. */
  resolverOptions?: Omit<ResolvedAgentJwksResolverOptions, 'fetchCapabilities'>;
  /**
   * Fetch capabilities for seller key discovery. The callback must authenticate
   * only to the supplied, already-pinned seller URL and protocol.
   */
  fetchCapabilities?: (agentUrl: string, protocol: 'mcp' | 'a2a') => Promise<unknown>;
}

export interface VerifyAndParseWebhookOptions {
  /** Raw HTTP body bytes captured before JSON parsing. Required when `webhookSecret` is configured. */
  rawBody?: string | Buffer | Uint8Array;
  /** Parsed payload or raw body. When HMAC is configured, verified raw bytes are parsed instead of `payload`. */
  body?: string | Buffer | Uint8Array | unknown;
  /** Parsed protocol payload. */
  payload?: unknown;
  /** Header bag from the receiver framework. Used for HMAC verification when configured. */
  headers?: WebhookHeadersLike;
  /** Task type from trusted routing context. Used as an A2A fallback. */
  taskType?: string;
  /** Operation id from trusted routing context. Used as an A2A fallback. */
  operationId?: string;
  /** Actual HTTP method from trusted server context. Required for every registered callback. */
  requestMethod?: string;
  /** Externally visible absolute request URL from trusted server/proxy configuration. Required for every registered callback. */
  requestUrl?: string;
  /** Explicit legacy HMAC signature header value. */
  signature?: WebhookHeaderValue;
  /** Explicit legacy HMAC timestamp header value. */
  timestamp?: WebhookHeaderValue;
}

/** Trusted HTTP request context for direct registered-webhook dispatch. */
export interface WebhookRequestContext {
  /** Actual HTTP method from trusted server context. */
  requestMethod: string;
  /** Externally visible absolute request URL from trusted server/proxy configuration. */
  requestUrl: string;
}

export interface WebhookHandlerRequest {
  headers: Record<string, WebhookHeaderValue>;
  body: unknown;
  rawBody?: string | Buffer | Uint8Array;
  params?: Record<string, string>;
  method?: string;
  /** Trusted externally visible absolute URL supplied by the application. */
  publicUrl?: string;
}

export interface WebhookHandlerAdapter {
  getOperationId?: (request: WebhookHandlerRequest) => string | undefined | Promise<string | undefined>;
  getTaskType?: (request: WebhookHandlerRequest) => string | undefined | Promise<string | undefined>;
  getRequestMethod?: (request: WebhookHandlerRequest) => string | undefined | Promise<string | undefined>;
  /** Must return a trusted externally visible URL; never derive it from untrusted forwarding headers. */
  getRequestUrl?: (request: WebhookHandlerRequest) => string | undefined | Promise<string | undefined>;
}

export type WebhookParseResult = WebhookParseSuccess | WebhookParseFailure;

export interface WebhookParseSuccess {
  ok: true;
  protocol: 'mcp' | 'a2a';
  envelope: MCPWebhookPayload | A2ATask | TaskStatusUpdateEvent;
  result: unknown;
  metadata: {
    taskId: string;
    taskType: string;
    operationId: string;
    contextId?: string;
    idempotencyKey?: string;
    notificationId?: string;
    status: TaskStatus;
    timestamp?: string;
    message?: string;
    previewHandler?: 'canonical' | 'legacy';
    requiresDurableSettlement?: boolean;
  };
}

export interface WebhookParseFailure {
  ok: false;
  code: WebhookParseErrorCode;
  message: string;
  cause?: unknown;
}

export class WebhookDispatchError extends Error {
  readonly code: WebhookParseErrorCode;
  readonly cause?: unknown;

  constructor(code: WebhookParseErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'WebhookDispatchError';
    this.code = code;
    this.cause = cause;
  }
}

const WEBHOOK_TASK_STATUSES = new Set<string>([
  'submitted',
  'working',
  'input-required',
  'completed',
  'canceled',
  'failed',
  'rejected',
  'auth-required',
  'unknown',
]);
const DURABLE_SETTLEMENT_TERMINAL_STATUSES = new Set<import('./ConversationTypes').TaskStatus>([
  'completed',
  'failed',
  'rejected',
  'canceled',
  'governance-denied',
  'aborted',
]);

// Top-level fields that every MCP webhook envelope must carry, regardless of
// negotiated AdCP version. `operation_id` is intentionally NOT here: it became
// a required webhook field in AdCP 3.1, but 3.0 senders are spec-compliant
// without it. The receiver can't reliably know the sender's negotiated version
// from the POST body alone, so requiring `operation_id` here broke 3.0
// interop. When absent we fall back to the routing-context operationId (see
// normalizeWebhookPayload), so its omission is non-fatal for dispatch.
const MCP_WEBHOOK_REQUIRED_FIELDS = ['idempotency_key', 'task_id', 'task_type', 'status', 'timestamp'] as const;

/** Context for an isolated inline completion status-handler failure. */
export interface StatusHandlerErrorContext {
  handlerName: keyof AsyncHandlerConfig;
  metadata: WebhookMetadata;
}

/**
 * Configuration for SingleAgentClient (and multi-agent client)
 */
export interface SingleAgentClientConfig extends ConversationConfig {
  /** Enable pinned draft identity schemas and positively negotiated 3.3 webhook rules. */
  experimentalIdentity33?: boolean;
  webhookSigningProfile?: 'adcp/webhook-signing/v1' | 'web-bot-auth';
  /** Default off disables provisioning gates; auto/strict use the provisioning registry. */
  accountPolicy?: AccountPolicy;
  /** Auto selects seller IDs only with stable_account_id or an AdCP 4+ wire contract. Natural-key preserves legacy implicit references. */
  accountReferenceMode?: 'auto' | 'natural-key';
  accountStorage?: BuyerAccountStorage;
  accountRegistryMaxEntries?: number;
  accountRegistryOptions?: Pick<
    import('./buyer-account-registry').BuyerAccountRegistryOptions,
    'onDispatchStart' | 'onResult'
  >;
  /** Trusted stable caller identity for durable registry partitioning. Default is credential fingerprint. */
  accountRegistryScope?: string;
  productCache?: ProductCache;
  /**
   * Share endpoint discovery, the `tools/list` schema map and
   * `get_adcp_capabilities` across client instances. Opt-in: nothing is shared
   * unless a cache and a caller-owned `authIdentity` are supplied.
   *
   * Entries are keyed by agent URL, `authIdentity`, the pinned AdCP version, the
   * non-correlation request headers (tenant/routing headers included), the
   * signing identity and the transport policy (`allowPrivateIp`,
   * `maxResponseBytes`), and expire after `ttlMs`. Synthetic capabilities
   * (a seller whose capabilities call failed or that has no
   * `get_adcp_capabilities`) are never shared, and calls that use a scoped
   * `trustedFetchFn` bypass the cache entirely.
   * See `docs/guides/DISCOVERY-CACHE-AND-SESSION-REUSE.md`.
   */
  discoveryCache?: AgentDiscoveryCacheConfig;
  /** @internal Allow local discovery reuse while the compliance runner owns this exact transport. */
  _reuseConfiguredDiscovery?: () => boolean;
  /** Durable storage for restart-safe A2A human continuations. */
  deferredStorage?: DeferredTaskStorage;
  /** Resolve current trusted agent configuration for a persisted continuation. */
  resolveDeferredAgent?: (agentId: string) => AgentConfig | undefined | Promise<AgentConfig | undefined>;
  /** Lifetime of a persisted continuation token in seconds. Defaults to seven days. */
  deferredTaskTtlSeconds?: number;
  /** Converter for seller-specific legacy creative formats at canonical read, write, and webhook boundaries. */
  legacyFormatConverter?: LegacyFormatConverter;
  /** Pre-resolved exact-owner publisher/community catalogs used at every projection boundary. */
  projectionCatalogs?: readonly ProjectionCatalogSnapshot[];
  /** Resolver for persisted canonical selections when a negotiated legacy wire is required. */
  canonicalFormatLegacyResolver?: CanonicalFormatLegacyResolver;
  /**
   * AdCP protocol version this client speaks to agents. Defaults to
   * {@link ADCP_VERSION} — the GA version the SDK ships against. Override
   * to pin to an older stable (e.g., `'3.0.0'`) or opt into a beta channel
   * (`'3.1.0-beta.1'`) once that registry ships.
   *
   * Stage 2 plumbs the option through and validates it at construction
   * time; cross-major pins (e.g. `'4.0.0-beta.1'` while the SDK ships
   * against major 3) throw `ConfigurationError`. Stage 3 wires per-instance
   * schema/validator selection off this field.
   *
   * Typed as `AdcpVersion | (string & {})` so editors autocomplete
   * canonical values from {@link COMPATIBLE_ADCP_VERSIONS} while still
   * accepting forward-compatible strings.
   */
  adcpVersion?: AdcpVersion | (string & {});
  /**
   * Optional wire-only AdCP version envelope override. Request/response
   * validation still uses `adcpVersion`; protocol envelopes use this value.
   */
  wireAdcpVersion?: AdcpVersion | (string & {});
  /**
   * Controls emission of AdCP version envelope fields. Defaults to `auto`.
   * `none` is primarily for conformance harnesses that need to send a
   * request exactly as authored, without SDK-managed version fields.
   */
  versionEnvelope?: import('../protocols').VersionEnvelopeMode;
  /** Enable debug logging */
  debug?: boolean;
  /** Custom User-Agent header sent with all outbound protocol requests.
   *  Overridden by per-agent `headers['User-Agent']` if set. */
  userAgent?: string;
  /** Additional headers to include in requests */
  headers?: Record<string, string>;
  /** Activity callback for observability (logging, UI updates, etc) */
  onActivity?: (activity: Activity) => void | Promise<void>;
  /**
   * Transport-level diagnostics callback for outbound HTTP requests.
   *
   * Receives sanitized request/response/failure events from the SDK's
   * protocol fetch layer. Header maps are allowlisted/redacted and URLs have
   * credentials, query strings, and fragments stripped before emission.
   */
  onTransportActivity?: import('../protocols').TransportActivityHandler;
  /**
   * Task completion handlers — called for both sync responses and webhook
   * completions.
   *
   * For at-least-once webhook delivery, set `handlers.webhookDedup` to
   * drop duplicate retries by `idempotency_key`. See
   * `docs/guides/PUSH-NOTIFICATION-CONFIG.md#deduplication`.
   * For per-call skipping and inline error isolation, see
   * `docs/guides/PUSH-NOTIFICATION-CONFIG.md#inline-completion-handlers`.
   */
  handlers?: AsyncHandlerConfig;
  /**
   * Return successful completed results even if an inline status handler throws.
   * Defaults to false, preserving handler rejection and durable finalization retry.
   * Does not change webhook error handling or cancellation behavior.
   */
  isolateStatusHandlerErrors?: boolean;
  /**
   * Reports inline status-handler errors when isolateStatusHandlerErrors is true.
   * Errors thrown by this observer are recorded as warnings and do not reject the task.
   */
  onStatusHandlerError?: (error: unknown, context: StatusHandlerErrorContext) => void | Promise<void>;
  /** Select legacy HMAC-SHA256 push verification. Omit to use RFC 9421. */
  webhookSecret?: string;
  /** Durable provenance for outbound push registrations. Defaults to process-local memory. */
  webhookRegistrationStore?: WebhookRegistrationStore;
  /** Registration retention in seconds. Defaults to seven days. */
  webhookRegistrationTtlSeconds?: number;
  /** RFC 9421 key, replay, revocation, and discovery configuration. */
  webhookVerification?: WebhookVerificationConfig;
  /**
   * Accept inbound webhooks that carry no verifiable authenticity at all.
   *
   * This bypass applies only when no trusted push registration exists and no
   * HMAC secret is configured. It never bypasses a failed RFC 9421 or HMAC
   * verification for a known registration.
   *
   * Set this only when the receiver is genuinely unreachable from outside your
   * network (in-process test harnesses, a route bound to loopback). It is not a
   * substitute for a secret on any route an agent can reach over the internet.
   *
   * @default false
   */
  allowUnauthenticatedWebhooks?: boolean;
  /**
   * Webhook URL template with macro substitution
   *
   * Available macros:
   * - {agent_id} - Agent ID
   * - {task_type} - Task type (e.g., sync_creatives, media_buy_delivery)
   * - {operation_id} - Operation ID
   *
   * @example
   * Path-based: "https://myapp.com/webhook/{task_type}/{agent_id}/{operation_id}"
   * Query string: "https://myapp.com/webhook?agent={agent_id}&op={operation_id}&type={task_type}"
   * Custom: "https://myapp.com/api/v1/adcp/{agent_id}?operation={operation_id}"
   */
  webhookUrlTemplate?: WebhookUrlTemplate;
  /**
   * Reporting webhook frequency
   *
   * @default 'daily'
   */
  reportingWebhookFrequency?: 'hourly' | 'daily' | 'monthly';
  /**
   * Validate that the seller supports required features before each task call.
   * When true, tasks like syncAudiences will fail fast with FeatureUnsupportedError
   * if the seller hasn't declared audience_targeting support.
   *
   * @default true
   */
  validateFeatures?: boolean;
  /** Require release compatibility and the declared idempotency replay TTL before mutations. */
  requireV3ForMutations?: boolean;
  /**
   * What to do when a request reaches a seller on an older AdCP release and
   * its account key uses fields that release cannot express. AdCP 3.2 added
   * `operator_unit`, `currency` and `timezone` to the account natural key and
   * `countries` to brand references; a 3.1 seller's key has none of them.
   *
   * - `'refuse'` (default): fail the call before it is sent with
   *   `ProtocolFeatureUnsupportedError`.
   * - `'reduce'`: send the older key when that is unambiguous, and refuse when
   *   it would merge accounts. Each reduced key is claimed for the one buyer
   *   key it came from (a key sent unreduced claims itself), and a second
   *   buyer key that would reach the same seller account fails with
   *   `account_identity_collision` before sending, so no two buyer accounts
   *   share one seller account. Each reduction is reported in `debug_logs` as
   *   an `account_identity_reduced` entry. Requires `accountStorage` with
   *   `compareAndSet`, so the claims hold across instances and restarts.
   *
   * The rule is proposed for the spec as adcontextprotocol/adcp DR-0032
   * (#8373); the default may change to `'reduce'` once it is ratified.
   *
   * @default 'refuse'
   */
  accountIdentityDowngrade?: AccountIdentityDowngrade;
  /**
   * Runtime schema validation options
   */
  validation?: {
    /**
     * Validate outgoing requests against the bundled AdCP JSON schema before
     * dispatch. Catches field-name drift at call-time instead of at
     * storyboard-time.
     *
     * - `strict`: throw `ValidationError` with a JSON Pointer to the bad field
     * - `warn`: log to debug logs and continue
     * - `off`: skip the validator entirely (no overhead)
     *
     * @default `strict` in dev/test, `warn` in production
     */
    requests?: import('../validation/client-hooks').ValidationMode;
    /**
     * Validate incoming responses against the bundled AdCP JSON schema.
     *
     * - `strict`: fail the task with `VALIDATION_ERROR`
     * - `warn`: log to debug logs and surface the task as successful
     * - `off`: skip the validator entirely
     *
     * Overrides `strictSchemaValidation` when set.
     *
     * @default `strict` in dev/test, `warn` in production
     */
    responses?: import('../validation/client-hooks').ValidationMode;
    /**
     * Legacy: fail tasks when response schema validation fails (default: true).
     * Superseded by `responses` above — retained for backward compat.
     * `false` maps to `responses: 'warn'` when `responses` isn't set.
     *
     * @default true
     */
    strictSchemaValidation?: boolean;
    /**
     * Emit schema validation violations to debug logs and the console (default: true).
     * Set false when violations are surfaced through another structured channel.
     *
     * @default true
     */
    logSchemaViolations?: boolean;
    /**
     * Filter out invalid products from get_products responses instead of rejecting the entire response (default: false)
     *
     * When true: Each product in a get_products response is validated individually.
     * Valid products are kept, invalid products are dropped, and the response is
     * returned as long as it passes full schema validation after filtering.
     * When false: The entire response is rejected if any product fails validation.
     *
     * Only applies to get_products — all other tool responses use standard validation.
     *
     * @default false
     */
    filterInvalidProducts?: boolean;
    /**
     * Reject products that arrive without a usable `pricing_options[]` array
     * from completed `get_products` responses (default: true).
     *
     * `pricing_options` is a required, non-empty field in AdCP 3.1 — a product
     * that advertises no pricing model is non-transactable, so the SDK drops it
     * from the product list before callers and completion handlers see it. This
     * runs on every completion path (sync, polling, `track`, webhook) and is
     * independent of the response `validation` mode, so unpriced products are
     * removed even under `responses: 'warn' | 'off'`. The rejection is recorded
     * in `result.metadata.productPricingPolicy` and a
     * `product_missing_pricing_options` debug-log notice.
     *
     * Set to `false` to pass products through untouched (e.g. when the caller
     * deliberately inspects malformed seller responses).
     *
     * @default true
     */
    rejectProductsWithoutPricingOptions?: boolean;
    /**
     * Buyer-side property policy applied to completed `get_products`
     * responses before completion handlers and callers receive the product
     * list. A request-level `property_list` is enforced automatically by
     * default; set this to `false` only when the caller deliberately wants to
     * trust seller-side filtering without SDK verification.
     *
     * Use this for brand/block-list rules such as excluding `ladbible.com`;
     * domain matching normalizes `www.` aliases, so `www.ladbible.com`
     * violates an exclusion for `ladbible.com`.
     */
    productPropertyPolicy?: ClientProductPropertyPolicy | false;
    /** Opt in to computed, evidence-bearing external collection path annotations on product discovery. */
    supplyPathVerification?: ProductSupplyPathOptions;
  };
  /** Governance configuration for buyer-side campaign governance */
  governance?: import('./GovernanceTypes').GovernanceConfig;
  /**
   * Transport-level safeguards. Applies to every call this client dispatches
   * unless overridden at call time.
   *
   * `maxResponseBytes` defaults to 4 MiB on every call; raise it for an agent
   * that legitimately publishes a large catalog, lower it when crawling
   * untrusted agents (registries, federated discovery layers), or set it to
   * exactly `0` to opt out of the cap entirely. A per-call `transport`
   * replaces this object wholesale rather than merging into it. Set
   * `requestTimeoutMs` to override the default 60s cap on A2A agent-card
   * discovery; use `0` to disable the SDK-imposed discovery timeout.
   */
  transport?: import('../protocols').TransportOptions;
}

/** Client-bound scope token for reusing externally observed capabilities. */
export interface CapabilityEvidenceScope {
  /** Exact normalized seller endpoint owned by this client. */
  agentUri: string;
  /** Exact AdCP release pin configured on this client. */
  adcpVersion: string;
  /** Opaque per-client token binding evidence to this authorization/transport instance. */
  scopeKey: string;
}

/** Fresh, scoped capability evidence produced by an application-owned preflight. */
export interface CapabilityEvidenceSnapshot {
  scope: CapabilityEvidenceScope;
  capabilities: AdcpCapabilities;
  /** RFC 3339 timestamp when the application observed the evidence. */
  observedAt: string;
  /** RFC 3339 freshness deadline. Expired evidence is refused. */
  expiresAt: string;
  /** `tools/list` input-schema properties keyed by tool name; optional when capabilities already carry discoveredTools. */
  toolSchemas?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/** Capability evidence to pre-seed into a shared `discoveryCache`. */
export interface AgentDiscoverySeed {
  /** Authoritative capabilities (never synthetic). */
  capabilities: AdcpCapabilities;
  /** `tools/list` input-schema properties keyed by tool name; optional when capabilities carry discoveredTools. */
  toolSchemas?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /**
   * The MCP endpoint serving this agent, to skip endpoint probing. Must be a
   * credential-free URL on the configured agent's origin, without query or fragment.
   */
  endpoint?: { agentUri: string; mcpEra?: 'legacy' | 'modern' };
}

// Per shared cache and key: the latest invalidation in this process. `epoch`
// (unique, never reused) lets an older in-flight discovery or local evidence
// notice it was dropped; `at` is a tombstone, so an entry observed before it is
// a miss even when the backend delete failed or is still queued. Bounded: records
// older than any entry could live, and the oldest beyond the cap, are forgotten,
// but only into a per-cache floor (the largest forgotten epoch and time) that
// every key inherits: held epochs and entries older than a forgotten invalidation
// then miss, so forgetting can only cost a rediscovery, never resurrect stale
// evidence. Best effort across processes: a distributed backend is not made atomic.
interface SharedInvalidation {
  epoch: number;
  at: number;
}
const sharedInvalidations = new WeakMap<object, Map<string, SharedInvalidation>>();
const sharedInvalidationFloors = new WeakMap<object, SharedInvalidation>();
let sharedInvalidationCounter = 0;
const MAX_SHARED_INVALIDATION_RECORDS = 1024;

// Per shared cache and key: in-process queue of backend mutations. Bounded so a
// backend that never answers cannot make the queues grow without limit.
interface SharedMutationQueue {
  tail: Promise<void>;
  pending: number;
  /** Latest queued delete that has not started; a newer invalidation joins it. */
  waitingDelete?: { promise: Promise<unknown>; started: boolean };
}
const sharedMutationChains = new WeakMap<object, Map<string, SharedMutationQueue>>();
const MAX_PENDING_SHARED_MUTATIONS_PER_KEY = 16;
const MAX_SHARED_MUTATION_KEYS = 1024;

// In-process singleflight of live discovery per shared cache and key.
const sharedDiscoveryFlights = new WeakMap<object, Map<string, Promise<void>>>();
const MAX_SHARED_DISCOVERY_WAITS = 3;
// Backend deadline for each shared-cache get/set/delete.
const SHARED_DISCOVERY_CACHE_TIMEOUT_MS = 2_000;
// Tolerated disagreement between hosts' clocks when judging an entry's age.
const SHARED_DISCOVERY_CLOCK_SKEW_MS = 5_000;

// Seller errors that say the capabilities, version or tool surface we cached have changed.
const CAPABILITY_STALE_ERROR_CODES: ReadonlySet<string> = new Set([
  'VERSION_UNSUPPORTED',
  'UNSUPPORTED_FEATURE',
  'FEATURE_UNSUPPORTED',
  'TOOL_NOT_FOUND',
  'METHOD_NOT_FOUND',
  'UNKNOWN_TOOL',
]);

/** A plain `{ toolName: { ...inputSchema.properties } }` record; arrays are rejected at both levels. */
function isToolSchemaRecord(value: unknown): value is Record<string, Record<string, unknown>> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(
      properties => typeof properties === 'object' && properties !== null && !Array.isArray(properties)
    )
  );
}

function isCapabilityEvidence(value: unknown): value is AdcpCapabilities {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<AdcpCapabilities>;
  return (
    candidate.version === 'v3' &&
    Array.isArray(candidate.majorVersions) &&
    candidate.majorVersions.includes(3) &&
    candidate.majorVersions.every(version => Number.isSafeInteger(version) && version > 0) &&
    Array.isArray(candidate.protocols) &&
    candidate.protocols.every(protocol => typeof protocol === 'string') &&
    typeof candidate.features === 'object' &&
    candidate.features !== null &&
    !Array.isArray(candidate.features) &&
    Array.isArray(candidate.extensions) &&
    candidate.extensions.every(extension => typeof extension === 'string') &&
    typeof candidate._synthetic === 'boolean'
  );
}

function productHasPricingOptions(product: unknown): boolean {
  if (!product || typeof product !== 'object') return false;
  const options = (product as { pricing_options?: unknown }).pricing_options;
  return Array.isArray(options) && options.length > 0;
}

function productIdForPricingDiagnostics(product: unknown): string | undefined {
  if (!product || typeof product !== 'object') return undefined;
  const id = (product as { product_id?: unknown }).product_id;
  return typeof id === 'string' ? id : undefined;
}

function propertyListReferenceFromRequest(params: Record<string, unknown>): PropertyListReference | undefined {
  const filters = params.filters;
  const nested =
    filters &&
    typeof filters === 'object' &&
    !Array.isArray(filters) &&
    Object.hasOwn(filters, 'property_list') &&
    (filters as Record<string, unknown>).property_list !== undefined;
  const value = nested ? (filters as Record<string, unknown>).property_list : params.property_list;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const ref = value as Partial<PropertyListReference>;
  if (typeof ref.agent_url !== 'string' || typeof ref.list_id !== 'string') return undefined;
  return {
    agent_url: ref.agent_url,
    list_id: ref.list_id,
    ...(typeof ref.auth_token === 'string' ? { auth_token: ref.auth_token } : {}),
  };
}

function productPolicyRequestSnapshot(requestParams: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const account = canonicalAccountRoutingSnapshot(requestParams.account);
  const propertyList = propertyListReferenceFromRequest(requestParams);
  const referenceError = propertyListReferenceError(requestParams);
  return Object.freeze({
    ...(account ? { account } : {}),
    ...(propertyList ? { property_list: Object.freeze(propertyList) } : {}),
    ...(referenceError ? { property_list_error: referenceError } : {}),
  });
}

function propertyListReferenceError(params: Record<string, unknown>): string | undefined {
  if (typeof params.property_list_error === 'string') return params.property_list_error;
  const filters = params.filters;
  if (params.property_list !== undefined && !propertyListReferenceFromRequest({ property_list: params.property_list }))
    return 'property_list_invalid_reference';
  if (
    !filters ||
    typeof filters !== 'object' ||
    Array.isArray(filters) ||
    !Object.hasOwn(filters, 'property_list') ||
    (filters as Record<string, unknown>).property_list === undefined
  )
    return undefined;
  const nested = propertyListReferenceFromRequest(params);
  if (!nested) return 'property_list_invalid_reference';
  if (params.property_list !== undefined) {
    const legacy = propertyListReferenceFromRequest({ property_list: params.property_list });
    if (
      !legacy ||
      nested.agent_url !== legacy.agent_url ||
      nested.list_id !== legacy.list_id ||
      nested.auth_token !== legacy.auth_token
    ) {
      return 'property_list_conflicting_references';
    }
  }
  return undefined;
}

function hasProductPropertyPolicyRules(policy: BuyerPropertyPolicy): boolean {
  return Boolean(
    policy.allowedDomains?.length ||
    policy.allowedPropertyIdentifiers?.length ||
    policy.requireAllowedPropertyMatch ||
    policy.excludedDomains?.length ||
    policy.excludedPropertyIds?.length ||
    policy.strict ||
    policy.unknownSelectorBehavior ||
    policy.missingPublisherPropertiesBehavior
  );
}

function unsupportedPropertyIdentifiers(
  identifiers: readonly { type: string; value: string }[]
): Array<{ type: string }> {
  return identifiers
    .filter(identifier => !isSupportedPropertyIdentifierType(identifier.type))
    .map(identifier => ({ type: identifier.type }));
}

function sanitizeDiagnosticUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return 'invalid_url';
  }
}

function propertyListResolutionErrorCode(err: unknown): string {
  const message = err instanceof Error ? err.message : '';
  if (/^property_list_[a-z_]+$/.test(message)) return message;
  if (/^list_agent_url_[a-z_]+$/.test(message)) return message;
  return 'property_list_resolution_failed';
}

export class SingleAgentClient {
  private _accounts?: BuyerAccountRegistry;
  private accountRegistryExplicitlyAccessed = false;
  private initialOAuthGrantMaterial?: string;
  private accountCredentialMaterial?: string;
  private accountCredentialScope?: string;

  private credentialScope(material: string): string {
    if (this.accountCredentialMaterial !== material) {
      this.accountCredentialScope = scryptSync(material, 'adcp-sdk/account-registry-scope/v1', 32).toString('hex');
      this.accountCredentialMaterial = material;
    }
    return this.accountCredentialScope!;
  }

  private accountScope(): string {
    const agent = this.normalizedAgent ?? this.agent;
    const cc = agent.oauth_client_credentials;
    if (!cc && agent.oauth_tokens && !this.initialOAuthGrantMaterial)
      this.initialOAuthGrantMaterial = JSON.stringify(agent.oauth_tokens);
    const oauthIdentity = cc
      ? { client_id: cc.client_id, token_endpoint: cc.token_endpoint, scope: cc.scope, resource: cc.resource }
      : this.initialOAuthGrantMaterial;
    const signing = agent.request_signing;
    const signingIdentity = signing
      ? signing.kind === 'provider'
        ? {
            keyid: signing.provider.keyid,
            algorithm: signing.provider.algorithm,
            fingerprint: signing.provider.fingerprint,
            purpose: signing.provider.adcpUse,
          }
        : { keyid: signing.kid, algorithm: signing.alg, key: signing.private_key }
      : undefined;
    const credential =
      this.config.accountRegistryScope ??
      this.credentialScope(
        JSON.stringify({
          token: agent.auth_token,
          oauth: oauthIdentity,
          oauthClient: agent.oauth_client?.client_id,
          oauthResource: agent.oauth_resource,
          headers: agent.headers,
          signing: signingIdentity,
        })
      );
    return JSON.stringify([this.agent.agent_uri, this.agent.protocol, credential]);
  }

  get accounts(): BuyerAccountRegistry {
    this.accountRegistryExplicitlyAccessed = true;
    return this.getAccountRegistry();
  }

  private getAccountRegistry(): BuyerAccountRegistry {
    return (this._accounts ??= new BuyerAccountRegistry(
      () => this.accountScope(),
      async (account, options, taskOptions, dispatch) => {
        const caps = await this.getCapabilities(taskOptions);
        const supported = caps.account?.supportedBilling ?? [];
        const billing =
          options.billing ?? caps.account?.defaultBilling ?? (supported.length === 1 ? supported[0] : undefined);
        if (!billing || (supported.length && !supported.includes(billing))) {
          throw new AccountRequiredError(
            'implicit',
            'sync_accounts',
            'Choose a supported billing party before provisioning.'
          );
        }
        return this.syncAccounts(
          {
            ...(dispatch && { idempotency_key: dispatch.idempotencyKey }),
            accounts: [
              {
                ...account,
                billing,
                ...(options.paymentTerms !== undefined && { payment_terms: options.paymentTerms }),
                ...(options.billingEntity !== undefined && { billing_entity: options.billingEntity }),
              },
            ],
          } as MutatingRequestInput<SyncAccountsRequest>,
          undefined,
          { ...taskOptions, [SKIP_ACCOUNT_REGISTRY_OBSERVATION]: true } as TaskOptions,
          dispatch
        );
      },
      this.config.accountStorage,
      async (accountId, options) => {
        const rows: ListAccountsResponse['accounts'] = [];
        const cursors = new Set<string>();
        let cursor: string | undefined;
        for (let page = 0; page < 100; page++) {
          const result = await this.listAccounts(
            { account: { account_id: accountId }, ...(cursor && { pagination: { cursor } }) },
            undefined,
            { ...childTaskOptions(options), [SKIP_ACCOUNT_REGISTRY_OBSERVATION]: true } as TaskOptions
          );
          if (!result.success || result.status !== 'completed' || !result.data || !('accounts' in result.data))
            throw new Error('Account status reconciliation failed.');
          rows.push(...result.data.accounts);
          if (rows.some(row => row.account_id === accountId) || !result.data.pagination?.has_more)
            return rows.filter(row => row.account_id === accountId);
          const next = result.data.pagination.cursor;
          if (!next || cursors.has(next)) break;
          cursors.add(next);
          cursor = next;
        }
        throw new Error('Account status reconciliation could not complete pagination.');
      },
      {
        ...this.config.accountRegistryOptions,
        provisionOwnsDispatchBoundary: true,
        maxEntries: this.config.accountRegistryMaxEntries,
        evictAtCapacity: () => !this.accountRegistryOptedIn(),
        normalizeOptions: async (options, taskOptions) => {
          if (options.billing) return options;
          const caps = await this.getCapabilities(taskOptions);
          const supported = caps.account?.supportedBilling ?? [];
          const billing = caps.account?.defaultBilling ?? (supported.length === 1 ? supported[0] : undefined);
          return { ...options, ...(billing && { billing }) };
        },
      }
    ));
  }

  /**
   * The memoized registry backs `resolveAccount()` only when the caller opts
   * in with an account policy or registry configuration. Otherwise
   * `resolveAccount()` keeps the SDK 14.0 sync-on-every-call behavior.
   */
  private accountRegistryOptedIn(): boolean {
    return (
      (this.config.accountPolicy ?? 'off') !== 'off' ||
      this.config.accountStorage !== undefined ||
      this.config.accountRegistryScope !== undefined ||
      this.config.accountRegistryMaxEntries !== undefined ||
      this.config.accountRegistryOptions !== undefined
    );
  }

  private accountRegistryContext(
    task: string,
    params: any,
    options?: TaskOptions
  ): DeferredClientFinalizationContext['accountRegistry'] {
    const knownOnly =
      !this.accountRegistryExplicitlyAccessed &&
      (this.config.accountPolicy ?? 'off') === 'off' &&
      !this.config.accountStorage;
    if (knownOnly && !this._accounts) return undefined;
    if (
      (options as TaskOptions & { [SKIP_ACCOUNT_REGISTRY_OBSERVATION]?: boolean })?.[SKIP_ACCOUNT_REGISTRY_OBSERVATION]
    )
      return undefined;
    if (task !== 'sync_accounts' && task !== 'list_accounts') return undefined;
    return {
      scope: this.accountScope(),
      ...(knownOnly && { knownOnly: true }),
      observationEpoch: this.getAccountRegistry().captureObservation(),
      ...(task === 'list_accounts' && params.account && { refs: [params.account] }),
      ...(task === 'sync_accounts' && {
        refs: Array.isArray(params.accounts)
          ? params.accounts.flatMap((value: unknown) => {
              const ref = canonicalAccountRoutingSnapshot(value);
              return ref ? [ref as AccountReference] : [];
            })
          : [],
        dryRun: params.dry_run === true,
      }),
    };
  }

  private usesStableAccountIds(capabilities: AdcpCapabilities): boolean {
    if (capabilities._synthetic) return false;
    return (
      capabilities.account?.stableAccountId === true ||
      (isAdcpVersionAtLeast(this.config.wireAdcpVersion ?? this.resolvedAdcpVersion, '4.0.0') &&
        (isAdcpVersionAtLeast(capabilities.servedVersion, '4.0.0') ||
          (!capabilities.servedVersion &&
            capabilities.supportedVersions?.some(version => isAdcpVersionAtLeast(version, '4.0.0')) === true)))
    );
  }

  private accountWireReference(
    account: AccountReference,
    accountId: string | undefined,
    capabilities: AdcpCapabilities
  ): AccountReference {
    if (
      'account_id' in account ||
      this.config.accountReferenceMode === 'natural-key' ||
      !this.usesStableAccountIds(capabilities)
    )
      return account;
    if (!accountId)
      throw new AccountSetupRequiredError(
        'The seller declares stable account IDs but did not return an account_id. Reconcile with syncAccounts.'
      );
    return { account_id: accountId };
  }

  private async applyAccountPolicy(task: string, params: any, options?: TaskOptions): Promise<any> {
    const policy = this.config.accountPolicy ?? 'off';
    const ref =
      params?.account ?? (typeof params?.account_id === 'string' ? { account_id: params.account_id } : undefined);
    if (
      options?.skipAccountValidation ||
      options?.preserveGovernedPayload ||
      task === 'list_accounts' ||
      task === 'sync_accounts'
    )
      return params;
    if (!ref) {
      if (
        policy === 'strict' &&
        ['get_products', 'list_products'].includes(task) &&
        this.usesStableAccountIds(await this.getCapabilities(options))
      )
        throw new AccountNotProvisionedError(undefined, task);
      return params;
    }
    if (policy === 'off' && !this._accounts) return params;
    if (
      typeof ref !== 'object' ||
      ref === null ||
      (!('account_id' in ref) && (typeof ref.brand?.domain !== 'string' || typeof ref.operator !== 'string'))
    )
      return params; // Let normal request validation report malformed references.
    const registry = this.getAccountRegistry();
    let known = await registry.get(ref);
    let capabilities: AdcpCapabilities | undefined;
    if (
      known &&
      !['unknown', 'provisioning', 'failed_provisioning'].includes(known.status) &&
      !('account_id' in ref) &&
      this.config.accountReferenceMode !== 'natural-key'
    ) {
      const scope = this.accountScope();
      capabilities = await this.getCapabilities(options);
      if (scope !== this.accountScope()) throw new AccountNotProvisionedError(ref, task);
      // Capability discovery may await transport I/O. Recheck status and binding
      // so a concurrent repair or explicit sync cannot inject an obsolete ID.
      known = await registry.get(ref);
      if (scope !== this.accountScope()) throw new AccountNotProvisionedError(ref, task);
    }
    if (known && !['unknown', 'provisioning', 'failed_provisioning'].includes(known.status)) {
      const commitsSpend = [
        'create_media_buy',
        'buy_products',
        'accept_proposal',
        'activate_signal',
        'acquire_rights',
      ].includes(task);
      // Payment-required accounts can still manage creatives for existing buys.
      const allowedStatuses = task === 'sync_creatives' ? ['active', 'payment_required'] : ['active'];
      if (policy !== 'off' && (commitsSpend || task === 'sync_creatives') && !allowedStatuses.includes(known.status)) {
        if (known.status === 'pending_approval') throw new AccountPendingApprovalError(ref, known.account_id);
        if (known.status === 'payment_required') throw new AccountPaymentRequiredError();
        throw new AccountSetupRequiredError(
          `Account status is ${known.status}. Refresh it with client.accounts.applyStatusChange or complete seller setup.`
        );
      }
      if (capabilities) {
        const account = this.accountWireReference(ref, known.account_id, capabilities);
        if (account !== ref) return { ...params, account };
      }
      return params;
    }
    if (policy === 'off') return params;
    if (
      policy === 'strict' ||
      ![
        'get_products',
        'list_products',
        'get_signals',
        'request_proposals',
        'refine_proposals',
        'decline_proposals',
      ].includes(task)
    ) {
      throw new AccountNotProvisionedError(ref, task);
    }
    const caps = await this.getCapabilities(options);
    if (
      caps._synthetic ||
      (['get_products', 'list_products'].includes(task) && caps.account?.requiredForProducts) ||
      params.push_notification_config ||
      !schemaAllowsTopLevelField(task, 'brand')
    ) {
      throw new AccountNotProvisionedError(ref, task);
    }
    if (!('brand' in ref)) throw new AccountNotProvisionedError(ref, task);
    const { account, ...publicRequest } = params;
    return { ...publicRequest, brand: params.brand ?? ref.brand };
  }

  private executor!: TaskExecutor;
  private asyncHandler?: AsyncHandler;
  private normalizedAgent!: InternalAgentConfig;
  private discoveredEndpoint?: string; // Cache discovered MCP endpoint
  private discoveredAgent?: AgentConfig; // Stable post-discovery config for protocol/provider caches
  private discoveredMcpEra?: 'legacy' | 'modern';
  private discoveredMcpEraAt = 0;
  private canonicalBaseUrl?: string; // Cache canonical base URL (from agent card or stripped /mcp)
  private cachedCapabilities?: AdcpCapabilities; // Cache detected server capabilities
  private runAgentInfo?: Awaited<ReturnType<SingleAgentClient['getAgentInfo']>>;
  private cachedToolSchemas?: Map<string, Record<string, unknown>>; // inputSchema.properties per tool name
  /** Release negotiated per operation, for converting webhook completions up. */
  private readonly negotiatedReleaseByOperation = new Map<string, string>();
  private primedCapabilitiesExpiresAt?: number; // Freshness bound for application-owned evidence only
  private capabilityEvidenceScopeKey = randomUUID();
  private capabilityEvidenceAuthMaterial?: string;
  private capabilitiesFromSharedCache = false; // Installed from config.discoveryCache rather than discovered live
  private discoveryEpoch = 0; // bumped by invalidation so an older in-flight discovery cannot re-install what was dropped
  private discoveredEndpointKey?: string; // discoveryCache key the local endpoint was obtained under
  private discoveredEndpointEpoch?: number; // shared invalidation epoch of that key when the endpoint was obtained
  private discoveredEndpointExpiresAt?: number; // freshness bound for that endpoint (shared-cache mode only)
  private sharedEvidenceEpoch?: number; // shared invalidation epoch of that key when the evidence was obtained
  private sharedEvidenceKey?: string; // discoveryCache key the local capability cache was obtained under
  private _syntheticV3WarningFired = false; // Gate: emit the synthetic-v3 warning once per client instance
  private readonly productPolicyRequestParamsByTask = new Map<string, ProductPolicyRequestState>();
  private readonly canonicalCreativeTaskAssociations = new Map<string, CanonicalCreativeTaskAssociation>();
  private readonly previewCreativeHandlersByTask = new Map<string, 'canonical' | 'legacy'>();
  private readonly canonicalLegacyRoutes = new Map<string, CanonicalLegacyRoute>();
  private readonly resolvedAdcpVersion!: string;
  private readonly webhookRegistrationStore!: WebhookRegistrationStore;
  private readonly webhookReplayStore!: ReplayStore;
  private readonly webhookRevocationStore!: RevocationStore;
  private readonly webhookJwksResolvers = new Map<string, JwksResolver>();
  private readonly durableSettlementRecoverers = new Set<
    (
      operationId: string,
      observation: ExternalTaskSettlementObservation
    ) => Promise<ExternalTaskStatusResult | undefined>
  >();
  private readonly durableDeferredResumeAuthorizers = new Set<
    (operationId: string, token: string) => boolean | undefined | Promise<boolean | undefined>
  >();
  private readonly durableDeferredOperationRecoveryAuthorizers = new Set<
    (
      operationId: string,
      recoveryKey: string,
      purpose: 'pause-recovery' | 'callback-checkpoint'
    ) => boolean | undefined | Promise<boolean | undefined>
  >();
  private readonly durableDeferredResumeTokenReplacers = new Set<
    (
      operationId: string,
      currentToken: string,
      replacementToken: string
    ) => boolean | undefined | Promise<boolean | undefined>
  >();

  constructor(
    private agent: AgentConfig,
    private config: SingleAgentClientConfig = {}
  ) {
    if ((config.experimentalIdentity33 === true) !== isIdentity33SchemaScope())
      return withIdentity33SchemaScope(() => {
        const instance = Reflect.construct(SingleAgentClient, [agent, config], new.target) as SingleAgentClient;
        return config.experimentalIdentity33 ? bindIdentity33SchemaScope(instance) : instance;
      }, config.experimentalIdentity33 === true);
    // Own the nested trust-boundary object at construction. Normalization
    // historically returns the input object unchanged for the preferred
    // `trustedFetchFn` spelling, so clone first while retaining function identity.
    const configuredTransport = config.transport === undefined ? undefined : { ...config.transport };
    const configuredWebhookVerification =
      config.webhookVerification === undefined
        ? undefined
        : {
            ...config.webhookVerification,
            ...(config.webhookVerification.resolverOptions !== undefined && {
              resolverOptions: { ...config.webhookVerification.resolverOptions },
            }),
          };
    this.config = {
      ...config,
      transport: normalizeTransportOptions(configuredTransport),
      ...(configuredWebhookVerification !== undefined && { webhookVerification: configuredWebhookVerification }),
    };
    config = this.config;
    validateAgentDiscoveryCacheConfig(config.discoveryCache);
    // Validate the configured adcpVersion at construction time. Throws
    // ConfigurationError if the pin's major differs from ADCP_MAJOR_VERSION
    // — cross-major support lands in Stage 3 of the multi-version refactor.
    this.resolvedAdcpVersion = resolveAdcpVersion(
      config.adcpVersion ?? (config.experimentalIdentity33 ? '3.3' : undefined)
    );
    if (config.accountIdentityDowngrade === 'reduce' && typeof config.accountStorage?.compareAndSet !== 'function') {
      // The no-merge guarantee is a claim on a reduced key that every
      // instance of this buyer must see; without an atomic store, two
      // instances (or a restart) can each claim a different buyer key for
      // the same seller account.
      throw new ConfigurationError(
        "accountIdentityDowngrade: 'reduce' requires accountStorage with compareAndSet. Reduced account keys are " +
          'claimed in that storage so that no two buyer accounts reach one seller account, across instances and ' +
          "restarts. Configure durable accountStorage that implements compareAndSet, or use 'refuse'.",
        'accountIdentityDowngrade'
      );
    }
    this.webhookRegistrationStore = config.webhookRegistrationStore ?? new InMemoryWebhookRegistrationStore();
    this.webhookReplayStore = config.webhookVerification?.replayStore ?? new InMemoryReplayStore();
    this.webhookRevocationStore = config.webhookVerification?.revocationStore ?? new InMemoryRevocationStore();
    const registrationTtl = config.webhookRegistrationTtlSeconds ?? 7 * 24 * 60 * 60;
    if (!Number.isSafeInteger(registrationTtl) || registrationTtl < 1) {
      throw new ConfigurationError('webhookRegistrationTtlSeconds must be a positive safe integer.');
    }

    // Inject userAgent into agent headers so it flows through both MCP and A2A transports
    if (config.userAgent) {
      validateUserAgent(config.userAgent);
      this.agent = {
        ...this.agent,
        headers: { 'User-Agent': config.userAgent, ...this.agent.headers },
      };
    }

    // Normalize agent URL for MCP protocol
    this.normalizedAgent = this.normalizeAgentConfig(this.agent);
    // Pin this client's configured OAuth grant, retaining caller isolation across automatic token refreshes.
    if (this.normalizedAgent.oauth_tokens && !this.normalizedAgent.oauth_client_credentials)
      this.initialOAuthGrantMaterial = JSON.stringify(this.normalizedAgent.oauth_tokens);
    this.capabilityEvidenceAuthMaterial = this.currentCapabilityEvidenceAuthMaterial();

    this.executor = new TaskExecutor({
      workingTimeout: config.workingTimeout || 120000, // Max 120s for working status
      defaultMaxClarifications: config.defaultMaxClarifications || 3,
      enableConversationStorage: config.persistConversations !== false,
      deferredStorage: config.deferredStorage,
      resolveDeferredAgent:
        config.resolveDeferredAgent ??
        (async agentId => {
          if (agentId !== this.normalizedAgent.id) return undefined;
          return this.normalizedAgent.protocol === 'a2a'
            ? this.ensureCanonicalUrlResolved()
            : this.ensureEndpointDiscovered();
        }),
      deferredTaskTtlSeconds: config.deferredTaskTtlSeconds,
      canRecoverDeferredSettlement: () => this.durableSettlementRecoverers.size > 0,
      authorizeDeferredSettlementResume: async (operationId, token) => {
        for (const authorize of this.durableDeferredResumeAuthorizers) {
          if ((await authorize(operationId, token)) === true) return true;
        }
        return false;
      },
      authorizeDeferredSettlementOperationRecovery: async (operationId, recoveryKey, purpose) => {
        for (const authorize of this.durableDeferredOperationRecoveryAuthorizers) {
          if ((await authorize(operationId, recoveryKey, purpose)) === true) return true;
        }
        return false;
      },
      replaceDeferredSettlementResumeToken: async (operationId, currentToken, replacementToken) => {
        for (const replace of this.durableDeferredResumeTokenReplacers) {
          if ((await replace(operationId, currentToken, replacementToken)) === true) return true;
        }
        return false;
      },
      recoverDeferredSettlement: async (result, operationId, serverTaskId) => {
        const settlement = await this.wrapPersistedDeferredSettlement(result, operationId, serverTaskId);
        return {
          result: settlement.result,
          ...(settlement.afterDispatch !== undefined && { afterFinalize: settlement.afterDispatch }),
        };
      },
      webhookUrlTemplate: config.webhookUrlTemplate,
      agentId: agent.id,
      webhookSecret: config.webhookSecret,
      identity33SchemaExperiment: config.experimentalIdentity33,
      experimentalIdentity33: () => this.config.experimentalIdentity33 === true && this.usesIdentity33Schemas(),
      signedIdentity33Webhooks: () => this.usesSigned33Webhooks(),
      webhookSigningProfile: () => this.selectedWebhookSigningProfile(),
      onWebhookRegistration: registration => this.persistWebhookRegistration(registration),
      onDurableSettlementRequired: operationId => this.markWebhookDurableSettlementRequired(operationId),
      externalTaskSettlementRetentionMs: registrationTtl * 1000,
      strictSchemaValidation: config.validation?.strictSchemaValidation !== false, // Default: true
      logSchemaViolations: config.validation?.logSchemaViolations !== false, // Default: true
      filterInvalidProducts: config.validation?.filterInvalidProducts === true, // Default: false
      validation: {
        ...(config.validation?.requests != null && { requests: config.validation.requests }),
        ...(config.validation?.responses != null && { responses: config.validation.responses }),
      },
      onActivity: config.onActivity ? activity => config.onActivity!(canonicalCreativeActivity(activity)) : undefined,
      onTransportActivity: config.onTransportActivity
        ? event => config.onTransportActivity!(canonicalCreativeTransportActivity(event))
        : undefined,
      governance: config.governance,
      adcpVersion: this.resolvedAdcpVersion,
      ...(config.wireAdcpVersion !== undefined && { wireAdcpVersion: config.wireAdcpVersion }),
      ...(config.versionEnvelope !== undefined && { versionEnvelope: config.versionEnvelope }),
      transport: config.transport,
    });

    // Create async handler if handlers are provided
    if (config.handlers) {
      this.asyncHandler = new AsyncHandler(config.handlers);
    }
  }

  private async persistWebhookRegistration(args: {
    agent: AgentConfig;
    taskType: string;
    operationId: string;
    callbackUrl: string;
    mode: WebhookRegistration['mode'];
    signingProfile?: WebhookRegistration['signingProfile'];
    deliveryKind?: WebhookRegistration['deliveryKind'];
    delegatedOperatorAuthorization?: DelegatedOperatorAuthorizationContext;
  }): Promise<void> {
    const nowMs = this.config.webhookVerification?.now
      ? Math.floor(this.config.webhookVerification.now() * 1000)
      : Date.now();
    const ttlSeconds = this.config.webhookRegistrationTtlSeconds ?? 7 * 24 * 60 * 60;
    const activeCreativeExecution = canonicalCreativeExecutionStorage.getStore();
    const previewMode =
      args.taskType === 'preview_creative' && activeCreativeExecution?.taskType === args.taskType
        ? activeCreativeExecution.canonical
          ? 'canonical'
          : 'legacy'
        : undefined;
    // Keep an operation-scoped fallback before awaiting durable persistence.
    // This preserves preview callback identity for immediate HMAC callbacks and
    // for the legacy HMAC compatibility path when the registration store is
    // temporarily unavailable.
    if (previewMode) {
      this.rememberPreviewCreativeHandlerKey(args.operationId, previewMode);
      if (previewMode === 'canonical') {
        this.rememberCanonicalCreativeTaskAssociation(args.operationId, args.taskType);
      } else {
        this.canonicalCreativeTaskAssociations.delete(args.operationId);
      }
    }
    const persistedAgentUrl = new URL(args.agent.agent_uri);
    persistedAgentUrl.username = '';
    persistedAgentUrl.password = '';
    persistedAgentUrl.hash = '';
    const delegatedOperatorAuthorization = args.deliveryKind
      ? undefined
      : this.effectiveDelegatedOperatorAuthorization(args.delegatedOperatorAuthorization);
    const registration: WebhookRegistration = {
      agentId: args.agent.id,
      agentUrl: persistedAgentUrl.toString(),
      protocol: args.agent.protocol,
      operationId: args.operationId,
      taskType: args.taskType,
      callbackUrl: args.deliveryKind ? canonicalTargetUri(args.callbackUrl, '3.2') : args.callbackUrl,
      method: 'POST',
      mode: args.mode,
      ...(args.signingProfile && { signingProfile: args.signingProfile }),
      ...(args.deliveryKind && { deliveryKind: args.deliveryKind }),
      authorizationContextVersion: 1,
      ...(delegatedOperatorAuthorization !== undefined && { delegatedOperatorAuthorization }),
      ...(previewMode && { previewMode }),
      createdAt: nowMs,
      expiresAt: nowMs + ttlSeconds * 1000,
    };
    validateWebhookRegistrationAuthorization(registration);
    try {
      if (args.deliveryKind) {
        const previous = await this.webhookRegistrationStore.get(args.agent.id, args.operationId);
        if (
          previous &&
          previous.expiresAt > nowMs &&
          (previous.signingProfile ?? 'adcp/webhook-signing/v1') !==
            (registration.signingProfile ?? 'adcp/webhook-signing/v1')
        )
          throw new ConfigurationError(
            `${args.deliveryKind} callback is already registered with ${previous.signingProfile ?? 'adcp/webhook-signing/v1'}. Use a new callback URL or delete its old registration after outstanding deliveries finish.`,
            `${args.deliveryKind}_webhook.signing_profile`
          );
      }
      await this.webhookRegistrationStore.putIfAbsent(registration);
      const persisted = await this.webhookRegistrationStore.get(args.agent.id, args.operationId);
      if (
        !persisted ||
        !sameWebhookRegistration(
          parseWebhookRegistration(persisted, { agentId: args.agent.id, operationId: args.operationId }),
          registration
        ) ||
        persisted.authorizationContextVersion !== 1
      ) {
        throw new Error(
          'Webhook registration store did not preserve the versioned delegated-operator authorization context.'
        );
      }
    } catch (cause) {
      if (
        args.deliveryKind &&
        cause instanceof ConfigurationError &&
        cause.configField === `${args.deliveryKind}_webhook.signing_profile`
      )
        throw cause;
      // RFC 9421 has no safe fallback without seller-pinned provenance. Legacy
      // HMAC remains verifiable from the configured global secret only for the
      // explicit recordless read-only allowlist. Mutation and unknown-task
      // receivers require registration provenance, so dispatch must fail too.
      if (args.mode === 'rfc9421' || !RECORDLESS_HMAC_READ_ONLY_TASKS.has(args.taskType)) {
        const error = new ConfigurationError('Could not persist trusted webhook registration for this operation.');
        Object.defineProperty(error, 'cause', { value: cause, configurable: true });
        throw error;
      }
    }
  }

  private configuredDelegatedOperatorAuthorization(): DelegatedOperatorAuthorizationContext | undefined {
    const options = this.config.webhookVerification?.resolverOptions;
    if (!options) return undefined;
    const context: DelegatedOperatorAuthorizationContext = {
      ...(options.requiredOperatorBrand !== undefined && { brand: options.requiredOperatorBrand }),
      ...(options.requiredOperatorScope !== undefined && { scope: options.requiredOperatorScope }),
      ...(options.requiredOperatorCountry !== undefined && { country: options.requiredOperatorCountry }),
    };
    return Object.keys(context).length > 0 ? context : undefined;
  }

  private effectiveDelegatedOperatorAuthorization(
    perCall: DelegatedOperatorAuthorizationContext | undefined
  ): DelegatedOperatorAuthorizationContext | undefined {
    // A per-call tuple is deliberately whole-object precedence. Mixing its
    // fields with client defaults can silently create an authorization tuple
    // the caller never selected.
    const selected = perCall ?? this.configuredDelegatedOperatorAuthorization();
    if (selected === undefined) return undefined;
    return { ...selected };
  }

  private delegatedOperatorAuthorizationForRegistration(
    registration: Readonly<WebhookRegistration>
  ): DelegatedOperatorAuthorizationContext | undefined {
    validateWebhookRegistrationAuthorization(registration);
    if (registration.authorizationContextVersion === 1) {
      return registration.delegatedOperatorAuthorization === undefined
        ? undefined
        : { ...registration.delegatedOperatorAuthorization };
    }
    return undefined;
  }

  private async markWebhookDurableSettlementRequired(operationId: string): Promise<void> {
    const mark = this.webhookRegistrationStore.markRequiresDurableSettlement;
    if (!mark) {
      throw new ConfigurationError(
        'A custom webhookRegistrationStore must implement markRequiresDurableSettlement for durable mutation callbacks.'
      );
    }
    await mark.call(this.webhookRegistrationStore, this.agent.id, operationId);
    try {
      const persisted = await this.webhookRegistrationStore.get(this.agent.id, operationId);
      if (
        !persisted ||
        parseWebhookRegistration(persisted, { agentId: this.agent.id, operationId }).requiresDurableSettlement !== true
      ) {
        throw new Error('Webhook registration durable-settlement marker is missing.');
      }
    } catch (cause) {
      const error = new ConfigurationError(
        'The webhook registration store did not preserve the durable-settlement requirement.'
      );
      Object.defineProperty(error, 'cause', { value: cause, configurable: true });
      throw error;
    }
  }

  private webhookJwksFor(registration: Readonly<WebhookRegistration>): JwksResolver {
    const configured = this.config.webhookVerification?.jwks;
    if (configured) return configured;
    if (registration.authorizationContextVersion !== 1) {
      throw new ConfigurationError(
        'Automatic seller-key discovery cannot verify a legacy webhook registration without a persisted authorization context.'
      );
    }
    const delegatedOperatorAuthorization = this.delegatedOperatorAuthorizationForRegistration(registration);
    const key = JSON.stringify([
      registration.protocol,
      registration.agentUrl,
      registration.authorizationContextVersion ?? 0,
      canonicalDelegatedOperatorAuthorization(delegatedOperatorAuthorization),
    ]);
    const existing = this.webhookJwksResolvers.get(key);
    if (existing) {
      this.webhookJwksResolvers.delete(key);
      this.webhookJwksResolvers.set(key, existing);
      return existing;
    }

    const configuredResolverOptions = this.config.webhookVerification?.resolverOptions;
    const {
      requiredOperatorBrand: _configuredBrand,
      requiredOperatorScope: _configuredScope,
      requiredOperatorCountry: _configuredCountry,
      ...resolverOptionsWithoutOperatorContext
    } = configuredResolverOptions ?? {};
    const resolver = new ResolvedAgentJwksResolver(registration.agentUrl, registration.protocol, {
      ...resolverOptionsWithoutOperatorContext,
      legacyWebhookFallback: configuredResolverOptions?.legacyWebhookFallback ?? true,
      ...(delegatedOperatorAuthorization?.brand !== undefined && {
        requiredOperatorBrand: delegatedOperatorAuthorization.brand,
      }),
      ...(delegatedOperatorAuthorization?.scope !== undefined && {
        requiredOperatorScope: delegatedOperatorAuthorization.scope,
      }),
      ...(delegatedOperatorAuthorization?.country !== undefined && {
        requiredOperatorCountry: delegatedOperatorAuthorization.country,
      }),
      fetchCapabilities: agentUrl => {
        const configuredFetch = this.config.webhookVerification?.fetchCapabilities;
        if (configuredFetch) return configuredFetch(agentUrl, registration.protocol);
        return ProtocolClient.callTool(
          {
            id: registration.agentId,
            name: registration.agentId,
            agent_uri: agentUrl,
            protocol: registration.protocol,
          },
          'get_adcp_capabilities',
          {},
          {
            adcpVersion: this.resolvedAdcpVersion,
            ...(this.config.wireAdcpVersion !== undefined && { wireAdcpVersion: this.config.wireAdcpVersion }),
            ...(this.config.versionEnvelope !== undefined && { versionEnvelope: this.config.versionEnvelope }),
            transport: {
              ...this.config.transport,
              requestTimeoutMs:
                this.config.transport?.requestTimeoutMs ??
                this.config.webhookVerification?.resolverOptions?.timeoutMs ??
                10_000,
            },
          }
        );
      },
    });
    if (this.webhookJwksResolvers.size >= WEBHOOK_JWKS_RESOLVER_LIMIT) {
      const oldest = this.webhookJwksResolvers.keys().next().value;
      if (oldest !== undefined) this.webhookJwksResolvers.delete(oldest);
    }
    this.webhookJwksResolvers.set(key, resolver);
    return resolver;
  }

  private resolveLegacyFormatConverter(
    override?: LegacyFormatConverter,
    projectionCatalogs: readonly ProjectionCatalogSnapshot[] | undefined = this.config.projectionCatalogs
  ): LegacyFormatConverter | undefined {
    return legacyFormatConverterFromCatalogSnapshots(projectionCatalogs, override ?? this.config.legacyFormatConverter);
  }

  /** Use an already-composed per-call converter without reapplying configured catalog precedence. */
  private finalLegacyFormatConverter(composed?: LegacyFormatConverter): LegacyFormatConverter | undefined {
    return composed ?? this.resolveLegacyFormatConverter();
  }

  private assertDurableProjectionOverrideSupported(override: LegacyFormatConverter | undefined): void {
    if (!override || !this.config.deferredStorage) return;
    throw new TypeError(
      'Per-call legacyFormatConverter functions cannot be used with durable deferredStorage because functions ' +
        'cannot be persisted for restart recovery. Configure legacyFormatConverter on the client, or pass ' +
        'serializable projectionCatalogs for this call.'
    );
  }

  private assertDurablePropertyListCredentialSupported(taskType: string, requestParams: Record<string, unknown>): void {
    if (!this.config.deferredStorage || taskType !== 'get_products') return;
    // Inspect both raw locations: selection precedence and malformed references must
    // never hide a credential that would still be serialized in the original request.
    const filters = requestParams.filters;
    const references = [
      requestParams.property_list,
      filters && typeof filters === 'object' ? (filters as Record<string, unknown>).property_list : undefined,
    ];
    const hasCredential = references.some(reference => {
      if (!reference || typeof reference !== 'object') return false;
      const token = (reference as Record<string, unknown>).auth_token;
      return token !== undefined && token !== null && token !== '';
    });
    if (!hasCredential) return;
    const policyConfig = this.config.validation?.productPropertyPolicy;
    if (policyConfig === false || policyConfig?.enforceRequestPropertyList === false) return;
    throw new ConfigurationError(
      'Durable deferred recovery cannot persist property_list.auth_token for buyer-side property-list ' +
        'verification. Configure validation.productPropertyPolicy.enforceRequestPropertyList as false, ' +
        'or use a client without deferredStorage for this request.'
    );
  }

  private canonicalAccountScope(account: unknown): string {
    if (account === undefined) return 'none';
    // Account-scoped route identity is the account id or the protocol's
    // natural key (brand + operator + sandbox). Per-call BrandReference
    // overrides are not identity and must not make a live request differ from
    // the minimal snapshot retained for an async completion.
    return canonicalizeJson(canonicalAccountRoutingSnapshot(account) ?? account);
  }

  private canonicalLegacyRouteKey(
    account: unknown,
    productId: string,
    ref:
      | { scope: 'product'; format_option_id: string }
      | {
          scope: 'publisher';
          publisher_domain: string;
          format_option_id: string;
        }
  ): string {
    return canonicalizeJson([
      this.canonicalAccountScope(account),
      productId,
      ref.scope,
      ref.scope === 'publisher' ? ref.publisher_domain.toLowerCase() : '',
      ref.format_option_id,
    ]);
  }

  private canonicalLegacyPackageRouteKey(account: unknown, packageId: string): string {
    return canonicalizeJson([this.canonicalAccountScope(account), 'package', packageId]);
  }

  private sameCanonicalOptionRef(left: CanonicalLegacyOptionRef, right: CanonicalLegacyOptionRef): boolean {
    return sameFormatOptionRef(left, right);
  }

  private rememberCanonicalLegacyRoute(key: string, route: CanonicalLegacyRoute): void {
    this.canonicalLegacyRoutes.delete(key);
    this.canonicalLegacyRoutes.set(key, {
      ...route,
      refs: Object.freeze(route.refs.map(ref => Object.freeze({ ...ref }))),
    });
    while (this.canonicalLegacyRoutes.size > TASK_SCOPED_STATE_LIMIT) {
      const oldest = this.canonicalLegacyRoutes.keys().next().value;
      if (oldest === undefined) break;
      this.canonicalLegacyRoutes.delete(oldest);
    }
  }

  private invalidateCanonicalProductRoutes(products: readonly unknown[], account: unknown): void {
    const accountScope = this.canonicalAccountScope(account);
    const productIds = new Set<string>();
    for (const value of products) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const productId = (value as Record<string, unknown>).product_id;
      if (typeof productId === 'string') productIds.add(productId);
    }
    if (productIds.size === 0) return;
    for (const [key, route] of this.canonicalLegacyRoutes) {
      if (route.kind === 'product' && route.accountScope === accountScope && productIds.has(route.productId)) {
        this.canonicalLegacyRoutes.delete(key);
      }
    }
  }

  private rememberCanonicalProductRoutes(
    products: readonly unknown[],
    account: unknown,
    authoritativeProducts?: readonly unknown[],
    evidence?: Omit<SellerFormatEvidence, 'productId'>
  ): void {
    this.invalidateCanonicalProductRoutes(authoritativeProducts ?? products, account);
    const accountScope = this.canonicalAccountScope(account);
    const declaredOptions = authoritativeProducts ? this.sellerDeclaredFormatOptions(authoritativeProducts) : undefined;
    for (const value of products) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const product = value as Record<string, unknown>;
      if (typeof product.product_id !== 'string' || !Array.isArray(product.format_options)) continue;
      for (const optionValue of product.format_options) {
        if (!optionValue || typeof optionValue !== 'object' || Array.isArray(optionValue)) continue;
        const option = optionValue as Record<string, unknown>;
        if (typeof option.format_option_id !== 'string') continue;
        const ref =
          typeof option.publisher_domain === 'string'
            ? {
                scope: 'publisher' as const,
                publisher_domain: option.publisher_domain,
                format_option_id: option.format_option_id,
              }
            : { scope: 'product' as const, format_option_id: option.format_option_id };
        const refs = legacyFormatRefsForDeclaration(option);
        // Cached canonical products carry the original seller evidence out of
        // band; their SDK-minted ids are not new seller declarations.
        // Keep origin even without legacy refs so fresh seller declarations
        // can override an older persisted undeclared route.
        const declared = declaredOptions
          ? declaredOptions.get(product.product_id)?.some(declaredRef => this.sameCanonicalOptionRef(declaredRef, ref))
          : sellerDeclaredFormatOption(option);
        if (declared !== undefined) rememberSellerDeclaredFormatOption(option, declared);
        if (declared === true && evidence)
          rememberSellerFormatEvidence(option, { ...evidence, productId: product.product_id });
        this.rememberCanonicalLegacyRoute(this.canonicalLegacyRouteKey(account, product.product_id, ref), {
          kind: 'product',
          accountScope,
          productId: product.product_id,
          optionRef: ref,
          refs,
          ...(declared === true && sellerFormatEvidence(option)
            ? { declaration: structuredCloneWithLegacyCreativeMetadata(option) }
            : {}),
          ...(declared === false ? { undeclaredSelector: undeclaredFormatOptionSelector(option) } : {}),
        });
      }
    }
  }

  /**
   * Option refs each product declared in the seller's own response. A product
   * absent from the response yields no entry, so its options are treated as
   * declared rather than guessed undeclared.
   */
  private sellerDeclaredFormatOptions(
    authoritativeProducts: readonly unknown[]
  ): Map<string, CanonicalLegacyOptionRef[]> {
    const declared = new Map<string, CanonicalLegacyOptionRef[]>();
    for (const value of authoritativeProducts) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const product = value as Record<string, unknown>;
      if (typeof product.product_id !== 'string') continue;
      declared.set(product.product_id, sellerDeclaredFormatOptionRefs(product));
    }
    return declared;
  }

  /**
   * What this client's own discovery recorded about an option's origin.
   * Without a product id, every remembered route for the option must agree
   * that the seller did not declare it.
   */
  private cachedFormatOptionOrigin(
    account: unknown,
    ref: CanonicalLegacyOptionRef,
    productId: string | undefined
  ): FormatOptionOrigin | undefined {
    const originOf = (route: Extract<CanonicalLegacyRoute, { kind: 'product' }>): FormatOptionOrigin =>
      route.undeclaredSelector
        ? { seller_declared: false, selector: route.undeclaredSelector }
        : { seller_declared: true };
    if (productId !== undefined) {
      const route = this.routeForOption(account, productId, ref);
      return route?.kind === 'product' ? originOf(route) : undefined;
    }
    const accountScope = this.canonicalAccountScope(account);
    const routes = [...this.canonicalLegacyRoutes.values()].filter(
      (route): route is Extract<CanonicalLegacyRoute, { kind: 'product' }> =>
        route.kind === 'product' &&
        (route.accountScope === accountScope || route.accountScope === 'none') &&
        this.sameCanonicalOptionRef(route.optionRef, ref)
    );
    if (routes.length === 0) return undefined;
    return originOf(routes.find(route => route.undeclaredSelector === undefined) ?? routes[0]!);
  }

  /**
   * The direct selector for an option the seller did not declare, from the
   * first source that knows the option's origin: the per-call resolver, this
   * client's discovery, then the configured resolver. Resolvers carry origin
   * only when built from persisted routes.
   */
  private undeclaredSelectorFor(
    account: unknown,
    ref: CanonicalLegacyOptionRef,
    productId: string | undefined,
    override: CanonicalFormatLegacyResolver | undefined
  ) {
    const origin =
      formatOptionOriginFromRoutes(override, ref, productId) ??
      this.cachedFormatOptionOrigin(account, ref, productId) ??
      formatOptionOriginFromRoutes(this.config.canonicalFormatLegacyResolver, ref, productId);
    return origin && !origin.seller_declared ? origin.selector : undefined;
  }

  private projectUndeclaredFormatOptions<T>(
    request: T,
    operation: 'create_media_buy' | 'update_media_buy' | 'sync_creatives',
    wireMode: CreativeFormatWireMode,
    account: unknown,
    override: CanonicalFormatLegacyResolver | undefined
  ): T {
    if (wireMode !== 'canonical') return request;
    return projectUndeclaredFormatOptionSelectors(request, operation, (ref, productId) =>
      this.undeclaredSelectorFor(account, ref, productId, override)
    );
  }

  private rememberCanonicalProductRoutesForCompletion(
    taskType: string,
    data: unknown,
    legacyFormatConverter: LegacyFormatConverter | undefined,
    account: unknown
  ): void {
    if (taskType !== 'get_products' || !data || typeof data !== 'object' || Array.isArray(data)) return;
    const authoritativeProducts = Array.isArray((data as { products?: unknown[] }).products)
      ? (data as { products: unknown[] }).products
      : [];
    const { response } = toCanonicalOnlyResponse(data as { products?: V1Product[] }, {
      legacyFormatConverter,
    });
    this.rememberCanonicalProductRoutes(
      response.products,
      account,
      authoritativeProducts.length > 0 ? authoritativeProducts : response.products
    );
  }

  private routeForOption(
    account: unknown,
    productId: string,
    optionRef: CanonicalLegacyOptionRef
  ): CanonicalLegacyRoute | undefined {
    const accountScope = this.canonicalAccountScope(account);
    const exactKey = this.canonicalLegacyRouteKey(account, productId, optionRef);
    const exact = this.canonicalLegacyRoutes.get(exactKey);
    if (exact) {
      this.canonicalLegacyRoutes.delete(exactKey);
      this.canonicalLegacyRoutes.set(exactKey, exact);
      return exact;
    }
    const candidates = [...this.canonicalLegacyRoutes.entries()].filter(
      ([, route]) =>
        route.kind === 'product' &&
        route.productId === productId &&
        this.sameCanonicalOptionRef(route.optionRef, optionRef)
    );
    // A scoped write may consume one uniquely known accountless discovery
    // route. The inverse is unsafe: absence of an account is not proof that a
    // sole tenant-scoped route belongs to this request.
    if (candidates.length !== 1) return undefined;
    const [key, candidate] = candidates[0]!;
    if (accountScope === 'none' || candidate.accountScope !== 'none') return undefined;
    this.canonicalLegacyRoutes.delete(key);
    this.canonicalLegacyRoutes.set(key, candidate);
    return candidate;
  }

  private routeForPackage(account: unknown, packageId: string): CanonicalLegacyRoute | undefined {
    const exactKey = this.canonicalLegacyPackageRouteKey(account, packageId);
    const exact = this.canonicalLegacyRoutes.get(exactKey);
    if (exact) {
      this.canonicalLegacyRoutes.delete(exactKey);
      this.canonicalLegacyRoutes.set(exactKey, exact);
      return exact;
    }
    // Package routes are tenant resources, never public discovery data. Cache
    // uniqueness is not tenant identity, so only the exact account key above
    // may resolve one.
    return undefined;
  }

  private packageIdsFromSelector(selector: Readonly<Record<string, unknown>>): string[] {
    const ids = new Set<string>();
    if (typeof selector.package_id === 'string') ids.add(selector.package_id);
    if (Array.isArray(selector.selector_containers)) {
      for (const value of selector.selector_containers) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        for (const id of this.packageIdsFromSelector(value as Readonly<Record<string, unknown>>)) ids.add(id);
      }
    }
    return [...ids];
  }

  private cachedCanonicalLegacyRefs(
    context: CanonicalFormatLegacyResolutionContext,
    account: unknown
  ): readonly V1FormatId[] | undefined {
    const selector: Readonly<Record<string, unknown>> =
      context.source === 'product'
        ? (context.declaration as unknown as Readonly<Record<string, unknown>>)
        : context.source === 'creative'
          ? context.selector
          : context.selector;
    const productId =
      context.source === 'product'
        ? context.productId
        : typeof selector.product_id === 'string'
          ? selector.product_id
          : undefined;
    if (!productId) {
      const packageIds = this.packageIdsFromSelector(selector);
      if (packageIds.length === 0) return undefined;
      const routes = packageIds.map(packageId => this.routeForPackage(account, packageId));
      if (routes.some(route => route === undefined)) return undefined;
      const normalized = routes.map(route =>
        canonicalizeJson(
          route!.refs
            .map(ref => ({ ...ref }))
            .sort((left, right) => canonicalizeJson(left).localeCompare(canonicalizeJson(right)))
        )
      );
      if (!normalized.every(value => value === normalized[0])) return undefined;
      return routes[0]!.refs.map(value => ({ ...value }));
    }

    const rawRefs: unknown[] = [];
    if (context.source === 'product') rawRefs.push(context.declaration);
    if (context.source === 'creative' && context.creative.format_option_ref !== undefined) {
      rawRefs.push(context.creative.format_option_ref);
    } else if (Array.isArray(selector.format_option_refs)) {
      rawRefs.push(...selector.format_option_refs);
    }
    const optionRefs: Array<
      | { scope: 'product'; format_option_id: string }
      | { scope: 'publisher'; publisher_domain: string; format_option_id: string }
    > = [];
    for (const value of rawRefs) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      if (typeof record.format_option_id !== 'string') continue;
      if (record.scope === 'publisher' || typeof record.publisher_domain === 'string') {
        if (typeof record.publisher_domain !== 'string') continue;
        optionRefs.push({
          scope: 'publisher',
          publisher_domain: record.publisher_domain,
          format_option_id: record.format_option_id,
        });
      } else {
        optionRefs.push({ scope: 'product', format_option_id: record.format_option_id });
      }
    }
    if (optionRefs.length === 0) return undefined;

    const resolved: V1FormatId[] = [];
    for (const ref of optionRefs) {
      const route = this.routeForOption(account, productId, ref);
      if (!route || route.refs.length === 0) return undefined;
      resolved.push(...route.refs.map(value => ({ ...value })));
    }
    return resolved;
  }

  private rememberCanonicalPackageRoutes(response: unknown, request: unknown): void {
    if (!response || typeof response !== 'object' || Array.isArray(response)) return;
    const requestRecord =
      request && typeof request === 'object' && !Array.isArray(request)
        ? (request as Record<string, unknown>)
        : undefined;
    const account = requestRecord?.account;
    // A package_id alone is not a tenant identity. Without an account (or a
    // future media_buy_id-bound key) retaining this route could cross tenants.
    if (account === undefined) return;
    const accountScope = this.canonicalAccountScope(account);
    const requestPackages = ['packages', 'new_packages'].flatMap(key =>
      Array.isArray(requestRecord?.[key])
        ? requestRecord[key].filter((value): value is Record<string, unknown> =>
            Boolean(value && typeof value === 'object' && !Array.isArray(value))
          )
        : []
    );
    const responsePackages: Record<string, unknown>[] = [];
    const visit = (value: unknown, depth = 0): void => {
      if (depth > 8 || !value || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        for (const item of value) visit(item, depth + 1);
        return;
      }
      const record = value as Record<string, unknown>;
      if (typeof record.package_id === 'string') responsePackages.push(record);
      for (const key of ['packages', 'affected_packages', 'media_buys']) {
        if (record[key] !== undefined) visit(record[key], depth + 1);
      }
    };
    visit(response);

    for (const pkg of responsePackages) {
      const packageId = pkg.package_id as string;
      let selector: Record<string, unknown> | undefined = pkg;
      let refs = this.cachedCanonicalLegacyRefs(
        { source: 'selector', selector, operation: 'package_route', field: packageId },
        account
      );
      if (!refs) {
        const byPackageId = requestPackages.filter(value => value.package_id === packageId);
        const productId = typeof pkg.product_id === 'string' ? pkg.product_id : undefined;
        const byProduct = productId ? requestPackages.filter(value => value.product_id === productId) : [];
        const matches = byPackageId.length === 1 ? byPackageId : byProduct.length === 1 ? byProduct : [];
        selector = matches[0];
        if (selector) {
          refs = this.cachedCanonicalLegacyRefs(
            { source: 'selector', selector, operation: 'package_route', field: packageId },
            account
          );
        }
      }
      if (!refs || refs.length === 0) continue;
      this.rememberCanonicalLegacyRoute(this.canonicalLegacyPackageRouteKey(account, packageId), {
        kind: 'package',
        accountScope,
        packageId,
        refs,
      });
    }
  }

  private rememberCanonicalPackageRoutesForTask(taskType: string, response: unknown, request: unknown): void {
    if (taskType === 'create_media_buy' || taskType === 'update_media_buy' || taskType === 'get_media_buys') {
      this.rememberCanonicalPackageRoutes(response, request);
    }
  }

  private resolveCanonicalFormatLegacyResolver(
    override: CanonicalFormatLegacyResolver | undefined,
    account: unknown
  ): CanonicalFormatLegacyResolver {
    const configured = this.config.canonicalFormatLegacyResolver;
    return context => override?.(context) ?? this.cachedCanonicalLegacyRefs(context, account) ?? configured?.(context);
  }

  /**
   * Returns the AdCP protocol version this client is configured to speak.
   *
   * Defaults to {@link ADCP_VERSION} (the GA version the SDK ships against)
   * unless overridden via `new SingleAgentClient(agent, { adcpVersion })`.
   *
   * Plumbing surface — Stage 2 of the multi-version refactor exposes the
   * configured value but does not yet vary validator/schema selection by
   * version. Wire-shape adapters key off this method in subsequent stages.
   */
  getAdcpVersion(): string {
    return this.resolvedAdcpVersion;
  }

  /**
   * Observe a persisted seller task using the continuation polling path.
   * Does not submit work or emit protocol_request/protocol_response activity
   * for each poll. Terminal status_change activity carries operation_id and
   * server_task_id. Results use the seller's original tool response shape.
   * Persist the returned operationId if none was supplied. Polling handles
   * are local to this client; matching identities can reattach to existing work.
   * Local observation failures do not publish seller terminal lifecycle events.
   */
  async trackTask<T = unknown>(request: TrackTaskRequest): Promise<TrackedTask<T>> {
    const snapshot = { ...request, transport: request.transport && { ...request.transport } };
    // Validate the correlation id before discovery performs any network work.
    getTaskOperationId(snapshot);
    throwIfAborted(snapshot.signal);
    const agent =
      this.normalizedAgent.protocol === 'a2a'
        ? await this.ensureCanonicalUrlResolved(snapshot)
        : await this.ensureEndpointDiscovered(snapshot);
    return this.executor.trackTask<T>(agent, snapshot);
  }

  /** Poll through the same discovered/canonical protocol endpoint used for dispatch. @internal */
  async getTaskStatus(
    taskId: string,
    transport?: import('../protocols').TransportOptions,
    signal?: AbortSignal,
    wireOptions?: {
      wireAdcpVersion?: string;
      versionEnvelope?: import('../protocols').VersionEnvelopeMode;
    }
  ): Promise<TaskInfo> {
    // Transport options define the outbound trust boundary. Own them before
    // endpoint discovery yields so caller mutation cannot change the fetch or
    // private-address policy between discovery and tasks/get.
    const transportSnapshot = transport === undefined ? undefined : { ...transport };
    const options = { transport: transportSnapshot, signal };
    const agent =
      this.normalizedAgent.protocol === 'a2a'
        ? await this.ensureCanonicalUrlResolved(options)
        : await this.ensureEndpointDiscovered(options);
    return this.executor.getTaskStatus(agent, taskId, transportSnapshot, signal, wireOptions);
  }

  /** Register durable restart/replica settlement recovery for an SDK coordinator. @internal */
  registerDurableSettlementRecovery(
    recoverer: (
      operationId: string,
      observation: ExternalTaskSettlementObservation
    ) => Promise<ExternalTaskStatusResult | undefined>
  ): () => void {
    this.durableSettlementRecoverers.add(recoverer);
    return () => this.durableSettlementRecoverers.delete(recoverer);
  }

  /** Register exact-token authorization for committed deferred continuation recovery. @internal */
  registerDurableDeferredResumeAuthorization(
    authorizer: (operationId: string, token: string) => boolean | undefined | Promise<boolean | undefined>
  ): () => void {
    this.durableDeferredResumeAuthorizers.add(authorizer);
    return () => this.durableDeferredResumeAuthorizers.delete(authorizer);
  }

  /** Register owner-capability authorization for committed operation route discovery. @internal */
  registerDurableDeferredOperationRecoveryAuthorization(
    authorizer: (
      operationId: string,
      recoveryKey: string,
      purpose: 'pause-recovery' | 'callback-checkpoint'
    ) => boolean | undefined | Promise<boolean | undefined>
  ): () => void {
    this.durableDeferredOperationRecoveryAuthorizers.add(authorizer);
    return () => this.durableDeferredOperationRecoveryAuthorizers.delete(authorizer);
  }

  /** Register an atomic committed-route handoff for a nested durable pause. @internal */
  registerDurableDeferredResumeTokenReplacement(
    replacer: (
      operationId: string,
      currentToken: string,
      replacementToken: string
    ) => boolean | undefined | Promise<boolean | undefined>
  ): () => void {
    this.durableDeferredResumeTokenReplacers.add(replacer);
    return () => this.durableDeferredResumeTokenReplacers.delete(replacer);
  }

  /** Whether this exact continuation currently has a durable SDK checkpoint. @internal */
  hasDurablyStoredDeferredTask(token: string): Promise<boolean> {
    return this.executor.hasDurablyStoredDeferredTask(token);
  }

  /** Recover the current committed pause when its opaque token handoff was interrupted. @internal */
  recoverDeferredTaskForOperation<T>(
    operationId: string,
    recoveryKey: string,
    publishTerminalTaskStatus = true
  ): Promise<{ token: string; result: TaskResult<T> } | undefined> {
    return this.executor.recoverDeferredTaskForOperation(operationId, recoveryKey, publishTerminalTaskStatus);
  }

  /** Recover the current generation of an opt-in direct mutation pause. */
  async recoverDirectPauseContinuation<T>(request: DirectPauseRecoveryRequest): Promise<TaskResult<T>> {
    const recovered = await this.executor.recoverDirectPauseContinuation<T>(request);
    return isDeferredClientFinalizationContext(recovered.clientContext)
      ? this.finalizeTaskResult(recovered.result, recovered.clientContext)
      : recovered.result;
  }

  /** Bridge a store-recovered callback into the deferred terminal checkpoint. @internal */
  checkpointExternalDeferredSettlement<T>(
    token: string,
    operationId: string,
    terminalResult: TaskResult<T>
  ): Promise<TaskResult<T> | undefined> {
    return this.executor.checkpointExternalDeferredSettlement(token, operationId, terminalResult);
  }

  /** Resolve and checkpoint the current generation using a separate owner capability. @internal */
  checkpointExternalDeferredSettlementForOperation<T>(
    operationId: string,
    recoveryKey: string,
    terminalResult: TaskResult<T>
  ): Promise<{ token: string; result?: TaskResult<T> } | undefined> {
    return this.executor.checkpointExternalDeferredSettlementForOperation(operationId, recoveryKey, terminalResult);
  }

  /** Publish a callback only after an external durable inbox has bound and settled it. @internal */
  async publishDurablySettledWebhook(args: {
    operationId: string;
    serverTaskId: string;
    taskType: string;
    status: import('./ConversationTypes').TaskStatus;
    result?: unknown;
    error?: string;
    idempotencyKey?: string;
  }): Promise<void> {
    const metadata: WebhookMetadata = {
      operation_id: args.operationId,
      task_id: args.serverTaskId,
      agent_id: this.agent.id,
      task_type: args.taskType,
      status: args.status,
      ...(args.error !== undefined && { message: args.error }),
      ...(args.idempotencyKey !== undefined && { idempotency_key: args.idempotencyKey }),
      timestamp: new Date().toISOString(),
      protocol: this.normalizedAgent.protocol,
    };
    await this.config.onActivity?.({
      type: 'webhook_received',
      operation_id: metadata.operation_id,
      agent_id: metadata.agent_id,
      task_id: metadata.task_id,
      server_task_id: metadata.task_id,
      task_type: metadata.task_type,
      status: metadata.status,
      payload: args.result,
      timestamp: metadata.timestamp,
    });
    await this.asyncHandler?.handleDurablySettledResult({
      result: args.result as AdCPAsyncResponseData | undefined,
      metadata,
    });
  }

  private async recoverDurableSettlement(
    operationId: string,
    observation: ExternalTaskSettlementObservation
  ): Promise<ExternalTaskStatusResult | undefined> {
    for (const recoverer of this.durableSettlementRecoverers) {
      const recovered = await recoverer(operationId, observation);
      if (recovered) return recovered;
    }
    return undefined;
  }

  private async recoverPersistedDeferredTerminal(
    operationId: string,
    status: import('./ConversationTypes').TaskStatus,
    result: unknown,
    serverTaskId: string | undefined,
    taskType: string,
    idempotencyKey?: string
  ): Promise<ExternalTaskStatusResult> {
    if (!serverTaskId) {
      throw new Error('A committed deferred continuation completed without its trusted seller task identity.');
    }
    const recovered = await this.recoverDurableSettlement(operationId, {
      status,
      result,
      serverTaskId,
      taskType,
      ...(idempotencyKey !== undefined && { idempotencyKey }),
      deferredCheckpointOwned: true,
    });
    if (
      !recovered ||
      recovered.queued === true ||
      recovered.settled !== true ||
      recovered.status === undefined ||
      !DURABLE_SETTLEMENT_TERMINAL_STATUSES.has(recovered.status)
    ) {
      throw new Error(
        'The committed deferred continuation reached a terminal seller result, but durable settlement recovery was unavailable.'
      );
    }
    return recovered;
  }

  private taskResultFromRecoveredSettlement<T>(
    original: TaskResult<T>,
    recovered: ExternalTaskStatusResult
  ): TaskResult<T> {
    const status = recovered.status!;
    const settled = {
      ...original,
      success: status === 'completed',
      status,
      metadata: { ...original.metadata, status },
    } as TaskResult<T> & { data?: T; error?: string };
    if (recovered.result === undefined) delete settled.data;
    else settled.data = recovered.result as T;
    if (recovered.error === undefined) delete settled.error;
    else settled.error = recovered.error;
    const recoveredResult = attachMatch(settled as TaskResult<T>) as TaskResult<T>;
    if (hasCompletionHandlerAlreadyPublished(recovered)) {
      markCompletionHandlerAlreadyPublished(recoveredResult);
    }
    return recoveredResult;
  }

  private async wrapPersistedDeferredSettlement<T>(
    result: TaskResult<T>,
    operationId: string,
    persistedServerTaskId?: string
  ): Promise<{ result: TaskResult<T>; afterDispatch?: () => Promise<void> }> {
    if (DURABLE_SETTLEMENT_TERMINAL_STATUSES.has(result.status)) {
      const recovered = await this.recoverPersistedDeferredTerminal(
        operationId,
        result.status,
        result.data,
        result.metadata.serverTaskId ?? persistedServerTaskId,
        result.metadata.taskName,
        result.metadata.idempotency_key
      );
      return {
        result: this.taskResultFromRecoveredSettlement(result, recovered),
        ...(recovered.afterDispatch !== undefined && { afterDispatch: recovered.afterDispatch }),
      };
    }
    if (result.deferred) {
      const deferred = result.deferred;
      result = attachMatch({
        ...result,
        deferred: {
          ...deferred,
          resume: input => this.resumeDeferredTask<T>(deferred.token, input),
        },
      } as TaskResult<T>);
    }
    if (!result.submitted) return { result };

    const submitted = result.submitted;
    return {
      result: attachMatch({
        ...result,
        submitted: {
          ...submitted,
          track: async transport => {
            const task = await submitted.track(transport);
            if (!DURABLE_SETTLEMENT_TERMINAL_STATUSES.has(task.status as import('./ConversationTypes').TaskStatus)) {
              return task;
            }
            const recovered = await this.recoverPersistedDeferredTerminal(
              operationId,
              task.status as import('./ConversationTypes').TaskStatus,
              task.result,
              task.taskId ?? persistedServerTaskId,
              task.taskType
            );
            await recovered.afterDispatch?.();
            return {
              ...task,
              status: recovered.status!,
              ...(recovered.result === undefined ? { result: undefined } : { result: recovered.result }),
              ...(recovered.error === undefined ? { error: undefined } : { error: recovered.error }),
            };
          },
          waitForCompletion: async (pollInterval, signal) => {
            const completion = await submitted.waitForCompletion(pollInterval, signal);
            if (!DURABLE_SETTLEMENT_TERMINAL_STATUSES.has(completion.status)) return completion;
            const recovered = await this.recoverPersistedDeferredTerminal(
              operationId,
              completion.status,
              completion.data,
              completion.metadata.serverTaskId ?? submitted.taskId ?? persistedServerTaskId,
              completion.metadata.taskName,
              completion.metadata.idempotency_key
            );
            const settled = this.taskResultFromRecoveredSettlement(completion, recovered);
            await recovered.afterDispatch?.();
            return settled;
          },
        },
      } as TaskResult<T>),
    };
  }

  /** Effective release pin emitted in protocol envelopes. @internal */
  getWireAdcpVersion(): string {
    return this.config.wireAdcpVersion ?? this.resolvedAdcpVersion;
  }

  /** @internal Read only current, auth-scoped actual discovery evidence; never fetch. */
  getCachedServedAdcpVersion(options?: ReadRequestOptions): string | undefined {
    this.synchronizeCapabilityEvidenceAuthorizationScope();
    if (this.usesScopedDiscoveryTransport(options)) return undefined;
    if (this.primedCapabilitiesExpiresAt !== undefined && this.primedCapabilitiesExpiresAt <= Date.now())
      return undefined;
    if (this.config.discoveryCache && this.cachedCapabilities) {
      const key = this.sharedDiscoveryKey(options);
      if (
        this.sharedEvidenceKey !== key ||
        (key !== undefined &&
          this.sharedEvidenceEpoch !== undefined &&
          this.sharedEvidenceEpoch !== this.sharedInvalidationEpoch(key))
      )
        return undefined;
    }
    return this.cachedCapabilities?._synthetic === false ? this.cachedCapabilities.servedVersion : undefined;
  }

  /**
   * Ensure MCP endpoint is discovered (lazy initialization)
   *
   * If the agent needs discovery, perform it now and cache the result.
   * Returns the agent config with the discovered endpoint.
   * Also computes the canonical base URL by stripping /mcp suffix.
   */
  private async ensureEndpointDiscovered(options?: ReadRequestOptions): Promise<AgentConfig> {
    return withMCPConnectionPolicy(normalizeTransportOptions(options?.transport ?? this.config.transport), () =>
      this.ensureEndpointDiscoveredWithConnectionPolicy(options)
    );
  }

  private async ensureEndpointDiscoveredWithConnectionPolicy(options?: ReadRequestOptions): Promise<AgentConfig> {
    throwIfAborted(options?.signal);
    if (this.config._reuseConfiguredDiscovery?.()) this.synchronizeCapabilityEvidenceAuthorizationScope();
    const needsDiscovery = this.normalizedAgent._needsDiscovery;
    const transport = normalizeTransportOptions(options?.transport ?? this.config.transport);
    const usesScopedFetch = this.usesScopedDiscoveryTransport(options);

    if (!needsDiscovery) {
      return this.normalizedAgent;
    }

    // With a shared discoveryCache the local endpoint is only valid for the
    // policy it was found under and for the freshness bound it was granted.
    const effectiveEndpointKey =
      this.config.discoveryCache && !usesScopedFetch && this.discoveredEndpoint
        ? this.sharedDiscoveryKey(options)
        : undefined;
    if (
      this.config.discoveryCache &&
      !usesScopedFetch &&
      this.discoveredEndpoint &&
      (this.discoveredEndpointKey !== effectiveEndpointKey ||
        (effectiveEndpointKey !== undefined &&
          this.discoveredEndpointEpoch !== this.sharedInvalidationEpoch(effectiveEndpointKey)) ||
        (this.discoveredEndpointExpiresAt ?? 0) <= Date.now())
    ) {
      this.discoveredEndpoint = undefined;
      this.discoveredAgent = undefined;
      this.discoveredMcpEra = undefined;
    }

    // Already discovered? Use cached value
    if (!usesScopedFetch && this.discoveredAgent) {
      return this.discoveredAgent;
    }
    if (!usesScopedFetch && !this.discoveredEndpoint && this.config.discoveryCache) {
      await this.adoptSharedEndpoint(options);
      // Adoption itself is awaited. A peer can invalidate the key after its
      // final read check but before this continuation uses the derived agent.
      if (
        this.discoveredEndpoint &&
        (this.discoveredEndpointEpoch !== this.sharedInvalidationEpoch(this.sharedDiscoveryKey(options)!) ||
          (this.discoveredEndpointExpiresAt ?? 0) <= Date.now())
      ) {
        this.discoveredEndpoint = undefined;
        this.discoveredAgent = undefined;
        this.discoveredMcpEra = undefined;
      }
    }
    if (!usesScopedFetch && this.discoveredEndpoint) {
      const adoptedAgent: AgentConfig = {
        ...this.normalizedAgent,
        agent_uri: this.discoveredEndpoint,
      };
      this.discoveredAgent = adoptedAgent;
      if (this.normalizedAgent.oauth_tokens && !this.normalizedAgent.oauth_client_credentials) {
        const { shareNonInteractiveOAuthProvider } = await import('../auth/oauth/provider-cache');
        shareNonInteractiveOAuthProvider(this.normalizedAgent, adoptedAgent);
      }
      return adoptedAgent;
    }

    if (this.normalizedAgent.oauth_client_credentials) {
      const { ensureClientCredentialsTokens, getAgentStorage } = await import('../auth/oauth');
      await ensureClientCredentialsTokens(this.normalizedAgent, {
        storage: getAgentStorage(this.normalizedAgent),
        allowPrivateIp: transport?.allowPrivateIp ?? isLikelyPrivateUrl(this.normalizedAgent.agent_uri),
        fetch: transport?.trustedFetchFn,
        signal: options?.signal,
      });
    }

    // Perform discovery
    const endpointEpoch = this.discoveryEpochSnapshot(options);
    const discoveredEndpoint = await this.discoverMCPEndpoint(this.normalizedAgent.agent_uri, options);

    if (usesScopedFetch) {
      const discoveredAgent = { ...this.normalizedAgent, agent_uri: discoveredEndpoint };
      if (this.normalizedAgent.oauth_tokens && !this.normalizedAgent.oauth_client_credentials) {
        const { shareNonInteractiveOAuthProvider } = await import('../auth/oauth/provider-cache');
        shareNonInteractiveOAuthProvider(this.normalizedAgent, discoveredAgent);
      }
      return discoveredAgent;
    }

    if (endpointEpoch && !this.discoveryEpochIs(endpointEpoch)) {
      // Invalidated while the probe was in flight: serve this call, keep nothing.
      return { ...this.normalizedAgent, agent_uri: discoveredEndpoint };
    }

    this.discoveredEndpoint = discoveredEndpoint;
    if (this.config.discoveryCache) {
      this.discoveredEndpointKey = this.sharedDiscoveryKey(options);
      this.discoveredEndpointEpoch = endpointEpoch?.shared;
      // Publish the complete local state before awaiting the shared write, so a
      // concurrent call on this instance never sees an endpoint without its bound.
      this.discoveredEndpointExpiresAt = Date.now() + resolveAgentDiscoveryTtlMs(this.config.discoveryCache.ttlMs);
      const stored = await this.writeSharedDiscovery(
        options,
        {
          endpoint: {
            agentUri: discoveredEndpoint,
            ...(this.discoveredMcpEra && { mcpEra: this.discoveredMcpEra }),
          },
        },
        false,
        endpointEpoch
      );
      if (endpointEpoch && !this.discoveryEpochIs(endpointEpoch)) {
        if (this.discoveredEndpoint === discoveredEndpoint && this.discoveredEndpointEpoch === endpointEpoch.shared) {
          this.discoveredEndpoint = undefined;
          this.discoveredEndpointKey = undefined;
          this.discoveredEndpointEpoch = undefined;
          this.discoveredEndpointExpiresAt = undefined;
          if (this.discoveredAgent?.agent_uri === discoveredEndpoint) this.discoveredAgent = undefined;
          this.discoveredMcpEra = undefined;
        }
        return { ...this.normalizedAgent, agent_uri: discoveredEndpoint };
      }
      if (stored && this.discoveredEndpoint === discoveredEndpoint) this.discoveredEndpointExpiresAt = stored.expiresAt;
    }

    // Compute canonical base URL by stripping /mcp suffix
    this.canonicalBaseUrl = this.computeBaseUrl(discoveredEndpoint);

    const discoveredAgent: AgentConfig = {
      ...this.normalizedAgent,
      agent_uri: discoveredEndpoint,
    };
    this.discoveredAgent = discoveredAgent;
    if (this.normalizedAgent.oauth_tokens && !this.normalizedAgent.oauth_client_credentials) {
      const { shareNonInteractiveOAuthProvider } = await import('../auth/oauth/provider-cache');
      shareNonInteractiveOAuthProvider(this.normalizedAgent, discoveredAgent);
    }
    return discoveredAgent;
  }

  /**
   * Ensure A2A canonical URL is resolved (lazy initialization)
   *
   * Fetches the agent card and extracts the canonical URL.
   * Returns the agent config with the canonical URL.
   */
  private async ensureCanonicalUrlResolved(options?: ReadRequestOptions): Promise<AgentConfig> {
    throwIfAborted(options?.signal);
    const needsCanonicalUrl = this.normalizedAgent._needsCanonicalUrl;
    const transport = normalizeTransportOptions(options?.transport ?? this.config.transport);
    const usesScopedFetch = this.usesScopedDiscoveryTransport(options);

    if (!needsCanonicalUrl) {
      return this.normalizedAgent;
    }

    // Already resolved? Use cached value
    if (!usesScopedFetch && this.canonicalBaseUrl) {
      return {
        ...this.normalizedAgent,
        agent_uri: this.canonicalBaseUrl,
      };
    }

    if (this.normalizedAgent.oauth_client_credentials) {
      const { ensureClientCredentialsTokens, getAgentStorage } = await import('../auth/oauth');
      await ensureClientCredentialsTokens(this.normalizedAgent, {
        storage: getAgentStorage(this.normalizedAgent),
        allowPrivateIp: transport?.allowPrivateIp ?? isLikelyPrivateUrl(this.normalizedAgent.agent_uri),
        fetch: transport?.trustedFetchFn,
        signal: options?.signal,
      });
    }

    // Fetch agent card to get canonical URL
    const canonicalEpoch = this.discoveryEpochSnapshot(options);
    const canonicalUrl = await this.fetchA2ACanonicalUrl(this.normalizedAgent.agent_uri, options);
    if (!usesScopedFetch && (!canonicalEpoch || this.discoveryEpochIs(canonicalEpoch))) {
      this.canonicalBaseUrl = canonicalUrl;
    }

    return {
      ...this.normalizedAgent,
      agent_uri: canonicalUrl,
    };
  }

  /**
   * Fetch the canonical URL from an A2A agent card
   *
   * Special handling for authentication errors (401):
   * - If the agent card fetch returns 401, throw AuthenticationRequiredError
   * - Check for OAuth metadata to provide helpful guidance
   */
  private async fetchA2ACanonicalUrl(agentUri: string, readOptions?: ReadRequestOptions): Promise<string> {
    // adcp-client#1804 — wrap A2A card discovery in withResponseSizeLimit so
    // `transport.maxResponseBytes` applies to every agent-card fetch. The
    // auth-stamping fetchImpl composes through wrapFetchWithSizeLimit so the
    // active ALS slot enforces the cap on the wire call. Matches the same
    // pattern in `getAgentInfo` (closed #1799 via PR #1802).
    const { withResponseSizeLimit, wrapFetchWithSizeLimit } = await import('../protocols/responseSizeLimit');
    const transport = normalizeTransportOptions(readOptions?.transport ?? this.config.transport);
    const maxResponseBytes = transport?.maxResponseBytes;
    const requestTimeoutMs = resolveRequestTimeoutMs(transport?.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    const sizeLimitedFetch = wrapFetchWithSizeLimit(
      createAgentTransportFetch(agentUri, {
        trustedFetchFn: transport?.trustedFetchFn,
        allowPrivateIp: transport?.allowPrivateIp,
      })
    );

    const authToken = this.normalizedAgent.oauth_client_credentials
      ? this.normalizedAgent.oauth_tokens?.access_token
      : this.normalizedAgent.auth_token;
    let got401 = false;

    const fetchImpl = async (url: string | URL | Request, requestInit?: RequestInit) => {
      const headers = a2aScopedHeaders(url, requestInit?.headers, agentUri, this.normalizedAgent.headers, authToken);

      const response = await withAbortSignal<Response>(
        [readOptions?.signal, requestInit?.signal],
        requestTimeoutMs,
        signal => sizeLimitedFetch(url as RequestInfo | URL, { ...requestInit, headers, signal })
      );

      // Track 401 errors for later handling
      if (response.status === 401) {
        got401 = true;
      }

      return response;
    };

    const cardUrls = buildCardUrls(agentUri);

    try {
      let client: A2AClient | undefined;
      let lastError: Error = new Error(`A2A agent card not found at ${cardUrls.join(', ')}`);
      for (const cardUrl of cardUrls) {
        try {
          client = await withResponseSizeLimit(maxResponseBytes, () =>
            createA2AClientFromCardUrl(cardUrl, fetchImpl, transport?.legacyCompat)
          );
          break;
        } catch (err: unknown) {
          lastError = err as Error;
          if (got401) break;
        }
      }
      if (!client) {
        throw lastError;
      }
      const agentCard = await withResponseSizeLimit(maxResponseBytes, async () => {
        const compatibleClient = client as unknown as {
          getAgentCard?: () => Promise<any>;
          agentCardPromise?: Promise<any>;
          agentCard?: any;
        };
        return typeof compatibleClient.getAgentCard === 'function'
          ? compatibleClient.getAgentCard()
          : (compatibleClient.agentCardPromise ?? compatibleClient.agentCard);
      });

      // Persist only the JSON-RPC interface negotiated by the official
      // client, and never widen credential scope based on untrusted card data.
      const canonicalUrl = selectA2AJsonRpcUrl(agentCard, client.protocolVersion, agentUri);
      if (canonicalUrl) return canonicalUrl;

      return this.computeBaseUrl(agentUri);
    } catch (error: unknown) {
      // If we got a 401, throw the richer NeedsAuthorizationError when the
      // full discovery walk succeeds; otherwise fall back to the simpler
      // one-hop AuthenticationRequiredError so behavior degrades gracefully.
      if (is401Error(error, got401)) {
        const requirements = await discoverAuthorizationRequirements(agentUri, {
          allowPrivateIp: transport?.allowPrivateIp ?? isLikelyPrivateUrl(agentUri),
          fetchFn: transport?.trustedFetchFn,
          signal: readOptions?.signal,
        });
        if (requirements) {
          throw new NeedsAuthorizationError(requirements);
        }
        // `discoverAuthorizationRequirements` returned null — either no PRM
        // walk available, or the 401 challenge wasn't Bearer. Re-probe to
        // surface the scheme on the error (Basic-fronted gateways are the
        // common non-Bearer case) so consumers don't bounce through OAuth
        // remediation that will never succeed.
        const challenge = await probeAuthChallenge(agentUri, {
          allowPrivateIp: transport?.allowPrivateIp ?? isLikelyPrivateUrl(agentUri),
          fetchFn: transport?.trustedFetchFn,
          signal: readOptions?.signal,
        });
        const oauthMetadata = await discoverOAuthMetadata(agentUri, {
          trustedFetchFn: transport?.trustedFetchFn,
          allowPrivateIp: transport?.allowPrivateIp ?? isLikelyPrivateUrl(agentUri),
          signal: readOptions?.signal,
        });
        throw new AuthenticationRequiredError(agentUri, oauthMetadata || undefined, undefined, challenge ?? undefined);
      }

      // Re-throw other errors
      throw error;
    }
  }

  /**
   * Compute base URL by stripping protocol-specific suffixes
   *
   * - Strips /.well-known/agent.json or /.well-known/agent-card.json for A2A discovery URLs
   * - Strips the protocol transport suffix (/mcp, /a2a, /sse)
   * - Strips trailing slash for consistency
   */
  private computeBaseUrl(url: string): string {
    let baseUrl = stripAgentCardPath(url);
    baseUrl = stripTransportSuffix(baseUrl);
    baseUrl = baseUrl.replace(/\/$/, '');
    return baseUrl;
  }

  private isWellKnownAgentCardUrl(url: string): boolean {
    return isWellKnownCardUrl(url);
  }

  /**
   * Discover MCP endpoint by testing the provided path, then trying variants
   *
   * Strategy:
   * 1. Test the exact URL provided (preserving trailing slashes)
   * 2. If that fails, try with/without trailing slash
   * 3. If still fails and doesn't end with /mcp, try adding /mcp
   *
   * Special handling for authentication errors (401):
   * - If any endpoint returns 401, we know the server exists but requires auth
   * - A validated MCP protected-resource metadata chain yields NeedsAuthorizationError
   * - Otherwise AuthenticationRequiredError carries the advertised challenge
   *
   * Note: This is async and called lazily on first agent interaction
   */
  private async discoverMCPEndpoint(providedUri: string, options?: ReadRequestOptions): Promise<string> {
    return withMCPConnectionPolicy(normalizeTransportOptions(options?.transport ?? this.config.transport), () =>
      this.discoverMCPEndpointWithConnectionPolicy(providedUri, options)
    );
  }

  private async discoverMCPEndpointWithConnectionPolicy(
    providedUri: string,
    options?: ReadRequestOptions
  ): Promise<string> {
    throwIfAborted(options?.signal);
    const { connectMCPWithFallback } = await import('../protocols/mcp');
    const { probeModernMCPConnection } = await import('../protocols/mcp-modern');
    const transport = normalizeTransportOptions(options?.transport ?? this.config.transport);
    const usesScopedFetch = this.usesScopedDiscoveryTransport(options);
    const endpointEpoch = this.discoveryEpochSnapshot(options);
    const mayRetain = () => !usesScopedFetch && (!endpointEpoch || this.discoveryEpochIs(endpointEpoch));

    const authToken = this.normalizedAgent.oauth_client_credentials
      ? this.normalizedAgent.oauth_tokens?.access_token
      : this.agent.auth_token;
    const agentHeaders = this.agent.headers;
    const authHeaders = createMCPRequestHeaders(agentHeaders, authToken);
    const oauth =
      this.normalizedAgent.oauth_tokens && !this.normalizedAgent.oauth_client_credentials
        ? await import('../auth/oauth')
        : undefined;
    const authProvider = oauth
      ? (await import('../auth/oauth/provider-cache')).getNonInteractiveOAuthProvider(this.normalizedAgent, {
          agentHint: this.normalizedAgent.id,
          storage: oauth.getAgentStorage(this.normalizedAgent),
          allowHttp: isLikelyPrivateUrl(this.normalizedAgent.agent_uri),
        })
      : undefined;

    type EndpointTestResult = {
      success: boolean;
      status?: number;
      error?: unknown;
    };

    const testEndpoint = async (url: string): Promise<EndpointTestResult> => {
      try {
        const modern = await probeModernMCPConnection(url, authToken, agentHeaders, {
          authProvider,
          signal: options?.signal,
          requestTimeoutMs: transport?.requestTimeoutMs,
          fetchFn: transport?.trustedFetchFn,
          allowPrivateIp: transport?.allowPrivateIp,
        });
        if (modern.connected) {
          if (mayRetain()) {
            this.discoveredMcpEra = modern.era;
            this.discoveredMcpEraAt = Date.now();
          }
          return { success: true };
        }

        // The v2 Streamable HTTP probe could not connect. Preserve the
        // established v1 Streamable→SSE fallback for old SSE-only agents.
        const client = await connectMCPWithFallback(
          new URL(url),
          authHeaders,
          [],
          'endpoint discovery',
          transport?.trustedFetchFn,
          {
            signal: options?.signal,
            requestTimeoutMs: transport?.requestTimeoutMs,
            allowPrivateIp: transport?.allowPrivateIp,
          }
        );
        await client.close();
        if (mayRetain()) {
          this.discoveredMcpEra = 'legacy';
          this.discoveredMcpEraAt = Date.now();
        }
        return { success: true };
      } catch (error: unknown) {
        const signedRejection = getSignedRequestRejection(error);
        if (signedRejection) throw signedRejection;
        if (isAbortOrTimeoutError(error)) {
          throw error;
        }
        if (is401Error(error)) {
          return { success: false, status: 401, error };
        }
        const errObj = error as Record<string, unknown>;
        const status =
          (errObj?.status as number | undefined) ||
          ((errObj?.response as Record<string, unknown>)?.status as number | undefined) ||
          ((errObj?.cause as Record<string, unknown>)?.status as number | undefined);
        return { success: false, status, error };
      }
    };

    const urlsToTry: string[] = [];

    // 1. Always try the exact URL provided first
    urlsToTry.push(providedUri);

    // 2. Try the opposite trailing slash variant
    const hasTrailingSlash = providedUri.endsWith('/');
    const alternateSlash = hasTrailingSlash
      ? providedUri.slice(0, -1) // Remove trailing slash
      : providedUri + '/'; // Add trailing slash
    urlsToTry.push(alternateSlash);

    // 3. If URL doesn't end with /mcp or /mcp/, try adding /mcp
    const normalizedUri = providedUri.replace(/\/$/, '');
    if (!normalizedUri.endsWith('/mcp')) {
      urlsToTry.push(normalizedUri + '/mcp');
      urlsToTry.push(normalizedUri + '/mcp/');
    }

    // Remove duplicates while preserving order
    const uniqueUrls = [...new Set(urlsToTry)];

    // Track results and whether we got any 401s
    let got401 = false;
    let first401Error: unknown;
    let firstWorkingUrl: string | undefined;

    // Test each URL
    for (const url of uniqueUrls) {
      const result = await testEndpoint(url);

      if (result.success) {
        firstWorkingUrl = url;
        break;
      }

      if (result.status === 401) {
        got401 = true;
        first401Error ??= result.error;
      }
    }

    if (firstWorkingUrl) {
      return firstWorkingUrl;
    }

    // If we got 401 from any endpoint, throw an authentication-required error.
    // Prefer the richer NeedsAuthorizationError when we can walk the full
    // RFC 9728 chain (PRM → AS metadata → endpoints + scopes + DCR hint).
    // Fall back to AuthenticationRequiredError with the advertised challenge
    // when the walk does not prove this MCP resource is OAuth protected.
    if (got401) {
      if (presentedStaticTransportCredential(authToken, agentHeaders, authProvider)) {
        throw new AuthenticationCredentialsRejectedError(providedUri, first401Error);
      }
      const requirements = await discoverAuthorizationRequirements(providedUri, {
        allowPrivateIp: transport?.allowPrivateIp ?? isLikelyPrivateUrl(providedUri),
        fetchFn: transport?.trustedFetchFn,
        signal: options?.signal,
      });
      if (requirements && hasValidatedMcpAuthorizationRequirements(requirements, providedUri)) {
        throw new NeedsAuthorizationError(requirements);
      }
      // Non-Bearer 401 (or Bearer-without-PRM). Re-probe to surface the
      // scheme on the error envelope — `Basic` is the common shape for
      // gateway-fronted agents (Apigee, Kong, AWS API GW) and routing
      // consumers at OAuth would never succeed.
      const challenge = await probeAuthChallenge(providedUri, {
        allowPrivateIp: transport?.allowPrivateIp ?? isLikelyPrivateUrl(providedUri),
        fetchFn: transport?.trustedFetchFn,
        signal: options?.signal,
      });
      throw new AuthenticationRequiredError(providedUri, undefined, undefined, challenge ?? undefined);
    }

    // None worked and no 401 - generic discovery failure.
    // The most common cause is `agent_uri` pointing at the host root when the
    // MCP endpoint lives at a non-standard path; the SDK only auto-probes `/`,
    // `/mcp`, and `/mcp/`. Surface that hint so operators can fix the
    // registration instead of debugging transport.
    throw new Error(
      `Failed to discover MCP endpoint. Tried:\n` +
        uniqueUrls.map((url, i) => `  ${i + 1}. ${url}`).join('\n') +
        '\n' +
        `None responded to MCP protocol.\n\n` +
        `Hint: this usually means agent_uri does not include the MCP endpoint path. ` +
        `The SDK auto-appends /mcp and /mcp/ (plus a trailing-slash variant) ` +
        `to the provided path. If your server exposes MCP at a different path ` +
        `(e.g. /api/mcp, /v1/mcp) or uses legacy SSE at /sse, register that ` +
        `exact path as agent_uri.`
    );
  }

  /**
   * Normalize agent config
   *
   * - If URL is a well-known agent card URL, switch to A2A protocol
   *   (these are A2A discovery URLs, not MCP endpoints)
   * - A2A agents are marked for canonical URL resolution (from agent card)
   * - MCP agents are marked for endpoint discovery
   */
  private normalizeAgentConfig(agent: AgentConfig): InternalAgentConfig {
    // If URL is a well-known agent card URL, use A2A protocol regardless of what was specified
    // Mark for canonical URL resolution - we'll fetch the agent card and use its url field
    if (this.isWellKnownAgentCardUrl(agent.agent_uri)) {
      return {
        ...agent,
        protocol: 'a2a',
        _needsCanonicalUrl: true,
      };
    }

    if (agent.protocol === 'a2a') {
      // A2A agents need canonical URL resolution from agent card
      return {
        ...agent,
        _needsCanonicalUrl: true,
      };
    }

    if (agent.protocol !== 'mcp') {
      return agent;
    }

    // In-process MCP clients have no HTTP endpoint to discover
    if (agent._inProcessMcpClient) {
      return agent;
    }

    // MCP agents need endpoint discovery - we'll test their path, then try adding /mcp
    return {
      ...agent,
      _needsDiscovery: true,
    };
  }

  /**
   * Handle webhook from agent (async task status updates and completions)
   *
   * Accepts webhook payloads from both MCP and A2A protocols:
   * 1. MCP: MCPWebhookPayload envelope with AdCP data in .result field
   * 2. A2A: Native Task/TaskStatusUpdateEvent with AdCP data in either:
   *    - status.message.parts[].data (for status updates)
   *    - artifacts (for task completion, per A2A spec)
   *
   * The method normalizes both formats so handlers receive the unwrapped
   * AdCP response data (AdCPAsyncResponseData), not the raw protocol structure.
   * Registered callbacks require trusted HTTP method and public-URL context;
   * use `createWebhookHandler()` or `verifyAndParseWebhook()` for those flows.
   *
   * @param payload - Protocol-specific webhook payload (MCPWebhookPayload | Task | TaskStatusUpdateEvent)
   * @param taskType - Task type (e.g create_media_buy) from url param or url part of the webhook delivery
   * @param operationId - Operation id (e.g used for client app to track the operation) from the param or url part of the webhook delivery
   * @param signature - X-ADCP-Signature header (format: "sha256=...")
   * @param timestamp - X-ADCP-Timestamp header (Unix timestamp)
   * @param requestContext - Trusted method and public URL. Required for registered callbacks.
   * @returns Whether webhook was handled successfully
   *
   * @example
   * ```typescript
   * app.post(
   *   '/webhook/:task_type/:operation_id',
   *   express.raw({ type: 'application/json' }),
   *   client.createWebhookHandler({
   *     getRequestUrl: req => `https://buyer.example${req.originalUrl}`,
   *   }),
   * );
   * ```
   *
   * `createWebhookHandler()` preserves the SDK's typed HTTP mapping: authentication
   * failures return 401, invalid/conflicting deliveries return 400/409, rate abuse
   * returns 429, and transient verification, storage, or publication failures return
   * 503 for seller retry. Do not map every `handleWebhook()` exception to 401.
   */
  async handleWebhook(
    payload: MCPWebhookPayload | A2ATask | TaskStatusUpdateEvent,
    taskType: string,
    operationId: string,
    signature?: WebhookHeaderValue,
    timestamp?: WebhookHeaderValue,
    rawBody?: string | Buffer | Uint8Array,
    requestContext?: WebhookRequestContext
  ): Promise<boolean> {
    const parsed = await this.verifyAndParseWebhook({
      payload,
      taskType,
      operationId,
      signature,
      timestamp,
      rawBody,
      requestMethod: requestContext?.requestMethod,
      requestUrl: requestContext?.requestUrl,
    });
    if (!parsed.ok) {
      throw new WebhookDispatchError(parsed.code, parsed.message, parsed.cause);
    }

    return this.dispatchParsedWebhook(parsed);
  }

  /**
   * Verify and normalize an inbound webhook without dispatching handlers.
   *
   * This is the lower-level receiver primitive for integrations that need to
   * map malformed webhooks to precise HTTP responses. It verifies the mode
   * selected by the trusted outbound registration (RFC 9421 by default, or
   * legacy HMAC when `webhookSecret` was used), parses raw JSON bodies,
   * validates the transport envelope shape, and returns the canonicalized
   * AdCP result plus routing metadata. Legacy wire inspection is intentionally
   * confined to the transport adapter and is not returned by this primary API.
   * Every registered callback must include its trusted HTTP method and externally
   * visible absolute request URL so the persisted callback target is enforced.
   */
  async verifyAndParseWebhook(options: VerifyAndParseWebhookOptions): Promise<WebhookParseResult> {
    const rawBody = options.rawBody ?? rawBodyFromUnknown(options.body);
    const authHeaders = inspectWebhookAuthenticationHeaders(options.headers, options.signature, options.timestamp);
    let trustedOperationId = options.operationId && options.operationId !== 'unknown' ? options.operationId : undefined;
    let registration: Readonly<WebhookRegistration> | undefined;
    if (trustedOperationId) {
      let stored: Readonly<WebhookRegistration> | undefined;
      try {
        stored = await this.webhookRegistrationStore.get(this.agent.id, trustedOperationId);
      } catch (cause) {
        if (cause instanceof WebhookRegistrationIntegrityError) {
          return {
            ok: false,
            code: 'webhook_registration_store_unavailable',
            message: 'Webhook registration state is invalid.',
            cause,
          };
        }
        const routedTaskType = options.taskType && options.taskType !== 'unknown' ? options.taskType : undefined;
        if (
          !this.config.webhookSecret ||
          routedTaskType === undefined ||
          !RECORDLESS_HMAC_READ_ONLY_TASKS.has(routedTaskType)
        ) {
          return {
            ok: false,
            code: 'webhook_registration_store_unavailable',
            message: 'Webhook registration state is temporarily unavailable.',
            cause,
          };
        }
      }
      if (stored) {
        try {
          registration = parseWebhookRegistration(stored, {
            agentId: this.agent.id,
            operationId: trustedOperationId,
          });
        } catch (cause) {
          // Corrupt or mismatched state is an authorization failure, not a
          // transient read outage eligible for recordless HMAC fallback.
          return {
            ok: false,
            code: 'webhook_registration_store_unavailable',
            message: 'Webhook registration state is invalid.',
            cause,
          };
        }
      }
    }
    if (
      !registration &&
      options.requestUrl &&
      ['media_buy_delivery', 'artifact_delivery'].includes(options.taskType ?? '')
    ) {
      const kind = options.taskType === 'artifact_delivery' ? 'artifact' : 'reporting';
      const routeId = deliveryWebhookRegistrationId(kind, options.requestUrl);
      try {
        const stored = await this.webhookRegistrationStore.get(this.agent.id, routeId);
        if (stored) {
          registration = parseWebhookRegistration(stored, { agentId: this.agent.id, operationId: routeId });
          trustedOperationId = routeId;
        }
      } catch (cause) {
        return {
          ok: false,
          code: 'webhook_registration_store_unavailable',
          message: 'Delivery registration state is unavailable',
          cause,
        };
      }
    }
    if (registration) {
      const nowMs = this.config.webhookVerification?.now
        ? Math.floor(this.config.webhookVerification.now() * 1000)
        : Date.now();
      if (registration.expiresAt <= nowMs) registration = undefined;
    }

    const trustedRouteTaskType = options.taskType && options.taskType !== 'unknown' ? options.taskType : undefined;
    if (
      !registration &&
      this.config.webhookSecret &&
      (trustedRouteTaskType === undefined || !RECORDLESS_HMAC_READ_ONLY_TASKS.has(trustedRouteTaskType))
    ) {
      return {
        ok: false,
        code: 'webhook_registration_store_unavailable',
        message: 'A trusted webhook registration is required for this task type.',
      };
    }

    if (authHeaders.hasRfc9421 && !trustedOperationId) {
      return {
        ok: false,
        code: 'webhook_verification_context_missing',
        message: 'RFC 9421 verification requires a trusted route operation id.',
      };
    }
    if (registration) {
      const routedTaskType = options.taskType === 'unknown' ? undefined : options.taskType;
      if (routedTaskType !== undefined && routedTaskType !== registration.taskType) {
        return {
          ok: false,
          code: 'webhook_registration_mismatch',
          message: 'Trusted webhook route does not match the registered task type.',
        };
      }
      const oppositeMode =
        (registration.mode === 'rfc9421' && authHeaders.hasLegacy) ||
        (registration.mode === 'hmac-sha256' && authHeaders.hasRfc9421);
      if (oppositeMode) {
        const cause = new WebhookSignatureError(
          'webhook_mode_mismatch',
          1,
          'Received webhook authentication mode does not match the registered callback mode.'
        );
        return { ok: false, code: cause.code, message: cause.message, cause };
      }
    }
    if (!registration && this.config.webhookSecret && authHeaders.hasRfc9421) {
      const cause = new WebhookSignatureError(
        'webhook_mode_mismatch',
        1,
        'RFC 9421 signature headers do not match the configured legacy HMAC receiver mode.'
      );
      return { ok: false, code: cause.code, message: cause.message, cause };
    }
    if (registration) {
      if (!options.requestMethod || !options.requestUrl) {
        return {
          ok: false,
          code: 'webhook_verification_context_missing',
          message:
            'Registered webhook verification requires the POST method and externally visible absolute request URL from trusted server context.',
        };
      }
      if (options.requestMethod.toUpperCase() !== registration.method) {
        return {
          ok: false,
          code: 'webhook_verification_context_missing',
          message: 'Webhook request method does not match the registered callback method.',
        };
      }
      try {
        if (canonicalTargetUri(options.requestUrl) !== canonicalTargetUri(registration.callbackUrl)) {
          const cause = new WebhookSignatureError(
            'webhook_signature_invalid',
            10,
            'Trusted request URL does not match the registered callback URL.'
          );
          return { ok: false, code: cause.code, message: cause.message, cause };
        }
      } catch (cause) {
        return {
          ok: false,
          code: 'webhook_verification_context_missing',
          message: 'Webhook request URL must be a valid absolute public URL.',
          cause,
        };
      }
    }
    if (registration?.mode === 'rfc9421') {
      const { verifyWebBotAuth, selectSignatureProfile, WebBotAuthError, WebBotAuthUnavailableError } =
        loadWebBotAuth();
      const requestMethod = options.requestMethod;
      const requestUrl = options.requestUrl;
      if (rawBody === undefined || !options.headers || !trustedOperationId || !requestMethod || !requestUrl) {
        return {
          ok: false,
          code: 'webhook_verification_context_missing',
          message:
            'RFC 9421 verification requires raw body bytes, all headers, POST method, an absolute trusted public URL, and a trusted route operation id.',
        };
      }
      const normalizedHeaders = normalizeRfc9421WebhookHeaders(options.headers);
      if (!normalizedHeaders.ok) return normalizedHeaders.failure;
      try {
        const actualProfile = selectSignatureProfile({ headers: normalizedHeaders.headers });
        if (registration.signingProfile === 'web-bot-auth') {
          if (
            registration.delegatedOperatorAuthorization ||
            (await this.config.webhookVerification?.publisherPins?.(registration))
          )
            throw new WebBotAuthError(403, 'legacy_webhook_authorization_requires_rfc_profile');
          const config = this.config.webhookVerification?.webBotAuth;
          if (!config) throw new WebBotAuthError(403, 'webhook_profile_not_configured');
          const signers = await verifyWebBotAuth(
            {
              method: requestMethod,
              url: requestUrl,
              headers: normalizedHeaders.headers,
              body:
                typeof rawBody === 'string'
                  ? rawBody
                  : // ignoreBOM: Content-Digest covers the exact received bytes.
                    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(rawBody),
            },
            {
              directory: config.directory,
              replayStore: this.webhookReplayStore,
              ...(config.isRevoked && !config.revocation && { isRevoked: config.isRevoked }),
              now: this.config.webhookVerification?.now,
            }
          );
          if (signers.length !== 1 || signers[0]!.origin !== canonicalAgentOrigin(registration.agentUrl))
            throw new WebBotAuthError(403, 'webhook_signer_mismatch');
          if (config.revocation) {
            let status;
            try {
              status = await config.revocation.status(signers[0]!.origin, signers[0]!.keyid);
            } catch (error) {
              throw new WebBotAuthUnavailableError('revocation_persistence_failed', error);
            }
            if (status === 'revoked') throw new WebBotAuthError(403, 'key_revoked');
            if (status === 'unknown') throw new WebBotAuthError(403, 'identity_unverified');
          } else if (!config.isRevoked) throw new WebBotAuthError(403, 'webhook_revocation_not_configured');
        } else {
          if (actualProfile === 'web-bot-auth') throw new WebBotAuthError(403, 'webhook_profile_mismatch');
          const delegatedOperatorAuthorization = this.delegatedOperatorAuthorizationForRegistration(registration);
          await verifyRfc9421WebhookSignature(
            {
              method: requestMethod,
              url: requestUrl,
              headers: normalizedHeaders.headers,
              body: rawBody,
            },
            {
              jwks: this.webhookJwksFor(registration),
              publisherPins: await this.config.webhookVerification?.publisherPins?.(registration),
              onKeyResolutionError: this.config.webhookVerification?.onKeyResolutionError,
              replayStore: this.webhookReplayStore,
              revocationStore: this.webhookRevocationStore,
              ...(this.config.webhookVerification?.now && { now: this.config.webhookVerification.now }),
              agentUrlForKeyid: () => registration.agentUrl,
              ...(registration.authorizationContextVersion === 1 && {
                replayScopeBinding: `delegated-operator:v1:${crypto
                  .createHash('sha256')
                  .update(canonicalDelegatedOperatorAuthorization(delegatedOperatorAuthorization))
                  .digest('base64url')}`,
              }),
            }
          );
        }
      } catch (cause) {
        // Discovery failures, unknown revocation status and verifier
        // infrastructure outages are retryable; signature failures are not.
        if (cause instanceof WebBotAuthUnavailableError)
          return { ok: false, code: 'webhook_verification_unavailable', message: cause.message, cause };
        if (cause instanceof WebBotAuthError)
          return {
            ok: false,
            code: [
              'directory_unavailable',
              'directory_fetch_limit',
              'directory_expired',
              'identity_unverified',
              'verification_unavailable',
            ].includes(cause.reason)
              ? 'webhook_verification_unavailable'
              : 'webhook_signature_invalid',
            message: cause.message,
            cause,
          };
        if (cause instanceof WebhookSignatureError) {
          if (cause.retryable)
            return {
              ok: false,
              code: 'webhook_verification_unavailable',
              message: 'Seller signing keys could not be resolved for webhook verification.',
              cause,
            };
          return { ok: false, code: cause.code, message: cause.message, cause };
        }
        if (
          cause instanceof AgentResolverError &&
          RequestSigningErrorCodeMetadata[cause.code].recovery !== 'transient'
        ) {
          return {
            ok: false,
            code: 'webhook_signature_key_unknown',
            message: 'The registered seller is not authorized to supply this webhook signing key.',
            cause,
          };
        }
        return {
          ok: false,
          code: 'webhook_verification_unavailable',
          message: 'Seller signing keys could not be resolved for webhook verification.',
          cause,
        };
      }
    } else if (registration?.mode === 'hmac-sha256' || (!registration && this.config.webhookSecret)) {
      if (rawBody === undefined) {
        return {
          ok: false,
          code: 'webhook_signature_invalid',
          message: 'Raw webhook body required for HMAC signature verification; capture bytes before JSON parsing.',
        };
      }
      let hmacSecret: string | undefined;
      try {
        hmacSecret = this.config.webhookSecret;
      } catch (cause) {
        return {
          ok: false,
          code: 'webhook_verification_unavailable',
          message: 'Legacy webhook key material is temporarily unavailable.',
          cause,
        };
      }
      if (!hmacSecret) {
        return {
          ok: false,
          code: 'webhook_verification_unavailable',
          message: 'Legacy webhook key material is unavailable for this registration.',
        };
      }
      const check = verifyWebhookRequest({
        rawBody,
        secret: hmacSecret,
        headers: options.headers,
        signature: options.signature,
        timestamp: options.timestamp,
      });
      if (!check.ok) {
        return {
          ok: false,
          code:
            check.reason === 'invalid_timestamp' || check.reason === 'stale_timestamp'
              ? 'webhook_timestamp_invalid'
              : 'webhook_signature_invalid',
          message: check.message,
        };
      }
    } else if (
      this.config.allowUnauthenticatedWebhooks === true &&
      !registration &&
      !authHeaders.hasRfc9421 &&
      !authHeaders.hasLegacy
    ) {
      warnUnverifiedWebhookReceive();
    } else {
      return {
        ok: false,
        code: authHeaders.hasRfc9421 ? 'webhook_registration_not_found' : 'webhook_unverifiable',
        message: 'Refusing a webhook without trusted registration provenance or a configured legacy HMAC secret.',
      };
    }

    const payloadSource =
      (registration || this.config.webhookSecret) && rawBody !== undefined
        ? rawBody
        : (options.payload ?? options.body ?? rawBody);
    const parsedPayload = parseWebhookBody(payloadSource);
    if (!parsedPayload.ok) {
      return parsedPayload;
    }

    if (registration?.deliveryKind) {
      const loader = require('../validation/schema-loader') as typeof import('../validation/schema-loader');
      const body = parsedPayload.payload as Record<string, unknown>;
      const isReport = registration.deliveryKind === 'reporting';
      const payload = isReport ? body.result : body;
      const schemaRef = isReport
        ? 'media-buy/media-buy-delivery-webhook-result.json'
        : 'content-standards/artifact-webhook-payload.json';
      const validator = loader.getSchemaValidatorByRef(schemaRef, this.resolvedAdcpVersion);
      const envelopeValidator = isReport
        ? loader.getSchemaValidatorByRef('core/mcp-webhook-payload.json', this.resolvedAdcpVersion)
        : undefined;
      if (
        !validator ||
        !validator(payload) ||
        (isReport && (!envelopeValidator || !envelopeValidator(body) || body.task_type !== 'media_buy_delivery'))
      )
        return {
          ok: false,
          code: 'webhook_envelope_invalid',
          message: 'Authenticated delivery does not match its registered payload kind',
        };
      const taskId =
        isReport && typeof body.task_id === 'string'
          ? body.task_id
          : typeof body.media_buy_id === 'string'
            ? body.media_buy_id
            : registration.operationId;
      const operationId =
        isReport && typeof body.operation_id === 'string' ? body.operation_id : registration.operationId;
      const status = isReport && isAdcpStatus(body.status) ? body.status : 'completed';
      return {
        ok: true,
        protocol: registration.protocol,
        envelope: isReport
          ? (body as unknown as MCPWebhookPayload)
          : ({
              ...body,
              task_type: registration.taskType,
              operation_id: operationId,
              task_id: taskId,
              status,
              result: payload,
            } as MCPWebhookPayload),
        result: payload,
        metadata: {
          taskId,
          taskType: registration.taskType,
          operationId,
          status,
          ...(typeof body.timestamp === 'string' && { timestamp: body.timestamp }),
          ...(typeof body.idempotency_key === 'string' && { idempotencyKey: body.idempotency_key }),
        },
      };
    }
    const topLevelTaskType =
      isObjectRecord(parsedPayload.payload) && typeof parsedPayload.payload.task_type === 'string'
        ? parsedPayload.payload.task_type
        : undefined;
    const payloadRecord = isObjectRecord(parsedPayload.payload) ? parsedPayload.payload : undefined;
    const signedRoute = extractSignedWebhookRoute(parsedPayload.payload);
    if (!signedRoute.ok) {
      return {
        ok: false,
        code: 'webhook_envelope_invalid',
        message: signedRoute.message,
      };
    }
    const parsedTaskType = signedRoute.taskType ?? topLevelTaskType;
    if (!registration && this.config.webhookSecret && trustedOperationId === undefined) {
      return {
        ok: false,
        code: 'webhook_verification_context_missing',
        message: 'Legacy HMAC verification requires a trusted route operation id.',
      };
    }
    const hmacAuthenticated = registration?.mode === 'hmac-sha256' || (!registration && this.config.webhookSecret);
    if (
      hmacAuthenticated &&
      (signedRoute.operationId === undefined ||
        signedRoute.operationId !== trustedOperationId ||
        signedRoute.taskType === undefined ||
        signedRoute.taskType !== trustedRouteTaskType)
    ) {
      return {
        ok: false,
        code: 'webhook_registration_mismatch',
        message: 'Legacy HMAC webhook body is not bound to the trusted callback route.',
      };
    }
    if (
      registration &&
      ((signedRoute.operationId !== undefined && signedRoute.operationId !== registration.operationId) ||
        (signedRoute.taskType !== undefined && signedRoute.taskType !== registration.taskType) ||
        (signedRoute.agentId !== undefined && signedRoute.agentId !== registration.agentId))
    ) {
      return {
        ok: false,
        code: 'webhook_envelope_invalid',
        message: 'Authenticated webhook routing fields do not match the trusted registration.',
      };
    }
    const associatedTaskTypes = new Set(
      [
        options.operationId,
        typeof payloadRecord?.operation_id === 'string' ? payloadRecord.operation_id : undefined,
        typeof payloadRecord?.task_id === 'string' ? payloadRecord.task_id : undefined,
        typeof payloadRecord?.context_id === 'string' ? payloadRecord.context_id : undefined,
      ].flatMap(id => {
        const taskType = this.canonicalCreativeTaskAssociation(id)?.taskType;
        return taskType ? [taskType] : [];
      })
    );
    const associatedTaskType = associatedTaskTypes.size === 1 ? [...associatedTaskTypes][0] : undefined;
    const routedTaskType = options.taskType === 'unknown' ? undefined : options.taskType;
    const declaredTaskType = routedTaskType ?? parsedTaskType;
    const previewOperationId =
      typeof payloadRecord?.operation_id === 'string' ? payloadRecord.operation_id : options.operationId;
    const localPreviewHandler =
      declaredTaskType === 'preview_creative' && previewOperationId
        ? this.previewCreativeHandlerForWebhook({
            operation_id: previewOperationId,
            task_id: '',
            context_id: '',
            task_type: 'preview_creative',
          })
        : undefined;
    // Durable registration provenance wins when available. During the legacy
    // HMAC store-outage fallback, the operation-scoped local marker must win
    // over a stale canonical association on a reused task or context id.
    const previewHandler = registration?.previewMode ?? localPreviewHandler;
    const authoritativePreviewTask = declaredTaskType === 'preview_creative' && previewHandler !== undefined;
    if (
      !authoritativePreviewTask &&
      (associatedTaskTypes.size > 1 ||
        (associatedTaskType !== undefined && declaredTaskType !== undefined && associatedTaskType !== declaredTaskType))
    ) {
      return {
        ok: false,
        code: 'webhook_envelope_invalid',
        message: 'Webhook task_type does not match the locally tracked task association.',
      };
    }
    let normalizedTaskType = authoritativePreviewTask ? declaredTaskType : (associatedTaskType ?? declaredTaskType);
    try {
      const normalizedPayload = this.normalizeWebhookPayload(
        parsedPayload.payload,
        normalizedTaskType ?? 'unknown',
        options.operationId ?? 'unknown',
        registration?.mode === 'rfc9421'
      );
      normalizedTaskType = normalizedPayload.task_type;
      if (registration && (normalizedPayload.protocol ?? 'mcp') !== registration.protocol) {
        return {
          ok: false,
          code: 'webhook_envelope_invalid',
          message: 'Authenticated webhook protocol does not match the trusted registration.',
        };
      }
      if (
        !authoritativePreviewTask &&
        associatedTaskType !== undefined &&
        normalizedPayload.task_type !== associatedTaskType
      ) {
        return {
          ok: false,
          code: 'webhook_envelope_invalid',
          message: 'Webhook task_type does not match the locally tracked task association.',
        };
      }
      const metadata: WebhookMetadata = {
        operation_id: normalizedPayload.operation_id,
        context_id: normalizedPayload.context_id,
        task_id: normalizedPayload.task_id,
        agent_id: this.agent.id,
        task_type: normalizedPayload.task_type,
        status: normalizedPayload.status,
        message: normalizedPayload.message,
        timestamp: normalizedPayload.timestamp || new Date().toISOString(),
        idempotency_key: normalizedPayload.idempotency_key,
        notification_id: normalizedPayload.notification_id,
        protocol: normalizedPayload.protocol ?? 'mcp',
      };
      const canonicalCreativeTask =
        CANONICAL_CREATIVE_ACTIVITY_TASKS.has(normalizedPayload.task_type) ||
        (normalizedPayload.task_type === 'preview_creative' &&
          (previewHandler !== undefined ? previewHandler === 'canonical' : associatedTaskType === 'preview_creative'));
      const canonicalResult = this.canonicalizeWebhookCreativeResult(
        metadata,
        normalizedPayload.result,
        canonicalCreativeTask
      );
      const legacyFormatConverter = this.legacyFormatConverterForWebhook(metadata);
      const canonicalEnvelope = canonicalCreativeTask
        ? stripLegacyCreativeIdentity(
            projectCanonicalCreativeResponseValue(
              parsedPayload.payload,
              normalizedPayload.task_type,
              legacyFormatConverter
            )
          )
        : parsedPayload.payload;
      const canonicalMessage = canonicalCreativeTask
        ? (
            stripLegacyCreativeIdentity({
              message: normalizedPayload.message,
              legacySource: parsedPayload.payload,
            }) as { message?: string }
          ).message
        : normalizedPayload.message;
      return {
        ok: true,
        protocol: normalizedPayload.protocol ?? 'mcp',
        envelope: canonicalEnvelope as MCPWebhookPayload | A2ATask | TaskStatusUpdateEvent,
        result: canonicalResult,
        metadata: {
          operationId: normalizedPayload.operation_id,
          contextId: normalizedPayload.context_id,
          taskId: normalizedPayload.task_id,
          taskType: normalizedPayload.task_type,
          status: normalizedPayload.status,
          message: canonicalMessage,
          previewHandler,
          timestamp: normalizedPayload.timestamp,
          idempotencyKey: normalizedPayload.idempotency_key,
          notificationId: normalizedPayload.notification_id,
          requiresDurableSettlement: registration?.requiresDurableSettlement,
        },
      };
    } catch (error) {
      const canonicalCreativeTask =
        normalizedTaskType !== undefined &&
        (CANONICAL_CREATIVE_ACTIVITY_TASKS.has(normalizedTaskType) ||
          (normalizedTaskType === 'preview_creative' &&
            (previewHandler !== undefined
              ? previewHandler === 'canonical'
              : associatedTaskType === 'preview_creative')));
      if (error instanceof WebhookDispatchError) {
        if (!canonicalCreativeTask) {
          return { ok: false, code: error.code, message: error.message };
        }
        const safe = stripLegacyCreativeIdentity({
          message: error.message,
          legacySource: parsedPayload.payload,
        }) as { message: string };
        return { ok: false, code: error.code, message: safe.message };
      }
      const message = error instanceof Error ? error.message : 'Webhook payload could not be normalized.';
      if (canonicalCreativeTask) {
        const safe = stripLegacyCreativeIdentity({ message, legacySource: parsedPayload.payload }) as {
          message: string;
        };
        return { ok: false, code: 'webhook_result_invalid', message: safe.message };
      }
      return {
        ok: false,
        code: 'webhook_result_invalid',
        message: 'Webhook payload could not be normalized.',
      };
    }
  }

  private async dispatchParsedWebhook(parsed: WebhookParseSuccess): Promise<boolean> {
    if (parsed.metadata.taskType === 'preview_creative' && parsed.metadata.previewHandler) {
      for (const key of [parsed.metadata.operationId, parsed.metadata.taskId, parsed.metadata.contextId]) {
        if (!key) continue;
        this.rememberPreviewCreativeHandlerKey(key, parsed.metadata.previewHandler);
        if (parsed.metadata.previewHandler === 'canonical') {
          this.rememberCanonicalCreativeTaskAssociation(key, 'preview_creative');
        } else {
          this.canonicalCreativeTaskAssociations.delete(key);
        }
      }
    }
    const canonicalCreativeTask =
      parsed.metadata.taskType === 'preview_creative' && parsed.metadata.previewHandler !== undefined
        ? parsed.metadata.previewHandler === 'canonical'
        : this.isCanonicalCreativeWebhook({
            operation_id: parsed.metadata.operationId,
            context_id: parsed.metadata.contextId,
            task_id: parsed.metadata.taskId,
            task_type: parsed.metadata.taskType,
          });
    let metadata: WebhookMetadata = {
      operation_id: parsed.metadata.operationId,
      context_id: parsed.metadata.contextId,
      task_id: parsed.metadata.taskId,
      agent_id: this.agent.id,
      task_type: parsed.metadata.taskType,
      status: parsed.metadata.status,
      message: parsed.metadata.message,
      timestamp: parsed.metadata.timestamp || new Date().toISOString(),
      idempotency_key: parsed.metadata.idempotencyKey,
      notification_id: parsed.metadata.notificationId,
      protocol: parsed.protocol,
      rawHTTPPayload: canonicalCreativeTask ? stripLegacyCreativeIdentity(parsed.envelope) : parsed.envelope,
    };
    try {
      this.asyncHandler?.assertWebhookDedupInput(metadata);
    } catch (error) {
      if (error instanceof WebhookDedupInputError) {
        throw new WebhookDispatchError('webhook_envelope_invalid', error.message, error);
      }
      throw error;
    }
    this.rememberCanonicalCreativeWebhookContext(metadata);
    let externalStatus: ExternalTaskStatusResult | undefined;
    let forgetPolicyState = false;
    try {
      const canonicalResult = this.canonicalizeWebhookCreativeResult(
        metadata,
        this.convertWebhookResultToClientRelease(parsed),
        canonicalCreativeTask
      );
      const dedupResult = canonicalResult as AdCPAsyncResponseData | undefined;
      const dedupMetadata = { ...metadata };
      let webhookResult = dedupResult;
      let suppressHandler = false;

      const dispatchClaimedWebhook = async (): Promise<boolean> => {
        try {
          const policyDispatch = await this.applyProductPropertyPolicyToWebhookResult(webhookResult, metadata);
          webhookResult = policyDispatch.result;
          metadata = policyDispatch.metadata;
          suppressHandler = policyDispatch.suppressHandler;

          if (metadata.task_type === 'request_proposals') {
            assertNativeRequestProposalsResult(webhookResult);
          }

          const observation = {
            status: metadata.status as import('./ConversationTypes').TaskStatus,
            result: webhookResult,
            serverTaskId: metadata.task_id,
            taskType: metadata.task_type,
            ...(metadata.idempotency_key !== undefined && { idempotencyKey: metadata.idempotency_key }),
          };
          if (parsed.metadata.requiresDurableSettlement === true) {
            const recovered = await this.recoverDurableSettlement(metadata.operation_id, observation);
            if (recovered) {
              const hasTerminalStatus =
                recovered.status !== undefined && DURABLE_SETTLEMENT_TERMINAL_STATUSES.has(recovered.status);
              const validQueued =
                recovered.queued === true &&
                recovered.settled === false &&
                recovered.duplicate !== true &&
                recovered.status === undefined &&
                recovered.result === undefined &&
                recovered.error === undefined;
              const validDuplicate =
                recovered.duplicate === true &&
                recovered.settled === true &&
                recovered.queued !== true &&
                hasTerminalStatus;
              const validSettled =
                recovered.settled === true &&
                recovered.duplicate !== true &&
                recovered.queued !== true &&
                hasTerminalStatus &&
                (recovered.status !== 'completed' || recovered.result !== undefined);
              if (!validQueued && !validDuplicate && !validSettled) {
                throw new WebhookDispatchError(
                  'webhook_durable_settlement_unavailable',
                  'The durable settlement recoverer returned an invalid or contradictory callback outcome.'
                );
              }
              externalStatus = recovered;
            } else {
              throw new WebhookDispatchError(
                'webhook_durable_settlement_unavailable',
                'The callback requires durable mutation settlement, but no recoverable settlement route is available.'
              );
            }
          } else {
            externalStatus = await this.executor.observeExternalTaskStatus(
              metadata.operation_id,
              observation.status,
              observation.result,
              { serverTaskId: observation.serverTaskId, taskType: observation.taskType }
            );
          }
          if (!externalStatus) throw new Error('Webhook settlement did not produce an observable status.');
          if (externalStatus.queued) {
            externalStatus = undefined;
            return true;
          }
          if (externalStatus.duplicate) {
            metadata = {
              ...metadata,
              status: externalStatus.status ?? metadata.status,
              ...(externalStatus.error !== undefined && { message: externalStatus.error }),
            };
            const duplicateActivity: Activity = {
              type: 'webhook_duplicate',
              operation_id: metadata.operation_id,
              agent_id: metadata.agent_id,
              context_id: metadata.context_id,
              task_id: metadata.task_id,
              server_task_id: metadata.task_id,
              task_type: metadata.task_type,
              status: metadata.status,
              idempotency_key: metadata.idempotency_key,
              timestamp: metadata.timestamp,
            };
            await this.config.onActivity?.(canonicalCreativeActivity(duplicateActivity));
            await this.asyncHandler?.handleDurableSettlementDuplicate(metadata);
            await externalStatus.afterDispatch?.();
            externalStatus = undefined;
            return true;
          }
          if (externalStatus.settled) {
            webhookResult = externalStatus.result as AdCPAsyncResponseData | undefined;
            metadata = {
              ...metadata,
              status: externalStatus.status ?? metadata.status,
              ...(externalStatus.error !== undefined && { message: externalStatus.error }),
            };
          }

          await this.config.onActivity?.(
            canonicalCreativeActivity({
              type: 'webhook_received',
              operation_id: metadata.operation_id,
              agent_id: metadata.agent_id,
              context_id: metadata.context_id,
              task_id: metadata.task_id,
              server_task_id: metadata.task_id,
              task_type: metadata.task_type,
              status: metadata.status,
              payload: webhookResult,
              timestamp: metadata.timestamp,
            })
          );

          if (!suppressHandler && this.asyncHandler) {
            await this.asyncHandler.handleClaimedWebhook({
              result: webhookResult,
              metadata,
              previewHandler: parsed.metadata.previewHandler ?? this.previewCreativeHandlerForWebhook(metadata),
            });
          }
          await externalStatus.afterDispatch?.();
          externalStatus = undefined;
          return this.asyncHandler !== undefined || suppressHandler;
        } catch (error) {
          const rejectedStatus = externalStatus;
          externalStatus = undefined;
          if (rejectedStatus?.onDispatchError) {
            try {
              await rejectedStatus.onDispatchError();
            } catch (rejectionError) {
              throw new WebhookDedupClaimRetentionError(
                [error, rejectionError],
                'Webhook dispatch failed and its durable settlement ownership could not be released.'
              );
            }
          }
          throw error;
        }
      };

      if (!this.asyncHandler) {
        let handled: boolean;
        try {
          handled = await dispatchClaimedWebhook();
        } catch (error) {
          if (error instanceof WebhookDedupClaimRetentionError) {
            throw new WebhookDispatchError(
              'webhook_publication_in_progress',
              'Webhook dispatch failed while durable publication ownership remained active.',
              error
            );
          }
          throw error;
        }
        forgetPolicyState = DURABLE_SETTLEMENT_TERMINAL_STATUSES.has(
          metadata.status as import('./ConversationTypes').TaskStatus
        );
        return handled;
      }

      let deduped: {
        outcome: 'handled' | 'already_handled' | 'in_progress';
        value?: boolean;
      };
      try {
        deduped = await this.asyncHandler.runWebhookDeduplicated({
          result: dedupResult,
          metadata: dedupMetadata,
          dispatch: dispatchClaimedWebhook,
        });
      } catch (error) {
        if (error instanceof WebhookDedupClaimRetentionError) {
          throw new WebhookDispatchError(
            'webhook_publication_in_progress',
            'Webhook dispatch failed while durable publication ownership remained active.',
            error
          );
        }
        if (error instanceof WebhookDedupConflictError) {
          throw new WebhookDispatchError('webhook_idempotency_conflict', error.message, error);
        }
        if (error instanceof WebhookDedupInputError) {
          throw new WebhookDispatchError('webhook_envelope_invalid', error.message, error);
        }
        throw error;
      }
      if (deduped.outcome === 'in_progress') {
        throw new WebhookDispatchError(
          'webhook_publication_in_progress',
          'A matching callback publication is still in progress.'
        );
      }
      if (deduped.outcome === 'already_handled') {
        await this.config.onActivity?.(
          canonicalCreativeActivity({
            type: 'webhook_duplicate',
            operation_id: metadata.operation_id,
            agent_id: metadata.agent_id,
            context_id: metadata.context_id,
            task_id: metadata.task_id,
            server_task_id: metadata.task_id,
            task_type: metadata.task_type,
            status: metadata.status,
            idempotency_key: metadata.idempotency_key,
            timestamp: metadata.timestamp,
          })
        );
        forgetPolicyState = DURABLE_SETTLEMENT_TERMINAL_STATUSES.has(
          metadata.status as import('./ConversationTypes').TaskStatus
        );
        return true;
      }
      forgetPolicyState = DURABLE_SETTLEMENT_TERMINAL_STATUSES.has(
        metadata.status as import('./ConversationTypes').TaskStatus
      );
      return deduped.value ?? true;
    } finally {
      if (forgetPolicyState) this.forgetProductPolicyRequestParams(metadata);
    }
  }

  private rememberCanonicalCreativeWebhookContext(metadata: WebhookMetadata): void {
    if (!metadata.context_id || !this.isCanonicalCreativeWebhook(metadata)) return;
    const association =
      this.canonicalCreativeTaskAssociation(metadata.operation_id) ??
      this.canonicalCreativeTaskAssociation(metadata.task_id) ??
      this.canonicalCreativeTaskAssociation(metadata.context_id);
    if (!association) return;
    this.rememberCanonicalCreativeTaskAssociation(
      metadata.context_id,
      association.taskType,
      association.legacyFormatConverter,
      association.routingSnapshot
    );
    const previewHandler = this.previewCreativeHandlerForWebhook(metadata);
    if (previewHandler) this.rememberPreviewCreativeHandlerKey(metadata.context_id, previewHandler);
  }

  private canonicalizeWebhookCreativeResult(
    metadata: WebhookMetadata,
    result: unknown,
    canonicalCreativeTask = this.isCanonicalCreativeWebhook(metadata)
  ): unknown {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
    const taskType = metadata.task_type;
    const legacyFormatConverter = this.legacyFormatConverterForWebhook(metadata);
    const response = result as Record<string, unknown>;
    if (taskType === 'get_products' && Array.isArray(response.products)) {
      const { response: canonical, diagnostics } = toCanonicalOnlyResponse(
        response as unknown as { products?: V1Product[] },
        { legacyFormatConverter }
      );
      const requestParams = this.productPolicyRequestParamsForWebhook(metadata);
      this.rememberCanonicalProductRoutes(canonical.products, requestParams.account, response.products);
      const { _message: _dropLegacyMessage, ...safe } = canonical as typeof canonical & { _message?: unknown };
      void _dropLegacyMessage;
      return stripLegacyCreativeIdentity({ ...safe, projection: { diagnostics } });
    }
    if (taskType === 'list_creatives' && Array.isArray(response.creatives)) {
      const { _message: _dropLegacyMessage, ...safe } = response;
      void _dropLegacyMessage;
      return stripLegacyCreativeIdentity({
        ...safe,
        creatives: response.creatives.map(creative =>
          projectCreativeForDelivery(creative as never, {}, 'canonical', 'list_creatives', legacyFormatConverter)
        ),
      });
    }
    const canonical = canonicalCreativeTask
      ? stripLegacyCreativeIdentity(projectCanonicalCreativeResponseValue(result, taskType, legacyFormatConverter))
      : result;
    const association =
      this.canonicalCreativeTaskAssociation(metadata.operation_id) ??
      this.canonicalCreativeTaskAssociation(metadata.task_id) ??
      this.canonicalCreativeTaskAssociation(metadata.context_id);
    if (metadata.status === 'completed') {
      this.rememberCanonicalPackageRoutesForTask(taskType, canonical, association?.routingSnapshot);
    }
    return canonical;
  }

  /**
   * Normalize webhook payload - handles both MCP and A2A webhook formats
   *
   * MCP: Uses MCPWebhookPayload envelope with AdCP data in .result field
   * A2A: Uses native Task/TaskStatusUpdateEvent messages with AdCP data in either:
   *      - status.message.parts[].data (for status updates)
   *      - artifacts (for task completion responses, per A2A spec)
   *
   * @param payload - Protocol-specific webhook payload (MCPWebhookPayload | Task | TaskStatusUpdateEvent)
   * @param taskType - Task type override
   * @param operationId - Operation id
   * @returns Normalized webhook payload with extracted AdCP response
   */
  private normalizeWebhookPayload(
    payload: unknown,
    taskType: string,
    operationId: string,
    allowLegacyA2AArtifactFallback = false
  ): NormalizedWebhookPayload {
    if (!isObjectRecord(payload)) {
      throw new WebhookDispatchError(
        'webhook_unsupported_payload',
        'Unsupported webhook payload format. Expected an MCP webhook envelope object or an A2A task/status event.'
      );
    }

    if (isBareDeliveryReport(payload)) {
      throw new WebhookDispatchError(
        'webhook_unsupported_payload',
        'Unsupported webhook payload format: received a bare delivery report result. Webhook POST bodies must be an MCP envelope with top-level idempotency_key, operation_id, task_id, task_type, status, timestamp, and result, or an A2A task/status event. Put delivery fields under result.'
      );
    }

    // 1. Check for A2A Task or TaskStatusUpdateEvent before considering MCP.
    // Native A2A events also carry a top-level `status`, so MCP's broad
    // candidate detector must never get first refusal.
    const normalizedA2APayload = normalizeA2AWebhookEnvelope(payload);
    if (normalizedA2APayload) {
      const a2aPayload = normalizedA2APayload as A2ATask | TaskStatusUpdateEvent;
      const statusMessageData = latestA2AWebhookMessageData(a2aPayload.status?.message?.parts);
      const artifactExtraction = a2aPayload.kind === 'task' ? getLatestA2ADataPartFromTask(a2aPayload) : undefined;
      const artifactData = artifactExtraction?.data;
      // A terminal Task's artifacts are canonical. Its status.message can be
      // an earlier progress observation and must not shadow the final result.
      const adcpData = a2aPayload.kind === 'task' ? (artifactData ?? statusMessageData) : statusMessageData;
      const artifactMetadata = isObjectRecord(artifactExtraction?.artifact.metadata)
        ? artifactExtraction.artifact.metadata
        : undefined;
      const hasExplicitTaskEnvelope =
        adcpData !== undefined &&
        (Object.hasOwn(adcpData, 'result') || Object.hasOwn(adcpData, 'error') || Object.hasOwn(adcpData, 'errors'));
      const dataAdcpStatus =
        adcpData && hasExplicitTaskEnvelope && isAdcpStatus(adcpData.status)
          ? adcpData.status
          : extractAdcpTaskStatusFromPayload(adcpData);
      const metadataAdcpStatus = isAdcpStatus(artifactMetadata?.adcp_status) ? artifactMetadata.adcp_status : undefined;
      if (metadataAdcpStatus !== undefined && dataAdcpStatus !== undefined && metadataAdcpStatus !== dataAdcpStatus) {
        throw new WebhookDispatchError(
          'webhook_envelope_invalid',
          'Invalid A2A webhook envelope: artifact and structured AdCP work statuses do not match.'
        );
      }
      // Native A2A artifact metadata is the transport-safe work observation.
      // It must win over typed result payloads whose domain `status` can use
      // the same literals (for example a completed cancellation result).
      const legacyArtifactStatus = legacyA2AArtifactStatus(a2aPayload, artifactExtraction?.artifact);
      const usesLegacyArtifactFallback =
        allowLegacyA2AArtifactFallback &&
        metadataAdcpStatus === undefined &&
        dataAdcpStatus === undefined &&
        legacyArtifactStatus !== undefined;
      const adcpStatus =
        metadataAdcpStatus ?? dataAdcpStatus ?? (usesLegacyArtifactFallback ? legacyArtifactStatus : undefined);
      const isTerminalAdcpStatus =
        adcpStatus !== undefined &&
        DURABLE_SETTLEMENT_TERMINAL_STATUSES.has(adcpStatus as import('./ConversationTypes').TaskStatus);
      const hasTerminalEnvelope =
        adcpData !== undefined &&
        (!isTerminalAdcpStatus ||
          metadataAdcpStatus !== undefined ||
          usesLegacyArtifactFallback ||
          Object.hasOwn(adcpData, 'result') ||
          Object.hasOwn(adcpData, 'error') ||
          Object.hasOwn(adcpData, 'errors'));
      if (!adcpData || !adcpStatus || !WEBHOOK_TASK_STATUSES.has(adcpStatus) || !hasTerminalEnvelope) {
        throw new WebhookDispatchError(
          'webhook_envelope_invalid',
          'Invalid A2A webhook envelope: structured AdCP status data is required; transport Task state is not an AdCP work observation.'
        );
      }

      const wrapped = { result: a2aPayload };
      const artifactTaskId = responseParser.getTaskId({
        task_id: artifactMetadata?.adcp_task_id ?? artifactMetadata?.serverTaskId,
      });
      const dataTaskId = responseParser.getTaskId({ task_id: adcpData.task_id });
      if (artifactTaskId && dataTaskId && artifactTaskId !== dataTaskId) {
        throw new WebhookDispatchError(
          'webhook_envelope_invalid',
          'Invalid A2A webhook envelope: artifact and structured AdCP work task IDs do not match.'
        );
      }
      // Prefer seller-issued AdCP work identity. For synchronous native A2A
      // callbacks there may be no separate work handle; the authenticated,
      // buyer-issued callback route operation is then the trusted identity.
      // A2A transport Task.id is deliberately never used.
      const taskId = artifactTaskId ?? dataTaskId ?? (usesLegacyArtifactFallback ? operationId : undefined);
      if (!taskId) {
        throw new WebhookDispatchError(
          'webhook_envelope_invalid',
          'Invalid A2A webhook envelope: a structured AdCP work task_id is required; transport Task.id is not accepted.'
        );
      }

      const declaredTaskType = typeof adcpData.task_type === 'string' ? adcpData.task_type : undefined;
      if (declaredTaskType && taskType !== 'unknown' && declaredTaskType !== taskType) {
        throw new WebhookDispatchError(
          'webhook_envelope_invalid',
          'Invalid A2A webhook envelope: structured task_type does not match the trusted route.'
        );
      }

      const result = Object.hasOwn(adcpData, 'result')
        ? (adcpData.result as AdCPAsyncResponseData | undefined)
        : (adcpData as AdCPAsyncResponseData);
      const textParts = latestA2AWebhookTextParts(a2aPayload.status?.message?.parts);

      return {
        operation_id: operationId,
        context_id: responseParser.getContextId(wrapped),
        task_id: taskId,
        task_type: taskType !== 'unknown' ? taskType : (declaredTaskType ?? 'unknown'),
        status: adcpStatus,
        result,
        message: textParts.length > 0 ? textParts.join(' ') : undefined,
        timestamp: a2aPayload.status?.timestamp || new Date().toISOString(),
        ...(typeof adcpData.idempotency_key === 'string' && { idempotency_key: adcpData.idempotency_key }),
        ...(typeof adcpData.notification_id === 'string' && { notification_id: adcpData.notification_id }),
        protocol: 'a2a',
      };
    }

    // 2. Check for MCP Webhook Payload (has task_id, status, task_type fields)
    if (isMcpWebhookCandidate(payload)) {
      const missing = missingMcpWebhookFields(payload);
      if (missing.length > 0) {
        throw new WebhookDispatchError(
          'webhook_envelope_invalid',
          `Invalid MCP webhook envelope: missing top-level field(s) ${missing.join(', ')}. Delivery result fields such as notification_type and media_buy_deliveries belong under result, not at the top level.`
        );
      }
      if (typeof payload.status !== 'string' || !WEBHOOK_TASK_STATUSES.has(payload.status)) {
        throw new WebhookDispatchError(
          'webhook_envelope_invalid',
          `Invalid MCP webhook envelope: unsupported top-level status. Expected one of ${Array.from(WEBHOOK_TASK_STATUSES).join(', ')}.`
        );
      }
      if (typeof payload.timestamp !== 'string' || Number.isNaN(Date.parse(payload.timestamp))) {
        throw new WebhookDispatchError(
          'webhook_envelope_invalid',
          'Invalid MCP webhook envelope: timestamp must be an ISO 8601 date-time string.'
        );
      }
      const mcpPayload = payload as unknown as MCPWebhookPayload;
      return {
        operation_id: operationId && operationId !== 'unknown' ? operationId : mcpPayload.operation_id || 'unknown',
        context_id: mcpPayload.context_id ?? undefined,
        task_id: mcpPayload.task_id,
        task_type: taskType && taskType !== 'unknown' ? taskType : mcpPayload.task_type,
        status: mcpPayload.status,
        result: mcpPayload.result ?? undefined,
        message: mcpPayload.message ?? undefined,
        timestamp: mcpPayload.timestamp,
        idempotency_key: mcpPayload.idempotency_key,
        notification_id: mcpPayload.notification_id ?? undefined,
        protocol: 'mcp',
      };
    }

    // 3. Unknown payload format
    throw new WebhookDispatchError(
      'webhook_unsupported_payload',
      'Unsupported webhook payload format. Expected an MCP webhook envelope with top-level idempotency_key, operation_id, task_id, task_type, status, timestamp, and result, or an A2A Task/TaskStatusUpdateEvent with AdCP data nested in status.message.parts[].data or task artifacts.'
    );
  }

  /**
   * Generate webhook URL using macro substitution
   *
   * @param taskType - Type of task (e.g., 'get_products', 'media_buy_delivery')
   * @param operationId - Operation ID for this request
   * @returns Full webhook URL with macros replaced
   *
   * @example
   * ```typescript
   * // With template: "https://myapp.com/webhook/{task_type}/{agent_id}/{operation_id}"
   * const webhookUrl = client.getWebhookUrl('sync_creatives', 'op_123');
   * // Returns: https://myapp.com/webhook/sync_creatives/agent_x/op_123
   *
   * // With template: "https://myapp.com/webhook?agent={agent_id}&op={operation_id}"
   * const webhookUrl = client.getWebhookUrl('sync_creatives', 'op_123');
   * // Returns: https://myapp.com/webhook?agent=agent_x&op=op_123
   * ```
   */
  getWebhookUrl(taskType: string, operationId: string): string {
    if (!this.config.webhookUrlTemplate) {
      throw new Error('webhookUrlTemplate not configured - cannot generate webhook URL');
    }

    const webhookUrl = resolveWebhookUrl(this.config.webhookUrlTemplate, this.agent.id, taskType, operationId);
    if (!webhookUrl) {
      throw new Error(`webhookUrlTemplate not configured for task type '${taskType}'`);
    }
    return webhookUrl;
  }

  /**
   * Create an HTTP webhook handler that automatically verifies signatures
   *
   * This helper creates a standard HTTP handler (Express/Next.js/etc.) that:
   * - Reads the full header bag so duplicate/conflicting signature headers are rejected
   * - Verifies the registered RFC 9421 or legacy HMAC signature mode
   * - Validates signature freshness and RFC 9421 nonce replay
   * - Calls handleWebhook() with proper error handling
   *
   * @returns HTTP handler function compatible with Express-style adapters.
   *
   * @example Express
   * ```typescript
   * const client = new SingleAgentClient(agent, {
   *   webhookUrlTemplate: 'https://buyer.example/webhook/{task_type}/{operation_id}',
   *   handlers: {
   *     onSyncCreativesStatusChange: async (result) => {
   *       console.log('Creative synced:', result);
   *     }
   *   }
   * });
   *
   * app.post(
   *   '/webhook/:task_type/:operation_id',
   *   express.raw({ type: 'application/json' }),
   *   client.createWebhookHandler({
   *     getRequestUrl: req => `https://buyer.example${req.originalUrl}`,
   *   }),
   * );
   * ```
   */
  createWebhookHandler(adapter: WebhookHandlerAdapter = {}) {
    return async (
      req: WebhookHandlerRequest,
      res: {
        status: (code: number) => { json: (body: unknown) => void };
        json?: unknown;
        writeHead: (code: number, headers: Record<string, string>) => void;
        end: (body: string) => void;
      }
    ) => {
      try {
        // Capture raw body bytes for signature verification, then parse.
        const rawBody =
          req.rawBody ??
          (typeof req.body === 'string' || Buffer.isBuffer(req.body) || req.body instanceof Uint8Array
            ? req.body
            : undefined);
        if (this.config.webhookSecret && rawBody === undefined) {
          throw new WebhookDispatchError(
            'webhook_signature_invalid',
            'Raw webhook body required for HMAC signature verification; capture bytes before JSON parsing.'
          );
        }
        const payload =
          typeof req.body === 'string' || Buffer.isBuffer(req.body) || req.body instanceof Uint8Array
            ? undefined
            : req.body;

        // Extract routing params if available (e.g., Express route params)
        const taskType =
          (await adapter.getTaskType?.(req)) || req.params?.task_type || req.params?.taskType || 'unknown';
        const operationId =
          (await adapter.getOperationId?.(req)) || req.params?.operation_id || req.params?.operationId || 'unknown';
        const requestMethod = (await adapter.getRequestMethod?.(req)) || req.method;
        const requestUrl = (await adapter.getRequestUrl?.(req)) || req.publicUrl;

        const parsed = await this.verifyAndParseWebhook({
          payload,
          body: req.body,
          rawBody,
          headers: req.headers,
          taskType,
          operationId,
          requestMethod,
          requestUrl,
        });
        if (!parsed.ok) {
          throw new WebhookDispatchError(parsed.code, parsed.message, parsed.cause);
        }

        const handled = await this.dispatchParsedWebhook(parsed);

        // Return success
        if (res.json) {
          res.status(202).json({ status: 'accepted', received: handled });
        } else {
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'accepted', received: handled }));
        }
      } catch (error: unknown) {
        // Stable verification/dispatch errors are safe for callers. Never
        // reflect arbitrary handler, storage, or infrastructure messages.
        const errorMessage = error instanceof WebhookDispatchError ? error.message : 'Webhook could not be processed.';
        const statusCode = webhookErrorHttpStatus(error);

        if (res.json) {
          res.status(statusCode).json({ error: errorMessage });
        } else {
          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: errorMessage }));
        }
      }
    };
  }

  /**
   * Verify webhook signature using HMAC-SHA256 per AdCP spec.
   *
   * HMAC is computed over the **raw HTTP body bytes** — the exact bytes received
   * on the wire, before JSON parsing. This ensures cross-language interop since
   * different JSON serializers may produce different byte representations of the
   * same logical payload.
   *
   * For backward compatibility, a parsed object is still accepted but will be
   * re-serialized with JSON.stringify, which may not match the sender's bytes.
   * Always prefer passing the raw body string.
   *
   * Signature format: sha256={hex_signature}
   * Message format: {timestamp}.{raw_body}
   *
   * @param rawBodyOrPayload - Raw HTTP body string (preferred) or parsed payload object (deprecated)
   * @param signature - X-ADCP-Signature header value (format: "sha256=...")
   * @param timestamp - X-ADCP-Timestamp header value (Unix timestamp)
   * @returns true if signature is valid
   */
  verifyWebhookSignature(
    rawBodyOrPayload: string | Buffer | Uint8Array | unknown,
    signature: WebhookHeaderValue,
    timestamp: WebhookHeaderValue
  ): boolean {
    if (!this.config.webhookSecret) {
      return false;
    }

    // Use raw body bytes when available; fall back to JSON.stringify for backward compat
    const rawBody =
      typeof rawBodyOrPayload === 'string' ||
      Buffer.isBuffer(rawBodyOrPayload) ||
      rawBodyOrPayload instanceof Uint8Array
        ? rawBodyOrPayload
        : String(JSON.stringify(rawBodyOrPayload));

    return verifyWebhookRequest({
      rawBody,
      secret: this.config.webhookSecret,
      signature,
      timestamp,
    }).ok;
  }

  /**
   * Execute task and call appropriate handler on completion
   *
   * Adapts requests for maintained AdCP 3 releases and normalizes product responses.
   */
  private async executeAndHandle<T>(
    taskType: string,
    handlerName: keyof AsyncHandlerConfig,
    params: any,
    inputHandler?: InputHandler,
    options?: TaskOptions,
    transformCompletedResponse?: (data: T) => T,
    legacyFormatConverter?: LegacyFormatConverter,
    canonicalRequest?: unknown,
    projectionCatalogs?: readonly ProjectionCatalogSnapshot[]
  ): Promise<TaskResult<T>> {
    const requestParamsSnapshot = structuredClone(params);
    const canonicalRequestSnapshot = canonicalRequest === undefined ? undefined : structuredClone(canonicalRequest);
    const deferredProjectionCatalogs = projectionCatalogs ? structuredClone(projectionCatalogs) : undefined;
    const taskOptionsSnapshot = snapshotTaskOptions(options);
    return withTaskDeadline(taskOptionsSnapshot, effectiveOptions =>
      this.executeAndHandleWithinDeadline(
        taskType,
        handlerName,
        requestParamsSnapshot,
        inputHandler,
        effectiveOptions,
        transformCompletedResponse,
        legacyFormatConverter,
        canonicalRequestSnapshot,
        deferredProjectionCatalogs
      )
    );
  }

  private async executeAndHandleWithinDeadline<T>(
    taskType: string,
    handlerName: keyof AsyncHandlerConfig,
    params: any,
    inputHandler?: InputHandler,
    options?: TaskOptions,
    transformCompletedResponse?: (data: T) => T,
    legacyFormatConverter?: LegacyFormatConverter,
    canonicalRequest?: unknown,
    projectionCatalogs?: readonly ProjectionCatalogSnapshot[]
  ): Promise<TaskResult<T>> {
    throwIfAborted(options?.signal);
    const canonicalCreativeInvocation =
      CANONICAL_CREATIVE_ACTIVITY_TASKS.has(taskType) || canonicalRequest !== undefined;
    params = await this.applyAccountPolicy(taskType, params, options);
    // Normalize params for backwards compatibility before validation
    let normalizedParams = options?.preserveGovernedPayload
      ? params
      : normalizeRequestParams(taskType, params, {
          skipIdempotencyAutoInject: options?.skipIdempotencyAutoInject,
          skipAccountValidation: options?.skipAccountValidation,
        });
    if (!options?.skipRequestValidation) assertNoPrincipalIdentityInput(taskType, normalizedParams);
    this.assertRequestSupportedByConfiguredVersion(taskType, normalizedParams, options, canonicalCreativeInvocation);
    this.assertDurablePropertyListCredentialSupported(taskType, normalizedParams);

    // Inject an idempotency_key for mutating tools before schema validation
    // so callers don't have to supply one. TaskExecutor also guards against
    // missing keys, but validation happens here first — do the injection up
    // front so the request passes the spec's required-field check.
    // `options.skipIdempotencyAutoInject` disables this for compliance
    // testing that needs to exercise server-side missing-key behavior.
    if (
      !options?.skipIdempotencyAutoInject &&
      !options?.preserveGovernedPayload &&
      requestUsesIdempotency(taskType, normalizedParams) &&
      normalizedParams &&
      typeof normalizedParams === 'object' &&
      !normalizedParams.idempotency_key
    ) {
      normalizedParams = { ...normalizedParams, idempotency_key: generateIdempotencyKey() };
    }

    // Validate request params against schema. Compliance-only malformed-input
    // vectors can skip this pass explicitly (or implicitly through the older
    // missing-idempotency/account escape hatches) so the seller receives the
    // request it is meant to validate. An explicit external schema root also
    // skips this generated snapshot; TaskExecutor's AJV pass below validates
    // the same request against the caller-supplied current-source bundle.
    if (
      !options?.skipIdempotencyAutoInject &&
      !options?.skipAccountValidation &&
      !options?.skipRequestValidation &&
      !options?.preserveGovernedPayload &&
      !isExternalSchemaRootActive(this.resolvedAdcpVersion)
    ) {
      this.validateRequest(taskType, normalizedParams);
    }

    // Validate required features before sending request
    await this.validateTaskFeatures(taskType, options);
    throwIfAborted(options?.signal);

    // Guard mutating calls against pre-v3 sellers when opted in.
    if (this.config.requireV3ForMutations && requestUsesIdempotency(taskType, normalizedParams)) {
      await this.requireSupportedMajor(taskType, options);
      throwIfAborted(options?.signal);
    }

    const agent = await this.ensureEndpointDiscovered(options);
    throwIfAborted(options?.signal);

    // Schema-driven pre-send validation runs on the unadapted v3 shape so
    // wire-format adapters (e.g. adaptGetProductsRequestForV2) don't strip
    // v3-only fields out from under the v3 bundled schema. Skip the entire
    // Zod parse when compliance testing has suppressed request validation —
    // the invalid shape is intentional and must reach the seller.
    if (
      !options?.skipIdempotencyAutoInject &&
      !options?.skipAccountValidation &&
      !options?.skipRequestValidation &&
      !options?.preserveGovernedPayload
    ) {
      this.executor.validateRequest(taskType, normalizedParams);
    }

    // Adapt request for the detected server and AdCP protocol versions.
    const capabilityDiscoveryContext: CapabilityDiscoveryContext = {};
    const detectionOptions: InternalReadRequestOptions = {
      ...options,
      [CAPABILITY_DISCOVERY_CONTEXT]: capabilityDiscoveryContext,
    };
    const serverVersion = await this.detectServerVersion(detectionOptions);
    throwIfAborted(options?.signal);
    const negotiatedRelease = this.negotiateCallRelease(capabilityDiscoveryContext.capabilities, options);
    this.assertToolAvailableAtRelease(taskType, negotiatedRelease, capabilityDiscoveryContext.toolSchemas);
    this.assertRequestSupportedByTargetVersion(
      taskType,
      normalizedParams,
      capabilityDiscoveryContext.capabilities,
      canonicalCreativeInvocation,
      serverVersion,
      negotiatedRelease
    );
    const { options: webhookOptions, driftLog: webhookDriftLog } = this.suppressPre31DiscoveryWebhook(
      taskType,
      options,
      capabilityDiscoveryContext.capabilities
    );
    const effectiveOptions = this.withNegotiatedRelease(webhookOptions, negotiatedRelease);
    const inputSchemaStripLogs: any[] = [];
    if (options?.preserveGovernedPayload && serverVersion !== 'v3') {
      throw new ConfigurationError(
        'Governed storyboard requests require a v3 seller to preserve the approved payload.'
      );
    }
    const { params: convertedParams, driftLogs: adaptDriftLogs } = options?.preserveGovernedPayload
      ? { params: normalizedParams, driftLogs: [] }
      : this.adaptRequest(
          taskType,
          normalizedParams,
          serverVersion,
          inputSchemaStripLogs,
          capabilityDiscoveryContext.toolSchemas,
          capabilityDiscoveryContext.capabilities,
          negotiatedRelease
        );
    const adaptedParams = options?.preserveGovernedPayload
      ? convertedParams
      : await this.reconcileAccountKeyReductions(
          taskType,
          normalizedParams,
          convertedParams,
          negotiatedRelease,
          adaptDriftLogs
        );
    if (
      negotiatedRelease?.downgraded &&
      !options?.skipIdempotencyAutoInject &&
      !options?.skipAccountValidation &&
      !options?.skipRequestValidation
    ) {
      // Validate the converted request against the release on the wire. The
      // same three flags gate the pre-conversion check above: compliance
      // vectors that skip idempotency-key injection or account validation send
      // a deliberately invalid request, which this check would reject before
      // the seller can grade it.
      this.executor.validateRequest(taskType, adaptedParams, inputSchemaStripLogs, negotiatedRelease.version);
    }

    const adaptationLogs: any[] = [...adaptDriftLogs];
    if (webhookDriftLog) adaptationLogs.push(webhookDriftLog);

    const canonicalInputHandler = this.canonicalCreativeInputHandler(
      taskType,
      inputHandler,
      canonicalCreativeInvocation
    );
    const routingSnapshot = canonicalCreativeInvocation
      ? canonicalCreativeRoutingSnapshot(taskType, canonicalRequest ?? normalizedParams)
      : undefined;
    const deferredClientContext: DeferredClientFinalizationContext = {
      kind: 'single-agent',
      taskType,
      handlerName,
      canonical: canonicalCreativeInvocation,
      serverVersion,
      ...(capabilityDiscoveryContext.capabilities?._synthetic !== undefined && {
        serverVersionSynthetic: capabilityDiscoveryContext.capabilities._synthetic,
      }),
      ...(negotiatedRelease?.downgraded && { negotiatedAdcpVersion: negotiatedRelease.version }),
      productPolicyRequest: productPolicyRequestSnapshot(normalizedParams),
      accountRegistry: this.accountRegistryContext(taskType, normalizedParams, effectiveOptions),
      ...(projectionCatalogs !== undefined && { projectionCatalogs }),
      ...(routingSnapshot !== undefined && { routingSnapshot }),
      ...(effectiveOptions?.taskId !== undefined && { optionTaskId: effectiveOptions.taskId }),
      ...(effectiveOptions?.contextId !== undefined && { optionContextId: effectiveOptions.contextId }),
      ...(effectiveOptions?.skipStatusHandlers !== undefined && {
        skipStatusHandlers: effectiveOptions.skipStatusHandlers,
      }),
    };
    let result = await canonicalCreativeExecutionStorage.run(
      {
        taskType,
        canonical: canonicalCreativeInvocation,
        legacyFormatConverter,
        canonicalRequest: canonicalRequest ?? normalizedParams,
      },
      () =>
        this.executor.executeTask<T>(
          agent,
          taskType,
          adaptedParams,
          canonicalInputHandler,
          effectiveOptions,
          serverVersion,
          capabilityDiscoveryContext.capabilities,
          undefined,
          deferredClientContext
        )
    );
    throwIfAborted(effectiveOptions?.signal);
    if (!result.success) await this.invalidateDiscoveryOnCapabilityError(result.adcpError?.code, effectiveOptions);

    // Merge collected drift into the executor's debug_logs so adopters
    // reading result.debug_logs see input-schema stripping, post-adapter
    // adaptation and pre-3.1 webhook-degradation notices alongside
    // the executor's own logs. On error paths the executor may not surface
    // result.debug_logs at all; logs collected before the failure are
    // dropped, matching the executor's own debug-log behavior.
    const postAdapterLogs = [...inputSchemaStripLogs, ...adaptationLogs];
    if (postAdapterLogs.length > 0) {
      result.debug_logs = [...(result.debug_logs ?? []), ...postAdapterLogs];
    }

    return this.finalizeTaskResult(
      result,
      deferredClientContext,
      effectiveOptions,
      transformCompletedResponse,
      legacyFormatConverter
    );
  }

  private async finalizeTaskResult<T>(
    result: TaskResult<T>,
    context: DeferredClientFinalizationContext,
    options?: TaskOptions,
    transformCompletedResponse?: (data: T) => T,
    legacyFormatConverter?: LegacyFormatConverter
  ): Promise<TaskResult<T>> {
    try {
      return await this.finalizeTaskResultInner(
        result,
        context,
        options,
        transformCompletedResponse,
        legacyFormatConverter
      );
    } catch (error) {
      await rejectDeferredSettlement(result);
      throw error;
    }
  }

  private async finalizeTaskResultInner<T>(
    result: TaskResult<T>,
    context: DeferredClientFinalizationContext,
    options?: TaskOptions,
    transformCompletedResponse?: (data: T) => T,
    legacyFormatConverter?: LegacyFormatConverter
  ): Promise<TaskResult<T>> {
    if (context.serverVersion !== undefined) {
      result.metadata = {
        ...result.metadata,
        serverVersion: context.serverVersion,
        ...(context.serverVersionSynthetic !== undefined && {
          serverVersionSynthetic: context.serverVersionSynthetic,
        }),
      };
    }
    if (context.negotiatedAdcpVersion !== undefined) {
      result.metadata = { ...result.metadata, negotiatedAdcpVersion: context.negotiatedAdcpVersion };
      if (result.metadata.taskId) this.rememberNegotiatedRelease(result.metadata.taskId, context.negotiatedAdcpVersion);
      if (result.success && result.data) {
        const converted = this.convertResponseToClientRelease(
          context.taskType,
          result.data,
          context.negotiatedAdcpVersion
        );
        result.data = converted.data as T;
        if (converted.driftLogs.length > 0) {
          result.debug_logs = [...(result.debug_logs ?? []), ...converted.driftLogs];
        }
      }
    }
    const completionHandlerAlreadyPublished = hasCompletionHandlerAlreadyPublished(result);
    const settlementAcknowledger = (
      result as TaskResult<T> & {
        [DEFERRED_SETTLEMENT_ACK]?: (finalizedResult?: TaskResult<T>) => Promise<void>;
      }
    )[DEFERRED_SETTLEMENT_ACK];
    const taskType = context.taskType;
    if (
      context.accountRegistry !== undefined &&
      context.accountRegistry.scope === this.accountScope() &&
      result.success &&
      result.status === 'completed' &&
      result.data &&
      typeof result.data === 'object' &&
      'accounts' in result.data &&
      Array.isArray(result.data.accounts)
    ) {
      try {
        const registry = this.getAccountRegistry();
        let refs = context.accountRegistry.refs ?? [];
        let rows: readonly unknown[] = result.data.accounts;
        if (context.accountRegistry.knownOnly) {
          refs = (await Promise.all(refs.map(async ref => ((await registry.get(ref)) ? ref : undefined)))).filter(
            (ref): ref is AccountReference => ref !== undefined
          );
          if (taskType === 'list_accounts') {
            rows = (
              await Promise.all(
                result.data.accounts.map(async row => {
                  const ref = canonicalAccountRoutingSnapshot(row);
                  if (ref && (await registry.get(ref as AccountReference))) return row;
                  const natural = canonicalAccountRoutingSnapshot({ ...row, account_id: undefined });
                  return natural && (await registry.get(natural as AccountReference)) ? row : undefined;
                })
              )
            ).filter(row => row !== undefined);
          }
        }
        if (context.accountRegistry.scope !== this.accountScope()) return result;
        if (taskType === 'sync_accounts')
          await registry.observeSync(
            refs,
            rows,
            context.accountRegistry.dryRun,
            context.accountRegistry.observationEpoch
          );
        if (taskType === 'list_accounts') {
          const ref = refs[0];
          await registry.observeList(
            rows,
            ref &&
              'account_id' in ref &&
              (!(result.data as unknown as ListAccountsResponse).pagination?.has_more ||
                result.data.accounts.some(row => (row as { account_id?: string }).account_id === ref.account_id))
              ? ref.account_id
              : undefined,
            context.accountRegistry.observationEpoch
          );
        }
      } catch {
        result.debug_logs = [
          ...(result.debug_logs ?? []),
          {
            level: 'warn',
            timestamp: new Date().toISOString(),
            message:
              'Account registry observation failed. The seller operation completed; reconcile with listAccounts before relying on the registry.',
          },
        ];
      }
    }
    const resumedOptions: TaskOptions = {
      ...(options ?? {}),
      ...(context.optionTaskId !== undefined && { taskId: context.optionTaskId }),
      ...(context.optionContextId !== undefined && { contextId: context.optionContextId }),
      ...(context.skipStatusHandlers !== undefined && { skipStatusHandlers: context.skipStatusHandlers }),
    };
    const rawDeferredResume = result.deferred?.resume;
    const rawSubmittedWaitForCompletion = result.submitted?.waitForCompletion;
    const finalizerLegacyFormatConverter =
      legacyFormatConverter ?? this.resolveLegacyFormatConverter(undefined, context.projectionCatalogs);

    if (result.success && result.data) {
      result.data = this.normalizeEstablishedResponse(taskType, result.data) as T;
    }

    result = this.wrapProductPolicySubmittedContinuation(
      result,
      taskType,
      context.productPolicyRequest,
      resumedOptions
    );
    if (result.status === 'working') {
      this.rememberProductPolicyRequestParams(taskType, context.productPolicyRequest, result, resumedOptions);
    }
    this.rememberLegacyFormatConverter(taskType, finalizerLegacyFormatConverter, result, resumedOptions);
    result = await this.applyProductPropertyPolicy(result, taskType, context.productPolicyRequest, options?.signal);
    throwIfAborted(options?.signal);

    if (context.canonical) {
      if (result.status === 'completed' && result.success && result.data) {
        this.rememberCanonicalProductRoutesForCompletion(
          taskType,
          result.data,
          finalizerLegacyFormatConverter,
          context.productPolicyRequest.account
        );
      }
      result = this.canonicalizeCreativeTaskResult(
        result,
        taskType,
        transformCompletedResponse,
        finalizerLegacyFormatConverter
      );
      result = this.wrapCanonicalCreativeContinuations(
        result,
        taskType,
        transformCompletedResponse,
        finalizerLegacyFormatConverter,
        context.routingSnapshot,
        context.productPolicyRequest.account
      );
      this.rememberCanonicalCreativeTaskIds(result, taskType, finalizerLegacyFormatConverter, context.routingSnapshot);
      if (result.success && result.status === 'completed' && result.data !== undefined) {
        this.rememberCanonicalPackageRoutesForTask(taskType, result.data, context.routingSnapshot);
      }
    } else if (result.status === 'completed' && result.success && result.data && transformCompletedResponse) {
      result = { ...result, data: transformCompletedResponse(result.data) };
    }

    if (context.handlerName) {
      this.rememberPreviewCreativeHandler(result, taskType, context.handlerName, resumedOptions);
      if (!completionHandlerAlreadyPublished) {
        await this.notifyCompletedStatusHandler(result, taskType, context.handlerName, resumedOptions);
        markCompletionHandlerAlreadyPublished(result);
      }
    }

    // Replace the canonical wrapper's recursive closure with the shared
    // finalizer. Durable tokens re-enter the public client path after restart;
    // in-process tokens keep their one-shot executor closure.
    if (result.deferred && rawDeferredResume) {
      result.deferred = {
        ...result.deferred,
        resume: input =>
          rawDeferredResume(input).then(next =>
            this.finalizeTaskResult(next, context, options, transformCompletedResponse, finalizerLegacyFormatConverter)
          ),
      };
    }
    if (result.submitted && rawSubmittedWaitForCompletion) {
      result.submitted = {
        ...result.submitted,
        waitForCompletion: async (pollInterval, signal) => {
          const signals = [options?.signal, signal].filter(
            (candidate): candidate is AbortSignal => candidate !== undefined
          );
          const completionSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
          const completionOptions = { ...(options ?? {}), ...(completionSignal ? { signal: completionSignal } : {}) };
          const completed = await rawSubmittedWaitForCompletion(pollInterval, signal);
          return this.finalizeTaskResult(
            completed,
            context,
            completed.success && completed.status === 'completed' ? completionOptions : options,
            transformCompletedResponse,
            finalizerLegacyFormatConverter
          );
        },
      };
    }

    const finalized = attachMatch(result);
    await settlementAcknowledger?.(finalized);
    return finalized;
  }

  private async notifyCompletedStatusHandler<T>(
    result: TaskResult<T>,
    taskType: string,
    handlerName: keyof AsyncHandlerConfig,
    options?: TaskOptions
  ): Promise<void> {
    if (options?.skipStatusHandlers === true || result.status !== 'completed' || !result.success || !this.asyncHandler)
      return;
    const handler = this.config.handlers?.[handlerName] as
      | ((data: unknown, metadata: WebhookMetadata) => void | Promise<void>)
      | undefined;
    if (!handler) return;
    throwIfAborted(options?.signal);
    const metadata: WebhookMetadata = {
      operation_id: options?.contextId || 'sync',
      context_id: options?.contextId,
      task_id: result.metadata.taskId,
      agent_id: this.agent.id,
      task_type: taskType,
      status: result.status,
      timestamp: new Date().toISOString(),
    };
    try {
      await handler(result.data, metadata);
    } catch (error) {
      if (this.config.isolateStatusHandlerErrors !== true) throw error;
      throwIfAborted(options?.signal);
      result.debug_logs = [
        ...(result.debug_logs ?? []),
        {
          level: 'warn',
          timestamp: new Date().toISOString(),
          message: 'Inline status handler failed. The seller operation completed; reconcile local post-processing.',
        },
      ];
      try {
        await this.config.onStatusHandlerError?.(error, { handlerName, metadata });
      } catch {
        result.debug_logs.push({
          level: 'warn',
          timestamp: new Date().toISOString(),
          message: 'onStatusHandlerError observer failed. The seller operation completed.',
        });
      }
    }
    throwIfAborted(options?.signal);
  }

  private canonicalCreativeInputHandler(
    taskType: string,
    inputHandler?: InputHandler,
    canonical = CANONICAL_CREATIVE_ACTIVITY_TASKS.has(taskType)
  ): InputHandler | undefined {
    if (!inputHandler || !canonical) return inputHandler;
    return async context => {
      const active = canonicalCreativeExecutionStorage.getStore();
      const converter = this.finalLegacyFormatConverter(
        active?.taskType === taskType ? active.legacyFormatConverter : undefined
      );
      const project = <T>(value: T): CanonicalCreativeResponse<T> =>
        projectCanonicalCreativeAncillaryValue(value, taskType, converter) as CanonicalCreativeResponse<T>;
      const messages = context.messages.map(message => ({
        ...message,
        content: project(message.content),
      })) as typeof context.messages;
      const safeContext = {
        ...context,
        messages,
        inputRequest: project(context.inputRequest) as typeof context.inputRequest,
        getSummary: () => messages.map(message => `${message.role}: ${JSON.stringify(message.content)}`).join('\n'),
        getPreviousResponse: (field: string) => project(context.getPreviousResponse(field)),
      };
      return inputHandler(safeContext);
    };
  }

  private projectCanonicalCreativeData<T>(
    taskType: string,
    data: T,
    transform?: (data: T) => T,
    legacyFormatConverter?: LegacyFormatConverter
  ): CanonicalCreativeResponse<T> {
    let projected = this.normalizeEstablishedResponse(taskType, data) as T;
    const record = projected && typeof projected === 'object' ? (projected as Record<string, unknown>) : undefined;
    const canProjectRead =
      taskType === 'get_products'
        ? Array.isArray(record?.products)
        : taskType === 'list_creatives'
          ? Array.isArray(record?.creatives)
          : true;
    if (transform && canProjectRead) {
      projected = transform(projected);
    } else if (canProjectRead && taskType === 'get_products' && record) {
      const active = canonicalCreativeExecutionStorage.getStore();
      const converter = this.finalLegacyFormatConverter(
        legacyFormatConverter ?? (active?.taskType === taskType ? active.legacyFormatConverter : undefined)
      );
      const { response, diagnostics } = toCanonicalOnlyResponse(record as { products?: V1Product[] }, {
        legacyFormatConverter: converter,
      });
      const { _message: _dropLegacyMessage, ...canonical } = response as typeof response & { _message?: unknown };
      void _dropLegacyMessage;
      projected = { ...canonical, projection: { diagnostics } } as T;
    } else if (canProjectRead && taskType === 'list_creatives' && record) {
      const active = canonicalCreativeExecutionStorage.getStore();
      const activeLegacyFormatConverter = this.finalLegacyFormatConverter(
        legacyFormatConverter ?? (active?.taskType === taskType ? active.legacyFormatConverter : undefined)
      );
      const { _message: _dropLegacyMessage, ...safe } = record;
      void _dropLegacyMessage;
      projected = {
        ...safe,
        creatives: (record.creatives as unknown[]).map(creative =>
          projectCreativeForDelivery(
            creative as import('../types/tools.generated').CreativeAsset,
            {},
            'canonical',
            'list_creatives',
            activeLegacyFormatConverter
          )
        ),
      } as T;
    } else if (canProjectRead && CANONICAL_CREATIVE_ACTIVITY_TASKS.has(taskType)) {
      const active = canonicalCreativeExecutionStorage.getStore();
      projected = projectCanonicalCreativeResponseValue(
        projected,
        taskType,
        this.finalLegacyFormatConverter(
          legacyFormatConverter ?? (active?.taskType === taskType ? active.legacyFormatConverter : undefined)
        )
      ) as T;
    }
    return stripLegacyCreativeIdentity(projected);
  }

  private canonicalizeCreativeTaskResult<T>(
    result: TaskResult<T>,
    taskType: string,
    transform?: (data: T) => T,
    legacyFormatConverter?: LegacyFormatConverter
  ): TaskResult<T> {
    const projectedData =
      result.data !== undefined
        ? this.projectCanonicalCreativeData(taskType, result.data, transform, legacyFormatConverter)
        : undefined;
    const errorInstance = result.errorInstance;
    const converter = this.finalLegacyFormatConverter(legacyFormatConverter);
    const metadataRecord = result.metadata as TaskResult<T>['metadata'] & { inputRequest?: unknown };
    const semanticMetadata = {
      ...metadataRecord,
      ...(metadataRecord.inputRequest !== undefined && {
        inputRequest: projectCanonicalCreativeAncillaryValue(metadataRecord.inputRequest, taskType, converter),
      }),
    };
    const semanticConversation = result.conversation?.map(message => ({
      ...message,
      content: projectCanonicalCreativeAncillaryValue(message.content, taskType, converter),
    }));
    const safe = stripLegacyCreativeIdentity({
      data: projectedData,
      metadata: semanticMetadata,
      conversation: semanticConversation,
      debug_logs: result.debug_logs,
      adcpError: result.adcpError,
      error: result.error,
      governance: result.governance,
      governanceOutcome: result.governanceOutcome,
      governanceOutcomeError: result.governanceOutcomeError,
      deferredQuestion: result.deferred?.question,
      // Token source only: discarded below, but lets the sanitizer remove exact
      // legacy IDs/URLs when the seller repeats them in messages or diagnostics.
      legacySource: result.data,
    }) as Record<string, any>;

    const safeErrorInstance = errorInstance ? canonicalCreativeErrorInstance(errorInstance, result.data) : undefined;

    const safeDeferred = result.deferred
      ? { ...result.deferred, ...(result.deferred.question !== undefined && { question: safe.deferredQuestion }) }
      : undefined;

    return attachMatch({
      ...result,
      ...(result.data !== undefined && { data: safe.data as T }),
      metadata: safe.metadata,
      ...(result.conversation !== undefined && { conversation: safe.conversation }),
      ...(result.debug_logs !== undefined && { debug_logs: safe.debug_logs }),
      ...(result.adcpError !== undefined && { adcpError: safe.adcpError }),
      ...(result.error !== undefined && { error: safe.error }),
      ...(result.governance !== undefined && { governance: safe.governance }),
      ...(result.governanceOutcome !== undefined && { governanceOutcome: safe.governanceOutcome }),
      ...(result.governanceOutcomeError !== undefined && { governanceOutcomeError: safe.governanceOutcomeError }),
      ...(safeDeferred !== undefined && { deferred: safeDeferred }),
      ...(safeErrorInstance !== undefined && { errorInstance: safeErrorInstance }),
    } as TaskResult<T>);
  }

  private canonicalizeCreativeTaskInfo<T>(
    taskInfo: TaskInfo,
    taskType: string,
    transform?: (data: T) => T,
    legacyFormatConverter?: LegacyFormatConverter
  ): TaskInfo {
    const source = taskInfo.result;
    const projected =
      source !== undefined
        ? this.projectCanonicalCreativeData(taskType, source as T, transform, legacyFormatConverter)
        : undefined;
    const { legacySource: _dropLegacySource, ...safe } = stripLegacyCreativeIdentity({
      ...taskInfo,
      taskType,
      ...(source !== undefined && { result: projected }),
      legacySource: source,
    }) as TaskInfo & { legacySource?: unknown };
    void _dropLegacySource;
    return safe as TaskInfo;
  }

  private wrapCanonicalCreativeContinuations<T>(
    result: TaskResult<T>,
    taskType: string,
    transform?: (data: T) => T,
    legacyFormatConverter?: LegacyFormatConverter,
    routingRequest?: unknown,
    productAccount?: unknown
  ): TaskResult<T> {
    const routingSnapshot = canonicalCreativeRoutingSnapshot(taskType, routingRequest);
    if (result.submitted) {
      const submitted = result.submitted;
      result = {
        ...result,
        submitted: {
          ...submitted,
          track: async transport => {
            const tracked = await canonicalCreativeExecutionStorage.run(
              { taskType, canonical: true, legacyFormatConverter },
              () => submitted.track(transport)
            );
            if (tracked.status === 'completed' && tracked.result !== undefined) {
              this.rememberCanonicalProductRoutesForCompletion(
                taskType,
                tracked.result,
                legacyFormatConverter,
                productAccount
              );
            }
            const canonical = this.canonicalizeCreativeTaskInfo<T>(tracked, taskType, transform, legacyFormatConverter);
            if (canonical.status === 'completed' && canonical.result !== undefined) {
              this.rememberCanonicalPackageRoutesForTask(taskType, canonical.result, routingSnapshot);
            }
            return canonical;
          },
          waitForCompletion: async (pollInterval, signal) => {
            const completed = await canonicalCreativeExecutionStorage.run(
              { taskType, canonical: true, legacyFormatConverter },
              () => submitted.waitForCompletion(pollInterval, signal)
            );
            if (completed.success && completed.status === 'completed' && completed.data !== undefined) {
              this.rememberCanonicalProductRoutesForCompletion(
                taskType,
                completed.data,
                legacyFormatConverter,
                productAccount
              );
            }
            const canonical = this.canonicalizeCreativeTaskResult(
              completed,
              taskType,
              transform,
              legacyFormatConverter
            );
            if (canonical.success && canonical.status === 'completed' && canonical.data !== undefined) {
              this.rememberCanonicalPackageRoutesForTask(taskType, canonical.data, routingSnapshot);
            }
            this.rememberCanonicalCreativeTaskIds(canonical, taskType, legacyFormatConverter, routingSnapshot);
            return this.wrapCanonicalCreativeContinuations(
              canonical,
              taskType,
              transform,
              legacyFormatConverter,
              routingSnapshot,
              productAccount
            );
          },
        },
      } as TaskResult<T>;
    }
    if (result.deferred) {
      const deferred = result.deferred;
      result = {
        ...result,
        deferred: {
          ...deferred,
          resume: async input => {
            const resumed = await canonicalCreativeExecutionStorage.run(
              { taskType, canonical: true, legacyFormatConverter },
              () => deferred.resume(input)
            );
            const canonical = this.canonicalizeCreativeTaskResult(resumed, taskType, transform, legacyFormatConverter);
            if (canonical.success && canonical.status === 'completed' && canonical.data !== undefined) {
              this.rememberCanonicalPackageRoutesForTask(taskType, canonical.data, routingSnapshot);
            }
            this.rememberCanonicalCreativeTaskIds(canonical, taskType, legacyFormatConverter, routingSnapshot);
            return this.wrapCanonicalCreativeContinuations(
              canonical,
              taskType,
              transform,
              legacyFormatConverter,
              routingSnapshot,
              productAccount
            );
          },
        },
      } as TaskResult<T>;
    }
    return attachMatch(result);
  }

  private rememberCanonicalCreativeTaskIds<T>(
    result: TaskResult<T>,
    taskType: string,
    legacyFormatConverter?: LegacyFormatConverter,
    routingRequest?: unknown
  ): void {
    const routingSnapshot = canonicalCreativeRoutingSnapshot(taskType, routingRequest);
    const keys = [
      result.metadata.taskId,
      result.metadata.contextId,
      result.metadata.serverTaskId,
      result.submitted?.taskId,
    ];
    for (const key of keys) {
      if (!key) continue;
      this.rememberCanonicalCreativeTaskAssociation(key, taskType, legacyFormatConverter, routingSnapshot);
    }
  }

  private rememberPreviewCreativeHandler<T>(
    result: TaskResult<T>,
    taskType: string,
    handlerName: keyof AsyncHandlerConfig,
    options?: TaskOptions
  ): void {
    if (taskType !== 'preview_creative') return;
    const handler = handlerName === 'onPreviewCreativeLegacyStatusChange' ? 'legacy' : 'canonical';
    const metadata = result.metadata as typeof result.metadata & { operationId?: string };
    const keys = [
      metadata.operationId,
      metadata.taskId,
      metadata.contextId,
      metadata.serverTaskId,
      result.submitted?.taskId,
      options?.taskId,
      options?.contextId,
    ];
    for (const key of keys) {
      if (!key) continue;
      this.rememberPreviewCreativeHandlerKey(key, handler);
      if (handler === 'legacy') this.canonicalCreativeTaskAssociations.delete(key);
    }
  }

  private rememberPreviewCreativeHandlerKey(key: string, handler: 'canonical' | 'legacy'): void {
    this.previewCreativeHandlersByTask.delete(key);
    this.previewCreativeHandlersByTask.set(key, handler);
    while (this.previewCreativeHandlersByTask.size > TASK_SCOPED_STATE_LIMIT) {
      const oldest = this.previewCreativeHandlersByTask.keys().next().value;
      if (oldest === undefined) break;
      this.previewCreativeHandlersByTask.delete(oldest);
    }
  }

  private previewCreativeHandlerForWebhook(
    metadata: Pick<WebhookMetadata, 'operation_id' | 'task_id' | 'context_id' | 'task_type'>
  ): 'canonical' | 'legacy' | undefined {
    if (metadata.task_type !== 'preview_creative') return undefined;
    for (const key of [metadata.operation_id, metadata.task_id, metadata.context_id]) {
      if (!key) continue;
      const handler = this.previewCreativeHandlersByTask.get(key);
      if (!handler) continue;
      this.previewCreativeHandlersByTask.delete(key);
      this.previewCreativeHandlersByTask.set(key, handler);
      return handler;
    }
    return undefined;
  }

  private isCanonicalCreativeWebhook(
    metadata: Pick<WebhookMetadata, 'operation_id' | 'task_id' | 'context_id' | 'task_type'>
  ): boolean {
    if (CANONICAL_CREATIVE_ACTIVITY_TASKS.has(metadata.task_type)) return true;
    if (metadata.task_type !== 'preview_creative') return false;
    return [metadata.operation_id, metadata.task_id, metadata.context_id].some(
      key => this.canonicalCreativeTaskAssociation(key) !== undefined
    );
  }

  private rememberCanonicalCreativeTaskAssociation(
    key: string,
    taskType: string,
    legacyFormatConverter?: LegacyFormatConverter,
    canonicalRequest?: unknown
  ): void {
    const previous = this.canonicalCreativeTaskAssociations.get(key);
    const routingSnapshot = canonicalCreativeRoutingSnapshot(taskType, canonicalRequest);
    const effectiveRoutingSnapshot =
      routingSnapshot ?? (previous?.taskType === taskType ? previous.routingSnapshot : undefined);
    this.canonicalCreativeTaskAssociations.delete(key);
    this.canonicalCreativeTaskAssociations.set(key, {
      taskType,
      legacyFormatConverter,
      ...(effectiveRoutingSnapshot ? { routingSnapshot: effectiveRoutingSnapshot } : {}),
    });
    while (this.canonicalCreativeTaskAssociations.size > TASK_SCOPED_STATE_LIMIT) {
      const oldest = this.canonicalCreativeTaskAssociations.keys().next().value;
      if (oldest === undefined) break;
      this.canonicalCreativeTaskAssociations.delete(oldest);
    }
  }

  private canonicalCreativeTaskAssociation(key: string | undefined): CanonicalCreativeTaskAssociation | undefined {
    if (!key) return undefined;
    const association = this.canonicalCreativeTaskAssociations.get(key);
    if (!association) return undefined;
    // Touch the entry so actively-polled tasks and continued conversations
    // survive ahead of abandoned associations when the cache reaches its cap.
    this.canonicalCreativeTaskAssociations.delete(key);
    this.canonicalCreativeTaskAssociations.set(key, association);
    return association;
  }

  private forgetCanonicalCreativeTaskAssociationKeys(keys: Array<string | undefined>): void {
    for (const key of keys) {
      if (key) this.canonicalCreativeTaskAssociations.delete(key);
    }
  }

  /**
   * Drop products that arrive without a usable `pricing_options[]` array from a
   * completed `get_products` response. `pricing_options` is required and
   * non-empty in AdCP 3.1; a product with no pricing model can't be bought, so
   * the SDK rejects it before callers and completion handlers see the list.
   *
   * Controlled by `config.validation.rejectProductsWithoutPricingOptions`
   * (default `true`) and applied on every completion path via
   * {@link applyProductPropertyPolicy}, independent of the response validation
   * mode.
   */
  private enforceProductPricingOptions<T>(result: TaskResult<T>, taskType: string): TaskResult<T> {
    if (taskType !== 'get_products') return result;
    if (this.config.validation?.rejectProductsWithoutPricingOptions === false) return result;
    if (!result.success || result.status !== 'completed' || !result.data) return result;

    const response = result.data as unknown as GetProductsResponse;
    const products = (response as { products?: unknown }).products;
    if (!Array.isArray(products) || products.length === 0) return result;

    const kept: unknown[] = [];
    const rejected: Array<{ index: number; product_id?: string }> = [];
    products.forEach((product, index) => {
      if (productHasPricingOptions(product)) {
        kept.push(product);
        return;
      }
      const productId = productIdForPricingDiagnostics(product);
      rejected.push({ index, ...(productId ? { product_id: productId } : {}) });
    });

    if (rejected.length === 0) return result;

    const message = `Rejected ${rejected.length} product${rejected.length === 1 ? '' : 's'} without pricing_options`;

    // Mutate in place (like the property-policy filter path) so the
    // non-enumerable `match` accessor and result identity survive.
    result.data = { ...(response as unknown as Record<string, unknown>), products: kept } as T;
    result.metadata = {
      ...result.metadata,
      productPricingPolicy: {
        ok: true,
        accepted_count: kept.length,
        rejected_count: rejected.length,
        rejected_products: rejected,
      },
    };
    result.debug_logs = [
      ...(result.debug_logs ?? []),
      {
        type: 'warning',
        message,
        timestamp: new Date().toISOString(),
        details: {
          code: 'product_missing_pricing_options',
          task: taskType,
          agent_id: this.agent.id,
          rejected_count: rejected.length,
          rejected_products: rejected,
        },
      },
    ];
    return result;
  }

  private async applyProductPropertyPolicy<T>(
    result: TaskResult<T>,
    taskType: string,
    requestParams: Record<string, unknown>,
    taskSignal?: AbortSignal
  ): Promise<TaskResult<T>> {
    // Reject non-transactable products (no pricing_options) before any
    // property-policy evaluation, regardless of whether a property policy is
    // configured. This runs on the same completion chokepoint so it covers the
    // sync, polling, track, and webhook paths uniformly.
    result = this.enforceProductPricingOptions(result, taskType);
    if (
      this.config.validation?.supplyPathVerification &&
      (taskType === 'get_products' || taskType === 'list_products') &&
      result.success &&
      result.status === 'completed' &&
      result.data
    ) {
      const data = result.data as { products?: object[] };
      if (Array.isArray(data.products)) {
        const configured = this.config.validation.supplyPathVerification;
        const signals = [configured.signal, taskSignal].filter((signal): signal is AbortSignal => signal !== undefined);
        const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
        const products = await annotateProductsSupplyPaths(data.products, this.agent.agent_uri, {
          ...configured,
          ...(signal ? { signal } : {}),
        });
        result = { ...result, data: { ...result.data, products } };
      }
    }

    const policyConfig = this.config.validation?.productPropertyPolicy;
    if (policyConfig === false || taskType !== 'get_products') return result;
    if (!result.success || result.status !== 'completed' || !result.data) return result;

    const response = result.data as unknown as GetProductsResponse;
    if (!Array.isArray(response.products)) return result;

    const requestPropertyList = propertyListReferenceFromRequest(requestParams);
    const {
      mode = 'filter',
      message = 'Property list not adhered to',
      enforceRequestPropertyList = true,
      propertyListResolveOptions,
      resolvePublisherProperties,
      maxPublisherLookups = 100,
      publisherLookupTimeoutMs = 10_000,
      publisherLookupBudgetMs = 10_000,
      ...explicitPolicy
    } = policyConfig || {};
    const policy: BuyerPropertyPolicy = {
      ...explicitPolicy,
    };

    let resolvedRequestPropertyList:
      | {
          listId: string;
          agentUrl: string;
          identifierCount: number;
          unsupportedIdentifierTypes: string[];
          cacheValidUntil?: string;
        }
      | undefined;

    const referenceError = propertyListReferenceError(requestParams);
    if ((requestPropertyList || referenceError) && enforceRequestPropertyList) {
      try {
        if (referenceError) throw new Error(referenceError);
        const resolved = await resolvePropertyList(requestPropertyList!, propertyListResolveOptions);
        const unsupportedIdentifiers = unsupportedPropertyIdentifiers(resolved.identifiers);
        policy.allowedPropertyIdentifiers = [...(policy.allowedPropertyIdentifiers ?? []), ...resolved.identifiers];
        policy.requireAllowedPropertyMatch = true;
        policy.strict = policy.strict ?? true;
        resolvedRequestPropertyList = {
          listId: resolved.listId,
          agentUrl: resolved.agentUrl,
          identifierCount: resolved.identifiers.length,
          unsupportedIdentifierTypes: [...new Set(unsupportedIdentifiers.map(identifier => identifier.type))],
          ...(resolved.cacheValidUntil ? { cacheValidUntil: resolved.cacheValidUntil } : {}),
        };
      } catch (err) {
        const errorCode = propertyListResolutionErrorCode(err);
        const diagnosticAgentUrl = requestPropertyList
          ? sanitizeDiagnosticUrl(requestPropertyList.agent_url)
          : 'invalid_url';
        return attachMatch({
          success: false as const,
          status: 'failed' as const,
          data: response as unknown as T,
          error: `${message}: could not resolve property_list`,
          metadata: {
            ...result.metadata,
            status: 'failed',
            productPropertyPolicy: {
              mode,
              ok: false,
              accepted_count: 0,
              rejected_count: response.products.length,
              flagged_count: 0,
              message,
              diagnostics: [],
              request_property_list: {
                list_id: requestPropertyList?.list_id ?? 'invalid_reference',
                agent_url: diagnosticAgentUrl,
                resolution_error: errorCode,
              },
            },
          },
          conversation: result.conversation,
          debug_logs: [
            ...(result.debug_logs ?? []),
            {
              type: 'product_property_policy',
              message,
              mode,
              ok: false,
              request_property_list: {
                list_id: requestPropertyList?.list_id,
                agent_url: diagnosticAgentUrl,
                resolution_error: errorCode,
              },
            },
          ],
        });
      }
    }

    if (!hasProductPropertyPolicyRules(policy)) return result;

    if (
      resolvePublisherProperties &&
      policy.allowedPropertyIdentifiers?.some(
        identifier => identifier.type !== 'domain' && identifier.type !== 'subdomain'
      )
    ) {
      if (
        !Number.isSafeInteger(maxPublisherLookups) ||
        maxPublisherLookups < 1 ||
        !Number.isSafeInteger(publisherLookupTimeoutMs) ||
        publisherLookupTimeoutMs < 1 ||
        publisherLookupTimeoutMs > 2_147_483_647 ||
        !Number.isSafeInteger(publisherLookupBudgetMs) ||
        publisherLookupBudgetMs < 1 ||
        publisherLookupBudgetMs > 2_147_483_647
      ) {
        throw new ConfigurationError('Publisher lookup limits must be positive bounded integers');
      }
      const { validatePublisherDomain } = await import('../identifiers');
      const catalogs: NonNullable<BuyerPropertyPolicy['publisherProperties']> &
        Record<string, readonly ProductPolicyResolvedProperty[] | undefined> = Object.assign(
        Object.create(null),
        policy.publisherProperties
      );
      const domains = new Set(
        response.products.flatMap(product =>
          Array.isArray(product.publisher_properties)
            ? product.publisher_properties.flatMap(selector =>
                selector && typeof selector === 'object' && 'publisher_domain' in selector
                  ? [selector.publisher_domain]
                  : []
              )
            : []
        )
      );
      const hosts = [
        ...new Set(
          [...domains].flatMap(domain =>
            typeof domain === 'string' ? [normalizeDomainForPropertyPolicy(domain)?.host] : []
          )
        ),
      ].filter((host): host is string => typeof host === 'string' && !Object.hasOwn(catalogs, host));
      for (const host of hosts) catalogs[host] = undefined;
      const lookupStartedAt = performance.now();
      // Bound seller-driven fan-out; omitted/failed catalogs stay explicitly unknown.
      for (const host of hosts.slice(0, maxPublisherLookups)) {
        throwIfAborted(taskSignal);
        const remainingBudgetMs = publisherLookupBudgetMs - (performance.now() - lookupStartedAt);
        if (remainingBudgetMs <= 0) break;
        if (!validatePublisherDomain(host).ok || isLikelyPrivateUrl(`https://${host}`)) continue;
        const controller = new AbortController();
        const signal = taskSignal ? AbortSignal.any([taskSignal, controller.signal]) : controller.signal;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let budgetExpired = false;
        try {
          catalogs[host] = await Promise.race([
            resolvePublisherProperties(host, { signal }),
            new Promise<never>((_, reject) => {
              timeout = setTimeout(
                () => {
                  if (remainingBudgetMs <= publisherLookupTimeoutMs) budgetExpired = true;
                  controller.abort();
                  reject(new Error('publisher_catalog_timeout'));
                },
                Math.min(publisherLookupTimeoutMs, remainingBudgetMs)
              );
            }),
          ]);
        } catch {
          catalogs[host] = undefined;
        } finally {
          if (timeout) clearTimeout(timeout);
        }
        if (budgetExpired) break;
      }
      policy.publisherProperties = catalogs;
    }

    let validation: ProductPropertyPolicyValidationResult<ProductPolicyProductLike>;
    try {
      validation = validateProductsAgainstPropertyPolicy({
        products: response.products,
        policy,
        mode,
      });
    } catch (err) {
      if (!(err instanceof ProductPropertyPolicyError)) throw err;
      validation = err.result;
    }

    const summary = {
      mode,
      ok: validation.ok,
      accepted_count: validation.acceptedProducts.length,
      rejected_count: validation.rejectedProducts.length,
      flagged_count: validation.flaggedProducts.length,
      ...(validation.ok ? {} : { message }),
      ...(resolvedRequestPropertyList
        ? {
            request_property_list: {
              list_id: resolvedRequestPropertyList.listId,
              agent_url: sanitizeDiagnosticUrl(resolvedRequestPropertyList.agentUrl),
              identifier_count: resolvedRequestPropertyList.identifierCount,
              unsupported_identifier_types: resolvedRequestPropertyList.unsupportedIdentifierTypes,
              ...(resolvedRequestPropertyList.cacheValidUntil
                ? { cache_valid_until: resolvedRequestPropertyList.cacheValidUntil }
                : {}),
            },
          }
        : {}),
      diagnostics: validation.diagnostics as ProductPropertyPolicyDiagnostic[],
    };
    result.metadata.productPropertyPolicy = summary;

    if (validation.diagnostics.length > 0) {
      result.debug_logs = [
        ...(result.debug_logs ?? []),
        {
          type: 'product_property_policy',
          message: validation.ok ? 'Product property policy evaluated' : message,
          mode,
          ok: validation.ok,
          accepted_count: validation.acceptedProducts.length,
          rejected_count: validation.rejectedProducts.length,
          flagged_count: validation.flaggedProducts.length,
          ...(summary.request_property_list ? { request_property_list: summary.request_property_list } : {}),
          diagnostics: validation.diagnostics,
        },
      ];
    }

    if (mode === 'filter') {
      result.data = {
        ...(response as unknown as Record<string, unknown>),
        products: validation.products,
      } as T;
      return result;
    }

    if (mode === 'reject_response' && !validation.ok) {
      return attachMatch({
        success: false as const,
        status: 'failed' as const,
        data: response as unknown as T,
        error: message,
        metadata: {
          ...result.metadata,
          status: 'failed',
          productPropertyPolicy: summary,
        },
        conversation: result.conversation,
        debug_logs: result.debug_logs,
      });
    }

    return result;
  }

  private rememberProductPolicyRequestParams<T>(
    taskType: string,
    requestParams: Record<string, unknown>,
    result: TaskResult<T>,
    options?: TaskOptions
  ): void {
    this.rememberProductPolicyRequestState(
      taskType,
      { request: productPolicyRequestSnapshot(requestParams) },
      result,
      options
    );
  }

  private rememberProductPolicyRequestState<T>(
    taskType: string,
    requestState: ProductPolicyRequestState,
    result: TaskResult<T>,
    options?: TaskOptions
  ): void {
    if (
      taskType !== 'get_products' &&
      !(taskType === 'list_products' && this.config.validation?.supplyPathVerification)
    )
      return;
    if (result.status !== 'submitted' && result.status !== 'working') return;

    const keys = new Set<string>();
    if (result.metadata.taskId) keys.add(result.metadata.taskId);
    if (result.metadata.contextId) keys.add(result.metadata.contextId);
    if (result.metadata.serverTaskId) keys.add(result.metadata.serverTaskId);
    if (result.submitted?.taskId) keys.add(result.submitted.taskId);
    if (options?.taskId) keys.add(options.taskId);
    if (options?.contextId) keys.add(options.contextId);

    for (const key of keys) {
      this.productPolicyRequestParamsByTask.delete(key);
      this.productPolicyRequestParamsByTask.set(key, requestState);
      while (this.productPolicyRequestParamsByTask.size > TASK_SCOPED_STATE_LIMIT) {
        const oldest = this.productPolicyRequestParamsByTask.keys().next().value;
        if (oldest === undefined) break;
        this.productPolicyRequestParamsByTask.delete(oldest);
      }
    }
  }

  private rememberLegacyFormatConverter<T>(
    taskType: string,
    converter: LegacyFormatConverter | undefined,
    result: TaskResult<T>,
    options?: TaskOptions
  ): void {
    if (!converter || (taskType !== 'get_products' && taskType !== 'list_creatives')) return;
    const metadata = result.metadata as typeof result.metadata & { operationId?: string };
    const keys = [
      metadata.operationId,
      metadata.taskId,
      metadata.contextId,
      metadata.serverTaskId,
      options?.taskId,
      options?.contextId,
    ];
    for (const key of keys) {
      if (key) this.rememberCanonicalCreativeTaskAssociation(key, taskType, converter);
    }
  }

  private legacyFormatConverterForWebhook(metadata: WebhookMetadata): LegacyFormatConverter | undefined {
    return (
      this.canonicalCreativeTaskAssociation(metadata.operation_id)?.legacyFormatConverter ??
      this.canonicalCreativeTaskAssociation(metadata.task_id)?.legacyFormatConverter ??
      this.canonicalCreativeTaskAssociation(metadata.context_id)?.legacyFormatConverter ??
      this.resolveLegacyFormatConverter()
    );
  }

  private forgetProductPolicyRequestParams(metadata: WebhookMetadata): void {
    const aliases = [metadata.operation_id, metadata.task_id, metadata.context_id];
    const states = new Set(
      aliases
        .filter((key): key is string => key !== undefined)
        .map(key => this.productPolicyRequestParamsByTask.get(key))
        .filter((value): value is ProductPolicyRequestState => value !== undefined)
    );
    for (const state of states) state.request = undefined;
    this.forgetProductPolicyRequestParamKeys(aliases);
    if (states.size === 0) return;
    // All aliases for one request share the same immutable snapshot. A webhook
    // may name only operation/task/context, so remove any caller-supplied A2A
    // aliases that point at that same snapshot as well.
    for (const [key, state] of this.productPolicyRequestParamsByTask) {
      if (states.has(state)) this.productPolicyRequestParamsByTask.delete(key);
    }
  }

  private forgetProductPolicyRequestParamKeys(keys: Array<string | undefined>): void {
    for (const key of keys) {
      if (!key) continue;
      this.productPolicyRequestParamsByTask.delete(key);
    }
  }

  private wrapProductPolicySubmittedContinuation<T>(
    result: TaskResult<T>,
    taskType: string,
    requestParams: Record<string, unknown>,
    options?: TaskOptions
  ): TaskResult<T> {
    if (
      (taskType !== 'get_products' &&
        !(taskType === 'list_products' && this.config.validation?.supplyPathVerification)) ||
      result.status !== 'submitted' ||
      !result.submitted
    )
      return result;

    const submitted = result.submitted;
    const policyState: { request?: Readonly<Record<string, unknown>> } = {
      request: productPolicyRequestSnapshot(requestParams),
    };
    this.rememberProductPolicyRequestState(taskType, policyState, result, options);
    const retainedKeys = [
      result.metadata.taskId,
      result.metadata.contextId,
      result.metadata.serverTaskId,
      submitted.taskId,
      options?.taskId,
      options?.contextId,
    ];
    result.submitted = {
      ...submitted,
      track: async transport => {
        const taskInfo = await submitted.track(transport);
        const terminal = ['completed', 'failed', 'rejected', 'canceled'].includes(taskInfo.status);
        try {
          return await this.applyProductPropertyPolicyToTaskInfo(
            taskInfo,
            taskType,
            (policyState.request ?? {}) as Record<string, unknown>,
            options?.signal
          );
        } finally {
          if (terminal) {
            policyState.request = undefined;
            this.forgetProductPolicyRequestParamKeys([...retainedKeys, taskInfo.taskId]);
          }
        }
      },
      waitForCompletion: async (pollInterval, signal) => {
        let completed = await submitted.waitForCompletion(pollInterval, signal);
        if (completed.success && completed.data) {
          completed.data = this.normalizeEstablishedResponse(taskType, completed.data) as T;
        }
        const terminal = completed.status === 'completed' || completed.status === 'failed';
        try {
          return await this.applyProductPropertyPolicy(
            completed,
            taskType,
            (policyState.request ?? {}) as Record<string, unknown>,
            signal ?? options?.signal
          );
        } finally {
          if (terminal) {
            policyState.request = undefined;
            this.forgetProductPolicyRequestParamKeys([
              ...retainedKeys,
              completed.metadata.taskId,
              completed.metadata.serverTaskId,
            ]);
          }
        }
      },
    };

    return result;
  }

  private async applyProductPropertyPolicyToTaskInfo(
    taskInfo: TaskInfo,
    taskType: string,
    requestParams: Record<string, unknown>,
    taskSignal?: AbortSignal
  ): Promise<TaskInfo> {
    if (
      (taskType !== 'get_products' &&
        !(taskType === 'list_products' && this.config.validation?.supplyPathVerification)) ||
      taskInfo.status !== 'completed' ||
      !taskInfo.result
    )
      return taskInfo;

    const policyResult = await this.applyProductPropertyPolicy(
      attachMatch({
        success: true as const,
        status: 'completed' as const,
        data: this.normalizeEstablishedResponse(taskType, taskInfo.result),
        metadata: {
          taskId: taskInfo.taskId,
          taskName: taskInfo.taskType,
          agent: { id: this.agent.id, name: this.agent.name, protocol: this.agent.protocol },
          responseTimeMs: Math.max(0, Date.now() - taskInfo.createdAt),
          timestamp: new Date().toISOString(),
          clarificationRounds: 0,
          status: 'completed',
        },
        debug_logs: [],
      }),
      taskType,
      requestParams,
      taskSignal
    );

    if (policyResult.success) {
      return { ...taskInfo, result: policyResult.data };
    }

    return {
      ...taskInfo,
      status: 'failed',
      result: policyResult.data,
      error: policyResult.error,
      message: policyResult.error,
    };
  }

  private productPolicyRequestParamsForWebhook(metadata: WebhookMetadata): Record<string, unknown> {
    return (
      this.executor.getRequestParams(metadata.operation_id) ??
      this.executor.getRequestParams(metadata.task_id) ??
      this.productPolicyRequestParamsForKey(metadata.operation_id) ??
      this.productPolicyRequestParamsForKey(metadata.task_id) ??
      this.productPolicyRequestParamsForKey(metadata.context_id) ??
      {}
    );
  }

  private productPolicyRequestParamsForKey(key: string | undefined): Record<string, unknown> | undefined {
    if (!key) return undefined;
    const state = this.productPolicyRequestParamsByTask.get(key);
    if (!state?.request) return undefined;
    this.productPolicyRequestParamsByTask.delete(key);
    this.productPolicyRequestParamsByTask.set(key, state);
    return state.request as Record<string, unknown>;
  }

  private async applyProductPropertyPolicyToWebhookResult(
    result: AdCPAsyncResponseData | undefined,
    metadata: WebhookMetadata
  ): Promise<{ result: AdCPAsyncResponseData | undefined; metadata: WebhookMetadata; suppressHandler: boolean }> {
    if (
      (metadata.task_type !== 'get_products' &&
        !(metadata.task_type === 'list_products' && this.config.validation?.supplyPathVerification)) ||
      metadata.status !== 'completed' ||
      !result
    ) {
      return { result, metadata, suppressHandler: false };
    }

    const policyResult = await this.applyProductPropertyPolicy<AdCPAsyncResponseData>(
      attachMatch({
        success: true as const,
        status: 'completed' as const,
        data: result,
        metadata: {
          taskId: metadata.operation_id,
          taskName: metadata.task_type,
          agent: { id: this.agent.id, name: this.agent.name, protocol: this.agent.protocol },
          responseTimeMs: 0,
          timestamp: metadata.timestamp,
          clarificationRounds: 0,
          status: 'completed',
        },
        debug_logs: [],
      }),
      metadata.task_type,
      this.productPolicyRequestParamsForWebhook(metadata)
    );

    const nextMetadata: WebhookMetadata = {
      ...metadata,
      status: policyResult.success ? metadata.status : 'failed',
      ...(policyResult.error ? { message: policyResult.error } : {}),
      ...(policyResult.metadata.productPropertyPolicy
        ? { productPropertyPolicy: policyResult.metadata.productPropertyPolicy }
        : {}),
      ...(policyResult.metadata.productPricingPolicy
        ? { productPricingPolicy: policyResult.metadata.productPricingPolicy }
        : {}),
    };

    return {
      result: policyResult.data as AdCPAsyncResponseData | undefined,
      metadata: nextMetadata,
      suppressHandler: !policyResult.success,
    };
  }

  private get accountIdentityDowngrade(): AccountIdentityDowngrade {
    return this.config.accountIdentityDowngrade ?? 'refuse';
  }

  /**
   * Negotiate the AdCP release to speak with this seller for one call: the
   * highest release both sides support. Returns `undefined` when the call
   * keeps its configured wire version: an explicit `wireAdcpVersion`
   * override, a governed payload that must reach the seller byte-for-byte,
   * the identity 3.3 experiment, or no authoritative seller release
   * (synthetic capabilities, no release in common, or no release metadata at
   * all: AdCP 3.1 does not require `supported_versions`, so its absence does
   * not prove a 3.0 seller, and such sellers keep the 3.0 request adapters).
   */
  private negotiateCallRelease(
    capabilities: AdcpCapabilities | undefined,
    options: TaskOptions | undefined
  ): NegotiatedAdcpRelease | undefined {
    if (this.config.wireAdcpVersion !== undefined || options?.wireAdcpVersion !== undefined) return undefined;
    if (options?.preserveGovernedPayload || this.config.experimentalIdentity33) return undefined;
    const negotiated = negotiateAdcpRelease(this.resolvedAdcpVersion, capabilities);
    if (isNegotiationFailure(negotiated) && parseAdcpRelease(this.resolvedAdcpVersion)?.prerelease) {
      const requiredVersion = toReleasePrecisionWire(this.resolvedAdcpVersion);
      throw new ProtocolFeatureUnsupportedError(['adcp_version'], [], this.agent.agent_uri, {
        message: `The seller has not advertised the exact AdCP ${requiredVersion} preview. No request was sent.`,
        suggestion: 'Choose a stable AdCP release the seller supports or wait for it to advertise this exact preview.',
        details: {
          feature: 'adcp_version',
          required_version: requiredVersion,
          capability_path: 'adcp.supported_versions',
        },
      });
    }
    if (!negotiated || isNegotiationFailure(negotiated)) return undefined;
    if (negotiated.source === 'legacy_v3' && !parseAdcpRelease(this.resolvedAdcpVersion)?.prerelease) return undefined;
    return negotiated;
  }

  /**
   * Per-call options carrying the negotiated release to the executor, which
   * stamps it on the version envelope and validates the response against it.
   */
  private withNegotiatedRelease<O extends TaskOptions | undefined>(
    options: O,
    negotiated: NegotiatedAdcpRelease | undefined
  ): O {
    if (!negotiated?.downgraded) return options;
    return { ...(options ?? {}), wireAdcpVersion: negotiated.version, negotiatedAdcpVersion: negotiated.version } as O;
  }

  /**
   * Refuse a tool the negotiated release does not define (a 3.2-only task
   * sent to a 3.1 seller) with a typed error instead of a seller-side schema
   * or unknown-tool failure. Sellers that list the tool anyway are called.
   */
  private assertToolAvailableAtRelease(
    taskType: string,
    negotiated: NegotiatedAdcpRelease | undefined,
    toolSchemas: ToolSchemaMap | undefined
  ): void {
    if (!negotiated?.downgraded) return;
    // A caller-supplied schema root may cover only part of a release.
    if (isExternalSchemaRootActive(negotiated.version)) return;
    if (releaseDefinesTool(taskType, negotiated.version)) return;
    if (!releaseDefinesTool(taskType, this.resolvedAdcpVersion)) return;
    if ((toolSchemas ?? this.cachedToolSchemas)?.has(taskType)) return;
    const suggestion =
      `Call a task AdCP ${negotiated.version} defines, or reach this seller once it supports ` +
      `AdCP ${toReleasePrecisionWire(this.resolvedAdcpVersion)}.`;
    throw new ProtocolFeatureUnsupportedError([taskType], [], this.agent.agent_uri, {
      message:
        `${taskType} is not defined in AdCP ${negotiated.version}, the newest release this seller supports. ` +
        `No request was sent. ${suggestion}`,
      suggestion,
      details: {
        feature: taskType,
        required_version: toReleasePrecisionWire(this.resolvedAdcpVersion),
        capability_path: 'adcp.supported_versions',
        current_version: negotiated.version,
        tool: taskType,
      },
    });
  }

  /**
   * Account-key bookkeeping for `accountIdentityDowngrade: 'reduce'`.
   *
   * Converting down to an older seller release: claim each reduced key for
   * the buyer key it came from, and refuse the request when the reduced key
   * (or an unreduced key the request sends as is) already belongs to a
   * different buyer key. Without this, two buyer accounts would silently
   * share one seller account, with merged settings, spend and reads.
   *
   * Seller on the client's release: a buyer key that earlier reached this
   * seller reduced is still addressed by its reduced key, which is the key
   * the seller's account has, until the caller moves the account to the full
   * key and calls `client.accounts.clearReduction(key)`.
   *
   * Runs only once the account registry is in use or under `'reduce'`.
   */
  private async reconcileAccountKeyReductions(
    taskType: string,
    original: unknown,
    adapted: any,
    negotiated: NegotiatedAdcpRelease | undefined,
    driftLogs: Record<string, unknown>[]
  ): Promise<any> {
    if (this.accountIdentityDowngrade !== 'reduce' && !this._accounts) return adapted;
    const sites = accountKeySites(original);
    if (sites.length === 0) return adapted;
    const registry = this.getAccountRegistry();
    if (negotiated?.downgraded) {
      // Under 'refuse' nothing was reduced, so there is nothing to claim.
      if (this.accountIdentityDowngrade !== 'reduce') return adapted;
      const claims = sites.flatMap(site => {
        const reduced = naturalAccountKey(valueAt(adapted, site.path));
        return reduced ? [{ site, account: site.key, reduced, adcpVersion: negotiated.version }] : [];
      });
      const conflict = await registry.claimReductions(claims);
      if (conflict) {
        this.throwAccountKeyCollision(taskType, claims[conflict.index]!.site.path, conflict.owner, negotiated.version);
      }
      return adapted;
    }
    let rewritten = adapted;
    const pending: Array<{ path: string; fields: string[]; adcpVersion: string }> = [];
    for (const site of sites) {
      const reduction = await registry.reductionFor(site.key);
      if (!reduction) continue;
      rewritten = withReducedKeyAt(rewritten, site.path, reduction.account);
      pending.push({
        path: site.path.join('.'),
        fields: reducedFields(site.key, reduction.account),
        adcpVersion: reduction.adcpVersion,
      });
    }
    if (pending.length > 0) {
      const inPlace = pending.every(entry => entry.fields.every(field => field === 'operator_unit'));
      driftLogs.push({
        type: 'account_identity_migration_pending',
        message:
          `${taskType}: addressed ${pending.map(entry => entry.path).join(', ')} by the reduced account key ` +
          `this seller has, without ${[...new Set(pending.flatMap(entry => entry.fields))].join(', ')}. ` +
          (inPlace
            ? 'Rekey the account in place with a sync_accounts settings update (account, operator_identity, revision), '
            : 'currency, timezone and brand.countries cannot change on an existing account, so open a new account ' +
              'under the full key (and decide which key keeps the existing history), ') +
          'then call client.accounts.clearReduction(key).',
        accounts: pending,
        taskName: taskType,
        timestamp: new Date().toISOString(),
      });
    }
    return rewritten;
  }

  private throwAccountKeyCollision(
    taskType: string,
    path: ReadonlyArray<string | number>,
    owner: AccountReference,
    negotiatedVersion: string
  ): never {
    const field = path.join('.');
    const suggestion =
      `Reach this seller with one of the two account keys, address the account by account_id, or wait until ` +
      `the seller supports the release that tells them apart.`;
    throw new ProtocolFeatureUnsupportedError([`${taskType}.${field}`], [], this.agent.agent_uri, {
      message:
        `${taskType} ${field} would reach the same seller account as another of this buyer's account keys: ` +
        `AdCP ${negotiatedVersion} cannot tell them apart. No request was sent. ${suggestion}`,
      field,
      suggestion,
      details: {
        feature: `${taskType}.${field}`,
        reason: 'account_identity_collision',
        current_version: negotiatedVersion,
        tool: taskType,
        field,
        conflicting_account: owner,
      },
    });
  }

  private throwFieldsUnsupportedAtRelease(
    taskType: string,
    fields: ReadonlyArray<{ path: string; introducedIn: string }>,
    negotiatedVersion: string
  ): never {
    const [first] = fields;
    const paths = fields.map(field => field.path);
    const accountMove = paths.some(path => /(?:^|\.)(?:operator_identity|revision)$/.test(path));
    const suggestion = accountMove
      ? `AdCP ${negotiatedVersion} cannot rekey an account or hand it to another operator (operator_identity, ` +
        `revision). Make the move once the seller supports AdCP ${first!.introducedIn}; until then the account ` +
        'keeps its current key and operator.'
      : `Remove ${paths.join(', ')} for this seller, or reach it once it supports AdCP ${first!.introducedIn}. ` +
        'Sending the request without them would change what the seller does.';
    throw new ProtocolFeatureUnsupportedError(
      paths.map(path => `${taskType}.${path}`),
      [],
      this.agent.agent_uri,
      {
        message:
          `${taskType} ${paths.join(', ')} ${paths.length === 1 ? 'requires' : 'require'} AdCP ${first!.introducedIn}; ` +
          `this seller supports AdCP ${negotiatedVersion}. No request was sent. ${suggestion}`,
        field: first!.path,
        suggestion,
        details: {
          feature: `${taskType}.${first!.path}`,
          required_version: first!.introducedIn,
          capability_path: 'adcp.supported_versions',
          current_version: negotiatedVersion,
          tool: taskType,
          field: first!.path,
          fields: paths,
        },
      }
    );
  }

  private throwAccountIdentityUnsupported(
    taskType: string,
    fields: ReadonlyArray<{ path: string; introducedIn: string }>,
    negotiatedVersion: string
  ): never {
    const [first] = fields;
    const paths = fields.map(field => field.path);
    const suggestion =
      "Set accountIdentityDowngrade: 'reduce' to send the older account key (allowed while no other buyer key " +
      `reaches the same seller account without ${paths.join(', ')}), or remove those fields for this seller.`;
    throw new ProtocolFeatureUnsupportedError(
      paths.map(path => `${taskType}.${path}`),
      [],
      this.agent.agent_uri,
      {
        message:
          `${taskType} ${paths.join(', ')} ${paths.length === 1 ? 'is' : 'are'} part of the AdCP ${first!.introducedIn} ` +
          `account key, which AdCP ${negotiatedVersion} cannot express. No request was sent. ${suggestion}`,
        field: first!.path,
        suggestion,
        details: {
          feature: `${taskType}.${first!.path}`,
          required_version: first!.introducedIn,
          capability_path: 'adcp.supported_versions',
          current_version: negotiatedVersion,
          tool: taskType,
          field: first!.path,
          fields: paths,
        },
      }
    );
  }

  private rememberNegotiatedRelease(operationId: string, version: string): void {
    this.negotiatedReleaseByOperation.delete(operationId);
    this.negotiatedReleaseByOperation.set(operationId, version);
    if (this.negotiatedReleaseByOperation.size > MAX_REMEMBERED_NEGOTIATED_RELEASES) {
      const oldest = this.negotiatedReleaseByOperation.keys().next().value;
      if (oldest !== undefined) this.negotiatedReleaseByOperation.delete(oldest);
    }
  }

  /**
   * Webhook completions bypass task finalization, so convert their result up
   * here. The seller's own `adcp_version` names the release it served; an
   * AdCP 3.0 seller sends none, so fall back to the release this client
   * negotiated for the operation.
   */
  private convertWebhookResultToClientRelease(parsed: WebhookParseSuccess): unknown {
    const served = [parsed.result, parsed.envelope]
      .map(value =>
        value && typeof value === 'object' && typeof (value as { adcp_version?: unknown }).adcp_version === 'string'
          ? (value as { adcp_version: string }).adcp_version
          : undefined
      )
      .find(version => version !== undefined);
    const release = served ?? this.negotiatedReleaseByOperation.get(parsed.metadata.operationId);
    if (release === undefined || parsed.result === undefined || parsed.result === null) return parsed.result;
    return convertResponse(parsed.metadata.taskType, parsed.result, {
      fromVersion: release,
      toVersion: this.resolvedAdcpVersion,
    }).data;
  }

  /**
   * Convert a response served at the negotiated release up to the client's
   * release. Returns drift entries for each conversion applied.
   */
  private convertResponseToClientRelease(
    taskType: string,
    data: unknown,
    negotiatedVersion: string | undefined
  ): { data: unknown; driftLogs: Record<string, unknown>[] } {
    if (negotiatedVersion === undefined || data === undefined || data === null) return { data, driftLogs: [] };
    const translation = convertResponse(taskType, data, {
      fromVersion: negotiatedVersion,
      toVersion: this.resolvedAdcpVersion,
    });
    const timestamp = new Date().toISOString();
    return {
      data: translation.data,
      driftLogs: translation.drifts.map(drift => ({
        ...drift,
        taskName: taskType,
        clientVersion: this.resolvedAdcpVersion,
        targetVersion: negotiatedVersion,
        timestamp,
      })),
    };
  }

  /**
   * Adapt a request for the detected server wire version and the seller's
   * AdCP protocol version. Applies protocol-version adapters (e.g. stripping
   * 3.1-only fields for a 3.0 seller). Returns the adapted params and any
   * drift log entries describing what was changed.
   *
   * Runs after `detectServerVersion` so capabilities are available and the
   * current call's tool schemas can be supplied without cross-tenant caching.
   */
  private adaptRequest(
    taskType: string,
    params: any,
    serverVersion: string,
    debugLogs?: any[],
    perCallToolSchemas?: ToolSchemaMap,
    perCallCapabilities?: AdcpCapabilities,
    negotiated?: NegotiatedAdcpRelease
  ): { params: any; driftLogs: Record<string, unknown>[] } {
    if (serverVersion !== 'v3') {
      throw new VersionUnsupportedError(taskType, 'version', 'v2', this.agent.agent_uri);
    }
    const driftLogs: Record<string, unknown>[] = [];
    let adapted = params;

    // Strip any top-level fields not declared in the agent's tool schema.
    // This handles partial implementations (agents that omit some fields)
    // and prevents unknown fields from causing validation errors on the
    // remote server.
    // Fails open when no schema is cached OR when the schema declares no
    // properties (JSON Schema semantics: an object with no properties
    // and no `additionalProperties: false` accepts any shape). Post-#909,
    // framework-registered agents publish `{ type: 'object', properties: {} }`
    // on tools/list — treating that as "strip everything" would silently
    // drop every field the buyer sent.
    // MCP-only in practice: A2A agents don't populate cachedToolSchemas.
    //
    // Note: the empty-properties state from framework agents is intentional
    // (LLM context-window economy — see `PASSTHROUGH_INPUT_SCHEMA` in
    // `create-adcp-server.ts`). Don't try to "fix" it by wiring per-tool
    // schemas into `tools/list`. If you genuinely need to know a tool's
    // shape (gating, validation, version adaptation), read raw JSON from
    // `schemas/cache/{version}/` via `schema-loader.ts`. The right defense
    // against unknown-field errors is to gate at the *injection site*
    // (e.g. `applyBrandInvariant` in the storyboard runner — see #940),
    // not to lean on this strip path as a backstop.
    const toolSchema = (perCallToolSchemas ?? this.cachedToolSchemas)?.get(taskType);
    if (toolSchema && Object.keys(toolSchema).length > 0) {
      const declaredFields = new Set(Object.keys(toolSchema));

      // Protocol envelope fields are always preserved — they live at the
      // protocol layer, not in individual tool schemas.
      const envelopeFields = ADCP_ENVELOPE_FIELDS;
      const filtered: Record<string, unknown> = {};
      const schemaStripped: string[] = [];

      // A field is preserved when it's declared by the agent's (possibly
      // partial) tool schema, OR it's a protocol envelope field, OR it's a
      // CANONICAL top-level field for this task in the resolved AdCP version.
      //
      // The canonical-schema union is the fix for partial-schema sellers
      // (e.g. "Open Ads", https://api.openads.ai/mcp): such agents
      // under-declare their `tools/list` inputSchema, so intersecting only
      // their self-declared fields silently dropped canonical — sometimes
      // REQUIRED — AdCP request fields (`media_buy_id` on update_media_buy,
      // `media_buy_ids` on get_media_buy_delivery, `creative_ids` on
      // sync_creatives) before the request left the client, breaking
      // media-buy updates and delivery polling. Only fields unknown to BOTH
      // the agent schema AND the canonical request schema are genuine junk
      // and get stripped.
      //
      // `taskType` is the snake_case tool name (e.g. `update_media_buy`),
      // which is exactly the `toolName` key `schemaAllowsTopLevelField` looks
      // up as `${toolName}::request` in the loader's fileIndex. The version
      // arg is the raw resolved pin (`this.resolvedAdcpVersion`); the loader
      // resolves the bundle key internally via `ensureInit`/`resolveBundleKey`
      // (same contract as `TaskExecutor.validateRequest`). The helper FAILS
      // OPEN (returns true) when no canonical schema is indexed for the tool,
      // which preserves the field rather than dropping something we can't
      // authoritatively rule out.
      for (const [key, value] of Object.entries(adapted)) {
        if (
          declaredFields.has(key) ||
          envelopeFields.has(key) ||
          schemaAllowsTopLevelField(taskType, key, this.resolvedAdcpVersion)
        ) {
          filtered[key] = value;
        } else {
          schemaStripped.push(key);
        }
      }

      if (schemaStripped.length > 0) {
        console.warn(
          `[AdCP] Stripping request fields not declared by either agent "${this.agent.id}" or canonical AdCP schemas ` +
            `for ${taskType}: ${schemaStripped.join(', ')}`
        );
        debugLogs?.push({
          type: 'warning',
          message:
            `Stripped request fields not declared by either the agent tool input schema or canonical AdCP schema ` +
            `for ${taskType}: ${schemaStripped.join(', ')}`,
          timestamp: new Date().toISOString(),
          details: {
            code: 'input_schema_field_stripped',
            task: taskType,
            fields: schemaStripped,
            agent_id: this.agent.id,
          },
        });
      }

      adapted = filtered;
    }

    // Protocol version adaptation. With a negotiated older release, convert
    // the request down every minor step to it, removing and reporting what
    // the release cannot express. Without one (synthetic capabilities),
    // `resolveAdapterKey` falls back to the 3.0 adapters when the seller does
    // not advertise 3.1. Adapters live in `src/lib/adapters/version/<target>/`.
    if (negotiated?.downgraded) {
      const translation = convertRequest(taskType, adapted, {
        fromVersion: this.resolvedAdcpVersion,
        toVersion: negotiated.version,
        accountIdentity: this.accountIdentityDowngrade,
      });
      if (translation.identityFields.length > 0 && this.accountIdentityDowngrade === 'refuse') {
        this.throwAccountIdentityUnsupported(taskType, translation.identityFields, negotiated.version);
      }
      if (translation.refusedFields.length > 0) {
        this.throwFieldsUnsupportedAtRelease(taskType, translation.refusedFields, negotiated.version);
      }
      const timestamp = new Date().toISOString();
      for (const drift of translation.drifts) {
        driftLogs.push({
          ...drift,
          taskName: taskType,
          clientVersion: this.resolvedAdcpVersion,
          targetVersion: negotiated.version,
          timestamp,
        });
      }
      return { params: translation.params, driftLogs };
    }

    const adapterKey = resolveAdapterKey(this.resolvedAdcpVersion, perCallCapabilities ?? this.cachedCapabilities);
    if (adapterKey) {
      const versionAdapter = getVersionAdapter(adapterKey, taskType);
      if (versionAdapter?.adaptRequest) {
        const result = versionAdapter.adaptRequest(adapted);
        adapted = result.params;
        if (result.drift) {
          driftLogs.push({
            ...result.drift,
            taskName: taskType,
            clientVersion: this.resolvedAdcpVersion,
            targetVersion: adapterKey,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }

    return { params: adapted, driftLogs };
  }

  private normalizeEstablishedResponse(taskType: string, data: any): any {
    if (!data) return data;
    switch (taskType) {
      case 'get_products':
        return normalizeGetProductsResponse(data);
      case 'create_media_buy':
      case 'update_media_buy':
        return normalizeMediaBuyResponse(data);
      case 'list_creative_formats':
        return normalizeFormatsResponse(data);
      default:
        return data;
    }
  }

  // ====== MEDIA BUY TASKS ======

  /**
   * Discover available advertising products
   *
   * `brand` is optional when `catalog` is absent, including for the brief-only
   * request below. Requests with `catalog` must include `brand`; otherwise,
   * include it whenever discovery should account for a specific advertiser.
   *
   * @param params - Product discovery parameters
   * @param inputHandler - Handler for clarification requests
   * @param options - Task execution options
   *
   * @example
   * ```typescript
   * const products = await client.getProducts(
   *   {
   *     buying_mode: 'brief',
   *     brief: 'Find podcast and streaming audio placements for an eco-friendly bike subscription launch'
   *   },
   *   (context) => {
   *     if (context.inputRequest.field === 'budget') return 50000;
   *     return context.deferToHuman();
   *   }
   * );
   * ```
   */
  async getProducts(
    params: CanonicalGetProductsRequest,
    inputHandler?: InputHandler,
    options?: CanonicalReadTaskOptions
  ): Promise<TaskResult<CanonicalGetProductsResponse>> {
    const { legacyFormatConverter, projectionCatalogs, ...taskOptions } = options ?? {};
    this.assertDurableProjectionOverrideSupported(legacyFormatConverter);
    const effectiveLegacyFormatConverter = this.resolveLegacyFormatConverter(
      legacyFormatConverter,
      projectionCatalogs ?? this.config.projectionCatalogs
    );
    return withTaskDeadline(snapshotTaskOptions(taskOptions), async effectiveOptions => {
      this.assertRequestSupportedByConfiguredVersion('get_products', params, effectiveOptions);
      let request = await this.applyAccountPolicy('get_products', params, effectiveOptions);
      const legacyAccountId = (request as { account_id?: unknown }).account_id;
      const accountReference =
        request.account ??
        (typeof legacyAccountId === 'string' && legacyAccountId ? { account_id: legacyAccountId } : undefined);
      if (!request.account && typeof legacyAccountId === 'string' && legacyAccountId) {
        const { account_id: _legacyAccountId, ...rest } = request as CanonicalGetProductsRequest & {
          account_id: string;
        };
        void _legacyAccountId;
        request = { ...rest, account: { account_id: legacyAccountId } };
      }
      if (!effectiveOptions.skipRequestValidation && this.config.validateFeatures !== false) {
        const capabilities = await this.getCapabilities(effectiveOptions);
        const sellerDeclares31 =
          capabilities.servedVersion !== undefined
            ? !isPre31AdcpVersion(capabilities.servedVersion)
            : capabilities.supportedVersions?.some(version => !isPre31AdcpVersion(version)) === true;
        const sellerDeclaresBuyingModes = Array.isArray(
          (capabilities._raw?.media_buy as { buying_modes?: unknown } | undefined)?.buying_modes
        );
        if (!capabilities._synthetic) {
          const effectiveMode = request.buying_mode ?? (request.brief ? 'brief' : undefined);
          if (
            effectiveMode &&
            (sellerDeclares31 || sellerDeclaresBuyingModes) &&
            !supportsBuyingMode(capabilities, effectiveMode)
          ) {
            throw new UnsupportedBuyingModeError(effectiveMode, capabilities.buyingModes ?? ['brief']);
          }
          if (
            !effectiveOptions.skipAccountValidation &&
            !accountReference &&
            capabilities.account?.requiredForProducts
          ) {
            throw new AccountRequiredError(
              capabilities.account.requireOperatorAuth ? 'explicit' : 'implicit',
              'get_products'
            );
          }
        }
        if (!request.buying_mode && !request.brief) {
          const legacySeller = capabilities._synthetic || (!sellerDeclares31 && !sellerDeclaresBuyingModes);
          if (!legacySeller && !supportsBuyingMode(capabilities, 'wholesale')) {
            throw new UnsupportedBuyingModeError(undefined, capabilities.buyingModes ?? ['brief']);
          }
        }
      }
      // The field remains required even when callers explicitly disable
      // feature probing or request validation. Only the support check above
      // depends on discovery; keep the wire request well formed in every mode.
      if (!request.buying_mode && !request.brief) {
        request = { ...request, buying_mode: 'wholesale' };
      }
      const account = canonicalAccountRoutingSnapshot(accountReference);
      const cache =
        !effectiveOptions.skipRequestValidation &&
        !this.usesScopedDiscoveryTransport(effectiveOptions) &&
        !effectiveOptions.preserveGovernedPayload &&
        !inputHandler &&
        !request.push_notification_config &&
        !this.config.webhookUrlTemplate &&
        !this.config.handlers?.onGetProductsStatusChange
          ? this.config.productCache
          : undefined;
      // Scope derivation hashes credential material; only pay for it with an opt-in cache.
      const cacheScope = cache
        ? JSON.stringify([
            this.accountScope(),
            this.resolvedAdcpVersion,
            this.capabilityEvidenceScopeKey,
            effectiveOptions.contextId,
          ])
        : '';
      const cacheParams = request as unknown as Record<string, unknown>;
      const skipCacheRead = (options as CanonicalReadTaskOptions & { [SKIP_PRODUCT_CACHE]?: boolean })?.[
        SKIP_PRODUCT_CACHE
      ];
      if (
        cache &&
        !skipCacheRead &&
        cacheParams.if_wholesale_feed_version === undefined &&
        cacheParams.if_pricing_version === undefined
      ) {
        const hit = cache.read<CanonicalGetProductsResponse>(cacheScope, cacheParams);
        if (hit) {
          throwIfAborted(effectiveOptions.signal);
          if (hit.success && hit.status === 'completed')
            this.rememberCanonicalProductRoutes(hit.data.products ?? [], account);
          return attachMatch(
            await this.applyProductPropertyPolicy(
              hit,
              'get_products',
              productPolicyRequestSnapshot(request),
              effectiveOptions.signal
            )
          );
        }
      }
      const conditionalSnapshot = skipCacheRead
        ? undefined
        : cache?.read<CanonicalGetProductsResponse>(cacheScope, cacheParams, true);
      const productEvidence: Omit<SellerFormatEvidence, 'productId'> | undefined = this.usesScopedDiscoveryTransport(
        effectiveOptions
      )
        ? undefined
        : {
            scopeKey: this.getCapabilityEvidenceScope().scopeKey,
            accountScope: this.canonicalAccountScope(account),
            expiresAt: Date.now() + resolveAgentDiscoveryTtlMs(this.config.discoveryCache?.ttlMs),
          };
      const result = await this.executeAndHandle<CanonicalGetProductsResponse>(
        'get_products',
        'onGetProductsStatusChange',
        cache && !skipCacheRead ? cache.conditionalParams(cacheScope, cacheParams) : request,
        inputHandler,
        effectiveOptions,
        data => {
          const { response, diagnostics } = toCanonicalOnlyResponse(data as unknown as { products?: V1Product[] }, {
            legacyFormatConverter: effectiveLegacyFormatConverter,
            projectionCatalogs: projectionCatalogs ?? this.config.projectionCatalogs,
          });
          const authoritativeProducts = Array.isArray((data as unknown as { products?: unknown[] }).products)
            ? (data as unknown as { products: unknown[] }).products
            : response.products;
          this.rememberCanonicalProductRoutes(response.products, account, authoritativeProducts, productEvidence);
          const { _message: _dropLegacyMessage, ...canonical } = response as typeof response & { _message?: unknown };
          void _dropLegacyMessage;
          return { ...canonical, projection: { diagnostics } } as CanonicalGetProductsResponse;
        },
        effectiveLegacyFormatConverter,
        undefined,
        projectionCatalogs
      );
      const finishCache = async (
        completed: TaskResult<CanonicalGetProductsResponse>
      ): Promise<TaskResult<CanonicalGetProductsResponse>> => {
        if (!cache) return completed;
        const cachedResult = cache.write(cacheScope, cacheParams, completed, conditionalSnapshot, materialized => {
          // The seller confirmed the stored catalog. Renew its private proof
          // before ProductCache clones the materialized result into storage.
          this.rememberCanonicalProductRoutes(materialized.data?.products ?? [], account, undefined, productEvidence);
        });
        if (cachedResult.success && cachedResult.status === 'completed') {
          if (
            !skipCacheRead &&
            cacheParams.if_wholesale_feed_version === undefined &&
            cacheParams.if_pricing_version === undefined &&
            (cachedResult.data as { unchanged?: boolean }).unchanged === true
          ) {
            // A missing/mismatched conditional snapshot needs a real unconditional read.
            return this.getProducts(params, inputHandler, {
              ...childTaskOptions({ ...options, ...effectiveOptions }),
              [SKIP_PRODUCT_CACHE]: true,
            } as CanonicalReadTaskOptions);
          }
          this.rememberCanonicalProductRoutes(cachedResult.data.products ?? [], account);
        }
        if (cachedResult.submitted) {
          const submitted = cachedResult.submitted;
          cachedResult.submitted = {
            ...submitted,
            waitForCompletion: (interval, signal) => submitted.waitForCompletion(interval, signal).then(finishCache),
          };
        }
        if (cachedResult.deferred) {
          const deferred = cachedResult.deferred;
          cachedResult.deferred = { ...deferred, resume: input => deferred.resume(input).then(finishCache) };
        }
        return attachMatch(cachedResult);
      };
      return finishCache(result);
    });
  }

  /** Discover products through the compact AdCP 3.2 catalog task. */
  async listProducts(
    params: ListProductsRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<ListProductsResponseWithSupplyPath>> {
    return this.executeAndHandle<ListProductsResponseWithSupplyPath>(
      'list_products',
      'onListProductsStatusChange',
      params,
      inputHandler,
      options
    );
  }

  /** Read the seller's collection catalog using AdCP 3.3. @experimental */
  async listCollections(
    params: ListCollectionsRequest = {},
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<ListCollectionsResponse>> {
    return this.executeAndHandle<ListCollectionsResponse>(
      'list_collections',
      'onListCollectionsStatusChange',
      params,
      inputHandler,
      { ...options, disableWebhook: true }
    );
  }

  /** Read proposals in an authorized account using AdCP 3.3. @experimental */
  async listProposals(
    params: ListProposalsRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<ListProposalsResponse>> {
    return this.executeAndHandle<ListProposalsResponse>(
      'list_proposals',
      'onListProposalsStatusChange',
      params,
      inputHandler,
      { ...options, disableWebhook: true }
    );
  }

  /** @deprecated Explicit raw-wire escape hatch for migration tooling. */
  async getProductsLegacy(
    params: GetProductsRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<GetProductsResponse>> {
    const request = params.buying_mode || params.brief ? params : { ...params, buying_mode: 'wholesale' as const };
    return this.executeTaskUnprojected<GetProductsResponse>('get_products', request, inputHandler, options);
  }

  /** @internal Run final legacy get_products adaptation before an application-owned atomic mutation claim. */
  async getProductsLegacyWithPreDispatch(
    params: GetProductsRequest,
    beforeDispatch: UnprojectedPreDispatchHook<GetProductsResponse>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<GetProductsResponse>> {
    const requestSnapshot = structuredClone(
      params.buying_mode || params.brief ? params : { ...params, buying_mode: 'wholesale' as const }
    );
    return this.executeTaskUnprojected<GetProductsResponse>(
      'get_products',
      requestSnapshot,
      inputHandler,
      options,
      undefined,
      beforeDispatch
    );
  }

  /**
   * List a legacy named-format catalog for migration tooling.
   *
   * @param params - Format listing parameters
   * @param inputHandler - Handler for clarification requests
   * @param options - Task execution options
   * @deprecated Canonical applications discover `format_options[]` through `getProducts()`.
   */
  async listCreativeFormatsLegacy(
    params: ListCreativeFormatsRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<ListCreativeFormatsResponse>> {
    return this.executeAndHandle<ListCreativeFormatsResponse>(
      'list_creative_formats',
      'onListCreativeFormatsLegacyStatusChange',
      params,
      inputHandler,
      options
    );
  }

  /** @deprecated Migration-only access to legacy creative transformer declarations. */
  async listTransformersLegacy(
    params: ListTransformersRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<ListTransformersResponse>> {
    return this.executeTaskUnprojected<ListTransformersResponse>('list_transformers', params, inputHandler, options);
  }

  /**
   * Create a new media buy
   *
   * @param params - Media buy creation parameters
   * @param inputHandler - Handler for clarification requests
   * @param options - Task execution options
   */
  async createMediaBuy(
    params: MutatingRequestInput<CanonicalCreateMediaBuyInput>,
    inputHandler?: InputHandler,
    options?: CreativeDeliveryTaskOptions
  ): Promise<TaskResult<CanonicalCreativeResponse<CreateMediaBuyResponse>>> {
    assertRawMethodForGovernedPayload('create_media_buy', options);
    this.assertDurableProjectionOverrideSupported(options?.legacyFormatConverter);
    const requestSnapshot = structuredCloneWithLegacyCreativeMetadata(params);
    const projectionCatalogs = options?.projectionCatalogs ? structuredClone(options.projectionCatalogs) : undefined;
    const snapshottedOptions = {
      ...snapshotTaskOptions(options),
      ...(projectionCatalogs !== undefined && { projectionCatalogs }),
    };
    return withTaskDeadline(snapshottedOptions, effectiveOptions =>
      this.createMediaBuyWithinDeadline(requestSnapshot, inputHandler, effectiveOptions)
    );
  }

  private async createMediaBuyWithinDeadline(
    params: MutatingRequestInput<CanonicalCreateMediaBuyInput>,
    inputHandler: InputHandler | undefined,
    options: CreativeDeliveryTaskOptions
  ): Promise<TaskResult<CanonicalCreativeResponse<CreateMediaBuyResponse>>> {
    const { legacyFormatConverter, projectionCatalogs, canonicalFormatLegacyResolver, ...taskOptions } = options ?? {};
    const effectiveLegacyFormatConverter = this.resolveLegacyFormatConverter(
      legacyFormatConverter,
      projectionCatalogs ?? this.config.projectionCatalogs
    );
    const effectiveCanonicalFormatLegacyResolver = this.resolveCanonicalFormatLegacyResolver(
      canonicalFormatLegacyResolver,
      params.account
    );
    const hasCreativeFormatData = hasMediaBuyCreativeFormatData(params);
    if (this.config.experimentalIdentity33) await this.getCapabilities(taskOptions);
    const signed33Webhooks = this.usesSigned33Webhooks();
    // Merge library defaults with consumer-provided reporting_webhook config
    // Library provides url/auth/frequency defaults, consumer can override any field
    // Generates a media_buy_delivery webhook URL using operation_id pattern: delivery_report_{agent_id}_{YYYY-MM}
    if (this.config.webhookUrlTemplate && !options?.disableWebhook) {
      const now = new Date();
      const year = now.getUTCFullYear();
      const month = String(now.getUTCMonth() + 1).padStart(2, '0');
      const operationId = `delivery_report_${this.agent.id}_${year}-${month}`;
      const deliveryWebhookUrl = resolveWebhookUrl(
        this.config.webhookUrlTemplate,
        this.agent.id,
        'media_buy_delivery',
        operationId,
        options
      );

      if (deliveryWebhookUrl) {
        const reportingWebhook: unknown = params.reporting_webhook;
        const canCompleteReportingWebhook = reportingWebhook === undefined || isPlainRecord(reportingWebhook);

        // Preserve malformed JavaScript input for strict validation instead of
        // laundering it into a valid registration through object spread.
        if (canCompleteReportingWebhook) {
          const consumerReportingWebhook = reportingWebhook as
            | CanonicalCreateMediaBuyInput['reporting_webhook']
            | undefined;
          const consumerAuth = consumerReportingWebhook?.authentication;
          const consumerUrl = consumerReportingWebhook?.url;
          const consumerFrequency = consumerReportingWebhook?.reporting_frequency;
          const defaultAuth =
            !signed33Webhooks && this.config.webhookSecret
              ? { schemes: ['HMAC-SHA256'] as const, credentials: this.config.webhookSecret }
              : undefined;
          // The client secret is bound to the client-generated callback URL.
          // A caller-controlled endpoint must bring its own complete auth block
          // so the SDK never pairs a shared client credential with another host.
          const resolvedAuth =
            consumerAuth !== undefined ? consumerAuth : consumerUrl === undefined ? defaultAuth : undefined;

          // `reporting-webhook.json` requires `authentication` before AdCP 3.3; from
          // 3.3 a seller that signs webhooks under its profile accepts the
          // registration without it. Without positively negotiated 3.3 signed
          // webhooks the block therefore cannot simply be omitted, unlike
          // `push_notification_config`. With no configured secret and no caller-supplied credential there is
          // nothing real to put there — registering a placeholder would tell the
          // seller its delivery reports are authenticated by a constant that ships
          // in this file. Skip the auto-injection instead and say why.
          if ((!signed33Webhooks && resolvedAuth === undefined) || resolvedAuth === null) {
            // A caller who asked for a `reporting_webhook` explicitly gets an
            // error, not a silent edit: the request cannot be made spec-valid
            // without a credential, and quietly dropping a field the caller wrote
            // would make the SDK a translator of intent rather than a witness to
            // it. Only the library's OWN auto-injection is skipped silently.
            if (consumerReportingWebhook && consumerUrl !== undefined && consumerAuth === undefined) {
              throw new Error(
                'reporting_webhook requires an `authentication` block without positively negotiated 3.3 signed webhooks: ' +
                  'a caller-supplied `reporting_webhook.url` must bring its own `reporting_webhook.authentication` ' +
                  '(the client never pairs `webhookSecret` with a caller-controlled URL). Omit `url` to use the ' +
                  "client's webhookUrlTemplate callback, or remove `reporting_webhook` if you do not need automated " +
                  'delivery reports.'
              );
            }
            if (consumerReportingWebhook) {
              throw new Error(
                'reporting_webhook requires an `authentication` block without positively negotiated 3.3 signed webhooks, and no credential ' +
                  'is available: set `webhookSecret` on the client, or pass `reporting_webhook.authentication` ' +
                  'explicitly. Remove `reporting_webhook` from the request if you do not need automated ' +
                  'delivery reports — the media buy itself does not require it.'
              );
            }
            warnReportingWebhookNeedsSecret();
          } else {
            // Library defaults
            const libraryDefaults = {
              url: deliveryWebhookUrl,
              reporting_frequency: (this.config.reportingWebhookFrequency || 'daily') as 'hourly' | 'daily' | 'monthly',
            };

            // Merge the envelope, but treat `authentication` as ATOMIC. A
            // field-level merge would cross `schemes` from the caller with
            // `credentials` from `webhookSecret` — a caller passing
            // `schemes: ['Bearer']` with no credential would have the HMAC shared
            // secret registered as a Bearer token, which the seller then sends in
            // cleartext on every delivery. `schemes` determines how `credentials`
            // travels, so the two must come from the same source.
            params = {
              ...params,
              reporting_webhook: {
                ...libraryDefaults,
                ...consumerReportingWebhook,
                url: consumerUrl !== undefined ? consumerUrl : deliveryWebhookUrl,
                reporting_frequency:
                  consumerFrequency !== undefined ? consumerFrequency : libraryDefaults.reporting_frequency,
                ...(resolvedAuth !== undefined && { authentication: resolvedAuth }),
                ...(resolvedAuth === undefined &&
                  this.selectedWebhookSigningProfile() && { signing_profile: this.selectedWebhookSigningProfile() }),
              },
            } as CanonicalCreateMediaBuyInput;
            // Only the client's own callback is bound to the monthly delivery
            // operation id. A caller-supplied URL is registered at dispatch under
            // its URL-scoped id (deliveryWebhookRegistrationId), so buys with
            // different caller URLs in the same month cannot collide.
            if (signed33Webhooks && resolvedAuth === undefined && consumerUrl === undefined) {
              await this.persistWebhookRegistration({
                agent: this.normalizedAgent,
                taskType: 'media_buy_delivery',
                operationId,
                callbackUrl: deliveryWebhookUrl,
                mode: 'rfc9421',
                signingProfile: this.selectedWebhookSigningProfile(),
              });
            }
          }
        }
      }
    }

    // Validate the complete wire request after library-owned webhook defaults
    // have been resolved, but before capability discovery can make an outbound
    // call. Callers may provide reporting preferences while the client supplies
    // its own callback URL and authentication.
    if (hasCreativeFormatData) {
      this.validateBeforeCreativeCapabilityProbe('create_media_buy', params, taskOptions);
    }
    const wireMode = hasCreativeFormatData
      ? await this.resolveCreativeWireMode('create_media_buy', taskOptions, true, () =>
          this.productOptionsSupportCanonicalWire('create_media_buy', params, [], options)
        )
      : 'canonical';
    const wireParams = params as MutatingRequestInput<CanonicalCreateMediaBuyRequest>;

    const result = await this.executeAndHandle<CreateMediaBuyResponse>(
      'create_media_buy',
      'onCreateMediaBuyStatusChange',
      this.projectUndeclaredFormatOptions(
        projectMediaBuyCreativesForDelivery(
          wireParams,
          wireMode,
          'create_media_buy',
          effectiveLegacyFormatConverter,
          effectiveCanonicalFormatLegacyResolver
        ),
        'create_media_buy',
        wireMode,
        wireParams.account,
        canonicalFormatLegacyResolver
      ),
      inputHandler,
      taskOptions,
      undefined,
      effectiveLegacyFormatConverter,
      wireParams,
      projectionCatalogs
    );
    if (result.data !== undefined) this.rememberCanonicalPackageRoutes(result.data, wireParams);
    return result;
  }

  /**
   * @deprecated Compatibility-only entry point for callers still holding legacy creative `format_id` values.
   * Projection-only options are ignored because this method preserves the caller's legacy wire payload.
   */
  async createMediaBuyLegacy(
    params: MutatingRequestInput<CreateMediaBuyRequest>,
    inputHandler?: InputHandler,
    options?: CreativeDeliveryTaskOptions
  ): Promise<TaskResult<CreateMediaBuyResponse>> {
    return this.executeTaskUnprojected<CreateMediaBuyResponse>(
      'create_media_buy',
      params,
      inputHandler,
      options,
      'onCreateMediaBuyStatusChange'
    );
  }

  /** @internal Run deterministic legacy-create preflight before the caller atomically claims its mutation. */
  async createMediaBuyLegacyWithPreDispatch(
    params: MutatingRequestInput<CreateMediaBuyRequest>,
    beforeDispatch: UnprojectedPreDispatchHook<CreateMediaBuyResponse>,
    inputHandler?: InputHandler,
    options?: CreativeDeliveryTaskOptions
  ): Promise<TaskResult<CreateMediaBuyResponse>> {
    // Snapshot synchronously at the public boundary. Request validation and
    // endpoint/capability discovery contain awaits; callers must not be able to
    // mutate nested commercial terms between validation and durable dispatch.
    const requestSnapshot = structuredClone(params);
    return this.executeTaskUnprojected<CreateMediaBuyResponse>(
      'create_media_buy',
      requestSnapshot,
      inputHandler,
      options,
      'onCreateMediaBuyStatusChange',
      beforeDispatch
    );
  }

  /**
   * Update an existing media buy
   *
   * @param params - Media buy update parameters
   * @param inputHandler - Handler for clarification requests
   * @param options - Task execution options
   */
  async updateMediaBuy(
    params: MutatingRequestInput<CanonicalUpdateMediaBuyRequest>,
    inputHandler?: InputHandler,
    options?: CreativeDeliveryTaskOptions
  ): Promise<TaskResult<CanonicalCreativeResponse<UpdateMediaBuyResponse>>> {
    assertRawMethodForGovernedPayload('update_media_buy', options);
    this.assertDurableProjectionOverrideSupported(options?.legacyFormatConverter);
    const requestSnapshot = structuredCloneWithLegacyCreativeMetadata(params);
    const projectionCatalogs = options?.projectionCatalogs ? structuredClone(options.projectionCatalogs) : undefined;
    const snapshottedOptions = {
      ...snapshotTaskOptions(options),
      ...(projectionCatalogs !== undefined && { projectionCatalogs }),
    };
    return withTaskDeadline(snapshottedOptions, effectiveOptions =>
      this.updateMediaBuyWithinDeadline(requestSnapshot, inputHandler, effectiveOptions)
    );
  }

  private async updateMediaBuyWithinDeadline(
    params: MutatingRequestInput<CanonicalUpdateMediaBuyRequest>,
    inputHandler: InputHandler | undefined,
    options: CreativeDeliveryTaskOptions
  ): Promise<TaskResult<CanonicalCreativeResponse<UpdateMediaBuyResponse>>> {
    const { legacyFormatConverter, projectionCatalogs, canonicalFormatLegacyResolver, ...taskOptions } = options ?? {};
    const effectiveLegacyFormatConverter = this.resolveLegacyFormatConverter(
      legacyFormatConverter,
      projectionCatalogs ?? this.config.projectionCatalogs
    );
    const effectiveCanonicalFormatLegacyResolver = this.resolveCanonicalFormatLegacyResolver(
      canonicalFormatLegacyResolver,
      params.account
    );
    const hasCreativeFormatData = hasMediaBuyCreativeFormatData(params);
    if (hasCreativeFormatData) {
      this.validateBeforeCreativeCapabilityProbe('update_media_buy', params, taskOptions);
    }
    const wireMode = hasCreativeFormatData
      ? await this.resolveCreativeWireMode('update_media_buy', taskOptions, true, () =>
          this.productOptionsSupportCanonicalWire('update_media_buy', params, [], options)
        )
      : 'canonical';
    const result = await this.executeAndHandle<UpdateMediaBuyResponse>(
      'update_media_buy',
      'onUpdateMediaBuyStatusChange',
      this.projectUndeclaredFormatOptions(
        projectMediaBuyCreativesForDelivery(
          params,
          wireMode,
          'update_media_buy',
          effectiveLegacyFormatConverter,
          effectiveCanonicalFormatLegacyResolver
        ),
        'update_media_buy',
        wireMode,
        params.account,
        canonicalFormatLegacyResolver
      ),
      inputHandler,
      taskOptions,
      undefined,
      effectiveLegacyFormatConverter,
      params,
      projectionCatalogs
    );
    if (result.data !== undefined) this.rememberCanonicalPackageRoutes(result.data, params);
    return result;
  }

  /**
   * @deprecated Compatibility-only entry point for callers still holding legacy creative `format_id` values.
   * Projection-only options are ignored because this method preserves the caller's legacy wire payload.
   */
  async updateMediaBuyLegacy(
    params: MutatingRequestInput<UpdateMediaBuyRequest>,
    inputHandler?: InputHandler,
    options?: CreativeDeliveryTaskOptions
  ): Promise<TaskResult<UpdateMediaBuyResponse>> {
    return this.executeTaskUnprojected<UpdateMediaBuyResponse>(
      'update_media_buy',
      params,
      inputHandler,
      options,
      'onUpdateMediaBuyStatusChange'
    );
  }

  /**
   * Sync creative assets
   *
   * @param params - Creative sync parameters
   * @param inputHandler - Handler for clarification requests
   * @param options - Task execution options
   */
  async syncCreatives(
    params: MutatingRequestInput<CanonicalSyncCreativesRequest>,
    inputHandler?: InputHandler,
    options?: SyncCreativesTaskOptions
  ): Promise<TaskResult<CanonicalCreativeResponse<SyncCreativesResponse>>> {
    assertRawMethodForGovernedPayload('sync_creatives', options);
    this.assertDurableProjectionOverrideSupported(
      options?.creativeFormatProjection?.legacyFormatConverter ?? options?.legacyFormatConverter
    );
    const requestSnapshot = structuredCloneWithLegacyCreativeMetadata(params);
    const projectionCatalogs = options?.projectionCatalogs ? structuredClone(options.projectionCatalogs) : undefined;
    const creativeFormatProjection = options?.creativeFormatProjection
      ? {
          ...options.creativeFormatProjection,
          ...(options.creativeFormatProjection.selectorContainers !== undefined && {
            selectorContainers: structuredCloneWithLegacyCreativeMetadata(
              options.creativeFormatProjection.selectorContainers
            ),
          }),
        }
      : undefined;
    const snapshottedOptions = {
      ...snapshotTaskOptions(options),
      ...(projectionCatalogs !== undefined && { projectionCatalogs }),
      ...(creativeFormatProjection !== undefined && { creativeFormatProjection }),
    };
    return withTaskDeadline(snapshottedOptions, effectiveOptions =>
      this.syncCreativesWithinDeadline(requestSnapshot, inputHandler, effectiveOptions)
    );
  }

  private async syncCreativesWithinDeadline(
    params: MutatingRequestInput<CanonicalSyncCreativesRequest>,
    inputHandler: InputHandler | undefined,
    options: SyncCreativesTaskOptions
  ): Promise<TaskResult<CanonicalCreativeResponse<SyncCreativesResponse>>> {
    const {
      creativeFormatProjection,
      legacyFormatConverter,
      projectionCatalogs,
      canonicalFormatLegacyResolver,
      ...taskOptions
    } = options ?? {};
    const effectiveCanonicalFormatLegacyResolver = this.resolveCanonicalFormatLegacyResolver(
      canonicalFormatLegacyResolver,
      params.account
    );
    const effectiveLegacyFormatConverter = this.resolveLegacyFormatConverter(
      creativeFormatProjection?.legacyFormatConverter ?? legacyFormatConverter,
      projectionCatalogs ?? this.config.projectionCatalogs
    );
    this.validateBeforeCreativeCapabilityProbe('sync_creatives', params, taskOptions);
    const configuredSelectorContainers = [
      ...((creativeFormatProjection?.selectorContainers ?? []) as ReadonlyArray<CreativeFormatSelectorContainer>),
    ];
    const configuredPackageIds = new Set(
      configuredSelectorContainers.flatMap(container =>
        typeof container.package_id === 'string' ? [container.package_id] : []
      )
    );
    const assignmentPackageContainers = Array.isArray(params.assignments)
      ? params.assignments.flatMap(assignment =>
          typeof assignment.package_id === 'string' && !configuredPackageIds.has(assignment.package_id)
            ? [{ package_id: assignment.package_id }]
            : []
        )
      : [];
    const selectorContainers = [...configuredSelectorContainers, ...assignmentPackageContainers];
    const wireMode = await this.resolveCreativeWireMode('sync_creatives', taskOptions, true, () =>
      this.productOptionsSupportCanonicalWire('sync_creatives', params, selectorContainers, options)
    );
    const wireParams = this.projectUndeclaredFormatOptions(
      projectSyncCreativesForDelivery(
        params,
        selectorContainers,
        wireMode,
        effectiveLegacyFormatConverter,
        effectiveCanonicalFormatLegacyResolver
      ),
      'sync_creatives',
      wireMode,
      params.account,
      canonicalFormatLegacyResolver
    );
    return this.executeAndHandle<SyncCreativesResponse>(
      'sync_creatives',
      'onSyncCreativesStatusChange',
      wireParams,
      inputHandler,
      taskOptions,
      undefined,
      effectiveLegacyFormatConverter,
      params,
      projectionCatalogs
    );
  }

  /**
   * @deprecated Compatibility-only entry point for callers still holding legacy creative `format_id` values.
   * Projection-only options are ignored because this method preserves the caller's legacy wire payload.
   */
  async syncCreativesLegacy(
    params: MutatingRequestInput<SyncCreativesRequest>,
    inputHandler?: InputHandler,
    options?: SyncCreativesTaskOptions
  ): Promise<TaskResult<SyncCreativesResponse>> {
    return this.executeTaskUnprojected<SyncCreativesResponse>(
      'sync_creatives',
      params,
      inputHandler,
      options,
      'onSyncCreativesStatusChange'
    );
  }

  /**
   * Resolve the creative wire mode used by the canonical write methods without
   * sending a mutation. Discovers capabilities and the current tool's input
   * schema, or reuses fresh cached/primed evidence, with this client's wire pin.
   *
   * This context-free check returns `unknown` when capabilities and schema do
   * not establish support. A write to a proven 3.1 seller can still select
   * canonical delivery from matching seller-advertised product options;
   * otherwise projection requires an unambiguous legacy reference.
   * Conflicting evidence and unproven support with a 3.2+ buyer pin throw
   * `CreativeFormatCapabilityError`, just as they do during a write.
   */
  async resolveCreativeFormatWireMode(
    taskType: 'sync_creatives' | 'create_media_buy' | 'update_media_buy',
    options?: ReadRequestOptions
  ): Promise<CreativeFormatWireMode> {
    return this.resolveCreativeWireMode(taskType, options, true);
  }

  private async resolveCreativeWireMode(
    taskType: 'sync_creatives' | 'create_media_buy' | 'update_media_buy',
    options: ReadRequestOptions | undefined,
    canRediscover: boolean,
    matchingProductOptions?: () => boolean
  ): Promise<CreativeFormatWireMode> {
    const discoveryContext: CapabilityDiscoveryContext = {};
    const capabilities = await this.getCapabilities({
      ...options,
      [CAPABILITY_DISCOVERY_CONTEXT]: discoveryContext,
    } as InternalReadRequestOptions);
    const usesScopedFetch = this.usesScopedDiscoveryTransport(options);
    const toolSchemas = discoveryContext.toolSchemas ?? (usesScopedFetch ? undefined : this.cachedToolSchemas);
    // Capabilities `adcp.build_version` is advisory deployment metadata. The
    // protocol schema explicitly forbids using it for negotiation, so wire
    // guarantees follow the release pin this client actually emits.
    const wireRelease = this.config.wireAdcpVersion ?? this.resolvedAdcpVersion;
    const declared = resolveCreativeFormatWireMode(capabilities, wireRelease);
    const document = toolSchemas && toolInputSchemasByProperties.get(toolSchemas)?.get(taskType);
    const { creativeSchemaSupport } = await import('./creative-schema-support');
    throwIfAborted(options?.signal);
    const schema = creativeSchemaSupport(document ?? { properties: toolSchemas?.get(taskType) });
    if (declared !== 'unknown' && schema !== 'unknown' && declared !== schema) {
      throw new CreativeFormatCapabilityError(
        `Seller capability and ${taskType} input schema disagree about canonical creative support`
      );
    }
    let resolved = declared !== 'unknown' ? declared : schema;
    if (
      resolved === 'unknown' &&
      canUseProductOptionsForCreativeWire(capabilities, wireRelease) &&
      matchingProductOptions?.()
    ) {
      resolved = 'canonical';
    }
    const release = /^v?(\d+)\.(\d+)(?:\.|-|$)/.exec(wireRelease.trim());
    const canonicalRequiredByBuyerPin =
      release !== null && (Number(release[1]) > 3 || (Number(release[1]) === 3 && Number(release[2]) >= 2));
    if (resolved === 'unknown' && canonicalRequiredByBuyerPin) {
      // Older SDKs wrote only property maps to shared backends. Rediscover
      // once before refusing a referenced schema whose document was lost.
      if (
        canRediscover &&
        !usesScopedFetch &&
        this.normalizedAgent.protocol === 'mcp' &&
        this.capabilitiesFromSharedCache &&
        toolSchemas?.has(taskType) &&
        !toolInputSchemasByProperties.has(toolSchemas)
      ) {
        await this.invalidateDiscoveryCache(options);
        return this.resolveCreativeWireMode(taskType, options, false, matchingProductOptions);
      }
      throw new CreativeFormatCapabilityError(
        `Cannot prove which AdCP release the seller serves for ${taskType}; a 3.2+ client will not guess a legacy creative wire shape`
      );
    }
    return resolved;
  }

  /** Product evidence applies to this request only; it must never prime a tool-wide capability. */
  private productOptionsSupportCanonicalWire(
    taskType: 'sync_creatives' | 'create_media_buy' | 'update_media_buy',
    request: unknown,
    selectorContainers: readonly CreativeFormatSelectorContainer[] = [],
    options?: CreativeDeliveryTaskOptions
  ): boolean {
    if (!isPlainRecord(request) || this.usesScopedDiscoveryTransport(options)) return false;
    const scopeKey = this.getCapabilityEvidenceScope().scopeKey;
    const accountScope = this.canonicalAccountScope(request.account);
    const optionRef = (value: unknown): CanonicalLegacyOptionRef | undefined => {
      if (!isPlainRecord(value) || typeof value.format_option_id !== 'string' || !value.format_option_id) {
        return undefined;
      }
      if (typeof value.publisher_domain === 'string') {
        return {
          scope: 'publisher',
          publisher_domain: value.publisher_domain,
          format_option_id: value.format_option_id,
        };
      }
      if (value.scope !== undefined && value.scope !== 'product') return undefined;
      return { scope: 'product', format_option_id: value.format_option_id };
    };
    const accepts = (container: CreativeFormatSelectorContainer, creative?: unknown, depth = 0): boolean => {
      if (depth > 32) return false;
      if (Array.isArray(container.selector_containers)) {
        return (
          container.selector_containers.length > 0 &&
          container.selector_containers.every(nested => accepts(nested, creative, depth + 1))
        );
      }
      const refs = Array.isArray(container.format_option_refs) ? container.format_option_refs.map(optionRef) : [];
      if (refs.some(ref => ref === undefined)) return false;
      const creativeRef = isPlainRecord(creative) ? optionRef(creative.format_option_ref) : undefined;
      if (isPlainRecord(creative) && creative.format_option_ref !== undefined && !creativeRef) return false;
      const isSellerDeclaration = (value: unknown): value is Readonly<Record<string, unknown>> => {
        if (!isPlainRecord(value) || sellerDeclaredFormatOption(value) !== true || isSynthesizedFormatOption(value)) {
          return false;
        }
        const evidence = sellerFormatEvidence(value);
        if (
          !evidence ||
          evidence.scopeKey !== scopeKey ||
          (typeof container.product_id === 'string' && evidence.productId !== container.product_id) ||
          evidence.expiresAt <= Date.now() ||
          (evidence.accountScope !== accountScope && evidence.accountScope !== 'none')
        )
          return false;
        const ref = optionRef(value);
        if (
          ref &&
          formatOptionOriginFromRoutes(
            options?.canonicalFormatLegacyResolver,
            ref,
            typeof container.product_id === 'string' ? container.product_id : undefined
          )?.seller_declared === false
        )
          return false;
        return (
          !ref ||
          typeof container.product_id !== 'string' ||
          this.cachedFormatOptionOrigin(request.account, ref, container.product_id)?.seller_declared !== false
        );
      };
      const declarations: Readonly<Record<string, unknown>>[] = [
        ...(Array.isArray(container.format_options) ? container.format_options : []).filter(isSellerDeclaration),
        ...selectedFormatOptions(container).filter(isSellerDeclaration),
      ];
      if (typeof container.product_id === 'string') {
        for (const ref of [...refs, ...(creativeRef ? [creativeRef] : [])]) {
          if (!ref) continue;
          const route = this.routeForOption(request.account, container.product_id, ref);
          if (route?.kind === 'product' && route.declaration && isSellerDeclaration(route.declaration))
            declarations.push(route.declaration);
        }
      }
      const available = declarations.filter(declaration => declaration.experimental !== true);
      const matchesRef = (declaration: Readonly<Record<string, unknown>>, ref: CanonicalLegacyOptionRef): boolean => {
        const declaredRef = optionRef(declaration);
        return declaredRef !== undefined && sameFormatOptionRef(declaredRef, ref);
      };
      if (!refs.every(ref => available.some(declaration => matchesRef(declaration, ref!)))) return false;
      const selected = available.filter(
        declaration => refs.length === 0 || refs.some(ref => matchesRef(declaration, ref!))
      );
      if (creative === undefined) return refs.length > 0 && selected.length > 0;
      if (!isPlainRecord(creative) || typeof creative.format_kind !== 'string' || creative.format_id !== undefined)
        return false;
      return selected.some(
        declaration =>
          declaration.format_kind === creative.format_kind &&
          (!creativeRef || matchesRef(declaration, creativeRef)) &&
          creativeMatchesProductOption(creative, declaration)
      );
    };
    if (taskType === 'sync_creatives') {
      if (!Array.isArray(request.creatives) || request.creatives.length === 0) return false;
      const creatives = request.creatives;
      const assignments = Array.isArray(request.assignments) ? request.assignments : [];
      // Existing creatives have no manifest here to compare against the seller's
      // declarations. They cannot borrow evidence from another uploaded creative.
      if (
        !assignments.every(
          value =>
            isPlainRecord(value) &&
            typeof value.package_id === 'string' &&
            typeof value.creative_id === 'string' &&
            creatives.some((creative: unknown) => isPlainRecord(creative) && creative.creative_id === value.creative_id)
        )
      )
        return false;
      return creatives.every(creative => {
        if (!isPlainRecord(creative)) return false;
        const assigned = new Set(
          assignments.flatMap(value =>
            isPlainRecord(value) && value.creative_id === creative.creative_id && typeof value.package_id === 'string'
              ? [value.package_id]
              : []
          )
        );
        const relevant =
          assigned.size === 0
            ? selectorContainers
            : selectorContainers.filter(
                container => typeof container.package_id === 'string' && assigned.has(container.package_id)
              );
        return (
          relevant.length > 0 &&
          [...assigned].every(id => relevant.some(container => container.package_id === id)) &&
          relevant.every(container => accepts(container, creative))
        );
      });
    }
    const packages = ['packages', 'new_packages'].flatMap(key => (Array.isArray(request[key]) ? request[key] : []));
    let evidence = false;
    return (
      packages.length > 0 &&
      packages.every(pkg => {
        if (!isPlainRecord(pkg)) return false;
        const creatives = Array.isArray(pkg.creatives) ? pkg.creatives : [];
        const hasSelectors = Array.isArray(pkg.format_option_refs) && pkg.format_option_refs.length > 0;
        if (!hasSelectors && creatives.length === 0) {
          return pkg.format_kind === undefined && pkg.format_ids === undefined;
        }
        evidence = true;
        return (!hasSelectors || accepts(pkg)) && creatives.every(creative => accepts(pkg, creative));
      }) &&
      evidence
    );
  }

  /** Validate malformed creative payloads before capability discovery can perform I/O. */
  private validateBeforeCreativeCapabilityProbe(taskType: string, params: unknown, options: TaskOptions): void {
    if (options.skipIdempotencyAutoInject || options.skipAccountValidation || options.skipRequestValidation) return;
    let normalizedParams = normalizeRequestParams(taskType, params);
    if (
      requestUsesIdempotency(taskType, normalizedParams) &&
      normalizedParams &&
      typeof normalizedParams === 'object' &&
      !normalizedParams.idempotency_key
    ) {
      normalizedParams = { ...normalizedParams, idempotency_key: generateIdempotencyKey() };
    }
    if (!isExternalSchemaRootActive(this.resolvedAdcpVersion)) {
      this.validateRequest(taskType, normalizedParams);
    }
  }

  /**
   * List creatives through the canonical SDK boundary.
   *
   * Legacy format filters are rejected and returned creative identities are
   * projected to `format_kind` / `format_option_ref`. Migration tooling that
   * needs the negotiated raw wire shape must call `listCreativesLegacy()`.
   *
   * @param params - Creative listing parameters
   * @param inputHandler - Handler for clarification requests
   * @param options - Task execution options
   */
  async listCreatives(
    params: CanonicalListCreativesRequest,
    inputHandler?: InputHandler,
    options?: CanonicalReadTaskOptions
  ): Promise<TaskResult<CanonicalListCreativesResponse>> {
    const { legacyFormatConverter, projectionCatalogs, ...taskOptions } = options ?? {};
    this.assertDurableProjectionOverrideSupported(legacyFormatConverter);
    const effectiveLegacyFormatConverter = this.resolveLegacyFormatConverter(
      legacyFormatConverter,
      projectionCatalogs ?? this.config.projectionCatalogs
    );
    return this.executeAndHandle<CanonicalListCreativesResponse>(
      'list_creatives',
      'onListCreativesStatusChange',
      params,
      inputHandler,
      taskOptions,
      data => {
        const { _message: _dropLegacyMessage, ...safe } = data as typeof data & { _message?: unknown };
        void _dropLegacyMessage;
        return {
          ...safe,
          creatives: data.creatives.map(creative =>
            projectCreativeForDelivery(
              creative as unknown as import('../types/tools.generated').CreativeAsset,
              {},
              'canonical',
              'list_creatives',
              effectiveLegacyFormatConverter
            )
          ),
        } as CanonicalListCreativesResponse;
      },
      effectiveLegacyFormatConverter,
      undefined,
      projectionCatalogs
    );
  }

  /** @deprecated Explicit raw-wire escape hatch for migration tooling. */
  async listCreativesLegacy(
    params: ListCreativesRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<ListCreativesResponse>> {
    return this.executeTaskUnprojected<ListCreativesResponse>('list_creatives', params, inputHandler, options);
  }

  /** Preview a creative using canonical capability or creative-library identity. */
  async previewCreative(
    params: CanonicalPreviewCreativeRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<CanonicalPreviewCreativeResponse>> {
    const legacyPath = legacyCreativeIdentityPath(params);
    if (legacyPath) {
      const suggestion = 'Move this request to previewCreativeLegacy(), or replace format_id with canonical identity.';
      throw new ProtocolFeatureUnsupportedError(['preview_creative.canonical_identity'], [], this.agent.agent_uri, {
        message: `previewCreative() does not accept legacy creative identity at ${legacyPath}. ${suggestion}`,
        field: legacyPath,
        suggestion,
        details: {
          feature: 'preview_creative.canonical_identity',
          tool: 'preview_creative',
          field: legacyPath,
        },
      });
    }
    return this.executeAndHandle<CanonicalPreviewCreativeResponse>(
      'preview_creative',
      'onPreviewCreativeStatusChange',
      params,
      inputHandler,
      options,
      undefined,
      undefined,
      params
    );
  }

  /** @deprecated Migration-only access to `format_id`-based creative preview. */
  async previewCreativeLegacy(
    params: PreviewCreativeRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<PreviewCreativeResponse>> {
    return this.executeAndHandle<PreviewCreativeResponse>(
      'preview_creative',
      'onPreviewCreativeLegacyStatusChange',
      params,
      inputHandler,
      options
    );
  }

  /**
   * Get media buy status, creative approvals, and optional delivery snapshots
   *
   * @param params - Request parameters
   * @param inputHandler - Handler for clarification requests
   * @param options - Task execution options
   */
  async getMediaBuys(
    params: GetMediaBuysRequest,
    inputHandler?: InputHandler,
    options?: CanonicalReadTaskOptions
  ): Promise<TaskResult<CanonicalCreativeResponse<GetMediaBuysResponse>>> {
    const { legacyFormatConverter, projectionCatalogs, ...taskOptions } = options ?? {};
    this.assertDurableProjectionOverrideSupported(legacyFormatConverter);
    const result = await this.executeAndHandle<GetMediaBuysResponse>(
      'get_media_buys',
      'onGetMediaBuysStatusChange',
      params,
      inputHandler,
      taskOptions,
      undefined,
      this.resolveLegacyFormatConverter(legacyFormatConverter, projectionCatalogs ?? this.config.projectionCatalogs),
      undefined,
      projectionCatalogs
    );
    if (result.data !== undefined) this.rememberCanonicalPackageRoutes(result.data, params);
    return result;
  }

  /**
   * Get media buy delivery information
   *
   * @param params - Delivery information parameters
   * @param inputHandler - Handler for clarification requests
   * @param options - Task execution options
   */
  async getMediaBuyDelivery(
    params: GetMediaBuyDeliveryRequest,
    inputHandler?: InputHandler,
    options?: CanonicalReadTaskOptions
  ): Promise<TaskResult<CanonicalCreativeResponse<GetMediaBuyDeliveryResponse>>> {
    const { legacyFormatConverter, projectionCatalogs, ...taskOptions } = options ?? {};
    this.assertDurableProjectionOverrideSupported(legacyFormatConverter);
    return this.executeAndHandle<GetMediaBuyDeliveryResponse>(
      'get_media_buy_delivery',
      'onGetMediaBuyDeliveryStatusChange',
      params,
      inputHandler,
      taskOptions,
      undefined,
      this.resolveLegacyFormatConverter(legacyFormatConverter, projectionCatalogs ?? this.config.projectionCatalogs),
      undefined,
      projectionCatalogs
    );
  }

  /** Retrieve canonical creative-level and variant-level delivery metrics. */
  async getCreativeDelivery(
    params: GetCreativeDeliveryRequest,
    inputHandler?: InputHandler,
    options?: CanonicalReadTaskOptions
  ): Promise<TaskResult<CanonicalCreativeResponse<GetCreativeDeliveryResponse>>> {
    const { legacyFormatConverter, projectionCatalogs, ...taskOptions } = options ?? {};
    this.assertDurableProjectionOverrideSupported(legacyFormatConverter);
    return this.executeAndHandle<GetCreativeDeliveryResponse>(
      'get_creative_delivery',
      'onGetCreativeDeliveryStatusChange',
      params,
      inputHandler,
      taskOptions,
      undefined,
      this.resolveLegacyFormatConverter(legacyFormatConverter, projectionCatalogs ?? this.config.projectionCatalogs),
      undefined,
      projectionCatalogs
    );
  }

  /**
   * Provide performance feedback
   *
   * @param params - Performance feedback parameters
   * @param inputHandler - Handler for clarification requests
   * @param options - Task execution options
   */
  async providePerformanceFeedback(
    params: MutatingRequestInput<ProvidePerformanceFeedbackRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<ProvidePerformanceFeedbackResponse>> {
    return this.executeAndHandle<ProvidePerformanceFeedbackResponse>(
      'provide_performance_feedback',
      'onProvidePerformanceFeedbackStatusChange',
      params,
      inputHandler,
      options
    );
  }

  // ====== SIGNALS TASKS ======

  /**
   * Get audience signals
   *
   * @param params - Signals request parameters
   * @param inputHandler - Handler for clarification requests
   * @param options - Task execution options
   */
  async getSignals(
    params: GetSignalsRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<GetSignalsResponse>> {
    return this.executeAndHandle<GetSignalsResponse>(
      'get_signals',
      'onGetSignalsStatusChange',
      params,
      inputHandler,
      options
    );
  }

  /**
   * Activate audience signals
   *
   * @param params - Signal activation parameters
   * @param inputHandler - Handler for clarification requests
   * @param options - Task execution options
   */
  async activateSignal(
    params: MutatingRequestInput<ActivateSignalRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<ActivateSignalResponse>> {
    return this.executeAndHandle<ActivateSignalResponse>(
      'activate_signal',
      'onActivateSignalStatusChange',
      params,
      inputHandler,
      options
    );
  }

  // ====== GOVERNANCE TASKS ======

  /**
   * Sync campaign plans to a governance agent.
   * Plans define authorized parameters: budget, channels, flight dates, markets, policies, delegations.
   *
   * Uses the governance agent from config.governance.campaign.agent by default.
   * Pass an explicit agent via options.agent to override.
   */
  async syncPlans(
    params: MutatingRequestInput<SyncPlansRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions & { agent?: AgentConfig }
  ): Promise<TaskResult<SyncPlansResponse>> {
    const agent = options?.agent ?? this.getGovernanceAgent();
    // Pre-send schema check on the unadapted shape, mirroring the public-task
    // executeTask path. Without this call, governance/protocol entry points
    // that bypass the executeTask seam silently round-trip malformed requests
    // to the server instead of failing locally.
    this.executor.validateRequest('sync_plans', params);
    return this.executor.executeTask<SyncPlansResponse>(agent, 'sync_plans', params, inputHandler, options);
  }

  /**
   * Get governance audit logs for one or more plans.
   * Returns budget state, channel allocation, per-campaign breakdown, and audit trail.
   *
   * Uses the governance agent from config.governance.campaign.agent by default.
   * Pass an explicit agent via options.agent to override.
   */
  async getPlanAuditLogs(
    params: GetPlanAuditLogsRequest,
    options?: TaskOptions & { agent?: AgentConfig }
  ): Promise<TaskResult<GetPlanAuditLogsResponse>> {
    const agent = options?.agent ?? this.getGovernanceAgent();
    this.executor.validateRequest('get_plan_audit_logs', params);
    return this.executor.executeTask<GetPlanAuditLogsResponse>(
      agent,
      'get_plan_audit_logs',
      params,
      undefined,
      options
    );
  }

  /**
   * Report a governance outcome for an async task that has resolved.
   *
   * Use this when a task returned status 'submitted' or 'working' and
   * later resolves via polling or webhooks. The checkId is available
   * on the original TaskResult at result.governance.checkId. After a
   * TaskTimeoutError during governance postflight, pass the error's
   * governanceRecovery.outcomeIdempotencyKey in `options` to safely retry.
   */
  async reportGovernanceOutcome(
    checkId: string,
    outcome: OutcomeType,
    governanceContext?: string,
    sellerResponse?: Record<string, unknown>,
    error?: { code?: string; message: string },
    options?: { outcomeIdempotencyKey?: string; signal?: AbortSignal }
  ): Promise<import('./GovernanceTypes').GovernanceOutcome | undefined> {
    const middleware = this.executor.getGovernanceMiddleware();
    if (!middleware) {
      throw new Error('No governance middleware configured. Set config.governance.campaign to enable governance.');
    }
    return middleware.reportOutcome(
      checkId,
      outcome,
      sellerResponse,
      error,
      [],
      governanceContext,
      options?.signal,
      options?.outcomeIdempotencyKey
    );
  }

  private getGovernanceAgent(): AgentConfig {
    const agent = this.config.governance?.campaign?.agent;
    if (!agent) {
      throw new Error(
        'No governance agent configured. Either pass an explicit agent via options.agent or set config.governance.campaign.agent.'
      );
    }
    return agent;
  }

  // ====== PROTOCOL TASKS ======

  /**
   * Get AdCP capabilities
   *
   * @param params - Capabilities request parameters
   * @param inputHandler - Handler for clarification requests
   * @param options - Task execution options
   */
  async getAdcpCapabilities(
    params: GetAdCPCapabilitiesRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<GetAdCPCapabilitiesResponse>> {
    return withTaskDeadline(snapshotTaskOptions(options), effectiveOptions =>
      this.getAdcpCapabilitiesWithinDeadline(params, inputHandler, effectiveOptions)
    );
  }

  private async getAdcpCapabilitiesWithinDeadline(
    params: GetAdCPCapabilitiesRequest,
    inputHandler: InputHandler | undefined,
    options: TaskOptions
  ): Promise<TaskResult<GetAdCPCapabilitiesResponse>> {
    const scopeKey = this.config._reuseConfiguredDiscovery?.() ? this.getCapabilityEvidenceScope().scopeKey : undefined;
    const agent = await this.ensureEndpointDiscovered(options);
    this.executor.validateRequest('get_adcp_capabilities', params);
    const result = await this.executor.executeTask<GetAdCPCapabilitiesResponse>(
      agent,
      'get_adcp_capabilities',
      params,
      inputHandler,
      options
    );
    if (
      this.config._reuseConfiguredDiscovery?.() &&
      !this.usesScopedDiscoveryTransport(options) &&
      scopeKey === this.getCapabilityEvidenceScope().scopeKey &&
      Object.keys(params).length === 0 &&
      this.runAgentInfo !== undefined &&
      result.success &&
      result.data &&
      looksLikeV3Capabilities(result.data)
    ) {
      const capabilities = parseCapabilitiesResponse(structuredClone(result.data));
      if (!capabilities._synthetic) {
        this.cachedCapabilities = augmentCapabilitiesFromTools(capabilities, this.runAgentInfo.tools);
      }
    }
    return result;
  }

  // ====== CREATIVE BUILD TASKS ======

  /**
   * Build a creative through the legacy named-format protocol.
   * @deprecated Migration-only access to `target_format_id`-based creative building.
   */
  async buildCreativeLegacy(
    params: MutatingRequestInput<BuildCreativeRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<BuildCreativeResponse>> {
    return this.executeAndHandle<BuildCreativeResponse>(
      'build_creative',
      'onBuildCreativeLegacyStatusChange',
      params,
      inputHandler,
      options
    );
  }

  // ====== ACCOUNT & AUDIENCE TASKS ======

  /** Read the durable change feed for one account. */
  async listAccountChanges(
    params: ListAccountChangesRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<ListAccountChangesResponse>> {
    return this.executeAndHandle<ListAccountChangesResponse>(
      'list_account_changes',
      'onListAccountChangesStatusChange',
      params,
      inputHandler,
      options
    );
  }

  /** Read the authenticated caller's durable principal configuration. */
  async getPrincipal(
    params: GetPrincipalRequest = {},
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<import('../identity-3.3/types').Identity33GetPrincipalResponse>> {
    return this.executeAndHandle<import('../identity-3.3/types').Identity33GetPrincipalResponse>(
      'get_principal',
      'onGetPrincipalStatusChange',
      params,
      inputHandler,
      options
    );
  }

  /** Atomically replace selected sections of the authenticated caller's principal configuration. */
  async syncPrincipal(
    params: MutatingRequestInput<SyncPrincipalRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<SyncPrincipalResponse>> {
    return this.executeAndHandle<SyncPrincipalResponse>(
      'sync_principal',
      'onSyncPrincipalStatusChange',
      params,
      inputHandler,
      options
    );
  }

  /**
   * List accounts
   */
  async listAccounts(
    params: ListAccountsRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<ListAccountsResponse>> {
    return this.executeAndHandle<ListAccountsResponse>(
      'list_accounts',
      'onListAccountsStatusChange',
      params,
      inputHandler,
      options
    );
  }

  /**
   * Resolve an account for the authenticated caller. Explicit-account sellers
   * are discovered with list_accounts; implicit-account sellers are registered
   * with sync_accounts. Stable-ID sellers are addressed by ID; legacy implicit
   * sellers keep their natural key. includeDetails also exposes the seller handle.
   */
  async resolveAccount(
    hints: ResolveAccountOptions & { includeDetails: true },
    options?: TaskOptions,
    onTaskResult?: (result: TaskResult<unknown>) => void
  ): Promise<ResolveAccountResult>;
  async resolveAccount(
    hints?: ResolveAccountOptions & { includeDetails?: false },
    options?: TaskOptions,
    onTaskResult?: (result: TaskResult<unknown>) => void
  ): Promise<AccountReference>;
  async resolveAccount(
    hints: ResolveAccountOptions & { includeDetails?: boolean },
    options?: TaskOptions,
    onTaskResult?: (result: TaskResult<unknown>) => void
  ): Promise<AccountReference | ResolveAccountResult>;
  async resolveAccount(
    hints: ResolveAccountOptions & { includeDetails?: boolean } = {},
    options?: TaskOptions,
    /** @internal Allows the AgentClient wrapper to retain nested task session ids. */
    onTaskResult?: (result: TaskResult<unknown>) => void
  ): Promise<AccountReference | ResolveAccountResult> {
    return withTaskDeadline(snapshotTaskOptions(options), async effectiveOptions => {
      const capabilities = await this.getCapabilities(effectiveOptions);
      if (capabilities._synthetic || !capabilities.account) {
        throw new AccountRequiredError(
          'explicit',
          'resolveAccount',
          'The seller did not provide an account contract. Probe get_adcp_capabilities or pass an account reference explicitly.'
        );
      }
      const resolved = (account: AccountReference, accountId?: string): AccountReference | ResolveAccountResult => {
        const reference = this.accountWireReference(account, accountId, capabilities);
        return hints.includeDetails
          ? {
              reference,
              ...(accountId && { account_id: accountId }),
              ...(!('account_id' in account) && { naturalKey: structuredClone(account) }),
            }
          : reference;
      };
      if (capabilities.account.requireOperatorAuth) {
        const accounts: ListAccountsResponse['accounts'] = [];
        const seenCursors = new Set<string>();
        let cursor: string | undefined;
        for (let page = 0; page < 100; page++) {
          const result = await this.listAccounts(
            {
              status: 'active',
              sandbox: hints.sandbox ?? false,
              ...(cursor !== undefined && { pagination: { cursor } }),
            },
            undefined,
            childTaskOptions(effectiveOptions)
          );
          onTaskResult?.(result);
          if (
            !result.success ||
            result.status !== 'completed' ||
            !result.data ||
            !('accounts' in result.data) ||
            !Array.isArray(result.data.accounts)
          ) {
            throw new Error('list_accounts did not return a completed account list.');
          }
          accounts.push(...result.data.accounts);
          if (!result.data.pagination?.has_more) {
            const selected = selectListedAccount(accounts, hints);
            return resolved(selected, 'account_id' in selected ? selected.account_id : undefined);
          }
          const nextCursor = result.data.pagination.cursor;
          if (!nextCursor || seenCursors.has(nextCursor)) break;
          seenCursors.add(nextCursor);
          cursor = nextCursor;
        }
        throw new AccountRequiredError(
          'explicit',
          'resolveAccount',
          'Could not complete list_accounts pagination. Select an account_id explicitly after listing accounts.'
        );
      }
      if (!hints.brand?.domain || !hints.operator) {
        throw new AccountRequiredError(
          'implicit',
          'resolveAccount',
          'Implicit-account sellers require both brand and operator to sync an account.'
        );
      }
      const uses32NaturalKey =
        hints.operatorUnit !== undefined || hints.currency !== undefined || hints.timezone !== undefined;
      const sellerServes32 = capabilities.servedVersion
        ? !isPre32AdcpVersion(capabilities.servedVersion)
        : capabilities.supportedVersions?.some(version => !isPre32AdcpVersion(version)) === true;
      if (uses32NaturalKey && (isPre32AdcpVersion(this.resolvedAdcpVersion) || !sellerServes32)) {
        throw new AccountRequiredError(
          'implicit',
          'resolveAccount',
          'Operator unit, account currency, and account timezone require AdCP 3.2 on both buyer and seller.'
        );
      }
      const timezone = capabilities.account.timezone;
      if (timezone?.accountSelection === 'buyer_selected') {
        if (!hints.timezone || !timezone.supportedTimezones?.includes(hints.timezone)) {
          throw new AccountRequiredError(
            'implicit',
            'resolveAccount',
            'Choose a supported account timezone before sync_accounts.'
          );
        }
      } else if (hints.timezone && timezone) {
        throw new AccountRequiredError(
          'implicit',
          'resolveAccount',
          'This seller does not accept a buyer-selected account timezone.'
        );
      }
      const currencyModes = capabilities.account.supportedAccountCurrencyModes;
      if (currencyModes?.length === 1 && currencyModes[0] === 'fixed' && !hints.currency) {
        throw new AccountRequiredError('implicit', 'resolveAccount', 'This seller requires a fixed account currency.');
      }
      if (hints.currency && currencyModes?.length === 1 && currencyModes[0] === 'per_media_buy') {
        throw new AccountRequiredError('implicit', 'resolveAccount', 'This seller selects currency per media buy.');
      }
      const account = {
        brand: hints.brand,
        operator: hints.operator,
        ...(hints.operatorUnit !== undefined && { operator_unit: hints.operatorUnit }),
        ...(hints.currency !== undefined && { currency: hints.currency }),
        ...(hints.timezone !== undefined && { timezone: hints.timezone }),
        ...(hints.sandbox !== undefined && { sandbox: hints.sandbox }),
      };
      const supportedBilling = capabilities.account.supportedBilling;
      const billing =
        hints.billing ??
        capabilities.account.defaultBilling ??
        (supportedBilling.length === 1 ? supportedBilling[0] : undefined);
      if (!billing || (supportedBilling.length > 0 && !supportedBilling.includes(billing))) {
        throw new AccountRequiredError(
          'implicit',
          'resolveAccount',
          `Choose a supported billing party for sync_accounts (seller supports: ${supportedBilling.join(', ') || '(none)'}).`
        );
      }
      if (!this.accountRegistryOptedIn()) {
        // SDK 14.0 behavior: sync on every call so callers observe the
        // seller's current status. The memoized registry path is opt-in.
        const registry = this.usesStableAccountIds(capabilities) ? this.getAccountRegistry() : undefined;
        const registryScope = registry ? this.accountScope() : undefined;
        const observationEpoch = registry?.captureObservation();
        const result = await this.syncAccounts(
          {
            accounts: [
              {
                ...account,
                billing,
                ...(hints.paymentTerms !== undefined && { payment_terms: hints.paymentTerms }),
                ...(hints.billingEntity !== undefined && { billing_entity: hints.billingEntity }),
              },
            ],
          } as MutatingRequestInput<SyncAccountsRequest>,
          undefined,
          childTaskOptions(effectiveOptions)
        );
        onTaskResult?.(result);
        if (
          !result.success ||
          result.status !== 'completed' ||
          !result.data ||
          !('accounts' in result.data) ||
          !Array.isArray(result.data.accounts)
        ) {
          throw new Error('sync_accounts did not return a completed account result.');
        }
        if (registry) {
          if (registryScope !== this.accountScope())
            throw new AccountRequiredError(
              'implicit',
              'resolveAccount',
              'Caller credentials changed during provisioning.'
            );
          await registry.observeSync([account], result.data.accounts, false, observationEpoch);
          if (registryScope !== this.accountScope())
            throw new AccountRequiredError(
              'implicit',
              'resolveAccount',
              'Caller credentials changed during provisioning.'
            );
        }
        const matchingRows = result.data.accounts.filter(
          row =>
            row.brand?.domain === hints.brand!.domain &&
            row.operator === hints.operator &&
            (!hints.brand!.brand_id || row.brand.brand_id === hints.brand!.brand_id) &&
            sameCountrySet(hints.brand!.countries, row.brand.countries) &&
            (!hints.operatorUnit || row.operator_unit?.id === hints.operatorUnit.id) &&
            (!hints.currency || row.currency === hints.currency) &&
            (!hints.timezone || row.timezone === hints.timezone) &&
            (row.sandbox === undefined || (row.sandbox === true) === (hints.sandbox === true))
        );
        if (registry && matchingRows.length > 1)
          throw new AccountRequiredError(
            'implicit',
            'resolveAccount',
            'sync_accounts returned ambiguous rows for the requested account.'
          );
        const syncedRow = matchingRows[0];
        if (!syncedRow || syncedRow.action === 'failed') {
          throw new AccountRequiredError(
            'implicit',
            'resolveAccount',
            'sync_accounts did not establish an active account for the requested brand and operator.'
          );
        }
        let current = registry ? await registry.get(account) : syncedRow;
        if (registry && registryScope !== this.accountScope())
          throw new AccountRequiredError(
            'implicit',
            'resolveAccount',
            'Caller credentials changed during provisioning.'
          );
        if (registry && !current && registry.captureObservation() === observationEpoch) {
          // An automatic cache eviction is not a seller status change. Fall back
          // only when no newer authoritative repair could have superseded this row.
          current = syncedRow;
        }
        if (
          current &&
          current.account_id !== syncedRow.account_id &&
          registry?.captureObservation() === observationEpoch
        )
          throw new AccountRequiredError(
            'implicit',
            'resolveAccount',
            'The seller account binding changed during resolution. Resolve the account again.'
          );
        if (current?.status === 'pending_approval') throw new AccountPendingApprovalError(account, current.account_id);
        if (current?.status !== 'active')
          throw new AccountRequiredError(
            'implicit',
            'resolveAccount',
            'sync_accounts did not establish an active account for the requested brand and operator.'
          );
        return resolved(account, current.account_id);
      }
      let synced;
      try {
        synced = await this.getAccountRegistry().ensure(
          account,
          {
            billing,
            paymentTerms: hints.paymentTerms,
            billingEntity: hints.billingEntity,
          },
          childTaskOptions(effectiveOptions),
          onTaskResult
        );
      } catch (error) {
        if (error instanceof AccountNotFoundError)
          throw new AccountRequiredError('implicit', 'resolveAccount', error.message);
        throw error;
      }
      if (synced.status === 'pending_approval') throw new AccountPendingApprovalError(account, synced.account_id);
      if (synced.status !== 'active')
        throw new AccountRequiredError('implicit', 'resolveAccount', 'The account is not active.');
      return resolved(account, synced.account_id);
    });
  }

  /**
   * Sync accounts
   */
  async syncAccounts(
    params: MutatingRequestInput<SyncAccountsRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions,
    /** @internal Registry-owned final dispatch boundary. */
    dispatch?: import('./buyer-account-registry').BuyerAccountProvisioningDispatch
  ): Promise<TaskResult<SyncAccountsResponse>> {
    if (dispatch)
      return this.executeTaskUnprojected<SyncAccountsResponse>(
        'sync_accounts',
        params,
        inputHandler,
        options,
        'onSyncAccountsStatusChange',
        Object.assign(
          async (effectiveParams: Record<string, unknown>) => {
            if (dispatch.requireIdempotencyKey !== false && effectiveParams.idempotency_key !== dispatch.idempotencyKey)
              throw new ConfigurationError('Account provisioning idempotency key changed before dispatch.');
            await dispatch.beforeDispatch();
            return { action: 'dispatch_ready' as const };
          },
          { terminalSettlement: 'executor' as const }
        )
      );
    return this.executeAndHandle<SyncAccountsResponse>(
      'sync_accounts',
      'onSyncAccountsStatusChange',
      params,
      inputHandler,
      options
    );
  }

  /**
   * Sync audiences
   */
  async syncAudiences(
    params: MutatingRequestInput<SyncAudiencesRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<SyncAudiencesResponse>> {
    return this.executeAndHandle<SyncAudiencesResponse>(
      'sync_audiences',
      'onSyncAudiencesStatusChange',
      params,
      inputHandler,
      options
    );
  }

  // ====== GOVERNANCE TASKS ======

  /**
   * Create a property list
   */
  async createPropertyList(
    params: MutatingRequestInput<CreatePropertyListRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<CreatePropertyListResponse>> {
    return this.executeAndHandle<CreatePropertyListResponse>(
      'create_property_list',
      'onCreatePropertyListStatusChange',
      params,
      inputHandler,
      options
    );
  }

  /**
   * Get a property list
   */
  async getPropertyList(
    params: GetPropertyListRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<GetPropertyListResponse>> {
    return this.executeAndHandle<GetPropertyListResponse>(
      'get_property_list',
      'onGetPropertyListStatusChange',
      params,
      inputHandler,
      options
    );
  }

  /**
   * Update a property list
   */
  async updatePropertyList(
    params: MutatingRequestInput<UpdatePropertyListRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<UpdatePropertyListResponse>> {
    return this.executeAndHandle<UpdatePropertyListResponse>(
      'update_property_list',
      'onUpdatePropertyListStatusChange',
      params,
      inputHandler,
      options
    );
  }

  /**
   * List property lists
   */
  async listPropertyLists(
    params: ListPropertyListsRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<ListPropertyListsResponse>> {
    return this.executeAndHandle<ListPropertyListsResponse>(
      'list_property_lists',
      'onListPropertyListsStatusChange',
      params,
      inputHandler,
      options
    );
  }

  /**
   * Delete a property list
   */
  async deletePropertyList(
    params: MutatingRequestInput<DeletePropertyListRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<DeletePropertyListResponse>> {
    return this.executeAndHandle<DeletePropertyListResponse>(
      'delete_property_list',
      'onDeletePropertyListStatusChange',
      params,
      inputHandler,
      options
    );
  }

  /**
   * List content standards
   */
  async listContentStandardsLegacy(
    params: ListContentStandardsRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<ListContentStandardsResponse>> {
    return this.executeAndHandle<ListContentStandardsResponse>(
      'list_content_standards',
      'onListContentStandardsLegacyStatusChange',
      params,
      inputHandler,
      options
    );
  }

  /**
   * Get content standards
   */
  async getContentStandardsLegacy(
    params: GetContentStandardsRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<GetContentStandardsResponse>> {
    return this.executeAndHandle<GetContentStandardsResponse>(
      'get_content_standards',
      'onGetContentStandardsLegacyStatusChange',
      params,
      inputHandler,
      options
    );
  }

  /**
   * Calibrate content against standards
   */
  async calibrateContentLegacy(
    params: MutatingRequestInput<CalibrateContentRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<CalibrateContentResponse>> {
    return this.executeAndHandle<CalibrateContentResponse>(
      'calibrate_content',
      'onCalibrateContentLegacyStatusChange',
      params,
      inputHandler,
      options
    );
  }

  /**
   * Validate content delivery
   */
  async validateContentDeliveryLegacy(
    params: ValidateContentDeliveryRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<ValidateContentDeliveryResponse>> {
    return this.executeAndHandle<ValidateContentDeliveryResponse>(
      'validate_content_delivery',
      'onValidateContentDeliveryLegacyStatusChange',
      params,
      inputHandler,
      options
    );
  }

  // ====== SPONSORED INTELLIGENCE TASKS ======

  /**
   * Get an SI offering
   */
  async siGetOffering(
    params: SIGetOfferingRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<SIGetOfferingResponse>> {
    return this.executeAndHandle<SIGetOfferingResponse>(
      'si_get_offering',
      'onSIGetOfferingStatusChange',
      params,
      inputHandler,
      options
    );
  }

  /**
   * Initiate an SI session
   */
  async siInitiateSession(
    params: MutatingRequestInput<SIInitiateSessionRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<SIInitiateSessionResponse>> {
    return this.executeAndHandle<SIInitiateSessionResponse>(
      'si_initiate_session',
      'onSIInitiateSessionStatusChange',
      params,
      inputHandler,
      options
    );
  }

  /**
   * Send a message in an SI session
   */
  async siSendMessage(
    params: MutatingRequestInput<SISendMessageRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<SISendMessageResponse>> {
    return this.executeAndHandle<SISendMessageResponse>(
      'si_send_message',
      'onSISendMessageStatusChange',
      params,
      inputHandler,
      options
    );
  }

  /**
   * Terminate an SI session
   */
  async siTerminateSession(
    params: SITerminateSessionRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<SITerminateSessionResponse>> {
    return this.executeAndHandle<SITerminateSessionResponse>(
      'si_terminate_session',
      'onSITerminateSessionStatusChange',
      params,
      inputHandler,
      options
    );
  }

  // ====== GENERIC TASK EXECUTION ======

  /**
   * Execute any task by name with type safety
   *
   * @param taskName - Name of the task to execute
   * @param params - Task parameters
   * @param inputHandler - Handler for clarification requests
   * @param options - Task execution options
   *
   * @example
   * ```typescript
   * const result = await client.executeTask(
   *   'get_products',
   *   { brief: 'Coffee brands' },
   *   handler
   * );
   * ```
   */
  async executeTask<K extends AdcpTaskName>(
    taskName: K,
    params: TaskRequestFor<K>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<TaskResponseTypeMap[K]>>;
  async executeTask(
    taskName: string,
    params: any,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<any>> {
    switch (taskName) {
      case 'get_products':
        return this.getProducts(params as CanonicalGetProductsRequest, inputHandler, options);
      case 'list_products':
        return this.listProducts(params as ListProductsRequest, inputHandler, options);
      case 'list_collections':
        return this.listCollections(params as ListCollectionsRequest, inputHandler, options);
      case 'list_proposals':
        return this.listProposals(params as ListProposalsRequest, inputHandler, options);
      case 'create_media_buy':
        return (await this.createMediaBuy(
          params as MutatingRequestInput<CanonicalCreateMediaBuyRequest>,
          inputHandler,
          options
        )) as TaskResult<any>;
      case 'update_media_buy':
        return (await this.updateMediaBuy(
          params as MutatingRequestInput<CanonicalUpdateMediaBuyRequest>,
          inputHandler,
          options
        )) as TaskResult<any>;
      case 'sync_creatives':
        return (await this.syncCreatives(
          params as MutatingRequestInput<CanonicalSyncCreativesRequest>,
          inputHandler,
          options
        )) as TaskResult<any>;
      case 'list_creatives':
        return this.listCreatives(params as CanonicalListCreativesRequest, inputHandler, options);
      case 'get_media_buys':
        return this.getMediaBuys(params as GetMediaBuysRequest, inputHandler, options);
      case 'get_media_buy_delivery':
        return this.getMediaBuyDelivery(params as GetMediaBuyDeliveryRequest, inputHandler, options);
      case 'get_creative_delivery':
        return this.getCreativeDelivery(params as GetCreativeDeliveryRequest, inputHandler, options);
      case 'get_principal':
        return this.getPrincipal(params as GetPrincipalRequest, inputHandler, options);
      case 'sync_principal':
        return this.syncPrincipal(params as MutatingRequestInput<SyncPrincipalRequest>, inputHandler, options);
      case 'request_proposals':
        return guardNativeRequestProposalsCompletion(
          await this.executeTaskUnprojected(taskName, params, inputHandler, options)
        );
    }
    return this.executeTaskUnprojected(taskName, params, inputHandler, options);
  }

  /**
   * Execute an extension task that is not part of the standard AdCP task set.
   *
   * Keeping custom tasks on an explicitly named API prevents a response-type
   * generic from weakening the canonical request types enforced by
   * `executeTask()` for standard creative-boundary tasks.
   */
  async executeCustomTask<T = unknown>(
    taskName: string,
    params: Record<string, unknown>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<T>> {
    if (STANDARD_ADCP_TASK_NAMES.has(taskName)) {
      throw new Error(
        `executeCustomTask() cannot execute standard AdCP task "${taskName}". ` +
          'Use its typed primary method, or an explicitly named *Legacy method for legacy creative tools.'
      );
    }
    return this.executeTaskUnprojected<T>(taskName, params, inputHandler, options);
  }

  /**
   * Explicit raw-task compatibility escape hatch for conformance and migration tooling.
   * @deprecated Application code should use typed primary methods or `executeTask()`.
   */
  async executeTaskLegacy<T = any>(
    taskName: string,
    params: any,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<T>> {
    return this.executeTaskUnprojected<T>(taskName, params, inputHandler, options);
  }

  private async executeTaskUnprojected<T = any>(
    taskName: string,
    params: any,
    inputHandler?: InputHandler,
    options?: TaskOptions,
    handlerName?: keyof AsyncHandlerConfig,
    beforeDispatch?: UnprojectedPreDispatchHook<T>
  ): Promise<TaskResult<T>> {
    const requestParamsSnapshot = structuredClone(params);
    const taskOptionsSnapshot = snapshotTaskOptions(options);
    return withTaskDeadline(taskOptionsSnapshot, async effectiveOptions => {
      const result = await this.executeTaskUnprojectedWithinDeadline<T>(
        taskName,
        requestParamsSnapshot,
        inputHandler,
        effectiveOptions,
        beforeDispatch,
        handlerName
      );
      return result;
    });
  }

  private async executeTaskUnprojectedWithinDeadline<T = any>(
    taskName: string,
    params: any,
    inputHandler?: InputHandler,
    options?: TaskOptions,
    beforeDispatch?: UnprojectedPreDispatchHook<T>,
    handlerName?: keyof AsyncHandlerConfig
  ): Promise<TaskResult<T>> {
    throwIfAborted(options?.signal);
    const startTime = Date.now();
    let detectedServerVersion: 'v2' | 'v3' | undefined;
    let detectedServerVersionSynthetic: boolean | undefined;
    params = await this.applyAccountPolicy(taskName, params, options);
    try {
      const normalizedParams = options?.preserveGovernedPayload
        ? params
        : normalizeRequestParams(taskName, params, {
            skipIdempotencyAutoInject: options?.skipIdempotencyAutoInject,
            skipAccountValidation: options?.skipAccountValidation,
          });
      if (!options?.skipRequestValidation) assertNoPrincipalIdentityInput(taskName, normalizedParams);
      this.assertRequestSupportedByConfiguredVersion(taskName, normalizedParams, options);
      this.assertDurablePropertyListCredentialSupported(taskName, normalizedParams);

      await this.validateTaskFeatures(taskName, options);
      if (this.config.requireV3ForMutations && requestUsesIdempotency(taskName, normalizedParams)) {
        await this.requireSupportedMajor(taskName, options);
      }
      const agent = await this.ensureEndpointDiscovered(options);

      // Schema-driven pre-send validation runs on the unadapted v3 shape so
      // wire-format adapters (e.g. adaptGetProductsRequestForV2) don't strip
      // v3-only fields out from under the v3 bundled schema. Skip the entire
      // Zod parse when compliance testing has suppressed request validation —
      // the invalid shape is intentional and must reach the seller.
      if (
        !options?.skipIdempotencyAutoInject &&
        !options?.skipAccountValidation &&
        !options?.skipRequestValidation &&
        !options?.preserveGovernedPayload
      ) {
        this.executor.validateRequest(taskName, normalizedParams);
      }

      // Adapt request for the detected server and AdCP protocol versions.
      const capabilityDiscoveryContext: CapabilityDiscoveryContext = {};
      const detectionOptions: InternalReadRequestOptions = {
        ...options,
        [CAPABILITY_DISCOVERY_CONTEXT]: capabilityDiscoveryContext,
      };
      const serverVersion = await this.detectServerVersion(detectionOptions);
      detectedServerVersion = serverVersion;
      detectedServerVersionSynthetic = capabilityDiscoveryContext.capabilities?._synthetic;
      const negotiatedRelease = this.negotiateCallRelease(capabilityDiscoveryContext.capabilities, options);
      this.assertToolAvailableAtRelease(taskName, negotiatedRelease, capabilityDiscoveryContext.toolSchemas);
      this.assertRequestSupportedByTargetVersion(
        taskName,
        normalizedParams,
        capabilityDiscoveryContext.capabilities,
        false,
        serverVersion,
        negotiatedRelease
      );
      const { options: webhookOptions, driftLog: webhookDriftLog } = this.suppressPre31DiscoveryWebhook(
        taskName,
        options,
        capabilityDiscoveryContext.capabilities
      );
      const effectiveOptions = this.withNegotiatedRelease(webhookOptions, negotiatedRelease);
      const inputSchemaStripLogs: any[] = [];
      if (options?.preserveGovernedPayload && serverVersion !== 'v3') {
        throw new ConfigurationError(
          'Governed storyboard requests require a v3 seller to preserve the approved payload.'
        );
      }
      const { params: convertedParams, driftLogs: adaptDriftLogs } = options?.preserveGovernedPayload
        ? { params: normalizedParams, driftLogs: [] }
        : this.adaptRequest(
            taskName,
            normalizedParams,
            serverVersion,
            inputSchemaStripLogs,
            capabilityDiscoveryContext.toolSchemas,
            capabilityDiscoveryContext.capabilities,
            negotiatedRelease
          );
      const adaptedParams = options?.preserveGovernedPayload
        ? convertedParams
        : await this.reconcileAccountKeyReductions(
            taskName,
            normalizedParams,
            convertedParams,
            negotiatedRelease,
            adaptDriftLogs
          );
      if (
        negotiatedRelease?.downgraded &&
        !options?.skipIdempotencyAutoInject &&
        !options?.skipAccountValidation &&
        !options?.skipRequestValidation
      ) {
        // Gated like the pre-conversion check: see the matching comment in
        // executeAndHandleWithinDeadline.
        this.executor.validateRequest(taskName, adaptedParams, inputSchemaStripLogs, negotiatedRelease.version);
      }

      const adaptationLogs: any[] = [...adaptDriftLogs];
      if (webhookDriftLog) adaptationLogs.push(webhookDriftLog);

      const deferredClientContext: DeferredClientFinalizationContext = {
        kind: 'single-agent',
        taskType: taskName,
        ...(handlerName !== undefined && { handlerName }),
        canonical: false,
        serverVersion,
        ...(capabilityDiscoveryContext.capabilities?._synthetic !== undefined && {
          serverVersionSynthetic: capabilityDiscoveryContext.capabilities._synthetic,
        }),
        ...(negotiatedRelease?.downgraded && { negotiatedAdcpVersion: negotiatedRelease.version }),
        productPolicyRequest: productPolicyRequestSnapshot(normalizedParams),
        accountRegistry: this.accountRegistryContext(taskName, normalizedParams, effectiveOptions),
        ...(effectiveOptions?.taskId !== undefined && { optionTaskId: effectiveOptions.taskId }),
        ...(effectiveOptions?.contextId !== undefined && { optionContextId: effectiveOptions.contextId }),
        ...(effectiveOptions?.skipStatusHandlers !== undefined && {
          skipStatusHandlers: effectiveOptions.skipStatusHandlers,
        }),
      };
      let result = await this.executor.executeTask<T>(
        agent,
        taskName,
        adaptedParams,
        inputHandler,
        effectiveOptions,
        serverVersion,
        capabilityDiscoveryContext.capabilities,
        beforeDispatch,
        deferredClientContext
      );
      if (!result.success) await this.invalidateDiscoveryOnCapabilityError(result.adcpError?.code, effectiveOptions);

      const postAdapterLogs = [...inputSchemaStripLogs, ...adaptationLogs];
      if (postAdapterLogs.length > 0) {
        result.debug_logs = [...(result.debug_logs ?? []), ...postAdapterLogs];
      }

      return this.finalizeTaskResult(result, deferredClientContext, effectiveOptions);
    } catch (error) {
      if (error instanceof BeforeProtocolDispatchHookError || error instanceof AfterProtocolDispatchHookError) {
        throw error.original;
      }
      // Structured protocol errors carry typed fields (reason, actualVersion,
      // unsupportedFeatures, …) that callers use for recovery decisions. Auth
      // and timeout errors trigger OAuth flows / cancellation. All four are
      // established throws — rethrow so callers' existing catch sites work.
      if (
        error instanceof AuthenticationRequiredError ||
        error instanceof TaskTimeoutError ||
        error instanceof VersionUnsupportedError ||
        error instanceof FeatureUnsupportedError ||
        (error instanceof ConfigurationError && options?.durableContinuationRecovery !== undefined) ||
        isAbortOrTimeoutError(error)
      ) {
        throw error;
      }
      // Unexpected pre-flight errors (e.g. a TypeError from response parsing
      // during version detection) surface as a structured TaskResult rather
      // than escaping as raw exceptions — matching the declared return type
      // and the contract the internal executor already upholds for network
      // errors. attachMatch ensures the fluent .match() API works on this path.
      const errorMessage = error instanceof Error ? error.message : String(error);
      return attachMatch({
        success: false as const,
        status: 'failed' as const,
        error: errorMessage,
        metadata: {
          taskId: crypto.randomUUID(),
          taskName,
          agent: {
            id: this.agent.id,
            name: this.agent.name,
            protocol: this.normalizedAgent.protocol,
          },
          responseTimeMs: Date.now() - startTime,
          timestamp: new Date().toISOString(),
          clarificationRounds: 0,
          status: 'failed',
          ...(detectedServerVersion !== undefined && { serverVersion: detectedServerVersion }),
          ...(detectedServerVersionSynthetic !== undefined && {
            serverVersionSynthetic: detectedServerVersionSynthetic,
          }),
        },
        conversation: [],
        debug_logs: [],
      });
    }
  }

  // ====== DEFERRED TASK MANAGEMENT ======

  /**
   * Resume a deferred task using its token
   *
   * @param token - Deferred task token
   * @param input - Human- or application-provided answer for the paused task
   *
   * @example
   * ```typescript
   * const paused = await client.createMediaBuy(params, handler);
   * if (paused.status === 'deferred') {
   *   const result = await client.resumeDeferredTask(paused.deferred.token, humanProvidedValue);
   * }
   * ```
   */
  async resumeDeferredTask<T = any>(token: string, input: unknown): Promise<TaskResult<T>> {
    const { result, clientContext } = await this.executor.resumeDeferredTaskWithContext<T>(token, input);
    const finalized = isDeferredClientFinalizationContext(clientContext)
      ? await this.finalizeTaskResult(result, clientContext)
      : result;
    if (!isDeferredClientFinalizationContext(clientContext)) {
      await acknowledgeDeferredSettlement(finalized);
    }
    return finalized;
  }

  // ====== CONVERSATION MANAGEMENT ======

  /**
   * Continue an existing conversation with the agent
   *
   * @param message - Message to send to the agent
   * @param contextId - Conversation context ID to continue
   * @param inputHandler - Handler for any clarification requests
   *
   * @example
   * ```typescript
   * const agent = new ADCPClient(config);
   * const initial = await agent.getProducts({ brief: 'Tech products' });
   *
   * // Continue the conversation — use the server-returned contextId, not
   * // the client-minted correlation taskId.
   * const refined = await agent.continueConversation(
   *   'Focus only on laptops under $1000',
   *   initial.metadata.contextId!
   * );
   * ```
   */
  async continueConversation<T = any>(
    message: string,
    contextId: string,
    inputHandler?: InputHandler
  ): Promise<TaskResult<T>> {
    const agent = await this.ensureEndpointDiscovered();
    const creativeAssociation = this.canonicalCreativeTaskAssociation(contextId);
    if (!creativeAssociation) {
      return this.executor.executeTask<T>(agent, 'continue_conversation', { message }, inputHandler, { contextId });
    }

    const { taskType: creativeTaskType } = creativeAssociation;
    const legacyFormatConverter = this.finalLegacyFormatConverter(creativeAssociation.legacyFormatConverter);
    const result = await canonicalCreativeExecutionStorage.run(
      { taskType: creativeTaskType, canonical: true, legacyFormatConverter },
      () =>
        this.executor.executeTask<T>(
          agent,
          'continue_conversation',
          { message },
          this.canonicalCreativeInputHandler(creativeTaskType, inputHandler),
          { contextId }
        )
    );
    const canonical = this.canonicalizeCreativeTaskResult(result, creativeTaskType, undefined, legacyFormatConverter);
    this.rememberCanonicalCreativeTaskIds(
      canonical,
      creativeTaskType,
      legacyFormatConverter,
      creativeAssociation.routingSnapshot
    );
    return this.wrapCanonicalCreativeContinuations(
      canonical,
      creativeTaskType,
      undefined,
      legacyFormatConverter,
      creativeAssociation.routingSnapshot
    );
  }

  /**
   * Get conversation history for a task
   */
  getConversationHistory(taskId: string): Message[] | undefined {
    const history = this.executor.getConversationHistory(taskId);
    const association = this.canonicalCreativeTaskAssociation(taskId);
    if (!association) return history;
    const { taskType } = association;
    const converter = this.resolveLegacyFormatConverter(association.legacyFormatConverter);
    return history?.map(message => ({
      ...message,
      content: projectCanonicalCreativeAncillaryValue(message.content, taskType, converter),
    })) as Message[] | undefined;
  }

  /**
   * Clear conversation history for a task
   */
  clearConversationHistory(taskId: string): void {
    this.executor.clearConversationHistory(taskId);
    this.forgetCanonicalCreativeTaskAssociationKeys([taskId]);
    this.productPolicyRequestParamsByTask.delete(taskId);
  }

  // ====== AGENT INFORMATION ======

  /**
   * Get the agent configuration with normalized protocol
   *
   * Returns the agent config with:
   * - Protocol normalized (e.g., .well-known URLs switch to A2A)
   * - If canonical URL has been resolved, agent_uri will be the canonical URL
   *
   * For guaranteed canonical URL, use getResolvedAgent() instead.
   */
  getAgent(): AgentConfig {
    // If we have resolved the canonical URL, return config with it
    if (this.canonicalBaseUrl) {
      const { _needsDiscovery, _needsCanonicalUrl, ...cleanAgent } = this.normalizedAgent;
      return {
        ...cleanAgent,
        agent_uri: this.canonicalBaseUrl,
      };
    }

    // Return normalized agent without internal flags
    const { _needsDiscovery, _needsCanonicalUrl, ...cleanAgent } = this.normalizedAgent;
    return { ...cleanAgent };
  }

  /**
   * Get the fully resolved agent configuration
   *
   * This async method ensures the agent config has the canonical URL resolved:
   * - For A2A: Fetches the agent card and uses its 'url' field
   * - For MCP: Performs endpoint discovery
   *
   * @returns Promise resolving to agent config with canonical URL
   */
  async getResolvedAgent(): Promise<AgentConfig> {
    await this.resolveCanonicalUrl();
    return this.getAgent();
  }

  /**
   * Get the agent ID
   */
  getAgentId(): string {
    return this.agent.id;
  }

  /**
   * Get the agent name
   */
  getAgentName(): string {
    return this.agent.name;
  }

  /**
   * Get the agent protocol (may be normalized from original config)
   */
  getProtocol(): 'mcp' | 'a2a' {
    return this.normalizedAgent.protocol;
  }

  /** Resolved MCP endpoint already used by this client; never performs discovery. */
  getDiscoveredMcpEndpoint(): string | undefined {
    return this.discoveredEndpoint;
  }

  /**
   * Get the canonical base URL for this agent
   *
   * Returns the canonical URL if already resolved, or computes it synchronously
   * from the configured URL. For the most accurate canonical URL (especially for A2A
   * where the agent card contains the authoritative URL), use resolveCanonicalUrl() first.
   *
   * The canonical URL is:
   * - For A2A: The 'url' field from the agent card (if resolved), or base URL with
   *   the well-known agent card path stripped
   * - For MCP: The discovered endpoint with /mcp stripped
   *
   * @returns The canonical base URL (synchronous, may not be fully resolved)
   */
  getCanonicalUrl(): string {
    // Return cached canonical URL if available
    if (this.canonicalBaseUrl) {
      return this.canonicalBaseUrl;
    }

    // Compute from configured URL (best effort without network call)
    return this.computeBaseUrl(this.normalizedAgent.agent_uri);
  }

  /**
   * Resolve and return the canonical base URL for this agent
   *
   * This async method ensures the canonical URL is properly resolved:
   * - For A2A: Fetches the agent card and uses its 'url' field
   * - For MCP: Performs endpoint discovery and strips /mcp suffix
   *
   * The result is cached, so subsequent calls are fast.
   *
   * @returns Promise resolving to the canonical base URL
   */
  async resolveCanonicalUrl(): Promise<string> {
    if (this.canonicalBaseUrl) {
      return this.canonicalBaseUrl;
    }

    if (this.normalizedAgent.protocol === 'a2a') {
      await this.ensureCanonicalUrlResolved();
    } else if (this.normalizedAgent.protocol === 'mcp') {
      await this.ensureEndpointDiscovered();
    }

    return this.canonicalBaseUrl || this.computeBaseUrl(this.normalizedAgent.agent_uri);
  }

  /**
   * Check if this agent is the same as another agent
   *
   * Compares agents by their canonical base URLs. Two agents are considered
   * the same if they have the same canonical URL, regardless of:
   * - Protocol (MCP vs A2A)
   * - URL format (with/without /mcp, with/without well-known agent card path)
   * - Trailing slashes
   *
   * @param other - Another agent configuration or SingleAgentClient to compare
   * @returns true if agents have the same canonical URL
   */
  isSameAgent(other: AgentConfig | SingleAgentClient): boolean {
    const thisUrl = this.getCanonicalUrl().toLowerCase();

    let otherUrl: string;
    if (other instanceof SingleAgentClient) {
      otherUrl = other.getCanonicalUrl().toLowerCase();
    } else {
      otherUrl = this.computeBaseUrl(other.agent_uri).toLowerCase();
    }

    return thisUrl === otherUrl;
  }

  /**
   * Async version of isSameAgent that resolves canonical URLs first
   *
   * This provides more accurate comparison for A2A agents since it fetches
   * the agent card to get the authoritative canonical URL.
   *
   * @param other - Another agent configuration or SingleAgentClient to compare
   * @returns Promise resolving to true if agents have the same canonical URL
   */
  async isSameAgentResolved(other: AgentConfig | SingleAgentClient): Promise<boolean> {
    const thisUrl = (await this.resolveCanonicalUrl()).toLowerCase();

    let otherUrl: string;
    if (other instanceof SingleAgentClient) {
      otherUrl = (await other.resolveCanonicalUrl()).toLowerCase();
    } else {
      // For raw AgentConfig, we can only compute from the URL
      otherUrl = this.computeBaseUrl(other.agent_uri).toLowerCase();
    }

    return thisUrl === otherUrl;
  }

  /**
   * Get active tasks for this agent
   */
  getActiveTasks() {
    return this.executor
      .getActiveTasks()
      .filter(task => task.agent.id === this.agent.id)
      .map(task => {
        assertNativeRequestProposalsTask(task);
        if (!CANONICAL_CREATIVE_ACTIVITY_TASKS.has(task.taskName)) return task;
        const converter = this.resolveLegacyFormatConverter(
          this.canonicalCreativeTaskAssociation(task.taskId)?.legacyFormatConverter
        );
        return stripLegacyCreativeIdentity({
          ...task,
          params: projectCanonicalCreativeAncillaryValue(task.params, task.taskName, converter),
          messages: task.messages.map(message => ({
            ...message,
            content: projectCanonicalCreativeAncillaryValue(message.content, task.taskName, converter),
          })),
          ...(task.pendingInput !== undefined && {
            pendingInput: projectCanonicalCreativeAncillaryValue(task.pendingInput, task.taskName, converter),
          }),
        }) as TaskState;
      });
  }

  // ====== TASK MANAGEMENT & NOTIFICATIONS ======

  /**
   * List all tasks for this agent with detailed information
   *
   * @returns Promise resolving to array of task information
   *
   * @example
   * ```typescript
   * const tasks = await client.listTasks();
   * tasks.forEach(task => {
   *   console.log(`${task.taskName}: ${task.status}`);
   * });
   * ```
   */
  async listTasks(): Promise<TaskInfo[]> {
    const tasks = await this.executor.getTaskList(this.agent.id);
    return tasks.map(task =>
      assertNativeRequestProposalsTask(
        CANONICAL_CREATIVE_ACTIVITY_TASKS.has(task.taskType)
          ? this.canonicalizeCreativeTaskInfo(
              task,
              task.taskType,
              undefined,
              this.resolveLegacyFormatConverter(
                this.canonicalCreativeTaskAssociation(task.taskId)?.legacyFormatConverter
              )
            )
          : task
      )
    );
  }

  /**
   * Get detailed information about a specific task
   *
   * @param taskId - ID of the task to get information for
   * @returns Promise resolving to task information
   */
  async getTaskInfo(taskId: string): Promise<TaskInfo | null> {
    const task = await this.executor.getTaskInfo(taskId);
    if (!task) return null;
    return assertNativeRequestProposalsTask(
      CANONICAL_CREATIVE_ACTIVITY_TASKS.has(task.taskType)
        ? this.canonicalizeCreativeTaskInfo(
            task,
            task.taskType,
            undefined,
            this.resolveLegacyFormatConverter(this.canonicalCreativeTaskAssociation(task.taskId)?.legacyFormatConverter)
          )
        : task
    );
  }

  /**
   * Subscribe to task notifications for this agent
   *
   * @param callback - Function to call when task status changes
   * @returns Unsubscribe function
   *
   * @example
   * ```typescript
   * const unsubscribe = client.onTaskUpdate((task) => {
   *   console.log(`Task ${task.taskName} is now ${task.status}`);
   *   if (task.status === 'completed') {
   *     // Handle completion
   *   }
   * });
   *
   * // Later, stop listening
   * unsubscribe();
   * ```
   */
  onTaskUpdate(callback: (task: TaskInfo) => void): () => void {
    return this.executor.onTaskUpdate(this.agent.id, task =>
      callback(
        assertNativeRequestProposalsTask(
          CANONICAL_CREATIVE_ACTIVITY_TASKS.has(task.taskType)
            ? this.canonicalizeCreativeTaskInfo(
                task,
                task.taskType,
                undefined,
                this.resolveLegacyFormatConverter(
                  this.canonicalCreativeTaskAssociation(task.taskId)?.legacyFormatConverter
                )
              )
            : task
        )
      )
    );
  }

  /**
   * Subscribe to all task events (create, update, complete, error)
   *
   * @param callbacks - Event callbacks for different task events
   * @returns Unsubscribe function
   */
  onTaskEvents(callbacks: {
    onTaskCreated?: (task: TaskInfo) => void;
    onTaskUpdated?: (task: TaskInfo) => void;
    onTaskCompleted?: (task: TaskInfo) => void;
    onTaskFailed?: (task: TaskInfo, error: string) => void;
  }): () => void {
    const safe = (task: TaskInfo): TaskInfo =>
      assertNativeRequestProposalsTask(
        CANONICAL_CREATIVE_ACTIVITY_TASKS.has(task.taskType)
          ? this.canonicalizeCreativeTaskInfo(
              task,
              task.taskType,
              undefined,
              this.resolveLegacyFormatConverter(
                this.canonicalCreativeTaskAssociation(task.taskId)?.legacyFormatConverter
              )
            )
          : task
      );
    return this.executor.onTaskEvents(this.agent.id, {
      ...(callbacks.onTaskCreated && { onTaskCreated: task => callbacks.onTaskCreated!(safe(task)) }),
      ...(callbacks.onTaskUpdated && { onTaskUpdated: task => callbacks.onTaskUpdated!(safe(task)) }),
      ...(callbacks.onTaskCompleted && { onTaskCompleted: task => callbacks.onTaskCompleted!(safe(task)) }),
      ...(callbacks.onTaskFailed && {
        onTaskFailed: (task, error) => {
          const safeTask = safe(task);
          callbacks.onTaskFailed!(safeTask, safeTask.error ?? stripLegacyCreativeIdentity(error));
        },
      }),
    });
  }

  /**
   * Register webhook URL for receiving task notifications
   *
   * @param webhookUrl - URL to receive webhook notifications
   * @param taskTypes - Optional array of task types to watch (defaults to all)
   *
   * @example
   * ```typescript
   * await client.registerWebhook('https://myapp.com/webhook', ['create_media_buy']);
   * ```
   */
  async registerWebhook(webhookUrl: string, taskTypes?: string[]): Promise<void> {
    const agent = await this.ensureEndpointDiscovered();
    return this.executor.registerWebhook(agent, webhookUrl, taskTypes);
  }

  /**
   * Unregister webhook notifications
   */
  async unregisterWebhook(): Promise<void> {
    const agent = await this.ensureEndpointDiscovered();
    return this.executor.unregisterWebhook(agent);
  }

  // ====== AGENT DISCOVERY METHODS ======

  /**
   * Get comprehensive agent information including name, description, and available tools/skills
   *
   * Works with both MCP (tools) and A2A (skills) protocols to discover what the agent can do.
   *
   * Auth resolution: this method forwards `agent.headers` as `customHeaders`
   * to the MCP transport so header-only auth (HTTP Basic via gateways like
   * Apigee/Kong, x-api-key, custom tenant routing) reaches the precheck
   * path. The invariant — **basic-auth credentials live entirely on
   * `headers.Authorization`; do not also set `auth_token`** — is documented
   * at `docs/guides/BASIC-AUTH.md`. See #1864 for the failure mode if it's
   * violated.
   *
   * @returns Promise resolving to agent information including tools
   *
   * @example
   * ```typescript
   * const client = new ADCPClient(agentConfig);
   * const info = await client.getAgentInfo();
   *
   * console.log(`${info.name}: ${info.description}`);
   * console.log(`Supports ${info.tools.length} tools`);
   *
   * info.tools.forEach(tool => {
   *   console.log(`  - ${tool.name}: ${tool.description}`);
   * });
   * ```
   */
  async getAgentInfo(options?: ReadRequestOptions): Promise<{
    name: string;
    description?: string;
    protocol: 'mcp' | 'a2a';
    url: string;
    tools: Array<{
      name: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
      parameters?: string[];
    }>;
  }> {
    return withMCPConnectionPolicy(normalizeTransportOptions(options?.transport ?? this.config.transport), () =>
      this.getAgentInfoWithConnectionPolicy(options)
    );
  }

  private async getAgentInfoWithConnectionPolicy(options?: ReadRequestOptions): Promise<{
    name: string;
    description?: string;
    protocol: 'mcp' | 'a2a';
    url: string;
    tools: Array<{
      name: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
      parameters?: string[];
    }>;
  }> {
    throwIfAborted(options?.signal);
    const reuse = this.config._reuseConfiguredDiscovery?.() && !this.usesScopedDiscoveryTransport(options);
    if (!reuse) return this.getAgentInfoLive(options);
    const scopeKey = this.getCapabilityEvidenceScope().scopeKey;
    if (this.runAgentInfo) return structuredClone(this.runAgentInfo);
    const info = await this.getAgentInfoLive(options);
    if (reuse && scopeKey === this.getCapabilityEvidenceScope().scopeKey) {
      this.runAgentInfo = structuredClone(info);
      const documents = new Map(
        this.runAgentInfo.tools.filter(tool => tool.inputSchema).map(tool => [tool.name, tool.inputSchema!])
      );
      this.cachedToolSchemas = new Map(
        [...documents].map(([name, schema]) => [name, (schema.properties ?? {}) as Record<string, unknown>])
      );
      toolInputSchemasByProperties.set(this.cachedToolSchemas, documents);
    }
    return info;
  }

  private async getAgentInfoLive(options?: ReadRequestOptions): Promise<{
    name: string;
    description?: string;
    protocol: 'mcp' | 'a2a';
    url: string;
    tools: Array<{
      name: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
      parameters?: string[];
    }>;
  }> {
    // adcp-client#1799 — wrap every wire call in the response-size cap so
    // `transport.maxResponseBytes` extends to discovery / tools-list bodies.
    // `withResponseSizeLimit` installs the 4 MiB default when no cap is
    // configured (adcp-client#3253).
    const { withResponseSizeLimit } = await import('../protocols/responseSizeLimit');
    throwIfAborted(options?.signal);
    const transport = normalizeTransportOptions(options?.transport ?? this.config.transport);
    const maxResponseBytes = transport?.maxResponseBytes;
    const requestTimeoutMs = resolveRequestTimeoutMs(transport?.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    const clientRequestTimeoutMs = resolveClientRequestTimeoutMs(transport?.requestTimeoutMs);
    const mcpRequestOptions = {
      ...(options?.signal && { signal: options.signal }),
      ...(clientRequestTimeoutMs !== undefined && { timeout: clientRequestTimeoutMs }),
    };
    const discoveryAdcpVersion = this.getWireAdcpVersion();
    const mcpListParams =
      parseAdcpMajorVersion(discoveryAdcpVersion) >= 3
        ? { _meta: { adcp_version: toReleasePrecisionVersion(discoveryAdcpVersion) } }
        : undefined;
    const ensureReadAuthToken = async (): Promise<string | undefined> => {
      if (!this.normalizedAgent.oauth_client_credentials) return this.normalizedAgent.auth_token;
      const { ensureClientCredentialsTokens, getAgentStorage } = await import('../auth/oauth');
      await ensureClientCredentialsTokens(this.normalizedAgent, {
        storage: getAgentStorage(this.normalizedAgent),
        allowPrivateIp: transport?.allowPrivateIp ?? isLikelyPrivateUrl(this.normalizedAgent.agent_uri),
        fetch: transport?.trustedFetchFn,
        signal: options?.signal,
      });
      return this.normalizedAgent.oauth_tokens?.access_token;
    };
    if (this.normalizedAgent.protocol === 'mcp') {
      // In-process: use the pre-connected client instead of opening a new HTTP connection
      if (this.normalizedAgent._inProcessMcpClient) {
        const mcpClient = this.normalizedAgent._inProcessMcpClient;
        const toolsList = await withResponseSizeLimit(maxResponseBytes, () =>
          mcpClient.listTools(mcpListParams, mcpRequestOptions)
        );
        const tools = toolsList.tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema as Record<string, unknown> | undefined,
          parameters: tool.inputSchema?.properties ? Object.keys(tool.inputSchema.properties as object) : [],
        }));
        return {
          name: this.normalizedAgent.name,
          description: undefined,
          protocol: this.normalizedAgent.protocol,
          url: this.normalizedAgent.agent_uri,
          tools,
        };
      }

      const readAuthToken = await ensureReadAuthToken();
      // Discover endpoint if needed
      const agent = await this.ensureEndpointDiscovered(options);

      // Use the shared connectMCP path so both static bearer AND saved OAuth
      // tokens work. OAuth takes the refresh-capable authProvider branch.
      // Header-only auth (basic, x-api-key, custom routing) lives on
      // `normalizedAgent.headers` and must be forwarded as `customHeaders` —
      // basic auth in particular suppresses `auth_token` on purpose so the
      // SDK doesn't emit a competing `Authorization: Bearer …`.
      const { connectMCP } = await import('../protocols/mcp');
      const { tryListModernMCPTools } = await import('../protocols/mcp-modern');
      const connectOptions: Parameters<typeof connectMCP>[0] = { agentUrl: agent.agent_uri };
      if (options?.signal) {
        connectOptions.signal = options.signal;
      }
      if (transport?.requestTimeoutMs !== undefined) {
        connectOptions.requestTimeoutMs = transport.requestTimeoutMs;
      }
      if (transport?.trustedFetchFn) {
        connectOptions.fetchFn = transport.trustedFetchFn;
      }
      if (transport?.allowPrivateIp !== undefined) {
        connectOptions.allowPrivateIp = transport.allowPrivateIp;
      }
      if (this.normalizedAgent.headers && Object.keys(this.normalizedAgent.headers).length > 0) {
        connectOptions.customHeaders = this.normalizedAgent.headers;
      }
      let authProvider: Parameters<typeof connectMCP>[0]['authProvider'];
      if (this.normalizedAgent.oauth_tokens && !this.normalizedAgent.oauth_client_credentials) {
        const { getAgentStorage } = await import('../auth/oauth');
        const { getNonInteractiveOAuthProvider } = await import('../auth/oauth/provider-cache');
        authProvider = getNonInteractiveOAuthProvider(this.normalizedAgent, {
          agentHint: this.normalizedAgent.id,
          storage: getAgentStorage(this.normalizedAgent),
          allowHttp: isLikelyPrivateUrl(this.normalizedAgent.agent_uri),
        });
        connectOptions.authProvider = authProvider;
      } else if (readAuthToken) {
        connectOptions.authToken = readAuthToken;
      }

      const modernTools =
        !this.usesScopedDiscoveryTransport(options) &&
        this.discoveredMcpEra === 'legacy' &&
        Date.now() - this.discoveredMcpEraAt < 5 * 60 * 1000
          ? ({ handled: false } as const)
          : await withResponseSizeLimit(maxResponseBytes, () =>
              tryListModernMCPTools(agent.agent_uri, readAuthToken, this.normalizedAgent.headers, {
                authProvider,
                ...(mcpListParams?._meta.adcp_version !== undefined && {
                  adcpVersion: mcpListParams._meta.adcp_version,
                }),
                signal: options?.signal,
                requestTimeoutMs: transport?.requestTimeoutMs,
                fetchFn: transport?.trustedFetchFn,
                allowPrivateIp: transport?.allowPrivateIp,
              })
            );
      if (modernTools.handled) {
        const tools = modernTools.tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          parameters: tool.inputSchema?.properties ? Object.keys(tool.inputSchema.properties) : [],
        }));
        return {
          name: this.normalizedAgent.name,
          description: undefined,
          protocol: this.normalizedAgent.protocol,
          url: agent.agent_uri,
          tools,
        };
      }

      // Inside a caller-owned connection scope, list on the scope's shared v1
      // session so discovery and the tool calls that follow initialize once.
      const { withScopedLegacyConnection } = await import('../protocols/mcp');
      const scopedList = await withScopedLegacyConnection(connectOptions, 'tools/list', client =>
        withResponseSizeLimit(maxResponseBytes, () => client.listTools(mcpListParams, mcpRequestOptions))
      );
      if (scopedList) {
        return {
          name: this.normalizedAgent.name,
          description: undefined,
          protocol: this.normalizedAgent.protocol,
          url: agent.agent_uri,
          tools: scopedList.value.tools.map(tool => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            parameters: tool.inputSchema?.properties ? Object.keys(tool.inputSchema.properties) : [],
          })),
        };
      }

      const { client: mcpClient } = await connectMCP(connectOptions);
      try {
        const toolsList = await withResponseSizeLimit(maxResponseBytes, () =>
          mcpClient.listTools(mcpListParams, mcpRequestOptions)
        );

        const tools = toolsList.tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          parameters: tool.inputSchema?.properties ? Object.keys(tool.inputSchema.properties) : [],
        }));

        return {
          name: this.normalizedAgent.name,
          description: undefined,
          protocol: this.normalizedAgent.protocol,
          url: agent.agent_uri,
          tools,
        };
      } finally {
        try {
          await mcpClient.close();
        } catch {
          /* ignore */
        }
      }
    } else if (this.normalizedAgent.protocol === 'a2a') {
      // Use A2A SDK to get agent card

      // adcp-client#1799 — route the custom fetchImpl through
      // `wrapFetchWithSizeLimit` so the active ALS slot enforces the cap on
      // the card-discovery body. Without this, the auth-stamping wrapper
      // calls native `fetch` directly and ignores `transport.maxResponseBytes`.
      const { wrapFetchWithSizeLimit } = await import('../protocols/responseSizeLimit');
      const authToken = await ensureReadAuthToken();
      const agentHeaders = this.normalizedAgent.headers ?? {};
      const configuredAgentUrl = this.normalizedAgent.agent_uri;
      const sizeLimitedFetch = wrapFetchWithSizeLimit(
        createAgentTransportFetch(configuredAgentUrl, {
          trustedFetchFn: transport?.trustedFetchFn,
          allowPrivateIp: transport?.allowPrivateIp,
        })
      );
      const fetchImpl = async (url: string | URL | Request, requestInit?: RequestInit) => {
        const headers = a2aScopedHeaders(url, requestInit?.headers, configuredAgentUrl, agentHeaders, authToken);
        return withAbortSignal<Response>([options?.signal, requestInit?.signal], requestTimeoutMs, signal =>
          sizeLimitedFetch(url as RequestInfo | URL, { ...requestInit, headers, signal })
        );
      };

      const cardUrls = buildCardUrls(this.normalizedAgent.agent_uri);

      let client: A2AClient | undefined;
      let lastCardError: Error = new Error(`A2A agent card not found at ${cardUrls.join(', ')}`);
      for (const cardUrl of cardUrls) {
        try {
          // Wrap A2A card discovery so `transport.maxResponseBytes` applies
          // to agent-card fetches and the deferred `agentCardPromise` read
          // below — both fire fetches that would otherwise bypass the cap.
          client = await withResponseSizeLimit(maxResponseBytes, () =>
            createA2AClientFromCardUrl(cardUrl, fetchImpl, transport?.legacyCompat)
          );
          break;
        } catch (err: unknown) {
          lastCardError = err as Error;
        }
      }
      if (!client) {
        throw lastCardError;
      }
      const agentCard = await withResponseSizeLimit(maxResponseBytes, async () => {
        const compatibleClient = client as unknown as {
          getAgentCard?: () => Promise<any>;
          agentCardPromise?: Promise<any>;
          agentCard?: any;
        };
        return typeof compatibleClient.getAgentCard === 'function'
          ? compatibleClient.getAgentCard()
          : (compatibleClient.agentCardPromise ?? compatibleClient.agentCard);
      });

      const tools = agentCard?.skills
        ? agentCard.skills.map(
            (skill: {
              id?: string;
              name: string;
              description?: string;
              inputSchema?: Record<string, unknown>;
              inputFormats?: string[];
            }) => ({
              name: skill.id || skill.name,
              description: skill.description,
              inputSchema: skill.inputSchema,
              parameters: skill.inputFormats || [],
            })
          )
        : [];

      return {
        name: agentCard?.name || this.normalizedAgent.name,
        description: agentCard?.description,
        protocol: this.normalizedAgent.protocol,
        url: this.normalizedAgent.agent_uri,
        tools,
      };
    }

    throw new Error(`Unsupported protocol: ${this.normalizedAgent.protocol}`);
  }

  /**
   * Get agent capabilities, including AdCP version support
   *
   * For v3 servers, calls get_adcp_capabilities tool.
   * Requires AdCP 3 capability discovery; retired AdCP 2 agents are rejected.
   *
   * @returns Promise resolving to normalized capabilities object
   *
   * @example
   * ```typescript
   * const capabilities = await client.getCapabilities();
   *
   * console.log(`Server version: ${capabilities.version}`);
   * console.log(`Protocols: ${capabilities.protocols.join(', ')}`);
   *
   * if (capabilities.features.propertyListFiltering) {
   *   // Use v3 property list features
   * }
   * ```
   */
  async getCapabilities(options?: ReadRequestOptions): Promise<AdcpCapabilities> {
    return withMCPConnectionPolicy(normalizeTransportOptions(options?.transport ?? this.config.transport), () =>
      this.getCapabilitiesWithConnectionPolicy(options)
    );
  }

  private async getCapabilitiesWithConnectionPolicy(options?: ReadRequestOptions): Promise<AdcpCapabilities> {
    throwIfAborted(options?.signal);
    this.synchronizeCapabilityEvidenceAuthorizationScope();
    const discoveryContext = (options as InternalReadRequestOptions | undefined)?.[CAPABILITY_DISCOVERY_CONTEXT];
    const transport = normalizeTransportOptions(options?.transport ?? this.config.transport);
    const usesScopedFetch = this.usesScopedDiscoveryTransport(options);
    // Application-owned evidence keeps its declared freshness bound after it
    // has been installed. Once expired, discard both capability and schema
    // evidence and perform ordinary discovery below.
    if (this.primedCapabilitiesExpiresAt !== undefined && this.primedCapabilitiesExpiresAt <= Date.now()) {
      this.cachedCapabilities = undefined;
      this.cachedToolSchemas = undefined;
      this.primedCapabilitiesExpiresAt = undefined;
      this.capabilitiesFromSharedCache = false;
    }

    // With a shared discoveryCache, local evidence is only valid for the policy
    // (transport overrides, headers, version) it was gathered under, and only
    // until anything sharing that key invalidates it.
    const effectiveSharedKey =
      this.config.discoveryCache && !usesScopedFetch && this.cachedCapabilities
        ? this.sharedDiscoveryKey(options)
        : undefined;
    if (
      this.config.discoveryCache &&
      !usesScopedFetch &&
      this.cachedCapabilities &&
      (this.sharedEvidenceKey !== effectiveSharedKey ||
        (effectiveSharedKey !== undefined &&
          this.sharedEvidenceEpoch !== undefined &&
          this.sharedEvidenceEpoch !== this.sharedInvalidationEpoch(effectiveSharedKey)))
    ) {
      this.cachedCapabilities = undefined;
      this.cachedToolSchemas = undefined;
      this.primedCapabilitiesExpiresAt = undefined;
      this.capabilitiesFromSharedCache = false;
    }

    // Return cached if available
    if (!usesScopedFetch && this.cachedCapabilities) {
      if (discoveryContext) discoveryContext.toolSchemas = this.cachedToolSchemas;
      this.assertSupportedServer(this.cachedCapabilities);
      return this.cachedCapabilities;
    }

    if (!usesScopedFetch && this.config.discoveryCache) {
      return this.discoverCapabilitiesThroughSharedCache(options, usesScopedFetch, discoveryContext);
    }
    return this.discoverCapabilitiesLive(options, usesScopedFetch, discoveryContext);
  }

  /**
   * Serve capabilities from the shared `discoveryCache`, or discover them live
   * as the single in-process "leader" for this cache key. Concurrent clients
   * for the same key wait for the leader under their *own* signal and deadline;
   * a leader that fails or is cancelled never fails its followers, which then
   * discover for themselves.
   */
  private async discoverCapabilitiesThroughSharedCache(
    options: ReadRequestOptions | undefined,
    usesScopedFetch: boolean,
    discoveryContext: CapabilityDiscoveryContext | undefined
  ): Promise<AdcpCapabilities> {
    const config = this.config.discoveryCache!;
    const key = this.sharedDiscoveryKey(options);
    if (!key) return this.discoverCapabilitiesLive(options, usesScopedFetch, discoveryContext);

    let flights = sharedDiscoveryFlights.get(config.cache);
    if (!flights) {
      flights = new Map();
      sharedDiscoveryFlights.set(config.cache, flights);
    }

    for (let attempt = 0; ; attempt++) {
      const readEpoch = this.discoveryEpochSnapshot(options);
      const entry = await this.readSharedDiscovery(options);
      const installed =
        entry &&
        (!readEpoch || this.discoveryEpochIs(readEpoch)) &&
        this.installSharedCapabilities(entry, key, discoveryContext);
      if (installed) return installed;

      const flight = flights.get(key);
      if (flight && attempt < MAX_SHARED_DISCOVERY_WAITS) {
        const requestTimeoutMs = resolveRequestTimeoutMs(
          options?.transport?.requestTimeoutMs ?? this.config.transport?.requestTimeoutMs
        );
        // Rejects only for this caller's own abort or timeout.
        await withAbortSignal([options?.signal], requestTimeoutMs, () => flight);
        continue;
      }

      let finish!: () => void;
      const mine = new Promise<void>(resolve => (finish = resolve));
      const ownsFlight = !flights.has(key);
      if (ownsFlight) flights.set(key, mine);
      try {
        return await this.discoverCapabilitiesLive(options, usesScopedFetch, discoveryContext);
      } finally {
        if (ownsFlight) {
          // The (weakly held) map stays: a follower may hold it, and dropping it
          // would let a later caller start a second, unseen one.
          flights.delete(key);
        }
        finish();
      }
    }
  }

  /** Install capabilities from a shared entry; `undefined` when the entry is not usable evidence. */
  private installSharedCapabilities(
    entry: AgentDiscoveryEntry,
    key: string,
    discoveryContext: CapabilityDiscoveryContext | undefined
  ): AdcpCapabilities | undefined {
    const capabilities = entry.capabilities;
    if (!isCapabilityEvidence(capabilities) || capabilities._synthetic) return undefined;
    const toolSchemas = entry.toolSchemas;
    const hasToolEvidence = toolSchemas !== undefined || Array.isArray(capabilities.discoveredTools);
    if (!hasToolEvidence) return undefined;
    if (toolSchemas !== undefined && !isToolSchemaRecord(toolSchemas)) {
      return undefined;
    }
    if (entry.toolInputSchemas !== undefined && (!toolSchemas || !isToolSchemaRecord(entry.toolInputSchemas))) {
      return undefined;
    }
    let installed: AdcpCapabilities;
    let schemas: Map<string, Record<string, unknown>> | undefined;
    try {
      installed = structuredClone(capabilities);
      schemas = toolSchemas
        ? new Map(Object.entries(toolSchemas).map(([tool, properties]) => [tool, structuredClone(properties)]))
        : undefined;
      if (schemas && entry.toolInputSchemas) {
        toolInputSchemasByProperties.set(
          schemas,
          new Map(Object.entries(entry.toolInputSchemas).map(([tool, schema]) => [tool, structuredClone(schema)]))
        );
      }
    } catch {
      // A malformed entry from a custom backend is a miss, not a failed call.
      return undefined;
    }
    this.cachedCapabilities = installed;
    this.cachedToolSchemas = schemas;
    this.primedCapabilitiesExpiresAt = entry.expiresAt;
    this.capabilitiesFromSharedCache = true;
    this.recordSharedEvidence(key);
    if (discoveryContext) discoveryContext.toolSchemas = this.cachedToolSchemas;
    this.assertSupportedServer(installed);
    return installed;
  }

  private async discoverCapabilitiesLive(
    options: ReadRequestOptions | undefined,
    usesScopedFetch: boolean,
    discoveryContext: CapabilityDiscoveryContext | undefined
  ): Promise<AdcpCapabilities> {
    const startedAtEpoch = this.discoveryEpochSnapshot(options);
    // An invalidation that lands while this discovery is in flight wins: its
    // result still serves this call but must not be re-installed anywhere.
    const superseded = () => startedAtEpoch !== undefined && !this.discoveryEpochIs(startedAtEpoch);

    // First get tool list to support both detection methods
    const agentInfo = await this.getAgentInfo(options);
    const tools: ToolInfo[] = agentInfo.tools.map(t => ({
      name: t.name,
      description: t.description,
    }));

    // Make raw tool schemas available for field-level compatibility checks
    // (e.g. buying_mode on get_products). Scoped fetch keeps them in the
    // request-local discovery context; unscoped calls may share the cache.
    const discoveredInputSchemas = new Map(
      agentInfo.tools.filter(t => t.inputSchema).map(t => [t.name, t.inputSchema! as Record<string, unknown>])
    );
    const discoveredToolSchemas = new Map(
      [...discoveredInputSchemas].map(([name, schema]) => [name, (schema.properties ?? {}) as Record<string, unknown>])
    );
    toolInputSchemasByProperties.set(discoveredToolSchemas, discoveredInputSchemas);
    if (discoveryContext) discoveryContext.toolSchemas = discoveredToolSchemas;
    if (!usesScopedFetch && !superseded()) this.cachedToolSchemas = discoveredToolSchemas;

    // Check if agent supports get_adcp_capabilities (v3)
    const advertisesCapabilitiesTool = tools.some(t => t.name === 'get_adcp_capabilities');
    // The official A2A adapter omits discovery from the public skill card but
    // does advertise the framework task lifecycle. That combination is safe
    // evidence that get_adcp_capabilities is routable. Do not blindly probe
    // arbitrary A2A agents: an unadvertised call can consume application work
    // or change session state on non-AdCP routers.
    const officialA2ALifecycle =
      this.normalizedAgent.protocol === 'a2a' &&
      tools.some(tool => ['tasks/get', 'get_task_status', 'list_tasks'].includes(tool.name));
    const hasCapabilitiesTool = advertisesCapabilitiesTool || officialA2ALifecycle;

    if (hasCapabilitiesTool) {
      try {
        // ensureEndpointDiscovered is a no-op for in-process agents (_needsDiscovery is false
        // because normalizeAgentConfig returns early when _inProcessMcpClient is set). The
        // executor then hits ProtocolClient.callTool which reads _inProcessMcpClient directly,
        // so the sentinel adcp-in-process:// URI never reaches validateAgentUrl.
        const agent = await this.ensureEndpointDiscovered(options);
        // Capability discovery can run inside another task's deadline scope. Do
        // not forward that scope's private operation ID: the probe is a
        // separate physical task with its own webhook registration. Preserve
        // the caller's cancellation, transport safeguards, callback policy,
        // and callback authorization provenance. The active OpenTelemetry
        // context remains in the async chain, correlating both physical tasks.
        const callerOptions = options as CapabilityProbeRequestOptions | undefined;
        const isPreview = !!parseAdcpRelease(this.resolvedAdcpVersion)?.prerelease;
        const probeOptions: CapabilityProbeRequestOptions = {
          // Discover the seller's release window before claiming a preview
          // older sellers may reject. Ordinary calls still negotiate exact
          // preview evidence or a maintained stable downgrade afterwards.
          ...(isPreview && {
            versionEnvelope: callerOptions?.versionEnvelope ?? this.config.versionEnvelope ?? 'none',
            disableWebhook: true,
          }),
          ...(options?.signal !== undefined && { signal: options.signal }),
          ...(options?.transport !== undefined && { transport: options.transport }),
          ...(callerOptions?.disableWebhook !== undefined &&
            !isPreview && {
              disableWebhook: callerOptions.disableWebhook,
            }),
          ...(callerOptions?.delegatedOperatorAuthorization !== undefined && {
            delegatedOperatorAuthorization: { ...callerOptions.delegatedOperatorAuthorization },
          }),
        };
        const result = await this.executor.executeTask<any>(
          agent,
          'get_adcp_capabilities',
          {},
          undefined,
          probeOptions
        );
        throwIfAborted(options?.signal);
        const requestTimeoutMs = resolveRequestTimeoutMs(
          options?.transport?.requestTimeoutMs ?? this.config.transport?.requestTimeoutMs
        );
        if (
          !result.success &&
          requestTimeoutMs !== undefined &&
          /\b(requesttimeout|timeout|timed out)\b/i.test(result.error ?? '')
        ) {
          throw createTimeoutError(requestTimeoutMs);
        }

        if (result.success && result.data) {
          const capabilities = augmentCapabilitiesFromTools(parseCapabilitiesResponse(result.data), tools);
          this.assertSupportedServer(capabilities);
          if (!usesScopedFetch && !superseded()) {
            this.cachedCapabilities = capabilities;
            this.capabilitiesFromSharedCache = false;
            // Only an authoritative, validated response is shared; every
            // synthetic fallback below stays private to this instance.
            if (!capabilities._synthetic && this.config.discoveryCache) {
              this.recordSharedEvidence(this.sharedDiscoveryKey(options));
              const stored = await this.writeSharedDiscovery(
                options,
                {
                  capabilities: structuredClone(capabilities),
                  toolSchemas: Object.fromEntries(discoveredToolSchemas),
                  toolInputSchemas: Object.fromEntries(discoveredInputSchemas),
                },
                false,
                startedAtEpoch
              );
              if (superseded()) {
                // Invalidated while the write was in flight: drop this copy, but
                // never a newer live result another call has installed since.
                if (this.cachedCapabilities === capabilities) {
                  this.cachedCapabilities = undefined;
                  this.cachedToolSchemas = undefined;
                  this.primedCapabilitiesExpiresAt = undefined;
                }
              } else {
                // The live result honors the same freshness bound as shared copies.
                this.primedCapabilitiesExpiresAt =
                  stored?.expiresAt ?? Date.now() + resolveAgentDiscoveryTtlMs(this.config.discoveryCache.ttlMs);
              }
            }
          }
          this.assertSupportedServer(capabilities);
          return capabilities;
        }
        if (!advertisesCapabilitiesTool) {
          throw new Error('unadvertised official A2A capability probe was not supported');
        }
        // Recover usable capabilities from a structurally v3-shaped response
        // that failed validation (issue #1189). Explicit unsupported version
        // declarations must still be rejected before logging recovery or caching.
        // CodeQL: deliberately omit `result.error` from the log (matches the
        // existing fallback log below) — it can carry transport-level agent
        // identifiers that flow through the clear-text-logging tracker.
        if (result.data && looksLikeV3Capabilities(result.data)) {
          const capabilities = augmentCapabilitiesFromTools(parseCapabilitiesResponse(result.data), tools);
          this.assertSupportedServer(capabilities);
          console.warn(
            `[AdCP] Agent "${this.agent.id}" returned a get_adcp_capabilities response that ` +
              `failed validation, but the response is structurally v3-shaped. Treating as v3 ` +
              `(the agent has a wire-shape bug — that's the thing to fix).`,
            { hasError: !!result.error, hasData: !!result.data }
          );
          if (!usesScopedFetch && !superseded()) {
            this.cachedCapabilities = capabilities;
            this.capabilitiesFromSharedCache = false;
            this.recordSharedEvidence(this.sharedDiscoveryKey(options));
          }
          this.assertSupportedServer(capabilities);
          return capabilities;
        }
        // The call returned non-success and the response wasn't even
        // structurally v3-shaped (so the heuristic above didn't catch it),
        // OR data is missing entirely. The agent still advertises the
        // v3-only `get_adcp_capabilities` tool, so it's verifiably v3 —
        // synthesize v3 capabilities from the tool list and continue
        // (issue #1217). Falling back to v2 here cascades into "AdCP
        // schema data for version v2.5 not found" errors that obscure
        // the real bug (the broken capabilities response).
        //
        // We deliberately omit `result.data` and `result.error` from the
        // log: they can carry OAuth metadata or transport-level identifiers
        // (CodeQL clear-text-logging tracker). Shape booleans + status are
        // enough to triage.
        console.warn(
          `[AdCP] Agent "${this.agent.id}" advertises get_adcp_capabilities but the call ` +
            `returned non-success and the response is not v3-shaped — treating as v3 (synthetic) ` +
            `since the agent has the v3-only discovery tool. ` +
            `This client routes to v3 adapters, but calls reading capability details ` +
            `(idempotency TTL, supported_versions, feature flags) will fail until the agent ` +
            `operator fixes the capabilities endpoint.`,
          {
            success: result.success,
            hasError: !!result.error,
            hasData: !!result.data,
          }
        );
      } catch (error: unknown) {
        // Re-throw errors that indicate real infrastructure problems —
        // only fall through for tool-execution failures (the agent
        // advertises get_adcp_capabilities but can't actually serve it).
        if (
          error instanceof AuthenticationRequiredError ||
          error instanceof VersionUnsupportedError ||
          error instanceof ConfigurationError ||
          error instanceof TaskTimeoutError ||
          isAbortOrTimeoutError(error)
        ) {
          throw error;
        }
        if (advertisesCapabilitiesTool) {
          console.warn(
            `[AdCP] Agent "${this.agent.id}" advertises get_adcp_capabilities but the call ` +
              `threw — treating as v3 (synthetic) since the agent has the v3-only discovery tool. ` +
              `This client routes to v3 adapters, but calls reading capability details ` +
              `(idempotency TTL, supported_versions, feature flags) will fail until the agent ` +
              `operator fixes the capabilities endpoint.`
          );
        }
      }

      // Synthesize v3 capabilities from the tool list. Reached only when
      // the executor returned non-v3-shaped data, OR threw a non-auth
      // non-timeout error. The agent's v3-only tool list is the affirmative
      // signal that it's v3 even though we couldn't read details.
      if (advertisesCapabilitiesTool) {
        const capabilities = augmentCapabilitiesFromTools(buildSyntheticV3Capabilities(tools), tools);
        if (!usesScopedFetch && !superseded()) {
          this.cachedCapabilities = capabilities;
          this.capabilitiesFromSharedCache = false;
          this.recordSharedEvidence(this.sharedDiscoveryKey(options));
        }
        this.assertSupportedServer(capabilities);
        return capabilities;
      }
    }

    throw new VersionUnsupportedError('get_adcp_capabilities', 'synthetic', 'v2', this.agent.agent_uri);
  }

  /**
   * Return the client-bound scope required by {@link primeCapabilities}.
   *
   * Obtain this scope before an application-owned, tenant-scoped preflight and
   * attach it unchanged to the resulting snapshot. The opaque key prevents a
   * snapshot collected for another client, credential, or transport instance
   * from being installed accidentally.
   */
  getCapabilityEvidenceScope(): CapabilityEvidenceScope {
    this.synchronizeCapabilityEvidenceAuthorizationScope();
    return Object.freeze({
      agentUri: this.normalizedAgent.agent_uri,
      adcpVersion: this.resolvedAdcpVersion,
      scopeKey: this.capabilityEvidenceScopeKey,
    });
  }

  private currentCapabilityEvidenceAuthMaterial(): string {
    // OAuth refresh updates the normalized transport agent in place/replaces
    // its token bundle. Bind evidence to that effective credential state,
    // rather than the constructor argument that may now be stale.
    const effectiveAgent = this.normalizedAgent;
    return canonicalizeJson({
      authToken: effectiveAgent.auth_token ?? null,
      connectionPartition: this.config.transport?.connectionPartition ?? null,
      headers: effectiveAgent.headers ?? null,
      oauthTokens: effectiveAgent.oauth_tokens ?? null,
      oauthClient: effectiveAgent.oauth_client ?? null,
      oauthResource: effectiveAgent.oauth_resource ?? null,
      oauthClientCredentials: effectiveAgent.oauth_client_credentials ?? null,
      oauthCodeVerifier: effectiveAgent.oauth_code_verifier ?? null,
    });
  }

  private synchronizeCapabilityEvidenceAuthorizationScope(): void {
    const current = this.currentCapabilityEvidenceAuthMaterial();
    if (this.capabilityEvidenceAuthMaterial === undefined) {
      this.capabilityEvidenceAuthMaterial = current;
      return;
    }
    if (current === this.capabilityEvidenceAuthMaterial) return;
    this.capabilityEvidenceAuthMaterial = current;
    this.discoveryEpoch++;
    this.runAgentInfo = undefined;
    this.cachedCapabilities = undefined;
    this.cachedToolSchemas = undefined;
    this.primedCapabilitiesExpiresAt = undefined;
    this.capabilityEvidenceScopeKey = randomUUID();
    if (this.config._reuseConfiguredDiscovery?.()) {
      this.discoveredEndpoint = undefined;
      this.discoveredAgent = undefined;
      this.canonicalBaseUrl = undefined;
      this.discoveredMcpEra = undefined;
    }
  }

  /** A comply() run owns its configured fetch; per-call transport changes still discover separately. */
  private usesScopedDiscoveryTransport(options?: ReadRequestOptions): boolean {
    const transport = normalizeTransportOptions(options?.transport ?? this.config.transport);
    const configured = normalizeTransportOptions(this.config.transport);
    if (transport?.connectionPartition !== configured?.connectionPartition) return true;
    if (!this.config._reuseConfiguredDiscovery?.()) return transport?.trustedFetchFn !== undefined;
    return (
      transport?.trustedFetchFn !== configured?.trustedFetchFn ||
      transport?.allowPrivateIp !== configured?.allowPrivateIp ||
      transport?.maxResponseBytes !== configured?.maxResponseBytes ||
      transport?.requestTimeoutMs !== configured?.requestTimeoutMs ||
      transport?.legacyCompat?.enabled !== configured?.legacyCompat?.enabled
    );
  }

  /**
   * Reuse a fresh capability observation made by the embedding application.
   *
   * Returns `false` and leaves discovery cold when the scope, endpoint,
   * configured release, or freshness window does not match. Per-call scoped
   * transports (`trustedFetchFn`) continue to bypass this cache and discover
   * within their own request scope.
   */
  primeCapabilities(snapshot: CapabilityEvidenceSnapshot): boolean {
    const expected = this.getCapabilityEvidenceScope();
    const scope = snapshot?.scope;
    const capabilities = snapshot?.capabilities;
    const observedAt = Date.parse(typeof snapshot?.observedAt === 'string' ? snapshot.observedAt : '');
    const expiresAt = Date.parse(typeof snapshot?.expiresAt === 'string' ? snapshot.expiresAt : '');
    const now = Date.now();
    const matchesScope =
      typeof scope === 'object' &&
      scope !== null &&
      scope.scopeKey === expected.scopeKey &&
      scope.agentUri === expected.agentUri &&
      scope.adcpVersion === expected.adcpVersion;
    const isFresh =
      Number.isFinite(observedAt) &&
      Number.isFinite(expiresAt) &&
      observedAt <= now &&
      expiresAt > now &&
      expiresAt >= observedAt;
    const hasCapabilities = isCapabilityEvidence(capabilities);
    const hasValidToolSchemas =
      snapshot?.toolSchemas === undefined ||
      (typeof snapshot.toolSchemas === 'object' &&
        snapshot.toolSchemas !== null &&
        Object.values(snapshot.toolSchemas).every(
          properties => typeof properties === 'object' && properties !== null && !Array.isArray(properties)
        ));
    const configuredScopedFetch = this.usesScopedDiscoveryTransport();
    const hasToolEvidence = snapshot?.toolSchemas !== undefined || Array.isArray(capabilities?.discoveredTools);
    if (
      !matchesScope ||
      !isFresh ||
      !hasCapabilities ||
      !hasValidToolSchemas ||
      !hasToolEvidence ||
      configuredScopedFetch
    ) {
      this.cachedCapabilities = undefined;
      this.cachedToolSchemas = undefined;
      this.primedCapabilitiesExpiresAt = undefined;
      this.capabilitiesFromSharedCache = false;
      return false;
    }

    try {
      const observedTools = [
        ...new Set([...(capabilities.discoveredTools ?? []), ...Object.keys(snapshot.toolSchemas ?? {})]),
      ].map(name => ({ name }));
      this.cachedCapabilities = augmentCapabilitiesFromTools(structuredClone(capabilities), observedTools);
      this.primedCapabilitiesExpiresAt = expiresAt;
      // Application-owned evidence, not a shared-cache copy: a failed feature
      // check must not discard it as if it were stale shared evidence.
      this.capabilitiesFromSharedCache = false;
      this.recordSharedEvidence(this.sharedDiscoveryKey(), true);
      this.cachedToolSchemas = snapshot.toolSchemas
        ? new Map(
            Object.entries(snapshot.toolSchemas).map(([tool, properties]) => [
              tool,
              structuredClone(properties) as Record<string, unknown>,
            ])
          )
        : undefined;
      return true;
    } catch {
      this.cachedCapabilities = undefined;
      this.cachedToolSchemas = undefined;
      this.primedCapabilitiesExpiresAt = undefined;
      return false;
    }
  }

  /** Which kind of credential this client presents (never its value), so an unauthenticated client cannot adopt an authenticated one's evidence. */
  private discoveryCredentialKind(): string {
    const agent = this.normalizedAgent;
    if (agent.oauth_client_credentials) return 'oauth-client-credentials';
    if (agent.oauth_tokens) return 'oauth';
    if (agent.auth_token) return 'bearer';
    const headerNames = Object.keys(agent.headers ?? {}).map(name => name.toLowerCase());
    return headerNames.includes('authorization') || headerNames.includes('x-adcp-auth') ? 'header' : 'none';
  }

  /** Epoch of this client's evidence for the call's effective shared key; `undefined` without a shared cache. */
  private discoveryEpochSnapshot(
    options?: ReadRequestOptions
  ): { local: number; shared: number; key: string } | undefined {
    const key = this.sharedDiscoveryKey(options);
    if (!key || !this.config.discoveryCache) {
      return this.config._reuseConfiguredDiscovery?.() ? { local: this.discoveryEpoch, shared: 0, key: '' } : undefined;
    }
    return { local: this.discoveryEpoch, shared: this.sharedInvalidationEpoch(key), key };
  }

  private discoveryEpochIs(epoch: { local: number; shared: number; key: string }): boolean {
    return (
      epoch.local === this.discoveryEpoch && (!epoch.key || epoch.shared === this.sharedInvalidationEpoch(epoch.key))
    );
  }

  /** The latest invalidation that applies to `key`: its own, combined with the cache's floor of forgotten ones. */
  private sharedInvalidationRecord(key: string): SharedInvalidation | undefined {
    const cache = this.config.discoveryCache!.cache;
    const record = sharedInvalidations.get(cache)?.get(key);
    const floor = sharedInvalidationFloors.get(cache);
    if (!floor) return record;
    if (!record) return floor;
    return { epoch: Math.max(record.epoch, floor.epoch), at: Math.max(record.at, floor.at) };
  }

  private sharedInvalidationEpoch(key: string): number {
    return this.sharedInvalidationRecord(key)?.epoch ?? 0;
  }

  private bumpSharedInvalidationEpoch(key: string): void {
    const cache = this.config.discoveryCache!.cache;
    let records = sharedInvalidations.get(cache);
    if (!records) {
      records = new Map();
      sharedInvalidations.set(cache, records);
    }
    const now = Date.now();
    // Re-inserting keeps the map ordered oldest-first for pruning.
    records.delete(key);
    records.set(key, { epoch: ++sharedInvalidationCounter, at: now });
    for (const [oldKey, record] of records) {
      if (records.size <= MAX_SHARED_INVALIDATION_RECORDS && record.at + MAX_AGENT_DISCOVERY_TTL_MS > now) break;
      const floor = sharedInvalidationFloors.get(cache);
      sharedInvalidationFloors.set(cache, {
        epoch: Math.max(record.epoch, floor?.epoch ?? 0),
        at: Math.max(record.at, floor?.at ?? 0),
      });
      records.delete(oldKey);
    }
  }

  /**
   * Remember which key the local capability evidence belongs to and, unless it
   * is application-owned (`primeCapabilities`), the shared invalidation epoch it
   * was obtained under. Application-owned evidence keeps its caller-declared
   * freshness and is not discarded by another instance's invalidation.
   */
  private recordSharedEvidence(key: string | undefined, applicationOwned = false): void {
    this.sharedEvidenceKey = key;
    this.sharedEvidenceEpoch =
      key && this.config.discoveryCache && !applicationOwned ? this.sharedInvalidationEpoch(key) : undefined;
  }

  /** Non-secret fingerprint of the request-signing identity, so keys never mix signing identities. */
  private discoverySigningFingerprint(): unknown {
    const signing = this.normalizedAgent.request_signing;
    if (!signing) return undefined;
    const provider = signing.kind === 'provider' ? signing.provider : undefined;
    return {
      kind: signing.kind ?? 'inline',
      agentUrl: signing.agent_url ?? null,
      kid: (provider ? provider.keyid : (signing as { kid?: string }).kid) ?? null,
      alg: (provider ? provider.algorithm : (signing as { alg?: string }).alg) ?? null,
      alwaysSign: signing.always_sign ?? null,
      alwaysSignProtocolMethods: signing.always_sign_protocol_methods ?? null,
      unsignedCapabilityBootstrap: hasUnsignedCapabilityBootstrap(signing),
      signSupported: signing.sign_supported ?? null,
    };
  }

  /**
   * Shared-discovery key for the effective transport policy of this call, or
   * `undefined` when sharing is off or the call uses a scoped `trustedFetchFn`
   * (whose network boundary is per-call, so its evidence is never shared).
   */
  private sharedDiscoveryKey(options?: ReadRequestOptions): string | undefined {
    const config = this.config.discoveryCache;
    if (!config) return undefined;
    const transport = normalizeTransportOptions(options?.transport ?? this.config.transport);
    if (transport?.trustedFetchFn !== undefined) return undefined;
    return agentDiscoveryCacheKey({
      protocol: this.normalizedAgent.protocol,
      agentUri: this.normalizedAgent.agent_uri,
      adcpVersion: this.resolvedAdcpVersion,
      wireAdcpVersion: this.config.wireAdcpVersion,
      authIdentity: config.authIdentity,
      connectionPartition: transport?.connectionPartition,
      credentialKind: this.discoveryCredentialKind(),
      headers: withAmbientIdentityHeaders(this.normalizedAgent.headers),
      signing: this.discoverySigningFingerprint(),
      allowPrivateIp: transport?.allowPrivateIp,
      maxResponseBytes: transport?.maxResponseBytes,
    });
  }

  /**
   * Run a shared-cache operation under the caller's signal and a fixed backend
   * deadline, so an unresponsive store can neither make a call uncancellable nor
   * stall it beyond {@link SHARED_DISCOVERY_CACHE_TIMEOUT_MS}. Rejects on the
   * caller's abort or when the backend fails or times out; callers decide which
   * of those is a miss.
   */
  private boundedCacheOperation<T>(operation: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
    return withAbortSignal([signal], SHARED_DISCOVERY_CACHE_TIMEOUT_MS, () => Promise.resolve().then(operation));
  }

  /**
   * Run one backend mutation (or read-modify-write) for a shared key strictly
   * after every earlier mutation of that key in this process has actually
   * settled. The caller's wait is still bounded: an unresponsive backend makes
   * the caller see a miss, but later mutations stay queued behind the hung
   * operation, so an old callback can never land after a newer one.
   *
   * The queue is bounded. A `droppable` mutation (a write or cleanup) is
   * abandoned when its caller stopped waiting before it started, and is refused
   * when the key's queue is full; refusal is a failed write, never a call
   * failure. A `delete` is never refused for a known key: while one is queued
   * and not yet started, a newer invalidation joins it. Only for a new key beyond
   * the key cap is a delete refused — the invalidation tombstone still hides the
   * entry from this process's readers.
   */
  private serializedCacheMutation<T>(
    key: string,
    operation: () => T | Promise<T>,
    signal?: AbortSignal,
    kind: 'delete' | 'droppable' = 'droppable'
  ): Promise<T> {
    const cache = this.config.discoveryCache!.cache;
    let chains = sharedMutationChains.get(cache);
    if (!chains) {
      chains = new Map();
      sharedMutationChains.set(cache, chains);
    }
    let queue = chains.get(key);
    if (!queue && chains.size >= MAX_SHARED_MUTATION_KEYS) {
      return Promise.reject(new Error('Shared discovery cache mutation queue is full.'));
    }
    if (kind === 'delete' && queue?.waitingDelete && !queue.waitingDelete.started) {
      const joined = queue.waitingDelete.promise as Promise<T>;
      return this.boundedCacheOperation(() => joined, signal);
    }
    if (kind === 'droppable' && queue && queue.pending >= MAX_PENDING_SHARED_MUTATIONS_PER_KEY) {
      return Promise.reject(new Error('Shared discovery cache mutation queue is full.'));
    }
    if (!queue) {
      queue = { tail: Promise.resolve(), pending: 0 };
      chains.set(key, queue);
    }
    const current = queue;
    const state = { abandoned: false, started: false };
    const run = current.tail.then(() => {
      if (kind === 'droppable' && state.abandoned) throw new Error('Shared discovery cache mutation abandoned.');
      state.started = true;
      if (current.waitingDelete?.promise === run) current.waitingDelete.started = true;
      return operation();
    });
    current.pending++;
    if (kind === 'delete') current.waitingDelete = { promise: run, started: false };
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    current.tail = tail;
    void tail.then(() => {
      current.pending--;
      if (current.waitingDelete?.promise === run) current.waitingDelete = undefined;
      if (current.pending === 0) {
        if (chains.get(key) === current) chains.delete(key);
        if (chains.size === 0 && sharedMutationChains.get(cache) === chains) sharedMutationChains.delete(cache);
      }
    });
    return this.boundedCacheOperation(() => run, signal).catch(error => {
      state.abandoned = true;
      throw error;
    });
  }

  /** Is this stored entry structurally sound and not expired (before any caller-TTL cap)? */
  private isLiveSharedEntry(entry: AgentDiscoveryEntry, now: number): boolean {
    return (
      Number.isFinite(entry.expiresAt) &&
      Number.isFinite(entry.observedAt) &&
      entry.expiresAt >= entry.observedAt &&
      entry.expiresAt > now
    );
  }

  /**
   * Read a fresh, structurally valid shared entry. A backend failure or
   * timeout is a miss, never a call failure; the caller's own abort propagates.
   */
  private async readSharedDiscovery(options?: ReadRequestOptions): Promise<AgentDiscoveryEntry | undefined> {
    const key = this.sharedDiscoveryKey(options);
    if (!key) return undefined;
    const cache = this.config.discoveryCache!.cache;
    const epoch = this.discoveryEpochSnapshot(options);
    try {
      const entry = await this.boundedCacheOperation(() => cache.get(key), options?.signal);
      // A read that was in flight when the evidence was invalidated is a miss.
      if (epoch && !this.discoveryEpochIs(epoch)) return undefined;
      if (!entry) return undefined;
      // An entry observed before the latest invalidation here is stale evidence
      // the backend has not (yet) dropped: its delete may have failed or still be queued.
      const invalidation = this.sharedInvalidationRecord(key);
      if (invalidation && entry.observedAt <= invalidation.at) return undefined;
      const now = Date.now();
      if (!this.isLiveSharedEntry(entry, now)) {
        // Remove it only if it is still the expired entry when the mutation runs:
        // a fresh seed or write may have replaced it meanwhile.
        await this.serializedCacheMutation(
          key,
          async () => {
            const current = await cache.get(key);
            if (current && !this.isLiveSharedEntry(current, Date.now())) await cache.delete(key);
          },
          options?.signal
        );
        return undefined;
      }
      // Hosts sharing a backend disagree about the time by a little; an entry
      // observed further in the future than that is not trusted, but is not ours to delete.
      if (entry.observedAt > now + SHARED_DISCOVERY_CLOCK_SKEW_MS) return undefined;
      // Another client may have stored this entry under a longer TTL; this
      // caller never trusts evidence older than its own configured window. The
      // stored entry is left for callers whose TTL still admits it.
      const callerExpiresAt = entry.observedAt + resolveAgentDiscoveryTtlMs(this.config.discoveryCache!.ttlMs);
      if (!(callerExpiresAt > now)) return undefined;
      return callerExpiresAt < entry.expiresAt ? { ...entry, expiresAt: callerExpiresAt } : entry;
    } catch {
      throwIfAborted(options?.signal);
      return undefined;
    }
  }

  /**
   * Merge fresh evidence into the shared entry; the merged entry never outlives
   * its oldest part. Returns the stored entry, or `undefined` when it was not
   * stored: automatic writes
   * ignore a `false` (a failed write only costs a later rediscovery), while
   * {@link primeDiscoveryCache} reports it.
   */
  private async writeSharedDiscovery(
    options: ReadRequestOptions | undefined,
    patch: Pick<AgentDiscoveryEntry, 'endpoint' | 'capabilities' | 'toolSchemas' | 'toolInputSchemas'>,
    replace = false,
    epoch = this.discoveryEpochSnapshot(options)
  ): Promise<AgentDiscoveryEntry | undefined> {
    const key = this.sharedDiscoveryKey(options);
    if (!key) return undefined;
    // URL queries and fragments can carry credentials. Keep such endpoints
    // local, while still allowing their capabilities and schemas to be shared.
    if (patch.endpoint && !this.isDiscoverableEndpoint(patch.endpoint.agentUri)) {
      patch = {
        capabilities: patch.capabilities,
        toolSchemas: patch.toolSchemas,
        toolInputSchemas: patch.toolInputSchemas,
      };
      if (!patch.capabilities && !patch.toolSchemas) return undefined;
    }
    const config = this.config.discoveryCache!;
    // An invalidation since `epoch` was taken wins over this writer. Staleness is
    // judged when the mutation reaches the front of the key's queue and again
    // after its read; a set already in flight when an invalidation arrives is
    // followed (never preceded) by that invalidation's delete, so it cannot
    // outlive it and no cleanup that could remove newer evidence is needed.
    const stale = () => epoch !== undefined && !this.discoveryEpochIs(epoch);
    try {
      return await this.serializedCacheMutation(
        key,
        async () => {
          if (stale()) return undefined;
          // Fresh evidence is stamped strictly after the latest invalidation here,
          // so the tombstone can tell it from anything observed before.
          const invalidation = this.sharedInvalidationRecord(key);
          const now = Math.max(Date.now(), (invalidation?.at ?? 0) + 1);
          let existing: AgentDiscoveryEntry | undefined;
          if (!replace) {
            const raw = await config.cache.get(key);
            // Nothing observed before the latest invalidation here is merged back
            // in: not the entry, and not an endpoint carried inside a newer one.
            if (
              raw &&
              this.isLiveSharedEntry(raw, now) &&
              raw.observedAt <= now + SHARED_DISCOVERY_CLOCK_SKEW_MS &&
              !(invalidation && raw.observedAt <= invalidation.at)
            ) {
              const endpointObservedAt = raw.endpoint?.observedAt ?? raw.observedAt;
              existing = { ...raw };
              if (
                existing.endpoint &&
                (!this.isDiscoverableEndpoint(existing.endpoint.agentUri) ||
                  (invalidation && endpointObservedAt <= invalidation.at))
              )
                delete existing.endpoint;
            }
            if (stale()) return undefined;
          }
          // Fresh capabilities restart the entry's clock; each endpoint keeps its own
          // observation time so merging never extends how long it may be trusted.
          const restartsClock = !existing || patch.capabilities !== undefined;
          const ttl = resolveAgentDiscoveryTtlMs(config.ttlMs);
          const entry: AgentDiscoveryEntry = {
            ...(existing?.capabilities && { capabilities: existing.capabilities }),
            ...(existing?.toolSchemas && { toolSchemas: existing.toolSchemas }),
            // Endpoint-only writes retain schema documents. Fresh tool evidence
            // replaces them together, including clearing older full documents
            // when the caller supplies only a property map.
            ...(patch.toolSchemas === undefined &&
              existing?.toolInputSchemas && {
                toolInputSchemas: existing.toolInputSchemas,
              }),
            ...(existing?.endpoint && { endpoint: existing.endpoint }),
            ...(patch.endpoint && { endpoint: { ...patch.endpoint, observedAt: now } }),
            ...(patch.capabilities && { capabilities: patch.capabilities }),
            ...(patch.toolSchemas && { toolSchemas: patch.toolSchemas }),
            ...(patch.toolInputSchemas && { toolInputSchemas: patch.toolInputSchemas }),
            observedAt: restartsClock || !existing ? now : Math.min(existing.observedAt, now),
            expiresAt: restartsClock || !existing ? now + ttl : Math.min(existing.expiresAt, now + ttl),
          };
          await config.cache.set(key, structuredClone(entry));
          return stale() ? undefined : entry;
        },
        options?.signal
      );
    } catch {
      return undefined;
    }
  }

  /** Is `agentUri` a credential-free URL on the configured agent's origin (all discovery ever tries)? */
  private isDiscoverableEndpoint(agentUri: unknown): agentUri is string {
    if (typeof agentUri !== 'string') return false;
    try {
      const candidate = new URL(agentUri);
      return (
        candidate.username === '' &&
        candidate.password === '' &&
        candidate.search === '' &&
        candidate.hash === '' &&
        candidate.origin === new URL(this.normalizedAgent.agent_uri).origin
      );
    } catch {
      return false;
    }
  }

  /** Adopt a previously discovered MCP endpoint instead of re-probing the agent. */
  private async adoptSharedEndpoint(options?: ReadRequestOptions): Promise<void> {
    const readEpoch = this.discoveryEpochSnapshot(options);
    const entry = await this.readSharedDiscovery(options);
    if (readEpoch && !this.discoveryEpochIs(readEpoch)) return;
    const endpoint = entry?.endpoint;
    // A cached endpoint that is not a path variant of the configured URL is not
    // something this client's discovery could have found.
    if (!entry || !endpoint || !this.isDiscoverableEndpoint(endpoint.agentUri)) return;
    // The endpoint is only as fresh as its own observation, under this caller's TTL.
    const observedAt = Number.isFinite(endpoint.observedAt) ? (endpoint.observedAt as number) : entry.observedAt;
    const sharedKey = this.sharedDiscoveryKey(options);
    const tombstone = sharedKey ? this.sharedInvalidationRecord(sharedKey) : undefined;
    if (tombstone && observedAt <= tombstone.at) return;
    const expiresAt = Math.min(
      entry.expiresAt,
      observedAt + resolveAgentDiscoveryTtlMs(this.config.discoveryCache!.ttlMs)
    );
    if (!(expiresAt > Date.now()) || observedAt > Date.now() + SHARED_DISCOVERY_CLOCK_SKEW_MS) return;
    this.discoveredEndpoint = endpoint.agentUri;
    this.discoveredEndpointKey = this.sharedDiscoveryKey(options);
    this.discoveredEndpointEpoch = this.discoveredEndpointKey
      ? this.sharedInvalidationEpoch(this.discoveredEndpointKey)
      : undefined;
    this.discoveredEndpointExpiresAt = expiresAt;
    this.canonicalBaseUrl = this.computeBaseUrl(endpoint.agentUri);
    if (endpoint.mcpEra === 'legacy' || endpoint.mcpEra === 'modern') {
      this.discoveredMcpEra = endpoint.mcpEra;
      // The era verdict is as old as the endpoint observation, not this adoption.
      this.discoveredMcpEraAt = observedAt;
    }
  }

  /**
   * Drop discovery evidence for this client: its in-memory capability and
   * tool-schema caches, the discovered endpoint, and the shared
   * `discoveryCache` entry (when configured). The next call rediscovers.
   *
   * Call this when you learn the seller changed (a deploy, a version bump, a
   * capability-dependent error you observed). The SDK also invalidates by
   * itself when a feature check fails against shared evidence, and when a
   * seller answers with a version or capability error.
   */
  async invalidateDiscoveryCache(options?: Pick<TaskOptions, 'transport'>): Promise<void> {
    this.runAgentInfo = undefined;
    if (this.config._reuseConfiguredDiscovery?.()) this.canonicalBaseUrl = undefined;
    this.cachedCapabilities = undefined;
    this.cachedToolSchemas = undefined;
    this.primedCapabilitiesExpiresAt = undefined;
    this.capabilitiesFromSharedCache = false;
    this.capabilityEvidenceScopeKey = randomUUID();
    this.discoveryEpoch++;
    if (this.normalizedAgent._needsDiscovery) {
      this.discoveredEndpoint = undefined;
      this.discoveredAgent = undefined;
      this.discoveredMcpEra = undefined;
      this.discoveredEndpointKey = undefined;
      this.discoveredEndpointEpoch = undefined;
      this.discoveredEndpointExpiresAt = undefined;
    }
    const key = this.sharedDiscoveryKey(options);
    if (!key) return;
    this.bumpSharedInvalidationEpoch(key);
    try {
      const cache = this.config.discoveryCache!.cache;
      // Queued behind any write already in flight, ahead of any later one.
      await this.serializedCacheMutation(key, () => cache.delete(key), undefined, 'delete');
    } catch {
      /* best effort */
    }
  }

  /**
   * Pre-seed the shared `discoveryCache` with capability evidence the caller
   * already holds (for example from a registry sync), so no client sharing
   * this identity probes the seller within the TTL. Unlike
   * {@link primeCapabilities} the seeded evidence outlives this instance.
   *
   * Returns `true` only once the backing cache has accepted the entry. Returns
   * `false` — having seeded nothing — when sharing is not configured, the
   * client uses a scoped `trustedFetchFn`, or the evidence is synthetic,
   * malformed or not cloneable. When the cache rejects the write or does not
   * answer within the backend deadline, the result is also `false`, but the
   * outcome is indeterminate: a write already handed to the backend may still
   * land, whereas one still queued behind earlier operations is dropped. Treat
   * `false` as "not confirmed", and seed again (or invalidate) rather than
   * assuming the cache is empty. Seed `endpoint` as well
   * to skip the endpoint probe on the first call; without it that probe still
   * runs once per cold client.
   */
  async primeDiscoveryCache(seed: AgentDiscoverySeed): Promise<boolean> {
    const key = this.sharedDiscoveryKey();
    const capabilities = seed?.capabilities;
    if (!key || !isCapabilityEvidence(capabilities) || capabilities._synthetic) return false;
    const toolSchemas = seed.toolSchemas;
    if (toolSchemas !== undefined && !isToolSchemaRecord(toolSchemas)) {
      return false;
    }
    if (toolSchemas === undefined && !Array.isArray(capabilities.discoveredTools)) return false;
    if (seed.endpoint !== undefined && !this.isDiscoverableEndpoint(seed.endpoint.agentUri)) return false;
    try {
      const stored = await this.writeSharedDiscovery(
        undefined,
        {
          capabilities: structuredClone(capabilities),
          ...(toolSchemas && { toolSchemas: structuredClone(toolSchemas) as Record<string, Record<string, unknown>> }),
          ...(seed.endpoint && {
            endpoint: {
              agentUri: seed.endpoint.agentUri,
              ...(seed.endpoint.mcpEra && { mcpEra: seed.endpoint.mcpEra }),
            },
          }),
        },
        true
      );
      return stored !== undefined;
    } catch {
      // Evidence that cannot be cloned is not evidence.
      return false;
    }
  }

  /** Drop shared evidence when a seller answers with an error that says our cached view of it is stale. */
  private async invalidateDiscoveryOnCapabilityError(
    code: string | undefined,
    options?: Pick<TaskOptions, 'transport'>
  ): Promise<void> {
    if (!this.config.discoveryCache || !code || !CAPABILITY_STALE_ERROR_CODES.has(code)) return;
    // The entry that served this call lives under its effective (per-call) transport policy.
    await this.invalidateDiscoveryCache(options);
  }

  /** Reject retired protocol generations before caching or dispatching. */
  private assertSupportedServer(capabilities: AdcpCapabilities): void {
    if (capabilities.version !== 'v3' || !capabilities.majorVersions.includes(3)) {
      throw new VersionUnsupportedError('get_adcp_capabilities', 'version', capabilities.version, this.agent.agent_uri);
    }
  }

  /**
   * Warn once per client when `requireSupportedMajor` accepts synthetic v3
   * capabilities — the agent advertised the v3-only `get_adcp_capabilities`
   * tool but the call itself failed, so the version + idempotency-TTL
   * checks were skipped. Adopters who depend on TTL guarantees (BYOK retry
   * callers, idempotency replay logic) should know they're in a degraded
   * mode where the agent is verifiably v3 but specifics are unverifiable
   * until the agent's capabilities endpoint is fixed.
   *
   * One-shot via `_syntheticV3WarningFired` (matches `maybeWarnV2Sunset`
   * cadence). Issue #1217.
   */
  private maybeWarnSyntheticV3(): void {
    if (this._syntheticV3WarningFired) return;
    this._syntheticV3WarningFired = true;
    console.warn(
      `[adcp] Warning: agent ${this.agent.agent_uri} advertises get_adcp_capabilities (v3-only) ` +
        `but the call failed. Treating as v3 (synthetic) — version + idempotency-TTL checks skipped. ` +
        `Calls to getIdempotencyReplayTtlSeconds() will throw until the agent's capabilities ` +
        `endpoint is fixed. Report the wire-shape bug to the agent operator at ${this.agent.agent_uri}.`
    );
  }

  /**
   * Detect server AdCP version
   *
   * @returns 'v2' or 'v3' based on server capabilities
   */
  async detectServerVersion(options?: ReadRequestOptions): Promise<'v2' | 'v3'> {
    const capabilities = await this.getCapabilities(options);
    const discoveryContext = (options as InternalReadRequestOptions | undefined)?.[CAPABILITY_DISCOVERY_CONTEXT];
    if (discoveryContext) discoveryContext.capabilities = capabilities;
    this.assertSupportedServer(capabilities);
    return capabilities.version;
  }

  /**
   * Check if server supports a specific AdCP major version
   */
  async supportsVersion(version: 3): Promise<boolean> {
    const capabilities = await this.getCapabilities();
    return version === 3 && capabilities.majorVersions.includes(3);
  }

  /**
   * Return the seller's declared `adcp.idempotency.replay_ttl_seconds`.
   *
   * BYOK callers use this to compare the age of persisted keys against the
   * seller's replay window — past the window, the safe recovery is a
   * natural-key lookup rather than reusing the key.
   *
   * Fails closed when the seller is v3 but does not declare the field: the
   * spec makes the declaration REQUIRED, and silently defaulting to 24h
   * would mislead buyers about retry safety.
   */
  async getIdempotencyReplayTtlSeconds(): Promise<number | undefined> {
    const capabilities = await this.getCapabilities();
    if (capabilities.idempotency?.supported === false) return undefined;
    if (capabilities.idempotency) {
      assertValidIdempotencyReplayTtlSeconds(capabilities.idempotency.replayTtlSeconds);
      return capabilities.idempotency.replayTtlSeconds;
    }
    throw new ConfigurationError(
      `Agent "${this.agent.id}" is v3 but does not declare adcp.idempotency.replay_ttl_seconds. ` +
        `The spec requires this for v3 sellers — treating the agent as non-compliant rather than ` +
        `defaulting to 24h, which would silently mislead retry-sensitive flows.`,
      'adcp.idempotency.replay_ttl_seconds'
    );
  }

  /**
   * Check if the seller supports a feature.
   *
   * Feature names resolve as follows:
   * - Protocol names ('media_buy', 'signals', etc.) check supported_protocols
   * - 'ext:<name>' checks extensions_supported
   * - 'targeting.<name>' checks media_buy.execution.targeting
   * - Other names check media_buy.features (e.g., 'audience_targeting', 'conversion_tracking')
   *
   * Absent features return false.
   */
  async supports(feature: FeatureName): Promise<boolean> {
    const capabilities = await this.getCapabilities();
    return resolveFeature(capabilities, feature);
  }

  /**
   * Require that the seller supports all listed features.
   * Throws FeatureUnsupportedError if any are missing.
   *
   * Call this before making feature-dependent task calls to fail fast
   * with an actionable error message.
   */
  async require(...features: FeatureName[]): Promise<void> {
    await this.assertFeaturesSupported(features);
  }

  /**
   * Throw {@link FeatureUnsupportedError} when a feature is missing, deciding on
   * live capabilities when the refusal would rest on shared evidence that may
   * predate a seller upgrade.
   */
  private async assertFeaturesSupported(
    requiredFeatures: readonly FeatureName[],
    options?: ReadRequestOptions
  ): Promise<void> {
    let capabilities = await this.getCapabilities(options);
    let missing = requiredFeatures.filter(f => !resolveFeature(capabilities, f));
    if (missing.length > 0 && this.capabilitiesFromSharedCache) {
      // Shared evidence may predate a seller upgrade: before refusing the
      // call, drop it and decide on live capabilities.
      await this.invalidateDiscoveryCache(options);
      capabilities = await this.getCapabilities(options);
      missing = requiredFeatures.filter(f => !resolveFeature(capabilities, f));
    }
    if (missing.length > 0) {
      throw new FeatureUnsupportedError(missing, listDeclaredFeatures(capabilities), this.agent.agent_uri);
    }
  }

  /**
   * Force-refresh cached capabilities from the server.
   * Useful when seller capabilities may have changed.
   */
  async refreshCapabilities(): Promise<AdcpCapabilities> {
    this.cachedCapabilities = undefined;
    this.cachedToolSchemas = undefined;
    this.primedCapabilitiesExpiresAt = undefined;
    this.capabilitiesFromSharedCache = false;
    this.capabilityEvidenceScopeKey = randomUUID();
    this.discoveryEpoch++;
    if (this.config.discoveryCache) await this.invalidateDiscoveryCache();
    return this.getCapabilities();
  }

  /**
   * Validate that the seller supports all features required by a task.
   * Throws FeatureUnsupportedError if any required features are missing.
   *
   * Skipped when validateFeatures is false or the task has no feature requirements.
   */
  private async validateTaskFeatures(taskName: string, options?: ReadRequestOptions): Promise<void> {
    if (this.config.validateFeatures === false) return;

    const requiredFeatures = TASK_FEATURE_MAP[taskName];
    if (!requiredFeatures || requiredFeatures.length === 0) return;

    await this.assertFeaturesSupported(requiredFeatures, options);
  }

  /**
   * Fail version-incompatible request shapes before schema validation.
   *
   * Some 3.1 request controls change behavior rather than merely filtering a
   * result set. A pre-3.1 client pin should not silently drop those controls
   * or let a generic schema error hide the recovery path.
   */
  private assertRequestSupportedByConfiguredVersion(
    taskName: string,
    params: unknown,
    options?: TaskOptions,
    canonicalCreativeInvocation = false
  ): void {
    const configuredVersion = this.config.wireAdcpVersion ?? this.resolvedAdcpVersion;
    const accountWireVersion = options?.wireAdcpVersion ?? configuredVersion;
    if (isPre32AdcpVersion(this.resolvedAdcpVersion) || isPre32AdcpVersion(accountWireVersion)) {
      this.assertLegacySyncAccountsIdentity(
        taskName,
        params,
        isPre32AdcpVersion(this.resolvedAdcpVersion) ? this.resolvedAdcpVersion : accountWireVersion
      );
    }
    const beta6Issue = beta6ReportingRequestIssue(taskName, params);
    if (beta6Issue && !isAdcpVersionAtLeast(configuredVersion, '3.2.0-beta.6')) {
      this.throwBeta6ReportingUnsupported(taskName, beta6Issue, configuredVersion);
    }
    if (
      taskName === 'preview_creative' &&
      canonicalCreativeInvocation &&
      isPre32AdcpVersion(this.config.wireAdcpVersion ?? this.resolvedAdcpVersion)
    ) {
      this.throwCanonicalPreviewUnsupported(this.config.wireAdcpVersion ?? this.resolvedAdcpVersion);
    }
    if (!isPre31AdcpVersion(this.resolvedAdcpVersion)) return;
    const request =
      params && typeof params === 'object' && !Array.isArray(params) ? (params as Record<string, unknown>) : {};

    if (taskName === 'get_signals' && request.discovery_mode === 'wholesale') {
      this.throwPre31UnsupportedFeature(taskName, 'discovery_mode', 'get_signals.discovery_mode=wholesale', {
        capabilityPath: 'signals.discovery_modes',
        suffix: 'Probe get_adcp_capabilities at signals.discovery_modes before issuing wholesale calls.',
      });
    }

    // An EXPLICIT push_notification_config on a discovery task is caller misuse
    // while hard-pinned <3.1: surface it rather than silently dropping the
    // caller's webhook. An AUTO-injected discovery webhook (from
    // `webhookUrlTemplate`) is degraded to polling instead; see
    // `suppressPre31DiscoveryWebhook`.
    if ((taskName === 'get_products' || taskName === 'get_signals') && request.push_notification_config !== undefined) {
      this.throwPre31UnsupportedFeature(taskName, 'push_notification_config', `${taskName}.push_notification_config`, {
        capabilityPath: 'adcp.supported_versions',
        suffix: 'Probe get_adcp_capabilities at adcp.supported_versions before relying on discovery task webhooks.',
      });
    }

    // Intentionally do not guard `if_wholesale_feed_version` /
    // `if_pricing_version`: 3.1 defines them as optimistic conditional
    // probes, and pre-3.1 sellers may safely ignore them and return the full
    // payload.
  }

  /**
   * Degrade the auto-injected get_products / get_signals discovery webhook to
   * polling when the client is pinned below 3.1. Discovery-task
   * `push_notification_config` is an AdCP 3.1 feature; a pre-3.1 seller would
   * reject it. Rather than throwing on the library's own auto-injected webhook
   * (which the caller never asked for), suppress it via `disableWebhook` and
   * record a `pre31_webhook_degraded` drift entry so the loss of push is
   * visible in `debug_logs`.
   *
   * Returns the effective options (a `disableWebhook` copy when suppressing,
   * otherwise the caller's unchanged) and an optional drift log to merge into
   * the result. Explicit caller-supplied `push_notification_config` is handled
   * by `assertRequestSupportedByConfiguredVersion` (it throws) and never
   * reaches here.
   */
  private suppressPre31DiscoveryWebhook(
    taskName: string,
    options?: TaskOptions,
    capabilities?: AdcpCapabilities
  ): { options: TaskOptions | undefined; driftLog?: Record<string, unknown> } {
    if (resolveAdapterKey(this.resolvedAdcpVersion, capabilities) !== '3.0') return { options };
    if (taskName !== 'get_products' && taskName !== 'get_signals') return { options };
    if (options?.disableWebhook) return { options };
    if (selectWebhookTemplate(this.config.webhookUrlTemplate, taskName) === undefined) return { options };

    const clientPinnedPre31 = isPre31AdcpVersion(this.resolvedAdcpVersion);
    const targetVersions = capabilities?.supportedVersions ?? [];
    const reason = clientPinnedPre31
      ? `this client is pinned to ${this.resolvedAdcpVersion}`
      : targetVersions.length > 0
        ? `the target seller advertises only ${targetVersions.join(', ')}`
        : 'the target seller does not advertise AdCP 3.1 support';
    return {
      options: { ...options, disableWebhook: true },
      driftLog: {
        type: 'pre31_webhook_degraded',
        message:
          `${taskName} discovery webhook degraded to polling: discovery-task push_notification_config ` +
          `requires AdCP 3.1, but ${reason}. ` +
          'The seller will not receive a push webhook; poll for the result instead.',
        timestamp: new Date().toISOString(),
        taskName,
        clientVersion: this.resolvedAdcpVersion,
        ...(targetVersions.length > 0 ? { targetVersions } : {}),
      },
    };
  }

  /**
   * Reject shape-changing 3.1 requests after seller capability discovery.
   * This second gate covers a modern client talking to a 3.0 seller on the
   * first (cold-cache) call; the configured-version gate above still catches
   * an explicitly pre-3.1 client before validation or network I/O.
   */
  private assertRequestSupportedByTargetVersion(
    taskName: string,
    params: unknown,
    capabilities: AdcpCapabilities | undefined,
    canonicalCreativeInvocation = false,
    serverVersion?: 'v2' | 'v3',
    negotiated?: NegotiatedAdcpRelease
  ): void {
    // Under 'reduce', a negotiated older release converts the account key
    // down (and reports it) instead of refusing it here.
    const reducesAccountIdentity = this.accountIdentityDowngrade === 'reduce' && negotiated?.downgraded === true;
    if (taskName === 'sync_accounts' && !reducesAccountIdentity) {
      const advertisedVersions = capabilities?.supportedVersions ?? [];
      const servedVersion = capabilities?.servedVersion ?? capabilities?._raw?.adcp_version;
      // The selected release takes precedence over the seller's broader
      // supported set. A build version is never evidence of wire support.
      const supports32 =
        serverVersion !== 'v2' &&
        (typeof servedVersion === 'string'
          ? isAdcpVersionAtLeast(servedVersion, '3.2.0-0')
          : advertisedVersions.some(version => isAdcpVersionAtLeast(version, '3.2.0-0')));
      if (!supports32) {
        this.assertLegacySyncAccountsIdentity(
          taskName,
          params,
          typeof servedVersion === 'string'
            ? servedVersion
            : advertisedVersions.join(', ') || serverVersion || 'unknown',
          'the target seller has not negotiated AdCP 3.2 support'
        );
      }
    }
    const beta6Issue = beta6ReportingRequestIssue(taskName, params);
    if (beta6Issue) {
      const advertisedVersions = capabilities?.supportedVersions ?? [];
      const responseVersion =
        typeof capabilities?._raw?.adcp_version === 'string' ? capabilities._raw.adcp_version : undefined;
      const supportsBeta6 =
        advertisedVersions.some(version => isAdcpVersionAtLeast(version, '3.2.0-beta.6')) ||
        (advertisedVersions.length === 0 && isAdcpVersionAtLeast(responseVersion, '3.2.0-beta.6'));
      const hasAuthoritativeLegacyEvidence =
        serverVersion === 'v2' ||
        advertisedVersions.length > 0 ||
        responseVersion !== undefined ||
        (capabilities?._synthetic === false && capabilities?.version === 'v3');
      if (!supportsBeta6 && hasAuthoritativeLegacyEvidence) {
        this.throwBeta6ReportingUnsupported(
          taskName,
          beta6Issue,
          advertisedVersions.join(', ') || responseVersion || serverVersion || capabilities?.version || 'unknown',
          'the target seller does not advertise AdCP 3.2.0-beta.6 support'
        );
      }
    }
    if (taskName === 'preview_creative' && canonicalCreativeInvocation) {
      const advertisedVersions = capabilities?.supportedVersions ?? [];
      const responseVersion =
        typeof capabilities?._raw?.adcp_version === 'string' ? capabilities._raw.adcp_version : undefined;
      const supports32 =
        advertisedVersions.some(version => !isPre32AdcpVersion(version)) ||
        (advertisedVersions.length === 0 && responseVersion !== undefined && !isPre32AdcpVersion(responseVersion));
      const hasAuthoritativeLegacyEvidence =
        serverVersion === 'v2' ||
        advertisedVersions.length > 0 ||
        responseVersion !== undefined ||
        (capabilities?._synthetic === false && capabilities?.version === 'v3');
      if (!supports32 && hasAuthoritativeLegacyEvidence) {
        this.throwCanonicalPreviewUnsupported(
          advertisedVersions.join(', ') || responseVersion || serverVersion || capabilities?.version || 'unknown',
          'the target seller does not advertise AdCP 3.2 support'
        );
      }
    }
    if (isPre31AdcpVersion(this.resolvedAdcpVersion)) return;
    // supportedVersions is the authoritative negotiation field. Legacy 3.0
    // sellers omit it; buildVersion is advisory and must not select a newer
    // wire shape. Shape-breaking wholesale discovery therefore requires
    // positive 3.1+ support from a declared v3 seller. The response envelope's
    // adcp_version is also direct evidence of the wire release the seller just
    // served (distinct from advisory adcp.build_version). Synthetic discovery
    // alone is not enough evidence to classify the seller as 3.0.
    const advertisedVersions = capabilities?.supportedVersions ?? [];
    if (advertisedVersions.some(version => !isPre31AdcpVersion(version))) return;
    const responseVersion =
      typeof capabilities?._raw?.adcp_version === 'string' ? capabilities._raw.adcp_version : undefined;
    if (advertisedVersions.length === 0 && responseVersion !== undefined && !isPre31AdcpVersion(responseVersion)) {
      return;
    }
    const declaredLegacyV3 = capabilities?.version === 'v3' && capabilities._synthetic === false;
    if (advertisedVersions.length === 0 && !declaredLegacyV3) return;
    const request =
      params && typeof params === 'object' && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
    if (taskName === 'get_signals' && request.discovery_mode === 'wholesale') {
      this.throwPre31UnsupportedFeature(taskName, 'discovery_mode', 'get_signals.discovery_mode=wholesale', {
        capabilityPath: 'signals.discovery_modes',
        currentVersion: advertisedVersions.join(', ') || responseVersion || '3.0 (not advertised)',
        incompatibility: 'the target seller does not advertise AdCP 3.1 support',
        suffix: 'Retry with a meaningful signal_spec, or probe signals.discovery_modes before issuing wholesale calls.',
      });
    }
  }

  /** Account-key fields must never be silently ignored by legacy sellers. */
  private assertLegacySyncAccountsIdentity(
    taskName: string,
    params: unknown,
    currentVersion: string,
    incompatibility = `this client is pinned to ${currentVersion}`
  ): void {
    if (taskName !== 'sync_accounts' || !params || typeof params !== 'object') return;
    const accounts = (params as Record<string, unknown>).accounts;
    if (!Array.isArray(accounts)) return;
    for (const [index, entry] of accounts.entries()) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      // Settings updates can address a natural key under `account`. Inspect
      // both locations even on mixed-mode rows: legacy sellers may ignore
      // `account` and provision from the top-level fields instead.
      for (const [key, path] of [
        [entry, `accounts[${index}]`],
        [entry.account, `accounts[${index}].account`],
      ] as const) {
        if (!key || typeof key !== 'object' || Array.isArray(key)) continue;
        const brand = key.brand;
        const identityField = ['operator_unit', 'currency', 'timezone'].find(
          field => Object.hasOwn(key, field) && key[field] !== undefined
        );
        const field = identityField
          ? `${path}.${identityField}`
          : brand && typeof brand === 'object' && Object.hasOwn(brand, 'countries') && brand.countries !== undefined
            ? `${path}.brand.countries`
            : undefined;
        if (!field) continue;
        const suggestion =
          'Use AdCP 3.2 or later on both the client (adcpVersion and wireAdcpVersion) and seller, ' +
          'or explicitly project to a legacy account key by removing operator_unit, currency, timezone, ' +
          'and brand.countries. Distinct keys may then share a seller account.';
        throw new ProtocolFeatureUnsupportedError([`${taskName}.${field}`], [], this.agent.agent_uri, {
          message: `${taskName} ${field} requires AdCP 3.2 or later; ${incompatibility}. No request was sent. ${suggestion}`,
          field,
          suggestion,
          details: {
            feature: `${taskName}.${field}`,
            required_version: '3.2',
            capability_path: 'adcp.supported_versions',
            current_version: currentVersion,
            tool: taskName,
            field,
          },
        });
      }
    }
  }

  private throwPre31UnsupportedFeature(
    taskName: string,
    field: string,
    feature: string,
    opts: { capabilityPath: string; suffix: string; currentVersion?: string; incompatibility?: string }
  ): never {
    const currentVersion = opts.currentVersion ?? this.resolvedAdcpVersion;
    const incompatibility = opts.incompatibility ?? `this client is pinned to ${this.resolvedAdcpVersion}`;
    throw new ProtocolFeatureUnsupportedError([feature], [], this.agent.agent_uri, {
      message: `${taskName} ${field} requires AdCP 3.1 or later; ` + `${incompatibility}. ${opts.suffix}`,
      field,
      suggestion: opts.suffix,
      details: {
        feature,
        required_version: '3.1',
        capability_path: opts.capabilityPath,
        current_version: currentVersion,
        tool: taskName,
        field,
      },
    });
  }

  private throwBeta6ReportingUnsupported(
    taskName: string,
    issue: Beta6DeliveryRequestIssue,
    currentVersion: string,
    incompatibility = `this client is pinned to ${currentVersion}`
  ): never {
    const suggestion = 'Negotiate AdCP 3.2.0-beta.6 or omit the beta.6 reporting field or metric.';
    throw new ProtocolFeatureUnsupportedError([`${taskName}.${issue.field}`], [], this.agent.agent_uri, {
      message: `${taskName} ${issue.field} requires AdCP 3.2.0-beta.6 or later; ${incompatibility}. ${suggestion}`,
      field: issue.field,
      suggestion,
      details: {
        feature: `${taskName}.${issue.field}`,
        required_version: '3.2.0-beta.6',
        capability_path: 'adcp.supported_versions',
        current_version: currentVersion,
        tool: taskName,
        field: issue.field,
      },
    });
  }

  private throwCanonicalPreviewUnsupported(currentVersion: string, incompatibility?: string): never {
    const suggestion =
      'Use previewCreativeLegacy() for format_id-based sellers, or negotiate AdCP 3.2 before calling previewCreative().';
    throw new ProtocolFeatureUnsupportedError(['preview_creative.canonical_identity'], [], this.agent.agent_uri, {
      message:
        `preview_creative canonical identity requires AdCP 3.2 or later; ` +
        `${incompatibility ?? `this client is pinned to ${currentVersion}`}. ${suggestion}`,
      field: 'target_capability_id',
      suggestion,
      details: {
        feature: 'preview_creative.canonical_identity',
        required_version: '3.2',
        capability_path: 'adcp.supported_versions',
        current_version: currentVersion,
        tool: 'preview_creative',
        field: 'target_capability_id',
      },
    });
  }

  /**
   * Assert that the seller's capabilities corroborate the major this client
   * is pinned to (per `getAdcpVersion()`).
   *
   * A self-reported `version: 'v3'` is not enough — a hostile or
   * misconfigured seller can just string-claim the version. For sellers
   * that return an authoritative `get_adcp_capabilities` response, the
   * guard requires:
   *
   *   1. `capabilities.majorVersions.includes(<this client's major>)`
   *   2. `capabilities.idempotency.replayTtlSeconds` present (spec-required
   *      for real major-3+ sellers)
   *
   * Synthetic v3 evidence is accepted only when the agent advertises discovery.
   * Agents without discovery and AdCP 2-only agents are rejected.
   *
   * Throws `VersionUnsupportedError` with the specific reason on failure.
   */
  async requireSupportedMajor(taskType: string = 'request', options?: ReadRequestOptions): Promise<void> {
    const capabilities = await this.getCapabilities(options);

    this.assertSupportedServer(capabilities);
    if (capabilities._synthetic) {
      this.maybeWarnSyntheticV3();
      return;
    }
    // Prefer release-precision matching when the seller advertises
    // `supported_versions` (AdCP 3.1+ per spec PR `adcontextprotocol/adcp#3493`).
    // Fall back to the deprecated integer `major_versions` for legacy 3.0
    // sellers. Pre-release pins match exactly per spec — `'3.1.0-beta.1'`
    // matches only against another `'3.1.0-beta.1'`, not `'3.1'`.
    //
    // A seller on an older release of the same major is compatible: requests
    // are converted down to the highest release both sides support. Only a
    // seller with no release on or below the client's line is refused.
    const supportedVersions = capabilities.supportedVersions;
    if (supportedVersions !== undefined && supportedVersions.length > 0) {
      if (
        !isAdcpVersionSupported(this.resolvedAdcpVersion, supportedVersions) &&
        this.negotiateCallRelease(capabilities, options as TaskOptions | undefined) === undefined
      ) {
        throw new VersionUnsupportedError(taskType, 'version', capabilities.version, this.agent.agent_uri);
      }
    } else {
      const expectedMajor = parseAdcpMajorVersion(this.resolvedAdcpVersion);
      const advertisedMajors = capabilities.majorVersions;
      if (!Number.isFinite(expectedMajor) || !advertisedMajors.includes(expectedMajor)) {
        throw new VersionUnsupportedError(taskType, 'version', capabilities.version, this.agent.agent_uri);
      }
    }
    if (capabilities.idempotency?.replayTtlSeconds === undefined) {
      throw new VersionUnsupportedError(taskType, 'idempotency', capabilities.version, this.agent.agent_uri);
    }
    assertValidIdempotencyReplayTtlSeconds(capabilities.idempotency.replayTtlSeconds);
  }

  /**
   * Deprecated alias for {@link requireSupportedMajor}. Original name from
   * the AdCP v2/v3 split; the function generalized in Stage 3 to check the
   * client's per-instance major instead of hardcoded 3, and `requireV3`
   * stopped reflecting what the function actually does.
   *
   * @deprecated Use `requireSupportedMajor()` instead.
   */
  async requireV3(taskType: string = 'request'): Promise<void> {
    return this.requireSupportedMajor(taskType);
  }

  // ====== STATIC HELPER METHODS ======

  /**
   * Query a legacy creative-agent named-format catalog.
   *
   * Canonical applications discover seller-supported declarations through
   * `AgentClient.getProducts()` and consume `format_options[]` instead.
   *
   * @param creativeAgentUrl - URL of the creative agent (e.g., 'https://creative.adcontextprotocol.org/mcp')
   * @param protocol - Protocol to use ('mcp' or 'a2a'), defaults to 'mcp'
   * @returns Promise resolving to the list of available formats
   *
   * @deprecated Migration-only helper for the legacy named-format protocol.
   */
  static async discoverCreativeFormatsLegacy(
    creativeAgentUrl: string,
    protocol: 'mcp' | 'a2a' = 'mcp'
  ): Promise<Format[]> {
    const client = new SingleAgentClient(
      {
        id: 'creative_agent_discovery',
        name: 'Creative Agent',
        agent_uri: creativeAgentUrl,
        protocol,
      },
      {}
    );

    const result = await client.listCreativeFormatsLegacy({});

    if (!result.success || !result.data) {
      throw new Error(`Failed to discover creative formats: ${result.error || 'Unknown error'}`);
    }

    return result.data.formats || [];
  }

  /**
   * Validate request parameters against AdCP schema.
   *
   * Uses default (non-strict) parsing so required fields are still enforced
   * but unknown top-level keys pass through. This matters because callers —
   * including the storyboard runner's `applyBrandInvariant` — inject
   * scoping fields (`brand`, `account`) onto every outgoing request, and
   * `adaptRequest` strips those fields downstream for tools
   * whose schema doesn't declare them. A strict parse here rejects the
   * injected fields before the adapter gets a chance to clean them up, so
   * the two passes have to agree on "extra keys are fine."
   */
  private usesIdentity33Schemas(): boolean {
    return (
      this.config.experimentalIdentity33 === true &&
      this.cachedCapabilities?._synthetic === false &&
      isAdcpVersionAtLeast(this.cachedCapabilities.servedVersion, '3.3.0')
    );
  }
  private usesSigned33Webhooks(): boolean {
    const capabilities = this.cachedCapabilities;
    return (
      this.config.experimentalIdentity33 === true &&
      capabilities?._synthetic === false &&
      isAdcpVersionAtLeast(capabilities.servedVersion, '3.3.0') &&
      (capabilities._raw?.webhook_signing as { supported?: boolean } | undefined)?.supported === true
    );
  }
  private selectedWebhookSigningProfile(): 'adcp/webhook-signing/v1' | 'web-bot-auth' | undefined {
    if (!this.usesSigned33Webhooks()) return undefined;
    const advertisement = this.cachedCapabilities?._raw?.webhook_signing as
      | { profiles?: string[]; profile?: string }
      | undefined;
    const profile =
      this.config.webhookSigningProfile ??
      (advertisement?.profile === 'web-bot-auth' ||
      (advertisement?.profiles?.length === 1 && advertisement.profiles[0] === 'web-bot-auth')
        ? 'web-bot-auth'
        : 'adcp/webhook-signing/v1');
    if (profile === 'web-bot-auth' && !advertisement?.profiles?.includes(profile))
      throw new ConfigurationError(
        'Seller did not advertise the selected Web Bot Auth webhook profile',
        'webhookSigningProfile'
      );
    return profile;
  }

  private validateRequest(taskType: string, params: any): void {
    if (this.config.experimentalIdentity33 && this.usesIdentity33Schemas()) {
      this.executor.validateRequest(taskType, params);
      return;
    }
    const schema = this.getRequestSchema(taskType);
    if (!schema) {
      return; // No schema available for this task type
    }

    const result = schema.safeParse(params);
    if (!result.success) {
      const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new Error(`Request validation failed for ${taskType}: ${issues}`);
    }
  }

  /**
   * Get request schema for a given task type.
   *
   * Note: Schema validation is not available for all task types. The following
   * tasks use complex discriminated unions that cannot be represented in Zod
   * without significant runtime overhead:
   *
   * - `update_media_buy`: Uses conditional package update operations
   *
   * For these tasks, TypeScript compile-time checking is still enforced via
   * the generated types, but runtime validation falls back to basic type checks.
   * Invalid requests will still be rejected by the server with descriptive errors.
   *
   * @internal
   */
  private getRequestSchema(taskType: string) {
    const schemas = loadClientRequestSchemas();
    const schemaMap = {
      get_products: schemas.GetProductsRequestSchema,
      list_creative_formats: schemas.ListCreativeFormatsRequestSchema,
      create_media_buy: schemas.CreateMediaBuyRequestSchema,
      // update_media_buy: excluded - complex discriminated unions (package operations)
      sync_creatives: schemas.SyncCreativesRequestSchema,
      list_creatives: schemas.ListCreativesRequestSchema,
      get_media_buys: schemas.GetMediaBuysRequestSchema,
      get_creative_features: schemas.GetCreativeFeaturesRequestSchema,
      get_media_buy_delivery: schemas.GetMediaBuyDeliveryRequestSchema,
      get_signals: schemas.GetSignalsRequestSchema,
      activate_signal: schemas.ActivateSignalRequestSchema,
    };

    return schemaMap[taskType as keyof typeof schemaMap] || null;
  }
}

let clientRequestSchemasModule: typeof import('../types/schemas.generated') | undefined;

function loadClientRequestSchemas(): typeof import('../types/schemas.generated') {
  clientRequestSchemasModule ??= require('../types/schemas.generated') as typeof import('../types/schemas.generated');
  return clientRequestSchemasModule;
}

let hasWarnedAboutUnverifiedWebhookReceive = false;

/**
 * Warn once when a webhook is accepted with no authenticity check at all.
 *
 * This path is available only through the explicit
 * `allowUnauthenticatedWebhooks` escape hatch and only when no trusted push
 * registration or legacy HMAC secret is available.
 */
function warnUnverifiedWebhookReceive(): void {
  if (hasWarnedAboutUnverifiedWebhookReceive) return;
  hasWarnedAboutUnverifiedWebhookReceive = true;
  console.warn(
    '[adcp] Webhook accepted WITHOUT authenticity verification because ' +
      '`allowUnauthenticatedWebhooks` is enabled and no trusted registration was found. ' +
      'Any caller able to reach this receiver can forge task completions and status changes.'
  );
}

let hasWarnedAboutReportingWebhookSecret = false;

/**
 * Warn once when an automatic `reporting_webhook` registration is skipped.
 *
 * `reporting-webhook.json` makes `authentication` required for all of AdCP 3.x,
 * so the registration cannot be sent without a credential — and the only
 * credential available without `webhookSecret` would be a hardcoded placeholder,
 * which would misrepresent the channel as authenticated.
 */
function warnReportingWebhookNeedsSecret(): void {
  if (hasWarnedAboutReportingWebhookSecret) return;
  hasWarnedAboutReportingWebhookSecret = true;
  console.warn(
    '[adcp] Skipping automatic `reporting_webhook` registration: AdCP 3.x requires an `authentication` ' +
      'block and no `webhookSecret` is configured. Set `webhookSecret` on the client, or pass an explicit ' +
      '`reporting_webhook.authentication` on the request. The media buy itself is unaffected.'
  );
}

function rawBodyFromUnknown(value: unknown): string | Buffer | Uint8Array | undefined {
  return typeof value === 'string' || Buffer.isBuffer(value) || value instanceof Uint8Array ? value : undefined;
}

function parseWebhookBody(value: unknown): { ok: true; payload: unknown } | WebhookParseFailure {
  if (value === undefined) {
    return {
      ok: false,
      code: 'webhook_envelope_invalid',
      message: 'Webhook body is required.',
    };
  }
  if (typeof value === 'string' || Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const raw = Buffer.isBuffer(value) || value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : value;
    try {
      return { ok: true, payload: JSON.parse(raw) };
    } catch {
      return {
        ok: false,
        code: 'webhook_envelope_invalid',
        message: 'Webhook body must be valid JSON.',
      };
    }
  }
  return { ok: true, payload: value };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function inspectWebhookAuthenticationHeaders(
  headers: WebhookHeadersLike | undefined,
  explicitSignature: WebhookHeaderValue,
  explicitTimestamp: WebhookHeaderValue
): { hasLegacy: boolean; hasRfc9421: boolean } {
  const hasHeader = (name: string): boolean => {
    if (!headers) return false;
    if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) !== null;
    return Object.entries(headers).some(
      ([key, value]) => key.toLowerCase() === name && value !== null && value !== undefined
    );
  };
  return {
    hasLegacy:
      explicitSignature != null ||
      explicitTimestamp != null ||
      hasHeader('x-adcp-signature') ||
      hasHeader('x-adcp-timestamp'),
    hasRfc9421: hasHeader('signature') || hasHeader('signature-input'),
  };
}

function normalizeRfc9421WebhookHeaders(
  headers: WebhookHeadersLike
): { ok: true; headers: Record<string, string | string[] | undefined> } | { ok: false; failure: WebhookParseFailure } {
  const normalized: Record<string, string | string[] | undefined> = {};
  if (typeof (headers as Headers).forEach === 'function') {
    (headers as Headers).forEach((value, key) => {
      normalized[key] = value;
    });
    return { ok: true, headers: normalized };
  }

  const singletonHeaders = new Set([
    'signature',
    'signature-input',
    'signature-agent',
    'content-digest',
    'content-type',
    'x-adcp-signature',
    'x-adcp-timestamp',
  ]);
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (singletonHeaders.has(lower)) {
      if (seen.has(lower) || Array.isArray(value)) {
        const cause = new WebhookSignatureError(
          'webhook_signature_header_malformed',
          1,
          `Webhook header ${lower} must have exactly one unambiguous value.`
        );
        return { ok: false, failure: { ok: false, code: cause.code, message: cause.message, cause } };
      }
      seen.add(lower);
    }
    if (value === null || value === undefined) continue;
    normalized[key] = Array.isArray(value) ? value.map(String) : String(value);
  }
  return { ok: true, headers: normalized };
}

function isBareDeliveryReport(payload: Record<string, unknown>): boolean {
  return (
    typeof payload.notification_type === 'string' &&
    ('media_buy_deliveries' in payload || 'creative_deliveries' in payload || 'reporting_period' in payload) &&
    !('result' in payload) &&
    !('task_id' in payload)
  );
}

/**
 * Accept both A2A 1.0 JSON/protobuf envelopes and the SDK's 0.3 compatibility
 * objects. A2A 1.0 removes the `kind` discriminator and wraps response/event
 * variants in a oneof (`task`, `statusUpdate`, or an in-memory `payload`).
 */
function normalizeA2AWebhookEnvelope(payload: Record<string, unknown>): Record<string, any> | undefined {
  if (payload.kind === 'task' || payload.kind === 'status-update') return payload;

  const oneof = isObjectRecord(payload.payload) ? payload.payload : undefined;
  const oneofCase = oneof?.$case;
  const oneofValue = isObjectRecord(oneof?.value) ? oneof.value : undefined;
  if (oneofValue && oneofCase === 'task') return { ...oneofValue, kind: 'task' };
  if (oneofValue && oneofCase === 'statusUpdate') return { ...oneofValue, kind: 'status-update' };

  if (isObjectRecord(payload.task)) return { ...payload.task, kind: 'task' };
  if (isObjectRecord(payload.statusUpdate)) return { ...payload.statusUpdate, kind: 'status-update' };

  if (typeof payload.id === 'string' && isObjectRecord(payload.status) && Array.isArray(payload.artifacts)) {
    return { ...payload, kind: 'task' };
  }
  if (typeof payload.taskId === 'string' && isObjectRecord(payload.status) && !('artifact' in payload)) {
    return { ...payload, kind: 'status-update' };
  }
  return undefined;
}

function a2aWebhookPartValue(part: unknown, expectedCase: 'data' | 'text'): unknown {
  if (!isObjectRecord(part)) return undefined;
  if (part.kind === expectedCase) return part[expectedCase];
  if (part.kind === undefined && Object.hasOwn(part, expectedCase)) return part[expectedCase];
  const content = isObjectRecord(part.content) ? part.content : undefined;
  return content?.$case === expectedCase ? content.value : undefined;
}

function latestA2AWebhookMessageData(parts: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(parts)) return undefined;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const data = a2aWebhookPartValue(parts[index], 'data');
    if (!isObjectRecord(data)) continue;
    return data;
  }
  return undefined;
}

function latestA2AWebhookTextParts(parts: unknown): string[] {
  if (!Array.isArray(parts)) return [];
  return parts
    .map(part => a2aWebhookPartValue(part, 'text'))
    .filter((value): value is string => typeof value === 'string');
}

type SignedWebhookRoute = {
  operationId?: string;
  taskType?: string;
  agentId?: string;
};

function extractSignedWebhookRoute(
  payload: unknown
): ({ ok: true } & SignedWebhookRoute) | { ok: false; message: string } {
  if (!isObjectRecord(payload)) return { ok: true };
  const normalizedA2A = normalizeA2AWebhookEnvelope(payload);
  const records: Record<string, unknown>[] = [payload];
  if (normalizedA2A) {
    records.length = 0;
    const status = isObjectRecord(normalizedA2A.status) ? normalizedA2A.status : undefined;
    const message = isObjectRecord(status?.message) ? status.message : undefined;
    const messageData = latestA2AWebhookMessageData(message?.parts);
    if (messageData) records.push(messageData);
    if (normalizedA2A.kind === 'task') {
      const artifactData = getLatestA2ADataPartFromTask(normalizedA2A as unknown as A2ATask)?.data;
      if (artifactData) records.push(artifactData);
    }
  }

  const oneValue = (field: 'operation_id' | 'task_type' | 'agent_id'): string | undefined | null => {
    const values = new Set(
      records
        .map(record => record[field])
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
    );
    return values.size > 1 ? null : values.values().next().value;
  };
  const operationId = oneValue('operation_id');
  const taskType = oneValue('task_type');
  const agentId = oneValue('agent_id');
  if (operationId === null || taskType === null || agentId === null) {
    return {
      ok: false,
      message: 'Authenticated webhook contains contradictory signed routing fields.',
    };
  }
  return {
    ok: true,
    ...(operationId !== undefined && { operationId }),
    ...(taskType !== undefined && { taskType }),
    ...(agentId !== undefined && { agentId }),
  };
}

function legacyA2AArtifactStatus(
  payload: A2ATask | TaskStatusUpdateEvent,
  artifact: unknown
): NormalizedWebhookPayload['status'] | undefined {
  if (payload.kind !== 'task' || !isObjectRecord(artifact) || typeof artifact.name !== 'string') return undefined;
  const transportState = payload.status?.state;
  if (
    artifact.name === 'result' &&
    (transportState === 'completed' || transportState === 'TASK_STATE_COMPLETED' || transportState === 3)
  )
    return 'completed';
  if (artifact.name !== 'error') return undefined;
  if (transportState === 'failed' || transportState === 'TASK_STATE_FAILED' || transportState === 4) return 'failed';
  if (transportState === 'rejected' || transportState === 'TASK_STATE_REJECTED' || transportState === 7)
    return 'rejected';
  if (transportState === 'canceled' || transportState === 'TASK_STATE_CANCELED' || transportState === 5)
    return 'canceled';
  return undefined;
}

function isMcpWebhookCandidate(payload: Record<string, unknown>): boolean {
  return (
    MCP_WEBHOOK_REQUIRED_FIELDS.some(field => field in payload) ||
    'result' in payload ||
    'context_id' in payload ||
    'notification_id' in payload
  );
}

function missingMcpWebhookFields(payload: Record<string, unknown>): string[] {
  return MCP_WEBHOOK_REQUIRED_FIELDS.filter(field => {
    const value = payload[field];
    return typeof value !== 'string' || value.length === 0;
  });
}

function webhookErrorHttpStatus(error: unknown): number {
  if (error instanceof WebhookDispatchError) {
    if (error.code === 'webhook_signature_replayed') return 409;
    if (error.code === 'webhook_idempotency_conflict') return 409;
    if (error.code === 'webhook_signature_rate_abuse') return 429;
    if (
      error.code === 'webhook_registration_store_unavailable' ||
      error.code === 'webhook_verification_unavailable' ||
      error.code === 'webhook_durable_settlement_unavailable' ||
      error.code === 'webhook_publication_in_progress' ||
      error.code === 'webhook_signature_revocation_stale'
    ) {
      return 503;
    }
    if (error.code === 'webhook_verification_context_missing') return 500;
    if (
      error.code.startsWith('webhook_signature_') ||
      error.code === 'webhook_timestamp_invalid' ||
      error.code === 'webhook_mode_mismatch' ||
      error.code === 'webhook_registration_not_found' ||
      error.code === 'webhook_registration_mismatch' ||
      error.code === 'webhook_unverifiable'
    ) {
      return 401;
    }
    return 400;
  }
  return 500;
}

/**
 * Factory function to create a single-agent client.
 *
 * @param agent - Agent configuration
 * @param config - Client configuration
 * @returns Configured SingleAgentClient instance
 */
export function createSingleAgentClient(agent: AgentConfig, config?: SingleAgentClientConfig): SingleAgentClient {
  return new SingleAgentClient(agent, config);
}
