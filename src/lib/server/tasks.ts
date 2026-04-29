/**
 * Server-side helpers for MCP Tasks protocol support.
 *
 * Publishers can use these to add async task support to their AdCP MCP servers.
 * The MCP SDK handles all protocol plumbing (tasks/get, tasks/result, tasks/cancel,
 * tasks/list, TTL, _meta injection) — publishers only implement task creation and
 * result storage logic.
 *
 * @example
 * ```typescript
 * import { createTaskCapableServer, registerAdcpTaskTool, InMemoryTaskStore } from '@adcp/sdk';
 *
 * const server = createTaskCapableServer('My Publisher', '1.0.0');
 *
 * registerAdcpTaskTool(server, 'create_media_buy', {
 *   description: 'Create a media buy (async)',
 *   inputSchema: { campaign_name: z.string() },
 *   taskSupport: 'required',
 * }, {
 *   createTask: async (args, extra) => {
 *     const task = await extra.taskStore.createTask({ ttl: 300_000 });
 *     startBackgroundWork(task.taskId, args);
 *     return { task };
 *   },
 *   getTask: async (_args, extra) => {
 *     return extra.taskStore.getTask(extra.taskId);
 *   },
 *   getTaskResult: async (_args, extra) => {
 *     return extra.taskStore.getTaskResult(extra.taskId);
 *   },
 * });
 * ```
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdcpServer } from './adcp-server';
import { getSdkServer } from './adcp-server';
import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShapeCompat, AnySchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { ToolAnnotations, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolTaskHandler, TaskToolExecution } from '@modelcontextprotocol/sdk/experimental/tasks/interfaces.js';

// Re-export SDK task primitives so publishers don't import from experimental paths
import { InMemoryTaskStore as _InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
export { _InMemoryTaskStore as InMemoryTaskStore };
export { isTerminal } from '@modelcontextprotocol/sdk/experimental/tasks/interfaces.js';
export type {
  TaskStore,
  TaskMessageQueue,
  CreateTaskOptions,
  ToolTaskHandler,
  CreateTaskRequestHandlerExtra,
  TaskRequestHandlerExtra,
} from '@modelcontextprotocol/sdk/experimental/tasks/interfaces.js';
export type { CreateTaskResult, GetTaskResult, Task } from '@modelcontextprotocol/sdk/experimental/tasks/types.js';

/**
 * Build a task tool result response.
 *
 * Same pattern as `productsResponse()` / `mediaBuyResponse()` but designed for
 * use in `getTaskResult` handlers where you return the final async result.
 */
export function taskToolResponse(data: Record<string, unknown>, summary?: string): CallToolResult {
  return {
    content: [{ type: 'text', text: summary ?? 'Task completed' }],
    structuredContent: data,
  };
}

/**
 * Configuration for registering an AdCP task tool.
 */
export interface AdcpTaskToolConfig {
  description: string;
  title?: string;
  inputSchema?: ZodRawShapeCompat | AnySchema;
  outputSchema?: ZodRawShapeCompat | AnySchema;
  annotations?: ToolAnnotations;
  taskSupport?: 'optional' | 'required';
}

/**
 * Register an AdCP task-based tool on an MCP server.
 *
 * Wraps `server.experimental.tasks.registerToolTask()` with AdCP defaults.
 * Sets `execution.taskSupport` (default: 'optional') and passes through to the SDK.
 *
 * Accepts either an `AdcpServer` from `createAdcpServer()` or a raw SDK
 * `McpServer` from `createTaskCapableServer()` — the helper unwraps the
 * opaque handle when needed so registration reaches the SDK server.
 */
export function registerAdcpTaskTool(
  server: AdcpServer | McpServer,
  name: string,
  config: AdcpTaskToolConfig,
  handler: ToolTaskHandler<any>
): RegisteredTool {
  const mcp = getSdkServer(server as AdcpServer) ?? (server as McpServer);
  const { description, title, inputSchema, outputSchema, annotations, taskSupport = 'optional' } = config;

  const execution: TaskToolExecution = { taskSupport };

  const sdkConfig = {
    description,
    execution,
    ...(title != null && { title }),
    ...(outputSchema != null && { outputSchema }),
    ...(annotations != null && { annotations }),
  };

  if (inputSchema != null) {
    return mcp.experimental.tasks.registerToolTask(name, { ...sdkConfig, inputSchema }, handler);
  }

  return mcp.experimental.tasks.registerToolTask(
    name,
    sdkConfig as Parameters<typeof mcp.experimental.tasks.registerToolTask>[1],
    handler as ToolTaskHandler<undefined>
  );
}

/**
 * Create an MCP server with task support pre-configured.
 *
 * Sets up the server with a `taskStore` (defaults to `InMemoryTaskStore`) and
 * declares tasks capability. Publishers can then use `registerAdcpTaskTool()`
 * or `server.experimental.tasks.registerToolTask()` directly.
 *
 * This uses the higher-level `McpServer` API. Publishers with complex dispatch
 * patterns (e.g., custom request routing) can use the lower-level `Server` class
 * directly by passing `taskStore` in `ServerOptions` and using `setRequestHandler`
 * for task lifecycle methods. See the MCP SDK docs for that approach.
 */
export function createTaskCapableServer(
  name: string,
  version: string,
  options?: {
    taskStore?: import('@modelcontextprotocol/sdk/experimental/tasks/interfaces.js').TaskStore;
    taskMessageQueue?: import('@modelcontextprotocol/sdk/experimental/tasks/interfaces.js').TaskMessageQueue;
    instructions?: string;
  }
): McpServer {
  const taskStore = options?.taskStore ?? new _InMemoryTaskStore();

  return new McpServer({ name, version }, {
    capabilities: {
      tasks: {
        list: {},
        cancel: {},
        requests: {
          tools: {
            call: {},
          },
        },
      },
    },
    taskStore,
    taskMessageQueue: options?.taskMessageQueue,
    instructions: options?.instructions,
  } as ConstructorParameters<typeof McpServer>[1]);
}
