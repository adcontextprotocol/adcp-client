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
  type ResourceMetadata,
  type RegisteredTool as ModernRegisteredTool,
  type StandardSchemaWithJSON,
  type ServerContext,
  type Tool as ModernTool,
  type ToolAnnotations,
} from '@modelcontextprotocol/server';
import { toNodeHandler, toWebRequest, type NodeMcpRequestHandler } from '@modelcontextprotocol/node';
import type { IncomingMessage } from 'http';
import {
  getSdkServer,
  getSdkServerInfo,
  getSdkServerInstructions,
  getMcpToolProfile,
  isRegisteredToolVisible,
  isToolAvailableForVersion,
  listMcpAppResources,
  listRegisteredToolDefinitions,
  type AdcpAuthInfo,
  type AdcpServer,
  type RegisteredToolDefinition,
} from './adcp-server';
import { ADCP_INSTRUCTIONS_RESOLVER, MEDIA_BUY_MCP_TOOL_PROFILE } from './create-adcp-server';
import { mcpAppResourceMetadata, readMcpAppResource } from './mcp-app';
import { getMcpToolSchema, getMcpToolSummary } from '../validation/schema-loader';

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

function linkedMcpAppResourceUri(tool: { _meta?: Record<string, unknown> }): string | undefined {
  const ui = tool._meta?.['ui'];
  if (ui === null || typeof ui !== 'object') return undefined;
  const resourceUri = (ui as Record<string, unknown>)['resourceUri'];
  return typeof resourceUri === 'string' ? resourceUri : undefined;
}

let warnedAboutCustomSchemaJsonConversion = false;

function hasStandardJsonSchema(schema: unknown): boolean {
  if (schema === null || typeof schema !== 'object') return false;
  const standard = (schema as Record<string, unknown>)['~standard'];
  if (standard === null || typeof standard !== 'object') return false;
  const jsonSchema = (standard as Record<string, unknown>)['jsonSchema'];
  return jsonSchema !== null && typeof jsonSchema === 'object';
}

function hasJsonConversionForSchemaOrRawShape(schema: unknown): boolean {
  if (hasStandardJsonSchema(schema)) return true;
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return false;
  const entries = Object.values(schema as Record<string, unknown>);
  return entries.length > 0 && entries.every(hasStandardJsonSchema);
}

function officialAdcpInputSchema(
  toolName: string,
  adcpVersion: string,
  profile: 'media-buy' | 'all'
): Readonly<Record<string, unknown>> | undefined {
  // Use the exact manifest for the negotiated MCP era. The compact catalog
  // resolves through its role profile; `all` resolves through the generic
  // transport manifest and never borrows constraints from a narrower role.
  const projection = getMcpToolSchema(
    toolName,
    'input',
    {
      protocolVersion: '2026-07-28',
      ...(profile === 'media-buy' && { profile: 'media-buy' }),
    },
    adcpVersion
  );
  return projection;
}

function officialAdcpToolSummary(
  toolName: string,
  adcpVersion: string,
  profile: 'media-buy' | 'all'
): string | undefined {
  return getMcpToolSummary(
    toolName,
    {
      protocolVersion: '2026-07-28',
      ...(profile === 'media-buy' && { profile: 'media-buy' }),
    },
    adcpVersion
  );
}

function schemaForModernMcp(schema: unknown, hasOfficialSchema: boolean): StandardSchemaWithJSON {
  if (!hasOfficialSchema && !hasJsonConversionForSchemaOrRawShape(schema) && !warnedAboutCustomSchemaJsonConversion) {
    warnedAboutCustomSchemaJsonConversion = true;
    console.warn(
      '[adcp/serve] A custom MCP tool schema does not expose ~standard.jsonSchema. ' +
        'With Zod, complete modern tools/list schemas require zod >=4.2.0. ' +
        'Current AdCP tools use bundled official JSON Schemas, but this custom or legacy tool may be advertised with an empty schema.'
    );
  }
  return schema as StandardSchemaWithJSON;
}

/** Build a strict 2026-07-28 handler around one configured AdCP server. @internal */
export function createModernMcpServerAdapter(agentServer: AdcpServer): ModernMcpServerAdapter {
  const sdkServer = getSdkServer(agentServer);
  if (!sdkServer) {
    throw new Error('Modern MCP serving requires an AdcpServer backed by the official MCP SDK');
  }

  const serverInfo = getSdkServerInfo(sdkServer);
  const toolDefinitions = listRegisteredToolDefinitions(sdkServer);
  const adcpVersion = agentServer.getAdcpVersion();
  const activeMcpToolProfile = getMcpToolProfile(agentServer);
  const mediaBuyProfileTools = new Set<string>(MEDIA_BUY_MCP_TOOL_PROFILE);
  const isInActiveDiscoveryProfile = (toolName: string): boolean =>
    activeMcpToolProfile === 'all' || mediaBuyProfileTools.has(toolName);
  const modernToolDefinitions: Array<
    Omit<RegisteredToolDefinition, 'inputSchema' | 'outputSchema'> & {
      inputSchema?: StandardSchemaWithJSON;
      advertisedInputSchema?: Readonly<Record<string, unknown>>;
      outputSchema?: StandardSchemaWithJSON;
    }
  > = toolDefinitions.map(tool => {
    const { inputSchema, outputSchema, ...definition } = tool;
    const description = tool.description ?? officialAdcpToolSummary(tool.name, adcpVersion, activeMcpToolProfile);
    // Framework-registered AdCP tools carry the version marker below. A
    // hand-wrapped adopter tool may reuse an official name while intentionally
    // defining a different contract; advertising the official schema for that
    // tool would lie about the schema enforced at call time.
    const frameworkAdcpTool = tool._meta?.adcp_version === adcpVersion;
    const advertisedInputSchema = frameworkAdcpTool
      ? officialAdcpInputSchema(tool.name, adcpVersion, activeMcpToolProfile)
      : undefined;
    return {
      ...definition,
      ...(description !== undefined && { description }),
      ...(inputSchema !== undefined && {
        // Keep call-time validation on the adopter/framework schema. The
        // framework's AdCP validator must see domain-invalid objects so it can
        // return a structured `adcp_error` + context echo; the official strict
        // projection remains discovery-only below.
        inputSchema: schemaForModernMcp(inputSchema, advertisedInputSchema !== undefined),
      }),
      ...(advertisedInputSchema !== undefined && { advertisedInputSchema }),
      // Output schemas can dwarf the input discovery surface and are not
      // required for clients to form tool calls. Preserve an adopter's
      // explicitly registered schema, but do not replace it with a bundled
      // full AdCP response projection.
      ...(outputSchema !== undefined && { outputSchema: outputSchema as StandardSchemaWithJSON }),
    };
  });
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
      const toolVisibility = new Map<string, boolean>();
      const registeredTools = new Map<string, ModernRegisteredTool>();
      for (const tool of modernToolDefinitions) {
        const versionAvailable = isToolAvailableForVersion(agentServer, tool.name, agentServer.getAdcpVersion());
        const visible =
          versionAvailable && (await isRegisteredToolVisible(agentServer, { toolName: tool.name, authInfo }));
        toolVisibility.set(tool.name, visible);
        if (!visible) continue;
        const config = {
          ...(tool.title !== undefined && { title: tool.title }),
          ...(tool.description !== undefined && { description: tool.description }),
          ...(tool.outputSchema !== undefined && {
            outputSchema: tool.outputSchema,
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
            // Only strengthen calls for tools whose exact official schema we
            // advertise. Hidden compatibility tools remain directly callable
            // and retain the adopter's configured validation mode.
            ...(tool.advertisedInputSchema !== undefined && { enforceRequestSchema: true }),
          });

        if (tool.inputSchema !== undefined) {
          registeredTools.set(
            tool.name,
            modern.registerTool(tool.name, { ...config, inputSchema: tool.inputSchema }, async (args, ctx) =>
              invoke((args ?? {}) as Record<string, unknown>, ctx)
            )
          );
        } else {
          registeredTools.set(
            tool.name,
            modern.registerTool(tool.name, config, async ctx => invoke({}, ctx))
          );
        }
      }

      // Keep every authorized handler registered for direct compatibility
      // calls, but make the role profile a discovery concern only. The
      // low-level handler override is the public MCP SDK extension point for
      // response shaping; tool dispatch continues through McpServer's own
      // registered tools/call handler and validation pipeline.
      if (registeredTools.size > 0) {
        modern.server.setRequestHandler('tools/list', () => ({
          tools: modernToolDefinitions
            .filter(tool => toolVisibility.get(tool.name) === true && isInActiveDiscoveryProfile(tool.name))
            .map(tool => {
              const registered = registeredTools.get(tool.name)!;
              return {
                name: tool.name,
                ...(tool.title !== undefined && { title: tool.title }),
                ...(tool.description !== undefined && { description: tool.description }),
                inputSchema: (tool.advertisedInputSchema ??
                  modern.toolInputSchemaJson(tool.name) ?? {
                    type: 'object',
                    properties: {},
                  }) as unknown as ModernTool['inputSchema'],
                ...(registered.outputSchemaJson !== undefined && { outputSchema: registered.outputSchemaJson }),
                ...(tool.annotations !== undefined && { annotations: tool.annotations as ToolAnnotations }),
                ...(tool._meta !== undefined && { _meta: tool._meta }),
              };
            }),
          _meta: {
            adcp_version: adcpVersion,
            adcp_profile: activeMcpToolProfile,
          },
        }));
      }

      // `createMcpHandler` reconstructs the MCP v2 server for every request,
      // so resources must be registered inside the factory rather than once
      // when the opaque AdCP server is created.
      for (const resource of listMcpAppResources(agentServer)) {
        const linkedTools = toolDefinitions.filter(tool => linkedMcpAppResourceUri(tool) === resource.uri);
        if (
          linkedTools.length > 0 &&
          !linkedTools.some(tool => toolVisibility.get(tool.name) === true && isInActiveDiscoveryProfile(tool.name))
        )
          continue;
        modern.registerResource(
          resource.name,
          resource.uri,
          mcpAppResourceMetadata(resource) as ResourceMetadata,
          async (uri, ctx) =>
            readMcpAppResource(resource, uri, {
              signal: ctx.mcpReq.signal,
            })
        );
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
