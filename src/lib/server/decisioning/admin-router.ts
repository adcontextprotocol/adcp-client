/**
 * Admin Express router for the v6.0 TenantRegistry.
 *
 * Mounted on a separate port / path from the public agent endpoint so
 * tenant traffic and ops surface stay independent. Adopters wire it
 * behind their existing auth (basic auth, mTLS, OAuth introspection):
 *
 * ```ts
 * import express from 'express';
 * import { createTenantAdminRouter } from '@adcp/client/server/decisioning';
 *
 * const adminApp = express();
 * adminApp.use('/admin', requireOpsAuth, createTenantAdminRouter(registry));
 * adminApp.listen(9090);
 * ```
 *
 * Endpoints:
 *
 *   - `GET    /tenants`              — list all tenants with health status
 *   - `GET    /tenants/:id`          — single tenant status (404 if unknown)
 *   - `POST   /tenants/:id/recheck`  — force JWKS revalidation (returns new status)
 *   - `DELETE /tenants/:id`          — unregister (idempotent; 204 either way)
 *
 * All responses are JSON. Missing tenants return 404 + `{ error: 'tenant_not_found' }`.
 *
 * Status: Preview / 6.0.
 *
 * @public
 */

import type { Request, Response, NextFunction, IRouter } from 'express';
import type { TenantRegistry } from './tenant-registry';

/**
 * Minimal Express-router-shaped object so we don't need a hard dependency
 * on the Express types in this file. Adopters who use a different framework
 * (Koa, Fastify) can mount the same handler functions via the framework's
 * adapter — `createTenantAdminHandlers(registry)` returns the bare handlers.
 */
export interface RouterLike {
  get(path: string, handler: (req: Request, res: Response, next?: NextFunction) => void): unknown;
  post(path: string, handler: (req: Request, res: Response, next?: NextFunction) => void): unknown;
  delete(path: string, handler: (req: Request, res: Response, next?: NextFunction) => void): unknown;
}

export interface TenantAdminHandlers {
  listTenants(req: Request, res: Response): void;
  getTenant(req: Request, res: Response): void;
  recheckTenant(req: Request, res: Response): Promise<void>;
  unregisterTenant(req: Request, res: Response): void;
}

/**
 * Bare handlers — for adopters running a non-Express framework. The router
 * helper below mounts these on the standard paths.
 */
export function createTenantAdminHandlers(registry: TenantRegistry): TenantAdminHandlers {
  return {
    listTenants(_req: Request, res: Response): void {
      res.json({ tenants: registry.list() });
    },

    getTenant(req: Request, res: Response): void {
      const id = req.params.id;
      if (!id) {
        res.status(400).json({ error: 'tenant_id_required' });
        return;
      }
      const status = registry.getStatus(id);
      if (!status) {
        res.status(404).json({ error: 'tenant_not_found', tenant_id: id });
        return;
      }
      res.json(status);
    },

    async recheckTenant(req: Request, res: Response): Promise<void> {
      const id = req.params.id;
      if (!id) {
        res.status(400).json({ error: 'tenant_id_required' });
        return;
      }
      try {
        const status = await registry.recheck(id);
        res.json(status);
      } catch (err) {
        if (err instanceof Error && /not registered/.test(err.message)) {
          res.status(404).json({ error: 'tenant_not_found', tenant_id: id });
          return;
        }
        res.status(500).json({
          error: 'recheck_failed',
          tenant_id: id,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    },

    unregisterTenant(req: Request, res: Response): void {
      const id = req.params.id;
      if (!id) {
        res.status(400).json({ error: 'tenant_id_required' });
        return;
      }
      registry.unregister(id);
      res.status(204).end();
    },
  };
}

/**
 * Build an Express router with the standard admin endpoints mounted.
 * Pass an `express.Router()` instance to mount on (so we don't need an
 * Express dependency in this file).
 */
export function mountTenantAdmin(router: RouterLike, registry: TenantRegistry): RouterLike {
  const handlers = createTenantAdminHandlers(registry);
  router.get('/tenants', handlers.listTenants);
  router.get('/tenants/:id', handlers.getTenant);
  router.post('/tenants/:id/recheck', handlers.recheckTenant);
  router.delete('/tenants/:id', handlers.unregisterTenant);
  return router;
}

/**
 * Convenience: takes an `express` import and a registry, returns a
 * mounted `Router` ready to attach. Usage:
 *
 * ```ts
 * import express from 'express';
 * import { createTenantAdminRouter } from '@adcp/client/server/decisioning';
 * adminApp.use('/admin', createTenantAdminRouter(express.Router(), registry));
 * ```
 *
 * The `routerFactory` argument lets adopters pre-configure middleware
 * (auth, logging) on the router before passing it in.
 */
export function createTenantAdminRouter<R extends RouterLike>(routerFactory: R, registry: TenantRegistry): R {
  mountTenantAdmin(routerFactory, registry);
  return routerFactory;
}

export type { IRouter };
