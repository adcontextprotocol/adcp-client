// Public barrel for buyer-side media-buy action helpers (AdCP 3.1 / #4480).

export type {
  ActionNotAllowedDetails,
  ActionNotAllowedReason,
  LegacyCoarseAction,
  MediaBuyActionContext,
  MediaBuyActionMode,
  MediaBuyAvailableAction,
  MediaBuyValidAction,
  SlaWindow,
  UpdateMediaBuyRequestLike,
} from './types';
export { LEGACY_COARSE_ACTIONS } from './types';

export type { AvailableActionsResult, AvailableActionsSource } from './available-actions';
export {
  findAvailableAction,
  getAvailableActions,
  getRollupParent,
  __resetValidActionsWarningForTests,
} from './available-actions';

export type {
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
  getActionForMutation,
  preflightUpdateMediaBuy,
  recoveryForModeMismatch,
} from './preflight';

export type { UpdateFieldEntry } from './update-fields.generated';
export { ACTIONS_BY_FIELD, UPDATE_FIELDS_BY_ACTION } from './update-fields.generated';
