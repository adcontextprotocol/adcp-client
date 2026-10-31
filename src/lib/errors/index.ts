// Custom error classes for ADCP client library
import { RequestSigningErrorCodeMetadata } from '../types/enums.generated';

/**
 * Base class for all ADCP client errors
 */
export abstract class ADCPError extends Error {
  abstract readonly code: string;

  constructor(
    message: string,
    public details?: unknown
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

/**
 * Error thrown when a task times out
 */
export interface GovernanceOutcomeRecovery {
  checkId: string;
  outcome?: 'completed' | 'failed';
  outcomeIdempotencyKey?: string;
}

export class TaskTimeoutError extends ADCPError {
  readonly code = 'TASK_TIMEOUT';
  /** Retry-safety key for mutating requests that reached dispatch. */
  idempotency_key?: string;
  /** Camel-case compatibility alias for `idempotency_key`. */
  idempotencyKey?: string;
  /** Retry identity when the deadline expires during governance postflight. */
  governanceRecovery?: GovernanceOutcomeRecovery;

  constructor(
    public readonly taskId: string,
    public readonly timeout: number
  ) {
    super(`Task ${taskId} timed out after ${timeout}ms`);
  }
}

/**
 * Error thrown when maximum clarification attempts are exceeded
 */
export class MaxClarificationError extends ADCPError {
  readonly code = 'MAX_CLARIFICATIONS';

  constructor(
    public readonly taskId: string,
    public readonly maxAttempts: number
  ) {
    super(`Task ${taskId} exceeded maximum clarification attempts: ${maxAttempts}`);
  }
}

/**
 * Error thrown when a task is deferred to human
 * Contains the token needed to resume the task
 */
export class DeferredTaskError extends ADCPError {
  readonly code = 'TASK_DEFERRED';
  readonly token!: string;

  constructor(token: string) {
    super('Task deferred with an opaque continuation token.');
    Object.defineProperty(this, 'token', {
      value: token,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
}

/**
 * Error thrown when a task is aborted
 */
export class TaskAbortedError extends ADCPError {
  readonly code = 'TASK_ABORTED';

  constructor(
    public readonly taskId: string,
    public readonly reason?: string
  ) {
    super(`Task ${taskId} aborted: ${reason || 'No reason provided'}`);
  }
}

/**
 * Error thrown when an agent is not found
 */
export class AgentNotFoundError extends ADCPError {
  readonly code = 'AGENT_NOT_FOUND';

  constructor(
    public readonly agentId: string,
    public readonly availableAgents: string[]
  ) {
    super(`Agent '${agentId}' not found. Available agents: ${availableAgents.join(', ')}`);
  }
}

/**
 * Error thrown when an agent doesn't support a task
 */
export class UnsupportedTaskError extends ADCPError {
  readonly code = 'UNSUPPORTED_TASK';

  constructor(
    public readonly agentId: string,
    public readonly taskName: string,
    public readonly supportedTasks?: string[]
  ) {
    const tasksMsg = supportedTasks ? ` Supported tasks: ${supportedTasks.join(', ')}` : '';
    super(`Agent '${agentId}' does not support task '${taskName}'.${tasksMsg}`);
  }
}

/** Seller did not declare the requested get_products buying mode. */
export class UnsupportedBuyingModeError extends ADCPError {
  readonly code = 'UNSUPPORTED_BUYING_MODE';

  constructor(
    public readonly requestedMode: string | undefined,
    public readonly declaredModes: readonly string[]
  ) {
    const requested = requestedMode ?? 'an inferred wholesale mode';
    const declared = declaredModes.length ? declaredModes.join(', ') : '(unknown)';
    super(
      `Seller does not support ${requested} buying mode. Declared modes: ${declared}. ` +
        'Supply a brief or choose a declared buying_mode after probing get_adcp_capabilities.'
    );
    this.details = { requested_mode: requestedMode, declared_modes: [...declaredModes] };
  }
}

/** A seller requires an account reference before an account-scoped request. */
export class AccountRequiredError extends ADCPError {
  readonly code = 'ACCOUNT_REQUIRED';
  readonly fault = 'buyer_setup' as const;

  constructor(
    public readonly accountModel: 'explicit' | 'implicit',
    public readonly taskName: string,
    reason?: string
  ) {
    super(
      reason ??
        `${taskName} requires an account for this ${accountModel}-account seller. ` +
          (accountModel === 'explicit'
            ? 'Call resolveAccount() to discover an account_id, then pass account: { account_id }.'
            : 'Call resolveAccount({ brand, operator }) to sync the account, then pass the returned reference.')
    );
    this.details = { account_model: accountModel, task_name: taskName };
  }
}

/** Account provisioning succeeded but the seller has not approved its use. */
export class AccountPendingApprovalError extends ADCPError {
  readonly code = 'ACCOUNT_PENDING_APPROVAL';
  readonly fault = 'buyer_setup' as const;

  constructor(
    public readonly account: import('../types').AccountReference,
    public readonly accountId?: string
  ) {
    super('The seller is reviewing this account. Wait for approval before making account-scoped requests.');
    this.details = { status: 'pending_approval', account_id: accountId, account };
  }
}

/** More than one active account matches the caller's selection hints. */
export class AccountAmbiguousError extends ADCPError {
  readonly code = 'ACCOUNT_AMBIGUOUS';

  constructor(public readonly candidates: readonly string[]) {
    super('Multiple eligible accounts. Supply brand/operator or a select callback.');
    this.details = { candidate_count: candidates.length };
  }
}

/** Buyer setup errors must be excluded from seller-health failure counts. */
export abstract class BuyerSetupError extends ADCPError {
  readonly fault = 'buyer_setup' as const;
}
export class AccountNotFoundError extends BuyerSetupError {
  readonly code: string = 'ACCOUNT_NOT_FOUND';
  constructor(message = 'The account has not been provisioned at this seller.') {
    super(message);
  }
}
export class AccountSetupRequiredError extends BuyerSetupError {
  readonly code: string = 'ACCOUNT_SETUP_REQUIRED';
  constructor(message = 'Complete account setup before making account-scoped requests.') {
    super(message);
  }
}
export class AccountPaymentRequiredError extends BuyerSetupError {
  readonly code: string = 'ACCOUNT_PAYMENT_REQUIRED';
  constructor(message = 'Complete account payment before making account-scoped requests.') {
    super(message);
  }
}
/**
 * `client.accounts.ensure` could not be processed (AdCP 3.3). Thrown only when the seller could not
 * process the call; `errors` carry the wire codes. A pending, ambiguous or rejected account is a value
 * (`AccountPending`, `AccountAmbiguous`, `AccountRejected`), never this error.
 */
export class AccountRequestError extends ADCPError {
  readonly code: string;
  readonly recovery: 'transient' | 'correctable' | 'terminal';
  constructor(
    public readonly operation: string,
    public readonly errors: readonly { code: string; message?: string; recovery?: string }[]
  ) {
    const first = errors[0];
    super(
      `${operation} could not be processed${first ? `: ${first.code}${first.message ? ` (${first.message})` : ''}` : ''}. ` +
        'Retry a transient failure; correct the request otherwise.'
    );
    this.code = first?.code ?? 'SERVICE_UNAVAILABLE';
    this.recovery =
      first?.recovery === 'correctable' || first?.recovery === 'terminal' || first?.recovery === 'transient'
        ? first.recovery
        : first
          ? 'correctable'
          : 'transient';
    this.details = { operation, errors: structuredClone(errors) };
  }
}
export class AccountNotProvisionedError extends AccountNotFoundError {
  constructor(
    public readonly account: import('../types').AccountReference | undefined,
    public readonly taskName: string
  ) {
    super(
      account
        ? `${taskName} requires an account provisioned at this seller. Call client.accounts.ensure first.`
        : `${taskName} requires a provisioned account reference. Call client.accounts.ensure and pass the account reference.`
    );
  }
}

/**
 * Error thrown when protocol communication fails
 */
export class ProtocolError extends ADCPError {
  readonly code = 'PROTOCOL_ERROR';

  constructor(
    public readonly protocol: 'mcp' | 'a2a',
    message: string,
    public readonly originalError?: Error
  ) {
    super(`${protocol.toUpperCase()} protocol error: ${message}`);
    this.details = { originalError };
  }
}

/**
 * Error thrown when validation fails
 */
export class ValidationError extends ADCPError {
  readonly code = 'VALIDATION_ERROR';

  constructor(
    public readonly field: string,
    public readonly value: unknown,
    public readonly constraint: string,
    /** Replaces the default `Validation failed for field …` message when given. */
    message?: string
  ) {
    super(message ?? `Validation failed for field '${field}': ${constraint}`);
    this.details = { field, value, constraint };
  }
}

/**
 * Whether the SDK refused this request locally, before sending any of it.
 *
 * Such errors carry `dispatched: false`: no bytes of the task's request left
 * this process, so the agent cannot have acted on it, and the failure says
 * nothing about the agent's health. The SDK sets the marker only on refusals it
 * decides by itself: request schema validation, the release and feature gates,
 * and the version refusals that follow already-known capabilities.
 *
 * Failures that involve contacting the agent are never marked, even when the
 * task itself was not sent: endpoint discovery, OAuth token fetches, and the
 * `get_adcp_capabilities` fetch (including its v2 rejection). A refused
 * connection, a 5xx or a 429 there is an agent failure. Refusing to resume a
 * deferred task is not marked either, because the original task was sent.
 *
 * This checks the property, not the class, so it also works when the error
 * crosses a bundle boundary where `instanceof` fails.
 */
export function isPreDispatchError(error: unknown): error is { readonly dispatched: false } {
  return typeof error === 'object' && error !== null && (error as { dispatched?: unknown }).dispatched === false;
}

/**
 * Error thrown when the client rejects a request against the request schema
 * before sending it. `dispatched` is always `false`.
 *
 * Carries the task name and the invalid field paths as JSON Pointers (`/` for
 * the root), never the submitted values. The message is the validator's
 * existing text, so callers that match on it keep working. To classify the
 * error without `instanceof`, check `code === 'VALIDATION_ERROR'` and
 * `dispatched === false`.
 *
 * Extends {@link ValidationError} (exported from the package root as
 * `ADCPValidationError`), so existing `instanceof` checks still match. `field`
 * is the first invalid path and `value` is always `undefined`.
 */
export class RequestValidationError extends ValidationError {
  /** The request was refused before it was sent. */
  readonly dispatched = false as const;

  /** JSON Pointers to the invalid fields, without their values. */
  readonly fields: readonly string[];

  constructor(
    /** The task whose request was refused, e.g. `sync_creatives`. */
    public readonly task: string,
    fields: readonly string[],
    constraint: string,
    message?: string
  ) {
    super(fields[0] ?? '/', undefined, constraint, message);
    this.fields = Object.freeze([...new Set(fields)]);
  }
}

/**
 * Error thrown when input handler is missing but required
 */
export class MissingInputHandlerError extends ADCPError {
  readonly code = 'MISSING_INPUT_HANDLER';

  constructor(
    public readonly taskId: string,
    public readonly question: string
  ) {
    super(`Agent requested input but no handler provided. Task: ${taskId}, Question: ${question}`);
  }
}

/**
 * Error thrown when conversation context is invalid
 */
export class InvalidContextError extends ADCPError {
  readonly code = 'INVALID_CONTEXT';

  constructor(
    public readonly contextId: string,
    reason: string
  ) {
    super(`Invalid conversation context '${contextId}': ${reason}`);
  }
}

/**
 * Error thrown when configuration is invalid
 */
export class ConfigurationError extends ADCPError {
  readonly code = 'CONFIGURATION_ERROR';

  constructor(
    message: string,
    public readonly configField?: string,
    cause?: unknown
  ) {
    super(`Configuration error: ${message}`);
    this.details = { configField };
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', { value: cause, configurable: true });
    }
  }
}

/**
 * OAuth metadata for authentication guidance
 */
export interface OAuthMetadataInfo {
  /** URL of the authorization endpoint */
  authorization_endpoint: string;
  /** URL of the token endpoint */
  token_endpoint: string;
  /** URL of the dynamic client registration endpoint (optional) */
  registration_endpoint?: string;
  /** Issuer identifier */
  issuer?: string;
}

/**
 * Subset of the parsed `WWW-Authenticate` challenge surfaced on
 * {@link AuthenticationRequiredError}. Mirrors the public shape of
 * `WWWAuthenticateChallenge` from `@adcp/sdk/auth/oauth` without forcing the
 * errors module to depend on the auth subtree (the dependency would invert
 * the build graph).
 *
 * `scheme` is lowercased per RFC 9110 §11.6.1.
 */
export interface AuthChallengeInfo {
  scheme: string;
  realm?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

/** Diagnostics from the original HTTP response to an SDK-signed request. */
export interface SignedRequestRejectionInfo {
  status: number;
  /** Untrusted seller text, already bounded and redacted by the transport. */
  responseBody?: string;
}

/**
 * Error thrown when authentication is required to access an MCP endpoint
 *
 * This error is thrown during MCP endpoint discovery when the server returns
 * a 401 Unauthorized response. The shape of the remediation depends on what
 * the 401 disclosed:
 *
 * - OAuth metadata (RFC 9728 PRM walk succeeded) → `oauthMetadata` set,
 *   message points at the authorization endpoint.
 * - A `WWW-Authenticate` challenge with a non-Bearer scheme (e.g. Basic
 *   behind an Apigee/Kong/AWS API GW gateway) → `challenge` set, message
 *   names the scheme and the SDK / CLI surface that configures it.
 * - Plain 401 with no metadata → fallback "provide auth_token" message.
 *
 * Consumers branching on `error.challenge?.scheme === 'basic'` can route
 * straight to `auth: { type: 'basic', username, password }` instead of
 * retrying Bearer indefinitely.
 *
 * @example
 * ```typescript
 * try {
 *   await client.getProducts({ brief: 'test' });
 * } catch (error) {
 *   if (error instanceof AuthenticationRequiredError) {
 *     if (error.challenge?.scheme === 'basic') {
 *       // Gateway-fronted agent — configure HTTP Basic
 *       reconnect({ auth: { type: 'basic', username, password } });
 *     } else if (error.oauthMetadata) {
 *       // Redirect user to OAuth flow
 *       const authUrl = error.oauthMetadata.authorization_endpoint;
 *       console.log(`Please authenticate at: ${authUrl}`);
 *     } else {
 *       console.log('Authentication required but no scheme metadata available');
 *     }
 *   }
 * }
 * ```
 */
export class AuthenticationRequiredError extends ADCPError {
  readonly code = 'AUTHENTICATION_REQUIRED';
  declare readonly signatureErrorCode?: keyof typeof RequestSigningErrorCodeMetadata;
  declare readonly requestSigned?: boolean;
  declare readonly status?: number;
  /**
   * Bounded, redacted seller diagnostic. Non-enumerable: do not forward this
   * untrusted text to automated prompts or treat it as recovery instructions.
   * Read it directly as `error.responseBody`; spread and JSON serialization omit it.
   */
  declare readonly responseBody?: string;

  constructor(
    public readonly agentUrl: string,
    public readonly oauthMetadata?: OAuthMetadataInfo,
    message?: string,
    public readonly challenge?: AuthChallengeInfo,
    signedRejection?: SignedRequestRejectionInfo
  ) {
    const defaultMessage = buildAuthRequiredMessage(agentUrl, oauthMetadata, challenge, !!signedRejection);
    super(message || defaultMessage);
    // `details` is serialized through error envelopes; surfacing the challenge
    // here lets non-CLI consumers (LLM agents, dashboards, programmatic
    // callers) branch on the scheme without instanceof-checking.
    this.details = { agentUrl, oauthMetadata, challenge };
    if (signedRejection) {
      this.requestSigned = true;
      this.status = signedRejection.status;
      const signatureCode = getRequestSignatureRejectionCode(challenge);
      if (signatureCode) this.signatureErrorCode = signatureCode;
      // Seller-controlled prose must not flow into serialized error reports.
      Object.defineProperty(this, 'responseBody', { value: signedRejection.responseBody, enumerable: false });
      this.details = { agentUrl, challenge, requestSigned: true, status: this.status };
    }
  }

  /**
   * Check if OAuth authentication is available
   */
  get hasOAuth(): boolean {
    return this.oauthMetadata !== undefined;
  }

  /**
   * Get the authorization URL if OAuth is available
   */
  get authorizationUrl(): string | undefined {
    return this.oauthMetadata?.authorization_endpoint;
  }

  /**
   * Lowercased scheme from the `WWW-Authenticate` challenge, when present.
   * `'basic'` is the common non-OAuth case — gateway-fronted agents speaking
   * RFC 7617.
   */
  get suggestedScheme(): string | undefined {
    return this.challenge?.scheme;
  }
}

/**
 * A configured non-interactive credential reached the agent and was rejected.
 * The transport error is retained as a non-enumerable cause so reflected
 * credential material from an untrusted 401 body cannot enter JSON reports.
 */
export class AuthenticationCredentialsRejectedError extends AuthenticationRequiredError {
  readonly subCode = 'credentials_rejected' as const;

  constructor(agentUrl: string, cause?: unknown) {
    const safeAgentUrl = sanitizeAgentUrlForError(agentUrl);
    super(
      safeAgentUrl,
      undefined,
      'The agent rejected the configured credential with HTTP 401. Verify or replace the saved credential and retry.'
    );
    this.name = 'AuthenticationCredentialsRejectedError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        value: cause,
        enumerable: false,
        configurable: true,
      });
    }
  }
}

function sanitizeAgentUrlForError(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return 'invalid_url';
  }
}

/**
 * Build the default error message. Branches on what the 401 disclosed:
 * - non-Bearer challenge (Basic, Digest, …) → scheme-specific remediation
 * - OAuth metadata → point at the authorization endpoint
 * - nothing → fallback "provide auth_token"
 *
 * The Basic branch names both the SDK shape (`createTestClient({ auth: …
 * type: 'basic' })`) and the CLI shape (`--auth user:pass --auth-scheme
 * basic`) so the same error envelope serves library and CLI consumers.
 */
function buildAuthRequiredMessage(
  agentUrl: string,
  oauthMetadata: OAuthMetadataInfo | undefined,
  challenge: AuthChallengeInfo | undefined,
  requestSigned = false
): string {
  if (requestSigned || challenge?.scheme === 'signature') {
    const code = getRequestSignatureRejectionCode(challenge);
    const suggestion = code ? ` ${RequestSigningErrorCodeMetadata[code].suggestion}.` : '';
    return (
      `Authentication failed with HTTP 401 for ${sanitizeAgentUrlForError(agentUrl)}. ` +
      (requestSigned ? 'The seller rejected an SDK-signed request' : 'The seller requires a valid request signature') +
      (code ? ` (${code})` : '') +
      '. Check signature verification and key discovery (brand_json_url → agents[] → jwks_uri).' +
      (requestSigned && !challenge
        ? ' No authentication challenge was returned; check configured credentials too.'
        : '') +
      suggestion +
      (requestSigned ? ' A bounded seller diagnostic is available on responseBody when captured.' : '')
    );
  }
  if (challenge && challenge.scheme !== 'bearer') {
    if (challenge.scheme === 'basic') {
      return (
        `Authentication required for ${agentUrl}. Agent (or its fronting gateway) speaks HTTP Basic ` +
        `(RFC 7617). Configure via createTestClient({ auth: { type: 'basic', username, password } }) ` +
        `— or from the CLI, --auth <user:pass> --auth-scheme basic.`
      );
    }
    // Digest / Negotiate / NTLM / vendor schemes: we don't have first-class
    // support but the scheme name in the message saves a discovery round-trip.
    const realmHint = challenge.realm ? ` (realm: ${challenge.realm})` : '';
    return (
      `Authentication required for ${agentUrl}. Agent speaks ${challenge.scheme}${realmHint}, ` +
      `which is not natively supported by @adcp/sdk. Configure auth at the transport layer ` +
      `(custom fetch wrapper, reverse-proxy header injection) or contact the agent operator ` +
      `about Bearer / Basic / OAuth support.`
    );
  }
  if (oauthMetadata) {
    return `Authentication required for ${agentUrl}. OAuth available at: ${oauthMetadata.authorization_endpoint}`;
  }
  return `Authentication required for ${agentUrl}. No OAuth metadata available - provide auth_token in agent config.`;
}

function getRequestSignatureRejectionCode(challenge: AuthChallengeInfo | undefined) {
  if (challenge?.scheme !== 'signature' || !challenge.error) return undefined;
  return Object.prototype.hasOwnProperty.call(RequestSigningErrorCodeMetadata, challenge.error)
    ? (challenge.error as keyof typeof RequestSigningErrorCodeMetadata)
    : undefined;
}

/**
 * Error thrown when a request reused an `idempotency_key` with a different
 * canonical payload within the seller's replay window.
 *
 * Recovery: `correctable` — reconcile the prior operation by natural key
 * before deciding whether this is a genuinely new intent. Do not blindly mint
 * a fresh key: a conflict may span an SDK replay-identity upgrade after the
 * original operation already succeeded.
 *
 * @example
 * ```typescript
 * try {
 *   await client.createMediaBuy({...});
 * } catch (error) {
 *   if (error instanceof IdempotencyConflictError) {
 *     // Look up the prior operation by its natural key before deciding
 *     // whether a new intent should receive a fresh idempotency key.
 *   }
 * }
 * ```
 */
export class IdempotencyConflictError extends ADCPError {
  readonly code = 'IDEMPOTENCY_CONFLICT';

  // Exposed via the getter so `console.log(err)` and JSON.stringify don't
  // leak the key (it's a retry-pattern oracle within the seller's TTL).
  // Callers reading `err.idempotencyKey` get it normally.
  readonly idempotencyKey: string | undefined;

  constructor(idempotencyKey: string | undefined, message?: string) {
    super(
      message ||
        'idempotency_key was used earlier with a different canonical payload. ' +
          'Reconcile the prior operation by natural key before creating any new intent; do not blindly retry with a fresh key.'
    );
    Object.defineProperty(this, 'idempotencyKey', {
      value: idempotencyKey,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
}

/**
 * Error thrown when a request carries an `idempotency_key` that is past the
 * seller's declared replay window (plus clock-skew tolerance).
 *
 * Recovery: `correctable`. If the caller knows the prior call succeeded
 * (e.g., they saw the response once, then crashed), they SHOULD fall back
 * to a natural-key lookup (e.g., `get_media_buys` by
 * `context.internal_campaign_id`) rather than minting a new key — otherwise
 * the seller treats the new request as fresh and silently creates a duplicate.
 *
 * If the caller doesn't know whether the prior call succeeded, a fresh key
 * is safe.
 */
export class IdempotencyExpiredError extends ADCPError {
  readonly code = 'IDEMPOTENCY_EXPIRED';

  // Non-enumerable so `console.log(err)` / JSON.stringify don't leak it —
  // same reasoning as IdempotencyConflictError.idempotencyKey.
  readonly idempotencyKey: string | undefined;

  constructor(idempotencyKey: string | undefined, message?: string) {
    super(
      message ||
        "idempotency_key is past the seller's replay window. " +
          'If you know the prior call succeeded, look up the resource by natural key before retrying. Otherwise, mint a fresh UUID v4.'
    );
    Object.defineProperty(this, 'idempotencyKey', {
      value: idempotencyKey,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
}

export interface FeatureUnsupportedErrorOptions {
  message?: string;
  details?: Record<string, unknown>;
}

export type ClientPreflightAdcpErrorRecovery = 'transient' | 'correctable' | 'terminal';

/**
 * Protocol-shaped error metadata attached to SDK-local preflight throws.
 * Mirrors the public `TaskResult.adcpError` fields without importing core
 * task types into the errors module.
 */
export interface ClientPreflightAdcpErrorInfo {
  code: string;
  message: string;
  recovery?: ClientPreflightAdcpErrorRecovery;
  field?: string;
  suggestion?: string;
  details?: Record<string, unknown>;
}

export interface ProtocolFeatureUnsupportedErrorOptions extends FeatureUnsupportedErrorOptions {
  field?: string;
  suggestion?: string;
  recovery?: ClientPreflightAdcpErrorRecovery;
}

export const SDK_ERROR_TO_PROTOCOL_ERROR_CODE = {
  FEATURE_UNSUPPORTED: 'UNSUPPORTED_FEATURE',
} as const;

export function mapSdkErrorCodeToProtocolErrorCode(code: string): string | undefined {
  return SDK_ERROR_TO_PROTOCOL_ERROR_CODE[code as keyof typeof SDK_ERROR_TO_PROTOCOL_ERROR_CODE];
}

/**
 * Error thrown when a required feature is not supported by the seller or by
 * the configured AdCP version.
 */
export class FeatureUnsupportedError extends ADCPError {
  readonly code: string = 'FEATURE_UNSUPPORTED';
  /**
   * Every construction site is a local gate that runs before the task is sent.
   * A future site that throws after a send must not use this class as is.
   */
  readonly dispatched = false as const;

  constructor(
    public readonly unsupportedFeatures: string[],
    public readonly declaredFeatures: string[],
    public readonly agentUrl?: string,
    options: FeatureUnsupportedErrorOptions = {}
  ) {
    const missing = unsupportedFeatures.join(', ');
    const declared = declaredFeatures.length > 0 ? declaredFeatures.join(', ') : '(none)';
    const urlPart = agentUrl ? ` at ${agentUrl}` : '';
    super(options.message ?? `Seller${urlPart} does not support: ${missing}\n  Declared features: ${declared}`);
    this.details = {
      unsupported_features: unsupportedFeatures,
      declared_features: declaredFeatures,
      ...(options.details ?? {}),
    };
  }
}

/**
 * Version-gate error for requests that use a protocol feature outside the
 * configured AdCP release. Kept as a FeatureUnsupportedError subclass so
 * existing catch sites keep working, while `code` carries the AdCP wire code
 * expected by probe/recovery layers.
 */
export class ProtocolFeatureUnsupportedError extends FeatureUnsupportedError {
  readonly code: string = 'UNSUPPORTED_FEATURE';

  readonly adcpError: ClientPreflightAdcpErrorInfo;

  constructor(
    unsupportedFeatures: string[],
    declaredFeatures: string[],
    agentUrl?: string,
    options: ProtocolFeatureUnsupportedErrorOptions = {}
  ) {
    super(unsupportedFeatures, declaredFeatures, agentUrl, options);
    this.adcpError = {
      code: this.code,
      message: this.message,
      recovery: options.recovery ?? 'correctable',
      ...(options.field && { field: options.field }),
      ...(options.suggestion && { suggestion: options.suggestion }),
      ...(isRecord(this.details) && { details: this.details }),
    };
  }
}

export function getClientPreflightAdcpError(error: unknown): ClientPreflightAdcpErrorInfo | undefined {
  if (error instanceof ProtocolFeatureUnsupportedError) {
    return error.adcpError;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Error thrown when a response body exceeds the `maxResponseBytes` cap on the
 * transport — 4 MiB by default on every MCP and A2A call path. It prevents a
 * hostile or merely careless agent from buffering a large reply before schema
 * validation runs.
 *
 * Raised on three paths: a declared `Content-Length` over the cap, a one-shot
 * body that crosses the cap mid-stream, and a `text/event-stream` response
 * whose single event exceeds the cap or whose cumulative octets exceed the
 * call's stream budget. Nothing is truncated — the read fails.
 *
 * Recovery: `terminal` from the SDK's view — repeating the call against the
 * same agent will hit the same cap. The buyer's options are to widen the
 * cap (per-call `transport.maxResponseBytes`) when the agent's payload is
 * legitimately large, or to flag the agent as misbehaving.
 */
export class ResponseTooLargeError extends ADCPError {
  readonly code = 'RESPONSE_TOO_LARGE';

  constructor(
    public readonly limit: number,
    public readonly bytesRead: number,
    public readonly url: string,
    /**
     * The parsed value of the `Content-Length` response header when the cap
     * was tripped on the pre-check (before any body bytes were read). Undefined
     * when the response was streamed and exceeded the cap mid-flight, or when
     * the server omitted the header.
     */
    public readonly contentLengthHeader?: number
  ) {
    super(
      contentLengthHeader !== undefined
        ? `Response body declared ${contentLengthHeader} bytes, exceeds response size cap of ${limit} (${url}). Raise transport.maxResponseBytes per client or per call to allow larger responses.`
        : `Response body exceeded response size cap of ${limit} after reading ${bytesRead} bytes (${url}). Raise transport.maxResponseBytes per client or per call to allow larger responses.`
    );
    this.details = { limit, bytesRead, url, contentLengthHeader };
  }
}

/**
 * Error thrown when an agent rate-limits the SDK's endpoint discovery: a
 * probe answered HTTP 429, or HTTP 503 with a `Retry-After` header.
 *
 * Discovery stops at the first such probe instead of trying the remaining
 * candidate URLs, which would only spend more of the seller's request budget.
 * The rate limit says nothing about whether `agent_uri` is correct.
 *
 * Recovery: `transient`. Wait `retryAfterMs` (when the agent sent
 * `Retry-After`) and retry.
 */
export class AgentRateLimitedError extends ADCPError {
  readonly code = 'RATE_LIMITED';
  /** The probed URL, without credentials, query or fragment. */
  readonly agentUrl: string;
  /** `Retry-After` as the agent sent it. Set only when it is valid delta-seconds or an HTTP-date. */
  readonly retryAfter?: string;
  /** Delay from `Retry-After`, in milliseconds. */
  readonly retryAfterMs?: number;

  constructor(
    agentUrl: string,
    public readonly status: number,
    retryAfter?: string,
    cause?: unknown
  ) {
    const safeAgentUrl = sanitizeAgentUrlForError(agentUrl);
    const retryAfterMs = parseRetryAfterMs(retryAfter);
    const validRetryAfter = retryAfterMs === undefined ? undefined : retryAfter?.trim();
    const retryHint =
      retryAfterMs === undefined
        ? 'No usable Retry-After header; back off before retrying.'
        : `Retry-After: ${validRetryAfter} (${Math.ceil(retryAfterMs / 1000)}s).`;
    super(
      `Agent rate limited MCP endpoint discovery: HTTP ${status} from ${safeAgentUrl}. ${retryHint} ` +
        `Discovery stopped at this probe to avoid spending more of the agent's request budget; ` +
        `this does not indicate a wrong agent_uri.`
    );
    this.agentUrl = safeAgentUrl;
    if (retryAfterMs !== undefined) {
      this.retryAfter = validRetryAfter;
      this.retryAfterMs = retryAfterMs;
    }
    this.details = {
      agentUrl: safeAgentUrl,
      status,
      ...(retryAfterMs !== undefined && { retryAfter: validRetryAfter, retryAfterMs }),
    };
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', { value: cause, enumerable: false, configurable: true });
    }
  }
}

function parseRetryAfterMs(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (/^\d{1,10}$/.test(trimmed)) return Number(trimmed) * 1000;
  // IMF-fixdate (RFC 9110 §5.6.7). Anything looser is not echoed into messages.
  if (!/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(trimmed)) return undefined;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/**
 * Error thrown when an `update_media_buy` request is rejected because the
 * action it maps to isn't currently allowed on the buy (AdCP 3.1, RFC #4480).
 *
 * Typed `details` payload follows `error-details/action-not-allowed.json`:
 * `attempted_action`, `reason`, optional `currently_available_actions[]`.
 *
 * Recovery branches on `reason`:
 *  - `wrong_status`: transition the buy (or wait) to an allowed status.
 *  - `not_supported_on_product`: terminal for this buy; pick a different
 *    product for future buys that need the action.
 *  - `not_supported_on_buy`: terminal; renegotiate buy terms.
 *  - `mode_mismatch`: `recovery` is set to a typed hint indicating the
 *    required flow (`createProposal`, `waitForApproval`, `reissueAsDirect`)
 *    instead of a plain retry.
 */
export class ActionNotAllowedError extends ADCPError {
  readonly code = 'ACTION_NOT_ALLOWED';

  readonly attemptedAction: ActionNotAllowedErrorDetails['attempted_action'];
  readonly reason: ActionNotAllowedErrorDetails['reason'];
  readonly currentlyAvailableActions: ReadonlyArray<ActionNotAllowedAvailableAction>;
  readonly recovery?: ActionNotAllowedRecovery;

  constructor(detailsPayload: ActionNotAllowedErrorDetails, message?: string) {
    super(message ?? buildActionNotAllowedMessage(detailsPayload));
    this.attemptedAction = detailsPayload.attempted_action;
    this.reason = detailsPayload.reason;
    this.currentlyAvailableActions = detailsPayload.currently_available_actions ?? [];
    this.recovery = detailsPayload.reason === 'mode_mismatch' ? buildModeMismatchRecovery(detailsPayload) : undefined;
    this.details = detailsPayload;
  }
}

/**
 * Inline copy of the structured payload - duplicated here rather than
 * imported from `media-buy/types` to keep the errors module free of
 * cross-module imports (matches the convention used for the other typed
 * errors in this file).
 */
export interface ActionNotAllowedErrorDetails {
  attempted_action: ActionNotAllowedAttemptedAction;
  reason: ActionNotAllowedReasonValue;
  currently_available_actions?: ActionNotAllowedAvailableAction[];
}

export type ActionNotAllowedReasonValue =
  | 'wrong_status'
  | 'not_supported_on_product'
  | 'not_supported_on_buy'
  | 'mode_mismatch';

export type ActionNotAllowedAttemptedAction = string;

export interface ActionNotAllowedAvailableAction {
  action: ActionNotAllowedAttemptedAction;
  mode: 'self_serve' | 'conditional_self_serve' | 'seller_managed' | 'requires_proposal' | 'requires_approval';
  sla?: unknown;
  terms_ref?: string;
}

export type ActionNotAllowedRecovery =
  | { kind: 'createProposal'; message: string }
  | { kind: 'waitForApproval'; message: string }
  | { kind: 'waitForTask'; message: string }
  | { kind: 'reissueAsDirect'; message: string };

function buildActionNotAllowedMessage(details: ActionNotAllowedErrorDetails): string {
  const prefix = `update_media_buy rejected: \`${details.attempted_action}\` not allowed (${details.reason}).`;
  switch (details.reason) {
    case 'wrong_status':
      return `${prefix} transition the buy to an allowed status before retrying.`;
    case 'not_supported_on_product':
      return `${prefix} product does not declare this action; pick a different product for future buys needing it.`;
    case 'not_supported_on_buy':
      return `${prefix} buy was negotiated without this capability; renegotiate buy terms.`;
    case 'mode_mismatch':
      return `${prefix} mode shifted between preflight and dispatch; re-issue through the appropriate flow indicated by available_actions.`;
  }
}

function buildModeMismatchRecovery(details: ActionNotAllowedErrorDetails): ActionNotAllowedRecovery | undefined {
  const match = details.currently_available_actions?.find(a => a.action === details.attempted_action);
  if (!match) return undefined;
  switch (match.mode) {
    case 'seller_managed':
      return {
        kind: 'waitForTask',
        message: 'Use the declared task and follow its submitted/working/completed lifecycle.',
      };
    case 'requires_proposal':
      return {
        kind: 'createProposal',
        message:
          `seller now resolves \`${details.attempted_action}\` as requires_proposal. ` +
          'reissue via the proposal lifecycle (`create_proposal` / `finalize_proposal`).',
      };
    case 'requires_approval':
      return {
        kind: 'waitForApproval',
        message:
          `seller now resolves \`${details.attempted_action}\` as requires_approval. ` +
          'expect an async approval callback rather than a direct response.',
      };
    case 'conditional_self_serve':
      return {
        kind: 'reissueAsDirect',
        message:
          `seller resolves \`${details.attempted_action}\` as conditional_self_serve: ` +
          'small mutations clear automatically, larger ones queue. retry; expect a possible async escalation.',
      };
    case 'self_serve':
      return {
        kind: 'reissueAsDirect',
        message: `seller resolves \`${details.attempted_action}\` as self_serve. retry the same request.`,
      };
  }
}

/**
 * Reason the v3 guard refused a mutating dispatch.
 * - `version`: seller's `major_versions` does not include 3
 * - `idempotency`: seller reports v3 but omits the required
 *   `adcp.idempotency.replay_ttl_seconds` declaration
 * - `synthetic`: agent lacks the required AdCP 3 discovery tool.
 */
export type VersionUnsupportedReason = 'version' | 'idempotency' | 'synthetic';

export interface VersionUnsupportedErrorOptions {
  /**
   * Pass `false` only where no bytes of the task's request left the process.
   * See {@link isPreDispatchError}.
   */
  dispatched?: false;
}

/**
 * Error thrown when a mutating call would dispatch to a seller whose
 * capabilities cannot be corroborated as v3. Provides an explicit
 * pre-flight signal so callers don't silently mutate state on agents
 * that have not negotiated the expected major version.
 *
 * Agent URL is exposed on the instance (`agentUrl`) but omitted from the
 * default message to avoid leaking seller identity into shared log sinks.
 */
export class VersionUnsupportedError extends ADCPError {
  readonly code = 'VERSION_UNSUPPORTED';
  /**
   * `false` when the SDK refused the task locally from already-known
   * capabilities and sent nothing for it. Absent when the refusal came from a
   * capabilities response the agent just returned, or when it refuses to resume
   * a task that was already sent. See {@link isPreDispatchError}.
   */
  declare readonly dispatched?: false;

  constructor(
    public readonly taskType: string,
    public readonly reason: VersionUnsupportedReason,
    public readonly actualVersion: 'v2' | 'v3',
    public readonly agentUrl?: string,
    options: VersionUnsupportedErrorOptions = {}
  ) {
    super(
      (taskType === 'get_adcp_capabilities'
        ? 'Cannot discover supported AdCP capabilities: '
        : `Refusing to dispatch task '${taskType}': `) + VersionUnsupportedError.explain(reason, actualVersion)
    );
    if (options.dispatched === false) {
      Object.defineProperty(this, 'dispatched', { value: false, enumerable: true });
    }
  }

  private static explain(reason: VersionUnsupportedReason, actualVersion: 'v2' | 'v3'): string {
    switch (reason) {
      case 'version':
        return actualVersion === 'v2'
          ? 'AdCP 2 reached end of life on 2026-08-01. Upgrade the agent to AdCP 3. Migration and older SDK pins: https://github.com/adcontextprotocol/adcp-client/blob/main/docs/migration-drop-adcp-2.md'
          : `seller does not support the configured AdCP 3 release.`;
      case 'idempotency':
        return 'seller reports v3 but omits adcp.idempotency.replay_ttl_seconds (required by spec). Upgrade the agent to publish its replay guarantee. If your application does not require this guarantee, configure requireV3ForMutations: false.';
      case 'synthetic':
        return 'The agent does not advertise get_adcp_capabilities. AdCP 3 capability discovery is required; AdCP 2 compatibility has been removed.';
    }
  }
}

/**
 * Check if an error indicates a 401 Unauthorized response
 *
 * This helper centralizes the fragile logic of detecting 401 errors from
 * various sources (HTTP status codes, error messages, wrapped errors).
 * Used during endpoint discovery to detect authentication requirements.
 *
 * @param error - The error to check
 * @param got401Flag - Optional flag that was set by tracking HTTP responses
 * @returns true if the error appears to be a 401 authentication error
 */
export function is401Error(error: unknown, got401Flag = false): boolean {
  if (got401Flag) {
    return true;
  }

  if (!error) {
    return false;
  }

  // Check for status property (common in HTTP errors). MCP SDK's
  // `StreamableHTTPClientTransport` throws errors with the HTTP status on
  // `.code`, so we check that too.
  const errorObj = error as Record<string, unknown>;
  const status =
    (errorObj as { status?: number })?.status ||
    (errorObj as { response?: { status?: number } })?.response?.status ||
    (errorObj as { cause?: { status?: number } })?.cause?.status ||
    (errorObj as { code?: unknown })?.code;
  if (status === 401) {
    return true;
  }

  // Fall back to string matching in error message. Use word boundaries so
  // we don't misidentify things like "product prod-401-xyz" as an HTTP 401,
  // and require "Unauthorized" as a whole word rather than as a substring.
  const message = (errorObj as { message?: string })?.message || '';
  return /\b401\b/.test(message) || /\bunauthorized\b/i.test(message);
}

/**
 * Map a structured AdCP error (code + message) to a typed ADCPError subclass
 * when the code has a dedicated class. Returns `undefined` for codes that
 * don't have a typed mapping — callers should continue to use the untyped
 * `AdcpErrorInfo` for those.
 *
 * Pass the `idempotencyKey` the SDK sent so the constructed error carries it
 * for the caller's recovery logic. The server intentionally omits the key
 * from error bodies (it's a read-oracle), so the transport-layer caller is
 * the authoritative source.
 */
export function adcpErrorToTypedError(
  adcpError: { code: string; message?: string; details?: unknown },
  idempotencyKey?: string
): ADCPError | undefined {
  switch (adcpError.code) {
    case 'ACCOUNT_NOT_FOUND':
      return new AccountNotFoundError(adcpError.message);
    case 'ACCOUNT_SETUP_REQUIRED':
      return new AccountSetupRequiredError(adcpError.message);
    case 'ACCOUNT_PAYMENT_REQUIRED':
      return new AccountPaymentRequiredError(adcpError.message);
    case 'IDEMPOTENCY_CONFLICT':
      return new IdempotencyConflictError(idempotencyKey, adcpError.message);
    case 'IDEMPOTENCY_EXPIRED':
      return new IdempotencyExpiredError(idempotencyKey, adcpError.message);
    case 'ACTION_NOT_ALLOWED': {
      const parsed = parseActionNotAllowedDetails(adcpError.details);
      if (!parsed) return undefined;
      return new ActionNotAllowedError(parsed, adcpError.message);
    }
    default:
      return undefined;
  }
}

function parseActionNotAllowedDetails(raw: unknown): ActionNotAllowedErrorDetails | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const attempted = obj['attempted_action'];
  const reason = obj['reason'];
  if (typeof attempted !== 'string' || typeof reason !== 'string') return undefined;
  if (!isActionNotAllowedReason(reason)) return undefined;

  const rawList = obj['currently_available_actions'];
  let currently: ActionNotAllowedAvailableAction[] | undefined;
  if (Array.isArray(rawList)) {
    currently = [];
    for (const entry of rawList) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const action = e['action'];
      const mode = e['mode'];
      if (typeof action !== 'string' || typeof mode !== 'string') continue;
      if (!isActionMode(mode)) continue;
      const parsedEntry: ActionNotAllowedAvailableAction = { action, mode };
      if (typeof e['terms_ref'] === 'string') parsedEntry.terms_ref = e['terms_ref'];
      if (e['sla'] !== undefined) parsedEntry.sla = e['sla'];
      currently.push(parsedEntry);
    }
  }

  return {
    attempted_action: attempted,
    reason,
    currently_available_actions: currently,
  };
}

function isActionNotAllowedReason(value: string): value is ActionNotAllowedReasonValue {
  return (
    value === 'wrong_status' ||
    value === 'not_supported_on_product' ||
    value === 'not_supported_on_buy' ||
    value === 'mode_mismatch'
  );
}

function isActionMode(value: string): value is ActionNotAllowedAvailableAction['mode'] {
  return (
    value === 'self_serve' ||
    value === 'conditional_self_serve' ||
    value === 'seller_managed' ||
    value === 'requires_proposal' ||
    value === 'requires_approval'
  );
}

/**
 * Type guard to check if an error is an ADCP error
 */
export function isADCPError(error: unknown): error is ADCPError {
  return error instanceof ADCPError;
}

/**
 * Type guard to check if an error is a specific ADCP error type
 */
export function isErrorOfType<T extends ADCPError>(error: unknown, ErrorClass: new (...args: any[]) => T): error is T {
  return error instanceof ErrorClass;
}

/**
 * Utility to extract error information for logging/debugging
 */
export function extractErrorInfo(error: unknown): {
  message: string;
  code?: string;
  details?: unknown;
  stack?: string;
} {
  if (isADCPError(error)) {
    return {
      message: error.message,
      code: error.code,
      details: error.details,
      stack: error.stack,
    };
  }

  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    message: String(error),
  };
}

/**
 * Prepared fixture state was refused by the host authorizer.
 *
 * An authorization failure is an ACCESS-CONTROL error, not a grading
 * outcome, so the refused caller gets this and no `StoryboardResult` —
 * not a partial one, not a redacted one. It carries the machine refusal
 * code and nothing else: no fixture identities, no `seller_ids`, no
 * captures, no binding values, no request/response records, and no
 * results from steps that ran before the grant was revoked.
 *
 * The complete, unredacted record — including the synthesized
 * `prepared_fixtures_authorization` check, `fixture_resolutions` with
 * `seller_ids`, and exact request/response records — is handed to the
 * host's `prepared_fixtures_audit_sink` before this is thrown. Where no
 * sink is configured the record is simply not produced to anyone.
 *
 * Hosted entry points should surface this as a 403-style denial.
 */
export class PreparedFixturesDeniedError extends ADCPError {
  readonly code = 'PREPARED_FIXTURES_DENIED';

  constructor(
    /**
     * Machine refusal code: `authorizer_required` | `untrusted_state` |
     * `contract_version_mismatch` | `authorizer_denied` |
     * `binding_mismatch` | `unauthorized_metadata`.
     */
    public readonly refusalCode: string
  ) {
    super(`prepared fixture state was refused by the configured authorizer (${refusalCode})`);
    // Deliberately the code alone. Anything derived from the prepared
    // graph — including which binding field differed — belongs in the
    // audit record, not in an error the refused caller can read.
    this.details = { refusal_code: refusalCode };
  }
}

// ====== Reporting subscriptions (experimental `media_buy.reporting_subscriptions`, AdCP 3.3) ======
// Codes and recovery classes follow the shared vocabulary in the spec repository
// (`static/compliance/source/test-vectors/reporting-subscriptions/error-codes.json`), which the Python SDK uses too.

/** How to recover from an SDK error: the same vocabulary as {@link ClientPreflightAdcpErrorRecovery}. */
export type AdcpErrorRecovery = ClientPreflightAdcpErrorRecovery;

/**
 * Codes a buyer-side reporting-subscription refusal or failure carries.
 *
 * @experimental Reporting subscriptions (AdCP 3.3).
 */
export type ReportingSubscriptionErrorCode =
  | 'SUBSCRIPTION_WOULD_DEACTIVATE'
  | 'DESTINATION_WOULD_REVOKE'
  | 'SUBSCRIPTION_ID_CLASH'
  | 'SUBSCRIPTION_OPERATOR_SCOPE_REQUIRED'
  | 'SUBSCRIPTION_SELECTOR_UNMATCHED'
  | 'SUBSCRIPTION_CONFLICT_EXHAUSTED'
  | 'SUBSCRIPTION_READBACK_MISMATCH';

/** Codes the SDK raises only before sending anything, so they always carry `dispatched: false`. */
const REPORTING_SUBSCRIPTION_PRE_DISPATCH: ReadonlySet<ReportingSubscriptionErrorCode> = new Set([
  'SUBSCRIPTION_WOULD_DEACTIVATE',
  'DESTINATION_WOULD_REVOKE',
  'SUBSCRIPTION_ID_CLASH',
  'SUBSCRIPTION_OPERATOR_SCOPE_REQUIRED',
  'SUBSCRIPTION_SELECTOR_UNMATCHED',
]);

const REPORTING_SUBSCRIPTION_RECOVERY: Readonly<Record<ReportingSubscriptionErrorCode, AdcpErrorRecovery>> = {
  SUBSCRIPTION_WOULD_DEACTIVATE: 'correctable',
  DESTINATION_WOULD_REVOKE: 'correctable',
  SUBSCRIPTION_ID_CLASH: 'correctable',
  SUBSCRIPTION_OPERATOR_SCOPE_REQUIRED: 'correctable',
  SUBSCRIPTION_SELECTOR_UNMATCHED: 'correctable',
  SUBSCRIPTION_CONFLICT_EXHAUSTED: 'transient',
  SUBSCRIPTION_READBACK_MISMATCH: 'terminal',
};

/** Options for {@link ReportingSubscriptionError}. */
export interface ReportingSubscriptionErrorOptions {
  cause?: unknown;
  /**
   * For a code outside the vocabulary (`INVALID_REQUEST` for a malformed facade call, or a seller's
   * wire code): its recovery. Vocabulary codes always take their fixed recovery.
   */
  recovery?: AdcpErrorRecovery;
  /** For a code outside the vocabulary: `false` when the SDK refused before sending. */
  dispatched?: false;
  /** `SUBSCRIPTION_WOULD_DEACTIVATE`: the `subscription_id` values the write would deactivate. */
  wouldDeactivate?: readonly string[];
  /** `DESTINATION_WOULD_REVOKE`: the `destination_id` values the write would revoke. */
  wouldRevoke?: readonly string[];
  /** `SUBSCRIPTION_ID_CLASH`: the clashing `delivery_config_id`. */
  deliveryConfigId?: string;
  /** `SUBSCRIPTION_ID_CLASH`: the account that uses it. */
  accountId?: string;
  /** `SUBSCRIPTION_SELECTOR_UNMATCHED`: offerings that fail on the fewest attributes, each with the attributes it fails. */
  nearest?: readonly unknown[];
  /** `SUBSCRIPTION_READBACK_MISMATCH`: the seller's readback of the subscription. */
  readback?: unknown;
  /** The applied `sync_principal` result, when the write was applied and a later check failed. */
  appliedResponse?: unknown;
  /** The last coherent `get_principal` readback, when one was observed. */
  current?: unknown;
}

/**
 * A buyer-side reporting-subscription refusal or failure, with a stable `code` and `recovery`.
 * The message's last sentence says how to fix it; it is display text, never parse it.
 *
 * `dispatched` is `false` for the codes the SDK raises only before sending a `sync_principal`
 * write (`SUBSCRIPTION_WOULD_DEACTIVATE`, `DESTINATION_WOULD_REVOKE`, `SUBSCRIPTION_ID_CLASH`,
 * `SUBSCRIPTION_OPERATOR_SCOPE_REQUIRED`, `SUBSCRIPTION_SELECTOR_UNMATCHED`), so the refused write
 * changed nothing at the seller ({@link isPreDispatchError}). It is absent for the others, where the
 * write may have reached the seller.
 *
 * Wire errors a seller returns (`INVALID_REQUEST`, `UNSUPPORTED_FEATURE`, `CONFLICT`) are not
 * redefined here.
 *
 * @experimental Reporting subscriptions (AdCP 3.3).
 */
export class ReportingSubscriptionError extends ADCPError {
  /** One of the vocabulary codes, `INVALID_REQUEST` for a malformed facade call, or a seller's wire code. */
  readonly code: ReportingSubscriptionErrorCode | (string & {});
  readonly recovery: AdcpErrorRecovery;
  /** `false` when the write was refused before it was sent; absent otherwise. */
  declare readonly dispatched?: false;
  declare readonly wouldDeactivate?: readonly string[];
  declare readonly wouldRevoke?: readonly string[];
  declare readonly deliveryConfigId?: string;
  declare readonly accountId?: string;
  declare readonly nearest?: readonly unknown[];
  declare readonly readback?: unknown;
  declare readonly appliedResponse?: unknown;
  declare readonly current?: unknown;

  constructor(
    code: ReportingSubscriptionErrorCode | (string & {}),
    message: string,
    options: ReportingSubscriptionErrorOptions = {}
  ) {
    super(message);
    this.code = code;
    const known = REPORTING_SUBSCRIPTION_RECOVERY[code as ReportingSubscriptionErrorCode];
    this.recovery = known ?? options.recovery ?? (code === 'INVALID_REQUEST' ? 'correctable' : 'transient');
    if (
      REPORTING_SUBSCRIPTION_PRE_DISPATCH.has(code as ReportingSubscriptionErrorCode) ||
      (known === undefined && options.dispatched === false)
    ) {
      Object.defineProperty(this, 'dispatched', { value: false, enumerable: true });
    }
    if (options.cause !== undefined) Object.defineProperty(this, 'cause', { value: options.cause, configurable: true });
    if (options.deliveryConfigId !== undefined) this.deliveryConfigId = options.deliveryConfigId;
    if (options.accountId !== undefined) this.accountId = options.accountId;
    if (options.nearest !== undefined) this.nearest = Object.freeze([...options.nearest]);
    if (options.wouldDeactivate !== undefined) this.wouldDeactivate = Object.freeze([...options.wouldDeactivate]);
    if (options.wouldRevoke !== undefined) this.wouldRevoke = Object.freeze([...options.wouldRevoke]);
    if (options.readback !== undefined) this.readback = options.readback;
    if (options.appliedResponse !== undefined) this.appliedResponse = options.appliedResponse;
    if (options.current !== undefined) this.current = options.current;
    this.details = {
      code,
      ...(this.wouldDeactivate ? { would_deactivate: this.wouldDeactivate } : {}),
      ...(this.wouldRevoke ? { would_revoke: this.wouldRevoke } : {}),
      ...(this.deliveryConfigId !== undefined ? { delivery_config_id: this.deliveryConfigId } : {}),
      ...(this.accountId !== undefined ? { account_id: this.accountId } : {}),
      ...(this.nearest ? { nearest: this.nearest } : {}),
    };
  }
}

/**
 * Codes for a coverage computation that cannot run on its input.
 *
 * @experimental Reporting subscriptions (AdCP 3.3).
 */
export type CoverageInputErrorCode =
  | 'COVERAGE_INPUT_INCOMPLETE'
  | 'COVERAGE_INPUT_INVALID'
  | 'COVERAGE_BUDGET_EXCEEDED';

/**
 * The specific cause of a {@link CoverageInputError}: `missing_*` details go with
 * `COVERAGE_INPUT_INCOMPLETE`, `invalid_*` details with `COVERAGE_INPUT_INVALID`.
 * `COVERAGE_BUDGET_EXCEEDED` has none.
 *
 * @experimental Reporting subscriptions (AdCP 3.3).
 */
export type CoverageInputErrorDetail =
  | 'missing_account_timezone'
  | 'missing_source_timezone'
  | 'missing_previous_timezone'
  | 'missing_standard_dimensions'
  | 'missing_status_retention_days'
  | 'missing_version_configuration'
  | 'missing_destination_method'
  | 'invalid_timezone'
  | 'invalid_period_duration'
  | 'invalid_instant'
  | 'invalid_input';

/**
 * The coverage rule cannot be evaluated on this input: a value it needs is missing
 * (`COVERAGE_INPUT_INCOMPLETE`), a value it reads is malformed (`COVERAGE_INPUT_INVALID`), or the
 * result would exceed the caller's budget (`COVERAGE_BUDGET_EXCEEDED`). `detail` names the cause.
 * Coverage is a local computation, so the error never carries `dispatched`. The SDK fails closed: it
 * never returns a partial owed set.
 *
 * @experimental Reporting subscriptions (AdCP 3.3).
 */
export class CoverageInputError extends ADCPError {
  readonly code: CoverageInputErrorCode;
  readonly recovery = 'correctable' as const;
  declare readonly detail?: CoverageInputErrorDetail;

  constructor(code: CoverageInputErrorCode, message: string, detail?: CoverageInputErrorDetail) {
    super(message);
    this.code = code;
    if (detail !== undefined) this.detail = detail;
    this.details = { code, ...(detail !== undefined ? { detail } : {}) };
  }
}

/**
 * Codes for a seller-side reporting-subscription engine failure at run time.
 *
 * - `SUBSCRIPTION_STATE_CONFLICT`: concurrent reconciles kept winning the engine store's
 *   compare-and-set; retry.
 * - `SUBSCRIPTION_STATE_CORRUPT`: the engine store returned a malformed document, a revision of the
 *   wrong type, or a repeating cursor.
 * - `SUBSCRIPTION_ROSTER_INCOMPLETE`: `listAuthorizedAccounts` repeated a cursor or did not finish
 *   within the page limit, so the engine refused a partial roster.
 * - `SUBSCRIPTION_HOST_FACT_INVALID`: a host hook returned a fact the engine cannot use, such as a
 *   re-grant without `regranted_at`, a timezone change without `timezone_changed_at`, or an instant
 *   that is not RFC 3339.
 *
 * @experimental Reporting subscriptions (AdCP 3.3).
 */
export type ReportingSubscriptionEngineErrorCode =
  | 'SUBSCRIPTION_STATE_CONFLICT'
  | 'SUBSCRIPTION_STATE_CORRUPT'
  | 'SUBSCRIPTION_ROSTER_INCOMPLETE'
  | 'SUBSCRIPTION_HOST_FACT_INVALID';

const REPORTING_SUBSCRIPTION_ENGINE_RECOVERY: Readonly<
  Record<ReportingSubscriptionEngineErrorCode, AdcpErrorRecovery>
> = {
  SUBSCRIPTION_STATE_CONFLICT: 'transient',
  SUBSCRIPTION_STATE_CORRUPT: 'terminal',
  SUBSCRIPTION_ROSTER_INCOMPLETE: 'correctable',
  SUBSCRIPTION_HOST_FACT_INVALID: 'correctable',
};

/**
 * A seller-side reporting-subscription engine failure at run time, with a stable `code` and
 * `recovery`. Configuration mistakes caught when the engine is created throw `PlatformConfigError`
 * instead, and coverage-rule input problems throw {@link CoverageInputError}.
 *
 * @experimental Reporting subscriptions (AdCP 3.3).
 */
export class ReportingSubscriptionEngineError extends ADCPError {
  readonly code: ReportingSubscriptionEngineErrorCode;
  readonly recovery: AdcpErrorRecovery;

  constructor(code: ReportingSubscriptionEngineErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message);
    this.code = code;
    this.recovery = REPORTING_SUBSCRIPTION_ENGINE_RECOVERY[code];
    if (options.cause !== undefined) Object.defineProperty(this, 'cause', { value: options.cause, configurable: true });
    this.details = { code };
  }
}
