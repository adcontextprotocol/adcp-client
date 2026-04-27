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

import { randomUUID } from 'node:crypto';
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
import { AdcpError, type AdcpStructuredError } from '../async-outcome';
import type { CreativeTemplatePlatform } from '../specialisms/creative';
import type { CreativeAdServerPlatform } from '../specialisms/creative-ad-server';
import type { Audience } from '../specialisms/audiences';
import type { RequestContext } from '../context';
import type { AccountReference } from '../../../types/tools.generated';
import { adcpError, type AdcpErrorResponse } from '../../errors';
import { validatePlatform, PlatformConfigError } from './validate-platform';
import type { AdcpLogger } from '../../create-adcp-server';
import { buildRequestContext } from './to-context';
import { createInMemoryTaskRegistry, type TaskRegistry, type TaskRecord, type TaskStatus } from './task-registry';
import {
  createInMemoryStatusChangeBus,
  type StatusChangeBus,
  type PublishStatusChangeOpts,
} from '../status-changes';

/**
 * Lifecycle observability hooks the v6 runtime fires at well-known points.
 * Each callback is optional; throws are caught and logged via the framework
 * logger so adopter telemetry mistakes never break dispatch.
 *
 * Reach for these to wire DataDog / Prometheus / OpenTelemetry / structured
 * logging without baking any specific backend into the framework. For
 * OpenTelemetry, the `@adcp/client/telemetry/otel` peer-dep adapter returns
 * a pre-wired implementation with AdCP-aligned span / metric names.
 *
 * **What's instrumented today (v6.0):**
 * - Task lifecycle (`onTaskCreate`, `onTaskTransition`) — fires from `dispatchHitl`
 * - Webhook delivery (`onWebhookEmit`) — fires after each push-notification post
 * - Status-change events (`onStatusChangePublish`) — wraps the per-server bus
 * - Account resolution (`onAccountResolve`) — fires after every `resolve()` call
 *
 * **Coming in v6.1:**
 * - Per-tool dispatch latency (`onDispatchStart` / `onDispatchEnd`) —
 *   requires wrapping every handler entry point; lands when the per-handler
 *   instrumentation pass goes through.
 * - Idempotency replay rate (covered at the framework layer when v5 hooks land)
 * - State-store reads (per-handler instrumentation)
 *
 * @public
 */
export interface DecisioningObservabilityHooks {
  /**
   * Fired after `accounts.resolve` (or `resolveAccountFromAuth`) returns.
   * `resolved: false` means the resolver returned `null` — caller maps to
   * `ACCOUNT_NOT_FOUND`. `fromAuth: true` indicates the auth-derived path
   * (tools without an `account` field on the wire).
   */
  onAccountResolve?(info: {
    tool: string;
    durationMs: number;
    resolved: boolean;
    fromAuth: boolean;
  }): void;

  /** Fired when `dispatchHitl` allocates a new task in the registry. */
  onTaskCreate?(info: { tool: string; taskId: string; accountId: string }): void;

  /**
   * Fired when a task transitions to a terminal state (`completed` or
   * `failed`). `durationMs` is from create → terminal.
   */
  onTaskTransition?(info: {
    taskId: string;
    tool: string;
    accountId: string;
    status: 'completed' | 'failed';
    durationMs: number;
    errorCode?: string;
  }): void;

  /**
   * Fired after a push-notification webhook delivery attempt completes
   * (success or all retries exhausted). Adopters wire to per-buyer
   * deliverability dashboards.
   */
  onWebhookEmit?(info: {
    taskId: string;
    tool: string;
    status: string;
    url: string;
    success: boolean;
    durationMs: number;
    errors?: string[];
  }): void;

  /**
   * Fired after each `publishStatusChange(...)` event (per-server bus +
   * module-level singleton routes both go through the wrapped bus). Lets
   * adopters meter event rates per resource type without subscribing.
   */
  onStatusChangePublish?(info: {
    accountId: string;
    resourceType: string;
    resourceId: string;
  }): void;
}

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
   * Lifecycle observability hooks. Adopters wire their telemetry backend
   * (DataDog, Prometheus, OpenTelemetry, structured logger, etc.) by
   * supplying any subset of the callbacks below. The framework calls them
   * at well-known dispatch points; throws inside callbacks are caught and
   * logged via `opts.logger.warn` — they never break dispatch.
   *
   * For an out-of-the-box OpenTelemetry binding, `@adcp/client/telemetry/otel`
   * (peer-dep, opt-in) returns a pre-wired `DecisioningObservabilityHooks`
   * object. Adopters using DataDog, Prometheus, or hand-rolled metrics
   * implement the callbacks directly.
   */
  observability?: DecisioningObservabilityHooks;

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
   * `taskId` is unknown OR (when `expectedAccountId` is supplied) the
   * task's owning account doesn't match.
   *
   * **Multi-tenant isolation: pass `expectedAccountId` whenever the caller
   * has a buyer-derived account in scope.** Adopters wrapping this method
   * in a `tasks/get` wire handler MUST pass `ctx.account.id` to scope reads
   * — without it, any caller with a known `task_id` reads any tenant's
   * task lifecycle, including its `result` and `error` payloads. The
   * unscoped form (single-arg) is for ops / test harnesses that hold no
   * buyer account in scope.
   *
   * Async to accommodate storage-backed task registries
   * (`createPostgresTaskRegistry`); the in-memory impl resolves synchronously.
   */
  getTaskState<TResult = unknown>(
    taskId: string,
    expectedAccountId?: string
  ): Promise<TaskRecord<TResult> | null>;
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
  const baseBus = opts.statusChangeBus ?? createInMemoryStatusChangeBus();
  const taskWebhookEmit = opts.taskWebhookEmitter?.emit;

  // Wrap the status-change bus so every publish fires onStatusChangePublish.
  // Subscribers / recent-buffer behavior pass through unchanged — the wrap
  // is only for the publish side. Hook-throw is caught + logged so adopter
  // telemetry mistakes don't break event delivery.
  const observability = opts.observability;
  const statusChangeBus: StatusChangeBus = observability?.onStatusChangePublish
    ? wrapBusWithObservability(baseBus, observability)
    : baseBus;
  const fwLogger = opts.logger ?? {
    debug: () => {},
    info: () => {},
    // eslint-disable-next-line no-console
    warn: console.warn.bind(console),
    // eslint-disable-next-line no-console
    error: console.error.bind(console),
  };
  const mergeOpts = { mode: opts.mergeSeam ?? 'warn', logger: fwLogger };

  const config: AdcpServerConfig<Account> = {
    ...opts,
    resolveAccount: async (ref, ctx) => {
      const start = Date.now();
      let resolved = false;
      try {
        const account = await platform.accounts.resolve(ref, {
          ...(ctx.authInfo !== undefined && { authInfo: ctx.authInfo }),
          toolName: ctx.toolName,
        });
        resolved = account != null;
        return account;
      } catch (err) {
        if (err instanceof AccountNotFoundError) return null;
        throw err;
      } finally {
        safeFire(
          observability?.onAccountResolve,
          { tool: ctx.toolName, durationMs: Date.now() - start, resolved, fromAuth: false },
          'onAccountResolve',
          fwLogger
        );
      }
    },
    // Auth-derived path: framework calls this for tools whose wire request
    // doesn't carry an `account` field (`provide_performance_feedback`,
    // `list_creative_formats`, `tasks/get`). The platform's resolver runs
    // with `undefined` ref + `authInfo` available; per its `resolution`
    // mode it returns the singleton (`'derived'`), looks up by auth
    // (`'implicit'`), or `null` for `'explicit'` adopters who don't model
    // these tools.
    resolveAccountFromAuth: async ctx => {
      const start = Date.now();
      let resolved = false;
      try {
        const account = await platform.accounts.resolve(undefined, {
          ...(ctx.authInfo !== undefined && { authInfo: ctx.authInfo }),
          toolName: ctx.toolName,
        });
        resolved = account != null;
        return account;
      } catch (err) {
        if (err instanceof AccountNotFoundError) return null;
        throw err;
      } finally {
        safeFire(
          observability?.onAccountResolve,
          { tool: ctx.toolName, durationMs: Date.now() - start, resolved, fromAuth: true },
          'onAccountResolve',
          fwLogger
        );
      }
    },
    // Merge: platform-derived handlers WIN per-key over adopter-supplied
    // custom handlers. Adopter handlers fill gaps for tools the v6 platform
    // doesn't yet model (getMediaBuys, listCreativeFormats, content-standards
    // CRUD, sync_event_sources, etc.). See `CreateAdcpServerFromPlatformOptions`
    // JSDoc for the migration-seam contract.
    mediaBuy: mergeHandlers(
      opts.mediaBuy,
      buildMediaBuyHandlers(platform, taskRegistry, taskWebhookEmit, observability, fwLogger),
      'mediaBuy',
      mergeOpts
    ),
    creative: mergeHandlers(
      opts.creative,
      buildCreativeHandlers(platform, taskRegistry, taskWebhookEmit, observability, fwLogger),
      'creative',
      mergeOpts
    ),
    eventTracking: mergeHandlers(opts.eventTracking, buildEventTrackingHandlers(platform, taskRegistry), 'eventTracking', mergeOpts),
    signals: mergeHandlers(opts.signals, buildSignalsHandlers(platform), 'signals', mergeOpts),
    governance: mergeHandlers(opts.governance, buildGovernanceHandlers(platform), 'governance', mergeOpts),
    accounts: mergeHandlers(opts.accounts, buildAccountHandlers(platform), 'accounts', mergeOpts),
    customTools: {
      ...opts.customTools,
      tasks_get: buildTasksGetTool(platform, taskRegistry),
    },
  };

  const server = createAdcpServer(config);

  return Object.assign(server, {
    getTaskState: async <TResult = unknown>(
      taskId: string,
      expectedAccountId?: string
    ): Promise<TaskRecord<TResult> | null> => {
      const record = await taskRegistry.getTask<TResult>(taskId);
      if (record == null) return null;
      // Tenant boundary: if caller specified the expected account and the
      // task's owner doesn't match, treat as not-found. Returning null
      // here mirrors the "not-found / cross-tenant" envelope and avoids
      // principal-enumeration via task_id probing.
      if (expectedAccountId !== undefined && record.accountId !== expectedAccountId) {
        return null;
      }
      return record;
    },
    awaitTask: (taskId: string): Promise<void> => taskRegistry.awaitTask(taskId),
    statusChange: statusChangeBus,
  });
}

// ---------------------------------------------------------------------------
// `tasks_get` polling tool — buyer-facing wire path for HITL task lifecycle
// ---------------------------------------------------------------------------

/**
 * Custom tool exposing `taskRegistry.getTask(taskId)` over the wire so
 * buyer agents can poll HITL task state. Snake-case `tasks_get` (MCP tool
 * names disallow `/`) approximates the spec's `tasks/get` method.
 *
 * Native MCP `tasks/get` integration via the SDK's experimental
 * `registerToolTask` path lands in v6.1 — that registers HITL tools
 * (`create_media_buy`, `sync_creatives`) as MCP task tools and the SDK
 * handles the protocol-level `tasks/get` natively. Until then, this
 * custom tool is the buyer-facing polling surface.
 *
 * **Tenant scoping.** The tool reads from `taskRegistry.getTask`
 * directly. Adopters with multi-tenant deployments MUST pass `account`
 * in the request so the framework's account-resolution flow scopes the
 * read; the handler then verifies `record.accountId` matches the
 * resolved account before returning the task. Single-tenant agents
 * (`resolution: 'derived'`) get scoping for free via the auth-derived
 * resolver.
 */
function buildTasksGetTool<P extends DecisioningPlatform<any, any>>(
  platform: P,
  taskRegistry: TaskRegistry
) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const z = require('zod') as typeof import('zod');
  const inputShape = {
    task_id: z.string().min(1).describe('Task identifier returned in the submitted envelope of a HITL tool call.'),
    account: z
      .object({ account_id: z.string().optional() })
      .passthrough()
      .optional()
      .describe('Optional account reference for tenant scoping. Required for multi-tenant deployments.'),
  };
  return {
    description:
      'Poll the lifecycle of a HITL task (create_media_buy / sync_creatives) by task_id. ' +
      'Returns the current status, terminal result on completed, or structured error on failed. ' +
      'Spec-aligned alternative to the MCP-native `tasks/get` method (native integration lands in v6.1).',
    title: 'Get Task State',
    inputSchema: inputShape,
    annotations: { readOnlyHint: true },
    handler: async (args: { task_id: string; account?: { account_id?: string } }) => {
      const ref = args.account;
      let resolvedAccountId: string | undefined;
      if (ref) {
        try {
          const resolved = await platform.accounts.resolve(ref as AccountReference);
          if (resolved) resolvedAccountId = resolved.id;
        } catch (err) {
          if (!(err instanceof AccountNotFoundError)) throw err;
        }
        if (!resolvedAccountId) {
          return adcpError('ACCOUNT_NOT_FOUND', {
            message: 'The specified account does not exist',
            field: 'account',
          });
        }
      } else {
        try {
          const resolved = await platform.accounts.resolve(undefined);
          if (resolved) resolvedAccountId = resolved.id;
        } catch (err) {
          if (!(err instanceof AccountNotFoundError)) throw err;
        }
      }

      const record = await taskRegistry.getTask(args.task_id);
      if (record == null) {
        return adcpError('REFERENCE_NOT_FOUND', {
          message: `Task ${args.task_id} not found`,
          field: 'task_id',
        });
      }
      if (resolvedAccountId !== undefined && record.accountId !== resolvedAccountId) {
        return adcpError('REFERENCE_NOT_FOUND', {
          message: `Task ${args.task_id} not found`,
          field: 'task_id',
        });
      }

      const payload: Record<string, unknown> = {
        task_id: record.taskId,
        task_type: record.tool,
        status: record.status,
        timestamp: record.updatedAt,
        protocol: protocolForTool(record.tool),
      };
      if (record.statusMessage) payload.message = record.statusMessage;
      if (record.status === 'completed' && record.result !== undefined) {
        payload.result = record.result;
      }
      if (record.status === 'failed' && record.error) {
        payload.result = { errors: [record.error] };
      }
      return {
        content: [{ type: 'text' as const, text: `Task ${record.taskId} status: ${record.status}` }],
        structuredContent: payload,
      };
    },
  };
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
// Observability hook plumbing
// ---------------------------------------------------------------------------

/**
 * Fire an observability callback with throw-safe semantics. Adopter throws
 * inside hooks are caught + logged so a buggy span/metric callback never
 * breaks dispatch. Callbacks are sync; if you need async tracer work,
 * fire-and-forget inside the callback body.
 */
function safeFire<T>(fn: ((arg: T) => unknown) | undefined, arg: T, hookName: string, logger: AdcpLogger): void {
  if (!fn) return;
  try {
    fn(arg);
  } catch (err) {
    logger.warn(
      `[adcp/decisioning] observability hook ${hookName} threw — telemetry callbacks must never throw. ` +
        `Error: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Wrap a `StatusChangeBus` so every publish fires `onStatusChangePublish`
 * after the underlying bus persists the event. Subscribers + recent-buffer
 * pass through; only the publish side is observed.
 */
function wrapBusWithObservability(bus: StatusChangeBus, observability: DecisioningObservabilityHooks): StatusChangeBus {
  return {
    publish<TPayload>(eventOpts: PublishStatusChangeOpts<TPayload>): void {
      bus.publish(eventOpts);
      if (observability.onStatusChangePublish) {
        try {
          observability.onStatusChangePublish({
            accountId: eventOpts.account_id,
            resourceType: eventOpts.resource_type,
            resourceId: eventOpts.resource_id,
          });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(
            `[adcp/decisioning] observability hook onStatusChangePublish threw: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    },
    subscribe: bus.subscribe.bind(bus),
    recent: bus.recent.bind(bus),
  };
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
  observability?: DecisioningObservabilityHooks;
  logger: AdcpLogger;
}

async function dispatchHitl<TResult>(
  taskRegistry: TaskRegistry,
  opts: DispatchHitlOpts,
  taskFn: (taskId: string) => Promise<TResult>
): Promise<SubmittedEnvelope> {
  const { taskId } = await taskRegistry.create({ tool: opts.tool, accountId: opts.accountId });
  safeFire(
    opts.observability?.onTaskCreate,
    { tool: opts.tool, taskId, accountId: opts.accountId },
    'onTaskCreate',
    opts.logger
  );
  const taskStart = Date.now();

  // Three failure surfaces:
  //   1. taskFn throws → record failure → emit failed webhook
  //   2. taskFn succeeds but registry write fails (DB outage) → log only;
  //      do NOT emit webhook (buyer doesn't know task succeeded), do NOT
  //      try to fail() the task (taskFn DID succeed; mismatch would
  //      mislead operator reconciliation)
  //   3. taskFn fails AND registry fail-write also fails → log only;
  //      do not emit webhook (registry state is inconsistent)
  //
  // Webhook delivery is gated on the registry write succeeding so the
  // buyer's view (via webhook OR getTaskState) is always consistent.
  const completion: Promise<void> = (async () => {
    let result: TResult | undefined;
    let taskFnError: unknown;
    try {
      result = await taskFn(taskId);
    } catch (err) {
      taskFnError = err;
    }

    if (taskFnError === undefined) {
      // Success path
      try {
        await taskRegistry.complete(taskId, result as TResult);
      } catch (registryErr) {
        opts.logger.error(
          `[adcp/decisioning] task ${taskId} (${opts.tool}) completed but registry write failed — ` +
            `manual reconciliation required. Webhook not emitted; buyer state will diverge until resolved. ` +
            `Error: ${registryErr instanceof Error ? registryErr.message : String(registryErr)}`
        );
        return;
      }
      safeFire(
        opts.observability?.onTaskTransition,
        {
          taskId,
          tool: opts.tool,
          accountId: opts.accountId,
          status: 'completed',
          durationMs: Date.now() - taskStart,
        },
        'onTaskTransition',
        opts.logger
      );
      await emitTaskWebhook(opts, {
        task: { task_id: taskId, status: 'completed', result },
      });
      return;
    }

    // Failure path
    const structured =
      taskFnError instanceof AdcpError
        ? taskFnError.toStructuredError()
        : {
            code: 'SERVICE_UNAVAILABLE' as const,
            recovery: 'transient' as const,
            message: taskFnError instanceof Error ? taskFnError.message : String(taskFnError),
          };
    try {
      await taskRegistry.fail(taskId, structured);
    } catch (registryErr) {
      opts.logger.error(
        `[adcp/decisioning] task ${taskId} (${opts.tool}) failed AND registry fail-write also failed — ` +
          `manual reconciliation required. Webhook not emitted. ` +
          `taskFn error: ${structured.message}; registry error: ${registryErr instanceof Error ? registryErr.message : String(registryErr)}`
      );
      return;
    }
    safeFire(
      opts.observability?.onTaskTransition,
      {
        taskId,
        tool: opts.tool,
        accountId: opts.accountId,
        status: 'failed',
        durationMs: Date.now() - taskStart,
        errorCode: structured.code,
      },
      'onTaskTransition',
      opts.logger
    );
    await emitTaskWebhook(opts, {
      task: { task_id: taskId, status: 'failed', error: structured },
    });
  })();
  taskRegistry._registerBackground(taskId, completion);

  return { status: 'submitted', task_id: taskId };
}

/**
 * AdCP wire spec puts task / status / context fields on the webhook envelope
 * top level (`mcp-webhook-payload.json`); the success / failure body lives on
 * `result`. This helper builds that shape from the v6 task lifecycle data.
 *
 * Spec requires top-level: `idempotency_key`, `task_id`, `task_type`, `status`,
 * `timestamp`. Optional: `protocol`, `context_id`, `message`, `result`,
 * `operation_id`. We add `validation_token` (echoed from
 * `push_notification_config.token`) outside the spec but consistent with the
 * intent — receivers that don't expect it ignore the extra property.
 *
 * The webhook emitter generates `idempotency_key` internally from
 * `operation_id`; we mirror it on the payload body so receivers running
 * spec-conformant `mcp-webhook-payload.json` validation see the required
 * field. Same value is on the HTTP `Idempotency-Key` header for HTTP-level
 * dedup.
 */
function buildTaskWebhookPayload(
  opts: DispatchHitlOpts,
  taskId: string,
  status: TaskStatus,
  artifact: { result?: unknown; error?: AdcpStructuredError }
): Record<string, unknown> {
  const idempotencyKey = randomUUID();
  const payload: Record<string, unknown> = {
    idempotency_key: idempotencyKey,
    task_id: taskId,
    task_type: opts.tool,
    status,
    timestamp: new Date().toISOString(),
    protocol: protocolForTool(opts.tool),
  };
  if (opts.pushNotificationToken !== undefined) {
    payload.validation_token = opts.pushNotificationToken;
  }
  // `result` is the AdCP async-response-data union — for completed it's
  // the success-arm body; for failed it carries `errors: AdcpStructuredError[]`
  // alongside the empty success shape.
  if (status === 'completed' && artifact.result !== undefined) {
    payload.result = artifact.result;
  }
  if (status === 'failed' && artifact.error !== undefined) {
    payload.result = { errors: [artifact.error] };
    payload.message = artifact.error.message;
  }
  return payload;
}

/**
 * Map a v6 tool name to its AdCP protocol category, per
 * `enums/adcp-protocol.json`. Goes on the webhook payload's `protocol`
 * field so receivers can route to the right pipeline before parsing the
 * task body.
 */
function protocolForTool(tool: string): string {
  if (tool.startsWith('si_')) return 'sponsored-intelligence';
  if (
    tool === 'check_governance' ||
    tool === 'sync_plans' ||
    tool === 'report_plan_outcome' ||
    tool === 'get_plan_audit_logs' ||
    tool.endsWith('_property_list') ||
    tool.endsWith('_property_lists') ||
    tool.endsWith('_collection_list') ||
    tool.endsWith('_collection_lists') ||
    tool.endsWith('_content_standards') ||
    tool === 'calibrate_content' ||
    tool === 'validate_content_delivery' ||
    tool === 'get_media_buy_artifacts'
  ) {
    return 'governance';
  }
  if (tool === 'get_signals' || tool === 'activate_signal') return 'signals';
  if (tool === 'build_creative' || tool === 'preview_creative' || tool === 'get_creative_delivery') return 'creative';
  if (tool === 'get_brand_identity' || tool === 'get_rights' || tool === 'acquire_rights') return 'brand';
  return 'media-buy';
}

async function emitTaskWebhook(
  opts: DispatchHitlOpts,
  source: { task: { task_id: string; status: 'completed' | 'failed'; result?: unknown; error?: AdcpStructuredError } }
): Promise<void> {
  if (!opts.emitWebhook || !opts.pushNotificationUrl) return;
  const taskId = source.task.task_id;
  const wirePayload = buildTaskWebhookPayload(opts, taskId, source.task.status, {
    ...(source.task.result !== undefined && { result: source.task.result }),
    ...(source.task.error !== undefined && { error: source.task.error }),
  });
  const start = Date.now();
  let success = false;
  let errors: string[] | undefined;
  try {
    const result = await opts.emitWebhook({
      url: opts.pushNotificationUrl,
      payload: wirePayload,
      operation_id: `${opts.tool}.${taskId}`,
    });
    success = result?.delivered === true;
    if (result && Array.isArray(result.errors) && result.errors.length > 0) {
      errors = result.errors;
    }
  } catch (err) {
    errors = [err instanceof Error ? err.message : String(err)];
    // Webhook failures don't fail the task — registry already records the
    // terminal state. URL redacted from log to avoid leaking buyer-supplied
    // attacker-controllable values into operator log aggregators.
    opts.logger.warn(
      `[adcp/decisioning] task webhook for ${taskId} (${opts.tool}, status=${source.task.status}) ` +
        `failed: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    safeFire(
      opts.observability?.onWebhookEmit,
      {
        taskId,
        tool: opts.tool,
        status: source.task.status,
        url: opts.pushNotificationUrl,
        success,
        durationMs: Date.now() - start,
        ...(errors && { errors }),
      },
      'onWebhookEmit',
      opts.logger
    );
  }
}

// ---------------------------------------------------------------------------
// Specialism → handler-map adapters
// ---------------------------------------------------------------------------

function ctxFor(handlerCtx: HandlerContext<Account>): RequestContext<Account> {
  return buildRequestContext(handlerCtx);
}

/**
 * Extract the buyer's push-notification webhook config from a request body
 * and validate the URL + token against SSRF / replay primitives.
 *
 * AdCP wire requests for HITL tools carry `push_notification_config: { url,
 * token? }`. The buyer-supplied URL is attacker-controllable — without
 * validation, a buyer with `create_media_buy` access can force the agent
 * process to POST signed payloads to internal admin endpoints, AWS metadata
 * (`http://169.254.169.254/`), or RFC 1918 private ranges. Validation
 * gates here:
 *
 * 1. **Scheme**: `https://` only in production; `http://` allowed when
 *    `NODE_ENV` ∈ {test, development} OR the operator opts in via
 *    `ADCP_DECISIONING_ALLOW_HTTP_WEBHOOKS=1`. Same allowlist pattern as
 *    the in-memory task registry.
 * 2. **Host**: rejects IP-literals targeting RFC 1918 private ranges
 *    (10/8, 172.16/12, 192.168/16), link-local (169.254/16, fe80::/10),
 *    loopback (127/8, ::1), CGNAT (100.64/10), and unspecified addresses
 *    (0.0.0.0, ::). Rejects bare hostnames `localhost` / `0`.
 * 3. **Token shape**: rejects tokens longer than 255 chars or containing
 *    control characters. Tokens past 255 chars combined with a malicious
 *    URL would inflate webhook payload size; control characters break log
 *    redaction.
 *
 * Adopters who need stricter rules (host allowlist) can re-validate
 * inside their `taskWebhookEmitter` impl. Adopters needing to relax for
 * legitimate internal-network test setups use the env-var ack.
 *
 * On rejection, returns the URL + token absent — the framework then skips
 * webhook delivery silently (rather than failing the task) and logs at
 * warn level so operators can spot the buyer's malformed config.
 */
function extractPushConfig(params: unknown, logger: AdcpLogger): { url?: string; token?: string } {
  if (!params || typeof params !== 'object') return {};
  const cfg = (params as { push_notification_config?: unknown }).push_notification_config;
  if (!cfg || typeof cfg !== 'object') return {};
  const rawUrl = (cfg as { url?: unknown }).url;
  const rawToken = (cfg as { token?: unknown }).token;

  let url: string | undefined;
  if (typeof rawUrl === 'string') {
    const validation = validatePushNotificationUrl(rawUrl);
    if (validation.ok) {
      url = rawUrl;
    } else {
      logger.warn(
        `[adcp/decisioning] push_notification_config.url rejected: ${validation.reason}. ` +
          `Webhook delivery skipped. Buyer should resend with a public https URL.`
      );
    }
  }

  let token: string | undefined;
  if (typeof rawToken === 'string') {
    const validation = validatePushNotificationToken(rawToken);
    if (validation.ok) {
      token = rawToken;
    } else {
      logger.warn(
        `[adcp/decisioning] push_notification_config.token rejected: ${validation.reason}. ` +
          `Webhook delivered without token round-trip.`
      );
    }
  }

  return {
    ...(url !== undefined && { url }),
    ...(token !== undefined && { token }),
  };
}

interface UrlValidationResult {
  ok: boolean;
  reason?: string;
}

function validatePushNotificationUrl(rawUrl: string): UrlValidationResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'malformed URL' };
  }

  const allowHttp =
    process.env.NODE_ENV === 'test' ||
    process.env.NODE_ENV === 'development' ||
    process.env.ADCP_DECISIONING_ALLOW_HTTP_WEBHOOKS === '1';

  if (parsed.protocol === 'http:' && !allowHttp) {
    return { ok: false, reason: 'http:// scheme not allowed (use https:// or set ADCP_DECISIONING_ALLOW_HTTP_WEBHOOKS=1)' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `unsupported scheme "${parsed.protocol}" (only http: / https:)` };
  }

  const host = parsed.hostname.toLowerCase();
  if (host === '' || host === 'localhost' || host === '0') {
    return { ok: false, reason: `host "${host}" rejected (loopback / unspecified)` };
  }

  // IPv4 literal check
  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const a = Number(ipv4Match[1]);
    const b = Number(ipv4Match[2]);
    if (a === 10) return { ok: false, reason: 'RFC 1918 private range 10/8 rejected' };
    if (a === 127) return { ok: false, reason: 'loopback range 127/8 rejected' };
    if (a === 0) return { ok: false, reason: 'unspecified range 0/8 rejected' };
    if (a === 169 && b === 254) return { ok: false, reason: 'link-local 169.254/16 rejected (cloud metadata)' };
    if (a === 172 && b >= 16 && b <= 31) return { ok: false, reason: 'RFC 1918 private range 172.16/12 rejected' };
    if (a === 192 && b === 168) return { ok: false, reason: 'RFC 1918 private range 192.168/16 rejected' };
    if (a === 100 && b >= 64 && b <= 127) return { ok: false, reason: 'CGNAT range 100.64/10 rejected' };
    if (a >= 224) return { ok: false, reason: 'multicast / reserved range rejected' };
  }

  // IPv6 literal check (simplified — covers the common cases)
  if (host.includes(':')) {
    if (host === '::1' || host === '[::1]') return { ok: false, reason: 'IPv6 loopback ::1 rejected' };
    if (host === '::' || host === '[::]') return { ok: false, reason: 'IPv6 unspecified :: rejected' };
    if (host.startsWith('fe80:') || host.startsWith('[fe80:')) {
      return { ok: false, reason: 'IPv6 link-local fe80::/10 rejected' };
    }
    if (host.startsWith('fc') || host.startsWith('[fc') || host.startsWith('fd') || host.startsWith('[fd')) {
      return { ok: false, reason: 'IPv6 unique-local fc00::/7 rejected' };
    }
  }

  return { ok: true };
}

const TOKEN_MAX_LENGTH = 255;
const TOKEN_CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

function validatePushNotificationToken(token: string): UrlValidationResult {
  if (token.length > TOKEN_MAX_LENGTH) {
    return { ok: false, reason: `token longer than ${TOKEN_MAX_LENGTH} chars` };
  }
  if (TOKEN_CONTROL_CHAR_RE.test(token)) {
    return { ok: false, reason: 'token contains control characters' };
  }
  return { ok: true };
}

function buildMediaBuyHandlers<P extends DecisioningPlatform<any, any>>(
  platform: P,
  taskRegistry: TaskRegistry,
  taskWebhookEmit: NonNullable<HandlerContext<Account>['emitWebhook']> | undefined,
  observability: DecisioningObservabilityHooks | undefined,
  logger: AdcpLogger
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
        const push = extractPushConfig(params, logger);
        return dispatchHitl(
          taskRegistry,
          {
            tool: 'create_media_buy',
            accountId: reqCtx.account.id,
            pushNotificationUrl: push.url,
            pushNotificationToken: push.token,
            emitWebhook: taskWebhookEmit ?? ctx.emitWebhook,
            observability,
            logger,
          },
          taskId => sales.createMediaBuyTask!(taskId, params, reqCtx)
        );
      }
      if (!sales.createMediaBuy) {
        return adcpError('UNSUPPORTED_FEATURE', {
          message: 'create_media_buy not supported by this sales platform (declare either createMediaBuy or createMediaBuyTask)',
          recovery: 'terminal',
        });
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
        const push = extractPushConfig(params, logger);
        return dispatchHitl(
          taskRegistry,
          {
            tool: 'sync_creatives',
            accountId: reqCtx.account.id,
            pushNotificationUrl: push.url,
            pushNotificationToken: push.token,
            emitWebhook: taskWebhookEmit ?? ctx.emitWebhook,
            observability,
            logger,
          },
          taskId => sales.syncCreativesTask!(taskId, creatives, reqCtx)
        );
      }
      if (!sales.syncCreatives) {
        return adcpError('UNSUPPORTED_FEATURE', {
          message: 'sync_creatives not supported by this sales platform (declare either syncCreatives or syncCreativesTask)',
          recovery: 'terminal',
        });
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
  taskWebhookEmit: NonNullable<HandlerContext<Account>['emitWebhook']> | undefined,
  observability: DecisioningObservabilityHooks | undefined,
  logger: AdcpLogger
): CreativeHandlers<Account> | undefined {
  const creative = platform.creative;
  if (!creative) return undefined;

  return {
    buildCreative: async (params, ctx) => {
      const reqCtx = ctxFor(ctx);
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
        const push = extractPushConfig(params, logger);
        return dispatchHitl(
          taskRegistry,
          {
            tool: 'sync_creatives',
            accountId: reqCtx.account.id,
            pushNotificationUrl: push.url,
            pushNotificationToken: push.token,
            emitWebhook: taskWebhookEmit ?? ctx.emitWebhook,
            observability,
            logger,
          },
          taskId => creative.syncCreativesTask!(taskId, creatives, reqCtx)
        );
      }
      if (!creative.syncCreatives) {
        return adcpError('UNSUPPORTED_FEATURE', {
          message: 'sync_creatives not supported by this creative platform (declare either syncCreatives or syncCreativesTask)',
          recovery: 'terminal',
        });
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
