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
 * Error thrown when authentication is required to access an MCP endpoint
 *
 * This error is thrown during MCP endpoint discovery when the server returns
 * a 401 Unauthorized response. If the server supports OAuth, the error includes
 * the OAuth metadata to help clients initiate the authentication flow.
 *
 * @example
 * ```typescript
 * try {
 *   await client.getProducts({ brief: 'test' });
 * } catch (error) {
 *   if (error instanceof AuthenticationRequiredError) {
 *     if (error.oauthMetadata) {
 *       // Redirect user to OAuth flow
 *       const authUrl = error.oauthMetadata.authorization_endpoint;
 *       console.log(`Please authenticate at: ${authUrl}`);
 *     } else {
 *       console.log('Authentication required but OAuth not available');
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
    message?: string
  ) {
    const defaultMessage = oauthMetadata
      ? `Authentication required for ${agentUrl}. OAuth available at: ${oauthMetadata.authorization_endpoint}`
      : `Authentication required for ${agentUrl}. No OAuth metadata available - provide auth_token in agent config.`;
    super(message || defaultMessage);
    this.details = { agentUrl, oauthMetadata };
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

/**
 * Error thrown when a required feature is not supported by the seller
 */
export class FeatureUnsupportedError extends ADCPError {
  readonly code = 'FEATURE_UNSUPPORTED';

  constructor(
    public readonly unsupportedFeatures: string[],
    public readonly declaredFeatures: string[],
    public readonly agentUrl?: string
  ) {
    const missing = unsupportedFeatures.join(', ');
    const declared = declaredFeatures.length > 0 ? declaredFeatures.join(', ') : '(none)';
    const urlPart = agentUrl ? ` at ${agentUrl}` : '';
    super(`Seller${urlPart} does not support: ${missing}\n  Declared features: ${declared}`);
  }
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
 * Reason the v3 guard refused a mutating dispatch.
 * - `version`: seller's `major_versions` does not include 3
 * - `idempotency`: seller reports v3 but omits the required
 *   `adcp.idempotency.replay_ttl_seconds` declaration
 * - `synthetic`: capabilities were synthesized from a tool list (no
 *   `get_adcp_capabilities` response) so the v3 claim is unverifiable
 */
export type VersionUnsupportedReason = 'version' | 'idempotency' | 'synthetic';

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
        return `capabilities were synthesized from a tool list — v3 claim is unverifiable.`;
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
  adcpError: { code: string; message?: string },
  idempotencyKey?: string
): ADCPError | undefined {
  switch (adcpError.code) {
    case 'IDEMPOTENCY_CONFLICT':
      return new IdempotencyConflictError(idempotencyKey, adcpError.message);
    case 'IDEMPOTENCY_EXPIRED':
      return new IdempotencyExpiredError(idempotencyKey, adcpError.message);
    default:
      return undefined;
  }
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
