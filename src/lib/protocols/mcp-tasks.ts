/**
 * MCP Tasks protocol integration for async tool calls.
 *
 * When an MCP server declares `capabilities.tasks.requests.tools.call`, this module
 * uses the SDK's experimental tasks API instead of custom AdCP tool calls for async
 * lifecycle management. This removes the LLM from the polling path.
 *
 * Detection: check `client.getServerCapabilities()?.tasks?.requests?.tools?.call`
 * after connection. The SDK's `isToolTask()` auto-detects per-tool `taskSupport`.
 */

import type { Client as MCPClient } from '@modelcontextprotocol/sdk/client/index.js';
import type { DebugLogEntry } from '../types/adcp';
import type { TaskInfo } from '../core/ConversationTypes';
import { withCachedConnection } from './mcp';
import { createMCPAuthHeaders } from '../auth';
import { withSpan, injectTraceHeaders } from '../observability/tracing';

/** Response shape returned by MCPClient.callTool(). */
type CallToolResponse = {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  [key: string]: unknown;
};

/**
 * Track which MCP clients have had listTools() called.
 * The SDK's isToolTask() needs tool metadata from listTools() to determine
 * per-tool taskSupport. Without this, callToolStream silently degrades to
 * a synchronous tools/call (no task creation).
 */
const toolsListedClients = new WeakSet<MCPClient>();

/**
 * Ensure tool metadata is cached in the SDK so isToolTask() works.
 * Called once per client connection when tasks are supported.
 */
async function ensureToolsListed(client: MCPClient): Promise<void> {
  if (toolsListedClients.has(client)) return;
  await client.listTools();
  toolsListedClients.add(client);
}

/**
 * Check if an MCP server supports the Tasks protocol for tool calls.
 */
export function serverSupportsTasks(client: MCPClient): boolean {
  const caps = client.getServerCapabilities();
  return !!(caps as Record<string, any>)?.tasks?.requests?.tools?.call;
}

/**
 * Map MCP Tasks status to AdCP status.
 *
 * MCP Tasks uses underscores and British spelling; AdCP uses hyphens and American spelling.
 */
export function mapMCPTaskStatus(mcpStatus: string): string {
  switch (mcpStatus) {
    case 'working':
      return 'working';
    case 'input_required':
      return 'input-required';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'canceled';
    default:
      return mcpStatus;
  }
}

/**
 * Map an MCP Task object to an AdCP TaskInfo.
 */
function mapMCPTaskToTaskInfo(
  task: {
    taskId: string;
    status: string;
    createdAt: string;
    lastUpdatedAt: string;
    statusMessage?: string;
    pollInterval?: number;
  },
  toolName?: string
): TaskInfo {
  return {
    taskId: task.taskId,
    status: mapMCPTaskStatus(task.status),
    taskType: toolName ?? 'unknown',
    createdAt: new Date(task.createdAt).getTime(),
    updatedAt: new Date(task.lastUpdatedAt).getTime(),
    error: task.status === 'failed' ? task.statusMessage : undefined,
  };
}

/**
 * Build auth headers for MCP connections.
 */
function buildAuthHeaders(authToken?: string, customHeaders?: Record<string, string>): Record<string, string> {
  const traceHeaders = injectTraceHeaders();
  return {
    ...customHeaders,
    ...traceHeaders,
    ...(authToken ? createMCPAuthHeaders(authToken) : {}),
  };
}

/**
 * Redact sensitive fields from tool args before logging.
 */
function redactArgsForLog(args: Record<string, unknown>): Record<string, unknown> {
  if (!args.push_notification_config) return args;
  return {
    ...args,
    push_notification_config: { ...(args.push_notification_config as object), authentication: '***' },
  };
}

/**
 * Validate taskId before passing to protocol methods.
 */
function validateTaskId(taskId: string): void {
  if (!taskId || typeof taskId !== 'string' || taskId.length > 256) {
    throw new Error(`Invalid taskId: expected non-empty string (max 256 chars)`);
  }
}

/**
 * Call an MCP tool with Tasks protocol support.
 *
 * If the server supports MCP Tasks and the tool has `taskSupport: 'optional' | 'required'`,
 * uses `callToolStream()` which handles task creation, polling, and result retrieval.
 *
 * If the server doesn't support tasks, falls back to regular `client.callTool()`.
 *
 * The stream is consumed with a timeout. If the task doesn't complete within the timeout,
 * returns a working-status response with the MCP task_id for follow-up polling.
 */
export async function callMCPToolWithTasks(
  agentUrl: string,
  toolName: string,
  args: Record<string, unknown>,
  authToken?: string,
  debugLogs: DebugLogEntry[] = [],
  customHeaders?: Record<string, string>,
  options?: { workingTimeout?: number }
): Promise<unknown> {
  return withSpan(
    'adcp.mcp.call_tool',
    {
      'adcp.tool': toolName,
      'http.url': agentUrl,
    },
    async () => {
      const authHeaders = buildAuthHeaders(authToken, customHeaders);
      const workingTimeout = options?.workingTimeout ?? 120_000;

      // Log auth configuration (matching callMCPTool debug format for test compatibility)
      debugLogs.push({
        type: 'info',
        message: `MCP: Auth configuration`,
        timestamp: new Date().toISOString(),
        hasAuth: !!authToken,
        headers: authToken ? { 'x-adcp-auth': '***' } : {},
        customHeaderKeys: customHeaders ? Object.keys(customHeaders) : [],
      });

      debugLogs.push({
        type: 'info',
        message: `MCP: Calling tool ${toolName} with args: ${JSON.stringify(redactArgsForLog(args))}`,
        timestamp: new Date().toISOString(),
      });

      if (authToken) {
        debugLogs.push({
          type: 'info',
          message: `MCP: Transport configured with x-adcp-auth header for ${toolName}`,
          timestamp: new Date().toISOString(),
        });
      }

      return withCachedConnection(agentUrl, authToken, authHeaders, debugLogs, toolName, async client => {
        // Check if server supports MCP Tasks
        if (!serverSupportsTasks(client)) {
          debugLogs.push({
            type: 'info',
            message: `MCP Tasks: Server does not support tasks, using standard callTool for ${toolName}`,
            timestamp: new Date().toISOString(),
          });
          const response = (await client.callTool({ name: toolName, arguments: args })) as CallToolResponse;

          debugLogs.push({
            type: response?.isError ? 'error' : 'success',
            message: `MCP: Tool ${toolName} response received (${response?.isError ? 'error' : 'success'})`,
            timestamp: new Date().toISOString(),
            response: response,
          });

          return response;
        }

        // Ensure tool metadata is cached so the SDK's isToolTask() works correctly.
        // Without this, callToolStream silently skips task creation for tools that
        // declare taskSupport: 'optional' | 'required'.
        await ensureToolsListed(client);

        debugLogs.push({
          type: 'info',
          message: `MCP Tasks: Server supports tasks, using callToolStream for ${toolName}`,
          timestamp: new Date().toISOString(),
        });

        // Use callToolStream which handles the full task lifecycle
        const stream = client.experimental.tasks.callToolStream({ name: toolName, arguments: args }, undefined, {
          timeout: workingTimeout,
          resetTimeoutOnProgress: true,
        });

        let capturedTaskId: string | undefined;
        let capturedTask: { taskId: string; status: string; pollInterval?: number } | undefined;

        try {
          for await (const message of stream) {
            switch (message.type) {
              case 'taskCreated':
                capturedTaskId = message.task.taskId;
                capturedTask = message.task;
                debugLogs.push({
                  type: 'info',
                  message: `MCP Tasks: Task created ${capturedTaskId} for ${toolName}`,
                  timestamp: new Date().toISOString(),
                });
                break;

              case 'taskStatus':
                capturedTask = message.task;
                debugLogs.push({
                  type: 'info',
                  message: `MCP Tasks: Status update for ${capturedTaskId}: ${message.task.status}`,
                  timestamp: new Date().toISOString(),
                });
                break;

              case 'result': {
                debugLogs.push({
                  type: 'success',
                  message: `MCP: Tool ${toolName} response received (success)`,
                  timestamp: new Date().toISOString(),
                  response: message.result,
                });
                return message.result as CallToolResponse;
              }

              case 'error': {
                debugLogs.push({
                  type: 'error',
                  message: `MCP Tasks: Error for ${toolName}: ${message.error.message}`,
                  timestamp: new Date().toISOString(),
                });
                // The MCP Tasks SDK error event may strip structured content.
                // If we have a taskId, fetch the full result to recover adcp_error data
                // and return it as a proper isError response for downstream unwrapping.
                if (capturedTaskId) {
                  try {
                    const taskResult = await client.experimental.tasks.getTaskResult(capturedTaskId);
                    const content = taskResult?.content as Array<{ type: string; text?: string }> | undefined;
                    if (content) {
                      return {
                        isError: true,
                        content,
                        structuredContent: taskResult?.structuredContent,
                      } as unknown as CallToolResponse;
                    }
                  } catch {
                    // Failed to fetch task result — fall through to throw
                  }
                }
                throw message.error;
              }
            }
          }
        } catch (error) {
          // If we timed out but have a taskId, return a working status
          // so the caller can poll via getMCPTaskStatus/getMCPTaskResult
          if (capturedTaskId && error instanceof Error && error.message.includes('Timeout')) {
            debugLogs.push({
              type: 'info',
              message: `MCP Tasks: Timeout for ${toolName}, returning working status with taskId ${capturedTaskId}`,
              timestamp: new Date().toISOString(),
            });

            return {
              structuredContent: {
                status: 'working',
                task_id: capturedTaskId,
                poll_interval: capturedTask?.pollInterval,
              },
            };
          }
          throw error;
        }

        // Stream ended without result — shouldn't happen with well-behaved servers
        if (capturedTaskId) {
          return {
            structuredContent: {
              status: 'working',
              task_id: capturedTaskId,
              poll_interval: capturedTask?.pollInterval,
            },
          };
        }

        throw new Error(`MCP Tasks: callToolStream for ${toolName} ended without result or task`);
      });
    }
  );
}

/**
 * Get task status via MCP Tasks protocol method (not tool call).
 * Re-throws auth errors (401) — only catches protocol capability errors.
 */
export async function getMCPTaskStatus(
  agentUrl: string,
  taskId: string,
  authToken?: string,
  debugLogs: DebugLogEntry[] = [],
  toolName?: string
): Promise<TaskInfo> {
  validateTaskId(taskId);
  const authHeaders = buildAuthHeaders(authToken);

  return withCachedConnection(agentUrl, authToken, authHeaders, debugLogs, `tasks/get:${taskId}`, async client => {
    const result = await client.experimental.tasks.getTask(taskId);
    debugLogs.push({
      type: 'info',
      message: `MCP Tasks: getTask ${taskId} → ${result.status}`,
      timestamp: new Date().toISOString(),
    });
    return mapMCPTaskToTaskInfo(
      result as {
        taskId: string;
        status: string;
        createdAt: string;
        lastUpdatedAt: string;
        statusMessage?: string;
        pollInterval?: number;
      },
      toolName
    );
  });
}

/**
 * Get task result via MCP Tasks protocol method (blocks until terminal).
 */
export async function getMCPTaskResult(
  agentUrl: string,
  taskId: string,
  authToken?: string,
  debugLogs: DebugLogEntry[] = []
): Promise<unknown> {
  validateTaskId(taskId);
  const authHeaders = buildAuthHeaders(authToken);

  return withCachedConnection(agentUrl, authToken, authHeaders, debugLogs, `tasks/result:${taskId}`, async client => {
    const result = await client.experimental.tasks.getTaskResult(taskId);
    debugLogs.push({
      type: 'success',
      message: `MCP Tasks: getTaskResult ${taskId} received`,
      timestamp: new Date().toISOString(),
    });
    return result;
  });
}

/**
 * List tasks via MCP Tasks protocol method.
 */
export async function listMCPTasks(
  agentUrl: string,
  authToken?: string,
  debugLogs: DebugLogEntry[] = []
): Promise<TaskInfo[]> {
  const authHeaders = buildAuthHeaders(authToken);

  return withCachedConnection(agentUrl, authToken, authHeaders, debugLogs, 'tasks/list', async client => {
    const result = await client.experimental.tasks.listTasks();
    debugLogs.push({
      type: 'info',
      message: `MCP Tasks: listTasks returned ${result.tasks.length} tasks`,
      timestamp: new Date().toISOString(),
    });
    return result.tasks.map((task: any) => mapMCPTaskToTaskInfo(task));
  });
}

/**
 * Cancel a task via MCP Tasks protocol method.
 */
export async function cancelMCPTask(
  agentUrl: string,
  taskId: string,
  authToken?: string,
  debugLogs: DebugLogEntry[] = []
): Promise<void> {
  validateTaskId(taskId);
  const authHeaders = buildAuthHeaders(authToken);

  await withCachedConnection(agentUrl, authToken, authHeaders, debugLogs, `tasks/cancel:${taskId}`, async client => {
    await client.experimental.tasks.cancelTask(taskId);
    debugLogs.push({
      type: 'info',
      message: `MCP Tasks: cancelTask ${taskId} succeeded`,
      timestamp: new Date().toISOString(),
    });
  });
}
