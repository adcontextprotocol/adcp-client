// Custom error classes for ADCP client library

/**
 * Base class for all ADCP client errors
 */
export abstract class ADCPError extends Error {
  abstract readonly code: string;

  constructor(
    message: string,
    public details?: any
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
    public readonly value: any,
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

  // Check for status property (common in HTTP errors)
  const errorObj = error as any;
  const status = errorObj?.status || errorObj?.response?.status || errorObj?.cause?.status;
  if (status === 401) {
    return true;
  }

  // Fall back to string matching in error message
  // This is fragile but necessary since different SDKs format errors differently
  const message = errorObj?.message || '';
  return message.includes('401') || message.includes('Unauthorized');
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
  details?: any;
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
