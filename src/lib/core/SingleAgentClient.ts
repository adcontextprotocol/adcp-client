// Main ADCP Client - Type-safe conversation-aware client for AdCP agents

import { z } from 'zod';
import * as schemas from '../types/schemas.generated';
import type { AgentConfig } from '../types';
import { ADCP_ENVELOPE_FIELDS } from '../types/adcp';
import { parseAdcpMajorVersion, type AdcpVersion } from '../version';
import {
  isAdcpVersionSupported,
  isPre31AdcpVersion,
  isPre32AdcpVersion,
  resolveAdcpVersion,
} from '../utils/adcp-version-config';
import { getVersionAdapter, resolveAdapterKey } from '../adapters/version';
import { isExternalSchemaRootActive, schemaAllowsTopLevelField } from '../validation/schema-loader';
import type {
  GetProductsRequest,
  GetProductsResponse,
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
  OutcomeType,
} from '../types/tools.generated';
import { type MutatingRequestInput, generateIdempotencyKey, requestUsesIdempotency } from '../utils/idempotency';

import type { MCPWebhookPayload, AdCPAsyncResponseData, TaskStatus } from '../types/core.generated';
import type { Task as A2ATask, TaskStatusUpdateEvent } from '@a2a-js/sdk';
import { A2AClient as A2AClientImpl } from '@a2a-js/sdk/client';
// A2A SDK client used untyped — wire shapes are validated at runtime, matching
// the prior CommonJS `require('@a2a-js/sdk/client')` behaviour.
const A2AClient: any = A2AClientImpl;

import { TaskExecutor, DeferredTaskError } from './TaskExecutor';
import { attachMatch } from './match';
import { withTaskDeadline } from './task-deadline';
import { createMCPRequestHeaders } from '../auth';
import { isAbortOrTimeoutError } from '../protocols/abort';
import { ProtocolClient, normalizeTransportOptions } from '../protocols';
import {
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
} from './ConversationTypes';
import type { AdcpTaskName, TaskRequestFor, TaskResponseTypeMap } from './AgentClient';
import type { Activity, AsyncHandlerConfig, WebhookMetadata } from './AsyncHandler';
import { AsyncHandler } from './AsyncHandler';
import { verifyWebhookRequest, type WebhookHeaderValue, type WebhookHeadersLike } from '../webhooks';
import {
  InMemoryWebhookRegistrationStore,
  type WebhookRegistration,
  type WebhookRegistrationStore,
} from './webhook-registration';
import {
  InMemoryReplayStore,
  type ReplayStore,
  InMemoryRevocationStore,
  type RevocationStore,
  type JwksResolver,
  WebhookSignatureError,
  type WebhookSignatureErrorCode,
  verifyWebhookSignature as verifyRfc9421WebhookSignature,
  ResolvedAgentJwksResolver,
  type ResolvedAgentJwksResolverOptions,
  canonicalTargetUri,
} from '../signing/server';
import { unwrapProtocolResponse } from '../utils/response-unwrapper';
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

// v3.0 compatibility utilities
import type { AdcpCapabilities, AdcpMajorVersion, ToolInfo, FeatureName } from '../utils/capabilities';
import {
  buildSyntheticCapabilities,
  buildSyntheticV3Capabilities,
  augmentCapabilitiesFromTools,
  looksLikeV3Capabilities,
  parseCapabilitiesResponse,
  resolveFeature,
  listDeclaredFeatures,
  TASK_FEATURE_MAP,
  assertValidIdempotencyReplayTtlSeconds,
} from '../utils/capabilities';

import { normalizeRequestParams } from '../utils/request-normalizer';
import { globalAsyncLocalStorage } from '../utils/global-async-local-storage';
import { validateUserAgent } from '../utils/validate-user-agent';
import { resolveWebhookUrl, selectWebhookTemplate } from './webhook-url';
import { getV25Adapter } from '../adapters/legacy/v2-5';
import {
  ProductPropertyPolicyError,
  validateProductsAgainstPropertyPolicy,
  type BuyerPropertyPolicy,
  type ProductPolicyProductLike,
  type ProductPropertyPolicyDiagnostic,
  type ProductPropertyPolicyMode,
  type ProductPropertyPolicyValidationResult,
} from '../media-buy/property-policy';
import { resolvePropertyList, type ResolveListOptions } from '../server/targeting-helpers';
import {
  CreativeFormatCapabilityError,
  CreativeFormatProjectionError,
  projectMediaBuyCreativesForDelivery,
  projectCreativeForDelivery,
  projectSyncCreativesForDelivery,
  resolveCreativeFormatWireMode,
  stripLegacyCreativeIdentity,
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
} from '../v2/projection/creative-delivery';
import type { LegacyFormatConverter } from '../v2/projection/v1-to-v2';
import {
  legacyFormatConverterFromCatalogSnapshots,
  type ProjectionCatalogSnapshot,
} from '../v2/projection/catalog-snapshot';
import type { CanonicalFormatLegacyResolutionContext, CanonicalFormatLegacyResolver } from '../v2/projection/v2-to-v1';
import { toCanonicalOnlyResponse } from '../v2/projection/augment-response';
import { legacyFormatRefsForDeclaration } from '../v2/projection/legacy-metadata';
import { isProjectionProductInput, type V1FormatId, type V1Product } from '../v2/projection/types';
import { canonicalize as canonicalizeJson } from '../utils/jcs';

type ReadRequestOptions = Pick<TaskOptions, 'signal' | 'transport'>;
type ToolSchemaMap = Map<string, Record<string, unknown>>;
type CapabilityDiscoveryContext = {
  toolSchemas?: ToolSchemaMap;
  capabilities?: AdcpCapabilities;
};
const CAPABILITY_DISCOVERY_CONTEXT = Symbol('capabilityDiscoveryContext');
type InternalReadRequestOptions = ReadRequestOptions & {
  [CAPABILITY_DISCOVERY_CONTEXT]?: CapabilityDiscoveryContext;
};

function creativeSchemaSupport(value: unknown, depth = 0): CreativeFormatWireMode {
  if (depth > 24 || value === null || typeof value !== 'object') return 'unknown';
  if (Array.isArray(value)) {
    let legacy = false;
    for (const item of value) {
      const support = creativeSchemaSupport(item, depth + 1);
      if (support === 'canonical') return support;
      if (support === 'legacy') legacy = true;
    }
    return legacy ? 'legacy' : 'unknown';
  }
  const object = value as Record<string, unknown>;
  const properties = object.properties;
  if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
    const keys = properties as Record<string, unknown>;
    if ('creative_id' in keys && 'format_kind' in keys) return 'canonical';
    if ('creative_id' in keys && 'format_id' in keys) return 'legacy';
  }
  let legacy = false;
  for (const child of Object.values(object)) {
    const support = creativeSchemaSupport(child, depth + 1);
    if (support === 'canonical') return support;
    if (support === 'legacy') legacy = true;
  }
  return legacy ? 'legacy' : 'unknown';
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
    }
  | {
      kind: 'package';
      accountScope: string;
      packageId: string;
      refs: readonly V1FormatId[];
    };

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
  });
  return Object.freeze({
    brand,
    operator: account.operator,
    ...(typeof account.sandbox === 'boolean' ? { sandbox: account.sandbox } : {}),
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

const PRIMARY_ADCP_TASK_NAMES = {
  get_products: true,
  list_products: true,
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
  get_creative_delivery: true,
  provide_performance_feedback: true,
  get_signals: true,
  activate_signal: true,
  get_adcp_capabilities: true,
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
  protocol?: 'mcp' | 'a2a';
};

export interface ClientProductPropertyPolicy extends BuyerPropertyPolicy {
  /**
   * Enforcement mode for completed `get_products` responses.
   *
   * - `filter` (default): remove rejected products before handlers/callers see them
   * - `reject_response`: fail the task when any product violates the policy
   * - `audit`: keep products but attach diagnostics
   */
  mode?: ProductPropertyPolicyMode;
  /**
   * When true, a `get_products` request carrying `property_list` is resolved
   * and used as an allow-list for the returned products. Defaults to true.
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
  | 'webhook_verification_unavailable';

export interface WebhookVerificationConfig {
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
  /** Actual HTTP method from trusted server context. Required for RFC 9421. */
  requestMethod?: string;
  /** Externally visible absolute request URL from trusted server/proxy configuration. Required for RFC 9421. */
  requestUrl?: string;
  /** Explicit legacy HMAC signature header value. */
  signature?: WebhookHeaderValue;
  /** Explicit legacy HMAC timestamp header value. */
  timestamp?: WebhookHeaderValue;
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
    status: TaskStatus;
    timestamp?: string;
    message?: string;
    previewHandler?: 'canonical' | 'legacy';
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

// Top-level fields that every MCP webhook envelope must carry, regardless of
// negotiated AdCP version. `operation_id` is intentionally NOT here: it became
// a required webhook field in AdCP 3.1, but 3.0 senders are spec-compliant
// without it. The receiver can't reliably know the sender's negotiated version
// from the POST body alone, so requiring `operation_id` here broke 3.0
// interop. When absent we fall back to the routing-context operationId (see
// normalizeWebhookPayload), so its omission is non-fatal for dispatch.
const MCP_WEBHOOK_REQUIRED_FIELDS = ['idempotency_key', 'task_id', 'task_type', 'status', 'timestamp'] as const;

/**
 * Configuration for SingleAgentClient (and multi-agent client)
 */
export interface SingleAgentClientConfig extends ConversationConfig {
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
   */
  handlers?: AsyncHandlerConfig;
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
  /**
   * Gate mutating-task dispatch on the seller's declared major version.
   * When the seller returns an authoritative `get_adcp_capabilities`
   * response, the guard requires:
   *   1. `major_versions` includes 3
   *   2. `adcp.idempotency.replay_ttl_seconds` is declared (spec-required)
   *
   * Sellers whose capabilities are synthesized from `tools/list` (no
   * authoritative `get_adcp_capabilities` response) route through the
   * v2 adapter with a one-time warning — a compliant v3 seller would
   * declare itself, so absence of a declaration is read as v2. Adopters
   * who need a hard "definitely-v3" gate should validate
   * `(await client.getCapabilities())._synthetic === false` directly.
   *
   * Throws `VersionUnsupportedError` before the request is sent when
   * the guard rejects. Bypass with `allowV2` or — process-wide as a
   * fallback — `ADCP_ALLOW_V2=1`.
   *
   * @default false
   */
  requireV3ForMutations?: boolean;
  /**
   * Per-client bypass for the v3 guard. When `true`, the guard is off
   * regardless of the `ADCP_ALLOW_V2` env var. When `undefined`, the env
   * var is consulted as a fallback. Set explicitly in multi-tenant
   * deployments so one tenant's override can't silently disable safety
   * for another.
   */
  allowV2?: boolean;
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
  };
  /** Governance configuration for buyer-side campaign governance */
  governance?: import('./GovernanceTypes').GovernanceConfig;
  /**
   * Transport-level safeguards. Applies to every call this client dispatches
   * unless overridden at call time.
   *
   * Set `maxResponseBytes` when crawling untrusted agents (registries,
   * federated discovery layers) to prevent a hostile vendor from buffering
   * a large reply before any application-layer schema validation runs. Set
   * `requestTimeoutMs` to override the default 60s cap on A2A agent-card
   * discovery; use `0` to disable the SDK-imposed discovery timeout.
   */
  transport?: import('../protocols').TransportOptions;
}

/**
 * Internal single-agent client implementation
 *
 * This is an internal implementation detail used by AgentClient and ADCPMultiAgentClient.
 * External users should use AdCPClient (alias for ADCPMultiAgentClient) instead.
 *
 * Key features:
 * - 🔒 Full type safety for all ADCP tasks
 * - 💬 Conversation management with context preservation
 * - 🔄 Input handler pattern for clarifications
 * - ⏱️ Timeout and retry support
 * - 🐛 Debug logging and observability
 * - 🎯 Works with both MCP and A2A protocols
 */
/**
 * Does a JS runtime value's type plausibly match a JSON Schema's declared
 * shape? Used by the v2 adapter aliasing path to avoid moving a string
 * into a slot the agent's tool schema declared as an object (e.g.,
 * Wonderstruck's `brand: BrandReference` slot vs our adapter's
 * `brand_manifest: 'https://...'` URL string).
 *
 * Recurses into `anyOf` / `oneOf`: the move is safe iff at least one
 * variant accepts the value's runtime type. `$ref` we can't introspect
 * locally — return true and let the seller's own validation catch.
 *
 * The empty schema `{}` is treated as "doesn't accept this type" so
 * Pydantic-generated tool schemas with `anyOf: [{}, {type: null}]` —
 * which technically allow anything but in practice mask a stricter
 * Pydantic union — don't pull the buyer into the broken alias.
 */
function valueMatchesSchemaType(value: unknown, propSchema: unknown): boolean {
  if (!propSchema || typeof propSchema !== 'object') return false;
  const schema = propSchema as { type?: unknown; oneOf?: unknown; anyOf?: unknown; $ref?: unknown };
  if (schema.$ref) return true;

  const valueType: string = Array.isArray(value)
    ? 'array'
    : value === null
      ? 'null'
      : typeof value === 'object'
        ? 'object'
        : typeof value;

  // anyOf / oneOf: any variant matching = safe.
  for (const key of ['anyOf', 'oneOf'] as const) {
    const variants = (schema as { [k: string]: unknown })[key];
    if (Array.isArray(variants)) {
      return variants.some(v => valueMatchesSchemaType(value, v));
    }
  }

  const declared = schema.type;
  if (declared === undefined) return false;
  if (typeof declared === 'string') return declared === valueType;
  if (Array.isArray(declared)) return declared.includes(valueType);
  return false;
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
  const value = params.property_list;
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
  return Object.freeze({
    ...(account ? { account } : {}),
    ...(propertyList ? { property_list: Object.freeze(propertyList) } : {}),
  });
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

function comparablePropertyIdentifiers(
  identifiers: readonly { type: string; value: string }[]
): Array<{ type: string; value: string }> {
  return identifiers
    .filter(identifier => identifier.type === 'domain' || identifier.type === 'subdomain')
    .map(identifier => ({ type: identifier.type, value: identifier.value }));
}

function unsupportedPropertyIdentifiers(
  identifiers: readonly { type: string; value: string }[]
): Array<{ type: string }> {
  return identifiers
    .filter(identifier => identifier.type !== 'domain' && identifier.type !== 'subdomain')
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
  private executor: TaskExecutor;
  private asyncHandler?: AsyncHandler;
  private normalizedAgent: InternalAgentConfig;
  private discoveredEndpoint?: string; // Cache discovered MCP endpoint
  private discoveredAgent?: AgentConfig; // Stable post-discovery config for protocol/provider caches
  private discoveredMcpEra?: 'legacy' | 'modern';
  private discoveredMcpEraAt = 0;
  private canonicalBaseUrl?: string; // Cache canonical base URL (from agent card or stripped /mcp)
  private cachedCapabilities?: AdcpCapabilities; // Cache detected server capabilities
  private cachedToolSchemas?: Map<string, Record<string, unknown>>; // inputSchema.properties per tool name
  private _v2WarningFired = false; // Gate: emit the v2-sunset warning once per client instance
  private _syntheticV3WarningFired = false; // Gate: emit the synthetic-v3 warning once per client instance
  private _syntheticV2WarningFired = false; // Gate: emit the synthetic-v2 warning once per client instance
  private readonly productPolicyRequestParamsByTask = new Map<string, ProductPolicyRequestState>();
  private readonly canonicalCreativeTaskAssociations = new Map<string, CanonicalCreativeTaskAssociation>();
  private readonly previewCreativeHandlersByTask = new Map<string, 'canonical' | 'legacy'>();
  private readonly canonicalLegacyRoutes = new Map<string, CanonicalLegacyRoute>();
  private readonly resolvedAdcpVersion: string;
  private readonly webhookRegistrationStore: WebhookRegistrationStore;
  private readonly webhookReplayStore: ReplayStore;
  private readonly webhookRevocationStore: RevocationStore;
  private readonly webhookJwksResolvers = new Map<string, JwksResolver>();

  constructor(
    private agent: AgentConfig,
    private config: SingleAgentClientConfig = {}
  ) {
    this.config = { ...config, transport: normalizeTransportOptions(config.transport) };
    config = this.config;
    // Validate the configured adcpVersion at construction time. Throws
    // ConfigurationError if the pin's major differs from ADCP_MAJOR_VERSION
    // — cross-major support lands in Stage 3 of the multi-version refactor.
    this.resolvedAdcpVersion = resolveAdcpVersion(config.adcpVersion);
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

    this.executor = new TaskExecutor({
      workingTimeout: config.workingTimeout || 120000, // Max 120s for working status
      defaultMaxClarifications: config.defaultMaxClarifications || 3,
      enableConversationStorage: config.persistConversations !== false,
      webhookUrlTemplate: config.webhookUrlTemplate,
      agentId: agent.id,
      webhookSecret: config.webhookSecret,
      onWebhookRegistration: registration => this.persistWebhookRegistration(registration),
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
    try {
      await this.webhookRegistrationStore.putIfAbsent({
        agentId: args.agent.id,
        agentUrl: args.agent.agent_uri,
        protocol: args.agent.protocol,
        operationId: args.operationId,
        taskType: args.taskType,
        callbackUrl: args.callbackUrl,
        method: 'POST',
        mode: args.mode,
        ...(previewMode && { previewMode }),
        createdAt: nowMs,
        expiresAt: nowMs + ttlSeconds * 1000,
      });
    } catch (cause) {
      // RFC 9421 has no safe fallback without seller-pinned provenance. Legacy
      // HMAC remains verifiable from the configured global secret, preserving
      // pre-registration behavior across restarts and replicas.
      if (args.mode === 'rfc9421') throw cause;
    }
  }

  private webhookJwksFor(registration: Readonly<WebhookRegistration>): JwksResolver {
    const configured = this.config.webhookVerification?.jwks;
    if (configured) return configured;
    const key = `${registration.protocol}\x00${registration.agentUrl}`;
    const existing = this.webhookJwksResolvers.get(key);
    if (existing) return existing;

    const resolver = new ResolvedAgentJwksResolver(registration.agentUrl, registration.protocol, {
      ...this.config.webhookVerification?.resolverOptions,
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
    this.webhookJwksResolvers.set(key, resolver);
    return resolver;
  }

  private resolveLegacyFormatConverter(
    override?: LegacyFormatConverter,
    projectionCatalogs: readonly ProjectionCatalogSnapshot[] | undefined = this.config.projectionCatalogs
  ): LegacyFormatConverter | undefined {
    return legacyFormatConverterFromCatalogSnapshots(projectionCatalogs, override ?? this.config.legacyFormatConverter);
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
    return (
      left.scope === right.scope &&
      left.format_option_id === right.format_option_id &&
      (left.scope !== 'publisher' ||
        (right.scope === 'publisher' && left.publisher_domain.toLowerCase() === right.publisher_domain.toLowerCase()))
    );
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
    authoritativeProducts: readonly unknown[] = products
  ): void {
    this.invalidateCanonicalProductRoutes(authoritativeProducts, account);
    const accountScope = this.canonicalAccountScope(account);
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
        if (refs.length === 0) continue;
        this.rememberCanonicalLegacyRoute(this.canonicalLegacyRouteKey(account, product.product_id, ref), {
          kind: 'product',
          accountScope,
          productId: product.product_id,
          optionRef: ref,
          refs,
        });
      }
    }
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
      if (!route) return undefined;
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

  /** Effective release pin emitted in protocol envelopes. @internal */
  getWireAdcpVersion(): string {
    return this.config.wireAdcpVersion ?? this.resolvedAdcpVersion;
  }

  /**
   * Ensure MCP endpoint is discovered (lazy initialization)
   *
   * If the agent needs discovery, perform it now and cache the result.
   * Returns the agent config with the discovered endpoint.
   * Also computes the canonical base URL by stripping /mcp suffix.
   */
  private async ensureEndpointDiscovered(options?: ReadRequestOptions): Promise<AgentConfig> {
    throwIfAborted(options?.signal);
    const needsDiscovery = this.normalizedAgent._needsDiscovery;
    const transport = normalizeTransportOptions(options?.transport ?? this.config.transport);
    const usesScopedFetch = transport?.trustedFetchFn !== undefined;

    if (!needsDiscovery) {
      return this.normalizedAgent;
    }

    // Already discovered? Use cached value
    if (!usesScopedFetch && this.discoveredAgent) {
      return this.discoveredAgent;
    }
    if (!usesScopedFetch && this.discoveredEndpoint) {
      this.discoveredAgent = {
        ...this.normalizedAgent,
        agent_uri: this.discoveredEndpoint,
      };
      if (this.normalizedAgent.oauth_tokens && !this.normalizedAgent.oauth_client_credentials) {
        const { shareNonInteractiveOAuthProvider } = await import('../auth/oauth/provider-cache');
        shareNonInteractiveOAuthProvider(this.normalizedAgent, this.discoveredAgent);
      }
      return this.discoveredAgent;
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
    const discoveredEndpoint = await this.discoverMCPEndpoint(this.normalizedAgent.agent_uri, options);

    if (usesScopedFetch) {
      const discoveredAgent = { ...this.normalizedAgent, agent_uri: discoveredEndpoint };
      if (this.normalizedAgent.oauth_tokens && !this.normalizedAgent.oauth_client_credentials) {
        const { shareNonInteractiveOAuthProvider } = await import('../auth/oauth/provider-cache');
        shareNonInteractiveOAuthProvider(this.normalizedAgent, discoveredAgent);
      }
      return discoveredAgent;
    }

    this.discoveredEndpoint = discoveredEndpoint;

    // Compute canonical base URL by stripping /mcp suffix
    this.canonicalBaseUrl = this.computeBaseUrl(this.discoveredEndpoint);

    this.discoveredAgent = {
      ...this.normalizedAgent,
      agent_uri: this.discoveredEndpoint,
    };
    if (this.normalizedAgent.oauth_tokens && !this.normalizedAgent.oauth_client_credentials) {
      const { shareNonInteractiveOAuthProvider } = await import('../auth/oauth/provider-cache');
      shareNonInteractiveOAuthProvider(this.normalizedAgent, this.discoveredAgent);
    }
    return this.discoveredAgent;
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
    const usesScopedFetch = transport?.trustedFetchFn !== undefined;

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
    const canonicalUrl = await this.fetchA2ACanonicalUrl(this.normalizedAgent.agent_uri, options);
    if (!usesScopedFetch) this.canonicalBaseUrl = canonicalUrl;

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
      const headers: Record<string, string> = {
        ...(requestInit?.headers as Record<string, string>),
        ...this.normalizedAgent.headers,
        ...(authToken && {
          Authorization: `Bearer ${authToken}`,
          'x-adcp-auth': authToken,
        }),
      };

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
      let client: InstanceType<typeof A2AClient> | undefined;
      let lastError: Error = new Error(`A2A agent card not found at ${cardUrls.join(', ')}`);
      for (const cardUrl of cardUrls) {
        try {
          client = await withResponseSizeLimit(maxResponseBytes, () => A2AClient.fromCardUrl(cardUrl, { fetchImpl }));
          break;
        } catch (err: unknown) {
          lastError = err as Error;
          if (got401) break;
        }
      }
      if (!client) {
        throw lastError;
      }
      const agentCard = await withResponseSizeLimit(maxResponseBytes, async () =>
        client.agentCardPromise ? client.agentCardPromise : client.agentCard
      );

      // Use the canonical URL from the agent card, falling back to computed base URL
      if (agentCard?.url) {
        return agentCard.url;
      }

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
   * - We fetch OAuth metadata and throw AuthenticationRequiredError
   * - This gives consumers clear guidance on how to authenticate
   *
   * Note: This is async and called lazily on first agent interaction
   */
  private async discoverMCPEndpoint(providedUri: string, options?: ReadRequestOptions): Promise<string> {
    throwIfAborted(options?.signal);
    const { connectMCPWithFallback } = await import('../protocols/mcp');
    const { probeModernMCPConnection } = await import('../protocols/mcp-modern');
    const transport = normalizeTransportOptions(options?.transport ?? this.config.transport);
    const usesScopedFetch = transport?.trustedFetchFn !== undefined;

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
          if (!usesScopedFetch) {
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
        if (!usesScopedFetch) {
          this.discoveredMcpEra = 'legacy';
          this.discoveredMcpEraAt = Date.now();
        }
        return { success: true };
      } catch (error: unknown) {
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
      }
    }

    if (firstWorkingUrl) {
      return firstWorkingUrl;
    }

    // If we got 401 from any endpoint, throw an authentication-required error.
    // Prefer the richer NeedsAuthorizationError when we can walk the full
    // RFC 9728 chain (PRM → AS metadata → endpoints + scopes + DCR hint).
    // Fall back to the simpler AuthenticationRequiredError with one-hop AS
    // metadata when the walk doesn't yield enough.
    if (got401) {
      const requirements = await discoverAuthorizationRequirements(providedUri, {
        allowPrivateIp: transport?.allowPrivateIp ?? isLikelyPrivateUrl(providedUri),
        fetchFn: transport?.trustedFetchFn,
        signal: options?.signal,
      });
      if (requirements) {
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
      const oauthMetadata = await discoverOAuthMetadata(providedUri, {
        trustedFetchFn: transport?.trustedFetchFn,
        allowPrivateIp: transport?.allowPrivateIp ?? isLikelyPrivateUrl(providedUri),
        signal: options?.signal,
      });
      throw new AuthenticationRequiredError(providedUri, oauthMetadata || undefined, undefined, challenge ?? undefined);
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
   *
   * @param payload - Protocol-specific webhook payload (MCPWebhookPayload | Task | TaskStatusUpdateEvent)
   * @param taskType - Task type (e.g create_media_buy) from url param or url part of the webhook delivery
   * @param operationId - Operation id (e.g used for client app to track the operation) from the param or url part of the webhook delivery
   * @param signature - X-ADCP-Signature header (format: "sha256=...")
   * @param timestamp - X-ADCP-Timestamp header (Unix timestamp)
   * @returns Whether webhook was handled successfully
   *
   * @example
   * ```typescript
   * import { verifyWebhookRequest } from '@adcp/sdk/webhooks';
   *
   * app.post('/webhook/:taskType', async (req, res) => {
   *   try {
   *     const check = verifyWebhookRequest({
   *       rawBody: req.rawBody,
   *       headers: req.headers,
   *       globalSecret: process.env.WEBHOOK_SECRET,
   *     });
   *     if (!check.ok) return res.status(401).json({ error: check.reason });
   *
   *     const handled = await client.handleWebhook(
   *       req.body,
   *       req.params.taskType,
   *       req.params.operationId,
   *       check.signature,
   *       check.timestamp,
   *       req.rawBody
   *     );
   *     res.status(200).json({ received: handled });
   *   } catch (error) {
   *     res.status(401).json({ error: error.message });
   *   }
   * });
   * ```
   */
  async handleWebhook(
    payload: MCPWebhookPayload | A2ATask | TaskStatusUpdateEvent,
    taskType: string,
    operationId: string,
    signature?: WebhookHeaderValue,
    timestamp?: WebhookHeaderValue,
    rawBody?: string | Buffer | Uint8Array
  ): Promise<boolean> {
    const parsed = await this.verifyAndParseWebhook({
      payload,
      taskType,
      operationId,
      signature,
      timestamp,
      rawBody,
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
   */
  async verifyAndParseWebhook(options: VerifyAndParseWebhookOptions): Promise<WebhookParseResult> {
    const rawBody = options.rawBody ?? rawBodyFromUnknown(options.body);
    const authHeaders = inspectWebhookAuthenticationHeaders(options.headers, options.signature, options.timestamp);
    const trustedOperationId =
      options.operationId && options.operationId !== 'unknown' ? options.operationId : undefined;
    let registration: Readonly<WebhookRegistration> | undefined;
    if (trustedOperationId) {
      try {
        registration = await this.webhookRegistrationStore.get(this.agent.id, trustedOperationId);
      } catch (cause) {
        if (!this.config.webhookSecret) {
          return {
            ok: false,
            code: 'webhook_registration_store_unavailable',
            message: 'Webhook registration state is temporarily unavailable.',
            cause,
          };
        }
      }
    }
    if (registration && (registration.agentId !== this.agent.id || registration.operationId !== trustedOperationId)) {
      return {
        ok: false,
        code: 'webhook_registration_store_unavailable',
        message: 'Webhook registration state is inconsistent with the trusted route.',
      };
    }
    if (registration) {
      const nowMs = this.config.webhookVerification?.now
        ? Math.floor(this.config.webhookVerification.now() * 1000)
        : Date.now();
      if (!Number.isFinite(registration.createdAt) || !Number.isFinite(registration.expiresAt)) {
        return {
          ok: false,
          code: 'webhook_registration_store_unavailable',
          message: 'Webhook registration state contains invalid timestamps.',
        };
      }
      if (registration.expiresAt <= nowMs) registration = undefined;
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
    if (registration?.mode === 'rfc9421') {
      if (
        rawBody === undefined ||
        !options.headers ||
        !trustedOperationId ||
        !options.requestMethod ||
        !options.requestUrl
      ) {
        return {
          ok: false,
          code: 'webhook_verification_context_missing',
          message:
            'RFC 9421 verification requires raw body bytes, all headers, POST method, an absolute trusted public URL, and a trusted route operation id.',
        };
      }
      if (options.requestMethod.toUpperCase() !== 'POST') {
        return {
          ok: false,
          code: 'webhook_verification_context_missing',
          message: 'Webhook request method must be POST.',
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
      const normalizedHeaders = normalizeRfc9421WebhookHeaders(options.headers);
      if (!normalizedHeaders.ok) return normalizedHeaders.failure;
      try {
        await verifyRfc9421WebhookSignature(
          {
            method: options.requestMethod,
            url: options.requestUrl,
            headers: normalizedHeaders.headers,
            body: rawBody,
          },
          {
            jwks: this.webhookJwksFor(registration),
            replayStore: this.webhookReplayStore,
            revocationStore: this.webhookRevocationStore,
            ...(this.config.webhookVerification?.now && { now: this.config.webhookVerification.now }),
            agentUrlForKeyid: () => registration.agentUrl,
          }
        );
      } catch (cause) {
        if (cause instanceof WebhookSignatureError) {
          return { ok: false, code: cause.code, message: cause.message, cause };
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

    const parsedTaskType =
      isObjectRecord(parsedPayload.payload) && typeof parsedPayload.payload.task_type === 'string'
        ? parsedPayload.payload.task_type
        : undefined;
    const payloadRecord = isObjectRecord(parsedPayload.payload) ? parsedPayload.payload : undefined;
    if (
      registration &&
      ((typeof payloadRecord?.operation_id === 'string' && payloadRecord.operation_id !== registration.operationId) ||
        (parsedTaskType !== undefined && parsedTaskType !== registration.taskType) ||
        (typeof payloadRecord?.agent_id === 'string' && payloadRecord.agent_id !== registration.agentId))
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
        options.operationId ?? 'unknown'
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
      protocol: parsed.protocol,
      rawHTTPPayload: canonicalCreativeTask ? stripLegacyCreativeIdentity(parsed.envelope) : parsed.envelope,
    };
    this.rememberCanonicalCreativeWebhookContext(metadata);
    try {
      const canonicalResult = this.canonicalizeWebhookCreativeResult(metadata, parsed.result, canonicalCreativeTask);
      const policyDispatch = await this.applyProductPropertyPolicyToWebhookResult(
        canonicalResult as AdCPAsyncResponseData | undefined,
        metadata
      );
      const webhookResult = policyDispatch.result;
      metadata = policyDispatch.metadata;

      // Emit activity
      await this.config.onActivity?.(
        canonicalCreativeActivity({
          type: 'webhook_received',
          operation_id: metadata.operation_id,
          agent_id: metadata.agent_id,
          context_id: metadata.context_id,
          task_id: metadata.task_id,
          task_type: metadata.task_type,
          status: metadata.status,
          payload: canonicalResult,
          timestamp: metadata.timestamp,
        })
      );

      if (policyDispatch.suppressHandler) return true;

      // Handle through async handler if configured
      if (this.asyncHandler) {
        await this.asyncHandler.handleWebhook({
          result: webhookResult,
          metadata,
          previewHandler: parsed.metadata.previewHandler ?? this.previewCreativeHandlerForWebhook(metadata),
        });
        return true;
      }

      return false;
    } finally {
      this.executor.observeExternalTaskStatus(
        metadata.operation_id,
        metadata.status as import('./ConversationTypes').TaskStatus,
        metadata.rawHTTPPayload
      );
      this.forgetProductPolicyRequestParams(metadata);
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
  private normalizeWebhookPayload(payload: unknown, taskType: string, operationId: string): NormalizedWebhookPayload {
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

    // 1. Check for MCP Webhook Payload (has task_id, status, task_type fields)
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
        operation_id: mcpPayload.operation_id || operationId || 'unknown',
        context_id: mcpPayload.context_id ?? undefined,
        task_id: mcpPayload.task_id,
        task_type: taskType && taskType !== 'unknown' ? taskType : mcpPayload.task_type,
        status: mcpPayload.status,
        result: mcpPayload.result ?? undefined,
        message: mcpPayload.message ?? undefined,
        timestamp: mcpPayload.timestamp,
        idempotency_key: mcpPayload.idempotency_key,
        protocol: 'mcp',
      };
    }

    // 2. Check for A2A Task or TaskStatusUpdateEvent
    if ('kind' in payload && (payload.kind === 'task' || payload.kind === 'status-update')) {
      const a2aPayload = payload as unknown as A2ATask | TaskStatusUpdateEvent;
      const a2aStatus = a2aPayload.status?.state || 'unknown';
      let result: AdCPAsyncResponseData | undefined = undefined;

      // Try to extract data from status.message.parts first (for status updates)
      const parts = a2aPayload.status?.message?.parts;
      if (parts && Array.isArray(parts)) {
        const dataPart = parts.find(p => 'data' in p && p.kind === 'data');
        if (dataPart && 'data' in dataPart) {
          result = dataPart.data as AdCPAsyncResponseData;
        }
      }

      // If not found in parts, check artifacts (standard A2A task output location)
      if (!result && 'artifacts' in a2aPayload && a2aPayload.artifacts && a2aPayload.artifacts.length > 0) {
        try {
          // Try to unwrap artifacts for all statuses
          result = unwrapProtocolResponse({ result: a2aPayload }, taskType, 'a2a') as AdCPAsyncResponseData;
        } catch (error) {
          throw new WebhookDispatchError(
            'webhook_result_invalid',
            'Failed to unwrap A2A webhook payload artifacts.',
            error
          );
        }
      }

      // Extract message part from status.message.parts (A2A Message structure)
      let message: string | undefined = undefined;
      if (a2aPayload.status?.message?.parts) {
        const textParts = a2aPayload.status.message.parts
          .filter(p => p.kind === 'text' && 'text' in p)
          .map(p => ('text' in p ? p.text : ''));
        if (textParts.length > 0) {
          message = textParts.join(' ');
        }
      }

      // Get task_id ensuring it's a string
      let taskId = 'unknown';
      if ('id' in a2aPayload && a2aPayload.id) {
        taskId = String(a2aPayload.id);
      } else if ('taskId' in a2aPayload && a2aPayload.taskId) {
        taskId = String(a2aPayload.taskId);
      }

      return {
        operation_id: operationId,
        context_id: 'contextId' in a2aPayload ? a2aPayload.contextId : undefined,
        task_id: taskId,
        task_type: taskType,
        status: a2aStatus,
        result,
        message: message,
        timestamp: a2aPayload.status?.timestamp || new Date().toISOString(),
        protocol: 'a2a',
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
        // Return error
        const errorMessage = error instanceof Error ? error.message : String(error);
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
   * Automatically adapts requests for v2 servers and normalizes responses.
   */
  private async executeAndHandle<T>(
    taskType: string,
    handlerName: keyof AsyncHandlerConfig,
    params: any,
    inputHandler?: InputHandler,
    options?: TaskOptions,
    transformCompletedResponse?: (data: T) => T,
    legacyFormatConverter?: LegacyFormatConverter,
    canonicalRequest?: unknown
  ): Promise<TaskResult<T>> {
    return withTaskDeadline(options, effectiveOptions =>
      this.executeAndHandleWithinDeadline(
        taskType,
        handlerName,
        params,
        inputHandler,
        effectiveOptions,
        transformCompletedResponse,
        legacyFormatConverter,
        canonicalRequest
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
    canonicalRequest?: unknown
  ): Promise<TaskResult<T>> {
    throwIfAborted(options?.signal);
    const canonicalCreativeInvocation =
      CANONICAL_CREATIVE_ACTIVITY_TASKS.has(taskType) || canonicalRequest !== undefined;
    // Normalize params for backwards compatibility before validation
    let normalizedParams = normalizeRequestParams(taskType, params, {
      skipIdempotencyAutoInject: options?.skipIdempotencyAutoInject,
      skipAccountValidation: options?.skipAccountValidation,
    });
    this.assertRequestSupportedByConfiguredVersion(taskType, normalizedParams, options, canonicalCreativeInvocation);

    // Inject an idempotency_key for mutating tools before schema validation
    // so callers don't have to supply one. TaskExecutor also guards against
    // missing keys, but validation happens here first — do the injection up
    // front so the request passes the spec's required-field check.
    // `options.skipIdempotencyAutoInject` disables this for compliance
    // testing that needs to exercise server-side missing-key behavior.
    if (
      !options?.skipIdempotencyAutoInject &&
      requestUsesIdempotency(taskType, normalizedParams) &&
      normalizedParams &&
      typeof normalizedParams === 'object' &&
      !normalizedParams.idempotency_key
    ) {
      normalizedParams = { ...normalizedParams, idempotency_key: generateIdempotencyKey() };
    }

    // Validate request params against schema. When compliance testing has
    // asked us to suppress idempotency auto-injection or account validation,
    // skip the entire Zod schema parse — the required field is intentionally
    // absent and Zod would fail on it too. This matches the pre-existing
    // `skipIdempotencyAutoInject` behavior and is acceptable because both
    // flags are @internal and only set by the storyboard runner for
    // schema_validation steps. An explicit external schema root also skips
    // this generated snapshot; TaskExecutor's AJV pass below validates the
    // same request against the caller-supplied current-source bundle.
    if (
      !options?.skipIdempotencyAutoInject &&
      !options?.skipAccountValidation &&
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

    // Check for v3 features used against v2 servers - return empty result if unsupported
    const earlyResult = await this.getEarlyResultForUnsupportedFeatures<T>(taskType, normalizedParams, options);
    throwIfAborted(options?.signal);
    if (earlyResult) {
      return attachMatch(earlyResult);
    }

    const agent = await this.ensureEndpointDiscovered(options);
    throwIfAborted(options?.signal);

    // Schema-driven pre-send validation runs on the unadapted v3 shape so
    // wire-format adapters (e.g. adaptGetProductsRequestForV2) don't strip
    // v3-only fields out from under the v3 bundled schema. Skip the entire
    // Zod parse when compliance testing has suppressed required-field
    // validation — the missing field is intentional and Zod would reject it.
    if (!options?.skipIdempotencyAutoInject && !options?.skipAccountValidation) {
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
    this.assertRequestSupportedByTargetVersion(
      taskType,
      normalizedParams,
      capabilityDiscoveryContext.capabilities,
      canonicalCreativeInvocation,
      serverVersion
    );
    const { options: effectiveOptions, driftLog: webhookDriftLog } = this.suppressPre31DiscoveryWebhook(
      taskType,
      options,
      capabilityDiscoveryContext.capabilities
    );
    const inputSchemaStripLogs: any[] = [];
    const { params: adaptedParams, driftLogs: adaptDriftLogs } = this.adaptRequest(
      taskType,
      normalizedParams,
      serverVersion,
      inputSchemaStripLogs,
      capabilityDiscoveryContext.toolSchemas,
      capabilityDiscoveryContext.capabilities
    );

    // Symmetric to the pre-adapter v3 pass above: when the adapter
    // rewrote the request for a v2 server, warn-validate the adapted
    // shape against the cached v2.5 schema bundle. Drift gets collected
    // here and merged into result.metadata.debug_logs after executeTask
    // returns — without that merge the warning would silently drop on
    // the floor and adapter drift would land in production unnoticed.
    const v25DriftLogs: any[] = [...adaptDriftLogs];
    if (webhookDriftLog) v25DriftLogs.push(webhookDriftLog);
    if (serverVersion === 'v2') {
      this.executor.validateAdaptedRequestAgainstV2(taskType, adaptedParams, v25DriftLogs);
    }

    const canonicalInputHandler = this.canonicalCreativeInputHandler(
      taskType,
      inputHandler,
      canonicalCreativeInvocation
    );
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
          capabilityDiscoveryContext.capabilities
        )
    );
    throwIfAborted(effectiveOptions?.signal);

    // Merge collected drift into the executor's debug_logs so adopters
    // reading result.debug_logs see input-schema stripping, post-adapter
    // v2.5 warnings, and any pre-3.1 webhook-degradation notice alongside
    // the executor's own logs. On error paths the executor may not surface
    // result.debug_logs at all; logs collected before the failure are
    // dropped, matching the executor's own debug-log behavior.
    const postAdapterLogs = [...inputSchemaStripLogs, ...v25DriftLogs];
    if (postAdapterLogs.length > 0) {
      result.debug_logs = [...(result.debug_logs ?? []), ...postAdapterLogs];
    }

    // Normalize response to v3 format
    if (result.success && result.data) {
      result.data = this.normalizeResponseToV3(taskType, result.data) as T;
    }

    result = this.wrapProductPolicySubmittedContinuation(result, taskType, normalizedParams, options);
    if (result.status === 'working') {
      this.rememberProductPolicyRequestParams(taskType, normalizedParams, result, options);
    }
    this.rememberLegacyFormatConverter(taskType, legacyFormatConverter, result, options);
    result = await this.applyProductPropertyPolicy(result, taskType, normalizedParams);
    throwIfAborted(effectiveOptions?.signal);

    if (canonicalCreativeInvocation) {
      // The full canonical request is needed only while the protocol activity
      // callback runs above. Async/terminal state retains a frozen routing-only
      // projection so creative assets and webhook credentials are not pinned.
      const routingSnapshot = canonicalCreativeRoutingSnapshot(taskType, canonicalRequest ?? normalizedParams);
      result = this.canonicalizeCreativeTaskResult(result, taskType, transformCompletedResponse, legacyFormatConverter);
      result = this.wrapCanonicalCreativeContinuations(
        result,
        taskType,
        transformCompletedResponse,
        legacyFormatConverter,
        routingSnapshot
      );
      this.rememberCanonicalCreativeTaskIds(result, taskType, legacyFormatConverter, routingSnapshot);
    } else if (result.status === 'completed' && result.success && result.data && transformCompletedResponse) {
      result = { ...result, data: transformCompletedResponse(result.data) };
    }

    this.rememberPreviewCreativeHandler(result, taskType, handlerName, effectiveOptions);
    await this.notifyCompletedStatusHandler(result, taskType, handlerName, effectiveOptions);

    return result;
  }

  private async notifyCompletedStatusHandler<T>(
    result: TaskResult<T>,
    taskType: string,
    handlerName: keyof AsyncHandlerConfig,
    options?: TaskOptions
  ): Promise<void> {
    if (result.status !== 'completed' || !result.success || !this.asyncHandler) return;
    const handler = this.config.handlers?.[handlerName] as
      | ((data: unknown, metadata: Record<string, unknown>) => void | Promise<void>)
      | undefined;
    if (!handler) return;
    throwIfAborted(options?.signal);
    await handler(result.data, {
      operation_id: options?.contextId || 'sync',
      context_id: options?.contextId,
      task_id: result.metadata.taskId,
      agent_id: this.agent.id,
      task_type: taskType,
      status: result.status,
      timestamp: new Date().toISOString(),
    });
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
      const converter = this.resolveLegacyFormatConverter(
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
    let projected = this.normalizeResponseToV3(taskType, data) as T;
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
      const { response, diagnostics } = toCanonicalOnlyResponse(record as { products?: V1Product[] }, {
        legacyFormatConverter: this.resolveLegacyFormatConverter(
          legacyFormatConverter ?? (active?.taskType === taskType ? active.legacyFormatConverter : undefined)
        ),
        projectionCatalogs: this.config.projectionCatalogs,
      });
      const { _message: _dropLegacyMessage, ...canonical } = response as typeof response & { _message?: unknown };
      void _dropLegacyMessage;
      projected = { ...canonical, projection: { diagnostics } } as T;
    } else if (canProjectRead && taskType === 'list_creatives' && record) {
      const active = canonicalCreativeExecutionStorage.getStore();
      const activeLegacyFormatConverter = this.resolveLegacyFormatConverter(
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
        this.resolveLegacyFormatConverter(
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
    const converter = this.resolveLegacyFormatConverter(legacyFormatConverter);
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
    routingRequest?: unknown
  ): TaskResult<T> {
    const routingSnapshot = canonicalCreativeRoutingSnapshot(taskType, routingRequest);
    if (result.submitted) {
      const submitted = result.submitted;
      result = {
        ...result,
        submitted: {
          ...submitted,
          track: async transport => {
            const canonical = this.canonicalizeCreativeTaskInfo<T>(
              await canonicalCreativeExecutionStorage.run({ taskType, canonical: true, legacyFormatConverter }, () =>
                submitted.track(transport)
              ),
              taskType,
              transform,
              legacyFormatConverter
            );
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
              routingSnapshot
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
              routingSnapshot
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
    requestParams: Record<string, unknown>
  ): Promise<TaskResult<T>> {
    // Reject non-transactable products (no pricing_options) before any
    // property-policy evaluation, regardless of whether a property policy is
    // configured. This runs on the same completion chokepoint so it covers the
    // sync, polling, track, and webhook paths uniformly.
    result = this.enforceProductPricingOptions(result, taskType);

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
          cacheValidUntil?: string;
        }
      | undefined;

    if (requestPropertyList && enforceRequestPropertyList) {
      try {
        const resolved = await resolvePropertyList(requestPropertyList, propertyListResolveOptions);
        const comparableIdentifiers = comparablePropertyIdentifiers(resolved.identifiers);
        const unsupportedIdentifiers = unsupportedPropertyIdentifiers(resolved.identifiers);
        if (unsupportedIdentifiers.length > 0) {
          throw new Error('property_list_unsupported_identifier_types');
        }
        if (comparableIdentifiers.length > 0 || resolved.identifiers.length === 0) {
          policy.allowedPropertyIdentifiers = [...(policy.allowedPropertyIdentifiers ?? []), ...comparableIdentifiers];
          policy.requireAllowedPropertyMatch = true;
        }
        policy.strict = policy.strict ?? true;
        resolvedRequestPropertyList = {
          listId: resolved.listId,
          agentUrl: resolved.agentUrl,
          identifierCount: resolved.identifiers.length,
          ...(resolved.cacheValidUntil ? { cacheValidUntil: resolved.cacheValidUntil } : {}),
        };
      } catch (err) {
        const errorCode = propertyListResolutionErrorCode(err);
        const diagnosticAgentUrl = sanitizeDiagnosticUrl(requestPropertyList.agent_url);
        return attachMatch({
          success: false as const,
          status: 'failed' as const,
          data: response as unknown as T,
          error: `${message}: could not resolve property_list ${requestPropertyList.list_id}`,
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
                list_id: requestPropertyList.list_id,
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
                list_id: requestPropertyList.list_id,
                agent_url: diagnosticAgentUrl,
                resolution_error: errorCode,
              },
            },
          ],
        });
      }
    }

    if (!hasProductPropertyPolicyRules(policy)) return result;

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
    if (taskType !== 'get_products') return;
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
    if (taskType !== 'get_products' || result.status !== 'submitted' || !result.submitted) return result;

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
            (policyState.request ?? {}) as Record<string, unknown>
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
          completed.data = this.normalizeResponseToV3(taskType, completed.data) as T;
        }
        const terminal = completed.status === 'completed' || completed.status === 'failed';
        try {
          return await this.applyProductPropertyPolicy(
            completed,
            taskType,
            (policyState.request ?? {}) as Record<string, unknown>
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
    requestParams: Record<string, unknown>
  ): Promise<TaskInfo> {
    if (taskType !== 'get_products' || taskInfo.status !== 'completed' || !taskInfo.result) return taskInfo;

    const policyResult = await this.applyProductPropertyPolicy(
      attachMatch({
        success: true as const,
        status: 'completed' as const,
        data: this.normalizeResponseToV3(taskType, taskInfo.result),
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
      requestParams
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
    if (metadata.task_type !== 'get_products' || metadata.status !== 'completed' || !result) {
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

  /**
   * Adapt a request for the detected server wire version and the seller's
   * AdCP protocol version. Applies wire-format adapters (v2.5) when talking
   * to a v2 server, then applies protocol-version adapters (e.g. stripping
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
    perCallCapabilities?: AdcpCapabilities
  ): { params: any; driftLogs: Record<string, unknown>[] } {
    const driftLogs: Record<string, unknown>[] = [];
    let adapted = params;

    if (serverVersion !== 'v3') {
      // Dispatch through the legacy v2.5 adapter registry. Per-tool pairs
      // live in `src/lib/adapters/legacy/v2-5/<tool>.ts`. Tools without a
      // registered pair (or pairs whose request side is pass-through)
      // leave `adapted` unchanged. Adding a future legacy version means
      // adding a sibling `legacy/<version>/` directory, not editing
      // this dispatch.
      const pair = getV25Adapter(taskType);
      if (pair) adapted = pair.adaptRequest(adapted);
    }

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

      // The v2 adapter may rename fields (e.g. brand → brand_manifest) that a
      // v3 server — misdetected as v2 — doesn't declare. Reconcile known
      // adapter mappings so the value isn't silently dropped.
      //
      // CRITICAL: only alias when the JS type of the moved value is
      // compatible with the destination field's declared shape. v2.5 sellers
      // (e.g. Wonderstruck) declare `brand` in their tool schema as a
      // BrandReference object — v2 adapter produces a `brand_manifest` URL
      // string, and blindly aliasing the string into the object slot causes
      // the seller to reject with `Input should be a valid dictionary or
      // instance of BrandReference`. Skip the alias when shapes don't match
      // and let the field-stripping path drop the v2-shaped value cleanly.
      const adapterAliases: [string, string][] = [['brand_manifest', 'brand']];
      for (const [adapterField, schemaField] of adapterAliases) {
        if (
          adapted[adapterField] !== undefined &&
          !declaredFields.has(adapterField) &&
          declaredFields.has(schemaField) &&
          adapted[schemaField] === undefined &&
          valueMatchesSchemaType(adapted[adapterField], (toolSchema as Record<string, unknown>)[schemaField])
        ) {
          adapted[schemaField] = adapted[adapterField];
          delete adapted[adapterField];
        }
      }

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

    // Protocol version adaptation: strip fields not accepted by the target
    // AdCP version. `resolveAdapterKey` returns the effective target version
    // based on the client pin and the seller's advertised caps; adapters live
    // in `src/lib/adapters/version/<target>/`.
    const adapterKey = resolveAdapterKey(this.resolvedAdcpVersion, perCallCapabilities ?? this.cachedCapabilities);
    if (adapterKey) {
      const versionAdapter = getVersionAdapter(adapterKey, taskType);
      if (versionAdapter) {
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

  /**
   * Normalize response to v3 format
   *
   * Converts v2 responses to v3 structure for consistent API surface.
   */
  private normalizeResponseToV3(taskType: string, data: any): any {
    // Dispatch through the legacy v2.5 adapter registry. The pair's
    // optional `normalizeResponse` runs when present; otherwise the
    // response is passed through unchanged.
    const pair = getV25Adapter(taskType);
    if (pair?.normalizeResponse) return pair.normalizeResponse(data);
    return data;
  }

  /**
   * Check if request uses v3 features that the server doesn't support
   *
   * Returns an early empty result if the request requires v3 features
   * that the server doesn't support. This treats "products matching unsupported
   * capability" as an empty result set rather than an error.
   *
   * @returns TaskResult with empty data if v3 features are unsupported, null to proceed normally
   */
  private async getEarlyResultForUnsupportedFeatures<T>(
    taskType: string,
    params: any,
    options?: ReadRequestOptions
  ): Promise<TaskResult<T> | null> {
    // Only check for tasks that have v3-specific features
    if (taskType !== 'get_products') {
      return null;
    }

    // Get capabilities to check what the server supports
    const capabilities = await this.getCapabilities(options);

    // If server is v3, all features are supported - proceed normally
    if (capabilities.version === 'v3') {
      return null;
    }

    // Check for v3-only features that would make this query return empty results.
    //
    // TODO: Once we remove backwards-compatibility stripping in adaptGetProductsRequestForV2,
    // re-enable these guards so v3-only requests fail fast against v2 servers:
    //   (params.property_list && !capabilities.features.propertyListFiltering) ||
    //   (params.filters?.required_features?.includes('property_list_filtering') &&
    //     !capabilities.features.propertyListFiltering) ||
    //
    // TODO: Surface the reason for empty results to the caller (e.g. metadata or a
    // structured warning) so they can distinguish "no products matched" from "server
    // lacks v3 feature support" vs "request failed". Right now empty results from a
    // capability mismatch look identical to a seller that simply has no inventory.
    const usesUnsupportedFeature =
      // required_features: content_standards requires contentStandards
      params.filters?.required_features?.includes('content_standards') && !capabilities.features.contentStandards;

    if (!usesUnsupportedFeature) {
      return null; // Proceed normally
    }

    // Log warning about v2 downgrade
    console.warn(
      `[AdCP] v3-only features not supported by server "${this.agent.id}" (${capabilities.version}). Returning empty results.`
    );

    // Return empty result - semantically "no products match this filter"
    const emptyResponse = {
      products: [],
      property_list_applied: false,
    } as T;

    return {
      success: true,
      status: 'completed',
      data: emptyResponse,
      metadata: {
        taskId: `early_${Date.now()}`,
        taskName: taskType,
        agent: {
          id: this.agent.id,
          name: this.agent.name,
          protocol: this.normalizedAgent.protocol,
        },
        responseTimeMs: 0,
        timestamp: new Date().toISOString(),
        clarificationRounds: 0,
        status: 'completed',
      },
    };
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
    const effectiveLegacyFormatConverter = this.resolveLegacyFormatConverter(
      legacyFormatConverter,
      projectionCatalogs ?? this.config.projectionCatalogs
    );
    const account = canonicalAccountRoutingSnapshot(params.account);
    return this.executeAndHandle<CanonicalGetProductsResponse>(
      'get_products',
      'onGetProductsStatusChange',
      params,
      inputHandler,
      taskOptions,
      data => {
        const { response, diagnostics } = toCanonicalOnlyResponse(data as unknown as { products?: V1Product[] }, {
          legacyFormatConverter: effectiveLegacyFormatConverter,
          projectionCatalogs: projectionCatalogs ?? this.config.projectionCatalogs,
        });
        const authoritativeProducts = Array.isArray((data as unknown as { products?: unknown[] }).products)
          ? (data as unknown as { products: unknown[] }).products
          : response.products;
        this.rememberCanonicalProductRoutes(response.products, account, authoritativeProducts);
        const { _message: _dropLegacyMessage, ...canonical } = response as typeof response & { _message?: unknown };
        void _dropLegacyMessage;
        return { ...canonical, projection: { diagnostics } } as CanonicalGetProductsResponse;
      },
      effectiveLegacyFormatConverter
    );
  }

  /** @deprecated Explicit raw-wire escape hatch for migration tooling. */
  async getProductsLegacy(
    params: GetProductsRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<GetProductsResponse>> {
    return this.executeTaskUnprojected<GetProductsResponse>('get_products', params, inputHandler, options);
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
    params: MutatingRequestInput<CanonicalCreateMediaBuyRequest>,
    inputHandler?: InputHandler,
    options?: CreativeDeliveryTaskOptions
  ): Promise<TaskResult<CanonicalCreativeResponse<CreateMediaBuyResponse>>> {
    return withTaskDeadline(options, effectiveOptions =>
      this.createMediaBuyWithinDeadline(params, inputHandler, effectiveOptions)
    );
  }

  private async createMediaBuyWithinDeadline(
    params: MutatingRequestInput<CanonicalCreateMediaBuyRequest>,
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
    if (hasCreativeFormatData) {
      this.validateBeforeCreativeCapabilityProbe('create_media_buy', params, taskOptions);
    }
    const wireMode = hasCreativeFormatData
      ? this.resolveCreativeFormatWireMode(
          'create_media_buy',
          await this.getCapabilities({ signal: taskOptions.signal, transport: taskOptions.transport })
        )
      : 'canonical';
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
        const consumerAuth = params.reporting_webhook?.authentication;
        const defaultAuth = this.config.webhookSecret
          ? { schemes: ['HMAC-SHA256'] as const, credentials: this.config.webhookSecret }
          : undefined;

        // `reporting-webhook.json` requires `authentication` throughout AdCP 3.x
        // (the requirement lifts in 4.0 when RFC 9421 becomes the only path), so
        // unlike `push_notification_config` the block cannot simply be omitted.
        // With no configured secret and no caller-supplied credential there is
        // nothing real to put there — registering a placeholder would tell the
        // seller its delivery reports are authenticated by a constant that ships
        // in this file. Skip the auto-injection instead and say why.
        if (!consumerAuth && !defaultAuth) {
          // A caller who asked for a `reporting_webhook` explicitly gets an
          // error, not a silent edit: the request cannot be made spec-valid
          // without a credential, and quietly dropping a field the caller wrote
          // would make the SDK a translator of intent rather than a witness to
          // it. Only the library's OWN auto-injection is skipped silently.
          if (params.reporting_webhook) {
            throw new Error(
              'reporting_webhook requires an `authentication` block for all of AdCP 3.x, and no credential ' +
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
              ...params.reporting_webhook,
              authentication: consumerAuth ?? defaultAuth,
            },
          } as CanonicalCreateMediaBuyRequest;
        }
      }
    }

    const result = await this.executeAndHandle<CreateMediaBuyResponse>(
      'create_media_buy',
      'onCreateMediaBuyStatusChange',
      projectMediaBuyCreativesForDelivery(
        params,
        wireMode,
        'create_media_buy',
        effectiveLegacyFormatConverter,
        effectiveCanonicalFormatLegacyResolver
      ),
      inputHandler,
      taskOptions,
      undefined,
      effectiveLegacyFormatConverter,
      params
    );
    if (result.data !== undefined) this.rememberCanonicalPackageRoutes(result.data, params);
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
    return withTaskDeadline(options, effectiveOptions =>
      this.updateMediaBuyWithinDeadline(params, inputHandler, effectiveOptions)
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
      ? this.resolveCreativeFormatWireMode(
          'update_media_buy',
          await this.getCapabilities({ signal: taskOptions.signal, transport: taskOptions.transport })
        )
      : 'canonical';
    const result = await this.executeAndHandle<UpdateMediaBuyResponse>(
      'update_media_buy',
      'onUpdateMediaBuyStatusChange',
      projectMediaBuyCreativesForDelivery(
        params,
        wireMode,
        'update_media_buy',
        effectiveLegacyFormatConverter,
        effectiveCanonicalFormatLegacyResolver
      ),
      inputHandler,
      taskOptions,
      undefined,
      effectiveLegacyFormatConverter,
      params
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
    return withTaskDeadline(options, effectiveOptions =>
      this.syncCreativesWithinDeadline(params, inputHandler, effectiveOptions)
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
    const wireMode = this.resolveCreativeFormatWireMode(
      'sync_creatives',
      await this.getCapabilities({ signal: taskOptions.signal, transport: taskOptions.transport })
    );
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
    const wireParams = projectSyncCreativesForDelivery(
      params,
      [...configuredSelectorContainers, ...assignmentPackageContainers],
      wireMode,
      effectiveLegacyFormatConverter,
      effectiveCanonicalFormatLegacyResolver
    );
    return this.executeAndHandle<SyncCreativesResponse>(
      'sync_creatives',
      'onSyncCreativesStatusChange',
      wireParams,
      inputHandler,
      taskOptions,
      undefined,
      effectiveLegacyFormatConverter,
      params
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

  private resolveCreativeFormatWireMode(taskType: string, capabilities: unknown): CreativeFormatWireMode {
    // Capabilities `adcp.build_version` is advisory deployment metadata. The
    // protocol schema explicitly forbids using it for negotiation, so wire
    // guarantees follow the release pin this client actually emits.
    const wireRelease = this.config.wireAdcpVersion ?? this.resolvedAdcpVersion;
    const declared = resolveCreativeFormatWireMode(capabilities, wireRelease);
    const schema = creativeSchemaSupport(this.cachedToolSchemas?.get(taskType));
    if (declared !== 'unknown' && schema !== 'unknown' && declared !== schema) {
      throw new CreativeFormatCapabilityError(
        `Seller capability and ${taskType} input schema disagree about canonical creative support`
      );
    }
    const resolved = declared !== 'unknown' ? declared : schema;
    const release = /^v?(\d+)\.(\d+)(?:\.|-|$)/.exec(wireRelease.trim());
    const canonicalRequiredByBuyerPin =
      release !== null && (Number(release[1]) > 3 || (Number(release[1]) === 3 && Number(release[2]) >= 2));
    if (resolved === 'unknown' && canonicalRequiredByBuyerPin) {
      throw new CreativeFormatCapabilityError(
        `Cannot prove which AdCP release the seller serves for ${taskType}; a 3.2+ client will not guess a legacy creative wire shape`
      );
    }
    return resolved;
  }

  /** Validate malformed creative payloads before capability discovery can perform I/O. */
  private validateBeforeCreativeCapabilityProbe(taskType: string, params: unknown, options: TaskOptions): void {
    if (options.skipIdempotencyAutoInject || options.skipAccountValidation) return;
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
      effectiveLegacyFormatConverter
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
    const result = await this.executeAndHandle<GetMediaBuysResponse>(
      'get_media_buys',
      'onGetMediaBuysStatusChange',
      params,
      inputHandler,
      taskOptions,
      undefined,
      this.resolveLegacyFormatConverter(legacyFormatConverter, projectionCatalogs ?? this.config.projectionCatalogs)
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
    return this.executeAndHandle<GetMediaBuyDeliveryResponse>(
      'get_media_buy_delivery',
      'onGetMediaBuyDeliveryStatusChange',
      params,
      inputHandler,
      taskOptions,
      undefined,
      this.resolveLegacyFormatConverter(legacyFormatConverter, projectionCatalogs ?? this.config.projectionCatalogs)
    );
  }

  /** Retrieve canonical creative-level and variant-level delivery metrics. */
  async getCreativeDelivery(
    params: GetCreativeDeliveryRequest,
    inputHandler?: InputHandler,
    options?: CanonicalReadTaskOptions
  ): Promise<TaskResult<CanonicalCreativeResponse<GetCreativeDeliveryResponse>>> {
    const { legacyFormatConverter, ...taskOptions } = options ?? {};
    return this.executeAndHandle<GetCreativeDeliveryResponse>(
      'get_creative_delivery',
      'onGetCreativeDeliveryStatusChange',
      params,
      inputHandler,
      taskOptions,
      undefined,
      legacyFormatConverter
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
    return withTaskDeadline(options, effectiveOptions =>
      this.getAdcpCapabilitiesWithinDeadline(params, inputHandler, effectiveOptions)
    );
  }

  private async getAdcpCapabilitiesWithinDeadline(
    params: GetAdCPCapabilitiesRequest,
    inputHandler: InputHandler | undefined,
    options: TaskOptions
  ): Promise<TaskResult<GetAdCPCapabilitiesResponse>> {
    const agent = await this.ensureEndpointDiscovered(options);
    this.executor.validateRequest('get_adcp_capabilities', params);
    return this.executor.executeTask<GetAdCPCapabilitiesResponse>(
      agent,
      'get_adcp_capabilities',
      params,
      inputHandler,
      options
    );
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
   * Sync accounts
   */
  async syncAccounts(
    params: MutatingRequestInput<SyncAccountsRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<SyncAccountsResponse>> {
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
    handlerName?: keyof AsyncHandlerConfig
  ): Promise<TaskResult<T>> {
    return withTaskDeadline(options, async effectiveOptions => {
      const result = await this.executeTaskUnprojectedWithinDeadline<T>(
        taskName,
        params,
        inputHandler,
        effectiveOptions
      );
      if (handlerName) await this.notifyCompletedStatusHandler(result, taskName, handlerName, effectiveOptions);
      return result;
    });
  }

  private async executeTaskUnprojectedWithinDeadline<T = any>(
    taskName: string,
    params: any,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<T>> {
    throwIfAborted(options?.signal);
    const startTime = Date.now();
    try {
      const normalizedParams = normalizeRequestParams(taskName, params, {
        skipIdempotencyAutoInject: options?.skipIdempotencyAutoInject,
        skipAccountValidation: options?.skipAccountValidation,
      });
      this.assertRequestSupportedByConfiguredVersion(taskName, normalizedParams, options);

      await this.validateTaskFeatures(taskName, options);
      if (this.config.requireV3ForMutations && requestUsesIdempotency(taskName, normalizedParams)) {
        await this.requireSupportedMajor(taskName, options);
      }
      const agent = await this.ensureEndpointDiscovered(options);

      // Schema-driven pre-send validation runs on the unadapted v3 shape so
      // wire-format adapters (e.g. adaptGetProductsRequestForV2) don't strip
      // v3-only fields out from under the v3 bundled schema. Skip the entire
      // Zod parse when compliance testing has suppressed required-field
      // validation — the missing field is intentional and Zod would reject it.
      if (!options?.skipIdempotencyAutoInject && !options?.skipAccountValidation) {
        this.executor.validateRequest(taskName, normalizedParams);
      }

      // Adapt request for the detected server and AdCP protocol versions.
      const capabilityDiscoveryContext: CapabilityDiscoveryContext = {};
      const detectionOptions: InternalReadRequestOptions = {
        ...options,
        [CAPABILITY_DISCOVERY_CONTEXT]: capabilityDiscoveryContext,
      };
      const serverVersion = await this.detectServerVersion(detectionOptions);
      this.assertRequestSupportedByTargetVersion(taskName, normalizedParams, capabilityDiscoveryContext.capabilities);
      const { options: effectiveOptions, driftLog: webhookDriftLog } = this.suppressPre31DiscoveryWebhook(
        taskName,
        options,
        capabilityDiscoveryContext.capabilities
      );
      const inputSchemaStripLogs: any[] = [];
      const { params: adaptedParams, driftLogs: adaptDriftLogs } = this.adaptRequest(
        taskName,
        normalizedParams,
        serverVersion,
        inputSchemaStripLogs,
        capabilityDiscoveryContext.toolSchemas,
        capabilityDiscoveryContext.capabilities
      );

      // Symmetric warn-only post-adapter pass against the v2.5 schema bundle.
      // Drift gets surfaced via result.metadata.debug_logs so adapter
      // regressions in production aren't silently swallowed.
      const v25DriftLogs: any[] = [...adaptDriftLogs];
      if (webhookDriftLog) v25DriftLogs.push(webhookDriftLog);
      if (serverVersion === 'v2') {
        this.executor.validateAdaptedRequestAgainstV2(taskName, adaptedParams, v25DriftLogs);
      }

      let result = await this.executor.executeTask<T>(
        agent,
        taskName,
        adaptedParams,
        inputHandler,
        effectiveOptions,
        serverVersion,
        capabilityDiscoveryContext.capabilities
      );

      const postAdapterLogs = [...inputSchemaStripLogs, ...v25DriftLogs];
      if (postAdapterLogs.length > 0) {
        result.debug_logs = [...(result.debug_logs ?? []), ...postAdapterLogs];
      }

      // Normalize response to v3 format for consistent API surface
      if (result.success && result.data) {
        result.data = this.normalizeResponseToV3(taskName, result.data) as T;
      }

      result = this.wrapProductPolicySubmittedContinuation(result, taskName, normalizedParams, options);
      if (result.status === 'working') {
        this.rememberProductPolicyRequestParams(taskName, normalizedParams, result, options);
      }
      result = await this.applyProductPropertyPolicy(result, taskName, normalizedParams);

      return result;
    } catch (error) {
      // Structured protocol errors carry typed fields (reason, actualVersion,
      // unsupportedFeatures, …) that callers use for recovery decisions. Auth
      // and timeout errors trigger OAuth flows / cancellation. All four are
      // established throws — rethrow so callers' existing catch sites work.
      if (
        error instanceof AuthenticationRequiredError ||
        error instanceof TaskTimeoutError ||
        error instanceof VersionUnsupportedError ||
        error instanceof FeatureUnsupportedError ||
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
   * @param inputHandler - Handler to provide the missing input
   *
   * @example
   * ```typescript
   * try {
   *   await client.createMediaBuy(params, handler);
   * } catch (error) {
   *   if (error instanceof DeferredTaskError) {
   *     // Get human input and resume
   *     const result = await client.resumeDeferredTask(
   *       error.token,
   *       (context) => humanProvidedValue
   *     );
   *   }
   * }
   * ```
   */
  async resumeDeferredTask<T = any>(token: string, inputHandler: InputHandler): Promise<TaskResult<T>> {
    // This is a simplified implementation
    // In a full implementation, you'd need to store deferred task state
    // and restore it here
    throw new Error('Deferred task resumption requires storage configuration');
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
    const legacyFormatConverter = this.resolveLegacyFormatConverter(creativeAssociation.legacyFormatConverter);
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
   * Get detailed information about a specific task
   *
   * @param taskId - ID of the task to get information for
   * @returns Promise resolving to task information
   */
  async getTaskInfo(taskId: string): Promise<TaskInfo | null> {
    const task = await this.executor.getTaskInfo(taskId);
    return task && CANONICAL_CREATIVE_ACTIVITY_TASKS.has(task.taskType)
      ? this.canonicalizeCreativeTaskInfo(
          task,
          task.taskType,
          undefined,
          this.resolveLegacyFormatConverter(this.canonicalCreativeTaskAssociation(task.taskId)?.legacyFormatConverter)
        )
      : task;
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
      CANONICAL_CREATIVE_ACTIVITY_TASKS.has(task.taskType)
        ? this.canonicalizeCreativeTaskInfo(
            task,
            task.taskType,
            undefined,
            this.resolveLegacyFormatConverter(this.canonicalCreativeTaskAssociation(task.taskId)?.legacyFormatConverter)
          )
        : task;
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
    // adcp-client#1799 — wrap every wire call in the response-size cap so
    // `transport.maxResponseBytes` extends to discovery / tools-list bodies.
    // `withResponseSizeLimit` is a no-op when no cap is configured.
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
          mcpClient.listTools(undefined, mcpRequestOptions)
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
        !transport?.trustedFetchFn &&
        this.discoveredMcpEra === 'legacy' &&
        Date.now() - this.discoveredMcpEraAt < 5 * 60 * 1000
          ? ({ handled: false } as const)
          : await withResponseSizeLimit(maxResponseBytes, () =>
              tryListModernMCPTools(agent.agent_uri, readAuthToken, this.normalizedAgent.headers, {
                authProvider,
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

      const { client: mcpClient } = await connectMCP(connectOptions);
      try {
        const toolsList = await withResponseSizeLimit(maxResponseBytes, () =>
          mcpClient.listTools(undefined, mcpRequestOptions)
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
      const sizeLimitedFetch = wrapFetchWithSizeLimit((input, init) =>
        transport?.trustedFetchFn ? transport.trustedFetchFn(input, init) : fetch(input as RequestInfo | URL, init)
      );
      const normalizeHeaders = (headers?: HeadersInit): Record<string, string> => {
        const normalized: Record<string, string> = {};
        if (!headers) return normalized;
        if (headers instanceof Headers) {
          headers.forEach((value, key) => {
            normalized[key] = value;
          });
        } else if (Array.isArray(headers)) {
          for (const [key, value] of headers) {
            normalized[key] = value;
          }
        } else {
          Object.assign(normalized, headers);
        }
        return normalized;
      };
      const buildHeaders = (requestInit?: RequestInit): Record<string, string> => ({
        ...normalizeHeaders(requestInit?.headers),
        ...agentHeaders,
        ...(authToken && {
          Authorization: `Bearer ${authToken}`,
          'x-adcp-auth': authToken,
        }),
      });
      const fetchImpl = async (url: string | URL | Request, requestInit?: RequestInit) => {
        const headers = buildHeaders(requestInit);
        return withAbortSignal<Response>([options?.signal, requestInit?.signal], requestTimeoutMs, signal =>
          sizeLimitedFetch(url as RequestInfo | URL, { ...requestInit, headers, signal })
        );
      };

      const cardUrls = buildCardUrls(this.normalizedAgent.agent_uri);

      let client: InstanceType<typeof A2AClient> | undefined;
      let lastCardError: Error = new Error(`A2A agent card not found at ${cardUrls.join(', ')}`);
      for (const cardUrl of cardUrls) {
        try {
          // Wrap A2A card discovery so `transport.maxResponseBytes` applies
          // to agent-card fetches and the deferred `agentCardPromise` read
          // below — both fire fetches that would otherwise bypass the cap.
          client = await withResponseSizeLimit(maxResponseBytes, () => A2AClient.fromCardUrl(cardUrl, { fetchImpl }));
          break;
        } catch (err: unknown) {
          lastCardError = err as Error;
        }
      }
      if (!client) {
        throw lastCardError;
      }
      const agentCard = await withResponseSizeLimit(maxResponseBytes, async () =>
        client.agentCardPromise ? client.agentCardPromise : client.agentCard
      );

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
        name: agentCard?.displayName || agentCard?.name || this.normalizedAgent.name,
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
   * For v2 servers, builds synthetic capabilities from available tools.
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
    throwIfAborted(options?.signal);
    const discoveryContext = (options as InternalReadRequestOptions | undefined)?.[CAPABILITY_DISCOVERY_CONTEXT];
    const transport = normalizeTransportOptions(options?.transport ?? this.config.transport);
    const usesScopedFetch = transport?.trustedFetchFn !== undefined;
    // Return cached if available
    if (!usesScopedFetch && this.cachedCapabilities) {
      if (discoveryContext) discoveryContext.toolSchemas = this.cachedToolSchemas;
      this.maybeWarnV2Sunset(this.cachedCapabilities);
      return this.cachedCapabilities;
    }

    // First get tool list to support both detection methods
    const agentInfo = await this.getAgentInfo(options);
    const tools: ToolInfo[] = agentInfo.tools.map(t => ({
      name: t.name,
      description: t.description,
    }));

    // Make raw tool schemas available for field-level compatibility checks
    // (e.g. buying_mode on get_products). Scoped fetch keeps them in the
    // request-local discovery context; unscoped calls may share the cache.
    const discoveredToolSchemas = new Map(
      agentInfo.tools
        .filter(t => t.inputSchema?.properties)
        .map(t => [t.name, t.inputSchema!.properties as Record<string, unknown>])
    );
    if (discoveryContext) discoveryContext.toolSchemas = discoveredToolSchemas;
    if (!usesScopedFetch) this.cachedToolSchemas = discoveredToolSchemas;

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
        const result = await this.executor.executeTask<any>(agent, 'get_adcp_capabilities', {}, undefined, options);
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
          if (!usesScopedFetch) this.cachedCapabilities = capabilities;
          this.maybeWarnV2Sunset(capabilities);
          return capabilities;
        }
        if (!advertisesCapabilitiesTool) {
          throw new Error('unadvertised official A2A capability probe was not supported');
        }
        // Tightened v2 fallback (issue #1189). When `result.success` is false
        // but `result.data` is structurally v3-shaped, the agent is a v3 agent
        // with a wire-shape bug — typically a single failed schema validation
        // on `get_adcp_capabilities`. Falling back to v2 in this case masks
        // the original bug behind cascading "AdCP schema data for version v2.5
        // not found" errors that nobody can debug. Parse the data anyway,
        // surface the validation failure loudly, and continue with the
        // v3 capabilities the agent actually returned.
        //
        // Override `version`/`majorVersions` after parse: when the response
        // doesn't carry an explicit `adcp.major_versions` block (one of the
        // valid v3-shape signals), `parseCapabilitiesResponse` defaults
        // majorVersions to [2] which would re-classify a known-v3 response
        // as v2 downstream. The heuristic established v3-shape; honor that.
        // CodeQL: deliberately omit `result.error` from the log (matches the
        // existing fallback log below) — it can carry transport-level agent
        // identifiers that flow through the clear-text-logging tracker.
        if (result.data && looksLikeV3Capabilities(result.data)) {
          console.warn(
            `[AdCP] Agent "${this.agent.id}" returned a get_adcp_capabilities response that ` +
              `failed validation, but the response is structurally v3-shaped. Treating as v3 ` +
              `(the agent has a wire-shape bug — that's the thing to fix).`,
            { hasError: !!result.error, hasData: !!result.data }
          );
          const parsed = parseCapabilitiesResponse(result.data);
          const v3Capabilities: AdcpCapabilities = {
            ...parsed,
            version: 'v3',
            majorVersions: parsed.majorVersions.includes(3) ? parsed.majorVersions : ([3] as AdcpMajorVersion[]),
          };
          const capabilities = augmentCapabilitiesFromTools(v3Capabilities, tools);
          if (!usesScopedFetch) this.cachedCapabilities = capabilities;
          this.maybeWarnV2Sunset(capabilities);
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
        if (!usesScopedFetch) this.cachedCapabilities = capabilities;
        this.maybeWarnV2Sunset(capabilities);
        return capabilities;
      }
    }

    // No get_adcp_capabilities tool — the agent is verifiably v2 (the tool
    // is v3-only). Synthesize v2 capabilities from the tool list.
    console.warn(
      `[AdCP] Agent "${this.agent.id}" detected as v2 (no get_adcp_capabilities tool). ` +
        `Tools: [${tools.map(t => t.name).join(', ')}]`
    );
    const capabilities = buildSyntheticCapabilities(tools);
    if (!usesScopedFetch) this.cachedCapabilities = capabilities;
    return capabilities;
  }

  /**
   * Emit a one-time warning when the agent reports v2 capabilities.
   *
   * v2 went unsupported on 2026-04-20 (AdCP 3.0 GA — adcp#2220). We still
   * execute v2 code paths (no behaviour change), but clients integrating
   * against an unsupported agent should hear about it loudly.
   *
   * Synthetic capabilities (no `get_adcp_capabilities` tool available) don't
   * trigger the warning — we don't actually know the agent's version, and
   * shouting at legitimately-unversioned agents would be noise.
   *
   * Suppression: `process.env.ADCP_ALLOW_V2 === '1'`.
   */
  private maybeWarnV2Sunset(capabilities: AdcpCapabilities): void {
    if (this._v2WarningFired) return;
    if (capabilities.version === 'v3') return;
    if (capabilities._synthetic) return;
    if (process.env.ADCP_ALLOW_V2 === '1') return;

    this._v2WarningFired = true;
    console.warn(
      `[adcp] Warning: agent ${this.agent.agent_uri} reports v2 capabilities. ` +
        `v2 went unsupported on 2026-04-20 (AdCP 3.0 GA). ` +
        `Upgrade the agent to v3 or set ADCP_ALLOW_V2=1 to suppress this warning. ` +
        `See https://github.com/adcontextprotocol/adcp/issues/2220`
    );
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
   * Warn once per client when `requireSupportedMajor` routes a synthetic-v2
   * seller through the v2 adapter — the agent did not expose
   * `get_adcp_capabilities`, so the version was inferred from `tools/list`.
   * A compliant v3 seller would declare itself; absence of a declaration is
   * read as v2. Idempotency-TTL guarantees are unknown for these sellers,
   * so BYOK retry callers should treat them as such.
   *
   * One-shot via `_syntheticV2WarningFired` (matches `maybeWarnV2Sunset`
   * cadence).
   */
  private maybeWarnSyntheticV2(): void {
    if (this._syntheticV2WarningFired) return;
    this._syntheticV2WarningFired = true;
    console.warn(
      `[adcp] Warning: agent ${this.agent.agent_uri} does not expose get_adcp_capabilities. ` +
        `Routing as v2 (synthetic) — idempotency-TTL guarantee is unknown. ` +
        `Ask the agent operator to declare v3 via get_adcp_capabilities if v3 routing is intended. ` +
        `Branch on client.isSyntheticV2() to tighten retry policies for these sellers.`
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
    return capabilities.version;
  }

  /**
   * Whether the seller's capabilities are synthesized from `tools/list`
   * with no authoritative `get_adcp_capabilities` response — i.e. the
   * dispatcher routes through the v2 adapter and idempotency-TTL is
   * unknown. Use this to gate retry behavior for sellers whose retry
   * safety can't be derived from declared capabilities (lower attempt
   * caps, longer backoff, or fall back to natural-key recovery).
   *
   * Returns `false` for declared v2 sellers, declared v3 sellers, and
   * synthetic v3 sellers (which advertise the v3 discovery tool even
   * when the call itself failed).
   *
   * Caveat for synthetic v3: the predicate returns `false`, but TTL is
   * still unknown for those sellers — `getIdempotencyReplayTtlSeconds()`
   * throws until the agent's capabilities endpoint is fixed (issue
   * #1217). Retry-policy consumers that need a complete "TTL unknown"
   * gate should additionally check `getCapabilities()._synthetic`.
   */
  async isSyntheticV2(): Promise<boolean> {
    const capabilities = await this.getCapabilities();
    return capabilities._synthetic === true && capabilities.version === 'v2';
  }

  /**
   * Check if server supports a specific AdCP major version
   */
  async supportsVersion(version: 2 | 3): Promise<boolean> {
    const capabilities = await this.getCapabilities();
    return capabilities.majorVersions.includes(version);
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
   * would mislead buyers about retry safety. Callers on v2 servers get
   * `undefined` instead of a throw — v2 pre-dates the idempotency envelope.
   */
  async getIdempotencyReplayTtlSeconds(): Promise<number | undefined> {
    const capabilities = await this.getCapabilities();
    if (capabilities.idempotency) {
      assertValidIdempotencyReplayTtlSeconds(capabilities.idempotency.replayTtlSeconds);
      return capabilities.idempotency.replayTtlSeconds;
    }
    if (capabilities.version !== 'v3') return undefined;
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
    const capabilities = await this.getCapabilities();
    const missing = features.filter(f => !resolveFeature(capabilities, f));
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

    const capabilities = await this.getCapabilities(options);
    const missing = requiredFeatures.filter(f => !resolveFeature(capabilities, f));
    if (missing.length > 0) {
      throw new FeatureUnsupportedError(missing, listDeclaredFeatures(capabilities), this.agent.agent_uri);
    }
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
    _options?: TaskOptions,
    canonicalCreativeInvocation = false
  ): void {
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
    serverVersion?: 'v2' | 'v3'
  ): void {
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
   * Sellers whose capabilities are synthesized from `tools/list` (no
   * authoritative `get_adcp_capabilities` response) are treated as v2: a
   * compliant v3 seller would declare itself, so absence of a declaration
   * is taken as evidence of v2. The dispatcher routes the request through
   * the v2 wire-shape adapter. A one-time warning surfaces the routing
   * decision so adopters can audit it; retry-safety (idempotency TTL) is
   * unknown for these sellers and BYOK callers should treat them as such.
   *
   * Per-client `allowV2: true` or, when that's undefined,
   * `ADCP_ALLOW_V2=1` in the environment bypasses the guard entirely.
   *
   * Throws `VersionUnsupportedError` with the specific reason on failure.
   */
  async requireSupportedMajor(taskType: string = 'request', options?: ReadRequestOptions): Promise<void> {
    if (this.isV2Allowed()) return;
    const capabilities = await this.getCapabilities(options);

    // Synthetic capabilities — no authoritative `get_adcp_capabilities`
    // response, so the version + idempotency-TTL fields couldn't be read.
    // Route as the synthesized version (v2 when the v3 discovery tool is
    // absent from tools/list, v3 when the tool is present but the call
    // failed). Emit a one-time per-client warning so adopters can audit
    // the routing decision and the skipped TTL guarantee.
    if (capabilities._synthetic) {
      if (capabilities.version === 'v3') {
        this.maybeWarnSyntheticV3();
      } else {
        this.maybeWarnSyntheticV2();
      }
      return;
    }
    // Prefer release-precision matching when the seller advertises
    // `supported_versions` (AdCP 3.1+ per spec PR `adcontextprotocol/adcp#3493`).
    // Fall back to the deprecated integer `major_versions` for legacy 3.0
    // sellers. Pre-release pins match exactly per spec — `'3.1.0-beta.1'`
    // matches only against another `'3.1.0-beta.1'`, not `'3.1'`.
    const supportedVersions = capabilities.supportedVersions;
    if (supportedVersions !== undefined && supportedVersions.length > 0) {
      if (!isAdcpVersionSupported(this.resolvedAdcpVersion, supportedVersions)) {
        throw new VersionUnsupportedError(taskType, 'version', capabilities.version, this.agent.agent_uri);
      }
    } else {
      // `AdcpMajorVersion` is currently `2 | 3` — cast through `number[]` because
      // the parsed major is a plain number; a future SDK release that supports
      // major 4 will widen the union.
      const expectedMajor = parseAdcpMajorVersion(this.resolvedAdcpVersion);
      const advertisedMajors = capabilities.majorVersions as readonly number[];
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

  private isV2Allowed(): boolean {
    if (this.config.allowV2 !== undefined) return this.config.allowV2 === true;
    return process.env.ADCP_ALLOW_V2 === '1';
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
  private validateRequest(taskType: string, params: any): void {
    const schema = this.getRequestSchema(taskType);
    if (!schema) {
      return; // No schema available for this task type
    }

    try {
      schema.parse(params);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const issues = error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
        throw new Error(`Request validation failed for ${taskType}: ${issues}`);
      }
      throw error;
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
  private getRequestSchema(taskType: string): z.ZodSchema | null {
    const schemaMap: Partial<Record<string, z.ZodSchema>> = {
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

    return schemaMap[taskType] || null;
  }
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
    if (error.code === 'webhook_signature_rate_abuse') return 429;
    if (
      error.code === 'webhook_registration_store_unavailable' ||
      error.code === 'webhook_verification_unavailable' ||
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
