// Custom error classes for ADCP client library

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
export class TaskTimeoutError extends ADCPError {
  readonly code = 'TASK_TIMEOUT';

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

  constructor(public readonly token: string) {
    super(`Task deferred with token: ${token}`);
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
    public readonly constraint: string
  ) {
    super(`Validation failed for field '${field}': ${constraint}`);
    this.details = { field, value, constraint };
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
    public readonly configField?: string
  ) {
    super(`Configuration error: ${message}`);
    this.details = { configField };
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

  constructor(
    public readonly agentUrl: string,
    public readonly oauthMetadata?: OAuthMetadataInfo,
    message?: string,
    public readonly challenge?: AuthChallengeInfo
  ) {
    const defaultMessage = buildAuthRequiredMessage(agentUrl, oauthMetadata, challenge);
    super(message || defaultMessage);
    // `details` is serialized through error envelopes; surfacing the challenge
    // here lets non-CLI consumers (LLM agents, dashboards, programmatic
    // callers) branch on the scheme without instanceof-checking.
    this.details = { agentUrl, oauthMetadata, challenge };
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
  challenge: AuthChallengeInfo | undefined
): string {
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

/**
 * Error thrown when a request reused an `idempotency_key` with a different
 * canonical payload within the seller's replay window.
 *
 * Recovery: `correctable` — the caller either reused a key by mistake (mint
 * a fresh UUID v4 for the new request) or re-planned with a different payload
 * (an agent whose LLM re-ran and emitted a different request must treat that
 * as a new intent, not a retry).
 *
 * @example
 * ```typescript
 * try {
 *   await client.createMediaBuy({...});
 * } catch (error) {
 *   if (error instanceof IdempotencyConflictError) {
 *     // Either the key was reused by mistake, or the agent re-planned with
 *     // a different payload. Mint a fresh key and try again.
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
          'Use a fresh UUID v4 for the new request, or resend the exact original payload to get the cached response.'
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
 * Error thrown when a response body exceeds the configured `maxResponseBytes`
 * cap on the transport. Surfaced when crawling untrusted agents (registries,
 * federated discovery layers) to prevent a hostile vendor from buffering a
 * large reply before schema validation runs.
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
        ? `Response body declared ${contentLengthHeader} bytes, exceeds maxResponseBytes cap of ${limit} (${url})`
        : `Response body exceeded maxResponseBytes cap of ${limit} after reading ${bytesRead} bytes (${url})`
    );
    this.details = { limit, bytesRead, url, contentLengthHeader };
  }
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
  mode: 'self_serve' | 'conditional_self_serve' | 'requires_proposal' | 'requires_approval';
  sla?: unknown;
  terms_ref?: string;
}

export type ActionNotAllowedRecovery =
  | { kind: 'createProposal'; message: string }
  | { kind: 'waitForApproval'; message: string }
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
 * - `synthetic`: @deprecated — kept in the union for downstream
 *   consumers that pattern-match on the union literal, but the SDK no
 *   longer emits it. Sellers whose capabilities are synthesized from
 *   `tools/list` are routed through the v2 adapter with a one-time
 *   warning; gate retry behavior on `SingleAgentClient.isSyntheticV2()`.
 */
export type VersionUnsupportedReason =
  | 'version'
  | 'idempotency'
  /** @deprecated SDK no longer emits this reason. See union JSDoc. */
  | 'synthetic';

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

  constructor(
    public readonly taskType: string,
    public readonly reason: VersionUnsupportedReason,
    public readonly actualVersion: 'v2' | 'v3',
    public readonly agentUrl?: string
  ) {
    super(
      `Refusing to dispatch mutating task '${taskType}': ` +
        VersionUnsupportedError.explain(reason, actualVersion) +
        ` Pass allowV2: true or requireV3ForMutations: false to override.`
    );
  }

  private static explain(reason: VersionUnsupportedReason, actualVersion: 'v2' | 'v3'): string {
    switch (reason) {
      case 'version':
        return `seller advertises major version '${actualVersion}' but v3 is required.`;
      case 'idempotency':
        return `seller reports v3 but omits adcp.idempotency.replay_ttl_seconds (required by spec).`;
      case 'synthetic':
        return `capabilities were synthesized from a tool list, v3 claim is unverifiable.`;
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
