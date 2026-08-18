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
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
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

const ADOPTER_SOURCE = `
// Mirrors the repro from issue #1236 and locks the server-side handler
// payload typing surface that adopters consume from a packed SDK tarball.
import type {
  AdcpServer,
  ActivateSignalPayload,
  LegacyBuildCreativePayload,
  LegacyBuildCreativeMultiPayload,
  CheckGovernancePayload,
  CreativeApprovedPayload,
  CreatePropertyListPayload,
  CreateMediaBuyPayload,
  CreateMediaBuyHandlerResult,
  GetMediaBuyDeliveryPayload,
  GetMediaBuysPayload,
  GetAccountFinancialsHandlerResult,
  GetBrandIdentityPayload,
  GetProductsPayload,
  LegacyGetRightsPayload,
  ListAccountsHandlerResult,
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
  SyncCreativesPayload,
  SyncCreativesHandlerResult,
  SyncEventSourcesPayload,
  SyncGovernanceHandlerResult,
  LegacyUpdateRightsPayload,
  UpdateMediaBuyPayload,
} from '@adcp/sdk/server';
import { createAdcpServerFromPlatform, defineOperationalPlatform } from '@adcp/sdk/server';
import { createAdcpServer as createLegacyAdcpServer } from '@adcp/sdk/server/legacy/v5';
import { createSingleAgentClient, extractAdcpErrorFromMcp, extractAdcpErrorFromTransport } from '@adcp/sdk';
import type {
  CreateMediaBuyPayload as TypesCreateMediaBuyPayload,
  CreateMediaBuySuccess,
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
  FormatSchemaReferenceResult,
  CreateMediaBuyPayload as RootCreateMediaBuyPayload,
  GetProductsPayload as RootGetProductsPayload,
  LegacyProduct,
  LegacyGetProductsResponse,
  MediaBuyAvailableAction,
  ProductCardFields,
  ProductCardDetailedFields,
  SLAWindow,
  SlaWindow,
  UpdateMediaBuyPayload as RootUpdateMediaBuyPayload,
} from '@adcp/sdk';
import type {
  AdCPVersionEnvelope,
  AudienceCharacteristic,
  CanonicalFormatBase as ToolCanonicalFormatBase,
  CommercialTerms,
  ExplicitPackagesWithFixedAllocation,
  Placement,
  PostalCountrySystem,
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
  Product1,
  Property1,
} from '@adcp/sdk/types/core.generated';
import { createCanonicalReferenceResolver as createSubpathCanonicalReferenceResolver } from '@adcp/sdk/canonical-references';
import { customToolFor, customToolForSchema, TOOL_INPUT_SCHEMAS, TOOL_INPUT_SHAPES, TOOL_REQUEST_SCHEMAS } from '@adcp/sdk/schemas';
import * as publicSchemas from '@adcp/sdk/schemas';

declare const _server: AdcpServer;
void _server;
void createSingleAgentClient;
void extractAdcpErrorFromMcp;
void extractAdcpErrorFromTransport;
void createAdcpServerFromPlatform;

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
  writeFileSync(join(adopterDir, 'adopter.ts'), ADOPTER_SOURCE);

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
