#!/usr/bin/env tsx
/**
 * Adopter type-check guard.
 *
 * Packs the SDK as it would ship to npm, scaffolds a minimal adopter
 * project that imports every public subpath, and runs `tsc --noEmit`
 * against it. Catches the class of bug where an internal symbol or
 * `declare`-only binding ends up referenced by a public `.d.ts` but
 * stripped from the emitted bundle — which compiles cleanly inside the
 * monorepo but fails on every adopter (issue #1236).
 *
 * Run via `npm run check:adopter-types`. Exits non-zero on any tsc
 * diagnostic against the scaffold.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Heap ceiling for the adopter tsc pass. The published `.d.ts` surface
// across `@adcp/sdk` + `@adcp/sdk/server` pulls in the full 3.1 codegen
// graph (~25K lines of generated types) without the monorepo's
// project-wide tsconfig optimizations. On Node's default 4 GiB heap, tsc
// OOMs during type instantiation before it can emit diagnostics — so
// adopters debugging the published types get a heap-exhaustion stack
// trace, not a useful tsc error. 8 GiB clears the current surface with
// headroom; revisit if the schema cache grows substantially further.
const TSC_HEAP_MB = 8192;

const REPO_ROOT = join(__dirname, '..');

const ADOPTER_TSCONFIG = {
  compilerOptions: {
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'bundler',
    esModuleInterop: true,
    strict: true,
    skipLibCheck: false,
    noEmit: true,
    types: ['node'],
    ignoreDeprecations: '6.0',
  },
  include: ['adopter.ts'],
};

const DECLARATION_TSCONFIG = {
  compilerOptions: {
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'bundler',
    strict: true,
    skipLibCheck: false,
    declaration: true,
    emitDeclarationOnly: true,
    outDir: 'declarations',
    types: ['node'],
    ignoreDeprecations: '6.0',
  },
  include: ['adopter-declaration.ts'],
};

const DECLARATION_SOURCE = `
import { ProductSchema, GetProductsRequestSchema } from '@adcp/sdk/schemas';
import { z } from 'zod';

export const SavedProductSchema = ProductSchema.safeExtend({
  local_id: z.string().optional(),
});

export const LocalGetProductsSchema = GetProductsRequestSchema.extend({
  ext: z.object({ local: z.record(z.string(), z.unknown()) }).optional(),
});

export const LocalGetProductsWithoutOptionalExtension: z.output<typeof LocalGetProductsSchema> = {
  buying_mode: 'brief',
};
`;

const ADOPTER_SOURCE = `
// Mirrors the repro from issue #1236 and locks the server-side handler
// payload typing surface that adopters consume from a packed SDK tarball.
import type {
  AdcpServer,
  Account,
  AccountStore,
  ActivateSignalPayload,
  LegacyBuildCreativePayload,
  LegacyBuildCreativeMultiPayload,
  LegacyBuildCreativeVariantPayload,
  CheckGovernancePayload,
  CreativeApprovedPayload,
  CreatePropertyListPayload,
  CreateMediaBuyPayload,
  CreateMediaBuyHandlerResult,
  DecisioningAdcpServer,
  GetMediaBuyDeliveryPayload,
  GetMediaBuysPayload,
  GetAccountFinancialsHandlerResult,
  GetBrandIdentityPayload,
  GetProductsHandlerResult,
  GetProductsPayload,
  LegacyGetRightsPayload,
  ListAccountsHandlerResult,
  ListAccountChangesHandlerResult,
  ListAccountsPayload,
  LegacyListCreativeFormatsPayload,
  LegacyListContentStandardsPayload,
  OperationalContext,
  OperationalPlatform,
  RightsTerms,
  ReportUsageHandlerResult,
  SalesCorePlatform,
  SalesIngestionPlatform,
  ServerPayload,
  SIGetOfferingPayload,
  SyncAudiencesPayload,
  SyncAccountsHandlerResult,
  SyncAccountsResultRow,
  SyncCreativesPayload,
  SyncCreativesHandlerResult,
  SyncEventSourcesPayload,
  SyncGovernanceHandlerResult,
  TaskHandoffProgress,
  TaskRegistry,
  LegacyUpdateRightsPayload,
  UpdateMediaBuyPayload,
} from '@adcp/sdk/server';
import {
  createAdcpServerFromPlatform,
  defineOperationalPlatform,
  withResponseSummary,
} from '@adcp/sdk/server';
import { createAdcpServer as createLegacyAdcpServer } from '@adcp/sdk/server/legacy/v5';
import { normalizeLegacyGetProductsResponse } from '@adcp/sdk/v2/projection';
import { createSingleAgentClient, extractAdcpErrorFromMcp, extractAdcpErrorFromTransport } from '@adcp/sdk';
import type {
  CreateMediaBuyPayload as TypesCreateMediaBuyPayload,
  CreateMediaBuySuccess,
  BuildCreativeVariantSuccess,
  CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement,
  CanonicalFormatBase,
  CanonicalFormatDAASTAudio,
  CanonicalFormatDisplayTag,
  CanonicalFormatHostedAudio,
  CanonicalFormatHostedVideo,
  CanonicalFormatHTML5Banner,
  CanonicalFormatImageCarousel,
  CanonicalFormatNativeInFeed,
  CanonicalFormatResponsiveCreative,
  CanonicalFormatSponsoredPlacementRetailMediaCatalogDriven,
  CanonicalFormatVASTVideo,
  CreativeManifest,
  ExtensionObject,
  GetProductsPayload as TypesGetProductsPayload,
  ServerPayload as ServerPayloadFromTypes,
  UpdateMediaBuyPayload as TypesUpdateMediaBuyPayload,
} from '@adcp/sdk/types';
import type {
  AccountReference,
  CreativeBrief,
  DisclosurePosition,
  FormatSchemaReferenceResult,
  CreateMediaBuyPayload as RootCreateMediaBuyPayload,
  DelegatedOperatorAuthorizationContext,
  GetProductsPayload as RootGetProductsPayload,
  LegacyProduct,
  LegacyGetProductsResponse,
  MediaBuyAvailableAction,
  Package,
  ProductCardFields,
  ProductCardDetailedFields,
  GetProductsRequest,
  SLAWindow,
  SlaWindow,
  TaskOptions,
  UpdateMediaBuyPayload as RootUpdateMediaBuyPayload,
  LegacyGetProductsRequest,
  WebhookRegistration,
} from '@adcp/sdk';
import { z } from 'zod';
import type {
  AdCPVersionEnvelope,
  AudienceCharacteristic,
  CanonicalFormatBase as ToolCanonicalFormatBase,
  CommercialTerms,
  ExplicitPackagesWithFixedAllocation,
  ListCreativesResponse,
  NotificationConfig,
  Placement,
  PostalCountrySystem,
  PublisherPropertySelector,
  ProductFormatDeclaration,
  ProtocolEnvelope,
  SelectedPlacements,
  SignalDefinitionEnrichment,
  SignalTargetingExpression,
} from '@adcp/sdk/types/tools.generated';
import type {
  BrandReference1,
  BrandReference2,
  BrandReference3,
  BrandReference4,
  BrandReference5,
  BrandReference6,
  BrandReference7,
  BrandReference8,
  BrandReference9,
  BrandReference10,
  BrandReference11,
  BrandReference12,
  BusinessEntity1,
  MeasurementTerms1,
  None1,
  None2,
  PlatformExtensionReference1,
  PostalArea,
  PostalArea1,
  Product1,
  Property1,
} from '@adcp/sdk/types/core.generated';
import { createCanonicalReferenceResolver as createSubpathCanonicalReferenceResolver } from '@adcp/sdk/canonical-references';
import { customToolFor, customToolForSchema, TOOL_INPUT_SCHEMAS, TOOL_INPUT_SHAPES, TOOL_REQUEST_SCHEMAS } from '@adcp/sdk/schemas';
import * as publicSchemas from '@adcp/sdk/schemas';

const _delegatedOperatorAuthorization: DelegatedOperatorAuthorizationContext = {
  brand: 'brand_a',
  scope: 'media_buying',
  country: 'GB',
};
const _delegatedTaskOptions: TaskOptions = {
  delegatedOperatorAuthorization: _delegatedOperatorAuthorization,
};
const _tupleAwareWebhookRegistration: WebhookRegistration = {
  agentId: 'seller',
  agentUrl: 'https://seller.example/mcp',
  protocol: 'mcp',
  operationId: 'operation',
  taskType: 'get_products',
  callbackUrl: 'https://buyer.example/webhook',
  method: 'POST',
  mode: 'rfc9421',
  authorizationContextVersion: 1,
  delegatedOperatorAuthorization: _delegatedOperatorAuthorization,
  createdAt: 1,
  expiresAt: 2,
};
void _delegatedTaskOptions;
void _tupleAwareWebhookRegistration;

const _accountChangeStore: AccountStore = {
  async resolve() {
    return null;
  },
  async listChanges(): Promise<ListAccountChangesHandlerResult> {
    return {
      changes: [],
      cursor: 'checkpoint',
      has_more: false,
      available_since: '2026-01-01T00:00:00Z',
      generated_at: '2026-08-28T00:00:00Z',
    };
  },
};
void _accountChangeStore;

// Issue #2831: decisioning Account surfaces must accept the current generated
// 3.2 notification contract, including reporting lifecycle subscriptions.
const _reportingStatusNotification: NotificationConfig = {
  subscriber_id: 'reporting-status',
  url: 'https://buyer.example/webhooks/adcp/reporting',
  event_types: ['reporting.status_changed'],
};
const _accountWithReportingStatusNotification: Account = {
  id: 'acct_1',
  name: 'Acme',
  status: 'active',
  ctx_metadata: {},
  notification_configs: [_reportingStatusNotification],
};
const _syncRowWithReportingStatusNotification: SyncAccountsResultRow = {
  brand: { domain: 'acme.example' },
  operator: 'acme-direct',
  action: 'updated',
  status: 'active',
  notification_configs: [_reportingStatusNotification],
};
void _accountWithReportingStatusNotification;
void _syncRowWithReportingStatusNotification;

// Public schema declarations must retain their object helpers and complete
// parse outputs after packing, not just while compiling inside the repository.
void publicSchemas.ProductSchema.shape.reporting_capabilities;
void publicSchemas.ProductSchema.extend({});
void publicSchemas.PackageSchema.pick({ package_id: true });
void publicSchemas.PackageRequestSchema.extend({});
void publicSchemas.PackageUpdateSchema.omit({ paused: true });
void publicSchemas.GetProductsResponseSchema.pick({ status: true });
void publicSchemas.PackageSchema.safeParse({});

// Issue #2674: exercise the packed declarations through the same composition
// patterns used by real adopters, not only through bare helper access.
const _productOutputExtensionsSchema = z.object({
  publisher_properties: z.array(publicSchemas.PublisherPropertySelectorSchema),
});
const _compatibleProductSchema = publicSchemas.ProductSchema.safeExtend(_productOutputExtensionsSchema.shape);
const _stagedCompatibleProductSchema = _compatibleProductSchema.safeExtend({
  placements: z.array(z.object({ placement_id: z.string(), name: z.string() })).optional(),
});
const _consumerProductSchema = publicSchemas.ProductSchema.safeExtend({
  publisher_properties: z.array(z.object({ property_id: z.string() })).optional(),
});
const _stagedConsumerProductSchema = _consumerProductSchema.safeExtend({
  placements: z.array(z.object({ placement_id: z.string(), name: z.string() })).optional(),
});
function _acceptZodObject<T extends z.ZodObject>(schema: T): T {
  return schema;
}
_acceptZodObject(publicSchemas.ProductSchema);
_acceptZodObject(_stagedConsumerProductSchema);
_acceptZodObject(_stagedCompatibleProductSchema);
declare const _stagedConsumerProduct: z.output<typeof _stagedConsumerProductSchema>;
const _stagedPublisherProperties: Array<{ property_id: string }> | undefined =
  _stagedConsumerProduct.publisher_properties;
void _stagedPublisherProperties;
publicSchemas.ProductSchema.safeExtend({
  // @ts-expect-error Product compatibility bridges still require Zod schemas.
  publisher_properties: 123,
});
publicSchemas.ProductSchema.safeExtend({
  // @ts-expect-error Product compatibility bridges still require Zod schemas.
  placements: 123,
});
publicSchemas.ProductSchema.safeExtend({
  // @ts-expect-error Unbridged Product fields retain normal safeExtend compatibility checks.
  name: z.number(),
});
const _composedProductsResponseSchema = publicSchemas.GetProductsResponseSchema.extend({
  status: z.literal('completed'),
  products: z.array(_compatibleProductSchema),
})
  .partial()
  .extend({ products: z.array(_compatibleProductSchema.partial()).optional() });
declare const _unknownPackedInput: unknown;
const _composedProductsResponse = _composedProductsResponseSchema.safeParse(_unknownPackedInput);
if (_composedProductsResponse.success) {
  _composedProductsResponse.data.products?.map(product => product.product_id);
}
type _IsAny<T> = 0 extends 1 & T ? true : false;
type _IsNever<T> = [T] extends [never] ? true : false;
type _Assert<T extends true> = T;
type _ComposedProduct = NonNullable<z.output<typeof _composedProductsResponseSchema>['products']>[number];
type _ComposedProductIsTyped = _Assert<_IsAny<_ComposedProduct> extends false ? true : false>;
type _ProductWithPlacementsPublisherProperties = z.output<
  typeof _productWithPlacementsSchema
>['publisher_properties'];
type _ProductWithPlacementsPublisherPropertiesIsTyped = _Assert<
  _IsAny<_ProductWithPlacementsPublisherProperties> extends false
    ? _IsNever<_ProductWithPlacementsPublisherProperties> extends false
      ? true
      : false
    : false
>;
const _pickedProductPublisherPropertiesSchema = publicSchemas.ProductSchema.pick({ publisher_properties: true });
type _PickedPublisherProperties = z.output<
  typeof _pickedProductPublisherPropertiesSchema
>['publisher_properties'];
type _PickedPublisherPropertiesIsTyped = _Assert<
  _IsAny<_PickedPublisherProperties> extends false
    ? _IsNever<_PickedPublisherProperties> extends false
      ? true
      : false
    : false
>;
declare const _pickedPublisherProperties: _PickedPublisherProperties;
const _pickedPublisherPropertiesAsPublic: PublisherPropertySelector[] = _pickedPublisherProperties;
void (null as unknown as _ComposedProductIsTyped);
void (null as unknown as _ProductWithPlacementsPublisherPropertiesIsTyped);
void (null as unknown as _PickedPublisherPropertiesIsTyped);
void _pickedPublisherPropertiesAsPublic;
declare const _consumerProduct: z.output<typeof _consumerProductSchema>;
const _consumerProductId: string = _consumerProduct.product_id;
void _consumerProductId;
const _productChannelsSchema = publicSchemas.ProductSchema.pick({ channels: true });
const _productChannelsInput: z.input<typeof _productChannelsSchema> = {};
void _productChannelsInput;
const _productWithPlacementsSchema = publicSchemas.ProductSchema.safeExtend({
  placements: z.array(z.object({
    placement_id: z.string(),
    name: z.string(),
  })).optional(),
});
declare const _productWithPlacements: z.output<typeof _productWithPlacementsSchema>;
const _productPublisherProperties: PublisherPropertySelector[] = _productWithPlacements.publisher_properties;
void _productPublisherProperties;
type _InferredPackage = z.infer<typeof publicSchemas.PackageSchema>;
declare const _inferredPackage: _InferredPackage;
const _inferredPackageAsPublic: Package = _inferredPackage;
declare const _publicPackage: Package;
const _publicPackageAsInferred: _InferredPackage = _publicPackage;
void _inferredPackageAsPublic;
void _publicPackageAsInferred;
const _packedGetProductsRequest: GetProductsRequest =
  publicSchemas.GetProductsRequestSchema.parse(_unknownPackedInput);
void _packedGetProductsRequest;
const _minimalPackedGetProductsRequestInput: z.input<typeof publicSchemas.GetProductsRequestSchema> = {
  buying_mode: 'brief',
};
void _minimalPackedGetProductsRequestInput;
const _extendedPackedGetProductsRequest = publicSchemas.GetProductsRequestSchema.extend({
  local_extension: z.string().optional(),
}).parse({ buying_mode: 'wholesale' }) satisfies GetProductsRequest & {
  local_extension?: string;
};
void _extendedPackedGetProductsRequest;
const _summarizedProducts: GetProductsHandlerResult = withResponseSummary(
  { products: [], cache_scope: 'public' },
  'Synthetic sample data for demonstration only.'
);
// @ts-expect-error — the published wrapper must retain its payload type.
const _invalidSummarizedProducts: GetProductsHandlerResult = withResponseSummary(
  { products: 'not-an-array', cache_scope: 'public' },
  'Invalid fixture.'
);
const _normalizedRecoveredProducts = normalizeLegacyGetProductsResponse({ products: [] });
const _invalidForecastNormalization = normalizeLegacyGetProductsResponse({
  products: [{ forecast: [] }],
});
type _NormalizedRecoveredProductsIsTyped = _Assert<
  _IsAny<typeof _normalizedRecoveredProducts> extends false ? true : false
>;
// @ts-expect-error — an array forecast selects the unknown safety overload.
const _invalidForecastNormalizationAsTyped: { products: Array<{ forecast: Record<string, unknown> }> } =
  _invalidForecastNormalization;
void _summarizedProducts;
void _invalidSummarizedProducts;
void _normalizedRecoveredProducts;
void _invalidForecastNormalizationAsTyped;
void (null as unknown as _NormalizedRecoveredProductsIsTyped);

const _wireFields = publicSchemas.LegacyGetProductsRequestSchema.parse({
  buying_mode: 'wholesale',
  fields: ['format_ids'],
  brand: {
    domain: 'buyer.example',
    brand_kit_override: {
      logo: {
        asset_type: 'image',
        url: 'https://buyer.example/logo.png',
        width: 100,
        height: 100,
        provenance: {
          disclosure: {
            required: true,
            jurisdictions: [
              {
                country: 'US',
                regulation: 'example_rule',
                render_guidance: { positions: ['overlay'] },
              },
            ],
          },
        },
      },
    },
  },
});
type _WireFieldSupportsLegacy = _Assert<
  'format_ids' extends NonNullable<LegacyGetProductsRequest['fields']>[number] ? true : false
>;
const _wireField: NonNullable<LegacyGetProductsRequest['fields']>[number] | undefined = _wireFields.fields?.[0];
const _canonicalGetProductsFields: z.input<typeof publicSchemas.GetProductsRequestSchema> = {
  buying_mode: 'wholesale',
  fields: ['format_options'],
};
const _legacyGetProductsFields: z.input<typeof publicSchemas.LegacyGetProductsRequestSchema> = {
  buying_mode: 'wholesale',
  fields: ['format_ids'],
};
const _disclosurePosition: DisclosurePosition | undefined =
  _wireFields.brand?.brand_kit_override?.logo?.provenance?.disclosure?.jurisdictions?.[0]?.render_guidance
    ?.positions?.[0];
void _wireField;
void _canonicalGetProductsFields;
void _legacyGetProductsFields;
void _disclosurePosition;
void (null as unknown as _WireFieldSupportsLegacy);

type PackedAssignedPackage = NonNullable<
  NonNullable<ListCreativesResponse['creatives'][number]['assignments']>['assigned_packages']
>[number];
declare const _packedAssignment: PackedAssignedPackage;
const _packedAssignmentId: string = _packedAssignment.package_id;
const _packedAssignedDate: string = _packedAssignment.assigned_date;
void [_packedAssignmentId, _packedAssignedDate, _packedAssignment.approval_status, _packedAssignment.indicators];

declare const _server: AdcpServer;
void _server;
void createSingleAgentClient;
void extractAdcpErrorFromMcp;
void extractAdcpErrorFromTransport;
void createAdcpServerFromPlatform;

// Scoped task-registry migration: production reads require explicit authority;
// the old unscoped lookup is intentionally absent from packed declarations.
declare const _decisioningServer: DecisioningAdcpServer;
void _decisioningServer.getTaskState('task_1', { accountId: 'acct_1', ownerScope: 'account:acct_1' });
// @ts-expect-error unsafe task lookup is not a public production API
void _decisioningServer.getTaskStateUnsafe('task_1');
void _decisioningServer.awaitTaskUnsafe('task_1');
const _taskRegistry: TaskRegistry = {
  scopeVersion: 1,
  async create() {
    return { taskId: 'task_1', accountId: 'acct_1', ownerScope: 'account:acct_1' };
  },
  async getTask() {
    return null;
  },
  async complete() {},
  async fail() {},
  async updateProgress() {},
  _registerBackground() {},
  async awaitTask() {},
  async _awaitTaskUnsafe() {},
};
// @ts-expect-error unsafe task lookup is not part of the public registry contract
void _taskRegistry._getTaskUnsafe('task_1');
void _taskRegistry._awaitTaskUnsafe('task_1');
const _extendedProgress: TaskHandoffProgress = { message: 'working', creatives_processed: 3 };
void _extendedProgress;

const _createMediaBuyPayload: CreateMediaBuyPayload = {
  media_buy_id: 'mb_1',
  confirmed_at: '2026-01-01T00:00:00Z',
  revision: 1,
  packages: [],
};
const _updateMediaBuyPayload: UpdateMediaBuyPayload = { media_buy_id: 'mb_1', revision: 1 };

const _legacyServer = createLegacyAdcpServer({
  name: 'packed-adopter',
  version: '1.0.0',
  mediaBuy: {
    getProducts: async () => ({ products: [], cache_scope: 'account' }),
    createMediaBuy: async () => _createMediaBuyPayload,
    getMediaBuys: async () => ({ media_buys: [] }),
    getMediaBuyDelivery: async () => ({
      reporting_period: { start: '2026-01-01', end: '2026-01-31' },
      media_buy_deliveries: [],
    }),
  },
});
void _legacyServer;

const _sales: SalesCorePlatform & SalesIngestionPlatform = {
  getProducts: async () => ({ products: [], cache_scope: 'account' }),
  createMediaBuy: async () => _createMediaBuyPayload,
  updateMediaBuy: async () => _updateMediaBuyPayload,
  getMediaBuys: async () => ({ media_buys: [] }),
  getMediaBuyDelivery: async () => ({
    reporting_period: { start: '2026-01-01', end: '2026-01-31' },
    media_buy_deliveries: [],
  }),
  syncCreatives: async () => [],
};
void _sales;

const _salesWithHandoff: SalesCorePlatform & SalesIngestionPlatform = {
  getProducts: async () => ({ products: [], cache_scope: 'account' }),
  createMediaBuy: async (_req, ctx) =>
    ctx.handoffToTask(async () => _createMediaBuyPayload),
  updateMediaBuy: async () => _updateMediaBuyPayload,
  getMediaBuys: async () => ({ media_buys: [] }),
  getMediaBuyDelivery: async () => ({
    reporting_period: { start: '2026-01-01', end: '2026-01-31' },
    media_buy_deliveries: [],
  }),
  syncCreatives: async (_creatives, ctx) => ctx.handoffToTask(async () => []),
};
void _salesWithHandoff;

type Ok<T> = { ok: true; value: T };
type Err<E> = { ok: false; error: E };
type Result<T, E> = Ok<T> | Err<E>;
const ok = <T,>(value: T): Result<T, Error> => ({ ok: true, value });
const creativeManifest = {} as CreativeManifest;
const rightsTerms = {} as RightsTerms;

// Issue #1988: adopter helper layers often wrap handler payloads in their
// own Result<T, E>. They need named payload types that do not require the
// protocol task envelope (status, timestamp, context_id, etc.).
const _payloadResults: [
  Result<GetProductsPayload, Error>,
  Result<LegacyListCreativeFormatsPayload, Error>,
  Result<CreateMediaBuyPayload, Error>,
  Result<UpdateMediaBuyPayload, Error>,
  Result<SyncCreativesPayload, Error>,
  Result<SyncEventSourcesPayload, Error>,
  Result<ListAccountsPayload, Error>,
  Result<GetMediaBuysPayload, Error>,
  Result<GetMediaBuyDeliveryPayload, Error>,
  Result<LegacyBuildCreativePayload, Error>,
  Result<LegacyBuildCreativeMultiPayload, Error>,
  Result<LegacyBuildCreativeVariantPayload, Error>,
  Result<SyncAudiencesPayload, Error>,
  Result<ActivateSignalPayload, Error>,
  Result<GetBrandIdentityPayload, Error>,
  Result<LegacyGetRightsPayload, Error>,
  Result<LegacyUpdateRightsPayload, Error>,
  Result<CreativeApprovedPayload, Error>,
  Result<CreateMediaBuyHandlerResult, Error>,
  Result<SyncCreativesHandlerResult, Error>,
] = [
  ok({ products: [], cache_scope: 'account' }),
  ok({ formats: [] }),
  ok(_createMediaBuyPayload),
  ok(_updateMediaBuyPayload),
  ok({ creatives: [] }),
  ok({ event_sources: [] }),
  ok({ accounts: [] }),
  ok({ media_buys: [] }),
  ok({
    reporting_period: { start: '2026-01-01', end: '2026-01-31' },
    media_buy_deliveries: [],
  }),
  ok({ creative_manifest: creativeManifest }),
  ok({ creative_manifests: [] }),
  ok({ creatives: [] } satisfies BuildCreativeVariantSuccess),
  ok({ audiences: [] }),
  ok({ deployments: [] }),
  ok({ brand_id: 'brand_1', house: { domain: 'acme.com', name: 'Acme' }, names: [{ en: 'Acme' }] }),
  ok({ rights: [] }),
  ok({
    rights_id: 'rights_1',
    terms: rightsTerms,
    generation_credentials: [],
    rights_constraint: {} as LegacyUpdateRightsPayload['rights_constraint'],
    implementation_date: null,
  }),
  ok({ approval_status: 'approved', rights_id: 'rights_1' }),
  ok(_createMediaBuyPayload),
  ok([]),
];
void _payloadResults;

const _nativePostalArea: PostalArea = { country: 'US', system: 'zip', values: ['10001'] };
const _legacyNamedNativePostalArea: PostalArea1 = _nativePostalArea;
// @ts-expect-error Native postal targeting requires at least one value.
const _emptyNativePostalArea: PostalArea = { country: 'US', system: 'zip', values: [] };
void _legacyNamedNativePostalArea;
void _emptyNativePostalArea;

type PackedCreativeApproval = NonNullable<
  GetMediaBuysPayload['media_buys'][number]['packages'][number]['creative_approvals']
>[number];
const _packedCreativeApproval: PackedCreativeApproval = {
  creative_id: 'creative-1',
  approval_status: 'approved',
  rejection_reason: 'not used for approved creatives',
  approval_scopes: [],
  indicator_types_evaluated: ['creative_fatigue'],
  indicators: [],
  indicators_as_of: '2026-08-20T00:00:00Z',
  indicators_evaluated_scope: [],
};
void _packedCreativeApproval;

const _accountHandlerResults: [
  ListAccountsHandlerResult,
  SyncAccountsHandlerResult,
  SyncGovernanceHandlerResult,
  Result<ReportUsageHandlerResult, Error>,
  Result<GetAccountFinancialsHandlerResult, Error>,
] = [{ items: [] }, [], [], ok({ accepted: 0 }), ok({} as GetAccountFinancialsHandlerResult)];
void _accountHandlerResults;

const _safeListAccountsPayload: ListAccountsPayload = {
  accounts: [
    {
      account_id: 'acct_1',
      name: 'Acme',
      status: 'active',
      billing_entity: { legal_name: 'Acme Inc.' },
      notification_configs: [
        {
          subscriber_id: 'buyer-primary',
          url: 'https://hooks.test/notify',
          event_types: [],
          authentication: { schemes: ['Bearer'] },
        },
      ],
    },
  ],
};
const _safeNotificationAuth = _safeListAccountsPayload.accounts[0]?.notification_configs?.[0]?.authentication;
if (_safeNotificationAuth) {
  // @ts-expect-error response payload aliases must not expose write-only webhook credentials
  void _safeNotificationAuth.credentials;
}
const _safeBillingEntity = _safeListAccountsPayload.accounts[0]?.billing_entity;
if (_safeBillingEntity) {
  // @ts-expect-error response payload aliases must not expose write-only bank coordinates
  void _safeBillingEntity.bank;
}

interface OpsCtx extends OperationalContext {
  advertiserId: string;
}

const _ops: OperationalPlatform<OpsCtx> = defineOperationalPlatform<OpsCtx>({
  platformId: 'packed-adopter',
  extractContext: async () => ({ accessToken: undefined, advertiserId: 'adv_1' }),
  updateMediaBuy: async () => _updateMediaBuyPayload,
  getMediaBuyDelivery: async () => ({
    reporting_period: { start: '2026-01-01', end: '2026-01-31' },
    media_buy_deliveries: [],
  }),
  getProducts: async () => ({ products: [], cache_scope: 'account' }),
});
void _ops;

const _checkGovernancePayload: CheckGovernancePayload = {
  check_id: 'check_1',
  verdict: 'approved',
  plan_id: 'plan_1',
  explanation: 'Approved',
  governance_context: 'gc_123',
};
const _propertyListPayload: CreatePropertyListPayload = {
  list: { list_id: 'list_1', name: 'Test list' },
  auth_token: 'token_1',
};
const _contentStandardsPayload: LegacyListContentStandardsPayload = { standards: [] };
const _siPayload: SIGetOfferingPayload = { available: true };
void _checkGovernancePayload;
void _propertyListPayload;
void _contentStandardsPayload;
void _siPayload;

const _serverPayload: ServerPayload<CreateMediaBuySuccess> = {
  media_buy_id: 'mb_1',
  confirmed_at: '2026-01-01T00:00:00Z',
  revision: 1,
  packages: [],
  media_buy_status: 'active',
};
const _typesPayload: ServerPayloadFromTypes<CreateMediaBuySuccess> = _serverPayload;
void _typesPayload;
const _rootPayloadAlias: RootCreateMediaBuyPayload = _serverPayload;
const _typesPayloadAlias: TypesCreateMediaBuyPayload = _rootPayloadAlias;
const _rootGetProductsPayload: RootGetProductsPayload = { products: [], cache_scope: 'account' };
const _typesGetProductsPayload = { products: [], cache_scope: 'account' } satisfies TypesGetProductsPayload;
const _rootUpdatePayload: RootUpdateMediaBuyPayload = _updateMediaBuyPayload;
const _typesUpdatePayload: TypesUpdateMediaBuyPayload = _rootUpdatePayload;
const _slaWindow: SLAWindow = { response_max: 'PT1H', completion_max: 'P1D' };
const _legacySlaWindow: SlaWindow = _slaWindow;
const _availableAction: MediaBuyAvailableAction = {
  action: 'pause',
  mode: 'self_serve',
  sla: _legacySlaWindow,
};
void _typesPayloadAlias;
void _typesGetProductsPayload;
void _typesUpdatePayload;
void _availableAction;
// @ts-expect-error named payload aliases must not expose SDK-owned protocol envelope fields
void _rootPayloadAlias.task_id;

// Issue #2573: generated named interfaces must remain compatible with
// standard utility types and structurally equivalent adopter declarations.
// Runtime validation stays open to future wire fields; the exported named
// TypeScript surface must not acquire a catch-all index signature as a side
// effect. Explicit extension maps remain indexable by design.
type _BriefWithoutName = Omit<CreativeBrief, 'name'>;
declare const _briefWithoutName: _BriefWithoutName;
const _omittedBriefHeadline: string | undefined = _briefWithoutName.messaging?.headline;

type _BriefMessaging = Pick<CreativeBrief, 'messaging'>;
declare const _briefMessaging: _BriefMessaging;
const _pickedBriefHeadline: string | undefined = _briefMessaging.messaging?.headline;

interface _AdopterCreativeBrief {
  name: string;
  messaging?: {
    headline?: string;
  };
}
declare const _adopterCreativeBrief: _AdopterCreativeBrief;
const _structurallyAssignedBrief: CreativeBrief = _adopterCreativeBrief;

// Nested inline shapes must be just as source-compatible as named top-level
// interfaces. Both sides of this assignment are exported by the SDK: the
// projection helper produces ProductCardFields, while LegacyProduct embeds
// the corresponding wire shape inline.
declare const _helperProductCard: ProductCardFields;
const _generatedProductCard: NonNullable<LegacyProduct['product_card']> = _helperProductCard;
const _helperProductCardReverse: ProductCardFields = _generatedProductCard;
type _ProductCardWithoutDescription = Omit<NonNullable<LegacyProduct['product_card']>, 'description'>;
const _productCardWithoutDescription: _ProductCardWithoutDescription = _helperProductCard;
declare const _helperProductCardDetailed: ProductCardDetailedFields;
const _generatedProductCardDetailed: NonNullable<LegacyProduct['product_card_detailed']> = _helperProductCardDetailed;
const _helperProductCardDetailedReverse: ProductCardDetailedFields = _generatedProductCardDetailed;
type _LegacyResponseProduct = NonNullable<LegacyGetProductsResponse['products']>[number];
const _legacyResponseProductCard: NonNullable<_LegacyResponseProduct['product_card']> = _helperProductCard;

const _extensionMap: ExtensionObject = { vendor: { feature: true } };
const _extensionValue: unknown = _extensionMap.vendor;
void _omittedBriefHeadline;
void _pickedBriefHeadline;
void _structurallyAssignedBrief;
void _generatedProductCard;
void _helperProductCardReverse;
void _productCardWithoutDescription;
void _generatedProductCardDetailed;
void _helperProductCardDetailedReverse;
void _legacyResponseProductCard;
void _extensionValue;

type _HasNoStringIndex<T> = string extends keyof T ? false : true;
const _exactPackageFlowTypes: [
  _HasNoStringIndex<SelectedPlacements>,
  _HasNoStringIndex<ExplicitPackagesWithFixedAllocation>,
  _HasNoStringIndex<CommercialTerms>,
  _HasNoStringIndex<ProductFormatDeclaration>,
  _HasNoStringIndex<Placement>,
  _HasNoStringIndex<AudienceCharacteristic>,
] = [true, true, true, true, true, true];
void _exactPackageFlowTypes;

type _LegacyGeneratedAliases =
  | BrandReference1 | BrandReference2 | BrandReference3 | BrandReference4 | BrandReference5 | BrandReference6
  | BrandReference7 | BrandReference8 | BrandReference9 | BrandReference10 | BrandReference11 | BrandReference12
  | BusinessEntity1 | MeasurementTerms1 | None1 | None2 | PlatformExtensionReference1 | Product1 | Property1;
declare const _legacyGeneratedAlias: _LegacyGeneratedAliases;
void _legacyGeneratedAlias;

declare const _historicalToolExports: [
  AdCPVersionEnvelope,
  ToolCanonicalFormatBase,
  PostalCountrySystem,
  ProtocolEnvelope,
  SignalDefinitionEnrichment,
  SignalTargetingExpression,
];
void _historicalToolExports;

const _legacyGeneratedSchemaAliases = [
  publicSchemas.BrandReference1Schema, publicSchemas.BrandReference2Schema, publicSchemas.BrandReference3Schema,
  publicSchemas.BrandReference4Schema, publicSchemas.BrandReference5Schema, publicSchemas.BrandReference6Schema,
  publicSchemas.BrandReference7Schema, publicSchemas.BrandReference8Schema, publicSchemas.BrandReference9Schema,
  publicSchemas.BrandReference10Schema, publicSchemas.BrandReference11Schema, publicSchemas.BrandReference12Schema,
  publicSchemas.BusinessEntity1Schema, publicSchemas.MeasurementTerms1Schema, publicSchemas.None1Schema,
  publicSchemas.None2Schema, publicSchemas.PlatformExtensionReference1Schema, publicSchemas.Product1Schema,
  publicSchemas.Property1Schema,
];
void _legacyGeneratedSchemaAliases;

// Canonical format overlays refine the base declaration with defaults and
// format-specific fields. Their slots property must remain assignable from
// the shared array contract rather than being widened to a record by codegen.
const _canonicalSlots = [
  { asset_group_id: 'audio_main', asset_type: 'audio' as const, required: true },
] satisfies NonNullable<CanonicalFormatBase['slots']>;
const _canonicalSlotAssignments: [
  Pick<CanonicalFormatDisplayTag, 'slots'>,
  Pick<CanonicalFormatImageCarousel, 'slots'>,
  Pick<CanonicalFormatHostedVideo, 'slots'>,
  Pick<CanonicalFormatVASTVideo, 'slots'>,
  Pick<CanonicalFormatHostedAudio, 'slots'>,
  Pick<CanonicalFormatDAASTAudio, 'slots'>,
  Pick<CanonicalFormatSponsoredPlacementRetailMediaCatalogDriven, 'slots'>,
  Pick<CanonicalFormatNativeInFeed, 'slots'>,
  Pick<CanonicalFormatResponsiveCreative, 'slots'>,
  Pick<CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement, 'slots'>,
  Pick<CanonicalFormatHTML5Banner, 'slots'>,
] = [
  { slots: _canonicalSlots },
  { slots: _canonicalSlots },
  { slots: _canonicalSlots },
  { slots: _canonicalSlots },
  { slots: _canonicalSlots },
  { slots: _canonicalSlots },
  { slots: _canonicalSlots },
  { slots: _canonicalSlots },
  { slots: _canonicalSlots },
  { slots: _canonicalSlots },
  { slots: _canonicalSlots },
];
void _canonicalSlotAssignments;

const _canonicalResolver = createSubpathCanonicalReferenceResolver();
const _formatSchemaResult = null as unknown as FormatSchemaReferenceResult;
if (_formatSchemaResult.ok) {
  const schemaDraft: 'draft-07' | '2020-12' = _formatSchemaResult.schemaMeta.draft;
  void schemaDraft;
} else {
  const retryable: boolean = _formatSchemaResult.error.retryable;
  void retryable;
}
void _canonicalResolver.resolvePlatformExtensions({
  uri: 'https://publisher.example-ad.com/extensions.json',
  digest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
});

// @ts-expect-error ServerPayload must preserve required domain fields.
const _missingRequiredDomainField: ServerPayload<CreateMediaBuySuccess> = { packages: [] };
void _missingRequiredDomainField;

void TOOL_REQUEST_SCHEMAS.get_products.shape.brief;
void TOOL_REQUEST_SCHEMAS.create_media_buy.shape.account;
// @ts-expect-error known tool request schemas should reject bogus fields
void TOOL_REQUEST_SCHEMAS.create_media_buy.shape.not_a_real_field;
void TOOL_REQUEST_SCHEMAS.preview_creative.shape.request_type;
const previewRequestType: 'single' | 'batch' | 'variant' =
  TOOL_REQUEST_SCHEMAS.preview_creative.shape.request_type.parse('single');
void previewRequestType;
// @ts-expect-error TS7056 object annotations should keep known request fields exact
void TOOL_REQUEST_SCHEMAS.preview_creative.shape.not_a_real_field;
void TOOL_INPUT_SHAPES.creative_approval.rights_id;
void TOOL_INPUT_SHAPES.update_media_buy.media_buy_id;
// @ts-expect-error update_media_buy input shape should reject bogus fields
void TOOL_INPUT_SHAPES.update_media_buy.not_a_real_field;
void TOOL_INPUT_SHAPES.search_brands.query;
void TOOL_INPUT_SHAPES.verify_brand_claims.claims;
void TOOL_INPUT_SCHEMAS.verify_brand_claim.parse;

function assertOptionalAccountReference(account: AccountReference | undefined): void {
  if (account && 'account_id' in account) {
    const accountId: string = account.account_id;
    void accountId;
  }
}

customToolFor('creative_approval', 'Submit creative for approval', TOOL_INPUT_SHAPES.creative_approval, async args => {
  const rightsId: string = args.rights_id;
  void rightsId;
  // @ts-expect-error unknown creative approval fields should not type-check
  void args.not_a_real_field;
});

customToolFor('create_media_buy', 'Create a media buy', TOOL_INPUT_SHAPES.create_media_buy, async args => {
  assertOptionalAccountReference(args.account);
});

customToolFor('update_media_buy', 'Update a media buy', TOOL_INPUT_SHAPES.update_media_buy, async args => {
  const mediaBuyId: string = args.media_buy_id;
  void mediaBuyId;
  assertOptionalAccountReference(args.account);
  // @ts-expect-error customToolFor handler args should reject bogus update fields
  void args.not_a_real_field;
});

customToolFor('preview_creative', 'Preview a creative', TOOL_INPUT_SHAPES.preview_creative, async args => {
  const requestType: 'single' | 'batch' | 'variant' = args.request_type;
  void requestType;
});

customToolFor('search_brands', 'Search brands', TOOL_INPUT_SHAPES.search_brands, async args => {
  const query: string = args.query;
  void query;
});

customToolFor('verify_brand_claims', 'Verify brand claims', TOOL_INPUT_SHAPES.verify_brand_claims, async args => {
  const firstClaim = args.claims[0];
  if (firstClaim) {
    const claimType: 'subsidiary' | 'parent' | 'property' | 'trademark' = firstClaim.claim_type;
    void claimType;
  }
});

customToolForSchema('verify_brand_claim', 'Verify a brand claim', TOOL_INPUT_SCHEMAS.verify_brand_claim, async args => {
  if (args.claim_type === 'subsidiary') {
    const domain: string = args.claim.subsidiary_domain;
    void domain;
  }
  // @ts-expect-error passthrough allows extra keys as unknown, not as typed sibling-variant fields
  const parentDomain: string = args.claim.parent_domain;
  void parentDomain;
});

declare const runtimeToolName: string;
void TOOL_INPUT_SHAPES[runtimeToolName];
void TOOL_INPUT_SCHEMAS[runtimeToolName]?.parse;
void TOOL_REQUEST_SCHEMAS[runtimeToolName]?.shape;

// @ts-expect-error unknown tool names are not valid customToolFor shapes without narrowing
customToolFor('creative_approval', 'x', TOOL_INPUT_SHAPES.typo_tool, async args => args);

// @ts-expect-error verify_brand_claim is union-shaped, so callers must use customToolForSchema
customToolFor('verify_brand_claim', 'x', TOOL_INPUT_SHAPES.verify_brand_claim, async args => args);

// @ts-expect-error unknown fields should not type-check
void TOOL_INPUT_SHAPES.creative_approval.not_a_real_field;
`;

function run(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): void {
  execFileSync(cmd, args, { cwd, stdio: 'inherit', env: env ?? process.env });
}

function main(): void {
  console.log('[adopter-types] packing SDK...');
  const tarballDir = mkdtempSync(join(tmpdir(), 'adcp-adopter-pack-'));
  run('npm', ['pack', '--pack-destination', tarballDir, '--silent'], REPO_ROOT);
  const tarball = readdirSync(tarballDir).find(f => f.endsWith('.tgz'));
  if (!tarball) throw new Error('npm pack did not produce a tarball');
  const tarballPath = join(tarballDir, tarball);

  console.log('[adopter-types] scaffolding adopter project...');
  const adopterDir = mkdtempSync(join(tmpdir(), 'adcp-adopter-check-'));
  writeFileSync(
    join(adopterDir, 'package.json'),
    JSON.stringify({ name: 'adopter-types-check', version: '0.0.0', private: true })
  );
  writeFileSync(join(adopterDir, 'tsconfig.json'), JSON.stringify(ADOPTER_TSCONFIG, null, 2));
  writeFileSync(join(adopterDir, 'tsconfig.declaration.json'), JSON.stringify(DECLARATION_TSCONFIG, null, 2));
  writeFileSync(join(adopterDir, 'adopter.ts'), ADOPTER_SOURCE);
  writeFileSync(join(adopterDir, 'adopter-declaration.ts'), DECLARATION_SOURCE);

  // @types/express, @opentelemetry/api, and redis cover transitive type
  // references from the server bundle — adopters who import
  // `@adcp/sdk/server` need these (express is the HTTP adapter,
  // opentelemetry is the optional observability peer, redis is the
  // optional peer for the Redis backends). Installing them here scopes
  // this guard to detection of `@internal`-leak class bugs (issue #1236)
  // without flagging the orthogonal "transitive types not auto-installed"
  // class, which is tracked separately.
  //
  // Why `redis` here when `pg` is NOT installed: the pg backends type
  // their public surface via the project-local `PgQueryable` shape (no
  // `import type` from `pg`), so the published `.d.ts` has no `pg`
  // reference. The Redis backends deliberately type their public surface
  // as `RedisClientType<any,any,any> | <NarrowInterface>` so node-redis
  // users pass `createClient(...)` without casts — that DX win requires
  // the adopter type-checker to be able to resolve `redis`. We install
  // it here for the same reason we install `@types/express`: the adopter
  // using these backends will have it, and the check exists to validate
  // the adopter experience, not to enforce zero-peer-dep types.
  console.log('[adopter-types] installing tarball + adopter peers...');
  run(
    'npm',
    [
      'install',
      '--no-audit',
      '--no-fund',
      '--silent',
      tarballPath,
      'typescript',
      '@types/node',
      '@types/express',
      '@opentelemetry/api',
      'redis',
    ],
    adopterDir
  );

  console.log('[adopter-types] running tsc --noEmit against published types...');
  const tscEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--max-old-space-size=${TSC_HEAP_MB}`].filter(Boolean).join(' '),
  };
  try {
    run('npx', ['--no-install', 'tsc', '--noEmit'], adopterDir, tscEnv);
    console.log('[adopter-types] PASS — published .d.ts files type-check cleanly for an adopter.');

    console.log('[adopter-types] emitting declarations for composed public schemas...');
    run('npx', ['--no-install', 'tsc', '-p', 'tsconfig.declaration.json'], adopterDir, tscEnv);
    const declaration = readFileSync(join(adopterDir, 'declarations', 'adopter-declaration.d.ts'), 'utf8');
    if (/dist\/lib\/types\/[^'"\s]*generated/.test(declaration)) {
      throw new Error('Composed public schema declaration references SDK-private generated modules.');
    }
    if (!declaration.includes('SavedProductSchema') || !declaration.includes('LocalGetProductsSchema')) {
      throw new Error('Composed public schema declarations were not emitted.');
    }
    console.log('[adopter-types] PASS — composed schema declarations are portable.');
  } catch {
    console.error('[adopter-types] FAIL — published .d.ts files do not type-check on a clean adopter project.');
    console.error(`  Scaffold preserved at: ${adopterDir}`);
    console.error(`  Reproduce: cd ${adopterDir} && npx tsc --noEmit`);
    process.exit(1);
  }

  rmSync(tarballDir, { recursive: true, force: true });
  rmSync(adopterDir, { recursive: true, force: true });
}

main();
