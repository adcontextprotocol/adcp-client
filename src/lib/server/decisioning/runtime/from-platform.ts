/**
 * Build an `AdcpServer` from a `DecisioningPlatform` impl.
 *
 * v6.0 alpha entry point. Translates the per-specialism platform interface
 * into the framework's existing handler-style config and delegates to
 * `createAdcpServer()`. This means every framework primitive — idempotency,
 * RFC 9421 signing, governance, schema validation, state store, MCP/A2A
 * wire mapping, sandbox boundary — applies unchanged. The new code is the
 * adapter shim, not a forked runtime.
 *
 * **Adopter shape** (after the round-5 refactor): platform methods are plain
 * `async (req, ctx) => Promise<T>`. Return the success value to project to
 * the wire success arm; `throw new AdcpError(...)` to project to the wire
 * `adcp_error` envelope with structured fields (code/recovery/field/
 * suggestion/retry_after). Generic thrown errors (`Error`, `TypeError`)
 * fall through to the framework's `SERVICE_UNAVAILABLE` mapping.
 *
 * For async opt-in, adopters use `ctx.runAsync(opts, fn)` (in-process —
 * framework races against a timeout, auto-defers, auto-completes) or
 * `ctx.startTask()` (out-of-process — adopter persists the taskId, webhook
 * handler calls `server.completeTask(taskId, result)` later).
 *
 * **Wired surface** (current commit): `SalesPlatform` (all 5 tools),
 * `CreativeTemplatePlatform` / `CreativeGenerativePlatform`
 * (buildCreative, previewCreative, syncCreatives), `AudiencePlatform.syncAudiences`,
 * `accounts.resolve` / `upsert` / `list`. Plus `ctx.startTask()` wired to
 * an in-memory task registry that `taskHandle.notify` writes into;
 * `server.getTaskState(taskId)` reads back.
 *
 * Reserved for upcoming commits: `ctx.runAsync` (timeout race + auto-defer);
 * `tasks/get` wire handler so buyers poll the registry over MCP / A2A;
 * webhook emitter wiring on `notify` push; per-tenant `getCapabilitiesFor`;
 * "framework always calls accounts.resolve(authPrincipal)" for
 * `'derived'` / `'implicit'` resolution modes.
 *
 * Status: Preview / 6.0. Not yet exported from the public `./server`
 * subpath; reach in via `@adcp/client/server/decisioning/runtime` for
 * spike experimentation only.
 *
 * @public
 */

import type { AdcpServer } from '../../adcp-server';
import {
  createAdcpServer,
  type AdcpServerConfig,
  type MediaBuyHandlers,
  type CreativeHandlers,
  type EventTrackingHandlers,
  type AccountHandlers,
} from '../../create-adcp-server';
import type { DecisioningPlatform, RequiredPlatformsFor } from '../platform';
import type { Account } from '../account';
import { AccountNotFoundError } from '../account';
import { AdcpError, TaskDeferredError } from '../async-outcome';
import type { CreativeTemplatePlatform } from '../specialisms/creative';
import { adcpError, type AdcpErrorResponse } from '../../errors';
import { validatePlatform } from './validate-platform';
import { buildRequestContext } from './to-context';
import { createInMemoryTaskRegistry, type TaskRegistry, type TaskRecord } from './task-registry';

export interface CreateAdcpServerFromPlatformOptions extends Omit<
  AdcpServerConfig,
  'mediaBuy' | 'creative' | 'accounts' | 'eventTracking' | 'resolveAccount' | 'capabilities' | 'name' | 'version'
> {
  name: string;
  version: string;
  /**
   * Override the framework's task registry. Useful for tests that want to
   * pre-seed task records or assert on them across multiple servers.
   * Defaults to a fresh `createInMemoryTaskRegistry()` per server instance.
   */
  taskRegistry?: TaskRegistry;
}

/**
 * Adcp server returned by `createAdcpServerFromPlatform`. Adds task-state
 * accessors on top of the standard `AdcpServer` so test harnesses (and the
 * forthcoming `tasks/get` wire handler) can inspect lifecycle.
 */
export interface DecisioningAdcpServer extends AdcpServer {
  getTaskState<TResult = unknown>(taskId: string): TaskRecord<TResult> | null;
  /**
   * Await any in-flight background completion for `taskId` (`ctx.runAsync`
   * post-timeout work). Resolves immediately if the task is already
   * terminal or has no registered background. Used by tests + the
   * `tasks/get` wire path for deterministic settlement.
   */
  awaitTask(taskId: string): Promise<void>;
}

/**
 * Build an `AdcpServer` from a `DecisioningPlatform`. Validates specialism
 * × platform-interface invariants at construction (in addition to the
 * compile-time `RequiredPlatformsFor<S>` gate).
 */
export function createAdcpServerFromPlatform<P extends DecisioningPlatform>(
  platform: P & RequiredPlatformsFor<P['capabilities']['specialisms'][number]>,
  opts: CreateAdcpServerFromPlatformOptions
): DecisioningAdcpServer {
  validatePlatform(platform);

  const taskRegistry = opts.taskRegistry ?? createInMemoryTaskRegistry();

  const config: AdcpServerConfig<Account> = {
    ...opts,
    resolveAccount: async ref => {
      try {
        return await platform.accounts.resolve(ref);
      } catch (err) {
        if (err instanceof AccountNotFoundError) return null;
        throw err;
      }
    },
    mediaBuy: buildMediaBuyHandlers(platform, taskRegistry),
    creative: buildCreativeHandlers(platform, taskRegistry),
    eventTracking: buildEventTrackingHandlers(platform, taskRegistry),
    accounts: buildAccountHandlers(platform),
  };

  const server = createAdcpServer(config);

  return Object.assign(server, {
    getTaskState: <TResult = unknown>(taskId: string): TaskRecord<TResult> | null =>
      taskRegistry.getTask<TResult>(taskId),
    awaitTask: (taskId: string): Promise<void> => taskRegistry.awaitTask(taskId),
  });
}

// ---------------------------------------------------------------------------
// AdcpError catch + project — adopter throws, framework projects.
// ---------------------------------------------------------------------------

type SubmittedEnvelope = {
  status: 'submitted';
  task_id: string;
  message?: string;
  partial_result?: unknown;
};

/**
 * Run a platform method and project the outcome onto the wire dispatch
 * shape. Three throw branches:
 *
 *   - `TaskDeferredError` (from `ctx.runAsync` timing out): project to a
 *     submitted wire envelope carrying the framework-issued `task_id`,
 *     `message`, and optional `partial_result`. The original work promise
 *     keeps running in the background; on resolve the registry's terminal
 *     state is updated via `taskHandle.notify`.
 *   - `AdcpError`: project to the wire `adcp_error` envelope with full
 *     structured fields.
 *   - Other thrown errors: propagate to the framework's existing
 *     `SERVICE_UNAVAILABLE` mapping.
 */
async function projectPlatformCall<TResult, TWire>(
  fn: () => Promise<TResult>,
  mapResult: (r: TResult) => TWire
): Promise<TWire | SubmittedEnvelope | AdcpErrorResponse> {
  try {
    return mapResult(await fn());
  } catch (err) {
    if (err instanceof TaskDeferredError) {
      const env: SubmittedEnvelope = {
        status: 'submitted',
        task_id: err.taskHandle.taskId,
      };
      if (err.statusMessage !== undefined) env.message = err.statusMessage;
      if (err.partialResult !== undefined) env.partial_result = err.partialResult;
      return env;
    }
    if (err instanceof AdcpError) {
      return adcpError(err.code, {
        message: err.message,
        recovery: err.recovery,
        ...(err.field !== undefined && { field: err.field }),
        ...(err.suggestion !== undefined && { suggestion: err.suggestion }),
        ...(err.retry_after !== undefined && { retry_after: err.retry_after }),
        ...(err.details !== undefined && { details: err.details }),
      });
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Specialism → handler-map adapters
// ---------------------------------------------------------------------------

function buildMediaBuyHandlers<P extends DecisioningPlatform>(
  platform: P,
  taskRegistry: TaskRegistry
): MediaBuyHandlers<Account> | undefined {
  const sales = platform.sales;
  if (!sales) return undefined;
  return {
    getProducts: async (params, ctx) => {
      const reqCtx = buildRequestContext(ctx, { tool: 'get_products', taskRegistry });
      return sales.getProducts(params, reqCtx);
    },

    createMediaBuy: async (params, ctx) => {
      const reqCtx = buildRequestContext(ctx, { tool: 'create_media_buy', taskRegistry });
      return (await projectPlatformCall(
        () => sales.createMediaBuy(params, reqCtx),
        buy => buy
      )) as never;
    },

    updateMediaBuy: async (params, ctx) => {
      const reqCtx = buildRequestContext(ctx, { tool: 'update_media_buy', taskRegistry });
      const buyId = (params as { media_buy_id?: string }).media_buy_id;
      if (!buyId) {
        return adcpError('INVALID_REQUEST', {
          message: 'update_media_buy requires media_buy_id',
          field: 'media_buy_id',
          recovery: 'correctable',
        });
      }
      return (await projectPlatformCall(
        () => sales.updateMediaBuy(buyId, params, reqCtx),
        buy => buy
      )) as never;
    },

    syncCreatives: async (params, ctx) => {
      const reqCtx = buildRequestContext(ctx, { tool: 'sync_creatives', taskRegistry });
      const creatives = (params as { creatives?: unknown[] }).creatives ?? [];
      return (await projectPlatformCall(
        () => sales.syncCreatives(creatives as never[], reqCtx),
        results => ({
          creatives: results.map(r => ({
            creative_id: r.creative_id,
            status: r.status,
            ...(r.reason !== undefined && { reason: r.reason }),
          })),
        })
      )) as never;
    },

    getMediaBuyDelivery: async (params, ctx) => {
      const reqCtx = buildRequestContext(ctx, { tool: 'get_media_buy_delivery', taskRegistry });
      return (await projectPlatformCall(
        () => sales.getMediaBuyDelivery(params, reqCtx),
        actuals => actuals
      )) as never;
    },
  };
}

function buildCreativeHandlers<P extends DecisioningPlatform>(
  platform: P,
  taskRegistry: TaskRegistry
): CreativeHandlers<Account> | undefined {
  const creative = platform.creative;
  if (!creative) return undefined;
  return {
    buildCreative: async (params, ctx) => {
      const reqCtx = buildRequestContext(ctx, { tool: 'build_creative', taskRegistry });
      return (await projectPlatformCall(
        () => creative.buildCreative(params, reqCtx),
        manifest => manifest
      )) as never;
    },

    previewCreative: async (params, ctx) => {
      if (!('previewCreative' in creative)) {
        return adcpError('UNSUPPORTED_FEATURE', {
          message: 'preview_creative not supported by this platform',
          recovery: 'terminal',
        });
      }
      const reqCtx = buildRequestContext(ctx, { tool: 'preview_creative', taskRegistry });
      return (await projectPlatformCall(
        () => (creative as CreativeTemplatePlatform).previewCreative(params, reqCtx),
        preview => preview
      )) as never;
    },

    syncCreatives: async (params, ctx) => {
      const reqCtx = buildRequestContext(ctx, { tool: 'sync_creatives', taskRegistry });
      const creatives = (params as { creatives?: unknown[] }).creatives ?? [];
      return (await projectPlatformCall(
        () => creative.syncCreatives(creatives as never[], reqCtx),
        results => ({
          creatives: results.map(r => ({
            creative_id: r.creative_id,
            status: r.status,
            ...(r.reason !== undefined && { reason: r.reason }),
          })),
        })
      )) as never;
    },
  };
}

function buildEventTrackingHandlers<P extends DecisioningPlatform>(
  platform: P,
  taskRegistry: TaskRegistry
): EventTrackingHandlers<Account> | undefined {
  const audiences = platform.audiences;
  if (!audiences) return undefined;
  return {
    syncAudiences: async (params, ctx) => {
      const reqCtx = buildRequestContext(ctx, { tool: 'sync_audiences', taskRegistry });
      const audienceList = (params as { audiences?: unknown[] }).audiences ?? [];
      return (await projectPlatformCall(
        () => audiences.syncAudiences(audienceList as never[], reqCtx),
        results => ({ audiences: results })
      )) as never;
    },
  };
}

function buildAccountHandlers<P extends DecisioningPlatform>(platform: P): AccountHandlers<Account> {
  return {
    syncAccounts: async (params, _ctx) => {
      const refs = ((params as { accounts?: unknown[] }).accounts ?? []) as never[];
      return (await projectPlatformCall(
        () => platform.accounts.upsert(refs),
        rows => ({ accounts: rows })
      )) as never;
    },
    listAccounts: async (params, _ctx) => {
      const filter = params as { brand_domain?: string; operator?: string; cursor?: string; limit?: number };
      const page = await platform.accounts.list(filter as never);
      return {
        accounts: page.items as never,
        ...(page.nextCursor != null && { next_cursor: page.nextCursor }),
      };
    },
  };
}
