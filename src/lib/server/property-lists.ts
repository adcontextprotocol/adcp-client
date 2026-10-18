import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GetPropertyListRequest, GetPropertyListResponse } from '../types/tools.generated';
import { GetPropertyListRequestSchema, GetPropertyListResponseSchema } from '../types/schemas.generated';
import type { WebhookEmitter, WebhookEmitParams, WebhookEmitResult } from './webhook-emitter';
import { stripCtxMetadata } from './ctx-metadata/wire-shape';

export type PropertyListPage = Pick<
  GetPropertyListResponse,
  'list' | 'identifiers' | 'pagination' | 'resolved_at' | 'cache_valid_until' | 'coverage_gaps'
>;

export interface PropertyListToolOptions<TPrincipal> {
  /** Verify this token's access to this exact list on every request/page. Return null/false to deny access. */
  verifyToken: (input: {
    listId: string;
    token: string;
  }) => TPrincipal | null | false | Promise<TPrincipal | null | false>;
  /** Load an authorized page. Honor resolve:false without resolving identifiers. Cursors must be bound to the list and principal. */
  loadPage: (request: GetPropertyListRequest, principal: TPrincipal) => Promise<PropertyListPage>;
}

/**
 * Register a read-only MCP tool using per-list tokens, independently of normal
 * platform account credentials. Tokens arrive through Authorization: Bearer
 * or x-adcp-auth, never tool arguments. Mount on an MCP endpoint whose HTTP
 * auth layer permits list tokens through to this verifier.
 */
export function registerPropertyListTool<TPrincipal>(server: McpServer, options: PropertyListToolOptions<TPrincipal>) {
  return server.registerTool(
    'get_property_list',
    {
      description: 'Retrieve an authorized property list and a page of resolved identifiers.',
      inputSchema: GetPropertyListRequestSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (request, extra) => {
      const denied = () => toolError('PERMISSION_DENIED', 'Property list access denied.', request.context);
      const headers = extra.requestInfo?.headers ?? {};
      for (const name of ['authorization', 'x-adcp-auth']) {
        const values = Object.entries(headers).filter(([key]) => key.toLowerCase() === name);
        if (values.length > 1 || (values.length === 1 && typeof values[0]![1] !== 'string')) return denied();
      }
      const readHeader = (name: string): string | undefined => {
        const values = Object.entries(headers).filter(([key]) => key.toLowerCase() === name);
        if (values.length !== 1 || typeof values[0]![1] !== 'string') return undefined;
        return values[0]![1];
      };
      const authorization = readHeader('authorization');
      const bearer = authorization?.match(/^Bearer ([^\s]+)$/i)?.[1];
      const adcpToken = readHeader('x-adcp-auth');
      const authenticatedToken = extra.authInfo?.token;
      const tokens = [bearer, adcpToken, authenticatedToken].filter((token): token is string => token !== undefined);
      if (
        !tokens.length ||
        tokens.some(token => !token || token !== tokens[0]) ||
        (authorization !== undefined && !bearer)
      )
        return denied();
      let principal: TPrincipal | null | false;
      try {
        principal = await options.verifyToken({ listId: request.list_id, token: tokens[0]! });
      } catch {
        return denied();
      }
      if (principal === null || principal === false || principal === undefined) return denied();
      try {
        const page = await options.loadPage(request as GetPropertyListRequest, principal);
        if (page.list.list_id !== request.list_id) throw new Error('Invalid list identity');
        if (request.resolve !== false && !Array.isArray(page.identifiers))
          throw new Error('Missing resolved identifiers');
        const limit = request.pagination?.max_results ?? 1000;
        if (request.resolve !== false && (page.identifiers?.length ?? 0) > limit) throw new Error('Invalid page size');
        if (page.pagination?.has_more && !page.pagination.cursor) throw new Error('Missing continuation cursor');
        if (!page.pagination?.has_more && page.pagination?.cursor) throw new Error('Unexpected continuation cursor');
        const payload = GetPropertyListResponseSchema.parse({
          list: Object.fromEntries(
            [
              'list_id',
              'name',
              'description',
              'account',
              'base_properties',
              'filters',
              'brand',
              'webhook_url',
              'cache_duration_hours',
              'created_at',
              'updated_at',
              'property_count',
              'pricing_options',
            ]
              .filter(key => Object.hasOwn(page.list, key))
              .map(key => [key, (page.list as unknown as Record<string, unknown>)[key]])
          ),
          ...(page.identifiers !== undefined
            ? { identifiers: page.identifiers.map(identifier => ({ type: identifier.type, value: identifier.value })) }
            : {}),
          ...(page.pagination !== undefined
            ? {
                pagination: {
                  has_more: page.pagination.has_more,
                  cursor: page.pagination.cursor,
                  total_count: page.pagination.total_count,
                },
              }
            : {}),
          ...(page.resolved_at !== undefined ? { resolved_at: page.resolved_at } : {}),
          ...(page.cache_valid_until !== undefined ? { cache_valid_until: page.cache_valid_until } : {}),
          ...(page.coverage_gaps !== undefined ? { coverage_gaps: page.coverage_gaps } : {}),
          status: 'completed',
          ...(request.resolve === false ? { identifiers: undefined, pagination: undefined } : {}),
          ...(request.context ? { context: request.context } : {}),
        });
        stripCtxMetadata({ property_list: payload.list });
        return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }], structuredContent: payload };
      } catch {
        // Storage exceptions can contain list tokens or upstream credentials.
        return toolError('INTERNAL_ERROR', 'Property list could not be loaded.', request.context);
      }
    }
  );
}

function toolError(code: string, message: string, context?: unknown) {
  const payload = { status: 'failed', errors: [{ code, message }], ...(context !== undefined ? { context } : {}) };
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

export interface PropertyListChangedNotification {
  list_id: string;
  list_name?: string;
  resolved_at: string;
  cache_valid_until?: string;
  change_summary?: { properties_added?: number; properties_removed?: number; total_properties?: number };
}

export type SendPropertyListChangedOptions = Pick<
  WebhookEmitParams,
  'url' | 'delivery_id' | 'retries' | 'attemptAuthorizationContext'
> & { notification: PropertyListChangedNotification };

/** Send a summary-only notification through the SDK's signed, retrying delivery kernel. Reuse delivery_id and notification for retries. */
export async function sendPropertyListChanged(
  emitter: WebhookEmitter,
  options: SendPropertyListChangedOptions
): Promise<WebhookEmitResult> {
  const { notification, ...delivery } = options;
  const dateTime = z.string().datetime({ offset: true });
  if (
    !notification.list_id ||
    !dateTime.safeParse(notification.resolved_at).success ||
    (notification.cache_valid_until !== undefined && !dateTime.safeParse(notification.cache_valid_until).success)
  ) {
    throw new TypeError('Property-list notifications require a list_id and valid timestamps');
  }
  const summary =
    notification.change_summary === undefined
      ? undefined
      : Object.fromEntries(
          ['properties_added', 'properties_removed', 'total_properties']
            .filter(
              key =>
                Object.hasOwn(notification.change_summary!, key) &&
                (notification.change_summary as Record<string, unknown>)[key] !== undefined
            )
            .map(key => [key, (notification.change_summary as Record<string, unknown>)[key]])
        );
  for (const count of Object.values(summary ?? {})) {
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)
      throw new TypeError('Property-list change counts must be nonnegative integers');
  }
  return emitter.emit({
    ...delivery,
    authentication: null,
    signingProfile: 'adcp/webhook-signing/v1',
    payload: {
      event: 'property_list_changed',
      list_id: notification.list_id,
      resolved_at: notification.resolved_at,
      ...(notification.list_name !== undefined ? { list_name: notification.list_name } : {}),
      ...(notification.cache_valid_until !== undefined ? { cache_valid_until: notification.cache_valid_until } : {}),
      ...(summary !== undefined ? { change_summary: summary } : {}),
      signature: 'rfc9421',
    },
  });
}
