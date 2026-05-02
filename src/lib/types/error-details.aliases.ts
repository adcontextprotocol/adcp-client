// Back-compat aliases for the error-details schemas renamed in AdCP 3.0.x.
//
// adcp#3149 (`rate-limited.json`) and adcp#3566 (other error-details files)
// canonicalized SCREAMING_SNAKE titles like `RATE_LIMITED Details` and
// `ACCOUNT_SETUP_REQUIRED Details` into Title Case. The previous SDK release
// emitted `RATE_LIMITEDDetails`, `ACCOUNT_SETUP_REQUIREDDetails`, etc., because
// `json-schema-to-typescript` derives type names from each schema's `title`.
// Post-3.0.4, the canonical names are `RateLimitedDetails`,
// `AccountSetupRequiredDetails`, etc.
//
// These aliases preserve the previously-shipped names for one minor cycle so
// consumers' imports keep compiling. Each is `@deprecated` so editor tooling
// surfaces the rename. Slated for removal in the next major.
//
// Companion to `inline-enums.aliases.ts`, which handles the `_ScopeValues`
// surface for the same family (`RATE_LIMITEDDetails_ScopeValues` →
// `RateLimitedDetails_ScopeValues`). Same pattern as #942's `AgeVerificationMethod1`
// rename.
//
// `creative-rejected.json` is intentionally absent: the codegen pipeline never
// emits a standalone `CreativeRejectedDetails` (or its prior SCREAMING_SNAKE
// counterpart) because the brand-domain `CreativeRejected` interface lays
// claim to the namespace first. Tracking the gap separately — no alias to
// emit since no prior name was published.

import type {
  AccountSetupRequiredDetails,
  AudienceTooSmallDetails,
  BudgetTooLowDetails,
  ConflictDetails,
  PolicyViolationDetails,
  RateLimitedDetails,
} from './core.generated';
import {
  AccountSetupRequiredDetailsSchema,
  AudienceTooSmallDetailsSchema,
  BudgetTooLowDetailsSchema,
  ConflictDetailsSchema,
  PolicyViolationDetailsSchema,
  RateLimitedDetailsSchema,
} from './schemas.generated';

/** @deprecated Renamed in AdCP 3.0.4 (adcp#3566). Use `AccountSetupRequiredDetails` from `@adcp/sdk/types`. */
export type ACCOUNT_SETUP_REQUIREDDetails = AccountSetupRequiredDetails;

/** @deprecated Renamed in AdCP 3.0.4 (adcp#3566). Use `AudienceTooSmallDetails` from `@adcp/sdk/types`. */
export type AUDIENCE_TOO_SMALLDetails = AudienceTooSmallDetails;

/** @deprecated Renamed in AdCP 3.0.4 (adcp#3566). Use `BudgetTooLowDetails` from `@adcp/sdk/types`. */
export type BUDGET_TOO_LOWDetails = BudgetTooLowDetails;

/** @deprecated Renamed in AdCP 3.0.4 (adcp#3566). Use `ConflictDetails` from `@adcp/sdk/types`. */
export type CONFLICTDetails = ConflictDetails;

/** @deprecated Renamed in AdCP 3.0.4 (adcp#3566). Use `PolicyViolationDetails` from `@adcp/sdk/types`. */
export type POLICY_VIOLATIONDetails = PolicyViolationDetails;

/** @deprecated Renamed in AdCP 3.0.1 (adcp#3149). Use `RateLimitedDetails` from `@adcp/sdk/types`. */
export type RATE_LIMITEDDetails = RateLimitedDetails;

/** @deprecated Renamed in AdCP 3.0.4 (adcp#3566). Use `AccountSetupRequiredDetailsSchema` from `@adcp/sdk/types`. */
export const ACCOUNT_SETUP_REQUIREDDetailsSchema = AccountSetupRequiredDetailsSchema;

/** @deprecated Renamed in AdCP 3.0.4 (adcp#3566). Use `AudienceTooSmallDetailsSchema` from `@adcp/sdk/types`. */
export const AUDIENCE_TOO_SMALLDetailsSchema = AudienceTooSmallDetailsSchema;

/** @deprecated Renamed in AdCP 3.0.4 (adcp#3566). Use `BudgetTooLowDetailsSchema` from `@adcp/sdk/types`. */
export const BUDGET_TOO_LOWDetailsSchema = BudgetTooLowDetailsSchema;

/** @deprecated Renamed in AdCP 3.0.4 (adcp#3566). Use `ConflictDetailsSchema` from `@adcp/sdk/types`. */
export const CONFLICTDetailsSchema = ConflictDetailsSchema;

/** @deprecated Renamed in AdCP 3.0.4 (adcp#3566). Use `PolicyViolationDetailsSchema` from `@adcp/sdk/types`. */
export const POLICY_VIOLATIONDetailsSchema = PolicyViolationDetailsSchema;

/** @deprecated Renamed in AdCP 3.0.1 (adcp#3149). Use `RateLimitedDetailsSchema` from `@adcp/sdk/types`. */
export const RATE_LIMITEDDetailsSchema = RateLimitedDetailsSchema;
