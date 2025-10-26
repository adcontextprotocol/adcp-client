// Core task execution engine for ADCP conversation flow
// Implements PR #78 async patterns: working/submitted/input-required/completed

import { randomUUID } from 'crypto';
import type { AgentConfig } from '../types';
import { ProtocolClient } from '../protocols';
import type { Storage } from '../storage/interfaces';
import { responseValidator } from './ResponseValidator';
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
  SubmittedContinuation
} from './ConversationTypes';
import { normalizeHandlerResponse, isDeferResponse, isAbortResponse } from '../handlers/types';
import { ProtocolResponseParser, ADCP_STATUS, type ADCPStatus } from './ProtocolResponseParser';
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
    } = {}
  ) {
    this.responseParser = new ProtocolResponseParser();
    if (config.enableConversationStorage) {
      this.conversationStorage = new Map();
    }
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
    options: TaskOptions = {}
  ): Promise<TaskResult<T>> {
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
      agent: { id: agent.id, name: agent.name, protocol: agent.protocol }
    };
    this.activeTasks.set(taskId, taskState);

    // Emit task creation event
    this.emitTaskEvent({
      taskId,
      status: 'submitted',
      taskType: taskName,
      createdAt: startTime,
      updatedAt: startTime
    }, agent.id);
    
    // Create initial message
    const initialMessage: Message = {
      id: randomUUID(),
      role: 'user',
      content: { tool: taskName, params },
      timestamp: new Date().toISOString(),
      metadata: { toolName: taskName, type: 'request' }
    };

    // Start streaming connection
    const debugLogs: any[] = [];

    // Generate webhook URL if template is configured
    const webhookUrl = this.generateWebhookUrl(taskName, taskId);

    try {
      // Send initial request and get streaming response with webhook URL
      const response = await ProtocolClient.callTool(agent, taskName, params, debugLogs, webhookUrl, this.config.webhookSecret);
      
      // Add initial response message
      const responseMessage: Message = {
        id: randomUUID(),
        role: 'agent', 
        content: response,
        timestamp: new Date().toISOString(),
        metadata: { toolName: taskName, type: 'response' }
      };

      const messages = [initialMessage, responseMessage];
      
      // Handle response based on status
      return await this.handleAsyncResponse<T>(
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
      
    } catch (error) {
      return this.createErrorResult<T>(taskId, agent, error, debugLogs, startTime);
    }
  }

  /**
   * Handle agent response based on ADCP status (PR #78)
   */
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
        const completedData = this.extractResponseData(response, debugLogs);
        this.updateTaskStatus(taskId, 'completed', completedData);

        // Check if the actual operation succeeded (not just the task)
        // Some agents return { success: false, message: "error" } even with status: completed
        // Some agents return { error: "..." } without success field
        const operationSuccess = completedData?.success !== false && !completedData?.error;

        // Validate response against AdCP schema
        const validationResult = this.validateResponseSchema(response, taskName, debugLogs);

        // In strict mode, schema validation failures cause task to fail
        const finalSuccess = operationSuccess && validationResult.valid;
        const finalError = !finalSuccess
          ? (validationResult.errors.length > 0
              ? `Schema validation failed: ${validationResult.errors.join('; ')}`
              : (completedData?.error || completedData?.message || 'Operation failed'))
          : undefined;

        return {
          success: finalSuccess,
          status: 'completed',
          data: completedData,
          error: finalError,
          metadata: {
            taskId,
            taskName,
            agent: { id: agent.id, name: agent.name, protocol: agent.protocol },
            responseTimeMs: Date.now() - startTime,
            timestamp: new Date().toISOString(),
            clarificationRounds: 0,
            status: 'completed'
          },
          conversation: messages,
          debug_logs: debugLogs
        };

      case ADCP_STATUS.WORKING:
        // Server is processing - keep connection open for up to 120s
        return this.waitForWorkingCompletion<T>(
          agent, taskId, taskName, params, response, messages, 
          inputHandler, options, debugLogs, startTime
        );

      case ADCP_STATUS.SUBMITTED:
        // Long-running task - set up webhook
        return this.setupSubmittedTask<T>(
          agent, taskId, taskName, response, messages, 
          options, debugLogs, startTime
        );

      case ADCP_STATUS.INPUT_REQUIRED:
        // Server needs input - handler is mandatory
        return this.handleInputRequired<T>(
          agent, taskId, taskName, params, response, messages,
          inputHandler, options, debugLogs, startTime
        );

      case ADCP_STATUS.FAILED:
      case ADCP_STATUS.REJECTED:
      case ADCP_STATUS.CANCELED:
        throw new Error(`Task ${status}: ${response.error || response.message || 'Unknown error'}`);

      default:
        // Unknown status - treat as completed if we have data
        const defaultData = this.extractResponseData(response, debugLogs);
        if (defaultData && (defaultData !== response || response.structuredContent || response.result || response.data)) {
          // Check if the actual operation succeeded
          const defaultSuccess = defaultData?.success !== false && !defaultData?.error;

          // Validate response against AdCP schema
          const defaultValidation = this.validateResponseSchema(response, taskName, debugLogs);

          // In strict mode, schema validation failures cause task to fail
          const defaultFinalSuccess = defaultSuccess && defaultValidation.valid;
          const defaultFinalError = !defaultFinalSuccess
            ? (defaultValidation.errors.length > 0
                ? `Schema validation failed: ${defaultValidation.errors.join('; ')}`
                : (defaultData?.error || defaultData?.message || 'Operation failed'))
            : undefined;

          return {
            success: defaultFinalSuccess,
            status: 'completed',
            data: defaultData,
            error: defaultFinalError,
            metadata: {
              taskId,
              taskName,
              agent: { id: agent.id, name: agent.name, protocol: agent.protocol },
              responseTimeMs: Date.now() - startTime,
              timestamp: new Date().toISOString(),
              clarificationRounds: 0,
              status: 'completed'
            },
            conversation: messages,
            debug_logs: debugLogs
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
  public extractResponseData(response: any, debugLogs?: any[]): any {
    // MCP responses have structuredContent
    if (response?.structuredContent) {
      this.logDebug(debugLogs, 'info', 'Extracting data from MCP structuredContent', {
        hasStructuredContent: true,
        keys: Object.keys(response.structuredContent)
      });
      return response.structuredContent;
    }

    // A2A responses typically have result with artifacts
    if (response?.result) {
      // Check if this is an A2A artifact structure
      if (response.result.artifacts && Array.isArray(response.result.artifacts)) {
        // Extract data from the first artifact's first part
        const artifacts = response.result.artifacts;
        if (artifacts.length > 0 && artifacts[0].parts && Array.isArray(artifacts[0].parts)) {
          const firstPart = artifacts[0].parts[0];
          if (firstPart?.data) {
            this.logDebug(debugLogs, 'info', 'Extracting data from A2A artifact structure', {
              artifactCount: artifacts.length,
              partCount: artifacts[0].parts.length,
              dataKeys: Object.keys(firstPart.data || {})
            });
            return firstPart.data;
          }
        }
        this.logDebug(debugLogs, 'warning', 'A2A artifacts found but no data extracted', {
          artifactCount: artifacts.length,
          hasFirstPart: !!artifacts[0]?.parts?.[0]
        });
      }
      // Otherwise return the result as-is
      this.logDebug(debugLogs, 'info', 'Returning A2A result directly (no artifacts)', {
        hasArtifacts: !!response.result.artifacts
      });
      return response.result;
    }

    if (response?.data) {
      this.logDebug(debugLogs, 'info', 'Extracting data from response.data field');
      return response.data;
    }

    // Fallback to full response
    this.logDebug(debugLogs, 'warning', 'No standard data structure found, returning full response', {
      responseKeys: Object.keys(response || {})
    });
    return response;
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
        details
      });
    }
  }

  /**
   * Wait for 'working' status completion (max 120s per PR #78)
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
    // TODO: Implement SSE/streaming connection waiting
    // For now, simulate by polling tasks/get endpoint
    const workingTimeout = this.config.workingTimeout || 120000;
    const pollInterval = this.config.pollingInterval || 2000;
    const deadline = Date.now() + workingTimeout;
    
    while (Date.now() < deadline) {
      await this.sleep(pollInterval);
      
      try {
        const taskInfo = await this.getTaskStatus(agent, taskId);
        
        if (taskInfo.status === ADCP_STATUS.COMPLETED) {
          // Check if the actual operation succeeded
          const workingSuccess = taskInfo.result?.success !== false && !taskInfo.result?.error;

          return {
            success: workingSuccess,
            status: 'completed',
            data: taskInfo.result,
            error: workingSuccess ? undefined : (taskInfo.result?.error || taskInfo.result?.message || 'Operation failed'),
            metadata: {
              taskId,
              taskName,
              agent: { id: agent.id, name: agent.name, protocol: agent.protocol },
              responseTimeMs: Date.now() - startTime,
              timestamp: new Date().toISOString(),
              clarificationRounds: 0,
              status: 'completed'
            },
            conversation: messages
          };
        }
        
        if (taskInfo.status === ADCP_STATUS.INPUT_REQUIRED) {
          // Transition to input handling
          return this.handleInputRequired<T>(
            agent, taskId, taskName, params, taskInfo, messages,
            inputHandler, options, debugLogs, startTime
          );
        }
        
        if (taskInfo.status === ADCP_STATUS.FAILED) {
          throw new Error(`Task failed: ${taskInfo.error}`);
        }
        
        // Still working, continue polling
        
      } catch (error) {
        // Network error during polling - continue trying
        console.warn(`Polling error for task ${taskId}:`, error);
      }
    }
    
    throw new TaskTimeoutError(taskId, workingTimeout);
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
      waitForCompletion: (pollInterval = 60000) => this.pollTaskCompletion<T>(agent, taskId, pollInterval)
    };
    
    return {
      success: false,
      status: 'submitted',
      submitted,
      metadata: {
        taskId,
        taskName,
        agent: { id: agent.id, name: agent.name, protocol: agent.protocol },
        responseTimeMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
        clarificationRounds: 0,
        status: 'submitted'
      },
      conversation: messages,
      debug_logs: debugLogs
    };
  }

  /**
   * Handle input-required status (handler mandatory)
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
    
    // Handler is mandatory for input-required
    if (!inputHandler) {
      throw new InputRequiredError(inputRequest.question);
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
      abort: (reason) => { throw new Error(reason || 'Task aborted'); },
      getSummary: () => messages.map(m => `${m.role}: ${JSON.stringify(m.content)}`).join('\n'),
      wasFieldDiscussed: (field) => messages.some(m => 
        m.content && typeof m.content === 'object' && m.content[field] !== undefined
      ),
      getPreviousResponse: (field) => {
        const msg = messages.find(m => 
          m.role === 'user' && m.content && typeof m.content === 'object' && m.content[field] !== undefined
        );
        return msg?.content[field];
      }
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
          createdAt: Date.now()
        });
      }
      
      const deferred: DeferredContinuation<T> = {
        token,
        question: inputRequest.question,
        resume: (input) => this.resumeDeferredTask<T>(token, input)
      };
      
      return {
        success: false,
        status: 'deferred',
        deferred,
        metadata: {
          taskId,
          taskName,
          agent: { id: agent.id, name: agent.name, protocol: agent.protocol },
          responseTimeMs: Date.now() - startTime,
          timestamp: new Date().toISOString(),
          clarificationRounds: 1,
          status: 'deferred'
        },
        conversation: messages,
        debug_logs: debugLogs
      };
    }
    
    // Handler provided input - continue with the task
    return this.continueTaskWithInput<T>(
      agent, taskId, taskName, params, response.contextId, handlerResponse,
      messages, options, debugLogs, startTime
    );
  }

  /**
   * Task tracking methods (PR #78)
   */
  async listTasks(agent: AgentConfig): Promise<TaskInfo[]> {
    try {
      const response = await ProtocolClient.callTool(agent, 'tasks/list', {});
      return response.tasks || [];
    } catch (error) {
      console.warn('Failed to list tasks:', error);
      return [];
    }
  }

  async getTaskStatus(agent: AgentConfig, taskId: string): Promise<TaskInfo> {
    const response = await ProtocolClient.callTool(agent, 'tasks/get', { taskId });
    return response.task || response;
  }

  async pollTaskCompletion<T>(
    agent: AgentConfig,
    taskId: string, 
    pollInterval = 60000
  ): Promise<TaskResult<T>> {
    while (true) {
      const status = await this.getTaskStatus(agent, taskId);
      
      if (status.status === ADCP_STATUS.COMPLETED) {
        // Check if the actual operation succeeded
        const pollSuccess = status.result?.success !== false && !status.result?.error;

        return {
          success: pollSuccess,
          status: 'completed',
          data: status.result,
          error: pollSuccess ? undefined : (status.result?.error || status.result?.message || 'Operation failed'),
          metadata: {
            taskId,
            taskName: status.taskType,
            agent: { id: agent.id, name: agent.name, protocol: agent.protocol },
            responseTimeMs: Date.now() - status.createdAt,
            timestamp: new Date().toISOString(),
            clarificationRounds: 0,
            status: 'completed'
          }
        };
      }
      
      if (status.status === ADCP_STATUS.FAILED || status.status === ADCP_STATUS.CANCELED) {
        throw new Error(`Task ${status.status}: ${status.error}`);
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
    
    // Continue task with the provided input
    return this.continueTaskWithInput<T>(
      state.agent, state.taskId, state.taskName, state.params,
      state.contextId, input, state.messages
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
      metadata: { type: 'input_response' }
    };
    messages.push(inputMessage);
    
    // Continue the task with input
    const response = await ProtocolClient.callTool(agent, 'continue_task', {
      contextId,
      input
    }, debugLogs);
    
    // Add response message
    const responseMessage: Message = {
      id: randomUUID(),
      role: 'agent',
      content: response,
      timestamp: new Date().toISOString(),
      metadata: { type: 'continued_response' }
    };
    messages.push(responseMessage);
    
    // Handle the continued response
    return this.handleAsyncResponse<T>(
      agent, taskId, taskName, params, response, messages,
      undefined, options, debugLogs, startTime
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
    return {
      success: false,
      status: 'completed', // TaskResult status
      error: error.message || String(error),
      metadata: {
        taskId,
        taskName: 'unknown',
        agent: { id: agent.id, name: agent.name, protocol: agent.protocol },
        responseTimeMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
        clarificationRounds: 0,
        status: 'failed' // metadata status
      },
      debug_logs: debugLogs
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

  private taskEventListeners = new Map<string, {
    callback: (task: TaskInfo) => void;
    agentId?: string;
  }[]>();

  private webhookRegistrations = new Map<string, {
    agent: AgentConfig;
    webhookUrl: string;
    taskTypes?: string[];
  }>();

  /**
   * Get task list for a specific agent
   */
  async getTaskList(agentId: string): Promise<TaskInfo[]> {
    // First try to get from agent via protocol
    const agent = this.findAgentById(agentId);
    if (agent) {
      try {
        const response = await ProtocolClient.callTool(agent, 'tasks/list', {});
        return response.tasks || [];
      } catch (error) {
        console.warn('Failed to get remote task list:', error);
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
  onTaskEvents(agentId: string, callbacks: {
    onTaskCreated?: (task: TaskInfo) => void;
    onTaskUpdated?: (task: TaskInfo) => void;
    onTaskCompleted?: (task: TaskInfo) => void;
    onTaskFailed?: (task: TaskInfo, error: string) => void;
  }): () => void {
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
      taskTypes
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
            console.error('Error in task event callback:', error);
          }
        }
      });
    });
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
      const validationResult = responseValidator.validate(
        response,
        taskName,
        { validateSchema: true, strict: false }
      );

      if (!validationResult.valid) {
        // Log to debug logs if enabled
        if (logViolations) {
          const errorSummary = validationResult.errors.slice(0, 3).join('; ');
          const moreErrors = validationResult.errors.length > 3
            ? ` (and ${validationResult.errors.length - 3} more)`
            : '';

          debugLogs.push({
            timestamp: new Date().toISOString(),
            type: strictMode ? 'error' : 'warning',
            message: `Schema validation ${strictMode ? 'failed' : 'warning'} for ${taskName}: ${errorSummary}${moreErrors}`,
            errors: validationResult.errors,
            schemaErrors: validationResult.schemaErrors,
            strictMode
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
            errors: validationResult.errors
          };
        }
      }

      // Non-strict mode or validation passed
      return {
        valid: true,
        errors: []
      };
    } catch (error) {
      console.error(`Error during schema validation:`, error);
      // On validation error, fail safe based on strict mode
      return {
        valid: !strictMode, // In strict mode, treat validation errors as failures
        errors: strictMode ? [`Validation error: ${error}`] : []
      };
    }
  }

  /**
   * Update task status and emit events
   */
  private updateTaskStatus(taskId: string, status: TaskStatus, result?: any, error?: string): void {
    const task = this.activeTasks.get(taskId);
    if (task) {
      task.status = status;
      
      const taskInfo: TaskInfo = {
        taskId: task.taskId,
        status: status,
        taskType: task.taskName,
        createdAt: task.startTime,
        updatedAt: Date.now(),
        result,
        error
      };

      this.emitTaskEvent(taskInfo, task.agent.id);

      // If task is finished, remove from active tasks after a delay
      if (['completed', 'failed', 'rejected', 'canceled'].includes(status)) {
        setTimeout(() => {
          this.activeTasks.delete(taskId);
        }, 30000); // Keep for 30 seconds for final status checks
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
