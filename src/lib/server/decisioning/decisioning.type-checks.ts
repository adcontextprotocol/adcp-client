/* eslint-disable @typescript-eslint/no-unused-vars */
// Type-only tests for the DecisioningPlatform v1.0 surface.
//
// Same pattern as `asset-instances.type-checks.ts`: each `// @ts-expect-error`
// claims the next line WILL fail typechecking. If TS stops flagging the
// expected error, the directive itself becomes an error and `tsc --noEmit`
// fails. That's the regression alarm.
//
// Status: Preview / 6.0.

import type {
  DecisioningPlatform,
  RequiredPlatformsFor,
  RequiredCapabilitiesFor,
  RequiredOptsFor,
  Account,
  AccountStore,
  DecisioningCapabilities,
  TargetingCapabilities,
  StatusMappers,
  CreativeBuilderPlatform,
  CreativeTemplatePlatform,
  SalesPlatform,
  SalesCorePlatform,
  SalesIngestionPlatform,
  ActivateSignalPayload,
  BuildCreativePayload,
  BuildCreativeMultiPayload,
  CreativeApprovedPayload,
  GetProductsPayload,
  CreateMediaBuyHandlerResult,
  CreateMediaBuyPayload,
  UpdateMediaBuyPayload,
  GetMediaBuyDeliveryPayload,
  GetMediaBuysPayload,
  GetAccountFinancialsHandlerResult,
  GetBrandIdentityPayload,
  GetRightsPayload,
  ListAccountsHandlerResult,
  ListCreativeFormatsPayload,
  ReportUsageHandlerResult,
  SyncAudiencesPayload,
  SyncAccountsHandlerResult,
  SyncCreativesPayload,
  SyncCreativesHandlerResult,
  SyncEventSourcesPayload,
  SyncGovernanceHandlerResult,
  ListAccountsPayload,
  RightsTerms,
  UpdateRightsPayload,
  SponsoredIntelligencePlatform,
  AudiencePlatform,
  CreateAdcpServerFromPlatformOptions,
  ComplianceTestingCapabilities,
  ServerPayload,
  CheckGovernancePayload,
} from './index';
import type { OperationalContext, OperationalPlatform } from '../operational-platform';
import {
  AdcpError,
  AccountNotFoundError,
  defineSalesPlatform,
  defineSalesCorePlatform,
  defineSalesIngestionPlatform,
  defineAudiencePlatform,
  definePlatformWithCompliance,
} from './index';
import type { ComplyControllerConfig } from '../../testing/comply-controller';

// ── AdcpError construction ────────────────────────────────────────────

function _adcp_error_minimum(): AdcpError {
  return new AdcpError('TERMS_REJECTED', {
    recovery: 'correctable',
    message: 'max_variance_percent below seller floor',
  });
}

function _adcp_error_full_fields(): AdcpError {
  return new AdcpError('INVALID_REQUEST', {
    recovery: 'correctable',
    message: 'targeting.geo[0] is not a known DMA',
    field: 'packages[0].targeting.geo[0]',
    suggestion: 'Use a 3-digit Nielsen DMA code',
    retry_after: undefined,
    details: { offending_value: 'XYZ' },
  });
}

function _adcp_error_accepts_unknown_code(): AdcpError {
  return new AdcpError('GAM_INTERNAL_QUOTA_EXCEEDED', {
    recovery: 'transient',
    message: 'GAM rate limit hit',
    retry_after: 60,
  });
}

function _adcp_error_recovery_optional_defaults_from_code(): AdcpError {
  // `recovery` is now optional — defaults to getErrorRecovery(code) for
  // standard codes (here: TERMS_REJECTED → 'correctable' per the spec).
  return new AdcpError('TERMS_REJECTED', { message: 'omitted recovery — spec default applies' });
}

// AdcpError is throwable from any specialism method.
async function _adcp_error_throw_pattern(): Promise<{ id: string }> {
  if (Math.random() > 0.5) {
    throw new AdcpError('BUDGET_TOO_LOW', { recovery: 'correctable', message: 'too low' });
  }
  return { id: 'mb_1' };
}

// ── RequiredPlatformsFor enforces specialism → interface mapping ─────

// Positive: claiming sales-non-guaranteed AND providing sales: SalesPlatform satisfies the constraint.
type _ok_sales_only = RequiredPlatformsFor<'sales-non-guaranteed'> extends { sales: SalesPlatform } ? true : false;
const _check_sales_only: _ok_sales_only = true;

// Positive: claiming creative-template AND providing creative: CreativeBuilderPlatform satisfies.
// (CreativeTemplatePlatform is a deprecated alias of CreativeBuilderPlatform — both
// resolve to the same shape; the alias check below confirms source compat.)
type _ok_creative_template =
  RequiredPlatformsFor<'creative-template'> extends {
    creative: CreativeBuilderPlatform;
  }
    ? true
    : false;
const _check_creative_template: _ok_creative_template = true;

// Positive: claiming creative-generative ALSO maps to CreativeBuilderPlatform
// (the merged interface). Both specialism IDs share the implementation surface.
type _ok_creative_generative =
  RequiredPlatformsFor<'creative-generative'> extends {
    creative: CreativeBuilderPlatform;
  }
    ? true
    : false;
const _check_creative_generative: _ok_creative_generative = true;

// Source compat: CreativeTemplatePlatform alias still resolves to
// CreativeBuilderPlatform — adopters who imported the deprecated name
// see the same shape until the alias is removed.
type _ok_template_alias = CreativeTemplatePlatform extends CreativeBuilderPlatform ? true : false;
const _check_template_alias: _ok_template_alias = true;

// Positive: claiming audience-sync AND providing audiences: AudiencePlatform satisfies.
type _ok_audience_sync = RequiredPlatformsFor<'audience-sync'> extends { audiences: AudiencePlatform } ? true : false;
const _check_audience_sync: _ok_audience_sync = true;

// Positive: claiming sponsored-intelligence requires the SI platform interface.
type _ok_sponsored_intelligence =
  RequiredPlatformsFor<'sponsored-intelligence'> extends {
    sponsoredIntelligence: SponsoredIntelligencePlatform;
  }
    ? true
    : false;
const _check_sponsored_intelligence: _ok_sponsored_intelligence = true;

// Negative: misspelled specialism MUST fail compile. Without the
// `S extends AdCPSpecialism` constraint, a typo like `'sales-non-guarenteed'`
// would silently fall through to a permissive constraint and only fail
// at runtime in `validatePlatform()`. The constraint surfaces the typo
// at the use site.
function _required_platforms_rejects_typo() {
  // @ts-expect-error — 'sales-non-guarenteed' is not a known AdCPSpecialism (typo for 'sales-non-guaranteed').
  type _typo = RequiredPlatformsFor<'sales-non-guarenteed'>;
}

// ── RequiredCapabilitiesFor enforces specialism → capability-block mapping ──

// Positive: claiming brand-rights requires capabilities.brand block.
type _ok_brand_rights_requires_brand =
  RequiredCapabilitiesFor<'brand-rights'> extends { capabilities: { brand: unknown } } ? true : false;
const _check_brand_rights_requires_brand: _ok_brand_rights_requires_brand = true;

// Negative: specialisms NOT in the required-cap mapping return `{}` —
// no extra constraint, no required capability blocks.
type _ok_sales_no_required_caps =
  Record<string, never> extends RequiredCapabilitiesFor<'sales-non-guaranteed'> ? true : false;
const _check_sales_no_required_caps: _ok_sales_no_required_caps = true;

// ── Account is generic over TCtxMeta ─────────────────────────────────────

interface GAMAccountMeta {
  networkId: string;
  advertiserId: string;
}

function _account_with_typed_meta(account: Account<GAMAccountMeta>): string {
  return account.ctx_metadata.networkId;
}

function _account_typed_meta_rejects_wrong_field(account: Account<GAMAccountMeta>): string {
  // @ts-expect-error — `googleAdvertiserId` doesn't exist on GAMAccountMeta.
  return account.ctx_metadata.googleAdvertiserId;
}

// ── refreshToken hook receives Account<TCtxMeta> typed (#1168) ───────────

// Adopter declares an AccountStore for their typed metadata. The
// `refreshToken` hook signature inherits TCtxMeta so the hook reads
// adopter-typed fields off `account.ctx_metadata` without casts.
function _refresh_token_typed_meta(): NonNullable<AccountStore<GAMAccountMeta>['refreshToken']> {
  return async (account, _reason) => {
    // Compile-time assertion: account.ctx_metadata.networkId is reachable.
    const networkId: string = account.ctx_metadata.networkId;
    return { token: `refreshed_for_${networkId}` };
  };
}

function _refresh_token_typed_meta_rejects_wrong_field(): NonNullable<AccountStore<GAMAccountMeta>['refreshToken']> {
  return async (account, _reason) => {
    // @ts-expect-error — `googleAdvertiserId` doesn't exist on GAMAccountMeta.
    return { token: `refreshed_for_${account.ctx_metadata.googleAdvertiserId}` };
  };
}

// ── AccountNotFoundError is a class adopters can throw from resolve() ─

function _account_not_found_throw_pattern(): Promise<Account<GAMAccountMeta> | null> {
  // Adopters who prefer throw-based error flow over null returns can throw
  // this; framework catches and emits ACCOUNT_NOT_FOUND.
  throw new AccountNotFoundError();
}

// ── AccountStore.resolution is 'explicit' | 'implicit' (or absent) ────

function _account_store_resolution_implicit(): Pick<AccountStore<GAMAccountMeta>, 'resolution'> {
  return { resolution: 'implicit' };
}

function _account_store_resolution_derived(): Pick<AccountStore<GAMAccountMeta>, 'resolution'> {
  return { resolution: 'derived' };
}

function _account_store_resolution_invalid_value(): Pick<AccountStore<GAMAccountMeta>, 'resolution'> {
  // @ts-expect-error — only 'explicit' | 'implicit' | 'derived' allowed.
  return { resolution: 'auto' };
}

// ── Signals-only platforms omit media-buy fields ─────────────────────

// Positive: a signals-only platform doesn't need creative_agents, channels,
// or pricingModels — those fields are optional and inapplicable to platforms
// that sell audience data access rather than media inventory.
function _signals_only_capabilities_compiles(): DecisioningCapabilities {
  return {
    specialisms: ['signal-marketplace'] as const,
    config: {},
  };
}

// Negative: channels rejects values outside the MediaChannel union.
function _channels_rejects_unknown_channel(): Pick<DecisioningCapabilities, 'channels'> {
  // @ts-expect-error — 'billboard' is not a known MediaChannel value.
  return { channels: ['billboard'] as const };
}

// Negative: pricingModels rejects values outside the PricingModel union.
function _pricing_models_rejects_unknown_model(): Pick<DecisioningCapabilities, 'pricingModels'> {
  // @ts-expect-error — 'rev_share' is not a known PricingModel value.
  return { pricingModels: ['rev_share'] as const };
}

// ── DecisioningCapabilities.supportedBillings is a closed enum ────────

function _capabilities_supported_billings_operator(): Pick<DecisioningCapabilities, 'supportedBillings'> {
  return { supportedBillings: ['operator'] as const };
}

function _capabilities_supported_billings_advertiser(): Pick<DecisioningCapabilities, 'supportedBillings'> {
  return { supportedBillings: ['advertiser'] as const };
}

function _capabilities_supported_billings_invalid(): Pick<DecisioningCapabilities, 'supportedBillings'> {
  // @ts-expect-error — only 'operator' | 'agent' | 'advertiser' allowed.
  return { supportedBillings: ['publisher'] as const };
}

// ── TargetingCapabilities — nested geo systems compile cleanly ────────

function _targeting_capabilities_nested(): TargetingCapabilities {
  return {
    geo_countries: true,
    geo_metros: { nielsen_dma: true, eurostat_nuts2: true },
    geo_postal_areas: { us_zip: true, gb_outward: true },
    keyword_targets: { supported_match_types: ['broad', 'exact'] as const },
    age_restriction: {
      supported: true,
      verification_methods: ['credit_card', 'id_document'] as const,
    },
  };
}

function _targeting_capabilities_rejects_unknown_geo_metro(): TargetingCapabilities {
  return {
    // @ts-expect-error — 'made_up_geo_system' is not a known metro identifier.
    geo_metros: { made_up_geo_system: true },
  };
}

// ── ErrorCode covers the 45 spec codes (sample the new ones) ──────────

function _new_codes_compile(): AdcpError[] {
  // These codes weren't in the v1.0 scaffold pre-must-fixes; verify they
  // remain valid `code` values on AdcpError after the round-5 refactor.
  return [
    new AdcpError('INVALID_STATE', { recovery: 'correctable', message: '' }),
    new AdcpError('MEDIA_BUY_NOT_FOUND', { recovery: 'terminal', message: '' }),
    new AdcpError('NOT_CANCELLABLE', { recovery: 'terminal', message: '' }),
    new AdcpError('REQUOTE_REQUIRED', { recovery: 'correctable', message: '' }),
    new AdcpError('CREATIVE_DEADLINE_EXCEEDED', { recovery: 'terminal', message: '' }),
  ];
}

// ── RequiredPlatformsFor surfaces a legible "missing field" error ─────

interface _PlatformWithoutSales {
  capabilities: { specialisms: ['sales-non-guaranteed'] };
  // Note: no `sales` field.
}

// Negative: the conditional should resolve to `{ sales: SalesPlatform }` when
// the specialism is `sales-non-guaranteed`. A platform missing `sales`
// fails to satisfy the requirement — error reads "Property 'sales' is missing"
// rather than the unactionable "does not satisfy constraint 'never'".
type _missing_sales_required =
  RequiredPlatformsFor<'sales-non-guaranteed'> extends infer R ? (R extends { sales: unknown } ? true : false) : false;
const _check_sales_required: _missing_sales_required = true;

// ── Platform identity helpers — defineSalesPlatform / defineAudiencePlatform ─

interface _SocialMeta {
  advertiserId: string;
  pixelId: string;
}

// Positive: defineSalesPlatform<TCtxMeta> is pure identity — input type equals output type.
function _define_sales_platform_identity(p: SalesPlatform<_SocialMeta>): SalesPlatform<_SocialMeta> {
  return defineSalesPlatform<_SocialMeta>(p);
}

// ── #1341 sales-guaranteed migration paths ──────────────────────────
// `SalesPlatform` methods are now optional individually (#1341). Adopters
// claiming a `RequiredPlatformsFor<'sales-guaranteed'>`-narrowed
// specialism need to keep the closed shape on the way to the
// dispatcher. Two patterns work; both are exercised below as
// regression locks.

const _createBuyPayload = () => ({
  media_buy_id: 'x',
  confirmed_at: '2026-01-01T00:00:00Z',
  revision: 1,
  packages: [],
});
const _updateBuyPayload = () => ({ media_buy_id: 'x', revision: 1 });

// Pattern A — explicit field annotation. The contextual type from the
// `: SalesCorePlatform<Meta> & SalesIngestionPlatform<Meta>` annotation
// flows into the literal; the closed shape is enforced at the
// assignment site.
function _sales_guaranteed_field_annotation_pattern() {
  const sales: SalesCorePlatform<_SocialMeta> & SalesIngestionPlatform<_SocialMeta> = {
    getProducts: async () => ({ status: 'completed' as const, products: [], cache_scope: 'public' as const }),
    createMediaBuy: async () => _createBuyPayload(),
    updateMediaBuy: async () => _updateBuyPayload(),
    getMediaBuyDelivery: async () => ({
      status: 'completed' as const,
      reporting_period: { start: '2026-01-01', end: '2026-01-31' },
      media_buy_deliveries: [],
    }),
    getMediaBuys: async () => ({ status: 'completed' as const, media_buys: [] }),
    syncCreatives: async () => [],
  };
  type _SalesGuaranteedShape = (RequiredPlatformsFor<'sales-guaranteed'> & {
    sales: unknown;
  })['sales'];
  const _check: _SalesGuaranteedShape = sales;
  return _check;
}

// Pattern B — spread-helpers. `defineSalesCorePlatform` / `defineSales-
// IngestionPlatform` each return their closed shape; the spread carries
// both onto a single `sales` object. Useful when the adopter's class
// structure splits core from ingestion.
function _sales_guaranteed_spread_helpers_pattern() {
  const sales = {
    ...defineSalesCorePlatform<_SocialMeta>({
      getProducts: async () => ({ status: 'completed' as const, products: [], cache_scope: 'public' as const }),
      createMediaBuy: async () => _createBuyPayload(),
      updateMediaBuy: async () => _updateBuyPayload(),
      getMediaBuyDelivery: async () => ({
        status: 'completed' as const,
        reporting_period: { start: '2026-01-01', end: '2026-01-31' },
        media_buy_deliveries: [],
      }),
      getMediaBuys: async () => ({ status: 'completed' as const, media_buys: [] }),
    }),
    ...defineSalesIngestionPlatform<_SocialMeta>({
      syncCreatives: async () => [],
    }),
  };
  type _SalesGuaranteedShape = (RequiredPlatformsFor<'sales-guaranteed'> & {
    sales: unknown;
  })['sales'];
  const _check: _SalesGuaranteedShape = sales;
  return _check;
}

// Positive: platform handlers return domain payloads. The framework owns
// protocol envelope fields such as `status: "completed"`, `timestamp`, and
// `adcp_version`, so these payload returns must compile without status.
function _sales_platform_payload_returns_do_not_require_protocol_status() {
  const sales: SalesCorePlatform<_SocialMeta> & SalesIngestionPlatform<_SocialMeta> = {
    getProducts: async () => ({ products: [], cache_scope: 'account' }),
    createMediaBuy: async () => _createBuyPayload(),
    updateMediaBuy: async () => _updateBuyPayload(),
    getMediaBuyDelivery: async () => ({
      reporting_period: { start: '2026-01-01', end: '2026-01-31' },
      media_buy_deliveries: [],
    }),
    getMediaBuys: async () => ({ media_buys: [] }),
    listCreativeFormats: async () => ({ formats: [] }),
    syncCreatives: async () => [],
  };
  return sales;
}

function _sales_platform_handler_results_accept_task_handoff() {
  const sales: SalesCorePlatform<_SocialMeta> & SalesIngestionPlatform<_SocialMeta> = {
    getProducts: async () => ({ products: [], cache_scope: 'account' }),
    createMediaBuy: async (_req, ctx) => ctx.handoffToTask(async () => _createBuyPayload()),
    updateMediaBuy: async () => _updateBuyPayload(),
    getMediaBuyDelivery: async () => ({
      reporting_period: { start: '2026-01-01', end: '2026-01-31' },
      media_buy_deliveries: [],
    }),
    getMediaBuys: async () => ({ media_buys: [] }),
    syncCreatives: async (_creatives, ctx) => ctx.handoffToTask(async () => []),
  };

  const createResult: CreateMediaBuyHandlerResult = _createBuyPayload();
  const syncResult: SyncCreativesHandlerResult = [];
  void createResult;
  void syncResult;
  return sales;
}

type _Ok<T> = { ok: true; value: T };
type _Err<E> = { ok: false; error: E };
type _Result<T, E> = _Ok<T> | _Err<E>;
const _ok = <T>(value: T): _Result<T, Error> => ({ ok: true, value });

type _AdopterResultPayloadAliases = [
  _Result<GetProductsPayload, Error>,
  _Result<ListCreativeFormatsPayload, Error>,
  _Result<CreateMediaBuyPayload, Error>,
  _Result<UpdateMediaBuyPayload, Error>,
  _Result<SyncCreativesPayload, Error>,
  _Result<SyncEventSourcesPayload, Error>,
  _Result<ListAccountsPayload, Error>,
  _Result<GetMediaBuysPayload, Error>,
  _Result<GetMediaBuyDeliveryPayload, Error>,
  _Result<BuildCreativePayload, Error>,
  _Result<BuildCreativeMultiPayload, Error>,
  _Result<SyncAudiencesPayload, Error>,
  _Result<ActivateSignalPayload, Error>,
  _Result<GetBrandIdentityPayload, Error>,
  _Result<GetRightsPayload, Error>,
  _Result<UpdateRightsPayload, Error>,
  _Result<CreativeApprovedPayload, Error>,
  _Result<CreateMediaBuyHandlerResult, Error>,
  _Result<SyncCreativesHandlerResult, Error>,
];

function _adopter_result_payload_aliases_do_not_require_protocol_status(): _AdopterResultPayloadAliases {
  const creativeManifest = {} as CreativeManifest;
  const rightsTerms = {} as RightsTerms;
  const payloads: _AdopterResultPayloadAliases = [
    _ok({ products: [], cache_scope: 'account' }),
    _ok({ formats: [] }),
    _ok(_createBuyPayload()),
    _ok(_updateBuyPayload()),
    _ok({ creatives: [] }),
    _ok({ event_sources: [] }),
    _ok({ accounts: [] }),
    _ok({ media_buys: [] }),
    _ok({
      reporting_period: { start: '2026-01-01', end: '2026-01-31' },
      media_buy_deliveries: [],
    }),
    _ok({ creative_manifest: creativeManifest }),
    _ok({ creative_manifests: [] }),
    _ok({ audiences: [] }),
    _ok({ deployments: [] }),
    _ok({ brand_id: 'brand_1', house: { domain: 'acme.com', name: 'Acme' }, names: [{ en: 'Acme' }] }),
    _ok({ rights: [] }),
    _ok({ rights_id: 'rights_1', terms: rightsTerms }),
    _ok({ approval_status: 'approved', rights_id: 'rights_1' }),
    _ok(_createBuyPayload()),
    _ok([]),
  ];
  return payloads;
}

function _account_handler_result_aliases_are_exported() {
  const results: [
    ListAccountsHandlerResult,
    SyncAccountsHandlerResult,
    SyncGovernanceHandlerResult,
    _Result<ReportUsageHandlerResult, Error>,
    _Result<GetAccountFinancialsHandlerResult, Error>,
  ] = [{ items: [] }, [], [], _ok({ accepted: 0 }), _ok({} as GetAccountFinancialsHandlerResult)];
  return results;
}

function _server_payload_preserves_domain_status_fields(): void {
  type CreateMediaBuySuccess = import('../../types/tools.generated').CreateMediaBuySuccess;
  const payload: ServerPayload<CreateMediaBuySuccess> = {
    media_buy_id: 'x',
    confirmed_at: '2026-01-01T00:00:00Z',
    revision: 1,
    packages: [],
    status: 'active',
  };
  void payload;
}

function _sync_creatives_payload_accepts_operation_level_error(): void {
  const payload: SyncCreativesPayload = {
    errors: [{ code: 'INVALID_REQUEST', message: 'invalid creative batch' }],
  };
  void payload;
}

function _server_payload_strips_write_only_notification_credentials(): void {
  const listAccounts: ListAccountsPayload = {
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
  const auth = listAccounts.accounts[0]?.notification_configs?.[0]?.authentication;
  if (auth) {
    // @ts-expect-error — response payload aliases must not expose write-only webhook credentials.
    const _credentials = auth.credentials;
  }
  const billingEntity = listAccounts.accounts[0]?.billing_entity;
  if (billingEntity) {
    // @ts-expect-error — response payload aliases must not expose write-only bank coordinates.
    const _bank = billingEntity.bank;
  }

  const createBuy: CreateMediaBuyPayload = {
    media_buy_id: 'mb_1',
    confirmed_at: '2026-01-01T00:00:00Z',
    revision: 1,
    packages: [],
    invoice_recipient: { legal_name: 'Acme Inc.' },
    account: {
      account_id: 'acct_1',
      name: 'Acme',
      status: 'active',
      notification_configs: [
        {
          subscriber_id: 'buyer-primary',
          url: 'https://hooks.test/notify',
          event_types: [],
          authentication: { schemes: ['HMAC-SHA256'] },
        },
      ],
    },
  };
  const embeddedAuth = createBuy.account?.notification_configs?.[0]?.authentication;
  if (embeddedAuth) {
    // @ts-expect-error — embedded account payloads get the same response-safe projection.
    const _embeddedCredentials = embeddedAuth.credentials;
  }
  const invoiceRecipient = createBuy.invoice_recipient;
  if (invoiceRecipient) {
    // @ts-expect-error — direct BusinessEntity payloads get the same response-safe projection.
    const _invoiceRecipientBank = invoiceRecipient.bank;
  }
}

function _server_payload_keeps_required_domain_fields(): void {
  type CreateMediaBuySuccess = import('../../types/tools.generated').CreateMediaBuySuccess;
  // @ts-expect-error — ServerPayload removes framework-owned envelope fields,
  // but it must not make required domain fields optional.
  const payload: ServerPayload<CreateMediaBuySuccess> = { packages: [] };
  void payload;
}

function _server_payload_preserves_governance_context(): void {
  const payload: CheckGovernancePayload = {
    check_id: 'check_1',
    verdict: 'approved',
    plan_id: 'plan_1',
    explanation: 'Approved',
    governance_context: 'eyJhbGciOiJIUzI1NiJ9.test',
  };
  void payload;
}

function _non_sales_platform_payload_returns_do_not_require_protocol_status() {
  const sponsoredIntelligence: SponsoredIntelligencePlatform<_SocialMeta> = {
    getOffering: async () => ({ available: true }),
    initiateSession: async () => ({ session_id: 'si_1', session_status: 'active' }),
    sendMessage: async () => ({ session_id: 'si_1', session_status: 'active' }),
    terminateSession: async () => ({ session_id: 'si_1', terminated: true }),
  };
  return sponsoredIntelligence;
}

interface _OperationalMeta extends OperationalContext {
  advertiserId: string;
}

function _operational_platform_payload_returns_do_not_require_protocol_status(): OperationalPlatform<_OperationalMeta> {
  return {
    platformId: 'test',
    extractContext: async () => ({ accessToken: undefined, advertiserId: 'adv_1' }),
    updateMediaBuy: async () => ({ media_buy_id: 'mb_1', revision: 1 }),
    getMediaBuyDelivery: async () => ({
      reporting_period: { start: '2026-01-01', end: '2026-01-31' },
      media_buy_deliveries: [],
    }),
    getProducts: async () => ({ products: [], cache_scope: 'public' as const }),
  };
}

// Negative: bare `defineSalesPlatform<Meta>({...})` does NOT preserve the
// closed shape; its return type is the loose `SalesPlatform<TCtxMeta>`
// (all-optional after #1341). Adopters claiming `sales-guaranteed` need
// pattern A or B above. This test documents the limitation so future
// changes that "fix" `defineSalesPlatform`'s return type without proving
// inference-through-defaults don't silently regress the adopter migration.
function _define_sales_platform_widens_post_1341() {
  const sales = defineSalesPlatform<_SocialMeta>({
    getProducts: async () => ({ status: 'completed' as const, products: [], cache_scope: 'public' as const }),
    createMediaBuy: async () => _createBuyPayload(),
    updateMediaBuy: async () => _updateBuyPayload(),
    getMediaBuyDelivery: async () => ({
      status: 'completed' as const,
      reporting_period: { start: '2026-01-01', end: '2026-01-31' },
      media_buy_deliveries: [],
    }),
    getMediaBuys: async () => ({ status: 'completed' as const, media_buys: [] }),
  });
  type _SalesGuaranteedShape = (RequiredPlatformsFor<'sales-guaranteed'> & {
    sales: unknown;
  })['sales'];
  // @ts-expect-error — defineSalesPlatform returns SalesPlatform<TCtxMeta>
  // (all-optional after #1341) which doesn't satisfy the closed-shape
  // constraint of RequiredPlatformsFor<'sales-guaranteed'>. The expected
  // failure here is the regression alarm: if this stops failing, the
  // helper's return type narrowed and the migration patterns above can
  // be relaxed.
  const _check: _SalesGuaranteedShape = sales;
  return _check;
}

// Positive: defineAudiencePlatform<TCtxMeta> is pure identity.
function _define_audience_platform_identity(p: AudiencePlatform<_SocialMeta>): AudiencePlatform<_SocialMeta> {
  return defineAudiencePlatform<_SocialMeta>(p);
}

// Negative: defineAudiencePlatform rejects a method typed as a non-function.
function _define_audience_platform_rejects_wrong_shape() {
  // @ts-expect-error — syncAudiences must be a function, not a string.
  return defineAudiencePlatform<_SocialMeta>({ syncAudiences: 'not-a-function' });
}

// ── definePlatformWithCompliance / RequiredOptsFor invariants ─────────────

// Positive: definePlatformWithCompliance accepts a platform with compliance_testing.
type _PlatformBase = DecisioningPlatform<unknown, Record<string, unknown>>;
type _PlatformWithCT = _PlatformBase & {
  capabilities: { compliance_testing: ComplianceTestingCapabilities };
};
function _define_platform_with_compliance_accepts_ct(p: _PlatformWithCT): _PlatformWithCT {
  return definePlatformWithCompliance(p);
}

// Negative: definePlatformWithCompliance rejects a platform missing compliance_testing
// (compliance_testing is optional on DecisioningPlatformCapabilities, required by the helper).
function _define_platform_with_compliance_rejects_missing_ct() {
  const p: _PlatformBase = {} as unknown as _PlatformBase;
  // @ts-expect-error — compliance_testing is required by the helper but optional on the base type.
  return definePlatformWithCompliance(p);
}

// Positive: RequiredOptsFor resolves to base options when P has no compliance_testing.
type _opts_no_ct = RequiredOptsFor<_PlatformBase>;
const _check_opts_no_ct: _opts_no_ct extends CreateAdcpServerFromPlatformOptions ? true : false = true;

// Positive: RequiredOptsFor resolves to require complyTest when P has compliance_testing.
// Uses ComplyControllerConfig (not object) to assert the exact required type.
type _opts_with_ct = RequiredOptsFor<_PlatformWithCT>;
const _check_opts_with_ct: _opts_with_ct extends { complyTest: ComplyControllerConfig } ? true : false = true;

// Negative: base opts (complyTest optional) is NOT assignable to CT opts (complyTest required).
// This is the call-site regression alarm: if RequiredOptsFor stops requiring complyTest,
// this would flip to 'assignable' and fail to match the 'not-assignable' literal type.
type _ct_opts_requires_complytest =
  CreateAdcpServerFromPlatformOptions extends RequiredOptsFor<_PlatformWithCT> ? 'assignable' : 'not-assignable';
const _check_ct_opts_requires: _ct_opts_requires_complytest = 'not-assignable';

// ── Format.renders[] accepts typed render builders ──

import { displayRender, parameterizedRender } from '../../utils/format-render-builders';
import type { Format, PreviewCreativeResponse } from '../../types/tools.generated';

// `displayRender(...)` and `parameterizedRender(...)` produce closed shapes
// that must be assignable to `Format['renders'][number]` under strict tsc.
function _format_renders_accept_display_render(): void {
  type FormatRenders = NonNullable<Format['renders']>;
  const renders: FormatRenders = [
    displayRender({ role: 'primary', dimensions: { width: 300, height: 250 } }),
    parameterizedRender({ role: 'companion' }),
  ];
  void renders;
}

// ── NoAccountCtx narrows ctx.account on no-account tools ──

import { defineCreativeBuilderPlatform, defineCreativeAdServerPlatform } from './platform-helpers';
import type {
  ListCreativeFormatsResponse,
  GetCreativeDeliveryResponse,
  ListCreativesResponse,
} from '../../types/tools.generated';

// `previewCreative` handlers must narrow `ctx.account` before reading
// `ctx_metadata` — the wire schema does not carry an `account` field, so
// `ctx.account` is `Account<TCtxMeta> | undefined`.
function _preview_creative_requires_account_narrow(): void {
  defineCreativeBuilderPlatform<{ workspace_id: string }>({
    buildCreative: async () => ({}) as never,
    previewCreative: async (_req, ctx) => {
      if (ctx.account == null) {
        return {} as PreviewCreativeResponse;
      }
      const _ws: string = ctx.account.ctx_metadata.workspace_id;
      void _ws;
      return {} as PreviewCreativeResponse;
    },
  });
}

// Reading `ctx.account.ctx_metadata` without a narrow MUST fail typecheck
// — this is the regression alarm guarding the no-account contract.
function _preview_creative_rejects_unnarrowed_access(): void {
  defineCreativeBuilderPlatform<{ workspace_id: string }>({
    buildCreative: async () => ({}) as never,
    previewCreative: async (_req, ctx) => {
      // @ts-expect-error — ctx.account is `Account | undefined`; reading without narrowing fails.
      const _ws: string = ctx.account.ctx_metadata.workspace_id;
      void _ws;
      return {} as PreviewCreativeResponse;
    },
  });
}

// `listCreativeFormats` on `CreativeBuilderPlatform` is a no-account tool.
// Same dispatch contract as `previewCreative`: wire schema omits `account`,
// framework dispatches with `ctx.account === undefined` when
// `accounts.resolve(undefined)` returns null. Regression lock against #1384
// — a previous version of `CreativeBuilderPlatform` carried two declarations
// for `listCreativeFormats` (one `NoAccountCtx`, one `Ctx`); TS overload
// resolution kept the narrow at the implementation site, but the duplicate
// was a footgun for adopters and a tripwire for future refactors. Removing
// the duplicate and locking the narrow here.
function _builder_list_creative_formats_requires_account_narrow(): void {
  defineCreativeBuilderPlatform<{ catalog_id: string }>({
    buildCreative: async () => ({}) as never,
    listCreativeFormats: async (_req, ctx) => {
      if (ctx.account == null) {
        return {} as ListCreativeFormatsResponse;
      }
      const _catalog: string = ctx.account.ctx_metadata.catalog_id;
      void _catalog;
      return {} as ListCreativeFormatsResponse;
    },
  });
}

function _builder_list_creative_formats_rejects_unnarrowed_access(): void {
  defineCreativeBuilderPlatform<{ catalog_id: string }>({
    buildCreative: async () => ({}) as never,
    listCreativeFormats: async (_req, ctx) => {
      // @ts-expect-error — ctx.account is `Account | undefined`; reading without narrowing fails.
      const _catalog: string = ctx.account.ctx_metadata.catalog_id;
      void _catalog;
      return {} as ListCreativeFormatsResponse;
    },
  });
}

// Same lock for `CreativeAdServerPlatform.listCreativeFormats` — the
// ad-server interface carried the same duplicate-declaration pattern
// before #1384. Lock the narrow.
function _ad_server_list_creative_formats_requires_account_narrow(): void {
  defineCreativeAdServerPlatform<{ catalog_id: string }>({
    buildCreative: async () => ({}) as never,
    previewCreative: async () => ({}) as PreviewCreativeResponse,
    listCreatives: async () => ({}) as ListCreativesResponse,
    getCreativeDelivery: async () => ({}) as GetCreativeDeliveryResponse,
    listCreativeFormats: async (_req, ctx) => {
      if (ctx.account == null) {
        return {} as ListCreativeFormatsResponse;
      }
      const _catalog: string = ctx.account.ctx_metadata.catalog_id;
      void _catalog;
      return {} as ListCreativeFormatsResponse;
    },
  });
}

// ── Discriminator-injecting builders are non-overridable (#1386) ──

import { activationKey, segmentIdActivationKey, keyValueActivationKey } from '../../utils/activation-key-builders';
import { signalId, catalogSignalId, agentSignalId } from '../../utils/signal-id-builders';
import { buildCreativeReturn, singleEnvelopedBuildCreativeReturn } from '../../utils/build-creative-return-builders';
import { previewCreative, singlePreviewCreativeResponse } from '../../utils/preview-creative-builders';
import {
  mediaBuyDeliveryNotification,
  scheduledMediaBuyDeliveryNotification,
} from '../../utils/media-buy-delivery-notification-builders';
import type { ActivationKey, SignalID, CreativeManifest } from '../../types/core.generated';

function _activation_key_factories_inject_discriminator(): void {
  const seg: ActivationKey = activationKey.segment({ segment_id: 'plat_seg_xyz' });
  const kv: ActivationKey = activationKey.keyValue({ key: 'segment', value: 'abc123' });
  void seg;
  void kv;
  // @ts-expect-error — `type` is omitted from the parameter type; passing it must fail.
  segmentIdActivationKey({ type: 'key_value', segment_id: 'x' });
  // @ts-expect-error — same: cannot smuggle a conflicting discriminator via fields.
  keyValueActivationKey({ type: 'segment_id', key: 'k', value: 'v' });
}

function _signal_id_factories_inject_discriminator(): void {
  const cat: SignalID = signalId.catalog({ data_provider_domain: 'example.com', id: 'seg' });
  const agt: SignalID = signalId.agent({ agent_url: 'https://x/.well-known/adcp/signals', id: 'seg' });
  void cat;
  void agt;
  // @ts-expect-error — `source` is omitted from the parameter type.
  catalogSignalId({ source: 'agent', data_provider_domain: 'x', id: 'y' });
  // @ts-expect-error — same: agent factory rejects a `source: 'catalog'`.
  agentSignalId({ source: 'catalog', agent_url: 'https://x', id: 'y' });
}

function _preview_creative_factories_inject_discriminator(): void {
  const single = previewCreative.single({
    previews: [{ preview_id: 'p', renders: [], input: { name: 'default' } }],
    expires_at: '2026-05-03T00:00:00Z',
  });
  void single;
  singlePreviewCreativeResponse({
    // @ts-expect-error — `response_type` is omitted from the parameter type.
    response_type: 'batch',
    previews: [],
    expires_at: '2026-05-03T00:00:00Z',
  });
}

function _build_creative_return_factories_pin_arm(): void {
  const m: CreativeManifest = {} as CreativeManifest;
  const bare = buildCreativeReturn.single(m);
  const enveloped = buildCreativeReturn.singleEnveloped({ manifest: m, sandbox: true });
  void bare;
  void enveloped;
  // @ts-expect-error — `creative_manifest` is the wire field, not the helper input.
  singleEnvelopedBuildCreativeReturn({ creative_manifest: m });
}

function _media_buy_delivery_notification_factories_inject_discriminator(): void {
  const scheduled = mediaBuyDeliveryNotification.scheduled({
    status: 'completed' as const,
    reporting_period: { start: '2026-05-01T00:00:00Z', end: '2026-05-02T00:00:00Z' },
    currency: 'USD',
    media_buy_deliveries: [],
  });
  void scheduled;
  scheduledMediaBuyDeliveryNotification({
    // @ts-expect-error — `notification_type` is omitted from the parameter type.
    notification_type: 'final',
    reporting_period: { start: '2026-05-01T00:00:00Z', end: '2026-05-02T00:00:00Z' },
    currency: 'USD',
    media_buy_deliveries: [],
  });
}

function _ad_server_list_creative_formats_rejects_unnarrowed_access(): void {
  defineCreativeAdServerPlatform<{ catalog_id: string }>({
    buildCreative: async () => ({}) as never,
    previewCreative: async () => ({}) as PreviewCreativeResponse,
    listCreatives: async () => ({}) as ListCreativesResponse,
    getCreativeDelivery: async () => ({}) as GetCreativeDeliveryResponse,
    listCreativeFormats: async (_req, ctx) => {
      // @ts-expect-error — ctx.account is `Account | undefined`; reading without narrowing fails.
      const _catalog: string = ctx.account.ctx_metadata.catalog_id;
      void _catalog;
      return {} as ListCreativeFormatsResponse;
    },
  });
}

// Reference all symbols once so eslint-disable is targeted.
export const _references = [
  _signals_only_capabilities_compiles,
  _channels_rejects_unknown_channel,
  _pricing_models_rejects_unknown_model,
  _adcp_error_minimum,
  _adcp_error_full_fields,
  _adcp_error_accepts_unknown_code,
  _adcp_error_recovery_optional_defaults_from_code,
  _adcp_error_throw_pattern,
  _check_sales_only,
  _check_creative_template,
  _check_audience_sync,
  _account_with_typed_meta,
  _account_typed_meta_rejects_wrong_field,
  _refresh_token_typed_meta,
  _refresh_token_typed_meta_rejects_wrong_field,
  _account_not_found_throw_pattern,
  _account_store_resolution_implicit,
  _account_store_resolution_derived,
  _account_store_resolution_invalid_value,
  _capabilities_supported_billings_operator,
  _capabilities_supported_billings_advertiser,
  _capabilities_supported_billings_invalid,
  _targeting_capabilities_nested,
  _targeting_capabilities_rejects_unknown_geo_metro,
  _new_codes_compile,
  _check_sales_required,
  _check_brand_rights_requires_brand,
  _check_sales_no_required_caps,
  _define_sales_platform_identity,
  _sales_guaranteed_field_annotation_pattern,
  _sales_guaranteed_spread_helpers_pattern,
  _sales_platform_payload_returns_do_not_require_protocol_status,
  _sales_platform_handler_results_accept_task_handoff,
  _adopter_result_payload_aliases_do_not_require_protocol_status,
  _account_handler_result_aliases_are_exported,
  _server_payload_preserves_domain_status_fields,
  _server_payload_strips_write_only_notification_credentials,
  _server_payload_keeps_required_domain_fields,
  _server_payload_preserves_governance_context,
  _non_sales_platform_payload_returns_do_not_require_protocol_status,
  _operational_platform_payload_returns_do_not_require_protocol_status,
  _define_sales_platform_widens_post_1341,
  _define_audience_platform_identity,
  _define_audience_platform_rejects_wrong_shape,
  _define_platform_with_compliance_accepts_ct,
  _define_platform_with_compliance_rejects_missing_ct,
  _check_opts_no_ct,
  _check_opts_with_ct,
  _check_ct_opts_requires,
  _format_renders_accept_display_render,
  _preview_creative_requires_account_narrow,
  _preview_creative_rejects_unnarrowed_access,
  _builder_list_creative_formats_requires_account_narrow,
  _builder_list_creative_formats_rejects_unnarrowed_access,
  _ad_server_list_creative_formats_requires_account_narrow,
  _ad_server_list_creative_formats_rejects_unnarrowed_access,
  _activation_key_factories_inject_discriminator,
  _signal_id_factories_inject_discriminator,
  _preview_creative_factories_inject_discriminator,
  _build_creative_return_factories_pin_arm,
  _media_buy_delivery_notification_factories_inject_discriminator,
] as const;
