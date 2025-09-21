// Core task execution engine for ADCP conversation flow

import { randomUUID } from 'crypto';
import type { AgentConfig } from '../types';
import { ProtocolClient } from '../protocols';
import type {
  Message,
  InputRequest,
  InputHandler,
  ConversationContext,
  TaskOptions,
  TaskResult,
  TaskState,
  TaskStatus
} from './ConversationTypes';
import { normalizeHandlerResponse, isDeferResponse, isAbortResponse } from '../handlers/types';
import { ProtocolResponseParser, ResponseStatus } from './ProtocolResponseParser';
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

/**
 * Core task execution engine that handles the conversation loop with agents
 */
export class TaskExecutor {
  private responseParser: ProtocolResponseParser;

  private activeTasks = new Map<string, TaskState>();
  private conversationStorage?: Map<string, Message[]>;
  
  constructor(
    private config: {
      defaultTimeout?: number;
      defaultMaxClarifications?: number;
      enableConversationStorage?: boolean;
    } = {}
  ) {
    this.responseParser = new ProtocolResponseParser();
    if (config.enableConversationStorage) {
      this.conversationStorage = new Map();
    }
  }

  /**
   * Execute a task with an agent, handling the full conversation flow
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
    
    // Initialize task state
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
      agent: {
        id: agent.id,
        name: agent.name,
        protocol: agent.protocol
      }
    };

    // Load existing conversation if contextId provided
    if (options.contextId && this.conversationStorage?.has(options.contextId)) {
      taskState.messages = [...this.conversationStorage.get(options.contextId)!];
    }

    this.activeTasks.set(taskId, taskState);

    try {
      const result = await this.runTaskLoop<T>(agent, taskState, inputHandler);
      
      // Store conversation if enabled
      if (this.conversationStorage) {
        this.conversationStorage.set(taskId, taskState.messages);
      }

      return result;
    } finally {
      this.activeTasks.delete(taskId);
    }
  }

  /**
   * Main task execution loop - handles conversation until completion or failure
   */
  private async runTaskLoop<T>(
    agent: AgentConfig,
    taskState: TaskState,
    inputHandler?: InputHandler
  ): Promise<TaskResult<T>> {
    const timeout = taskState.options.timeout || this.config.defaultTimeout || 30000;
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new TaskTimeoutError(taskState.taskId, timeout)), timeout);
    });

    try {
      const result = await Promise.race([
        this.executeTaskInternal<T>(agent, taskState, inputHandler),
        timeoutPromise
      ]);

      return result;
    } catch (error) {
      return this.createErrorResult<T>(taskState, error);
    }
  }

  /**
   * Internal task execution logic
   */
  private async executeTaskInternal<T>(
    agent: AgentConfig,
    taskState: TaskState,
    inputHandler?: InputHandler
  ): Promise<TaskResult<T>> {
    const debugLogs: any[] = [];
    
    taskState.status = 'running';
    
    // Add initial request message
    this.addMessage(taskState, {
      role: 'user',
      content: {
        tool: taskState.taskName,
        params: taskState.params
      },
      metadata: {
        toolName: taskState.taskName,
        type: 'request'
      }
    });

    while (taskState.status === 'running' || taskState.status === 'needs_input') {
      try {
        // Call the agent
        const agentResponse = await ProtocolClient.callTool(
          agent,
          taskState.taskName,
          taskState.params,
          debugLogs
        );

        // Add agent response message
        this.addMessage(taskState, {
          role: 'agent',
          content: agentResponse,
          metadata: {
            toolName: taskState.taskName,
            type: 'response'
          }
        });

        // Check if agent is requesting input
        if (this.responseParser.isInputRequest(agentResponse, taskState.agent.protocol, taskState.agent.id)) {
          const inputRequest = this.responseParser.parseInputRequest(agentResponse, taskState.agent.protocol);
          taskState.status = 'needs_input';
          taskState.pendingInput = inputRequest;
          taskState.attempt++;

          // Check max attempts
          if (taskState.attempt > taskState.maxAttempts) {
            throw new MaxClarificationError(taskState.taskId, taskState.maxAttempts);
          }

          // Get input from handler
          if (!inputHandler) {
            throw new Error(`Agent requested input but no input handler provided. Question: ${inputRequest.question}`);
          }

          const userResponse = await this.handleInputRequest(
            taskState,
            inputRequest,
            inputHandler
          );

          // Add user response message
          this.addMessage(taskState, {
            role: 'user',
            content: userResponse,
            metadata: {
              type: 'clarification',
              field: inputRequest.field,
              attempt: taskState.attempt
            }
          });

          // Update params with user response
          if (inputRequest.field) {
            taskState.params = {
              ...taskState.params,
              [inputRequest.field]: userResponse
            };
          }

          taskState.status = 'running';
          continue;
        }

        // Task completed successfully
        taskState.status = 'completed';
        
        return {
          success: true,
          data: agentResponse,
          metadata: {
            taskId: taskState.taskId,
            taskName: taskState.taskName,
            agent: taskState.agent,
            responseTimeMs: Date.now() - taskState.startTime,
            timestamp: new Date().toISOString(),
            clarificationRounds: taskState.attempt,
            status: taskState.status
          },
          conversation: [...taskState.messages],
          debugLogs: taskState.options.debug ? debugLogs : undefined
        };

      } catch (error) {
        throw error;
      }
    }

    throw new Error(`Unexpected task state: ${taskState.status}`);
  }

  /**
   * Handle input request using the provided input handler
   */
  private async handleInputRequest(
    taskState: TaskState,
    inputRequest: InputRequest,
    inputHandler: InputHandler
  ): Promise<any> {
    const context = this.createConversationContext(taskState, inputRequest);
    
    try {
      const response = await inputHandler(context);
      return await normalizeHandlerResponse(response, context);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Task deferred with token:')) {
        const token = error.message.split(': ')[1];
        throw new DeferredTaskError(token);
      }
      throw error;
    }
  }

  /**
   * Create conversation context for input handlers
   */
  private createConversationContext(
    taskState: TaskState,
    inputRequest: InputRequest
  ): ConversationContext {
    const context: ConversationContext = {
      messages: [...taskState.messages],
      inputRequest,
      taskId: taskState.taskId,
      agent: taskState.agent,
      attempt: taskState.attempt,
      maxAttempts: taskState.maxAttempts,
      
      deferToHuman: async () => {
        const token = randomUUID();
        return { defer: true, token };
      },
      
      abort: (reason?: string) => {
        throw new Error(`Task aborted: ${reason || 'No reason provided'}`);
      },
      
      getSummary: () => {
        const messages = taskState.messages.filter(m => m.role !== 'system');
        return messages.map(m => `${m.role}: ${JSON.stringify(m.content)}`).join('\n');
      },
      
      wasFieldDiscussed: (field: string) => {
        return taskState.messages.some(m => 
          m.metadata?.field === field || 
          (typeof m.content === 'object' && m.content?.[field] !== undefined)
        );
      },
      
      getPreviousResponse: (field: string) => {
        const message = taskState.messages
          .filter(m => m.role === 'user' && m.metadata?.field === field)
          .pop();
        return message?.content;
      }
    };

    return context;
  }

  /**
   * Add a message to the task's conversation history
   */
  private addMessage(taskState: TaskState, message: Omit<Message, 'id' | 'timestamp'>): void {
    const fullMessage: Message = {
      ...message,
      id: randomUUID(),
      timestamp: new Date().toISOString()
    };
    
    taskState.messages.push(fullMessage);
  }

  /**
   * Create error result for failed tasks
   */
  private createErrorResult<T>(taskState: TaskState, error: any): TaskResult<T> {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    taskState.status = error instanceof DeferredTaskError ? 'deferred' : 'failed';
    
    return {
      success: false,
      error: errorMessage,
      metadata: {
        taskId: taskState.taskId,
        taskName: taskState.taskName,
        agent: taskState.agent,
        responseTimeMs: Date.now() - taskState.startTime,
        timestamp: new Date().toISOString(),
        clarificationRounds: taskState.attempt,
        status: taskState.status
      },
      conversation: [...taskState.messages]
    };
  }

  /**
   * Get active task information
   */
  getActiveTask(taskId: string): TaskState | undefined {
    return this.activeTasks.get(taskId);
  }

  /**
   * Get all active tasks
   */
  getActiveTasks(): TaskState[] {
    return Array.from(this.activeTasks.values());
  }

  /**
   * Get conversation history for a task
   */
  getConversationHistory(taskId: string): Message[] | undefined {
    return this.conversationStorage?.get(taskId);
  }

  /**
   * Clear conversation history for a task
   */
  clearConversationHistory(taskId: string): void {
    this.conversationStorage?.delete(taskId);
  }
}