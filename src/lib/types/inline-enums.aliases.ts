// Back-compat aliases for inline-enum exports collapsed in AdCP 3.0.1.
//
// adcp#3148 + adcp#3174 hoisted ~20 byte-identical inline string-literal
// unions into shared `enums/*.json` files; the per-parent `Foo_BarValues`
// exports the SDK previously emitted (e.g. `Account_PaymentTermsValues`,
// `VideoAsset_AudioChannelsValues`, `RATE_LIMITEDDetails_ScopeValues`)
// collapse into single canonical names (`PaymentTermsValues`,
// `AudioChannelLayoutValues`, `RateLimitedDetails_ScopeValues`).
//
// These aliases preserve the previously-shipped names for one minor cycle
// so consumers' imports keep compiling. Each is `@deprecated` so editors
// surface the rename. Slated for removal in the next major.
//
// Hand-authored on top of `inline-enums.generated.ts` and `enums.generated.ts`;
// regenerate carefully if either source moves.

import {
  AccountScopeValues,
  AudioChannelLayoutValues,
  BillingPartyValues,
  CollectionKindValues,
  FrameRateTypeValues,
  GOPTypeValues,
  GovernanceDecisionValues,
  MediaBuyValidActionValues,
  MoovAtomPositionValues,
  PaymentTermsValues,
  RightsBillingPeriodValues,
  ScanTypeValues,
  SnapshotUnavailableReasonValues,
} from './enums.generated';
import { RateLimitedDetails_ScopeValues } from './inline-enums.generated';

/** @deprecated Use `AccountScopeValues` from `@adcp/client/types`. */
export const Account_AccountScopeValues = AccountScopeValues;

/** @deprecated Use `BillingPartyValues` from `@adcp/client/types`. */
export const Account_BillingValues = BillingPartyValues;

/** @deprecated Use `PaymentTermsValues` from `@adcp/client/types`. */
export const Account_PaymentTermsValues = PaymentTermsValues;

/** @deprecated Use `AudioChannelLayoutValues` from `@adcp/client/types`. */
export const AudioAsset_ChannelsValues = AudioChannelLayoutValues;

/** @deprecated Use `GovernanceDecisionValues` from `@adcp/client/types`. */
export const CheckGovernanceResponse_StatusValues = GovernanceDecisionValues;

/** @deprecated Use `CollectionKindValues` from `@adcp/client/types`. */
export const CollectionListFilters_KindsValues = CollectionKindValues;

/** @deprecated Use `CollectionKindValues` from `@adcp/client/types`. */
export const Collection_KindValues = CollectionKindValues;

/** @deprecated Use `MediaBuyValidActionValues` from `@adcp/client/types`. */
export const CreateMediaBuySuccess_ValidActionsValues = MediaBuyValidActionValues;

/** @deprecated Use `PaymentTermsValues` from `@adcp/client/types`. */
export const GetAccountFinancialsSuccess_PaymentTermsValues = PaymentTermsValues;

/** @deprecated Use `SnapshotUnavailableReasonValues` from `@adcp/client/types`. */
export const PackageStatus_SnapshotUnavailableReasonValues = SnapshotUnavailableReasonValues;

/**
 * @deprecated Renamed to `RateLimitedDetails_ScopeValues` — the source schema's
 * title was canonicalized from `RATE_LIMITED Details` to `Rate Limited Details`
 * upstream (no wire change). Identical values.
 */
export const RATE_LIMITEDDetails_ScopeValues = RateLimitedDetails_ScopeValues;

/** @deprecated Use `RightsBillingPeriodValues` from `@adcp/client/types`. */
export const RightsPricingOption_PeriodValues = RightsBillingPeriodValues;

/** @deprecated Use `RightsBillingPeriodValues` from `@adcp/client/types`. */
export const RightsTerms_PeriodValues = RightsBillingPeriodValues;

/** @deprecated Use `MediaBuyValidActionValues` from `@adcp/client/types`. */
export const UpdateMediaBuySuccess_ValidActionsValues = MediaBuyValidActionValues;

/** @deprecated Use `AudioChannelLayoutValues` from `@adcp/client/types`. */
export const VideoAsset_AudioChannelsValues = AudioChannelLayoutValues;

/** @deprecated Use `FrameRateTypeValues` from `@adcp/client/types`. */
export const VideoAsset_FrameRateTypeValues = FrameRateTypeValues;

/** @deprecated Use `GOPTypeValues` from `@adcp/client/types`. */
export const VideoAsset_GopTypeValues = GOPTypeValues;

/** @deprecated Use `MoovAtomPositionValues` from `@adcp/client/types`. */
export const VideoAsset_MoovAtomPositionValues = MoovAtomPositionValues;

/** @deprecated Use `ScanTypeValues` from `@adcp/client/types`. */
export const VideoAsset_ScanTypeValues = ScanTypeValues;

/** @deprecated Use `AudioChannelLayoutValues` from `@adcp/client/types`. */
export const VideoAssetRequirements_AudioChannelsValues = AudioChannelLayoutValues;

/** @deprecated Use `FrameRateTypeValues` from `@adcp/client/types`. */
export const VideoAssetRequirements_FrameRateTypeValues = FrameRateTypeValues;

/** @deprecated Use `GOPTypeValues` from `@adcp/client/types`. */
export const VideoAssetRequirements_GopTypeValues = GOPTypeValues;

/** @deprecated Use `MoovAtomPositionValues` from `@adcp/client/types`. */
export const VideoAssetRequirements_MoovAtomPositionValues = MoovAtomPositionValues;

/** @deprecated Use `ScanTypeValues` from `@adcp/client/types`. */
export const VideoAssetRequirements_ScanTypeValues = ScanTypeValues;
