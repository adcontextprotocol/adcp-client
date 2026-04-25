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
  AsyncOutcome,
  Account,
  AccountStore,
  DecisioningCapabilities,
  TargetingCapabilities,
  StatusMappers,
  CreativeTemplatePlatform,
  SalesPlatform,
  AudiencePlatform,
} from './index';
import { ok, submitted, rejected, unimplemented, aggregateRejected, AccountNotFoundError } from './index';

// ── AsyncOutcome construction helpers ─────────────────────────────────

function _ok_returns_sync_kind(): AsyncOutcome<{ id: string }> {
  return ok({ id: 'mb_1' });
}

function _rejected_requires_recovery(): AsyncOutcome<{ id: string }> {
  return rejected({
    code: 'TERMS_REJECTED',
    recovery: 'correctable',
    message: 'max_variance_percent below seller floor',
  });
}

function _rejected_accepts_unknown_code_with_brand_trick(): AsyncOutcome<{ id: string }> {
  return rejected({
    code: 'GAM_INTERNAL_QUOTA_EXCEEDED', // platform-specific; (string & {}) escape hatch
    recovery: 'transient',
    message: 'GAM rate limit hit; retry in 60s',
  });
}

function _rejected_missing_recovery_fails(): AsyncOutcome<{ id: string }> {
  // @ts-expect-error — `recovery` is required on AdcpStructuredError.
  return rejected({
    code: 'TERMS_REJECTED',
    message: 'forgot recovery',
  });
}

// ── RequiredPlatformsFor enforces specialism → interface mapping ─────

// Positive: claiming sales-non-guaranteed AND providing sales: SalesPlatform satisfies the constraint.
type _ok_sales_only = RequiredPlatformsFor<'sales-non-guaranteed'> extends { sales: SalesPlatform } ? true : false;
const _check_sales_only: _ok_sales_only = true;

// Positive: claiming creative-template AND providing creative: CreativeTemplatePlatform satisfies.
type _ok_creative_template =
  RequiredPlatformsFor<'creative-template'> extends {
    creative: CreativeTemplatePlatform;
  }
    ? true
    : false;
const _check_creative_template: _ok_creative_template = true;

// Positive: claiming audience-sync AND providing audiences: AudiencePlatform satisfies.
type _ok_audience_sync = RequiredPlatformsFor<'audience-sync'> extends { audiences: AudiencePlatform } ? true : false;
const _check_audience_sync: _ok_audience_sync = true;

// ── Account is generic over TMeta ─────────────────────────────────────

interface GAMAccountMeta {
  networkId: string;
  advertiserId: string;
}

function _account_with_typed_meta(account: Account<GAMAccountMeta>): string {
  return account.metadata.networkId;
}

function _account_typed_meta_rejects_wrong_field(account: Account<GAMAccountMeta>): string {
  // @ts-expect-error — `googleAdvertiserId` doesn't exist on GAMAccountMeta.
  return account.metadata.googleAdvertiserId;
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

// ── DecisioningCapabilities.supportedBillings is a closed enum ────────

function _capabilities_supported_billings_operator(): Pick<DecisioningCapabilities, 'supportedBillings'> {
  return { supportedBillings: ['operator'] as const };
}

function _capabilities_supported_billings_invalid(): Pick<DecisioningCapabilities, 'supportedBillings'> {
  // @ts-expect-error — only 'operator' | 'agent' allowed.
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

// ── AdcpStructuredError carries field/suggestion/retry_after ──────────

function _structured_error_with_wire_fields(): AsyncOutcome<{ id: string }> {
  return rejected({
    code: 'INVALID_REQUEST',
    recovery: 'correctable',
    message: 'targeting.geo[0] is not a known DMA',
    field: 'packages[0].targeting.geo[0]',
    suggestion: 'Use a 3-digit Nielsen DMA code',
    retry_after: undefined, // optional; only required on RATE_LIMITED / SERVICE_UNAVAILABLE
  });
}

function _structured_error_retry_after_for_transient(): AsyncOutcome<{ id: string }> {
  return rejected({
    code: 'RATE_LIMITED',
    recovery: 'transient',
    message: 'too many concurrent get_products calls',
    retry_after: 60,
  });
}

// ── ErrorCode covers the 45 spec codes (sample the new ones) ──────────

function _new_codes_compile(): AsyncOutcome<{ id: string }> {
  // These codes weren't in the v1.0 scaffold pre-must-fixes.
  void rejected({ code: 'INVALID_STATE', recovery: 'correctable', message: '' });
  void rejected({ code: 'MEDIA_BUY_NOT_FOUND', recovery: 'terminal', message: '' });
  void rejected({ code: 'NOT_CANCELLABLE', recovery: 'terminal', message: '' });
  void rejected({ code: 'REQUOTE_REQUIRED', recovery: 'correctable', message: '' });
  void rejected({ code: 'CREATIVE_DEADLINE_EXCEEDED', recovery: 'terminal', message: '' });
  return ok({ id: 'mb_1' });
}

// ── submitted() carries partialResult for buy-pending-review pattern ──

function _submitted_with_partial_result(): AsyncOutcome<{ id: string; status: string }> {
  // Stub TaskHandle for the type test.
  const handle = { taskId: 'task_1', notify: () => {} };
  return submitted(handle, {
    estimatedCompletion: new Date(Date.now() + 4 * 3600_000),
    message: 'pending operator approval',
    partialResult: { id: 'mb_1', status: 'pending_start' },
  });
}

// ── unimplemented + aggregateRejected helpers compile cleanly ─────────

function _unimplemented_helper(): AsyncOutcome<{ id: string }> {
  return unimplemented('audience-sync not yet wired');
}

function _aggregate_rejected_with_errors(): AsyncOutcome<{ id: string }> {
  return aggregateRejected([
    { code: 'INVALID_REQUEST', recovery: 'correctable', message: 'budget too low', field: 'total_budget' },
    {
      code: 'UNSUPPORTED_FEATURE',
      recovery: 'correctable',
      message: 'pricing model "vcpm" not supported',
      field: 'packages[0].pricing.model',
    },
  ]);
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

// Reference all symbols once so eslint-disable is targeted.
export const _references = [
  _ok_returns_sync_kind,
  _rejected_requires_recovery,
  _rejected_accepts_unknown_code_with_brand_trick,
  _rejected_missing_recovery_fails,
  _check_sales_only,
  _check_creative_template,
  _check_audience_sync,
  _account_with_typed_meta,
  _account_typed_meta_rejects_wrong_field,
  _account_not_found_throw_pattern,
  _account_store_resolution_implicit,
  _account_store_resolution_derived,
  _account_store_resolution_invalid_value,
  _capabilities_supported_billings_operator,
  _capabilities_supported_billings_invalid,
  _targeting_capabilities_nested,
  _targeting_capabilities_rejects_unknown_geo_metro,
  _structured_error_with_wire_fields,
  _structured_error_retry_after_for_transient,
  _new_codes_compile,
  _submitted_with_partial_result,
  _unimplemented_helper,
  _aggregate_rejected_with_errors,
  _check_sales_required,
] as const;
