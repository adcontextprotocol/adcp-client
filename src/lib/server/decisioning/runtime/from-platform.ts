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
 * **v6.0 alpha scope** (current commit): wires the full v1.0 specialism
 * surface — `SalesPlatform` (all 5 tools, with `submitted` projection on
 * `create_media_buy` and `sync_creatives`), `CreativeTemplatePlatform` /
 * `CreativeGenerativePlatform` (`build_creative`, `preview_creative`,
 * `sync_creatives`), `AudiencePlatform.syncAudiences`, plus
 * `accounts.resolve` / `upsert` / `list`. Tools whose AdCP wire spec
 * lacks a Submitted arm (`update_media_buy`, `get_media_buy_delivery`,
 * `build_creative`, `sync_audiences`, `sync_accounts`) translate a
 * platform-side submitted return into an `INVALID_STATE` envelope with
 * the task_id in `details` — adopters whose async paths need wire
 * propagation should track their async work on tools that DO have a
 * Submitted arm (`create_media_buy`, `sync_creatives`).
 *
 * `ctx.startTask()` is also wired: returns a framework-managed `TaskHandle`
 * whose `notify(...)` persists lifecycle into the runtime's task registry.
 * Adopters call `notify(update)` from any context; the framework records
 * the update and exposes it via `server.getTaskState(taskId)`. `submitted`
 * outcomes carry `partialResult` into the registry record so test harnesses
 * (and the forthcoming `tasks/get` wire handler) can read it back.
 *
 * Reserved for upcoming commits: `tasks/get` wire integration so buyers
 * polling the registered task receive lifecycle updates back over MCP / A2A;
 * webhook emitter wiring so `notify` pushes a buyer-side
 * `push_notification_config.url` callback; per-tenant `getCapabilitiesFor`
 * runtime; "framework always calls accounts.resolve(authPrincipal)"
 * behavior for `'derived'` and `'implicit'` resolution modes.
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
import type { AsyncOutcome } from '../async-outcome';
import { AccountNotFoundError } from '../account';
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
  });
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
      const outcome = await sales.createMediaBuy(params, reqCtx);
      return projectMediaBuyOutcome(outcome);
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
      const outcome = await sales.updateMediaBuy(buyId, params, reqCtx);
      // update_media_buy wire spec has no Submitted arm. If the platform's
      // update path triggers an async approval workflow, return INVALID_STATE
      // with a recovery hint — buyer polls get_media_buys for resolution.
      if (outcome.kind === 'submitted') {
        return adcpError('INVALID_STATE', {
          message:
            'Update triggered an async approval workflow; AdCP update_media_buy has no submitted arm. Buyer should poll get_media_buys for resolution.',
          recovery: 'correctable',
          details: { task_id: outcome.taskHandle.taskId },
        });
      }
      return projectAsyncOutcome(outcome, buy => buy) as never;
    },

    syncCreatives: async (params, ctx) => {
      const reqCtx = buildRequestContext(ctx, { tool: 'sync_creatives', taskRegistry });
      const creatives = (params as { creatives?: unknown[] }).creatives ?? [];
      const outcome = await sales.syncCreatives(creatives as never[], reqCtx);
      if (outcome.kind === 'submitted') {
        return {
          status: 'submitted',
          task_id: outcome.taskHandle.taskId,
          ...(outcome.message !== undefined && { message: outcome.message }),
        };
      }
      return projectAsyncOutcome(outcome, results => ({
        creatives: results.map(r => ({
          creative_id: r.creative_id,
          status: r.status,
          ...(r.reason !== undefined && { reason: r.reason }),
        })),
      })) as never;
    },

    getMediaBuyDelivery: async (params, ctx) => {
      const reqCtx = buildRequestContext(ctx, { tool: 'get_media_buy_delivery', taskRegistry });
      const outcome = await sales.getMediaBuyDelivery(params, reqCtx);
      if (outcome.kind === 'submitted') {
        return adcpError('INVALID_STATE', {
          message:
            'Async report job started; AdCP get_media_buy_delivery has no submitted arm yet. Buyer should retry once data is available.',
          recovery: 'transient',
          details: { task_id: outcome.taskHandle.taskId },
        });
      }
      return projectAsyncOutcome(outcome, actuals => actuals) as never;
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
      const outcome = await creative.buildCreative(params, reqCtx);
      if (outcome.kind === 'submitted') {
        return adcpError('INVALID_STATE', {
          message:
            'Async creative generation started; AdCP build_creative has no submitted arm. Buyer should poll separately.',
          recovery: 'transient',
          details: { task_id: outcome.taskHandle.taskId },
        });
      }
      return projectAsyncOutcome(outcome, manifest => manifest) as never;
    },

    previewCreative: async (params, ctx) => {
      if (!('previewCreative' in creative)) {
        return adcpError('UNSUPPORTED_FEATURE', {
          message: 'preview_creative not supported by this platform',
          recovery: 'terminal',
        });
      }
      const reqCtx = buildRequestContext(ctx, { tool: 'preview_creative', taskRegistry });
      const outcome = await (creative as CreativeTemplatePlatform).previewCreative(params, reqCtx);
      return projectAsyncOutcome(outcome, preview => preview) as never;
    },

    syncCreatives: async (params, ctx) => {
      const reqCtx = buildRequestContext(ctx, { tool: 'sync_creatives', taskRegistry });
      const creatives = (params as { creatives?: unknown[] }).creatives ?? [];
      const outcome = await creative.syncCreatives(creatives as never[], reqCtx);
      if (outcome.kind === 'submitted') {
        return {
          status: 'submitted',
          task_id: outcome.taskHandle.taskId,
          ...(outcome.message !== undefined && { message: outcome.message }),
        };
      }
      return projectAsyncOutcome(outcome, results => ({
        creatives: results.map(r => ({
          creative_id: r.creative_id,
          status: r.status,
          ...(r.reason !== undefined && { reason: r.reason }),
        })),
      })) as never;
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
      const outcome = await audiences.syncAudiences(audienceList as never[], reqCtx);
      // sync_audiences wire spec has no Submitted arm — async match-rate
      // computation is reported via per-audience match_rate fields plus a
      // post-hoc getAudienceStatus poll.
      if (outcome.kind === 'submitted') {
        return adcpError('INVALID_STATE', {
          message:
            'Async audience match started; AdCP sync_audiences has no submitted arm. Buyer should poll getAudienceStatus.',
          recovery: 'transient',
          details: { task_id: outcome.taskHandle.taskId },
        });
      }
      return projectAsyncOutcome(outcome, results => ({ audiences: results })) as never;
    },
  };
}

function buildAccountHandlers<P extends DecisioningPlatform>(platform: P): AccountHandlers<Account> {
  return {
    syncAccounts: async (params, _ctx) => {
      const refs = ((params as { accounts?: unknown[] }).accounts ?? []) as never[];
      const outcome = await platform.accounts.upsert(refs);
      // sync_accounts wire spec has no Submitted arm — async account
      // provisioning surfaces via per-row `action: 'pending'` shape.
      if (outcome.kind === 'submitted') {
        return adcpError('INVALID_STATE', {
          message:
            'Async account provisioning started; AdCP sync_accounts has no submitted arm. Buyer should re-call after the workflow completes.',
          recovery: 'transient',
          details: { task_id: outcome.taskHandle.taskId },
        });
      }
      return projectAsyncOutcome(outcome, rows => ({ accounts: rows })) as never;
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

/**
 * Projection for `createMediaBuy` outcomes. `CreateMediaBuyResponse` has a
 * `Submitted` arm (`{ status: 'submitted', task_id, ... }`) so all three
 * AsyncOutcome arms map cleanly. Other media-buy mutations (update, delivery)
 * lack a wire submitted arm and handle that path with explicit
 * `INVALID_STATE` rejections inline at the call site.
 */
function projectMediaBuyOutcome<TBuy>(
  outcome: AsyncOutcome<TBuy>
): TBuy | { status: 'submitted'; task_id: string; message?: string } | AdcpErrorResponse {
  if (outcome.kind === 'submitted') {
    const submitted: { status: 'submitted'; task_id: string; message?: string } = {
      status: 'submitted',
      task_id: outcome.taskHandle.taskId,
    };
    if (outcome.message !== undefined) submitted.message = outcome.message;
    return submitted;
  }
  return projectAsyncOutcome(outcome, buy => buy) as TBuy | AdcpErrorResponse;
}

// ---------------------------------------------------------------------------
// AsyncOutcome → existing handler-return projection
//
// Reserved for upcoming commits that wire the async-eligible methods
// (createMediaBuy, syncCreatives, getMediaBuyDelivery, syncAudiences,
// accounts.upsert). v6.0 alpha exports the projection helper so the next
// commit's wiring can plug in directly.
// ---------------------------------------------------------------------------

/** @internal */
export function projectAsyncOutcome<TIn, TOut>(
  outcome: AsyncOutcome<TIn>,
  mapResult: (result: TIn) => TOut
): TOut | { status: 'submitted'; task_id: string; message?: string } | AdcpErrorResponse {
  switch (outcome.kind) {
    case 'sync':
      return mapResult(outcome.result);
    case 'rejected':
      return adcpError(outcome.error.code, {
        message: outcome.error.message,
        recovery: outcome.error.recovery,
        ...(outcome.error.field !== undefined && { field: outcome.error.field }),
        ...(outcome.error.suggestion !== undefined && { suggestion: outcome.error.suggestion }),
        ...(outcome.error.retry_after !== undefined && { retry_after: outcome.error.retry_after }),
        ...(outcome.error.details !== undefined && { details: outcome.error.details }),
      });
    case 'submitted': {
      const submitted: { status: 'submitted'; task_id: string; message?: string } = {
        status: 'submitted',
        task_id: outcome.taskHandle.taskId,
      };
      if (outcome.message !== undefined) submitted.message = outcome.message;
      return submitted;
    }
  }
}
