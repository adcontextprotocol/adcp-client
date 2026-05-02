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
  AudiencePlatform,
  CreateAdcpServerFromPlatformOptions,
  ComplianceTestingCapabilities,
} from './index';
import {
  AdcpError,
  AccountNotFoundError,
  defineSalesPlatform,
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
  _define_audience_platform_identity,
  _define_audience_platform_rejects_wrong_shape,
  _define_platform_with_compliance_accepts_ct,
  _define_platform_with_compliance_rejects_missing_ct,
  _check_opts_no_ct,
  _check_opts_with_ct,
  _check_ct_opts_requires,
] as const;
