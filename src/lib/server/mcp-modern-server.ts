/**
 * MCP 2026-07-28 server adapter.
 *
 * AdCP's handler pipeline remains registered on the v1 SDK server so legacy
 * MCP Tasks continue to work. This adapter mirrors only the public tool
 * definitions into the official v2 SDK and dispatches calls through the
 * opaque AdcpServer.invoke() surface.
 */

import {
  McpServer as ModernMcpServer,
  createMcpHandler,
  isLegacyRequest,
  type AuthInfo as ModernAuthInfo,
  type StandardSchemaWithJSON,
  type ServerContext,
  type ToolAnnotations,
} from '@modelcontextprotocol/server';
import { toNodeHandler, toWebRequest, type NodeMcpRequestHandler } from '@modelcontextprotocol/node';
import type { IncomingMessage } from 'http';
import {
  getSdkServer,
  getSdkServerInfo,
  getSdkServerInstructions,
  isRegisteredToolVisible,
  listRegisteredToolDefinitions,
  type AdcpAuthInfo,
  type AdcpServer,
} from './adcp-server';
import { ADCP_INSTRUCTIONS_RESOLVER } from './create-adcp-server';

export interface ModernMcpServerAdapter {
  handle: NodeMcpRequestHandler;
  isLegacyRequest(req: IncomingMessage, parsedBody: unknown): Promise<boolean>;
  close(): Promise<void>;
}

function toAdcpAuthInfo(authInfo: ModernAuthInfo | undefined): AdcpAuthInfo | undefined {
  if (!authInfo) return undefined;
  return {
    token: authInfo.token,
    clientId: authInfo.clientId,
    scopes: authInfo.scopes,
    ...(authInfo.expiresAt !== undefined && { expiresAt: authInfo.expiresAt }),
    ...(authInfo.extra !== undefined && { extra: authInfo.extra }),
  };
}

/** Build a strict 2026-07-28 handler around one configured AdCP server. @internal */
export function createModernMcpServerAdapter(agentServer: AdcpServer): ModernMcpServerAdapter {
  const sdkServer = getSdkServer(agentServer);
  if (!sdkServer) {
    throw new Error('Modern MCP serving requires an AdcpServer backed by the official MCP SDK');
  }

  const serverInfo = getSdkServerInfo(sdkServer);
  const toolDefinitions = listRegisteredToolDefinitions(sdkServer);
  const handler = createMcpHandler(
    async requestContext => {
      if (requestContext.requestInfo?.headers.get('mcp-method') === 'server/discover') {
        const instructionsResolver = (agentServer as unknown as Record<symbol, unknown>)[ADCP_INSTRUCTIONS_RESOLVER];
        if (typeof instructionsResolver === 'function') {
          await (instructionsResolver as () => Promise<string | undefined>)();
        }
      }
      const modern = new ModernMcpServer(
        { name: serverInfo.name, version: serverInfo.version },
        { instructions: getSdkServerInstructions(sdkServer) }
      );

      const authInfo = toAdcpAuthInfo(requestContext.authInfo);
      for (const tool of toolDefinitions) {
        if (!(await isRegisteredToolVisible(agentServer, { toolName: tool.name, authInfo }))) continue;
        const config = {
          ...(tool.title !== undefined && { title: tool.title }),
          ...(tool.description !== undefined && { description: tool.description }),
          ...(tool.outputSchema !== undefined && {
            outputSchema: tool.outputSchema as StandardSchemaWithJSON,
          }),
          ...(tool.annotations !== undefined && { annotations: tool.annotations as ToolAnnotations }),
          ...(tool._meta !== undefined && { _meta: tool._meta }),
        };
        const invoke = (args: Record<string, unknown>, ctx: ServerContext) =>
          agentServer.invoke({
            toolName: tool.name,
            args,
            authInfo: toAdcpAuthInfo(ctx.http?.authInfo),
            signal: ctx.mcpReq.signal,
          });

        if (tool.inputSchema !== undefined) {
          modern.registerTool(
            tool.name,
            { ...config, inputSchema: tool.inputSchema as StandardSchemaWithJSON },
            async (args, ctx) => invoke((args ?? {}) as Record<string, unknown>, ctx)
          );
        } else {
          modern.registerTool(tool.name, config, async ctx => invoke({}, ctx));
        }
      }

      return modern;
    },
    {
      legacy: 'reject',
      onerror(error) {
        console.error('[adcp/serve] modern MCP error:', error);
      },
    }
  );

  return {
    handle: toNodeHandler(handler, {
      onerror(error) {
        console.error('[adcp/serve] modern MCP Node adapter error:', error);
      },
    }),
    async isLegacyRequest(req, parsedBody) {
      const request = await toWebRequest(req, parsedBody);
      return isLegacyRequest(request, parsedBody);
    },
    close: () => handler.close(),
  };
}
