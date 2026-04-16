// Core task execution engine for ADCP conversation flow
// Implements PR #78 async patterns: working/submitted/input-required/completed

import { randomUUID } from 'crypto';
import type { AgentConfig } from '../types';
import { ProtocolClient } from '../protocols';
import { getMCPTaskStatus, listMCPTasks } from '../protocols/mcp-tasks';
import { getAuthToken } from '../auth';
import { is401Error } from '../errors';
import type { Storage } from '../storage/interfaces';
import { responseValidator } from './ResponseValidator';
import { unwrapProtocolResponse, isAdcpError } from '../utils/response-unwrapper';
import { extractAdcpErrorInfo, extractCorrelationId } from '../utils/error-extraction';
import { normalizeGetProductsResponse } from '../utils/pricing-adapter';
import type {
  Message,
  InputRequest,
  InputHandler,
  ConversationContext,
  TaskOptions,
  TaskResult,
  TaskState,
  TaskStatus,
  TaskInfo,
  DeferredContinuation,
  SubmittedContinuation,
} from './ConversationTypes';
import { normalizeHandlerResponse, isDeferResponse, isAbortResponse } from '../handlers/types';
import { ProtocolResponseParser, ADCP_STATUS, type ADCPStatus } from './ProtocolResponseParser';
import type { Activity } from './AsyncHandler';
import { GovernanceMiddleware } from './GovernanceMiddleware';
import type { GovernanceConfig, GovernanceCheckResult } from './GovernanceTypes';
/**
 * Custom errors for task execution
 */
export class TaskTimeoutError extends Error {
  constructor(taskId: string, timeout: number) {
    super(`Task ${taskId} timed out after ${timeout}ms`);
    this.name = 'TaskTimeoutError';
  }
}

export class MaxClarificationError extends Error {
  constructor(taskId: string, maxAttempts: number) {
    super(`Task ${taskId} exceeded maximum clarification attempts: ${maxAttempts}`);
    this.name = 'MaxClarificationError';
  }
}

export class DeferredTaskError extends Error {
  constructor(public token: string) {
    super(`Task deferred with token: ${token}`);
    this.name = 'DeferredTaskError';
  }
}

export class InputRequiredError extends Error {
  constructor(question: string) {
    super(`Server requires input but no handler provided. Question: ${question}`);
    this.name = 'InputRequiredError';
  }
}

/**
 * Webhook manager for submitted tasks
 */
interface WebhookManager {
  generateUrl(taskId: string): string;
  registerWebhook(agent: AgentConfig, taskId: string, webhookUrl: string): Promise<void>;
  processWebhook(token: string, body: any): Promise<void>;
}

/**
 * Deferred task storage for client deferrals
 */
interface DeferredTaskState {
  taskId: string;
  contextId: string;
  agent: AgentConfig;
  taskName: string;
  params: any;
  messages: Message[];
  createdAt: number;
}

/**
 * Core task execution engine that handles the conversation loop with agents
 */
export class TaskExecutor {
  private responseParser: ProtocolResponseParser;
  private activeTasks = new Map<string, TaskState>();
  private conversationStorage?: Map<string, Message[]>;
  private governanceMiddleware?: GovernanceMiddleware;
  private lastKnownServerVersion?: 'v2' | 'v3';

  constructor(
    private config: {
      /** Default timeout for 'working' status (max 120s per PR #78) */
      workingTimeout?: number;
      /** Polling interval for 'working' status in milliseconds (default: 2000ms) */
      pollingInterval?: number;
      /** Default max clarification attempts */
      defaultMaxClarifications?: number;
      /** Enable conversation storage */
      enableConversationStorage?: boolean;
      /** Webhook manager for submitted tasks */
      webhookManager?: WebhookManager;
      /** Storage for deferred task state */
      deferredStorage?: Storage<DeferredTaskState>;
      /** Webhook URL template for protocol-level webhook support */
      webhookUrlTemplate?: string;
      /** Agent ID for webhook URL generation */
      agentId?: string;
      /** Webhook secret for HMAC authentication (min 32 chars) */
      webhookSecret?: string;
      /** Fail tasks when response schema validation fails (default: true) */
      strictSchemaValidation?: boolean;
      /** Log all schema validation violations to debug logs (default: true) */
      logSchemaViolations?: boolean;
      /** Filter out invalid products from get_products responses instead of rejecting the entire response (default: false) */
      filterInvalidProducts?: boolean;
      /** Global activity callback for observability */
      onActivity?: (activity: Activity) => void | Promise<void>;
      /** Governance configuration for buyer-side campaign governance */
      governance?: GovernanceConfig;
    } = {}
  ) {
    this.responseParser = new ProtocolResponseParser();
    if (config.enableConversationStorage) {
      this.conversationStorage = new Map();
    }
    if (config.governance) {
      this.governanceMiddleware = new GovernanceMiddleware(config.governance, config.onActivity);
    }
  }

  /**
   * Access the governance middleware for direct outcome reporting (async tasks).
   */
  getGovernanceMiddleware(): GovernanceMiddleware | undefined {
    return this.governanceMiddleware;
  }

  /**
   * Generate webhook URL for protocol-level webhook support
   */
  private generateWebhookUrl(taskName: string, operationId: string): string | undefined {
    if (!this.config.webhookUrlTemplate || !this.config.agentId) {
      return undefined;
    }

    return this.config.webhookUrlTemplate
      .replace(/{agent_id}/g, this.config.agentId)
      .replace(/{task_type}/g, taskName)
      .replace(/{operation_id}/g, operationId);
  }

  /**
   * Execute a task with an agent using PR #78 async patterns
   * Handles: working (keep SSE open), submitted (webhook), input-required (handler), completed
   */
  async executeTask<T = any>(
    agent: AgentConfig,
    taskName: string,
    params: any,
    inputHandler?: InputHandler,
    options: TaskOptions = {},
    serverVersion?: 'v2' | 'v3'
  ): Promise<TaskResult<T>> {
    if (serverVersion) this.lastKnownServerVersion = serverVersion;
    const taskId = options.contextId || randomUUID();
    const startTime = Date.now();
    const workingTimeout = this.config.workingTimeout || 120000; // 120s max per PR #78

    // Register task in active tasks
    const taskState: TaskState = {
      taskId,
      taskName,
      params,
      status: 'pending',
      messages: [],
      startTime,
      attempt: 0,
      maxAttempts: options.maxClarifications || this.config.defaultMaxClarifications || 3,
      options,
      agent: { id: agent.id, name: agent.name, protocol: agent.protocol },
    };
    this.activeTasks.set(taskId, taskState);

    // Emit task creation event
    this.emitTaskEvent(
      {
        taskId,
        status: 'submitted',
        taskType: taskName,
        createdAt: startTime,
        updatedAt: startTime,
      },
      agent.id
    );

    // Start streaming connection
    const debugLogs: any[] = [];

    // Generate webhook URL if template is configured
    const webhookUrl = this.generateWebhookUrl(taskName, taskId);

    // Governance state (scoped outside try so catch can access)
    let governanceCheckId: string | undefined;
    let governanceResult: GovernanceCheckResult | undefined;
    let effectiveParams = params;

    try {
      // Emit protocol_request activity
      await this.config.onActivity?.({
        type: 'protocol_request',
        operation_id: taskId,
        agent_id: agent.id,
        context_id: options.contextId,
        task_id: taskId,
        task_type: taskName,
        status: 'pending',
        payload: { params },
        timestamp: new Date().toISOString(),
      });

      // Run governance check if configured for this tool
      if (this.governanceMiddleware?.requiresCheck(taskName)) {
        const { result: govResult, params: adjustedParams } = await this.governanceMiddleware.checkProposed(
          taskName,
          params,
          debugLogs
        );

        // Governance always blocks on denial/unapplied conditions.
        const isBlocking = true;

        if (govResult.status === 'denied' && isBlocking) {
          return this.buildGovernanceResult<T>(
            'governance-denied',
            govResult,
            taskId,
            taskName,
            agent,
            startTime,
            debugLogs
          );
        }

        if (govResult.status === 'escalated' && isBlocking) {
          return this.buildGovernanceResult<T>(
            'governance-escalated',
            govResult,
            taskId,
            taskName,
            agent,
            startTime,
            debugLogs
          );
        }

        if (govResult.status === 'conditions' && !govResult.conditionsApplied && isBlocking) {
          return this.buildGovernanceResult<T>(
            'governance-denied',
            govResult,
            taskId,
            taskName,
            agent,
            startTime,
            debugLogs
          );
        }

        // Approved, or non-blocking mode (advisory/audit) allows execution to proceed
        governanceCheckId = govResult.checkId;
        governanceResult = govResult;
        effectiveParams = adjustedParams;
      }

      // Create initial message (uses effectiveParams which may have governance-applied conditions)
      const initialMessage: Message = {
        id: randomUUID(),
        role: 'user',
        content: { tool: taskName, params: effectiveParams },
        timestamp: new Date().toISOString(),
        metadata: { toolName: taskName, type: 'request' },
      };

      // Send initial request and get streaming response with webhook URL
      const response = await ProtocolClient.callTool(
        agent,
        taskName,
        effectiveParams,
        debugLogs,
        webhookUrl,
        this.config.webhookSecret,
        undefined,
        serverVersion
      );

      // Emit protocol_response activity
      const respStatus = this.responseParser.getStatus(response) as string | undefined;
      await this.config.onActivity?.({
        type: 'protocol_response',
        operation_id: taskId,
        agent_id: agent.id,
        context_id: options.contextId,
        task_id: taskId,
        task_type: taskName,
        status: respStatus,
        payload: response,
        timestamp: new Date().toISOString(),
      });

      // Add initial response message
      const responseMessage: Message = {
        id: randomUUID(),
        role: 'agent',
        content: response,
        timestamp: new Date().toISOString(),
        metadata: { toolName: taskName, type: 'response' },
      };

      const messages = [initialMessage, responseMessage];

      // Handle response based on status
      const result = await this.handleAsyncResponse<T>(
        agent,
        taskId,
        taskName,
        effectiveParams,
        response,
        messages,
        inputHandler,
        options,
        debugLogs,
        startTime
      );

      // Attach governance check result to the task result
      if (governanceResult) {
        result.governance = governanceResult;
      }

      // Report governance outcome if we had a governance check.
      // For async tasks (submitted/working), outcome reporting is deferred —
      // the caller reports via client.reportGovernanceOutcome() when the
      // task resolves through polling or webhooks.
      if (governanceCheckId && this.governanceMiddleware) {
        const govCtx = governanceResult?.governanceContext;
        if (result.status === 'completed' && govCtx) {
          result.governanceOutcome = await this.governanceMiddleware.reportOutcome(
            governanceCheckId,
            'completed',
            result.data as Record<string, unknown> | undefined,
            undefined,
            debugLogs,
            govCtx
          );
          if (!result.governanceOutcome) {
            result.governanceOutcomeError = 'Outcome reporting to governance agent failed';
          }
        } else if (result.error && govCtx) {
          result.governanceOutcome = await this.governanceMiddleware.reportOutcome(
            governanceCheckId,
            'failed',
            undefined,
            { message: result.error },
            debugLogs,
            govCtx
          );
          if (!result.governanceOutcome) {
            result.governanceOutcomeError = 'Outcome reporting to governance agent failed';
          }
        } else if (result.status === 'submitted' || result.status === 'working') {
          // Attach the check ID so callers can report outcome after async resolution
          result.governance = { ...(result.governance ?? {}), checkId: governanceCheckId } as GovernanceCheckResult;
        }
      }

      return result;
    } catch (error) {
      // Report failed outcome on error
      if (governanceCheckId && this.governanceMiddleware && governanceResult?.governanceContext) {
        await this.governanceMiddleware.reportOutcome(
          governanceCheckId,
          'failed',
          undefined,
          { message: (error as Error).message },
          debugLogs,
          governanceResult.governanceContext
        );
      }
      return this.createErrorResult<T>(taskId, agent, error, debugLogs, startTime);
    }
  }

  /**
   * Handle agent response based on ADCP status (PR #78)
   */
  private buildGovernanceResult<T>(
    status: 'governance-denied' | 'governance-escalated',
    govResult: GovernanceCheckResult,
    taskId: string,
    taskName: string,
    agent: AgentConfig,
    startTime: number,
    debugLogs: any[]
  ): TaskResult<T> {
    return {
      success: false,
      status,
      error: govResult.explanation || `Governance ${status}`,
      governance: govResult,
      metadata: {
        taskId,
        taskName,
        agent: { id: agent.id, name: agent.name, protocol: agent.protocol },
        responseTimeMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
        clarificationRounds: 0,
        status,
      },
      conversation: [],
      debug_logs: debugLogs,
    };
  }

  private async handleAsyncResponse<T>(
    agent: AgentConfig,
    taskId: string,
    taskName: string,
    params: any,
    response: any,
    messages: Message[],
    inputHandler?: InputHandler,
    options: TaskOptions = {},
    debugLogs: any[] = [],
    startTime: number = Date.now()
  ): Promise<TaskResult<T>> {
    const status = this.responseParser.getStatus(response) as ADCPStatus;

    switch (status) {
      case ADCP_STATUS.COMPLETED:
        // Task completed immediately
        const completedData = this.extractResponseData(response, debugLogs, taskName);
        this.updateTaskStatus(taskId, 'completed', completedData);

        const operationSuccess = this.isOperationSuccess(completedData);

        // Validate response against AdCP schema - validate extracted data, not protocol wrapper
        const validationResult = this.validateResponseSchema(completedData, taskName, debugLogs);

        // In strict mode, schema validation failures cause task to fail
        const finalSuccess = operationSuccess && validationResult.valid;
        const finalError = !finalSuccess
          ? validationResult.errors.length > 0
            ? `Schema validation failed: ${validationResult.errors.join('; ')}`
            : this.extractOperationError(completedData)
          : undefined;

        if (finalSuccess) {
          return {
            success: true as const,
            status: 'completed' as const,
            data: completedData,
            metadata: {
              taskId,
              taskName,
              agent: { id: agent.id, name: agent.name, protocol: agent.protocol },
              responseTimeMs: Date.now() - startTime,
              timestamp: new Date().toISOString(),
              clarificationRounds: 0,
              status: 'completed' as const,
            },
            conversation: messages,
            debug_logs: debugLogs,
          };
        }
        return {
          success: false as const,
          status: 'failed' as const,
          data: completedData,
          error: finalError ?? 'Unknown error',
          adcpError: extractAdcpErrorInfo(completedData),
          correlationId: extractCorrelationId(completedData),
          metadata: {
            taskId,
            taskName,
            agent: { id: agent.id, name: agent.name, protocol: agent.protocol },
            responseTimeMs: Date.now() - startTime,
            timestamp: new Date().toISOString(),
            clarificationRounds: 0,
            status: 'failed' as const,
          },
          conversation: messages,
          debug_logs: debugLogs,
        };

      case ADCP_STATUS.WORKING:
        // Server is processing - keep connection open for up to 120s
        return this.waitForWorkingCompletion<T>(
          agent,
          taskId,
          taskName,
          params,
          response,
          messages,
          inputHandler,
          options,
          debugLogs,
          startTime
        );

      case ADCP_STATUS.SUBMITTED:
        // Long-running task - set up webhook
        return this.setupSubmittedTask<T>(agent, taskId, taskName, response, messages, options, debugLogs, startTime);

      case ADCP_STATUS.INPUT_REQUIRED:
        // Server needs input - handler is mandatory
        return this.handleInputRequired<T>(
          agent,
          taskId,
          taskName,
          params,
          response,
          messages,
          inputHandler,
          options,
          debugLogs,
          startTime
        );

      case ADCP_STATUS.FAILED:
      case ADCP_STATUS.REJECTED:
      case ADCP_STATUS.CANCELED: {
        const failedData = this.extractResponseData(response, debugLogs, taskName);
        const adcpErrorInfo = extractAdcpErrorInfo(failedData);
        const hasStructuredError = !!adcpErrorInfo;
        const failedError = hasStructuredError
          ? this.extractOperationError(failedData)
          : response.error || response.message || `Task ${status}`;
        return {
          success: false as const,
          status: 'failed' as const,
          data: hasStructuredError ? failedData : undefined,
          error: typeof failedError === 'string' ? failedError : `Task ${status}`,
          adcpError: adcpErrorInfo,
          correlationId: extractCorrelationId(failedData),
          metadata: {
            taskId,
            taskName,
            agent: { id: agent.id, name: agent.name, protocol: agent.protocol },
            responseTimeMs: Date.now() - startTime,
            timestamp: new Date().toISOString(),
            clarificationRounds: 0,
            status: 'failed' as const,
          },
          conversation: messages,
          debug_logs: debugLogs,
        };
      }

      default:
        // Unknown status - treat as completed if we have data
        const defaultData = this.extractResponseData(response, debugLogs, taskName);
        if (
          defaultData &&
          (defaultData !== response || response.structuredContent || response.result || response.data)
        ) {
          const defaultSuccess = this.isOperationSuccess(defaultData);

          // Validate response against AdCP schema - validate extracted data, not protocol wrapper
          const defaultValidation = this.validateResponseSchema(defaultData, taskName, debugLogs);

          // In strict mode, schema validation failures cause task to fail
          const defaultFinalSuccess = defaultSuccess && defaultValidation.valid;
          const defaultFinalError = !defaultFinalSuccess
            ? defaultValidation.errors.length > 0
              ? `Schema validation failed: ${defaultValidation.errors.join('; ')}`
              : this.extractOperationError(defaultData)
            : undefined;

          if (defaultFinalSuccess) {
            return {
              success: true as const,
              status: 'completed' as const,
              data: defaultData,
              metadata: {
                taskId,
                taskName,
                agent: { id: agent.id, name: agent.name, protocol: agent.protocol },
                responseTimeMs: Date.now() - startTime,
                timestamp: new Date().toISOString(),
                clarificationRounds: 0,
                status: 'completed' as const,
              },
              conversation: messages,
              debug_logs: debugLogs,
            };
          }
          return {
            success: false as const,
            status: 'failed' as const,
            data: defaultData,
            error: defaultFinalError!,
            adcpError: extractAdcpErrorInfo(defaultData),
            correlationId: extractCorrelationId(defaultData),
            metadata: {
              taskId,
              taskName,
              agent: { id: agent.id, name: agent.name, protocol: agent.protocol },
              responseTimeMs: Date.now() - startTime,
              timestamp: new Date().toISOString(),
              clarificationRounds: 0,
              status: 'failed' as const,
            },
            conversation: messages,
            debug_logs: debugLogs,
          };
        } else {
          throw new Error(`Unknown status: ${status || 'undefined'}`);
        }
    }
  }

  /**
   * Extract response data from different protocol formats
   *
   * @internal Exposed for testing purposes
   */
  public extractResponseData(response: any, debugLogs?: any[], toolName?: string): any {
    // MCP error responses (isError: true) flow through here — the response unwrapper
    // extracts structured data (adcp_error, context, ext) from structuredContent or text

    // Use the shared response unwrapper utility
    // This handles MCP structuredContent, A2A artifacts (including HITL multi-artifact responses),
    // and various edge cases consistently
    try {
      // Log what type of response we're processing BEFORE unwrapping
      // This ensures we have debug visibility even if unwrapping fails
      if (response?.structuredContent) {
        this.logDebug(debugLogs, 'info', 'Processing MCP structuredContent response');
      } else if (response?.result?.artifacts) {
        const artifacts = response.result.artifacts;
        if (artifacts.length === 0) {
          this.logDebug(debugLogs, 'info', 'Processing A2A response with empty artifacts array');
        } else {
          // Calculate total part count across all artifacts
          const totalParts = artifacts.reduce((sum: number, artifact: any) => {
            return sum + (artifact.parts?.length || 0);
          }, 0);

          // Extract data keys from first part for debugging
          const firstPart = artifacts[0]?.parts?.[0];
          const dataKeys = firstPart?.data ? Object.keys(firstPart.data) : [];

          this.logDebug(debugLogs, 'info', 'Processing A2A artifact structure', {
            artifactCount: artifacts.length,
            partCount: totalParts,
            extractedFrom: artifacts.length > 1 ? 'multi-artifact (HITL)' : 'single-artifact',
            dataKeys,
          });
        }
      } else if (response?.data) {
        this.logDebug(debugLogs, 'info', 'Processing response.data field');
      } else {
        this.logDebug(debugLogs, 'info', 'Processing response without standard structure', {
          responseKeys: Object.keys(response || {}),
        });
      }

      // Now unwrap the response
      const unwrapped = unwrapProtocolResponse(response, toolName, undefined, {
        filterInvalidProducts: this.config.filterInvalidProducts,
      });

      // Log successful extraction with result details
      if (response?.structuredContent) {
        this.logDebug(debugLogs, 'info', 'Successfully extracted MCP data', {
          dataKeys: Object.keys(unwrapped || {}),
        });
      } else if (response?.result?.artifacts && response.result.artifacts.length > 0) {
        this.logDebug(debugLogs, 'info', 'Successfully extracted A2A data', {
          dataKeys: Object.keys(unwrapped || {}),
        });
      }

      return unwrapped;
    } catch (error) {
      this.logDebug(debugLogs, 'warning', 'Response unwrapper failed', {
        error: error instanceof Error ? error.message : String(error),
        toolName,
        responseKeys: Object.keys(response || {}),
      });

      // If toolName was provided, schema validation may have caused the failure.
      // Retry without toolName to extract the payload without schema checks.
      if (toolName) {
        try {
          return unwrapProtocolResponse(response);
        } catch {
          // Unwrapping itself failed — fall through to raw response
        }
      }

      return response;
    }
  }

  /**
   * Check if extracted response data represents a successful operation.
   * Handles singular `error`, plural `errors` (AdCP schema), and `success: false`.
   */
  private isOperationSuccess(data: any): boolean {
    return data?.success !== false && !data?.error && !data?.adcp_error && !isAdcpError(data);
  }

  /**
   * Extract a human-readable error message from response data.
   * Handles singular `error`, plural `errors` array, and `message` field.
   */
  private extractOperationError(data: any): string {
    if (data?.adcp_error) {
      const ae = data.adcp_error;
      return ae.message ? `${ae.code}: ${ae.message}` : ae.code;
    }
    return (
      data?.error ||
      (isAdcpError(data) ? data.errors.map((e: any) => e.message || e.code).join('; ') : null) ||
      data?.message ||
      'Operation failed'
    );
  }

  /**
   * Helper to add debug logs safely
   */
  private logDebug(debugLogs: any[] | undefined, type: string, message: string, details?: any) {
    if (debugLogs && Array.isArray(debugLogs)) {
      debugLogs.push({
        type,
        message,
        timestamp: new Date().toISOString(),
        details,
      });
    }
  }

  /**
   * Handle 'working' status - return as valid intermediate state
   */
  private async waitForWorkingCompletion<T>(
    agent: AgentConfig,
    taskId: string,
    taskName: string,
    params: any,
    initialResponse: any,
    messages: Message[],
    inputHandler?: InputHandler,
    options: TaskOptions = {},
    debugLogs: any[] = [],
    startTime: number = Date.now()
  ): Promise<TaskResult<T>> {
    // Extract any data that came with the working response
    const partialData = this.extractResponseData(initialResponse, debugLogs, taskName);

    // Return working status immediately - this is a valid intermediate state
    // Callers can use the taskId to poll for completion or set up webhooks
    return {
      success: true, // The task is progressing, not failed
      status: 'working',
      data: partialData,
      metadata: {
        taskId,
        taskName,
        agent: { id: agent.id, name: agent.name, protocol: agent.protocol },
        responseTimeMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
        clarificationRounds: 0,
        status: 'working',
      },
      conversation: messages,
      debug_logs: debugLogs,
    };
  }

  /**
   * Set up submitted task with webhook
   */
  private async setupSubmittedTask<T>(
    agent: AgentConfig,
    taskId: string,
    taskName: string,
    response: any,
    messages: Message[],
    options: TaskOptions = {},
    debugLogs: any[] = [],
    startTime: number = Date.now()
  ): Promise<TaskResult<T>> {
    // Extract any data that came with the submitted response
    const partialData = this.extractResponseData(response, debugLogs, taskName);

    let webhookUrl = response.webhookUrl;

    // If no webhook URL provided by server, generate one
    if (!webhookUrl && this.config.webhookManager) {
      webhookUrl = this.config.webhookManager.generateUrl(taskId);
      await this.config.webhookManager.registerWebhook(agent, taskId, webhookUrl);
    }

    const submitted: SubmittedContinuation<T> = {
      taskId,
      webhookUrl,
      track: () => this.getTaskStatus(agent, taskId),
      waitForCompletion: (pollInterval = 60000) => this.pollTaskCompletion<T>(agent, taskId, pollInterval),
    };

    return {
      success: true, // The task is progressing, not failed
      status: 'submitted',
      submitted,
      data: partialData,
      metadata: {
        taskId,
        taskName,
        agent: { id: agent.id, name: agent.name, protocol: agent.protocol },
        responseTimeMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
        clarificationRounds: 0,
        status: 'submitted',
      },
      conversation: messages,
      debug_logs: debugLogs,
    };
  }

  /**
   * Handle input-required status
   *
   * Some agents (like Yahoo) return input-required status. THIS IS TOTALLY VALID AND IS AN INTERMEDIATE STATE.
   * IT SHOULD NOT BE THROWING AN ERROR. IT DOES NOT ALWAYS REQUIRE an input handler.
   * This is common for HITL (human-in-the-loop) workflows where the agent has already processed
   * the request and is just signaling that async approval may be needed.
   */
  private async handleInputRequired<T>(
    agent: AgentConfig,
    taskId: string,
    taskName: string,
    params: any,
    response: any,
    messages: Message[],
    inputHandler?: InputHandler,
    options: TaskOptions = {},
    debugLogs: any[] = [],
    startTime: number = Date.now()
  ): Promise<TaskResult<T>> {
    const inputRequest = this.responseParser.parseInputRequest(response);

    // If no handler provided, return input-required status as a valid intermediate state
    // This allows callers to handle the input-required state themselves (e.g., HITL workflows)
    if (!inputHandler) {
      // Extract any data that came with the response (some agents include partial results)
      const partialData = this.extractResponseData(response, debugLogs, taskName);

      return {
        success: true, // The task is progressing, not failed
        status: 'input-required',
        data: partialData,
        metadata: {
          taskId,
          taskName,
          agent: { id: agent.id, name: agent.name, protocol: agent.protocol },
          responseTimeMs: Date.now() - startTime,
          timestamp: new Date().toISOString(),
          clarificationRounds: 0,
          status: 'input-required',
          inputRequest, // Include the input request details for the caller
        },
        conversation: messages,
        debug_logs: debugLogs,
      };
    }

    // Build context for handler
    const context: ConversationContext = {
      messages,
      inputRequest,
      taskId,
      agent: { id: agent.id, name: agent.name, protocol: agent.protocol },
      attempt: 1,
      maxAttempts: options.maxClarifications || 3,
      deferToHuman: async () => ({ defer: true, token: randomUUID() }),
      abort: reason => {
        throw new Error(reason || 'Task aborted');
      },
      getSummary: () => messages.map(m => `${m.role}: ${JSON.stringify(m.content)}`).join('\n'),
      wasFieldDiscussed: field =>
        // Check if any agent message requested this field via input-required
        messages.some(
          m =>
            m.role === 'agent' &&
            m.content &&
            typeof m.content === 'object' &&
            'field' in m.content &&
            (m.content as Record<string, unknown>).field === field
        ),
      getPreviousResponse: field => {
        // Find the agent message that requested this field
        const fieldRequestIndex = messages.findIndex(
          m =>
            m.role === 'agent' &&
            m.content &&
            typeof m.content === 'object' &&
            'field' in m.content &&
            (m.content as Record<string, unknown>).field === field
        );
        // The response is the next user message after the field request
        if (fieldRequestIndex >= 0) {
          const responseMsg = messages
            .slice(fieldRequestIndex + 1)
            .find(m => m.role === 'user' && m.metadata?.type === 'input_response');
          return responseMsg?.content;
        }
        return undefined;
      },
    };

    // Call handler
    const handlerResponse = await inputHandler(context);

    // Check if handler wants to defer
    if (isDeferResponse(handlerResponse)) {
      const token = handlerResponse.token;

      // Save deferred state for later resumption
      if (this.config.deferredStorage) {
        await this.config.deferredStorage.set(token, {
          taskId,
          contextId: response.contextId || taskId,
          agent,
          taskName,
          params,
          messages,
          createdAt: Date.now(),
        });
      }

      const deferred: DeferredContinuation<T> = {
        token,
        question: inputRequest.question,
        resume: input => this.resumeDeferredTask<T>(token, input),
      };

      return {
        success: true, // The task is progressing, not failed
        status: 'deferred',
        deferred,
        metadata: {
          taskId,
          taskName,
          agent: { id: agent.id, name: agent.name, protocol: agent.protocol },
          responseTimeMs: Date.now() - startTime,
          timestamp: new Date().toISOString(),
          clarificationRounds: 1,
          status: 'deferred',
        },
        conversation: messages,
        debug_logs: debugLogs,
      };
    }

    // Handler provided input - continue with the task
    return this.continueTaskWithInput<T>(
      agent,
      taskId,
      taskName,
      params,
      response.contextId,
      handlerResponse,
      messages,
      inputHandler, // Pass handler for multi-round clarification
      options,
      debugLogs,
      startTime
    );
  }

  /**
   * List tasks for an agent, preferring MCP Tasks protocol when available.
   */
  private async listTasksForAgent(agent: AgentConfig): Promise<TaskInfo[]> {
    // Try MCP Tasks protocol method first
    if (agent.protocol === 'mcp') {
      const authToken = getAuthToken(agent);
      try {
        return await listMCPTasks(agent.agent_uri, authToken);
      } catch (err) {
        if (is401Error(err)) throw err;
        // Fall through to tool call if protocol method is not supported
      }
    }
    const response = (await ProtocolClient.callTool(
      agent,
      'tasks/list',
      {},
      [],
      undefined,
      undefined,
      undefined,
      this.lastKnownServerVersion
    )) as Record<string, unknown>;
    return (response.tasks as TaskInfo[]) || [];
  }

  /**
   * Task tracking methods (PR #78)
   */
  async listTasks(agent: AgentConfig): Promise<TaskInfo[]> {
    try {
      return await this.listTasksForAgent(agent);
    } catch (error) {
      console.warn('Failed to list tasks:', error instanceof Error ? error.message : 'unknown error');
      return [];
    }
  }

  async getTaskStatus(agent: AgentConfig, taskId: string): Promise<TaskInfo> {
    // Use MCP Tasks protocol method when available
    if (agent.protocol === 'mcp') {
      const authToken = getAuthToken(agent);
      try {
        return await getMCPTaskStatus(agent.agent_uri, taskId, authToken);
      } catch (err) {
        if (is401Error(err)) throw err;
        // Fall through to tool call if protocol method is not supported
      }
    }
    const response = (await ProtocolClient.callTool(
      agent,
      'tasks/get',
      { taskId },
      [],
      undefined,
      undefined,
      undefined,
      this.lastKnownServerVersion
    )) as Record<string, unknown>;
    return (response.task as TaskInfo) || (response as unknown as TaskInfo);
  }

  async pollTaskCompletion<T>(agent: AgentConfig, taskId: string, pollInterval = 60000): Promise<TaskResult<T>> {
    while (true) {
      const status = await this.getTaskStatus(agent, taskId);

      if (status.status === ADCP_STATUS.COMPLETED) {
        const pollSuccess = this.isOperationSuccess(status.result);

        if (pollSuccess) {
          return {
            success: true as const,
            status: 'completed' as const,
            data: status.result,
            metadata: {
              taskId,
              taskName: status.taskType,
              agent: { id: agent.id, name: agent.name, protocol: agent.protocol },
              responseTimeMs: Date.now() - status.createdAt,
              timestamp: new Date().toISOString(),
              clarificationRounds: 0,
              status: 'completed' as const,
            },
          };
        }
        return {
          success: false as const,
          status: 'failed' as const,
          data: status.result,
          error: this.extractOperationError(status.result),
          adcpError: extractAdcpErrorInfo(status.result),
          correlationId: extractCorrelationId(status.result),
          metadata: {
            taskId,
            taskName: status.taskType,
            agent: { id: agent.id, name: agent.name, protocol: agent.protocol },
            responseTimeMs: Date.now() - status.createdAt,
            timestamp: new Date().toISOString(),
            clarificationRounds: 0,
            status: 'failed' as const,
          },
        };
      }

      if (status.status === ADCP_STATUS.FAILED || status.status === ADCP_STATUS.CANCELED) {
        return {
          success: false as const,
          status: 'failed' as const,
          data: status.result,
          error: status.error || `Task ${status.status}`,
          adcpError: extractAdcpErrorInfo(status.result),
          correlationId: extractCorrelationId(status.result),
          metadata: {
            taskId,
            taskName: status.taskType,
            agent: { id: agent.id, name: agent.name, protocol: agent.protocol },
            responseTimeMs: Date.now() - status.createdAt,
            timestamp: new Date().toISOString(),
            clarificationRounds: 0,
            status: 'failed' as const,
          },
        };
      }

      await this.sleep(pollInterval);
    }
  }

  /**
   * Resume a deferred task (client deferral)
   */
  async resumeDeferredTask<T>(token: string, input: any): Promise<TaskResult<T>> {
    if (!this.config.deferredStorage) {
      throw new Error('Deferred storage not configured');
    }

    const state = await this.config.deferredStorage.get(token);
    if (!state) {
      throw new Error(`Deferred task not found: ${token}`);
    }

    // Continue task with the provided input (no handler for resumed deferred tasks)
    return this.continueTaskWithInput<T>(
      state.agent,
      state.taskId,
      state.taskName,
      state.params,
      state.contextId,
      input,
      state.messages,
      undefined // No handler for deferred tasks - input was provided by human
    );
  }

  /**
   * Continue a task after receiving input
   */
  private async continueTaskWithInput<T>(
    agent: AgentConfig,
    taskId: string,
    taskName: string,
    params: any,
    contextId: string,
    input: any,
    messages: Message[],
    inputHandler: InputHandler | undefined,
    options: TaskOptions = {},
    debugLogs: any[] = [],
    startTime: number = Date.now()
  ): Promise<TaskResult<T>> {
    // Add user input message
    const inputMessage: Message = {
      id: randomUUID(),
      role: 'user',
      content: input,
      timestamp: new Date().toISOString(),
      metadata: { type: 'input_response' },
    };
    messages.push(inputMessage);

    // Continue the task with input
    const response = await ProtocolClient.callTool(
      agent,
      'continue_task',
      {
        contextId,
        input,
      },
      debugLogs,
      undefined,
      undefined,
      undefined,
      this.lastKnownServerVersion
    );

    // Add response message
    const responseMessage: Message = {
      id: randomUUID(),
      role: 'agent',
      content: response,
      timestamp: new Date().toISOString(),
      metadata: { type: 'continued_response' },
    };
    messages.push(responseMessage);

    // Handle the continued response (pass inputHandler for multi-round clarification)
    return this.handleAsyncResponse<T>(
      agent,
      taskId,
      taskName,
      params,
      response,
      messages,
      inputHandler,
      options,
      debugLogs,
      startTime
    );
  }

  /**
   * Utility methods
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private createErrorResult<T>(
    taskId: string,
    agent: AgentConfig,
    error: any,
    debugLogs: any[] = [],
    startTime: number = Date.now()
  ): TaskResult<T> {
    // Try to extract structured error info from transport exceptions
    // (e.g., JSON-RPC errors with data.adcp_error)
    const transportData = error?.data || error?.response?.data;
    const adcpErrorInfo = extractAdcpErrorInfo(transportData);
    const correlationId = extractCorrelationId(transportData);

    return {
      success: false as const,
      status: 'failed' as const,
      error: error.message || String(error),
      adcpError: adcpErrorInfo,
      correlationId,
      metadata: {
        taskId,
        taskName: 'unknown',
        agent: { id: agent.id, name: agent.name, protocol: agent.protocol },
        responseTimeMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
        clarificationRounds: 0,
        status: 'failed' as const,
      },
      debug_logs: debugLogs,
    };
  }

  /**
   * Legacy methods for backward compatibility
   */
  getConversationHistory(taskId: string): Message[] | undefined {
    return this.conversationStorage?.get(taskId);
  }

  clearConversationHistory(taskId: string): void {
    this.conversationStorage?.delete(taskId);
  }

  getActiveTasks(): TaskState[] {
    return Array.from(this.activeTasks.values());
  }

  // ====== TASK MANAGEMENT & NOTIFICATION METHODS ======

  private taskEventListeners = new Map<
    string,
    {
      callback: (task: TaskInfo) => void;
      agentId?: string;
    }[]
  >();

  private webhookRegistrations = new Map<
    string,
    {
      agent: AgentConfig;
      webhookUrl: string;
      taskTypes?: string[];
    }
  >();

  /**
   * Get task list for a specific agent
   */
  async getTaskList(agentId: string): Promise<TaskInfo[]> {
    // First try to get from agent via protocol
    const agent = this.findAgentById(agentId);
    if (agent) {
      try {
        return await this.listTasksForAgent(agent);
      } catch (error) {
        console.warn('Failed to get remote task list:', error instanceof Error ? error.message : 'unknown error');
      }
    }

    // Fall back to local active tasks
    return Array.from(this.activeTasks.values())
      .filter(task => task.agent.id === agentId)
      .map(task => ({
        taskId: task.taskId,
        status: task.status,
        taskType: task.taskName,
        createdAt: task.startTime,
        updatedAt: task.startTime, // TODO: track updates
      }));
  }

  /**
   * Get detailed information about a specific task
   */
  async getTaskInfo(taskId: string): Promise<TaskInfo | null> {
    const localTask = this.activeTasks.get(taskId);
    if (localTask) {
      return {
        taskId: localTask.taskId,
        status: localTask.status,
        taskType: localTask.taskName,
        createdAt: localTask.startTime,
        updatedAt: localTask.startTime,
      };
    }

    // Try to get from agent
    // Note: Would need to know which agent to query
    return null;
  }

  /**
   * Subscribe to task updates for a specific agent
   */
  onTaskUpdate(agentId: string, callback: (task: TaskInfo) => void): () => void {
    const listenerId = randomUUID();
    const listeners = this.taskEventListeners.get(listenerId) || [];
    listeners.push({ callback, agentId });
    this.taskEventListeners.set(listenerId, listeners);

    return () => {
      this.taskEventListeners.delete(listenerId);
    };
  }

  /**
   * Subscribe to task events with detailed callbacks
   */
  onTaskEvents(
    agentId: string,
    callbacks: {
      onTaskCreated?: (task: TaskInfo) => void;
      onTaskUpdated?: (task: TaskInfo) => void;
      onTaskCompleted?: (task: TaskInfo) => void;
      onTaskFailed?: (task: TaskInfo, error: string) => void;
    }
  ): () => void {
    const unsubscribeFns: (() => void)[] = [];

    // Create combined handler that routes to specific callbacks
    const handler = (task: TaskInfo) => {
      switch (task.status) {
        case 'submitted':
        case 'working':
          callbacks.onTaskCreated?.(task);
          break;
        case 'input-required':
          callbacks.onTaskUpdated?.(task);
          break;
        case 'completed':
          callbacks.onTaskCompleted?.(task);
          break;
        case 'failed':
        case 'rejected':
          callbacks.onTaskFailed?.(task, task.error || 'Task failed');
          break;
        default:
          callbacks.onTaskUpdated?.(task);
      }
    };

    unsubscribeFns.push(this.onTaskUpdate(agentId, handler));

    return () => {
      unsubscribeFns.forEach(fn => fn());
    };
  }

  /**
   * Register webhook for task notifications
   */
  async registerWebhook(agent: AgentConfig, webhookUrl: string, taskTypes?: string[]): Promise<void> {
    this.webhookRegistrations.set(agent.id, {
      agent,
      webhookUrl,
      taskTypes,
    });

    // TODO: Register with remote agent if it supports webhooks
    console.log(`Webhook registered for agent ${agent.id}: ${webhookUrl}`);
  }

  /**
   * Unregister webhook notifications
   */
  async unregisterWebhook(agent: AgentConfig): Promise<void> {
    this.webhookRegistrations.delete(agent.id);
    console.log(`Webhook unregistered for agent ${agent.id}`);
  }

  /**
   * Emit task event to listeners
   */
  private emitTaskEvent(task: TaskInfo, agentId?: string): void {
    this.taskEventListeners.forEach(listeners => {
      listeners.forEach(({ callback, agentId: listenerAgentId }) => {
        if (!listenerAgentId || listenerAgentId === agentId) {
          try {
            callback(task);
          } catch (error) {
            console.error('Error in task event callback:', error instanceof Error ? error.message : 'unknown error');
          }
        }
      });
    });
  }

  /**
   * Normalize response data for schema validation
   *
   * Converts v2-style responses to v3 format before validation.
   * This ensures validation passes for both v2 and v3 server responses.
   */
  private normalizeResponseForValidation(response: any, taskName: string): any {
    if (!response) return response;

    switch (taskName) {
      case 'get_products':
        // Normalize v2 pricing options to v3 format
        return normalizeGetProductsResponse(response);
      default:
        return response;
    }
  }

  /**
   * Validate response against AdCP schema and log any violations
   *
   * Respects config.strictSchemaValidation (default: true):
   * - true: Validation failures cause task to fail
   * - false: Validation failures are logged only
   */
  private validateResponseSchema(
    response: any,
    taskName: string,
    debugLogs: any[]
  ): { valid: boolean; errors: string[] } {
    const strictMode = this.config.strictSchemaValidation !== false; // Default: true
    const logViolations = this.config.logSchemaViolations !== false; // Default: true

    try {
      // Normalize response to v3 format before validation
      // This ensures v2 server responses pass validation against v3 schemas
      const normalizedResponse = this.normalizeResponseForValidation(response, taskName);

      const validationResult = responseValidator.validate(normalizedResponse, taskName, {
        validateSchema: true,
        strict: false,
      });

      if (!validationResult.valid) {
        // Log to debug logs if enabled
        if (logViolations) {
          const errorSummary = validationResult.errors.slice(0, 3).join('; ');
          const moreErrors =
            validationResult.errors.length > 3 ? ` (and ${validationResult.errors.length - 3} more)` : '';

          debugLogs.push({
            timestamp: new Date().toISOString(),
            type: strictMode ? 'error' : 'warning',
            message: `Schema validation ${
              strictMode ? 'failed' : 'warning'
            } for ${taskName}: ${errorSummary}${moreErrors}`,
            errors: validationResult.errors,
            schemaErrors: validationResult.schemaErrors,
            strictMode,
          });
        }

        // Console output based on strict mode
        if (strictMode) {
          console.error(`Schema validation failed for ${taskName}:`, validationResult.errors);
        } else {
          console.warn(`Schema validation failed for ${taskName} (non-blocking):`, validationResult.errors);
        }

        // In strict mode, validation failures are treated as invalid
        if (strictMode) {
          return {
            valid: false,
            errors: validationResult.errors,
          };
        }
      }

      // Non-strict mode or validation passed
      return {
        valid: true,
        errors: [],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'unknown error';
      console.error('Error during schema validation:', errorMessage);
      // On validation error, fail safe based on strict mode
      return {
        valid: !strictMode, // In strict mode, treat validation errors as failures
        errors: strictMode ? [`Validation error: ${errorMessage}`] : [],
      };
    }
  }

  /**
   * Update task status and emit events
   */
  private updateTaskStatus(taskId: string, status: TaskStatus, result?: any, error?: string): void {
    const task = this.activeTasks.get(taskId);
    if (task) {
      const previousStatus = task.status;
      task.status = status;

      const taskInfo: TaskInfo = {
        taskId: task.taskId,
        status: status,
        taskType: task.taskName,
        createdAt: task.startTime,
        updatedAt: Date.now(),
        result,
        error,
      };

      this.emitTaskEvent(taskInfo, task.agent.id);

      this.config.onActivity?.({
        type: 'status_change',
        operation_id: task.taskId,
        agent_id: task.agent.id,
        context_id: undefined,
        task_id: task.taskId,
        task_type: task.taskName,
        status: status,
        payload: result ?? (error ? { error } : undefined),
        timestamp: new Date().toISOString(),
      });

      // If task is finished, remove from active tasks after a delay.
      // unref() ensures this timer doesn't prevent the process from exiting.
      if (['completed', 'failed', 'rejected', 'canceled'].includes(status)) {
        setTimeout(() => {
          this.activeTasks.delete(taskId);
        }, 30000).unref(); // Keep for 30 seconds for final status checks
      }
    }
  }

  /**
   * Helper to find agent config by ID
   */
  private findAgentById(agentId: string): AgentConfig | undefined {
    // This would ideally be passed in or stored in the executor
    // For now, return undefined and fall back to local tasks
    return undefined;
  }
}
