// `@adcp/sdk/errors`: typed SDK errors, the standard error-code table, error
// extraction, and the buyer retry policy, without loading the package root.
//
// Every name here is exported by `@adcp/sdk` under the same name, from the
// same source module, so `instanceof` and type meaning are identical whichever
// entry point a caller imports. Add a name here only when the root exports it
// under the same name. `test/lib/runtime-subpaths.test.js` enforces this, and
// `scripts/check-client-entry-graph.mjs` keeps this entry point free of
// `server/` and `testing/` modules.

export {
  ADCPError,
  TaskTimeoutError,
  MaxClarificationError,
  DeferredTaskError,
  TaskAbortedError,
  AgentNotFoundError,
  UnsupportedTaskError,
  ProtocolError,
  ValidationError as ADCPValidationError,
  RequestValidationError,
  MissingInputHandlerError,
  InvalidContextError,
  ConfigurationError,
  AuthenticationCredentialsRejectedError,
  AuthenticationRequiredError,
  FeatureUnsupportedError,
  ProtocolFeatureUnsupportedError,
  UnsupportedBuyingModeError,
  AccountRequiredError,
  AccountPendingApprovalError,
  AccountAmbiguousError,
  BuyerSetupError,
  AccountNotFoundError,
  AccountRequestError,
  AccountSetupRequiredError,
  AccountPaymentRequiredError,
  AccountNotProvisionedError,
  SDK_ERROR_TO_PROTOCOL_ERROR_CODE,
  VersionUnsupportedError,
  IdempotencyConflictError,
  IdempotencyExpiredError,
  ResponseTooLargeError,
  AgentRateLimitedError,
  ActionNotAllowedError,
  PreparedFixturesDeniedError,
  ReportingSubscriptionError,
  CoverageInputError,
  ReportingSubscriptionEngineError,
  adcpErrorToTypedError,
  getClientPreflightAdcpError,
  isADCPError,
  isErrorOfType,
  isPreDispatchError,
  extractErrorInfo,
  is401Error,
  mapSdkErrorCodeToProtocolErrorCode,
} from '../errors';
export type {
  OAuthMetadataInfo,
  ClientPreflightAdcpErrorInfo,
  ClientPreflightAdcpErrorRecovery,
  FeatureUnsupportedErrorOptions,
  ProtocolFeatureUnsupportedErrorOptions,
  VersionUnsupportedErrorOptions,
  ActionNotAllowedErrorDetails,
  ActionNotAllowedReasonValue,
  ActionNotAllowedAttemptedAction,
  ActionNotAllowedAvailableAction,
  ActionNotAllowedRecovery,
  AdcpErrorRecovery,
  ReportingSubscriptionErrorCode,
  ReportingSubscriptionErrorOptions,
  CoverageInputErrorCode,
  CoverageInputErrorDetail,
  ReportingSubscriptionEngineErrorCode,
} from '../errors';

// Standard error-code vocabulary.
export type { Error as TaskErrorDetail } from '../types/core.generated';
export {
  STANDARD_ERROR_CODES,
  isStandardErrorCode,
  getErrorRecovery,
  DEFAULT_UNKNOWN_ERROR_RECOVERY,
} from '../types/error-codes';
export type { StandardErrorCode, ErrorRecovery } from '../types/error-codes';

// Retry decisions.
export { isRetryable, getRetryDelay } from '../utils/retry';
export { decideRetry, BuyerRetryPolicy } from '../utils/buyer-retry-policy';
export type { RetryDecision, RetryContext, RetryDecisionOverride } from '../utils/buyer-retry-policy';

// Error extraction from task results and transport payloads.
export {
  extractAdcpErrorInfo,
  extractCorrelationId,
  resolveRecovery,
  getExpectedAction,
  extractAdcpErrorFromMcp,
  extractAdcpErrorFromTransport,
  extractVersionUnsupportedDetails,
} from '../utils/error-extraction';
export type { ExtractedAdcpError, VersionUnsupportedDetails } from '../utils/error-extraction';

// Response classification.
export { isAdcpError, isAdcpSuccess, isTerminalAdcpError } from '../utils/response-unwrapper';
