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
  StatusMappers,
  CreativeTemplatePlatform,
  SalesPlatform,
  AudiencePlatform,
} from './index';
import { ok, submitted, rejected } from './async-outcome';

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
] as const;
