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
 * **Adopter shape** (v2.1 dual-method): each spec-HITL tool has a method-pair.
 * Adopter implements EXACTLY ONE per pair. `validatePlatform()` enforces
 * exactly-one at construction; the framework dispatches on whichever is
 * defined:
 *
 *   - Sync (`xxx`): framework awaits in foreground; return value projects to
 *     the wire success arm. `throw new AdcpError(...)` projects to the wire
 *     `adcp_error` envelope.
 *   - HITL (`xxxTask`): framework allocates `taskId` BEFORE calling, returns
 *     the submitted envelope to the buyer immediately, then invokes
 *     `xxxTask(taskId, ...)` in the background. Method's return value
 *     becomes the task's terminal `result`; thrown `AdcpError` becomes the
 *     terminal `error`.
 *
 * Generic thrown errors (`Error`, `TypeError`) fall through to the
 * framework's `SERVICE_UNAVAILABLE` mapping.
 *
 * **Wired surface** (current commit): `SalesPlatform` (all 5 tools, dual-
 * method on get_products / create_media_buy / update_media_buy /
 * sync_creatives), `CreativeTemplatePlatform` / `CreativeGenerativePlatform`
 * (build_creative / sync_creatives dual-method, preview_creative sync-only),
 * `AudiencePlatform.syncAudiences` sync-only with status changes via the
 * upcoming `publishStatusChange` event bus, `accounts.resolve` / `upsert` /
 * `list`.
 *
 * Reserved for upcoming commits: `tasks/get` wire handler so buyers poll
 * the registry over MCP / A2A; `publishStatusChange` event bus + MCP
 * Resources subscription extension; per-tenant `getCapabilitiesFor`;
 * TenantRegistry with per-tenant health states.
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
  type SignalsHandlers,
  type HandlerContext,
} from '../../create-adcp-server';
import type { DecisioningPlatform, RequiredPlatformsFor } from '../platform';
import type { Account } from '../account';
import { AccountNotFoundError, toWireAccount } from '../account';
import { AdcpError } from '../async-outcome';
import type { CreativeTemplatePlatform } from '../specialisms/creative';
import type { Audience } from '../specialisms/audiences';
import type { RequestContext } from '../context';
import type { CreativeAsset, AccountReference } from '../../../types/tools.generated';
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
   * Defaults to a fresh `createInMemoryTaskRegistry()` per server instance
   * (gated by NODE_ENV — see `buildDefaultTaskRegistry`).
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
   * Await any in-flight background completion for `taskId` (HITL `*Task`
   * method still running). Resolves immediately if the task is terminal
   * or has no registered background. Used by tests + the `tasks/get` wire
   * path for deterministic settlement.
   */
  awaitTask(taskId: string): Promise<void>;
}

// Use `DecisioningPlatform<any, any>` for the generic constraint. The default
// `TMeta = Record<string, unknown>` doesn't accept adopter metadata interfaces
// without an index signature (e.g., `interface MyMeta { brand_id: string }`),
// which is a needless friction point — adopter metadata is opaque to the
// framework, so we don't need to constrain it here.
export function createAdcpServerFromPlatform<P extends DecisioningPlatform<any, any>>(
  platform: P & RequiredPlatformsFor<P['capabilities']['specialisms'][number]>,
  opts: CreateAdcpServerFromPlatformOptions
): DecisioningAdcpServer {
  validatePlatform(platform);

  const taskRegistry = opts.taskRegistry ?? buildDefaultTaskRegistry();

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
    signals: buildSignalsHandlers(platform),
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
// Default task registry — gated by NODE_ENV
// ---------------------------------------------------------------------------

/**
 * Build the default in-memory task registry, gated by NODE_ENV.
 *
 * The in-memory registry loses task state on process restart — fine for
 * tests and local dev, NOT fine for production. Gate via allowlist:
 * `NODE_ENV` must be `'test'` or `'development'`, OR the operator must
 * explicitly opt in via `ADCP_DECISIONING_ALLOW_INMEMORY_TASKS=1`.
 *
 * Pattern follows `feedback_node_env_allowlist.md`: never compare
 * `=== 'production'` (production may unset NODE_ENV entirely); always
 * allowlist the safe modes.
 */
function buildDefaultTaskRegistry(): TaskRegistry {
  const env = process.env.NODE_ENV;
  const safe = env === 'test' || env === 'development';
  const ack = process.env.ADCP_DECISIONING_ALLOW_INMEMORY_TASKS === '1';
  if (!safe && !ack) {
    throw new Error(
      'createAdcpServerFromPlatform: in-memory task registry refused outside ' +
        '{NODE_ENV=test, NODE_ENV=development}. Pass `taskRegistry` explicitly ' +
        '(e.g., a durable Postgres-backed registry — landing in v6.0-rc.1), ' +
        'OR set ADCP_DECISIONING_ALLOW_INMEMORY_TASKS=1 if you accept that ' +
        'in-flight tasks are lost on process restart.'
    );
  }
  return createInMemoryTaskRegistry();
}

// ---------------------------------------------------------------------------
// Sync vs HITL dispatch
// ---------------------------------------------------------------------------

type SubmittedEnvelope = {
  status: 'submitted';
  task_id: string;
};

/**
 * Project a sync platform call onto the wire dispatch shape. `AdcpError`
 * throws → wire `adcp_error` envelope; other thrown errors bubble to the
 * framework's `SERVICE_UNAVAILABLE` mapping.
 */
async function projectSync<TResult, TWire>(
  fn: () => Promise<TResult>,
  mapResult: (r: TResult) => TWire
): Promise<TWire | AdcpErrorResponse> {
  try {
    const result = await fn();
    return mapResult(result);
  } catch (err) {
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

/**
 * HITL dispatch: allocate task, return submitted envelope to buyer
 * immediately, run `*Task(taskId, ...)` in background. Method's return
 * value becomes terminal `result`; throws become terminal `error`.
 */
function dispatchHitl<TResult>(
  taskRegistry: TaskRegistry,
  opts: { tool: string; accountId: string },
  taskFn: (taskId: string) => Promise<TResult>
): SubmittedEnvelope {
  const { taskId } = taskRegistry.create({ tool: opts.tool, accountId: opts.accountId });

  const completion: Promise<void> = (async () => {
    try {
      const result = await taskFn(taskId);
      taskRegistry.complete(taskId, result);
    } catch (err) {
      if (err instanceof AdcpError) {
        taskRegistry.fail(taskId, err.toStructuredError());
      } else {
        taskRegistry.fail(taskId, {
          code: 'SERVICE_UNAVAILABLE',
          recovery: 'transient',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  })();
  taskRegistry._registerBackground(taskId, completion);

  return { status: 'submitted', task_id: taskId };
}

// ---------------------------------------------------------------------------
// Specialism → handler-map adapters
// ---------------------------------------------------------------------------

function ctxFor(handlerCtx: HandlerContext<Account>): RequestContext<Account> {
  return buildRequestContext(handlerCtx);
}

function buildMediaBuyHandlers<P extends DecisioningPlatform<any, any>>(
  platform: P,
  taskRegistry: TaskRegistry
): MediaBuyHandlers<Account> | undefined {
  const sales = platform.sales;
  if (!sales) return undefined;

  return {
    getProducts: async (params, ctx) => {
      const reqCtx = ctxFor(ctx);
      return projectSync(
        () => sales.getProducts(params, reqCtx),
        r => r
      );
    },

    createMediaBuy: async (params, ctx) => {
      const reqCtx = ctxFor(ctx);
      if (sales.createMediaBuyTask) {
        return dispatchHitl(taskRegistry, { tool: 'create_media_buy', accountId: reqCtx.account.id }, taskId =>
          sales.createMediaBuyTask!(taskId, params, reqCtx)
        );
      }
      return projectSync(
        () => sales.createMediaBuy!(params, reqCtx),
        r => r
      );
    },

    updateMediaBuy: async (params, ctx) => {
      const reqCtx = ctxFor(ctx);
      const buyId = (params as { media_buy_id?: string }).media_buy_id;
      if (!buyId) {
        return adcpError('INVALID_REQUEST', {
          message: 'update_media_buy requires media_buy_id',
          field: 'media_buy_id',
          recovery: 'correctable',
        });
      }
      return projectSync(
        () => sales.updateMediaBuy(buyId, params, reqCtx),
        r => r
      );
    },

    syncCreatives: async (params, ctx) => {
      const reqCtx = ctxFor(ctx);
      const creatives = ((params as { creatives?: CreativeAsset[] }).creatives ?? []) as CreativeAsset[];
      if (sales.syncCreativesTask) {
        return dispatchHitl(taskRegistry, { tool: 'sync_creatives', accountId: reqCtx.account.id }, taskId =>
          sales.syncCreativesTask!(taskId, creatives, reqCtx)
        );
      }
      return projectSync(
        () => sales.syncCreatives!(creatives, reqCtx),
        rows => ({ creatives: rows })
      );
    },

    getMediaBuyDelivery: async (params, ctx) => {
      const reqCtx = ctxFor(ctx);
      return projectSync(
        () => sales.getMediaBuyDelivery(params, reqCtx),
        actuals => actuals
      );
    },
  };
}

function buildCreativeHandlers<P extends DecisioningPlatform<any, any>>(
  platform: P,
  taskRegistry: TaskRegistry
): CreativeHandlers<Account> | undefined {
  const creative = platform.creative;
  if (!creative) return undefined;

  return {
    buildCreative: async (params, ctx) => {
      const reqCtx = ctxFor(ctx);
      // build_creative is sync-only at the wire level — BuildCreativeResponse
      // doesn't define a Submitted arm. Long-running generation awaits in
      // the request; status changes for downstream effects flow via
      // publishStatusChange.
      return projectSync(
        () => creative.buildCreative(params, reqCtx),
        manifest => ({ creative_manifest: manifest })
      );
    },

    previewCreative: async (params, ctx) => {
      if (!('previewCreative' in creative)) {
        return adcpError('UNSUPPORTED_FEATURE', {
          message: 'preview_creative not supported by this platform',
          recovery: 'terminal',
        });
      }
      const reqCtx = ctxFor(ctx);
      return projectSync(
        () => (creative as CreativeTemplatePlatform).previewCreative(params, reqCtx),
        preview => preview
      );
    },

    syncCreatives: async (params, ctx) => {
      const reqCtx = ctxFor(ctx);
      const creatives = ((params as { creatives?: CreativeAsset[] }).creatives ?? []) as CreativeAsset[];
      if (creative.syncCreativesTask) {
        return dispatchHitl(taskRegistry, { tool: 'sync_creatives', accountId: reqCtx.account.id }, taskId =>
          creative.syncCreativesTask!(taskId, creatives, reqCtx)
        );
      }
      return projectSync(
        () => creative.syncCreatives!(creatives, reqCtx),
        rows => ({ creatives: rows })
      );
    },
  };
}

function buildEventTrackingHandlers<P extends DecisioningPlatform<any, any>>(
  platform: P,
  _taskRegistry: TaskRegistry
): EventTrackingHandlers<Account> | undefined {
  const audiences = platform.audiences;
  if (!audiences) return undefined;
  return {
    syncAudiences: async (params, ctx) => {
      const reqCtx = ctxFor(ctx);
      const audienceList = ((params as { audiences?: Audience[] }).audiences ?? []) as Audience[];
      return projectSync(
        () => audiences.syncAudiences(audienceList, reqCtx),
        rows => ({ audiences: rows })
      );
    },
  };
}

function buildSignalsHandlers<P extends DecisioningPlatform<any, any>>(
  platform: P
): SignalsHandlers<Account> | undefined {
  const signals = platform.signals;
  if (!signals) return undefined;
  return {
    getSignals: async (params, ctx) => {
      const reqCtx = ctxFor(ctx);
      return projectSync(
        () => signals.getSignals(params, reqCtx),
        r => r
      );
    },
    activateSignal: async (params, ctx) => {
      const reqCtx = ctxFor(ctx);
      return projectSync(
        () => signals.activateSignal(params, reqCtx),
        r => r
      );
    },
  };
}

function buildAccountHandlers<P extends DecisioningPlatform<any, any>>(platform: P): AccountHandlers<Account> {
  return {
    syncAccounts: async (params, _ctx) => {
      if (!platform.accounts.upsert) {
        return adcpError('UNSUPPORTED_FEATURE', {
          message: 'sync_accounts not supported by this platform',
          recovery: 'terminal',
        });
      }
      const refs = ((params as { accounts?: AccountReference[] }).accounts ?? []) as AccountReference[];
      return projectSync(
        () => platform.accounts.upsert!(refs),
        rows => ({ accounts: rows })
      );
    },
    listAccounts: async (params, _ctx) => {
      if (!platform.accounts.list) {
        return adcpError('UNSUPPORTED_FEATURE', {
          message: 'list_accounts not supported by this platform',
          recovery: 'terminal',
        });
      }
      const filter = params as Parameters<NonNullable<typeof platform.accounts.list>>[0];
      const page = await platform.accounts.list(filter);
      return {
        accounts: page.items.map(toWireAccount),
        ...(page.nextCursor != null && { next_cursor: page.nextCursor }),
      };
    },
  };
}
