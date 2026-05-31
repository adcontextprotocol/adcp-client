/**
 * Path-routed TenantRegistry + Express StreamableHTTP auth example.
 *
 * Use this shape when an existing buyer-facing Express app already owns a
 * public path such as `/storefront/:platformId/mcp` and existing auth
 * middleware, but you want SDK-owned tenant servers instead of constructing
 * one AdCP server per buyer request.
 *
 * The important boundary is:
 *
 *   Express auth middleware -> req.user -> req.auth -> ctx.authInfo -> accounts.resolve()
 *
 * Tenant selection stays at the route/registry boundary. Buyer identity stays
 * in MCP `AuthInfo`, so platform handlers do not close over Express `req.user`.
 *
 * Mount this route after your JSON body parser, for example
 * `app.use(express.json({ limit: '2mb' }))`.
 */

import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { mcpAcceptHeaderMiddleware } from '@adcp/sdk/express-mcp';
import {
  createTenantRegistry,
  type AccountStore,
  type DecisioningAdcpServer,
  type ResolveContext,
  type TenantRegistry,
  type TenantSigningKey,
} from '@adcp/sdk/server';
import type { AccountReference } from '@adcp/sdk/types';
import { ProgrammaticSeller } from './decisioning-platform-programmatic';
import { BroadcastTvSeller } from './decisioning-platform-broadcast-tv';

type PlatformId = 'snap' | 'vertex';

interface StorefrontUser {
  buyerCustomerId: string;
  accessToken: string;
  scopes: string[];
}

type StorefrontRequest = Request<{ platformId: string }, unknown, unknown> & {
  user?: StorefrontUser;
  auth?: AuthInfo;
  body?: unknown;
};

interface ProgrammaticCtxMeta {
  network_id: string;
  advertiser_id: string;
  buyer_customer_id: string;
  tenant_id: PlatformId;
  [key: string]: unknown;
}

interface BroadcastCtxMeta {
  agency_buyer_id: string;
  affiliate_advertiser_id: string;
  buyer_customer_id: string;
  tenant_id: PlatformId;
  [key: string]: unknown;
}

/**
 * Existing apps usually already have this function behind their auth
 * middleware. The example accepts it as a dependency instead of inventing
 * bearer tokens or fake users.
 */
export type VerifyStorefrontUser = (req: Request) => Promise<StorefrontUser | null>;

// ---------------------------------------------------------------------------
// PRODUCTION: REPLACE WITH KMS-BACKED LOADER
// ---------------------------------------------------------------------------
//
// The registry can serve unsigned tenants in AdCP 3.x, so this example returns
// undefined to keep the route runnable before KMS/brand.json is wired. In a
// production signed-webhook deployment, load one tenant-specific key from your
// KMS or secret manager and publish the public half in that tenant's brand.json.
// Never commit private signing material to source.
// ---------------------------------------------------------------------------
async function loadTenantSigningKey(_tenantId: PlatformId): Promise<TenantSigningKey | undefined> {
  return undefined;
}

function optionalSigningKey(signingKey: TenantSigningKey | undefined): { signingKey?: TenantSigningKey } {
  return signingKey ? { signingKey } : {};
}

class StorefrontProgrammaticSeller extends ProgrammaticSeller {
  override accounts: AccountStore<ProgrammaticCtxMeta> = {
    resolve: async (ref: AccountReference | undefined, ctx?: ResolveContext) => {
      const buyerCustomerId = buyerCustomerIdFrom(ctx);
      if (!buyerCustomerId) return null;
      const accountId = accountIdFrom(ref) ?? `snap_${buyerCustomerId}`;
      return {
        id: accountId,
        name: `Snap storefront account ${accountId}`,
        status: 'active',
        operator: 'snap.example.com',
        ctx_metadata: {
          network_id: this.capabilities.config.networkId,
          advertiser_id: buyerCustomerId,
          buyer_customer_id: buyerCustomerId,
          tenant_id: 'snap',
        },
        authInfo: { kind: 'oauth', token: ctx?.authInfo?.token, principal: buyerCustomerId },
      };
    },
  };
}

class StorefrontBroadcastSeller extends BroadcastTvSeller {
  override accounts: AccountStore<BroadcastCtxMeta> = {
    resolve: async (ref: AccountReference | undefined, ctx?: ResolveContext) => {
      const buyerCustomerId = buyerCustomerIdFrom(ctx);
      if (!buyerCustomerId) return null;
      const accountId = accountIdFrom(ref) ?? `vertex_${buyerCustomerId}`;
      return {
        id: accountId,
        name: `Vertex storefront account ${accountId}`,
        status: 'active',
        operator: 'vertex.example.com',
        ctx_metadata: {
          agency_buyer_id: buyerCustomerId,
          affiliate_advertiser_id: accountId,
          buyer_customer_id: buyerCustomerId,
          tenant_id: 'vertex',
        },
        authInfo: { kind: 'oauth', token: ctx?.authInfo?.token, principal: buyerCustomerId },
      };
    },
  };
}

export async function buildPathRoutedStorefrontRegistry(): Promise<TenantRegistry> {
  const registry = createTenantRegistry({
    defaultServerOptions: {
      name: 'path-routed-storefront',
      version: '0.0.1',
      validation: { requests: 'strict', responses: 'strict' },
    },
    autoValidate: true,
  });

  registry.register('snap', {
    agentUrl: 'https://storefront.example.com/storefront/snap/mcp',
    ...optionalSigningKey(await loadTenantSigningKey('snap')),
    platform: new StorefrontProgrammaticSeller(),
    label: 'Snap Storefront',
    serverOptions: { name: 'snap-storefront', version: '1.0.0' },
  });

  registry.register('vertex', {
    agentUrl: 'https://storefront.example.com/storefront/vertex/mcp',
    ...optionalSigningKey(await loadTenantSigningKey('vertex')),
    platform: new StorefrontBroadcastSeller(),
    label: 'Vertex Storefront',
    serverOptions: { name: 'vertex-storefront', version: '1.0.0' },
  });

  return registry;
}

export interface MountPathRoutedStorefrontOptions {
  /**
   * Existing app-specific verifier. Return null for unauthenticated requests;
   * the middleware below maps that to 401 before the MCP transport runs.
   */
  verifyUser: VerifyStorefrontUser;
}

export function mountPathRoutedStorefront(
  app: Pick<Express, 'all'>,
  registry: TenantRegistry,
  options: MountPathRoutedStorefrontOptions
): void {
  const acceptMiddleware = mcpAcceptHeaderMiddleware() as RequestHandler;
  const authMiddleware = createStorefrontAuthMiddleware(options.verifyUser);

  app.all('/storefront/:platformId/mcp', acceptMiddleware, authMiddleware, async (req: Request, res: Response) => {
    const storefrontReq = req as StorefrontRequest;
    const platformId = normalizePlatformId(storefrontReq.params.platformId);
    if (!platformId) {
      res.status(404).json({ error: 'unknown platform' });
      return;
    }

    // Express already decoded `:platformId`, so prefer direct tenant lookup.
    // If your app uses a catch-all route instead, use
    // `registry.resolveByRequest(req.headers.host!, req.path)` here.
    const resolved = registry.get(platformId);
    if (!resolved) {
      res.status(404).json({ error: 'tenant unavailable' });
      return;
    }

    storefrontReq.auth = toMcpAuthInfo(storefrontReq.user!);
    await handleWithPerRequestTransport(resolved.server, storefrontReq, res, storefrontReq.body);
  });
}

function createStorefrontAuthMiddleware(verifyUser: VerifyStorefrontUser): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await verifyUser(req);
      if (!user) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      (req as StorefrontRequest).user = user;
      next();
    } catch (err) {
      next(err);
    }
  };
}

function toMcpAuthInfo(user: StorefrontUser): AuthInfo {
  return {
    token: user.accessToken,
    clientId: user.buyerCustomerId,
    scopes: user.scopes,
    extra: {
      buyerCustomerId: user.buyerCustomerId,
    },
  };
}

const transportLocks = new WeakMap<DecisioningAdcpServer, Promise<void>>();

async function handleWithPerRequestTransport(
  server: DecisioningAdcpServer,
  req: StorefrontRequest,
  res: Response,
  parsedBody: unknown
): Promise<void> {
  const runTransportCycle = async (): Promise<void> => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      if (parsedBody !== undefined) {
        await transport.handleRequest(req, res, parsedBody);
      } else {
        await transport.handleRequest(req, res);
      }
    } catch (err) {
      console.error('MCP transport error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    } finally {
      await server.close();
    }
  };

  const previous = transportLocks.get(server) ?? Promise.resolve();
  const current = previous.then(runTransportCycle, runTransportCycle);
  transportLocks.set(
    server,
    current.catch(() => {})
  );
  await current;
}

function buyerCustomerIdFrom(ctx: ResolveContext | undefined): string | undefined {
  const value = ctx?.authInfo?.extra?.buyerCustomerId;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function accountIdFrom(ref: AccountReference | undefined): string | undefined {
  return ref && 'account_id' in ref ? ref.account_id : undefined;
}

function normalizePlatformId(value: string | undefined): PlatformId | null {
  return value === 'snap' || value === 'vertex' ? value : null;
}
