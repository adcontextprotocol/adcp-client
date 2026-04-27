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
  type GovernanceHandlers,
  type HandlerContext,
} from '../../create-adcp-server';
import type { DecisioningPlatform, RequiredPlatformsFor } from '../platform';
import type { Account } from '../account';
import { AccountNotFoundError, toWireAccount } from '../account';
import { AdcpError } from '../async-outcome';
import type { CreativeTemplatePlatform } from '../specialisms/creative';
import type { CreativeAdServerPlatform } from '../specialisms/creative-ad-server';
import type { Audience } from '../specialisms/audiences';
import type { RequestContext } from '../context';
import type { AccountReference } from '../../../types/tools.generated';
import { adcpError, type AdcpErrorResponse } from '../../errors';
import { validatePlatform, PlatformConfigError } from './validate-platform';
import type { AdcpLogger } from '../../create-adcp-server';
import { buildRequestContext } from './to-context';
import { createInMemoryTaskRegistry, type TaskRegistry, type TaskRecord } from './task-registry';
import { createInMemoryStatusChangeBus, type StatusChangeBus } from '../status-changes';

export interface CreateAdcpServerFromPlatformOptions extends Omit<
  AdcpServerConfig,
  'resolveAccount' | 'capabilities' | 'name' | 'version'
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
  /**
   * Override the framework's status-change event bus for this server.
   * Defaults to a fresh per-server `createInMemoryStatusChangeBus()` so
   * tests get isolation without touching the module-level singleton from
   * `publishStatusChange(...)`. Adopters who publish from non-handler code
   * (webhook handlers, crons) typically use the module-level primitive
   * — pass an explicit bus here only when you want a per-server channel.
   */
  statusChangeBus?: StatusChangeBus;

  /**
   * Merge-seam collision behavior. When an adopter-supplied custom handler
   * (e.g. `opts.mediaBuy.getMediaBuys`) collides with a platform-derived
   * handler (e.g. `platform.sales.getMediaBuys`), the platform-derived one
   * wins per-key and the adopter override is silently shadowed.
   *
   * Modes:
   * - `'warn'` (default) — log a warning at every construction that hits a
   *   collision. Migration signal without breaking running deployments.
   * - `'log-once'` — log a warning the first time each `(domain, keys)`
   *   collision is seen in the process; subsequent constructions with the
   *   same shape stay silent. Right default for multi-tenant hosts (one
   *   process, N `createAdcpServerFromPlatform` calls) and hot-reload dev
   *   (server reconstructed every file change).
   * - `'strict'` — throw `PlatformConfigError`. Recommended for CI / new
   *   deployments where the v6 surface is the canonical source.
   * - `'silent'` — skip the check. For adopters who deliberately use the
   *   merge seam as an override (e.g., wrapping platform behavior with
   *   logging in their custom handler).
   */
  mergeSeam?: MergeSeamMode;

  /**
   * Override the webhook emitter the framework uses to push HITL task
   * completion to the buyer's `push_notification_config.url`. Default: when
   * the host wired `webhooks` on the underlying `AdcpServerConfig`, use
   * `ctx.emitWebhook` from the per-request HandlerContext (the framework
   * binds `webhookEmitter.emit` to it). Pass an explicit emitter here when
   * you want a dedicated webhook delivery path for task completions
   * (different signing key, different retry policy, different fetch impl)
   * separate from your other webhook emissions, or to inject a fake for
   * tests without wiring full RFC 9421 signing.
   */
  taskWebhookEmitter?: { emit: NonNullable<HandlerContext<Account>['emitWebhook']> };

  // ---------------------------------------------------------------------
  // Custom-handler escape hatch (incremental migration seam)
  // ---------------------------------------------------------------------
  //
  // The inherited `mediaBuy` / `creative` / `accounts` / `eventTracking` /
  // `signals` / `governance` / `brandRights` / `sponsoredIntelligence`
  // / `testController` keys (from `AdcpServerConfig`) accept raw
  // handler-style entries for tools the v6 platform doesn't yet model.
  //
  // **Merge semantics**: platform-derived handlers WIN per-key. Adopter-
  // supplied handlers fill gaps for un-wired tools (`getMediaBuys`,
  // `listCreativeFormats`, `providePerformanceFeedback`, `reportUsage`,
  // `syncEventSources`, `logEvent`, `getAccountFinancials`, content-
  // standards CRUD, etc.).
  //
  // Lets adopters with established handler-style adapters migrate
  // incrementally — move sales / audiences / signals to the v6 platform
  // shape today, keep custom handlers wired for tools whose specialism
  // interfaces are deferred to v1.1+ / rc.1 (event-tracking, catalog,
  // financials, content-standards, creative-review, brand-rights).
  //
  //     createAdcpServerFromPlatform(platform, {
  //       name: 'Adapter', version: '1.0.0',
  //       mediaBuy: {
  //         // platform.sales already wires get_products / create / update /
  //         // sync_creatives / get_media_buy_delivery; fill the rest:
  //         getMediaBuys: async (params, ctx) => myDb.queryBuys(params),
  //         providePerformanceFeedback: async (params, ctx) => ack(params),
  //       },
  //       eventTracking: {
  //         // platform.audiences wires sync_audiences; fill the trio:
  //         syncEventSources: async (params, ctx) => ...,
  //         logEvent: async (params, ctx) => ...,
  //         syncCatalogs: async (params, ctx) => ...,
  //       },
  //     });
}

/**
 * Adcp server returned by `createAdcpServerFromPlatform`. Adds task-state
 * accessors on top of the standard `AdcpServer` so test harnesses (and the
 * forthcoming `tasks/get` wire handler) can inspect lifecycle.
 */
export interface DecisioningAdcpServer extends AdcpServer {
  /**
   * Read the current lifecycle state for a HITL task. Returns `null` if the
   * `taskId` is unknown. Async to accommodate storage-backed task registries
   * (`createPostgresTaskRegistry`); the in-memory impl resolves synchronously.
   */
  getTaskState<TResult = unknown>(taskId: string): Promise<TaskRecord<TResult> | null>;
  /**
   * Await any in-flight background completion for `taskId` (HITL `*Task`
   * method still running). Resolves immediately if the task is terminal
   * or has no registered background. Used by tests + the `tasks/get` wire
   * path for deterministic settlement.
   */
  awaitTask(taskId: string): Promise<void>;
  /**
   * Per-server status-change bus. Delegates to the same internal bus the
   * framework uses for MCP Resources subscription projection.
   *
   * Use `server.statusChange.publish(...)` in tests to push events scoped
   * to this specific server instance — avoids contaminating sibling servers
   * that share the module-level `activeBus` when running multiple servers
   * in the same process. Production webhook/cron code that does not hold a
   * server reference keeps calling the module-level `publishStatusChange(...)`.
   *
   * **Projection wiring contract** (rc.1): when the MCP Resources subscription
   * projection commit lands, the projector MUST fan-in from BOTH this
   * per-server bus AND the module-level `activeBus`. Anchoring the subscriber
   * to only one source silently makes the other call site inert in production
   * — adopters who scope to `server.statusChange.publish(...)` for tenant
   * isolation must still reach buyer-facing subscriptions, and webhook/cron
   * code calling module-level `publishStatusChange(...)` must too.
   */
  statusChange: StatusChangeBus;
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
  const statusChangeBus = opts.statusChangeBus ?? createInMemoryStatusChangeBus();
  const taskWebhookEmit = opts.taskWebhookEmitter?.emit;
  const mergeOpts = {
    mode: opts.mergeSeam ?? 'warn',
    // eslint-disable-next-line no-console
    logger: opts.logger ?? { debug: () => {}, info: () => {}, warn: console.warn.bind(console), error: console.error.bind(console) },
  };

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
    // Auth-derived path: framework calls this for tools whose wire request
    // doesn't carry an `account` field (`provide_performance_feedback`,
    // `list_creative_formats`, `tasks/get`). The platform's resolver runs
    // with `undefined` ref; per its `resolution` mode it returns the
    // singleton (`'derived'`), looks up by auth (`'implicit'`), or `null`
    // for `'explicit'` adopters who don't model these tools.
    resolveAccountFromAuth: async () => {
      try {
        return await platform.accounts.resolve(undefined);
      } catch (err) {
        if (err instanceof AccountNotFoundError) return null;
        throw err;
      }
    },
    // Merge: platform-derived handlers WIN per-key over adopter-supplied
    // custom handlers. Adopter handlers fill gaps for tools the v6 platform
    // doesn't yet model (getMediaBuys, listCreativeFormats, content-standards
    // CRUD, sync_event_sources, etc.). See `CreateAdcpServerFromPlatformOptions`
    // JSDoc for the migration-seam contract.
    mediaBuy: mergeHandlers(opts.mediaBuy, buildMediaBuyHandlers(platform, taskRegistry, taskWebhookEmit), 'mediaBuy', mergeOpts),
    creative: mergeHandlers(opts.creative, buildCreativeHandlers(platform, taskRegistry, taskWebhookEmit), 'creative', mergeOpts),
    eventTracking: mergeHandlers(opts.eventTracking, buildEventTrackingHandlers(platform, taskRegistry), 'eventTracking', mergeOpts),
    signals: mergeHandlers(opts.signals, buildSignalsHandlers(platform), 'signals', mergeOpts),
    governance: mergeHandlers(opts.governance, buildGovernanceHandlers(platform), 'governance', mergeOpts),
    accounts: mergeHandlers(opts.accounts, buildAccountHandlers(platform), 'accounts', mergeOpts),
  };

  const server = createAdcpServer(config);

  return Object.assign(server, {
    getTaskState: <TResult = unknown>(taskId: string): Promise<TaskRecord<TResult> | null> =>
      taskRegistry.getTask<TResult>(taskId),
    awaitTask: (taskId: string): Promise<void> => taskRegistry.awaitTask(taskId),
    statusChange: statusChangeBus,
  });
}

// ---------------------------------------------------------------------------
// Handler merge — incremental migration seam
// ---------------------------------------------------------------------------

/**
 * Merge adopter-supplied custom handlers with platform-derived handlers.
 * Platform-derived wins per-key when both define the same handler; adopter
 * handlers fill any gaps. Returns `undefined` when neither side has any
 * handlers (so the framework knows the domain is unrouted and can omit it
 * from `tools/list`).
 *
 * Used to bridge the gap between v6 specialism interfaces (which model the
 * stable v1.0 surface) and adopter codebases that need to dispatch
 * tools the platform shape doesn't cover yet (getMediaBuys,
 * listCreativeFormats, providePerformanceFeedback, reportUsage,
 * sync_event_sources, log_event, content-standards CRUD, etc.).
 *
 * **Collision detection.** When a custom-supplied handler would be
 * shadowed by a platform-derived one (i.e., the framework added native
 * coverage for a tool the adopter previously filled via the merge seam),
 * the resolver logs a warning by default. Tells adopters to migrate the
 * custom logic into the platform method. Adopters who genuinely want
 * the custom logic to win can pass `mergeSeam: 'silent'` to skip the
 * warning, `'strict'` to throw a `PlatformConfigError`, or `'log-once'`
 * to suppress duplicate warnings across multiple server constructions
 * in the same process (multi-tenant deployments, hot-reload dev).
 */
type MergeSeamMode = 'warn' | 'log-once' | 'silent' | 'strict';

// Module-level dedupe set for `'log-once'` mode. Keyed on
// `${domain}|${sortedColliders}` so two constructions hitting the same
// collision pattern only log once across the lifetime of the process.
// Cleared via `_resetMergeSeamDedupe()` in tests.
const mergeSeamLoggedKeys = new Set<string>();

/** @internal — reset the log-once dedupe set. Tests only. */
export function _resetMergeSeamDedupe(): void {
  mergeSeamLoggedKeys.clear();
}

function mergeHandlers<T extends object>(
  custom: T | undefined,
  platform: T | undefined,
  domain: string,
  opts: { mode: MergeSeamMode; logger: AdcpLogger }
): T | undefined {
  if (!custom && !platform) return undefined;
  if (!custom) return platform;
  if (!platform) return custom;

  if (opts.mode !== 'silent') {
    const collisions: string[] = [];
    for (const key of Object.keys(platform)) {
      if (key in (custom as Record<string, unknown>)) collisions.push(key);
    }
    if (collisions.length > 0) {
      // Sort for stable dedupe key — same collision set logs the same key
      // regardless of declaration order across constructions.
      const dedupeKey = `${domain}|${[...collisions].sort().join(',')}`;
      const shouldLog = opts.mode !== 'log-once' || !mergeSeamLoggedKeys.has(dedupeKey);

      const message =
        `[adcp/decisioning] opts.${domain}.{${collisions.join(', ')}} ` +
        `${collisions.length === 1 ? 'is' : 'are'} shadowed by platform-derived handlers. ` +
        `The merge seam is for tools the platform doesn't model yet — once a tool has a native ` +
        `platform method, move the logic there and remove the opts override.`;

      if (opts.mode === 'strict') {
        throw new PlatformConfigError(message);
      }
      if (shouldLog) {
        opts.logger.warn(message);
        if (opts.mode === 'log-once') mergeSeamLoggedKeys.add(dedupeKey);
      }
    }
  }

  return { ...custom, ...platform };
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
        '(e.g., `createPostgresTaskRegistry({ pool })` — see ' +
        '`@adcp/client/server/decisioning`), OR set ' +
        'ADCP_DECISIONING_ALLOW_INMEMORY_TASKS=1 if you accept that ' +
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
 *
 * **Webhook delivery on terminal state.** When the buyer passed
 * `push_notification_config: { url, token? }` in the request and the host
 * wired `webhooks` on `serve()`, the framework emits a signed RFC 9421
 * webhook to that URL on terminal state with the task lifecycle payload.
 * Buyers don't need to poll — they receive completion via push. Polling via
 * `server.getTaskState(taskId)` continues to work for harnesses + the
 * forthcoming wire-level `tasks/get`.
 */
interface DispatchHitlOpts {
  tool: string;
  accountId: string;
  pushNotificationUrl?: string;
  pushNotificationToken?: string;
  emitWebhook?: HandlerContext<Account>['emitWebhook'];
}

async function dispatchHitl<TResult>(
  taskRegistry: TaskRegistry,
  opts: DispatchHitlOpts,
  taskFn: (taskId: string) => Promise<TResult>
): Promise<SubmittedEnvelope> {
  const { taskId } = await taskRegistry.create({ tool: opts.tool, accountId: opts.accountId });

  const completion: Promise<void> = (async () => {
    try {
      const result = await taskFn(taskId);
      await taskRegistry.complete(taskId, result);
      await emitTaskWebhook(opts, {
        task: { task_id: taskId, status: 'completed', result },
      });
    } catch (err) {
      const structured =
        err instanceof AdcpError
          ? err.toStructuredError()
          : {
              code: 'SERVICE_UNAVAILABLE' as const,
              recovery: 'transient' as const,
              message: err instanceof Error ? err.message : String(err),
            };
      await taskRegistry.fail(taskId, structured);
      await emitTaskWebhook(opts, {
        task: { task_id: taskId, status: 'failed', error: structured },
      });
    }
  })();
  taskRegistry._registerBackground(taskId, completion);

  return { status: 'submitted', task_id: taskId };
}

async function emitTaskWebhook(
  opts: DispatchHitlOpts,
  payload: { task: { task_id: string; status: string; result?: unknown; error?: unknown } }
): Promise<void> {
  if (!opts.emitWebhook || !opts.pushNotificationUrl) return;
  const wirePayload: Record<string, unknown> = { ...payload };
  if (opts.pushNotificationToken !== undefined) {
    wirePayload.validation_token = opts.pushNotificationToken;
  }
  try {
    await opts.emitWebhook({
      url: opts.pushNotificationUrl,
      payload: wirePayload,
      operation_id: `${opts.tool}.${payload.task.task_id}`,
    });
  } catch (err) {
    // Webhook failures don't fail the task — registry already records the
    // terminal state. Log via console so operators can investigate.
    // eslint-disable-next-line no-console
    console.warn(`[adcp] task webhook for ${payload.task.task_id} failed:`, err);
  }
}

// ---------------------------------------------------------------------------
// Specialism → handler-map adapters
// ---------------------------------------------------------------------------

function ctxFor(handlerCtx: HandlerContext<Account>): RequestContext<Account> {
  return buildRequestContext(handlerCtx);
}

/**
 * Extract the buyer's push-notification webhook config from a request body.
 * AdCP wire requests for HITL tools carry `push_notification_config: { url,
 * token? }`. The framework emits a signed RFC 9421 webhook to that URL on
 * task terminal state.
 */
function extractPushConfig(params: unknown): { url?: string; token?: string } {
  if (!params || typeof params !== 'object') return {};
  const cfg = (params as { push_notification_config?: unknown }).push_notification_config;
  if (!cfg || typeof cfg !== 'object') return {};
  const url = (cfg as { url?: unknown }).url;
  const token = (cfg as { token?: unknown }).token;
  return {
    ...(typeof url === 'string' && { url }),
    ...(typeof token === 'string' && { token }),
  };
}

function buildMediaBuyHandlers<P extends DecisioningPlatform<any, any>>(
  platform: P,
  taskRegistry: TaskRegistry,
  taskWebhookEmit: NonNullable<HandlerContext<Account>['emitWebhook']> | undefined
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
        const push = extractPushConfig(params);
        return dispatchHitl(
          taskRegistry,
          {
            tool: 'create_media_buy',
            accountId: reqCtx.account.id,
            pushNotificationUrl: push.url,
            pushNotificationToken: push.token,
            emitWebhook: taskWebhookEmit ?? ctx.emitWebhook,
          },
          taskId => sales.createMediaBuyTask!(taskId, params, reqCtx)
        );
      }
      return projectSync(
        () => sales.createMediaBuy!(params, reqCtx),
        r => r
      );
    },

    updateMediaBuy: async (params, ctx) => {
      const reqCtx = ctxFor(ctx);
      // `media_buy_id` is required on the wire schema, but `validation: 'off'`
      // mode skips the schema parse — guard at the seam so platform code can
      // trust the value rather than re-checking. Also catches buyers calling
      // with the param missing under an off-spec server config.
      const { media_buy_id } = params;
      if (!media_buy_id) {
        return adcpError('INVALID_REQUEST', {
          message: 'update_media_buy requires media_buy_id',
          field: 'media_buy_id',
          recovery: 'correctable',
        });
      }
      return projectSync(
        () => sales.updateMediaBuy(media_buy_id, params, reqCtx),
        r => r
      );
    },

    syncCreatives: async (params, ctx) => {
      const reqCtx = ctxFor(ctx);
      const creatives = params.creatives ?? [];
      if (sales.syncCreativesTask) {
        const push = extractPushConfig(params);
        return dispatchHitl(
          taskRegistry,
          {
            tool: 'sync_creatives',
            accountId: reqCtx.account.id,
            pushNotificationUrl: push.url,
            pushNotificationToken: push.token,
            emitWebhook: taskWebhookEmit ?? ctx.emitWebhook,
          },
          taskId => sales.syncCreativesTask!(taskId, creatives, reqCtx)
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

    // Optional methods — return UNSUPPORTED_FEATURE when the platform omits
    // them. Adopters that haven't migrated to the v6 platform interface for
    // these specific tools can still pass raw handlers via opts.mediaBuy
    // (merge seam) — the merge runs AFTER buildMediaBuyHandlers, so opts
    // handlers fill in for the methods this platform omits.
    ...(sales.getMediaBuys && {
      getMediaBuys: async (params, ctx) => {
        const reqCtx = ctxFor(ctx);
        return projectSync(
          () => sales.getMediaBuys!(params, reqCtx),
          r => r
        );
      },
    }),
    ...(sales.providePerformanceFeedback && {
      providePerformanceFeedback: async (params, ctx) => {
        const reqCtx = ctxFor(ctx);
        return projectSync(
          () => sales.providePerformanceFeedback!(params, reqCtx),
          r => r
        );
      },
    }),
    ...(sales.listCreativeFormats && {
      listCreativeFormats: async (params, ctx) => {
        const reqCtx = ctxFor(ctx);
        return projectSync(
          () => sales.listCreativeFormats!(params, reqCtx),
          r => r
        );
      },
    }),
    ...(sales.listCreatives && {
      listCreatives: async (params, ctx) => {
        const reqCtx = ctxFor(ctx);
        return projectSync(
          () => sales.listCreatives!(params, reqCtx),
          r => r
        );
      },
    }),
  };
}

function buildCreativeHandlers<P extends DecisioningPlatform<any, any>>(
  platform: P,
  taskRegistry: TaskRegistry,
  taskWebhookEmit: NonNullable<HandlerContext<Account>['emitWebhook']> | undefined
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
      const creatives = params.creatives ?? [];
      if (creative.syncCreativesTask) {
        const push = extractPushConfig(params);
        return dispatchHitl(
          taskRegistry,
          {
            tool: 'sync_creatives',
            accountId: reqCtx.account.id,
            pushNotificationUrl: push.url,
            pushNotificationToken: push.token,
            emitWebhook: taskWebhookEmit ?? ctx.emitWebhook,
          },
          taskId => creative.syncCreativesTask!(taskId, creatives, reqCtx)
        );
      }
      return projectSync(
        () => creative.syncCreatives!(creatives, reqCtx),
        rows => ({ creatives: rows })
      );
    },

    // Ad-server-specialism methods. Only the CreativeAdServerPlatform variant
    // implements these; framework returns UNSUPPORTED_FEATURE for the other
    // archetypes (template, generative).
    listCreatives: async (params, ctx) => {
      if (!('listCreatives' in creative)) {
        return adcpError('UNSUPPORTED_FEATURE', {
          message: 'list_creatives not supported by this platform',
          recovery: 'terminal',
        });
      }
      const reqCtx = ctxFor(ctx);
      return projectSync(
        () => (creative as CreativeAdServerPlatform).listCreatives(params, reqCtx),
        r => r
      );
    },

    getCreativeDelivery: async (params, ctx) => {
      if (!('getCreativeDelivery' in creative)) {
        return adcpError('UNSUPPORTED_FEATURE', {
          message: 'get_creative_delivery not supported by this platform',
          recovery: 'terminal',
        });
      }
      const reqCtx = ctxFor(ctx);
      return projectSync(
        () => (creative as CreativeAdServerPlatform).getCreativeDelivery(params, reqCtx),
        r => r
      );
    },
  };
}

function buildEventTrackingHandlers<P extends DecisioningPlatform<any, any>>(
  platform: P,
  _taskRegistry: TaskRegistry
): EventTrackingHandlers<Account> | undefined {
  const audiences = platform.audiences;
  const sales = platform.sales;
  // Retail-media adopters (sales-catalog-driven) implement sync_catalogs /
  // log_event / sync_event_sources on `SalesPlatform`. The wire spec routes
  // these through the `event-tracking` framework category so the handlers
  // land on `EventTrackingHandlers` regardless of which specialism owns
  // them on the platform side.
  if (!audiences && !sales) return undefined;

  const handlers: EventTrackingHandlers<Account> = {};

  if (audiences) {
    handlers.syncAudiences = async (params, ctx) => {
      const reqCtx = ctxFor(ctx);
      const audienceList = (params.audiences ?? []) as Audience[];
      return projectSync(
        () => audiences.syncAudiences(audienceList, reqCtx),
        rows => ({ audiences: rows })
      );
    };
  }

  if (sales?.syncCatalogs) {
    handlers.syncCatalogs = async (params, ctx) => {
      const reqCtx = ctxFor(ctx);
      return projectSync(
        () => sales.syncCatalogs!(params, reqCtx),
        r => r
      );
    };
  }

  if (sales?.logEvent) {
    handlers.logEvent = async (params, ctx) => {
      const reqCtx = ctxFor(ctx);
      return projectSync(
        () => sales.logEvent!(params, reqCtx),
        r => r
      );
    };
  }

  if (sales?.syncEventSources) {
    handlers.syncEventSources = async (params, ctx) => {
      const reqCtx = ctxFor(ctx);
      return projectSync(
        () => sales.syncEventSources!(params, reqCtx),
        r => r
      );
    };
  }

  return Object.keys(handlers).length > 0 ? handlers : undefined;
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

function buildGovernanceHandlers<P extends DecisioningPlatform<any, any>>(
  platform: P
): GovernanceHandlers<Account> | undefined {
  const cg = platform.campaignGovernance;
  const pl = platform.propertyLists;
  const cl = platform.collectionLists;
  const cs = platform.contentStandards;
  if (!cg && !pl && !cl && !cs) return undefined;

  const handlers: GovernanceHandlers<Account> = {};

  if (cg) {
    handlers.checkGovernance = async (params, ctx) => {
      const reqCtx = ctxFor(ctx);
      return projectSync(
        () => cg.checkGovernance(params, reqCtx),
        r => r
      );
    };
    handlers.syncPlans = async (params, ctx) => {
      const reqCtx = ctxFor(ctx);
      return projectSync(
        () => cg.syncPlans(params, reqCtx),
        r => r
      );
    };
    handlers.reportPlanOutcome = async (params, ctx) => {
      const reqCtx = ctxFor(ctx);
      return projectSync(
        () => cg.reportPlanOutcome(params, reqCtx),
        r => r
      );
    };
    handlers.getPlanAuditLogs = async (params, ctx) => {
      const reqCtx = ctxFor(ctx);
      return projectSync(
        () => cg.getPlanAuditLogs(params, reqCtx),
        r => r
      );
    };
  }

  if (pl) {
    handlers.createPropertyList = async (params, ctx) => {
      const reqCtx = ctxFor(ctx);
      return projectSync(
        () => pl.createPropertyList(params, reqCtx),
        r => r
      );
    };
    handlers.updatePropertyList = async (params, ctx) => {
      const reqCtx = ctxFor(ctx);
      return projectSync(
        () => pl.updatePropertyList(params, reqCtx),
        r => r
      );
    };
    handlers.getPropertyList = async (params, ctx) => {
      const reqCtx = ctxFor(ctx);
      return projectSync(
        () => pl.getPropertyList(params, reqCtx),
        r => r
      );
    };
    handlers.listPropertyLists = async (params, ctx) => {
      const reqCtx = ctxFor(ctx);
      return projectSync(
        () => pl.listPropertyLists(params, reqCtx),
        r => r
      );
    };
    handlers.deletePropertyList = async (params, ctx) => {
      const reqCtx = ctxFor(ctx);
      return projectSync(
        () => pl.deletePropertyList(params, reqCtx),
        r => r
      );
    };
  }

  if (cl) {
    handlers.createCollectionList = async (params, ctx) => {
      const reqCtx = ctxFor(ctx);
      return projectSync(
        () => cl.createCollectionList(params, reqCtx),
        r => r
      );
    };
    handlers.updateCollectionList = async (params, ctx) => {
      const reqCtx = ctxFor(ctx);
      return projectSync(
        () => cl.updateCollectionList(params, reqCtx),
        r => r
      );
    };
    handlers.getCollectionList = async (params, ctx) => {
      const reqCtx = ctxFor(ctx);
      return projectSync(
        () => cl.getCollectionList(params, reqCtx),
        r => r
      );
    };
    handlers.listCollectionLists = async (params, ctx) => {
      const reqCtx = ctxFor(ctx);
      return projectSync(
        () => cl.listCollectionLists(params, reqCtx),
        r => r
      );
    };
    handlers.deleteCollectionList = async (params, ctx) => {
      const reqCtx = ctxFor(ctx);
      return projectSync(
        () => cl.deleteCollectionList(params, reqCtx),
        r => r
      );
    };
  }

  if (cs) {
    handlers.listContentStandards = async (params, ctx) => {
      const reqCtx = ctxFor(ctx);
      return projectSync(
        () => cs.listContentStandards(params, reqCtx),
        r => r
      );
    };
    handlers.getContentStandards = async (params, ctx) => {
      const reqCtx = ctxFor(ctx);
      return projectSync(
        () => cs.getContentStandards(params, reqCtx),
        r => r
      );
    };
    handlers.createContentStandards = async (params, ctx) => {
      const reqCtx = ctxFor(ctx);
      return projectSync(
        () => cs.createContentStandards(params, reqCtx),
        r => r
      );
    };
    handlers.updateContentStandards = async (params, ctx) => {
      const reqCtx = ctxFor(ctx);
      return projectSync(
        () => cs.updateContentStandards(params, reqCtx),
        r => r
      );
    };
    handlers.calibrateContent = async (params, ctx) => {
      const reqCtx = ctxFor(ctx);
      return projectSync(
        () => cs.calibrateContent(params, reqCtx),
        r => r
      );
    };
    handlers.validateContentDelivery = async (params, ctx) => {
      const reqCtx = ctxFor(ctx);
      return projectSync(
        () => cs.validateContentDelivery(params, reqCtx),
        r => r
      );
    };
    if (cs.getMediaBuyArtifacts) {
      handlers.getMediaBuyArtifacts = async (params, ctx) => {
        const reqCtx = ctxFor(ctx);
        return projectSync(
          () => cs.getMediaBuyArtifacts!(params, reqCtx),
          r => r
        );
      };
    }
    if (cs.getCreativeFeatures) {
      handlers.getCreativeFeatures = async (params, ctx) => {
        const reqCtx = ctxFor(ctx);
        return projectSync(
          () => cs.getCreativeFeatures!(params, reqCtx),
          r => r
        );
      };
    }
  }

  return handlers;
}

function buildAccountHandlers<P extends DecisioningPlatform<any, any>>(platform: P): AccountHandlers<Account> {
  const accounts = platform.accounts;

  const handlers: AccountHandlers<Account> = {
    syncAccounts: async (params, _ctx) => {
      if (!accounts.upsert) {
        return adcpError('UNSUPPORTED_FEATURE', {
          message: 'sync_accounts not supported by this platform',
          recovery: 'terminal',
        });
      }
      const refs = (params.accounts ?? []) as AccountReference[];
      return projectSync(
        () => accounts.upsert!(refs),
        rows => ({ accounts: rows })
      );
    },
    listAccounts: async (params, _ctx) => {
      if (!accounts.list) {
        return adcpError('UNSUPPORTED_FEATURE', {
          message: 'list_accounts not supported by this platform',
          recovery: 'terminal',
        });
      }
      const filter = params as Parameters<NonNullable<typeof accounts.list>>[0];
      const page = await accounts.list(filter);
      return {
        accounts: page.items.map(toWireAccount),
        ...(page.nextCursor != null && { next_cursor: page.nextCursor }),
      };
    },
  };

  if (accounts.reportUsage) {
    handlers.reportUsage = async (params, _ctx) =>
      projectSync(
        () => accounts.reportUsage!(params),
        r => r
      );
  }

  if (accounts.getAccountFinancials) {
    handlers.getAccountFinancials = async (params, _ctx) =>
      projectSync(
        () => accounts.getAccountFinancials!(params),
        r => r
      );
  }

  return handlers;
}
