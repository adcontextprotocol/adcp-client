// Public barrel for buyer-side media-buy action helpers (AdCP 3.1 / #4480).

export type {
  ActionNotAllowedDetails,
  ActionNotAllowedReason,
  LegacyCoarseAction,
  MediaBuyActionContext,
  MediaBuyActionId,
  MediaBuyActionMode,
  MediaBuyAvailableAction,
  MediaBuyValidAction,
  SLAWindow,
  SlaWindow,
  UpdateMediaBuyRequestLike,
} from './types';
export { LEGACY_COARSE_ACTIONS } from './types';

/** Readable result of getAvailableActions; MediaBuyAvailableAction remains the narrower legacy wire type. */
export type { LiveMediaBuyAction } from './action-types';

export type { AvailableActionsResult, AvailableActionsSource } from './available-actions';
export {
  findAvailableAction,
  getAvailableActions,
  getRollupParent,
  __resetValidActionsWarningForTests,
} from './available-actions';

export type {
  BuyerPropertyPolicy,
  NormalizedPolicyDomain,
  ProductPolicyProductLike,
  ProductPropertyPolicyDiagnostic,
  ProductPropertyPolicyDiagnosticCode,
  ProductPropertyPolicyDiagnosticSeverity,
  ProductPropertyPolicyMode,
  ProductPropertyPolicySelectorBehavior,
  ProductPropertyPolicyValidationResult,
  ValidateProductsAgainstPropertyPolicyOptions,
} from './property-policy';
export {
  ProductPropertyPolicyError,
  normalizeDomainForPropertyPolicy,
  validateProductsAgainstPropertyPolicy,
} from './property-policy';

export type {
  DecomposedUpdateMediaBuy,
  DecomposedUpdateMediaBuyMutation,
  MediaBuyMutationDirection,
  MediaBuyMutationScope,
  ModeMismatchRecovery,
  PreflightAllowed,
  PreflightDenial,
  PreflightDenied,
  PreflightResult,
  ResolvedAction,
} from './preflight';
export {
  canAddPackages,
  canCancel,
  canDecreaseBudget,
  canExtendFlight,
  canIncreaseBudget,
  canPause,
  canReallocateBudget,
  canRemoveCreative,
  canRemovePackages,
  canReplaceCreative,
  canResume,
  canShortenFlight,
  canUpdateCreativeAssignments,
  canUpdateFlightDates,
  canUpdateFrequencyCaps,
  canUpdatePacing,
  canUpdateTargeting,
  decomposeUpdateMediaBuy,
  getActionForMutation,
  preflightUpdateMediaBuy,
  recoveryForModeMismatch,
} from './preflight';

export type {
  MediaBuyUpdateFieldAction,
  StructuredOnlyMediaBuyAction,
  UpdateFieldEntry,
} from './update-fields.generated';
/** Legacy coarse update-field metadata. Use decomposeUpdateMediaBuy for current accepted-term action mapping. */
export {
  ACTIONS_BY_FIELD,
  STRUCTURED_ONLY_MEDIA_BUY_ACTIONS,
  UPDATE_FIELDS_BY_ACTION,
} from './update-fields.generated';

export { applyTargetingInput, hasTargetingClears, resolveTargetingInput } from './targeting-input';
export type { ResolvedTargetingInput, TargetingInputFor } from './targeting-input';
export type { CreateTargetingInput, UpdateTargetingInput } from '../types';

export * from './compatibility';
export * from './established-proposal-store';
export * from './legacy-purchase-continuation';

export * from './actions';
