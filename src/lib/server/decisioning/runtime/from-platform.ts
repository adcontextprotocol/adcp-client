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
 * **Adopter shape (unified hybrid):** each HITL-eligible tool is a single
 * method. The method returns the wire success arm (sync fast path) OR
 * `ctx.handoffToTask(fn)` to promote the call to a background task (HITL
 * slow path). Adopters branch per-call; framework detects the `TaskHandoff`
 * marker and dispatches accordingly:
 *
 *   - Sync path: framework awaits the return value in foreground; projects
 *     it to the wire success arm. `throw new AdcpError(...)` projects to
 *     the wire `adcp_error` envelope.
 *   - HITL path: framework detects the `TaskHandoff` marker, allocates
 *     `taskId`, returns the submitted envelope to the buyer immediately,
 *     then runs the handoff function in background. The function's return
 *     value becomes the task's terminal `result`; thrown `AdcpError` becomes
 *     the terminal `error`.
 *
 * Generic thrown errors (`Error`, `TypeError`) fall through to the
 * framework's `SERVICE_UNAVAILABLE` mapping.
 *
 * **Wired surface (6.0):** `SalesPlatform` (14 tools — 3 required core +
 * 11 optional; unified hybrid on `create_media_buy` / `sync_creatives`),
 * `CreativeBuilderPlatform` (build_creative / sync_creatives unified
 * hybrid, optional preview_creative sync-only, optional refineCreative),
 * `AudiencePlatform.syncAudiences`, `SignalsPlatform` (activate_signal,
 * list_signals), `AccountStore` (reportUsage, getAccountFinancials),
 * `ContentStandardsPlatform`, `CampaignGovernancePlatform`,
 * `TenantRegistry` (multi-tenant health), `createPostgresTaskRegistry`,
 * `tasks/get` wire handler, per-server + module-level `publishStatusChange`.
 *
 * **Still deferred (rc.1+):** MCP Resources subscription projection for
 * `publishStatusChange`. The no-account tool surface (`preview_creative`,
 * `list_creative_formats`, `provide_performance_feedback`) is now typed
 * via `NoAccountCtx<TCtxMeta>` — handlers receive `ctx.account: Account |
 * undefined` and must narrow before reading `ctx_metadata`.
 *
 * Status: Preview / 6.0. Not yet exported from the public `./server`
 * subpath; reach in via `@adcp/sdk/server/decisioning/runtime` for
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
  type BrandRightsHandlers,
  type HandlerContext,
} from '../../create-adcp-server';
import type { DecisioningPlatform, RequiredPlatformsFor, RequiredCapabilitiesFor } from '../platform';
import type { ComplianceTestingCapabilities } from '../capabilities';
import type { Account, ResolvedAuthInfo, ResolveContext } from '../account';
import { AccountNotFoundError, refAccountId, toWireAccount, toWireSyncAccountRow } from '../account';
import type { BuyerAgent, BuyerAgentRegistry } from '../buyer-agent';
import { AdcpError, type AdcpStructuredError } from '../async-outcome';
import type { CreativeBuilderPlatform } from '../specialisms/creative';
import type { CreativeAdServerPlatform } from '../specialisms/creative-ad-server';
import type { Audience } from '../specialisms/audiences';
import type { RequestContext } from '../context';
import type {
  AccountReference,
  BuildCreativeMultiSuccess,
  BuildCreativeSuccess,
  CreativeManifest,
  GetAdCPCapabilitiesResponse,
} from '../../../types/tools.generated';
import { adcpError, type AdcpErrorResponse } from '../../errors';
import { validatePlatform, PlatformConfigError } from './validate-platform';
import { validateSpecialismRequiredTools, formatSpecialismIssue } from '../validate-specialisms';
import type { AdcpLogger } from '../../create-adcp-server';
import { buildRequestContext, buildHandoffContext } from './to-context';
import {
  type CtxMetadataStore,
  type ResourceKind,
  createCtxMetadataStore,
  pgCtxMetadataStore,
  getCtxMetadataMigration,
  stripCtxMetadata,
} from '../../ctx-metadata';
import { createIdempotencyStore, type IdempotencyStore } from '../../idempotency';
import { pgBackend, getIdempotencyMigration } from '../../idempotency/backends/pg';
import { createPostgresTaskRegistry, getDecisioningTaskRegistryMigration } from './postgres-task-registry';
import type { PgQueryable } from '../../postgres-task-store';
import { isTaskHandoff, _extractTaskFn, type TaskHandoff } from '../async-outcome';
import { TOOL_ENTITY_FIELDS } from './entity-hydration.generated';
import { z } from 'zod';
import { createInMemoryTaskRegistry, type TaskRegistry, type TaskRecord, type TaskStatus } from './task-registry';
import { protocolForTool, SPEC_WEBHOOK_TASK_TYPES } from './protocol-for-tool';

/**
 * Default logger when adopters don't supply `opts.logger`. `debug` /
 * `info` are no-op; `warn` / `error` route to console so framework
 * warnings (merge-seam collisions, SSRF rejections, observability hook
 * misuse) surface during development. Adopters wiring `pino`/`bunyan`
 * supply all four levels via `opts.logger`.
 */
const DEFAULT_FRAMEWORK_LOGGER: AdcpLogger = {
  debug: () => {},
  info: () => {},
  // eslint-disable-next-line no-console
  warn: console.warn.bind(console),
  // eslint-disable-next-line no-console
  error: console.error.bind(console),
};
import { createInMemoryStatusChangeBus, type StatusChangeBus, type PublishStatusChangeOpts } from '../status-changes';
import { createComplyController, type ComplyControllerConfig } from '../../../testing/comply-controller';
import type { TestControllerBridge } from '../../test-controller-bridge';
import { mergeSeedProduct } from '../../../testing/seed-merge';
import type { Product } from '../../../types/tools.generated';
import { normalizeErrors } from '../../normalize-errors';

/**
 * Apply `normalizeErrors` to a sync_creatives row's optional `errors`
 * field. Adopters often return errors as bare strings, native Error
 * instances, or vendor-specific shapes; the wire schema requires
 * `Error[]` with `{ code, message, ... }`. Normalizing at the
 * projection seam means every adopter's syncCreatives method gets
 * coerced to wire shape — the row passes strict response validation
 * even when the adopter doesn't hand-shape every error.
 */
function normalizeRowErrors<TRow extends { errors?: unknown }>(row: TRow): TRow {
  if (row?.errors == null) return row;
  return { ...row, errors: normalizeErrors(row.errors) } as TRow;
}

/**
 * Enforce the documented `'implicit'`-resolution refusal. When a platform
 * declares `accounts.resolution: 'implicit'`, the framework refuses inline
 * `account_id` references on the wire — the buyer is expected to call
 * `sync_accounts` first, then the framework resolves the account from the
 * authenticated principal on subsequent calls. Documented at
 * `AccountStore.resolution` in `account.ts`.
 *
 * Throws `AdcpError('INVALID_REQUEST')` before reaching the adopter's
 * `accounts.resolve`, so each adopter doesn't reimplement the same
 * `if (ref?.account_id) return null` branch and the wire response is
 * consistent across implicit-mode platforms. The brand+operator union arm
 * is permitted — the strict-reading docstring claim only refuses
 * `account_id`-shaped references.
 */
function refuseImplicitAccountId(
  resolution: 'explicit' | 'implicit' | 'derived' | undefined,
  ref: AccountReference | undefined
): void {
  if (resolution !== 'implicit') return;
  if (refAccountId(ref) === undefined) return;
  throw new AdcpError('INVALID_REQUEST', {
    message:
      'This platform resolves accounts from the authenticated principal — call sync_accounts first; do not pass account.account_id inline.',
    field: 'account.account_id',
    suggestion:
      'Call sync_accounts to associate accounts with your principal, then omit account_id on subsequent calls.',
  });
}

/**
 * Dev-mode warning when a multi-id read tool returns fewer rows than
 * the buyer requested — the canonical signal that the platform is
 * silently truncating to `media_buy_ids[0]` (closes #1342, follow-up
 * #1399). Catches the bug class where adopters write the recommended
 * pattern wrong on first pass; quiet in production where legitimate
 * misses (deleted, archived, cross-account) are routine and warning
 * on every miss would be noise.
 *
 * Suppressible via `ADCP_SUPPRESS_MULTI_ID_WARN=1` for adopters whose
 * legitimate-miss rate is high (deleted-account-rich datasets, etc.).
 */
function warnIfTruncatedMultiIdResponse(
  toolName: 'getMediaBuyDelivery' | 'getMediaBuys',
  requestedIds: readonly string[] | undefined,
  responseArray: readonly unknown[] | undefined,
  logger: AdcpLogger
): void {
  if (process.env.NODE_ENV === 'production') return;
  if (process.env.ADCP_SUPPRESS_MULTI_ID_WARN === '1') return;
  if (!requestedIds || requestedIds.length === 0) return;
  const returned = Array.isArray(responseArray) ? responseArray.length : 0;
  if (returned >= requestedIds.length) return;
  // Empty `media_buy_ids` is filtered above as paginated-mode (no truncation
  // possible without a request to compare against).
  logger.warn(
    `[adcp/sdk] ${toolName}: platform returned ${returned} row${returned === 1 ? '' : 's'} for ${requestedIds.length} requested media_buy_ids — ` +
      `the platform may be silently truncating to media_buy_ids[0]. ` +
      `See https://github.com/adcontextprotocol/adcp-client/issues/1342 for the multi-id pass-through contract. ` +
      `Suppress with ADCP_SUPPRESS_MULTI_ID_WARN=1 if legitimate misses (deleted / cross-account) are routine.`
  );
}

/**
 * Lifecycle observability hooks the v6 runtime fires at well-known points.
 * Each callback is optional; throws are caught and logged via the framework
 * logger so adopter telemetry mistakes never break dispatch.
 *
 * Reach for these to wire DataDog / Prometheus / OpenTelemetry / structured
 * logging without baking any specific backend into the framework. For
 * OpenTelemetry, the `@adcp/sdk/telemetry/otel` peer-dep adapter returns
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
   * (tools without an `account` field on the wire). `accountId` is the
   * resolved tenant id when `resolved: true`, undefined otherwise — useful
   * for dimensioning DD / Prometheus tag sets by tenant.
   *
   * **Cardinality warning:** if you forward `accountId` to a multi-tenant
   * metric backend, pre-bucket or sample — high tenant counts will
   * explode tag cardinality.
   */
  onAccountResolve?(info: {
    tool: string;
    durationMs: number;
    resolved: boolean;
    fromAuth: boolean;
    accountId?: string;
  }): void;

  /**
   * Fired when `dispatchHitl` allocates a new task in the registry.
   * `durationMs` is the registry-create call latency (typically
   * sub-millisecond for in-memory, single-digit ms for Postgres).
   */
  onTaskCreate?(info: { tool: string; taskId: string; accountId: string; durationMs: number }): void;

  /**
   * Fired when a task transitions to a terminal state (`completed`,
   * `failed`, or `failed-write` when the registry write itself fails).
   * `durationMs` is from create → terminal. `errorCode` is the structured
   * error code for the failure cases — pre-bucketed for metric tags
   * (matches `ErrorCode` enum + the framework-synthetic
   * `'REGISTRY_WRITE_FAILED'` value).
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
   *
   * `errorCode` is a single bucketed value adopters tag metrics with
   * (`'TIMEOUT'`, `'CONNECTION_REFUSED'`, `'HTTP_4XX'`, `'HTTP_5XX'`,
   * `'SIGNATURE_FAILURE'`, `'UNKNOWN'` — derived from the underlying
   * emitter error). `errorMessages` is the raw free-text error list for
   * structured-log adopters; do NOT forward this to metrics tag values.
   */
  onWebhookEmit?(info: {
    taskId: string;
    tool: string;
    status: string;
    url: string;
    success: boolean;
    durationMs: number;
    errorCode?: string;
    errorMessages?: string[];
  }): void;

  /**
   * Fired after each `publishStatusChange(...)` event (per-server bus +
   * module-level singleton routes both go through the wrapped bus). Lets
   * adopters meter event rates per resource type without subscribing.
   */
  onStatusChangePublish?(info: { accountId: string; resourceType: string; resourceId: string }): void;
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
   * For an out-of-the-box OpenTelemetry binding, `@adcp/sdk/telemetry/otel`
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
   *
   * **Signing posture is your responsibility.** When adopters claim
   * `signed-requests` capability, buyers expect RFC 9421-signed webhooks.
   * The default emitter (bound to `serve({ webhooks })`) signs;
   * a custom emitter passed here MUST either delegate to the same signed
   * pipeline or sign itself. Set `unsigned: true` to acknowledge that this
   * emitter intentionally bypasses signing — without that flag, an
   * unsigned emitter wired in production would silently ship unsigned
   * webhooks to buyers expecting signatures. Tests / dev paths set
   * `unsigned: true`.
   */
  taskWebhookEmitter?: {
    emit: NonNullable<HandlerContext<Account>['emitWebhook']>;
    /**
     * Set to `true` to acknowledge this emitter does NOT sign the webhook
     * payload (RFC 9421). Required for tests and development; production
     * deployments with `signed-requests` claimed should leave this
     * unset / `false` and rely on the framework's signing path.
     */
    unsigned?: boolean;
  };

  /**
   * `comply_test_controller` adapter set. When supplied, the framework
   * registers the wire tool automatically by composing `createComplyController`
   * (`@adcp/sdk/testing`) with the adopter's adapters and calling
   * `controller.register(server)` after platform handlers wire up.
   *
   * Adopter declares the scenarios they support — `seed: { product, … }`,
   * `force: { creative_status, … }`, `simulate: { delivery, … }`. The
   * framework auto-derives `capabilities.compliance_testing.scenarios`
   * from which adapters are present, projecting the discovery field to
   * `get_adcp_capabilities` so conformance harnesses see what's
   * supported.
   *
   * **Sandbox gating.** `complyTest.sandboxGate(input)` is the per-request
   * gate; tools/list visibility is controlled by whether you supply
   * `complyTest` at all. Production agents typically gate registration
   * itself on `process.env.ADCP_SANDBOX === '1'` or wrap construction in
   * an environment check; the helper logs a loud warning if registered
   * without a gate AND without an env-flag escape (matches the standalone
   * `createComplyController` warning behavior).
   *
   * **Capability-vs-adapter consistency.** Both directions are enforced:
   *
   * - `capabilities.compliance_testing` declared without `complyTest` →
   *   `PlatformConfigError` at construction (and a **compile-time error**
   *   when `P` is typed with `compliance_testing` non-optional, via
   *   `RequiredOptsFor<P>`).
   * - `complyTest` supplied without `capabilities.compliance_testing` →
   *   `PlatformConfigError` at construction (runtime defense-in-depth).
   *
   * To enforce the invariant at compile time when building the platform
   * as an object literal, wrap it with `definePlatformWithCompliance`:
   * TypeScript will then require `compliance_testing` on the platform
   * and `complyTest` on opts together.
   *
   * @public
   */
  complyTest?: ComplyControllerConfig;

  /**
   * Single-pool shortcut: pass a `pg.Pool` (or any `PgQueryable`) and the
   * framework wires `idempotency` + `ctxMetadata` + `taskRegistry`
   * internally with sensible defaults. One connection, three concerns.
   *
   * Adopters who pass any of `idempotency` / `ctxMetadata` / `taskRegistry`
   * explicitly keep override priority — the explicit values win, and the
   * pool fills only the unset ones.
   *
   * Run `getAllAdcpMigrations()` once per database to create the three
   * required tables (idempotency cache, ctx-metadata cache, task registry).
   *
   * @example
   * ```ts
   * import { Pool } from 'pg';
   * import {
   *   createAdcpServerFromPlatform,
   *   getAllAdcpMigrations,
   * } from '@adcp/sdk/server';
   *
   * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
   * await pool.query(getAllAdcpMigrations());
   *
   * const server = createAdcpServerFromPlatform(myPlatform, {
   *   name: 'my-agent',
   *   version: '1.0.0',
   *   pool,                                // wires all three persistence stores
   * });
   * ```
   *
   * **Memory-only deployment:** omit `pool` entirely. Framework defaults to
   * in-memory backends for all three (fine for dev / single-process; not
   * suitable for cluster).
   */
  pool?: PgQueryable;

  /**
   * Ctx-metadata store. Wire to enable the v6.1 `ctx_metadata` round-trip
   * cache: publishers attach opaque platform-specific blobs to any returned
   * resource (`{ product_id, ctx_metadata: { gam: {...} } }`); the framework
   * persists by `(account.id, kind, id)` and threads back into
   * `ctx.ctxMetadata` on subsequent calls referencing the same ID.
   *
   * Memory backend (`memoryCtxMetadataStore()`) for dev / single-process.
   * Postgres (`pgCtxMetadataStore(pool)`) for cluster — silent ctx_metadata
   * loss after rolling restart on memory backend produces "package not
   * found" errors that look like publisher bugs and run for weeks.
   *
   * @example
   * ```ts
   * import { Pool } from 'pg';
   * import {
   *   createAdcpServerFromPlatform,
   *   createCtxMetadataStore,
   *   pgCtxMetadataStore,
   *   getCtxMetadataMigration,
   * } from '@adcp/sdk/server';
   *
   * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
   * await pool.query(getCtxMetadataMigration());
   *
   * const ctxMetadata = createCtxMetadataStore({ backend: pgCtxMetadataStore(pool) });
   *
   * createAdcpServerFromPlatform(myPlatform, {
   *   name: 'My Adapter',
   *   version: '1.0.0',
   *   ctxMetadata,
   * });
   * ```
   *
   * @see docs/proposals/decisioning-platform-v6-1-ctx-metadata.md
   */
  ctxMetadata?: CtxMetadataStore;

  /**
   * Allow `push_notification_config.url` to point at loopback / private-IP
   * destinations. Default is `false` — the framework's request-ingest
   * validator rejects loopback (`localhost`, `127.0.0.0/8`, `::1`),
   * RFC 1918 / CGNAT / link-local ranges, and IPv4-mapped IPv6 forms
   * targeting any of those, since accepting them at production webhook
   * endpoints is a SSRF / cloud-metadata exfiltration path.
   *
   * Set `true` for sandbox / local-testing deployments where
   * adopter-controlled receivers (storyboard webhook receivers, pytest
   * httptest fixtures) bind to `127.0.0.1:<ephemeral>`. The flag bypasses
   * ONLY the private-range branch — malformed-URL, non-http(s) scheme,
   * and the `http://` reject (separately gated by NODE_ENV / the
   * `ADCP_DECISIONING_ALLOW_HTTP_WEBHOOKS` env) all still fire.
   *
   * Adopters typically scope this themselves on `NODE_ENV !== 'production'`
   * or a sandbox env flag — the framework doesn't auto-enable it because
   * the safe default is "reject private destinations." When the flag is
   * `true` AND `NODE_ENV` is unset / `'production'`, the framework emits
   * a one-shot console.warn at construction calling out the relaxation.
   */
  allowPrivateWebhookUrls?: boolean;

  /**
   * When `true`, throw `PlatformConfigError` at construction if any
   * specialism declared in `capabilities.specialisms[]` is missing a
   * platform method matching one of its required tools (per the manifest's
   * `SPECIALISM_REQUIRED_TOOLS`). Default `false` — the framework emits a
   * `console.warn` for each missing method instead, so adopters mid-
   * implementation aren't blocked on incomplete specialism coverage.
   *
   * Recommended for production CI builds: catches "claimed sales-non-
   * guaranteed but forgot to implement getProducts" before the deploy.
   * Recommended off in dev / sandbox where adopters are iterating.
   *
   * Tracked: adcp-client#1299 (manifest adoption stage 3).
   */
  strictSpecialismValidation?: boolean;

  /**
   * Auto-fire a completion webhook on the sync-success arm of mutating
   * tools when the request supplied `push_notification_config.url`.
   * Default is `true` — buyers passing the URL expect notification
   * regardless of whether the seller routed the call sync vs HITL, and
   * v5 adopters routinely wired this manually inside every handler.
   * The framework now does it for them.
   *
   * Webhook payload mirrors the HITL completion shape: top-level
   * `task_type` (the wire tool name), `status: 'completed'`, and
   * `result` carrying the projected sync response. `task_id` is
   * synthesized per call (sync responses don't allocate a registry
   * task); buyers correlate via the resource IDs (`media_buy_id`,
   * `creative_id`, etc.) on `result`.
   *
   * Same `SPEC_WEBHOOK_TASK_TYPES` gate as the HITL path: tools outside
   * the closed wire enum don't emit (adopters use `publishStatusChange`
   * for those). Sync auto-emit and the HITL path share the same
   * `emitWebhook` plumbing — host-wired signing, redelivery, and
   * observability hooks all apply uniformly.
   *
   * Set `false` to suppress the auto-emit for adopters who emit
   * webhooks manually inside their handlers (idempotency duplication
   * concern) or for transitional deployments that don't yet have the
   * webhook receiver path stood up.
   */
  autoEmitCompletionWebhooks?: boolean;

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
 * Derives the opts type for `createAdcpServerFromPlatform` based on whether
 * the platform declares `capabilities.compliance_testing`.
 *
 * When `P` carries a non-optional `compliance_testing` block (e.g. because
 * the caller used `definePlatformWithCompliance`), this resolves to
 * `CreateAdcpServerFromPlatformOptions & { complyTest: ComplyControllerConfig }`,
 * making `complyTest` required. For all other platform shapes the resolved
 * type is the plain `CreateAdcpServerFromPlatformOptions` — no change.
 *
 * Both directions of the mismatch are still caught at runtime by the
 * `PlatformConfigError` check in `createAdcpServerFromPlatform` as
 * defense-in-depth for untyped callers.
 *
 * @public
 */
export type RequiredOptsFor<P extends DecisioningPlatform<any, any>> = P extends {
  capabilities: { compliance_testing: ComplianceTestingCapabilities };
}
  ? CreateAdcpServerFromPlatformOptions & { complyTest: ComplyControllerConfig }
  : CreateAdcpServerFromPlatformOptions;

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
  getTaskState<TResult = unknown>(taskId: string, expectedAccountId?: string): Promise<TaskRecord<TResult> | null>;
  /**
   * Await any in-flight background completion for `taskId` (HITL handoff
   * function still running). Resolves immediately if the task is terminal
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
// `TCtxMeta = Record<string, unknown>` doesn't accept adopter metadata interfaces
// without an index signature (e.g., `interface MyMeta { brand_id: string }`),
// which is a needless friction point — adopter metadata is opaque to the
// framework, so we don't need to constrain it here.
export function createAdcpServerFromPlatform<P extends DecisioningPlatform<any, any>>(
  platform: P &
    RequiredPlatformsFor<P['capabilities']['specialisms'][number]> &
    RequiredCapabilitiesFor<P['capabilities']['specialisms'][number]>,
  opts: RequiredOptsFor<P>
): DecisioningAdcpServer {
  validatePlatform(platform);

  // Specialism→required-tools coverage check (adcp-client#1299).
  //
  // For each specialism declared in `capabilities.specialisms[]`, verify the
  // platform exposes a method matching every tool the manifest's
  // `SPECIALISM_REQUIRED_TOOLS` lists for that specialism. Catches the
  // common adopter mistake of declaring `'sales-non-guaranteed'` while
  // forgetting to implement `getProducts` / `createMediaBuy` / etc. —
  // would otherwise surface as a runtime error when a buyer actually
  // calls the missing tool.
  //
  // Default behavior is console.warn — strictSpecialismValidation: true
  // escalates to a thrown `PlatformConfigError`. The check is method-
  // presence-anywhere on the platform (not method-on-specific-field) so
  // adopters with non-standard layouts (e.g., a single mega-platform vs.
  // the conventional sales/creative/accounts split) aren't false-positively
  // flagged.
  {
    const specialisms = (platform.capabilities as { specialisms?: readonly string[] }).specialisms;
    const issues = validateSpecialismRequiredTools(platform, specialisms);
    if (issues.length > 0) {
      const messages = issues.map(formatSpecialismIssue);
      if (opts.strictSpecialismValidation === true) {
        throw new PlatformConfigError(
          `Platform missing methods for ${issues.length} specialism-required tool(s). ` +
            `Strict mode (\`strictSpecialismValidation: true\`) treats this as fatal.\n` +
            messages.map(m => `  - ${m}`).join('\n')
        );
      }
      // eslint-disable-next-line no-console
      for (const message of messages) console.warn(message);
    }
  }

  // Compliance-testing capability/adapter consistency.
  //
  // Two failure modes the framework refuses to ship:
  //   1. Capability declared, no adapter — discovery field projects to
  //      `get_adcp_capabilities` but the wire tool has no implementation
  //      behind it. Conformance harnesses would dispatch and crash.
  //   2. Adapter wired, capability not declared — discovery field is
  //      missing from `get_adcp_capabilities` so buyers / harnesses can't
  //      tell the agent supports compliance testing.
  //
  // Both throw at construction with `PlatformConfigError`. Adopters who
  // want one without the other are doing it wrong; the right escape hatch
  // is to set `compliance_testing.scenarios = []` (a noop block, but the
  // spec disallows empty `scenarios` so this should never come up in
  // practice — included only to make the constraint explicit).
  const capHasComplianceTesting = platform.capabilities.compliance_testing != null;
  const optsHasComplyTest = opts.complyTest != null;
  if (capHasComplianceTesting && !optsHasComplyTest) {
    throw new PlatformConfigError(
      `capabilities.compliance_testing is declared but opts.complyTest is missing. ` +
        `Either supply complyTest (the ComplyControllerConfig adapter set) or remove ` +
        `the compliance_testing capability block — the framework refuses to advertise ` +
        `comply_test_controller without an implementation.`
    );
  }
  if (optsHasComplyTest && !capHasComplianceTesting) {
    throw new PlatformConfigError(
      `opts.complyTest is supplied but capabilities.compliance_testing is not declared. ` +
        `Add 'compliance_testing: {}' to your platform.capabilities — the framework needs ` +
        `the discovery block to project comply_test_controller scenarios on get_adcp_capabilities. ` +
        `Scenarios auto-derive from your supplied adapters; explicit 'scenarios: [...]' is optional.`
    );
  }

  // Sec-M2: warn when `signed-requests` is claimed but a custom
  // taskWebhookEmitter is wired without acknowledging signing posture.
  // The default emitter (bound to `serve({ webhooks })`) signs; a custom
  // emitter that doesn't declare `unsigned: true` and doesn't delegate
  // to the framework's signed pipeline ships unsigned webhooks to buyers
  // who expect signatures.
  //
  // Gate via DEV_ALLOWLIST inversion (matches feedback_node_env_allowlist):
  // warn when NODE_ENV is NOT in {test, development} AND no explicit ack
  // env. Catches NODE_ENV unset, 'staging', 'prod', 'live' — common
  // production deployments that the previous `=== 'production'` check
  // failed open on.
  // Footgun guard for `allowPrivateWebhookUrls` — same DEV_ALLOWLIST
  // inversion pattern as the unsigned-emitter check below. Adopters
  // intentionally relaxing the SSRF gate for sandbox testing aren't
  // doing anything wrong; production deployments that flip this on
  // accidentally are. Warn on construction when the flag is true AND
  // NODE_ENV is unset / 'staging' / 'prod' / 'live' AND no explicit
  // ack env. Keeps the relaxation usable for real local-test setups
  // without letting it sneak into production.
  if (opts.allowPrivateWebhookUrls === true) {
    const env = process.env.NODE_ENV;
    const isDevOrTest = env === 'test' || env === 'development';
    const ack = process.env.ADCP_DECISIONING_ALLOW_PRIVATE_WEBHOOK_URLS === '1';
    if (!isDevOrTest && !ack) {
      // eslint-disable-next-line no-console
      console.warn(
        '[adcp/decisioning] allowPrivateWebhookUrls: true relaxes the loopback / private-IP ' +
          'guard on push_notification_config.url. NODE_ENV is not test/development and ' +
          'ADCP_DECISIONING_ALLOW_PRIVATE_WEBHOOK_URLS is not set — accepting private ' +
          'destinations in production is a SSRF / cloud-metadata exfiltration path. ' +
          'For sandbox/local testing, scope this on your own NODE_ENV check.'
      );
    }
  }

  if (opts.taskWebhookEmitter && !opts.taskWebhookEmitter.unsigned) {
    const claimsSigned = platform.capabilities?.specialisms?.includes('signed-requests' as never);
    const env = process.env.NODE_ENV;
    const isDevOrTest = env === 'test' || env === 'development';
    const ackUnsignedTestEmitter = process.env.ADCP_DECISIONING_ALLOW_UNSIGNED_TEST_EMITTER === '1';
    if (claimsSigned && !isDevOrTest && !ackUnsignedTestEmitter) {
      // eslint-disable-next-line no-console
      console.warn(
        '[adcp/decisioning] taskWebhookEmitter wired without unsigned:true while ' +
          "platform.capabilities.specialisms claims 'signed-requests'. " +
          'Buyers expecting RFC 9421 signatures will receive unsigned webhooks ' +
          'unless your custom emitter delegates to the framework signing path. ' +
          'If this is intentional (your emitter signs internally), set ' +
          'unsigned: true on the emitter. For dev/test fakes, set ' +
          'ADCP_DECISIONING_ALLOW_UNSIGNED_TEST_EMITTER=1 or NODE_ENV=test.'
      );
    }
  }

  // Pool shortcut: when `opts.pool` is wired and a specific store/registry
  // is NOT explicitly set, derive that store from pool with sensible
  // defaults. Explicit per-store opts always win — this is "fill the gaps,"
  // not "override what the adopter passed."
  const pooledIdempotency: IdempotencyStore | undefined =
    opts.pool && opts.idempotency === undefined ? createIdempotencyStore({ backend: pgBackend(opts.pool) }) : undefined;
  const pooledCtxMetadata: CtxMetadataStore | undefined =
    opts.pool && opts.ctxMetadata === undefined
      ? createCtxMetadataStore({ backend: pgCtxMetadataStore(opts.pool) })
      : undefined;
  const pooledTaskRegistry: TaskRegistry | undefined =
    opts.pool && opts.taskRegistry === undefined ? createPostgresTaskRegistry({ pool: opts.pool }) : undefined;

  // Effective resolved values. Explicit > pooled > default.
  const effectiveIdempotency: IdempotencyStore | 'disabled' | undefined = opts.idempotency ?? pooledIdempotency;
  const effectiveCtxMetadata: CtxMetadataStore | undefined = opts.ctxMetadata ?? pooledCtxMetadata;
  const taskRegistry = opts.taskRegistry ?? pooledTaskRegistry ?? buildDefaultTaskRegistry();
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
  const fwLogger = opts.logger ?? DEFAULT_FRAMEWORK_LOGGER;
  const mergeOpts = { mode: opts.mergeSeam ?? 'warn', logger: fwLogger };

  // Project per-domain capability blocks declared on the platform onto
  // get_adcp_capabilities via createAdcpServer's `overrides.media_buy`
  // deep-merge seam. Adopters declare audience_targeting /
  // conversion_tracking / content_standards on `platform.capabilities`;
  // the framework wires the deep-merge so buyers see the discovery
  // fields without an opaque custom get_adcp_capabilities tool (which
  // the framework refuses anyway).
  //
  // Each rich block also forces the corresponding `media_buy.features.*`
  // boolean to `true`. Buyers gating on `features.audience_targeting`
  // (which the framework auto-derives as `false` by default) would
  // otherwise skip the rich block sitting next to it.
  const at = platform.capabilities.audience_targeting;
  const ct = platform.capabilities.conversion_tracking;
  const cs = platform.capabilities.content_standards;
  const hasMediaBuyProjection = at != null || ct != null || cs != null;
  const mediaBuyOverrides: Partial<NonNullable<GetAdCPCapabilitiesResponse['media_buy']>> = {
    ...(at != null && { audience_targeting: at }),
    ...(ct != null && { conversion_tracking: ct }),
    ...(cs != null && { content_standards: cs }),
    ...(hasMediaBuyProjection && {
      features: {
        ...(at != null && { audience_targeting: true }),
        ...(ct != null && { conversion_tracking: true }),
        ...(cs != null && { content_standards: true }),
      },
    }),
  };

  // Brand-protocol capability projection. Adopters who declare
  // `capabilities.brand` get the block projected via `overrides.brand`.
  // When `BrandRightsPlatform` is supplied, `rights: true` is auto-
  // derived (the framework knows the wire tools are available); adopter-
  // declared `right_types` / `available_uses` / `generation_providers` /
  // `description` ride the deep-merge.
  const adopterBrand = platform.capabilities.brand;
  const hasBrandRightsImpl = platform.brandRights != null;
  const hasBrandProjection = adopterBrand != null || hasBrandRightsImpl;
  const brandOverrides: Partial<NonNullable<GetAdCPCapabilitiesResponse['brand']>> = {
    ...(hasBrandRightsImpl && { rights: true }),
    ...adopterBrand,
  };

  // Account-mode capability projection. Two redundant adopter signals
  // resolve into the same wire bit:
  //   - `capabilities.requireOperatorAuth: true` — explicit override
  //   - `accounts.resolution: 'explicit'` — derived from the account-store
  //     model (operators authenticate independently with the seller; the
  //     buyer discovers accounts via `list_accounts`, NOT `sync_accounts`).
  // Either, taken alone, projects to `account.require_operator_auth: true`.
  // The conformance storyboard runner reads this bit at step time and
  // grades `sync_accounts` steps as `'not_applicable'` (rather than the
  // misleading `'missing_tool'`) for explicit-mode adopters who correctly
  // don't implement that tool. See storyboard runner.ts account-mode gate.
  //
  // `supportedBillings` projects onto the parallel `account.supported_billing`
  // wire field — buyers pre-flight check whether the seller bills the
  // operator (retail-media model) or the buying agent (pass-through). Without
  // the projection, retail-media adopters that declared `['operator']` saw
  // their buyers default-route to agent-billed flows.
  const requireOperatorAuth = platform.capabilities.requireOperatorAuth ?? platform.accounts.resolution === 'explicit';
  const supportedBillings = platform.capabilities.supportedBillings;
  const hasAccountProjection = requireOperatorAuth === true || (supportedBillings?.length ?? 0) > 0;
  // Schema requires `supported_billing` (minItems: 1) whenever the account
  // block is emitted. Default to ['agent'] when adopters don't declare —
  // matches the documented platform interface default at
  // `capabilities.ts:130` ("Defaults to ['agent'] when omitted"). v6 was
  // dropping the field on undefined which failed schema validation; v5's
  // `?? []` would also fail (minItems: 1). 'agent' (agent consolidates
  // billing) is the least-surprising default for non-media-buy specialisms.
  // An adopter passing supportedBillings: [] also lands in the default
  // branch — the closed enum has no semantic meaning for empty, and
  // emitting an empty array would fail schema regardless.
  const accountOverrides: Partial<NonNullable<GetAdCPCapabilitiesResponse['account']>> = {
    ...(requireOperatorAuth === true && { require_operator_auth: true }),
    ...(hasAccountProjection && {
      supported_billing: supportedBillings?.length ? [...supportedBillings] : ['agent'],
    }),
  };

  // Compliance-testing scenarios projection. Adopters who claim the
  // `compliance_testing` capability AND wire `complyTest` adapters
  // expect buyers to discover which scenarios they implement via
  // `get_adcp_capabilities.compliance_testing.scenarios`. Without
  // projection the wire response carried an empty `compliance_testing: {}`
  // block, the comply-track runner emitted a warning on every call,
  // and adopters saw an actionable-looking message pointing at
  // something they'd already done correctly. Auto-derive scenario names
  // from the wired adapters; let an explicit
  // `capabilities.compliance_testing.scenarios` override the
  // auto-derivation when adopters want to advertise a subset.
  const declaredCT = platform.capabilities.compliance_testing;
  const wiredComplyTest = opts.complyTest;
  const hasComplianceTestingProjection = declaredCT != null && wiredComplyTest != null;
  const complianceTestingOverrides: NonNullable<GetAdCPCapabilitiesResponse['compliance_testing']> | undefined =
    hasComplianceTestingProjection
      ? {
          scenarios: declaredCT.scenarios ? [...declaredCT.scenarios] : deriveScenariosFromAdapters(wiredComplyTest),
        }
      : undefined;

  const projectedCapabilitiesConfig =
    hasMediaBuyProjection || hasBrandProjection || hasAccountProjection || hasComplianceTestingProjection
      ? {
          overrides: {
            ...(hasMediaBuyProjection && { media_buy: mediaBuyOverrides }),
            ...(hasBrandProjection && { brand: brandOverrides }),
            ...(hasAccountProjection && { account: accountOverrides }),
            ...(hasComplianceTestingProjection &&
              complianceTestingOverrides != null && { compliance_testing: complianceTestingOverrides }),
          },
        }
      : undefined;

  // Per-server `ctxFor` closure; threads the effective ctx-metadata store
  // (explicit > pooled > none) into `buildRequestContext` so handlers see
  // `ctx.ctxMetadata` as an account-scoped accessor. Multi-tenant hosts
  // (TenantRegistry) get one closure per server, so per-tenant store
  // routing is preserved.
  const ctxFor = makeCtxFor(effectiveCtxMetadata);

  // Construction-time warn: when the default `resolveIdempotencyPrincipal`
  // is used (no explicit hook), the chain falls through:
  //   ctx.authInfo.clientId → ctx.sessionKey → ctx.account.id → undefined
  // The `account.id` fallback collapses unauthenticated buyers into one
  // shared idempotency namespace per account — fine for single-tenant
  // deployments where every buyer authenticates, dangerous for multi-
  // tenant hosts serving unauthenticated traffic over a shared
  // account_id. Gate via the dev-allowlist pattern: warn unless
  // NODE_ENV ∈ {test, development} OR the operator explicitly acks via
  // ADCP_DECISIONING_ALLOW_ACCOUNT_ID_PRINCIPAL=1.
  if (opts.resolveIdempotencyPrincipal === undefined) {
    const env = process.env.NODE_ENV;
    const inDevAllowlist = env === 'test' || env === 'development';
    const acked = process.env.ADCP_DECISIONING_ALLOW_ACCOUNT_ID_PRINCIPAL === '1';
    if (!inDevAllowlist && !acked) {
      // eslint-disable-next-line no-console
      console.warn(
        `[adcp/decisioning] resolveIdempotencyPrincipal not explicitly wired. ` +
          `Default falls through: authInfo.clientId → sessionKey → account.id → undefined. ` +
          `The account.id fallback collapses unauthenticated buyers into one shared idempotency ` +
          `namespace per account. SAFE for single-tenant deployments where every buyer ` +
          `authenticates; UNSAFE for multi-tenant hosts serving unauthenticated traffic over a ` +
          `shared account_id. Wire \`authenticate\` on serve() (verifyApiKey / verifyIntrospection) ` +
          `OR pass an explicit \`resolveIdempotencyPrincipal\` in opts. ` +
          `Set ADCP_DECISIONING_ALLOW_ACCOUNT_ID_PRINCIPAL=1 to silence this warning.`
      );
    }
  }

  // Auto-seed: when the platform has a `getProducts` catalog and the adopter
  // wired `complyTest` without ANY explicit seed adapters and without a
  // `testController` bridge, the framework provides default in-memory seed
  // adapters so storyboards can call `seed_product` / `seed_pricing_option`
  // without the adopter writing any adapter code. The bridge makes seeded
  // products visible in `get_products` responses on sandbox requests.
  //
  // **Multi-tenant isolation.** The store is keyed by `account_id` so two
  // sandbox accounts on the same server (e.g. multiple tenants under one
  // TenantRegistry-fronted server, or distinct sandbox accounts on a
  // single-tenant server) never see each other's seeded products in
  // `get_products`. Adopters who need tighter scoping (per-session,
  // per-brand, per-storyboard-run) wire `bridgeFromSessionStore` explicitly
  // — auto-seed is the floor, not the ceiling.
  //
  // **Caveat.** The comply-controller's process-wide `SeedFixtureCache`
  // (`test-controller.ts createSeedFixtureCache`) keys by
  // `seed_product:${product_id}` and rejects divergent fixtures replayed
  // under the same id with `INVALID_PARAMS`. So two sandbox accounts can
  // freely seed *different* product_ids without leakage, but cannot seed
  // the same product_id with different fixtures on one server. That's a
  // pre-existing SDK limitation independent of auto-seed; lifting it
  // requires per-account seedCache scoping — tracked as a follow-up.
  //
  // The entire auto-seed path is skipped when EITHER `seed.product` OR
  // `seed.pricing_option` is explicitly wired — mixing explicit and auto-seed
  // adapters against the same bridge would yield inconsistent `get_products`
  // responses. In that case the adopter owns the full seed + bridge wiring.
  const autoSeedStore: Map<string, Map<string, unknown>> | undefined =
    opts.complyTest != null &&
    platform.sales?.getProducts != null &&
    !opts.testController &&
    !opts.complyTest.seed?.product &&
    !opts.complyTest.seed?.pricing_option
      ? new Map<string, Map<string, unknown>>()
      : undefined;

  const config: AdcpServerConfig<Account> = {
    ...opts,
    ...(autoSeedStore != null && { testController: makeAutoSeedBridge(autoSeedStore) }),
    ...(projectedCapabilitiesConfig != null && { capabilities: projectedCapabilitiesConfig }),
    // Buyer-agent registry (Phase 1 of #1269). Threaded through from the
    // platform so the v5 dispatcher can call `agentRegistry.resolve()` on
    // every request and populate `ctx.agent`. When the platform omits the
    // field, the v5 surface stays unchanged.
    //
    // Precedence: this spread runs AFTER `...opts`, so `platform.agentRegistry`
    // wins over any `opts.agentRegistry` an adopter passes via the v5 escape
    // hatch. Same convention as the `idempotency` spread below — the platform
    // is the authoritative v6 surface; opts is a low-level escape hatch.
    ...(platform.agentRegistry !== undefined && { agentRegistry: platform.agentRegistry }),
    // Server-level `instructions` (closes #1312). Same precedence pattern as
    // `agentRegistry` above — platform-declared instructions win over the
    // v5 `opts.instructions` escape hatch when both are present, so v6
    // adopters can colocate platform facts / decision policy with the rest
    // of their platform declaration.
    ...(platform.instructions !== undefined && { instructions: platform.instructions }),
    ...(platform.onInstructionsError !== undefined && { onInstructionsError: platform.onInstructionsError }),
    // Pool-derived stores override the spread above when adopters supplied
    // `pool` but no explicit per-store opt. Explicit values still win.
    ...(effectiveIdempotency !== undefined && { idempotency: effectiveIdempotency }),
    // v6 default principal resolver: every mutating tool requires an
    // idempotency principal (the v5 createAdcpServer surface returns
    // SERVICE_UNAVAILABLE when one isn't wired). v6 platform adopters
    // who skip the explicit hook get a sensible default — auth client
    // id when present (multi-tenant: each buyer owns its own
    // idempotency namespace), else session key, else account id
    // (single-tenant fallback). Adopters override by passing
    // resolveIdempotencyPrincipal in opts; the spread above keeps
    // explicit values winning. Closed by the Emma matrix surfacing
    // SERVICE_UNAVAILABLE on every v6 mutating call.
    resolveIdempotencyPrincipal:
      opts.resolveIdempotencyPrincipal ??
      (ctx => ctx.authInfo?.clientId ?? ctx.sessionKey ?? ctx.account?.id ?? undefined),
    resolveAccount: async (ref, ctx) => {
      const start = Date.now();
      let resolved = false;
      let resolvedAccountId: string | undefined;
      try {
        // Enforce the JSDoc contract documented at
        // `AccountStore.resolution`: implicit-mode platforms refuse inline
        // `account_id` references — buyers call sync_accounts first, then
        // the framework resolves accounts from the auth principal on
        // subsequent calls. The brand+operator union arm is permitted
        // (used during the initial sync_accounts onboarding flow); only
        // the `{ account_id }` arm is refused. Closes adcp-client#1364.
        refuseImplicitAccountId(platform.accounts.resolution, ref);
        const account = await platform.accounts.resolve(ref, toResolveCtx(ctx, ctx.toolName));
        resolved = account != null;
        resolvedAccountId = account?.id;
        return account;
      } catch (err) {
        if (err instanceof AccountNotFoundError) return null;
        throw err;
      } finally {
        safeFire(
          observability?.onAccountResolve,
          {
            tool: ctx.toolName,
            durationMs: Date.now() - start,
            resolved,
            fromAuth: false,
            ...(resolvedAccountId !== undefined && { accountId: resolvedAccountId }),
          },
          'onAccountResolve',
          fwLogger
        );
      }
    },
    // Auth-derived path: framework calls this for tools whose wire request
    // doesn't carry an `account` field (`provide_performance_feedback`,
    // `list_creative_formats`, `tasks_get`). The platform's resolver runs
    // with `undefined` ref + `authInfo` available — adopters of any
    // `resolution` mode can return a non-null Account here:
    //
    //   - `'derived'` — return the singleton.
    //   - `'implicit'` — look up by `ctx.authInfo.clientId`.
    //   - `'explicit'` — also handle the `undefined` ref branch by
    //     looking up via `ctx.authInfo.clientId` (or whichever principal
    //     field your auth wires). The framework calls this resolver
    //     regardless of declared `resolution` mode; only adopters who
    //     intentionally don't model these tools return null.
    //
    // A `null` return is legal — handler runs with `ctx.account`
    // undefined. Appropriate for tools that don't need tenant scoping
    // (publisher-wide format catalogs).
    resolveAccountFromAuth: async ctx => {
      const start = Date.now();
      let resolved = false;
      let resolvedAccountId: string | undefined;
      try {
        const account = await platform.accounts.resolve(undefined, toResolveCtx(ctx, ctx.toolName));
        resolved = account != null;
        resolvedAccountId = account?.id;
        return account;
      } catch (err) {
        if (err instanceof AccountNotFoundError) return null;
        throw err;
      } finally {
        safeFire(
          observability?.onAccountResolve,
          {
            tool: ctx.toolName,
            durationMs: Date.now() - start,
            resolved,
            fromAuth: true,
            ...(resolvedAccountId !== undefined && { accountId: resolvedAccountId }),
          },
          'onAccountResolve',
          fwLogger
        );
      }
    },
    // Merge: platform-derived handlers WIN per-key over adopter-supplied
    // custom handlers. Adopter handlers fill gaps for tools the v6 platform
    // doesn't yet model (content-standards CRUD, sync_event_sources, etc.).
    // See `CreateAdcpServerFromPlatformOptions` JSDoc for the migration-seam
    // contract.
    mediaBuy: mergeHandlers(
      opts.mediaBuy,
      buildMediaBuyHandlers(
        platform,
        taskRegistry,
        taskWebhookEmit,
        observability,
        fwLogger,
        {
          allowPrivateWebhookUrls: opts.allowPrivateWebhookUrls === true,
          autoEmitCompletionWebhooks: opts.autoEmitCompletionWebhooks !== false,
        },
        ctxFor,
        effectiveCtxMetadata
      ),
      'mediaBuy',
      mergeOpts
    ),
    creative: mergeHandlers(
      opts.creative,
      buildCreativeHandlers(
        platform,
        taskRegistry,
        taskWebhookEmit,
        observability,
        fwLogger,
        {
          allowPrivateWebhookUrls: opts.allowPrivateWebhookUrls === true,
          autoEmitCompletionWebhooks: opts.autoEmitCompletionWebhooks !== false,
        },
        ctxFor
      ),
      'creative',
      mergeOpts
    ),
    eventTracking: mergeHandlers(
      opts.eventTracking,
      buildEventTrackingHandlers(platform, ctxFor),
      'eventTracking',
      mergeOpts
    ),
    signals: mergeHandlers(
      opts.signals,
      buildSignalsHandlers(platform, ctxFor, effectiveCtxMetadata, fwLogger),
      'signals',
      mergeOpts
    ),
    governance: mergeHandlers(opts.governance, buildGovernanceHandlers(platform, ctxFor), 'governance', mergeOpts),
    accounts: mergeHandlers(opts.accounts, buildAccountHandlers(platform, ctxFor), 'accounts', mergeOpts),
    brandRights: mergeHandlers(
      opts.brandRights,
      buildBrandRightsHandlers(platform, ctxFor, effectiveCtxMetadata, fwLogger),
      'brandRights',
      mergeOpts
    ),
    customTools: {
      ...opts.customTools,
      tasks_get: buildTasksGetTool(platform, taskRegistry, platform.agentRegistry, fwLogger),
    },
  };

  const server = createAdcpServer(config);

  // Wire `comply_test_controller` if the adopter supplied adapters.
  // `createComplyController` builds the tool definition + handler + raw
  // dispatch; `register(server)` calls server.registerTool. Sandbox
  // gating is the adopter's job (per-request via complyTest.sandboxGate
  // or environment-level by guarding the createAdcpServerFromPlatform
  // call site itself).
  if (opts.complyTest != null) {
    let complyConfig = opts.complyTest;

    if (autoSeedStore != null) {
      // Inject auto-seed adapters for `seed_product` and `seed_pricing_option`
      // when the adopter didn't wire explicit ones. Explicit adapters win — the
      // spread only fills the undefined slots.
      //
      // **Namespace key: raw `account.account_id`.** The adapter does NOT call
      // `platform.accounts.resolve` even though that would seem symmetric with
      // the bridge's `ctx.account?.id` read — calling resolve here without
      // `authInfo` (which `ComplyControllerContext` doesn't expose) lets a
      // caller spoof `account.account_id: 'victim'` and have a non-validating
      // resolver write seeds into the victim's resolved namespace. Raw id is
      // the safe choice: a caller can only write to their own claimed id, and
      // the sandboxGate already filters non-sandbox traffic.
      //
      // **Trade-off.** Adopters whose resolver maps `account_id` to a distinct
      // internal id (e.g., `acc_1` → `tenant_a:acc_1`) will see seeded fixtures
      // disappear — the adapter writes to `acc_1`, the bridge reads
      // `tenant_a:acc_1`, no match. That's a documented limitation, not a
      // security issue: silent test loss, not cross-tenant pollution. The
      // architectural fix (widen `ComplyControllerContext` to expose the
      // framework-resolved account so writes match reads even under mapping
      // resolvers) is tracked at #1216. Mapping-resolver adopters wire
      // explicit seed adapters today.
      const explicitSeed = opts.complyTest.seed ?? {};
      const autoSeed = { ...explicitSeed };

      if (!explicitSeed.product) {
        autoSeed.product = async (params, ctx) => {
          const accountId = readAutoSeedAccountId(ctx.input);
          if (accountId == null) {
            fwLogger.warn(
              '[adcp/auto-seed] seed_product fired without `account.account_id`; dropping write. ' +
                'Verify the request envelope carries an account ref and the sandboxGate is configured correctly.',
              { product_id: params.product_id }
            );
            return;
          }
          autoSeedStoreFor(autoSeedStore, accountId).set(params.product_id, {
            ...params.fixture,
            product_id: params.product_id,
          });
        };
      }

      if (!explicitSeed.pricing_option) {
        autoSeed.pricing_option = async (params, ctx) => {
          const accountId = readAutoSeedAccountId(ctx.input);
          if (accountId == null) {
            fwLogger.warn(
              '[adcp/auto-seed] seed_pricing_option fired without `account.account_id`; dropping write. ' +
                'Verify the request envelope carries an account ref and the sandboxGate is configured correctly.',
              { product_id: params.product_id, pricing_option_id: params.pricing_option_id }
            );
            return;
          }
          const accountStore = autoSeedStoreFor(autoSeedStore, accountId);
          const existing = accountStore.get(params.product_id) as Record<string, unknown> | undefined;
          const pricingOption = { ...params.fixture, pricing_option_id: params.pricing_option_id };
          const existingOptions = Array.isArray(
            (existing as { pricing_options?: unknown[] } | undefined)?.pricing_options
          )
            ? (existing as { pricing_options: unknown[] }).pricing_options
            : [];
          const filtered = existingOptions.filter(
            (p): p is Record<string, unknown> =>
              p != null &&
              typeof p === 'object' &&
              (p as Record<string, unknown>).pricing_option_id !== params.pricing_option_id
          );
          accountStore.set(params.product_id, {
            ...(existing ?? { product_id: params.product_id }),
            pricing_options: [...filtered, pricingOption],
          });
        };
      }

      complyConfig = { ...opts.complyTest, seed: autoSeed };
    }

    const controller = createComplyController(complyConfig);
    controller.register(server);
  }

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
  taskRegistry: TaskRegistry,
  agentRegistry: BuyerAgentRegistry | undefined,
  logger: AdcpLogger
) {
  const inputShape = {
    // Cap task_id length: framework-issued task ids are
    // `task_<UUIDv4>` = 41 chars. Cap at 128 so a malicious buyer can't
    // hand us megabytes of string for a parameterized read query.
    task_id: z
      .string()
      .min(1)
      .max(128)
      .describe('Task identifier returned in the submitted envelope of a HITL tool call.'),
    // `AccountReference.account_id` per `core/account-ref.json`. Stricter
    // than `passthrough()` — must be a string when present. We don't
    // accept the `{ brand, operator }` arm here because tenant scoping
    // for `tasks_get` is by resolved account id, not by brand identity.
    account: z
      .object({ account_id: z.string().min(1).optional() })
      .strict()
      .optional()
      .describe('Optional account reference for tenant scoping. Required for multi-tenant deployments.'),
  };
  return {
    description:
      'Call this when you receive `{ status: "submitted", task_id }` from create_media_buy ' +
      'or sync_creatives — pass the same `task_id` plus your `account` to retrieve the ' +
      'terminal lifecycle state. Returns the spec-flat tasks-get-response shape ' +
      '(`status`, `result` on completed, `error: { code, message }` on failed). ' +
      "Snake-case substitute for the spec's `tasks/get` method (MCP tool names disallow " +
      '`/`); native MCP method dispatch lands in v6.1. Webhook delivery is the push-based ' +
      'alternative when the buyer set `push_notification_config` on the original request.',
    title: 'Get Task State',
    inputSchema: inputShape,
    annotations: { readOnlyHint: true },
    // Handler receives the MCP RequestHandlerExtra as second arg — carries
    // the caller's `authInfo` extracted by `serve({ authenticate })`. Thread
    // it through `accounts.resolve(ref, ctx)` so adopters' `'explicit'`-mode
    // resolvers can authorize the resolution against the principal — without
    // this, an attacker passing `{ account: { account_id: 'tenant_B' } }`
    // gets tenant B's account back from a naive `findById(ref.account_id)`
    // resolver and reads tenant B's task. Same threading as the regular
    // `resolveAccount` dispatch flow in `create-adcp-server.ts:2380-2398`.
    handler: async (
      args: { task_id: string; account?: { account_id?: string } },
      extra: { authInfo?: ResolvedAuthInfo }
    ) => {
      const ref = args.account;
      // Resolve the buyer agent (when an `agentRegistry` is configured) so
      // adopters' `accounts.resolve` impl sees `ctx.agent` — same contract as
      // every other AccountStore method. Bypasses the dispatcher's
      // resolution-and-status-enforcement seam at
      // `create-adcp-server.ts:2748-2832` deliberately:
      //
      //   - **Status enforcement is intentionally skipped on tasks_get
      //     polls.** A buyer agent suspended AFTER kicking off an HITL task
      //     must still be able to learn the task's terminal state — refusing
      //     the poll would strand work with no visibility. Hard-cutoff
      //     sellers implement that policy inside their `accounts.resolve`
      //     or downstream by reading `ctx.agent.status` themselves.
      //   - **Registry failures don't break the poll.** A transient registry
      //     error during a read poll falls through to `agent: undefined`;
      //     adopters who require a resolved agent for tenant scoping can
      //     return null from their `accounts.resolve` and the existing
      //     ACCOUNT_NOT_FOUND surface fires.
      let agent: BuyerAgent | undefined;
      if (agentRegistry !== undefined) {
        try {
          const resolved = await agentRegistry.resolve({
            ...(extra?.authInfo?.credential !== undefined && { credential: extra.authInfo.credential }),
            ...(extra?.authInfo?.extra !== undefined && { extra: extra.authInfo.extra }),
          });
          if (resolved != null) {
            // Mirror the dispatcher's freeze contract: lock the resolved
            // record (and `billing_capabilities` Set if present) so adopter
            // code cannot mutate shared registry state across requests.
            // See `create-adcp-server.ts:2762-2779` for the full rationale.
            if (!Object.isFrozen(resolved)) {
              if (resolved.billing_capabilities instanceof Set) {
                Object.freeze(resolved.billing_capabilities);
              }
              Object.freeze(resolved);
            }
            agent = resolved;
          }
        } catch (err) {
          // Swallow to keep the poll alive (see policy comment above), but
          // log so upstream-IDP outages are visible to operators. Without
          // this log, buyers seeing REFERENCE_NOT_FOUND for valid tasks
          // (because adopters' resolvers return null without `ctx.agent`)
          // would be invisible in adopter logs. Per security-reviewer
          // defense-in-depth note on PR #1323.
          logger.warn?.('Buyer-agent registry resolution failed during tasks_get poll', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      const resolveCtx = {
        ...(extra?.authInfo !== undefined && { authInfo: extra.authInfo }),
        toolName: 'tasks_get',
        ...(agent !== undefined && { agent }),
      };
      let resolvedAccountId: string | undefined;
      if (ref) {
        refuseImplicitAccountId(platform.accounts.resolution, ref as AccountReference);
        try {
          const resolved = await platform.accounts.resolve(ref as AccountReference, resolveCtx);
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
          const resolved = await platform.accounts.resolve(undefined, resolveCtx);
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
      // Tenant boundary. Two checks to close the auth-derived bypass:
      //   1. If we resolved an account, the task's owning account must match.
      //   2. If we did NOT resolve an account but the task IS owned by an
      //      account, refuse to leak. This catches the unauthenticated /
      //      `'explicit'`-mode-misconfigured caller that hits the auth-derived
      //      branch and would otherwise read any task by id.
      if (resolvedAccountId === undefined && record.accountId) {
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

      // Spec shape: `tasks-get-response.json` requires task_id, task_type,
      // status, created_at, updated_at, protocol. Optional: completed_at
      // (terminal states), error (failed tasks — top-level, NOT inside
      // result), result (success-arm body for completed tasks),
      // has_webhook (whether buyer wired push_notification_config).
      const payload: Record<string, unknown> = {
        task_id: record.taskId,
        task_type: record.tool,
        status: record.status,
        protocol: protocolForTool(record.tool),
        has_webhook: record.hasWebhook === true,
        created_at: record.createdAt,
        updated_at: record.updatedAt,
      };
      // Terminal states get `completed_at` per spec (covers completed,
      // failed, canceled). The framework writes terminal-state transitions
      // by stamping `updated_at`, so the two coincide today.
      if (record.status === 'completed' || record.status === 'failed' || record.status === 'canceled') {
        payload.completed_at = record.updatedAt;
      }
      if (record.statusMessage) payload.message = record.statusMessage;
      if (record.status === 'completed' && record.result !== undefined) {
        payload.result = record.result;
      }
      if (record.status === 'failed' && record.error) {
        // Spec shape: top-level `error: { code, message, details? }` —
        // matches `tasks-get-response.json`'s required `code` + `message`
        // shape with optional `details` carrying the structured-error
        // tail (`recovery`, `field`, `suggestion`, `retry_after`,
        // adopter-supplied `details`).
        const { code, message, ...details } = record.error;
        payload.error = {
          code,
          message,
          ...(Object.keys(details).length > 0 && { details }),
        };
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
 * Fire an observability callback with throw-safe semantics — both sync
 * throws AND rejected promises are caught + logged so a buggy span/metric
 * callback never breaks dispatch. The framework does NOT await the
 * callback; if you need async tracer work, do it inside the callback and
 * the framework will not hold the dispatch path waiting for it.
 */
/**
 * Derive scenario names from a wired `ComplyControllerConfig` adapter
 * set. Each adapter slot maps to one wire scenario name. Order is
 * stable (force → simulate) so adopter wire-fixture snapshots don't
 * churn between releases. Used by the projection seam to populate
 * `get_adcp_capabilities.compliance_testing.scenarios` when the adopter
 * doesn't supply an explicit subset.
 *
 * Seed scenarios (`seed_product`, `seed_creative`, etc.) are
 * deliberately NOT advertised on the wire — the spec scopes the
 * `compliance_testing.scenarios` enum to forces + simulates, and the
 * controller's own `list_scenarios` response follows the same rule.
 * Adopters who wire seed adapters get them dispatched correctly at
 * runtime; they just don't appear in capability discovery.
 */
function deriveScenariosFromAdapters(
  cfg: ComplyControllerConfig
): NonNullable<NonNullable<GetAdCPCapabilitiesResponse['compliance_testing']>['scenarios']> {
  const out: Array<NonNullable<NonNullable<GetAdCPCapabilitiesResponse['compliance_testing']>['scenarios']>[number]> =
    [];
  if (cfg.force?.creative_status) out.push('force_creative_status');
  if (cfg.force?.account_status) out.push('force_account_status');
  if (cfg.force?.media_buy_status) out.push('force_media_buy_status');
  if (cfg.force?.session_status) out.push('force_session_status');
  if (cfg.simulate?.delivery) out.push('simulate_delivery');
  if (cfg.simulate?.budget_spend) out.push('simulate_budget_spend');
  return out;
}

function safeFire<T>(fn: ((arg: T) => unknown) | undefined, arg: T, hookName: string, logger: AdcpLogger): void {
  if (!fn) return;
  let result: unknown;
  try {
    result = fn(arg);
  } catch (err) {
    logger.warn(
      `[adcp/decisioning] observability hook ${hookName} threw — telemetry callbacks must never throw. ` +
        `Error: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }
  // Catch rejected promises from accidentally-async callbacks. Without
  // this an `async () => { throw ... }` hook would surface as
  // UnhandledPromiseRejection and on `--unhandled-rejections=strict`
  // would crash the process. `Promise.resolve()` coerces both real
  // promises and user-land thenables (a thenable returning sync values
  // is wrapped, a true Promise is returned as-is) — safer than the
  // duck-typed `typeof .catch === 'function'` check.
  if (result !== undefined && result !== null) {
    Promise.resolve(result).catch((err: unknown) => {
      logger.warn(
        `[adcp/decisioning] observability hook ${hookName} returned a rejected promise — ` +
          `telemetry callbacks must never reject. ` +
          `Error: ${err instanceof Error ? err.message : String(err)}`
      );
    });
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
/**
 * Combined DDL for all framework persistence tables: idempotency cache,
 * ctx-metadata cache, and decisioning task registry. Run once per database
 * during deployment / boot. Idempotent — safe to re-run.
 *
 * Use with the `pool` shortcut on `createAdcpServerFromPlatform`:
 *
 * ```ts
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * await pool.query(getAllAdcpMigrations());
 *
 * createAdcpServerFromPlatform(myPlatform, {
 *   name: '...', version: '...',
 *   pool,
 * });
 * ```
 *
 * Adopters who don't use the `pool` shortcut should call the per-store
 * migration helpers (`getIdempotencyMigration`, `getCtxMetadataMigration`,
 * `getDecisioningTaskRegistryMigration`) only for the stores they wire.
 *
 * @public
 */
export function getAllAdcpMigrations(): string {
  return [getIdempotencyMigration(), getCtxMetadataMigration(), getDecisioningTaskRegistryMigration()].join('\n\n');
}

function buildDefaultTaskRegistry(): TaskRegistry {
  const env = process.env.NODE_ENV;
  const safe = env === 'test' || env === 'development';
  const ack = process.env.ADCP_DECISIONING_ALLOW_INMEMORY_TASKS === '1';
  if (!safe && !ack) {
    throw new Error(
      'createAdcpServerFromPlatform: in-memory task registry refused outside ' +
        '{NODE_ENV=test, NODE_ENV=development}. Production deployments need a ' +
        'durable task registry — pick one of:\n' +
        '  1. (Recommended) Pass `taskRegistry: createPostgresTaskRegistry({ pool })` ' +
        'to keep HITL tasks across restarts. See `@adcp/sdk/server/decisioning` ' +
        'for `getDecisioningTaskRegistryMigration()` — run it once against your DB.\n' +
        '  2. Pass `taskRegistry: createInMemoryTaskRegistry()` explicitly if you ' +
        'accept that in-flight tasks are lost on process restart. The explicit ' +
        'pass-in is the contract — saying "yes I want in-memory in production" ' +
        'in code is the right shape.\n' +
        '  3. ADCP_DECISIONING_ALLOW_INMEMORY_TASKS=1 env flag is the ops escape ' +
        'hatch (same effect as #2 but config-only); prefer #2 in adopter code.'
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
 * Mid-request token refresh hook config (#1145 Gap 2). When `refresh.fn`
 * is defined and the platform method throws `AdcpError({ code: 'AUTH_REQUIRED' })`,
 * `projectSync` refreshes the account's token via the hook, mutates
 * `account.authInfo.token`, and retries the platform method ONCE. If the
 * refresh hook itself throws, projects to `AUTH_REQUIRED` with
 * `recovery: 'correctable'` so the buyer re-links via their UI flow.
 *
 * Parameterized over `TCtxMeta` (#1168) so adopters' refresh hooks see
 * typed `account.ctx_metadata` rather than `unknown`. Default `unknown`
 * preserves backward compat for call sites that don't thread the
 * adopter's metadata shape through.
 */
interface RefreshConfig<TCtxMeta = unknown> {
  account: Account<TCtxMeta>;
  fn?: (account: Account<TCtxMeta>, reason: 'auth_required') => Promise<{ token: string; expiresAt?: number }>;
}

/**
 * Run a platform method with reactive token refresh on `AUTH_REQUIRED`.
 * Without a refresh fn (or no `refresh` at all) this passes the call
 * through. With one, catches `AUTH_REQUIRED`, calls `refresh.fn`, mutates
 * `account.authInfo.token` (and `expiresAt` if returned), and retries the
 * inner call exactly once.
 *
 * Failure modes:
 *   - Refresh hook throws → re-throw `AUTH_REQUIRED` with `recovery: 'correctable'`
 *     so the buyer re-links via their UI.
 *   - Retried call throws `AUTH_REQUIRED` again → bubble out (don't refresh
 *     a second time).
 */
async function runWithTokenRefresh<TCtxMeta, T>(
  fn: () => Promise<T>,
  refresh: RefreshConfig<TCtxMeta> | undefined
): Promise<T> {
  if (!refresh?.fn) return fn();
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof AdcpError) || err.code !== 'AUTH_REQUIRED') {
      throw err;
    }
    let refreshed: { token: string; expiresAt?: number };
    try {
      refreshed = await refresh.fn(refresh.account, 'auth_required');
    } catch {
      // Refresh-fn exception text is intentionally NOT echoed on the wire
      // — upstream identity-provider error messages routinely embed
      // refresh-token prefixes, internal hostnames, OAuth provider error
      // codes, and stack-trace fragments. Adopters log details server-
      // side; the buyer gets a fixed message + correctable recovery
      // signaling they need to re-authorize.
      throw new AdcpError('AUTH_REQUIRED', {
        message: 'Token refresh failed; re-authentication required',
        recovery: 'correctable',
      });
    }
    // `authInfo` became optional in #1286. Token refresh only fires after an
    // AUTH_REQUIRED throw — meaning an upstream call attempted to use a
    // token, which means `authInfo` was populated before the throw.
    // Defensive guard: if for some reason it isn't, the refreshed token
    // still flows on the next request rather than crashing here.
    if (refresh.account.authInfo) {
      refresh.account.authInfo.token = refreshed.token;
      if (refreshed.expiresAt !== undefined) {
        refresh.account.authInfo.expiresAt = refreshed.expiresAt;
      }
    }
    return fn();
  }
}

/**
 * Project a sync platform call onto the wire dispatch shape. `AdcpError`
 * throws → wire `adcp_error` envelope; other thrown errors bubble to the
 * framework's `SERVICE_UNAVAILABLE` mapping.
 *
 * When `refresh` is provided and the call throws `AUTH_REQUIRED`, the
 * framework calls `refresh.fn(refresh.account, 'auth_required')`, updates
 * `account.authInfo.token`, and retries the platform method once.
 */
async function projectSync<TResult, TWire, TCtxMeta = unknown>(
  fn: () => Promise<TResult>,
  mapResult: (r: TResult) => TWire,
  refresh?: RefreshConfig<TCtxMeta>
): Promise<TWire | AdcpErrorResponse> {
  try {
    const result = await runWithTokenRefresh(fn, refresh);
    const wire = mapResult(result as TResult);
    // Single-chokepoint runtime strip: ctx_metadata MUST NEVER cross to the
    // buyer. Defense-in-depth (compile-time WireShape<T> + runtime walk).
    // Mutates `wire` in place — every handler builds a fresh response per
    // call so mutation is safe. Runs BEFORE the framework wraps in envelope
    // / caches in idempotency, so cached replays stay clean too.
    if (wire != null && typeof wire === 'object') {
      stripCtxMetadata(wire as Record<string, unknown>);
    }
    return wire;
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
    // AccountNotFoundError is documented as throwable only from
    // AccountStore.resolve(); but adopters new to the framework
    // sometimes throw it from a specialism method body. Project to
    // ACCOUNT_NOT_FOUND so the wire envelope is right either way —
    // closes the silent-SERVICE_UNAVAILABLE foot-gun the security
    // review flagged. Adopters are still encouraged to handle account
    // not-found inside resolve() (canonical) — this is a guardrail.
    if (err instanceof AccountNotFoundError) {
      return adcpError('ACCOUNT_NOT_FOUND', {
        message: 'Account not found',
        field: 'account',
      });
    }
    throw err;
  }
}

/**
 * HITL dispatch: allocate task, return submitted envelope to buyer
 * immediately, run the handoff function in background. Method's return
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
  /**
   * Auto-emit a completion webhook on the sync-success arm too — see
   * `CreateAdcpServerFromPlatformOptions.autoEmitCompletionWebhooks`.
   * `routeIfHandoff` consults this when the platform returns a sync
   * Success (not a TaskHandoff). Threaded from per-handler call sites
   * so each tool's dispatcher reads the constructor flag once.
   */
  autoEmitCompletion?: boolean;
}

/**
 * Route a unified-shape return value: if it's a `TaskHandoff` marker,
 * dispatch through `dispatchHitl`; otherwise pass through the sync
 * projection.
 *
 * Adopter return type is `Success | TaskHandoff<Success>`. Each
 * specialism dispatcher uses this helper so all three call sites
 * (`createMediaBuy`, `sales.syncCreatives`, `creative.syncCreatives`)
 * route through a single seam — closes round-6 CR-1 (drift across
 * three near-identical `isTaskHandoff` branches).
 *
 * `project` shapes both arms identically — for `syncCreatives`,
 * `rows → { creatives: rows }`; for `createMediaBuy`, identity.
 */
async function routeIfHandoff<TInner, TWire>(
  taskRegistry: TaskRegistry,
  opts: DispatchHitlOpts,
  result: TInner | TaskHandoff<TInner>,
  project: (inner: TInner) => TWire
): Promise<TWire | SubmittedEnvelope> {
  if (isTaskHandoff<TInner>(result)) {
    const taskFn = _extractTaskFn(result);
    if (!taskFn) {
      // Forgery — adopter constructed something with the brand symbol
      // but didn't go through ctx.handoffToTask. Treat as a sync
      // success arm with an empty body (caller-supplied projection
      // shapes the result; this branch is defensive).
      return project(result as unknown as TInner);
    }
    return dispatchHitl(taskRegistry, opts, async taskId => {
      const inner = await taskFn(buildHandoffContext(taskRegistry, taskId));
      return project(inner);
    });
  }
  // Catch the most common LLM-scaffolded mistake: hand-rolling a
  // `{status: 'submitted', task_id: '...'}` envelope instead of returning
  // `ctx.handoffToTask(fn)`. The framework owns the submitted envelope —
  // adopters either return the sync-success arm or a TaskHandoff marker.
  // A bare submitted-shape return here would slip past dispatch and fail
  // response-schema validation downstream with a generic shape error;
  // pointing at the right SDK primitive up-front saves the debug round-trip.
  if (
    result != null &&
    typeof result === 'object' &&
    (result as { status?: unknown }).status === 'submitted' &&
    'task_id' in (result as object)
  ) {
    throw new Error(
      `Specialism handler returned a hand-rolled \`{status: 'submitted', task_id}\` ` +
        `envelope. The framework owns the submitted envelope — return ` +
        `\`ctx.handoffToTask(async (taskCtx) => { ... })\` from the handler ` +
        `and the framework will issue the task_id, persist the handoff, and ` +
        `wrap the wire envelope. Returning a bare submitted shape skips the ` +
        `task registry and the buyer ends up polling a task_id the framework ` +
        `never registered.`
    );
  }
  const projected = project(result);
  if (opts.autoEmitCompletion === true && opts.pushNotificationUrl) {
    // Auto-emit completion webhook on sync-success arm — fire-and-forget.
    // Awaiting inline would let an attacker-controlled
    // `push_notification_config.url` (e.g., a slowloris receiver) hold
    // the seller's request worker for the full retry budget — minutes-
    // to-tens-of-minutes per call, by spec-conformant payload. The buyer
    // already has the result inline; webhook delivery is purely a
    // notification convenience and shares the SPEC_WEBHOOK_TASK_TYPES
    // gate with the HITL path. Errors land on the framework logger and
    // the `onWebhookEmit` observability hook for operator alerting.
    void emitSyncCompletionWebhook(opts, projected).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      opts.logger.warn(`[adcp/decisioning] sync completion webhook background-error: ${msg}`);
    });
  }
  return projected;
}

/**
 * Auto-fire the post-success webhook for the sync arm of a mutating
 * tool. Mirrors `emitTaskWebhook` (HITL path) but synthesizes a
 * `task_id` since sync responses don't allocate a registry task.
 * Buyers correlate via the resource IDs embedded in `result`
 * (`media_buy_id`, `creative_id`, etc.) — `task_id` is informational
 * for the spec's required-field shape.
 *
 * Webhook delivery failures are logged-and-swallowed: the sync
 * response succeeded and the buyer has the result inline, so blocking
 * the response on a flaky webhook receiver would be strictly worse
 * than the buyer eventually polling.
 */
async function emitSyncCompletionWebhook(opts: DispatchHitlOpts, result: unknown): Promise<void> {
  if (!opts.emitWebhook || !opts.pushNotificationUrl) return;
  if (!SPEC_WEBHOOK_TASK_TYPES.has(opts.tool)) {
    opts.logger.warn(
      `[adcp/decisioning] sync completion webhook for ${opts.tool} skipped — ` +
        `tool not in spec task-type enum (closed 20-value set per enums/task-type.json). ` +
        `Use publishStatusChange for long-running ${opts.tool} state.`
    );
    return;
  }
  const taskId = `sync-${randomUUID()}`;
  const wirePayload = buildTaskWebhookPayload(opts, taskId, 'completed', { result });
  const start = Date.now();
  let success = false;
  let errorMessages: string[] | undefined;
  let errorCode: string | undefined;
  try {
    const r = await opts.emitWebhook({
      url: opts.pushNotificationUrl,
      payload: wirePayload,
      operation_id: `${opts.tool}.${taskId}`,
    });
    success = r?.delivered === true;
    if (r && Array.isArray(r.errors) && r.errors.length > 0) {
      errorMessages = r.errors;
      errorCode = bucketWebhookError(r.errors[0] ?? '');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errorMessages = [msg];
    errorCode = bucketWebhookError(msg);
    opts.logger.warn(`[adcp/decisioning] sync completion webhook for ${opts.tool} failed: ${msg}`);
  } finally {
    safeFire(
      opts.observability?.onWebhookEmit,
      {
        taskId,
        tool: opts.tool,
        status: 'completed' as const,
        url: opts.pushNotificationUrl,
        success,
        durationMs: Date.now() - start,
        ...(errorCode && { errorCode }),
        ...(errorMessages && { errorMessages }),
      },
      'onWebhookEmit',
      opts.logger
    );
  }
}

async function dispatchHitl<TResult>(
  taskRegistry: TaskRegistry,
  opts: DispatchHitlOpts,
  taskFn: (taskId: string) => Promise<TResult>
): Promise<SubmittedEnvelope> {
  const createStart = Date.now();
  const { taskId } = await taskRegistry.create({
    tool: opts.tool,
    accountId: opts.accountId,
    hasWebhook: opts.pushNotificationUrl !== undefined,
  });
  safeFire(
    opts.observability?.onTaskCreate,
    {
      tool: opts.tool,
      taskId,
      accountId: opts.accountId,
      durationMs: Date.now() - createStart,
    },
    'onTaskCreate',
    opts.logger
  );
  const taskStart = Date.now();

  // Single helper for the four `onTaskTransition` fire sites.
  const fireTransition = (status: 'completed' | 'failed', errorCode?: string): void => {
    safeFire(
      opts.observability?.onTaskTransition,
      {
        taskId,
        tool: opts.tool,
        accountId: opts.accountId,
        status,
        durationMs: Date.now() - taskStart,
        ...(errorCode !== undefined && { errorCode }),
      },
      'onTaskTransition',
      opts.logger
    );
  };

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
        fireTransition('failed', 'REGISTRY_WRITE_FAILED');
        return;
      }
      fireTransition('completed');
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
      fireTransition('failed', 'REGISTRY_WRITE_FAILED');
      return;
    }
    fireTransition('failed', structured.code);
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
  // Spec doesn't define a wire field name for the echoed token. Buyers
  // pass `push_notification_config.token` on the request; we echo it back
  // under the same name `token` so receivers verifying via the request
  // field can find it. (Earlier preview drops named this `validation_token`
  // — that wasn't spec-aligned and won't be picked up by buyers wiring
  // against the spec request shape.)
  if (opts.pushNotificationToken !== undefined) {
    payload.token = opts.pushNotificationToken;
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

// `protocolForTool` and `SPEC_WEBHOOK_TASK_TYPES` are exported from
// `protocol-for-tool.ts` — see import at top of file.

async function emitTaskWebhook(
  opts: DispatchHitlOpts,
  source: { task: { task_id: string; status: 'completed' | 'failed'; result?: unknown; error?: AdcpStructuredError } }
): Promise<void> {
  if (!opts.emitWebhook || !opts.pushNotificationUrl) return;
  const taskId = source.task.task_id;
  // Spec gate: `enums/task-type.json` is a closed 20-value enum at AdCP
  // 3.0 GA. Spec-validating receivers reject envelopes with a non-spec
  // `task_type` value. The framework dispatches a wider tool surface
  // than the spec-listed task types — for those, skip webhook delivery
  // (adopters surface long-running state via `publishStatusChange`
  // instead). Tracking spec issue to widen the enum.
  if (!SPEC_WEBHOOK_TASK_TYPES.has(opts.tool)) {
    opts.logger.warn(
      `[adcp/decisioning] task webhook for ${taskId} (${opts.tool}) skipped — ` +
        `tool not in spec task-type enum (closed 20-value set per enums/task-type.json). ` +
        `Use publishStatusChange for long-running ${opts.tool} state.`
    );
    return;
  }
  const wirePayload = buildTaskWebhookPayload(opts, taskId, source.task.status, {
    ...(source.task.result !== undefined && { result: source.task.result }),
    ...(source.task.error !== undefined && { error: source.task.error }),
  });
  const start = Date.now();
  let success = false;
  let errorMessages: string[] | undefined;
  let errorCode: string | undefined;
  try {
    const result = await opts.emitWebhook({
      url: opts.pushNotificationUrl,
      payload: wirePayload,
      operation_id: `${opts.tool}.${taskId}`,
    });
    success = result?.delivered === true;
    if (result && Array.isArray(result.errors) && result.errors.length > 0) {
      errorMessages = result.errors;
      errorCode = bucketWebhookError(result.errors[0] ?? '');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errorMessages = [msg];
    errorCode = bucketWebhookError(msg);
    // Webhook failures don't fail the task — registry already records the
    // terminal state. URL redacted from log to avoid leaking buyer-supplied
    // attacker-controllable values into operator log aggregators.
    opts.logger.warn(
      `[adcp/decisioning] task webhook for ${taskId} (${opts.tool}, status=${source.task.status}) ` + `failed: ${msg}`
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
        ...(errorCode && { errorCode }),
        ...(errorMessages && { errorMessages }),
      },
      'onWebhookEmit',
      opts.logger
    );
  }
}

/**
 * Bucket a free-text webhook error into a metric-tag-safe code. Matches
 * `DecisioningObservabilityHooks.onWebhookEmit.errorCode` documented enum
 * (`'TIMEOUT'`, `'CONNECTION_REFUSED'`, `'HTTP_4XX'`, `'HTTP_5XX'`,
 * `'SIGNATURE_FAILURE'`, `'UNKNOWN'`). Adopters tag DD/Prom by the bucket;
 * `errorMessages` carries the raw text for log adopters.
 */
function bucketWebhookError(msg: string): string {
  const lower = msg.toLowerCase();
  if (lower.includes('timeout') || lower.includes('etimedout')) return 'TIMEOUT';
  if (lower.includes('econnrefused') || lower.includes('connection refused')) return 'CONNECTION_REFUSED';
  if (lower.includes('signature') || lower.includes('rfc 9421')) return 'SIGNATURE_FAILURE';
  // Find ALL 3-digit HTTP-status-shaped tokens. Take the LARGEST one —
  // operator triage cares about the most-severe status, not the
  // left-most occurrence. Fixes "upstream 502 (proxy received 401)"
  // which would mis-bucket as HTTP_4XX under a first-match policy.
  const matches = lower.match(/\b[45]\d\d\b/g);
  if (matches && matches.length > 0) {
    const codes = matches.map(m => parseInt(m, 10));
    const max = Math.max(...codes);
    return max >= 500 ? 'HTTP_5XX' : 'HTTP_4XX';
  }
  return 'UNKNOWN';
}

// ---------------------------------------------------------------------------
// Specialism → handler-map adapters
// ---------------------------------------------------------------------------

/**
 * Per-server `ctxFor` builder. `createAdcpServerFromPlatform` constructs
 * one closure per server (capturing `opts.ctxMetadata` if wired) and
 * threads it into each handler-builder. Handler bodies invoke `ctxFor(ctx)`
 * at request time to derive the per-call `RequestContext`.
 */
type CtxForFn = (handlerCtx: HandlerContext<Account>) => RequestContext<Account>;

function makeCtxFor(ctxMetadataStore?: CtxMetadataStore): CtxForFn {
  return handlerCtx => buildRequestContext(handlerCtx, ctxMetadataStore);
}

/**
 * Project a framework `HandlerContext` / `RequestContext` to the public
 * `ResolveContext` shape passed to every `AccountStore` method
 * (`resolve`, `upsert`, `list`, `reportUsage`, `getAccountFinancials`).
 *
 * Single source of truth for the threading shape: when `ResolveContext`
 * gains a new field, update this function and every account-method call
 * site picks it up. The alternative (inline literals at each call site)
 * is what produced the original asymmetric `agent` gap on `reportUsage`
 * and `getAccountFinancials` — fixed by routing all six framework call
 * sites through here.
 *
 * `toolName` is supplied per call site (handlers hardcode their tool
 * name; the dispatcher's `resolveAccount` / `resolveAccountFromAuth`
 * paths read it off `RequestContext.toolName`). Spread guards keep
 * `authInfo` / `agent` keys absent rather than `undefined` — adopters
 * can use `'authInfo' in ctx` as a presence check.
 */
function toResolveCtx(ctx: { authInfo?: ResolvedAuthInfo; agent?: BuyerAgent }, toolName: string): ResolveContext {
  return {
    ...(ctx.authInfo !== undefined && { authInfo: ctx.authInfo }),
    toolName,
    ...(ctx.agent != null && { agent: ctx.agent }),
  };
}

/**
 * Auto-store helper. After a publisher returns resources from a discovery
 * tool (`getProducts`, `getMediaBuys`, etc.), persist each resource's wire
 * shape (minus `ctx_metadata`) alongside the publisher's `ctx_metadata`
 * blob. Subsequent calls referencing the same id by string can be hydrated
 * (publisher sees the full resource as `req.packages[i].product`).
 *
 * Failures are logged + swallowed — auto-store must NEVER break a
 * successful response.
 */
async function autoStoreResources(
  store: CtxMetadataStore | undefined,
  accountId: string | undefined,
  kind: ResourceKind,
  resources: readonly unknown[] | undefined,
  idField: string,
  logger: AdcpLogger
): Promise<void> {
  if (!store || !accountId || !resources) return;
  let skippedMissingId = 0;
  for (const r of resources) {
    if (r == null || typeof r !== 'object') continue;
    const obj = r as Record<string, unknown>;
    const id = obj[idField];
    if (typeof id !== 'string' || id.length === 0) {
      // The id field is wire-required on every resource the framework
      // auto-stores (e.g. `signal_agent_segment_id` on a signal,
      // `product_id` on a product). Silently skipping leaves buyers with
      // no way to reference the resource on a downstream mutating call —
      // a strong indicator the handler returned a misshaped response.
      skippedMissingId++;
      continue;
    }
    const ctxMeta = obj['ctx_metadata'];
    // Strip ctx_metadata from the resource before storing — round-trip
    // restores it on hydration. Keeping a pristine wire copy in `resource`.
    const { ctx_metadata: _stripped, ...wireResource } = obj as Record<string, unknown>;
    void _stripped;
    try {
      // Use `setResource` (not `setEntry`) so a publisher's prior
      // `ctx.ctxMetadata.set(kind, id, blob)` is preserved when the
      // publisher returns the resource WITHOUT `ctx_metadata` inline.
      // Auto-store should never clobber adopter-managed state.
      await store.setResource(accountId, kind, id, wireResource, ctxMeta);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[adcp/decisioning] auto-store ${kind} ${id} failed: ${msg}`);
    }
  }
  if (skippedMissingId > 0) {
    logger.warn(
      `[adcp/decisioning] auto-store skipped ${skippedMissingId} ${kind} ` +
        `record(s) missing required '${idField}' — buyers will not be able ` +
        `to reference these resources on a subsequent mutating call.`
    );
  }
}

/**
 * Auto-hydrate helper. Before invoking a publisher's mutating handler,
 * walk the request's resource references and attach the full wire
 * resource (including `ctx_metadata`) to each. Mutates the request in
 * place — adds an extra typed field alongside the original id.
 *
 * For `createMediaBuy`: walks `req.packages`, hydrates each with
 * `pkg.product = { ...resource, ctx_metadata }` keyed by `pkg.product_id`.
 *
 * Failures are logged + swallowed; the publisher still receives the
 * un-hydrated request and can fall back to its own DB.
 */
async function hydratePackagesWithProducts(
  store: CtxMetadataStore | undefined,
  accountId: string | undefined,
  packages: unknown[] | undefined,
  logger: AdcpLogger
): Promise<void> {
  if (!store || !accountId || !packages || packages.length === 0) return;
  const refs: Array<{ kind: 'product'; id: string }> = [];
  for (const pkg of packages) {
    if (pkg == null || typeof pkg !== 'object') continue;
    const productId = (pkg as Record<string, unknown>)['product_id'];
    if (typeof productId === 'string' && productId.length > 0) {
      refs.push({ kind: 'product', id: productId });
    }
  }
  if (refs.length === 0) return;
  let entries: ReadonlyMap<string, { value: unknown; resource?: unknown }>;
  try {
    entries = await store.bulkGetEntries(accountId, refs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[adcp/decisioning] auto-hydrate bulkGet failed: ${msg}`);
    return;
  }
  for (const pkg of packages) {
    if (pkg == null || typeof pkg !== 'object') continue;
    const productId = (pkg as Record<string, unknown>)['product_id'];
    if (typeof productId !== 'string') continue;
    const entry = entries.get(`product:${productId}`);
    if (!entry?.resource || typeof entry.resource !== 'object') continue;
    const hydrated: Record<string, unknown> = { ...(entry.resource as Record<string, unknown>) };
    if (entry.value !== null && entry.value !== undefined) {
      hydrated['ctx_metadata'] = entry.value;
    }
    Object.defineProperty(hydrated, '__adcp_hydrated__', {
      value: true,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    // Non-enumerable: see hydrateSingleResource for rationale (no leak via
    // JSON.stringify / spread / Object.entries; direct access works).
    Object.defineProperty(pkg, 'product', {
      value: hydrated,
      enumerable: false,
      writable: true,
      configurable: true,
    });
  }
}

/**
 * Auto-hydrate one resource referenced by id at the top level of a request.
 *
 * Generalization of {@link hydratePackagesWithProducts} for verbs whose
 * primary resource lives directly on the request body (`update_media_buy`,
 * `provide_performance_feedback`, `activate_signal`, `acquire_rights`).
 * Walks the store for `(kind, id)`, attaches `target[attachField] =
 * { ...resource, ctx_metadata }` when the entry has a wire resource.
 *
 * ## Error contract on missing references
 *
 * **Misses are silent. The handler runs anyway with `target[attachField]`
 * undefined.** This is deliberate — the framework cache is a *hint*, not
 * the source of truth. A miss can mean any of:
 *
 *   1. The buyer never called the discovery verb in this session (cold
 *      start, fresh tenant). Hydration is purely additive context; the
 *      publisher's own DB is authoritative for whether the id exists.
 *   2. The cache evicted (TTL, LRU). Same: publisher's DB stays the
 *      source of truth.
 *   3. The buyer truly referenced an unknown id. The publisher SHOULD
 *      reject this — see the handler-side guard pattern below.
 *
 * Adopters who want strict existence checks (option 1: framework throws
 * `PRODUCT_NOT_FOUND` / `MEDIA_BUY_NOT_FOUND` and the handler never runs)
 * implement that check inside the handler:
 *
 * ```ts
 * updateMediaBuy: async (id, patch, ctx) => {
 *   // Hydration miss + DB miss = unknown to this seller.
 *   if (!patch.media_buy && !(await db.findMediaBuy(id))) {
 *     throw new MediaBuyNotFoundError({ message: `media_buy ${id} not found` });
 *   }
 *   // ...
 * }
 * ```
 *
 * The framework cannot distinguish (1)/(2) from (3) without consulting the
 * publisher's DB, which is exactly what the handler does. Erroring at the
 * framework layer would force every adopter to manage cache warmth or
 * pre-load every media_buy into the cache before serving traffic — wrong
 * default for a hint-based cache.
 *
 * ## Field semantics on the hydrated value
 *
 * The attached field is **non-enumerable** so accidental serialization
 * (`JSON.stringify(req)`, spread `{...req}`, `Object.entries(req)`)
 * doesn't leak the publisher's `ctx_metadata` blob into request-side audit
 * sinks. Direct property access (`req.media_buy.ctx_metadata`) still
 * works; the field is invisible only to enumeration-based serializers.
 *
 * Hydrated fields carry a `__adcp_hydrated__: true` non-enumerable marker
 * so handler authors and middleware can disambiguate "publisher passed it"
 * from "framework attached it" — the field is **advisory context only**;
 * the wire contract is defined by the spec request fields, not by what
 * the SDK happens to attach.
 *
 * Store-fetch failures (Postgres unavailable, etc.) are logged + swallowed.
 * Hydration must NEVER break a successful dispatch — same posture as a
 * cache miss.
 */
async function hydrateSingleResource(
  store: CtxMetadataStore | undefined,
  accountId: string | undefined,
  kind: ResourceKind,
  id: string | undefined,
  attachField: string,
  target: unknown,
  logger: AdcpLogger
): Promise<void> {
  if (!store || !accountId || !id || target == null || typeof target !== 'object') return;
  let entry: { value: unknown; resource?: unknown } | undefined;
  try {
    entry = await store.getEntry(accountId, kind, id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[adcp/decisioning] auto-hydrate ${kind}:${id} failed: ${msg}`);
    return;
  }
  if (!entry?.resource || typeof entry.resource !== 'object') return;
  const hydrated: Record<string, unknown> = { ...(entry.resource as Record<string, unknown>) };
  if (entry.value !== null && entry.value !== undefined) {
    hydrated['ctx_metadata'] = entry.value;
  }
  Object.defineProperty(hydrated, '__adcp_hydrated__', {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  // Attach as non-enumerable so JSON.stringify(req), spread {...req}, and
  // Object.entries(req) do NOT carry the publisher's ctx_metadata blob into
  // log lines, audit sinks, or replay payloads. Direct access (req.foo)
  // still works.
  Object.defineProperty(target, attachField, {
    value: hydrated,
    enumerable: false,
    writable: true,
    configurable: true,
  });
}

/**
 * Spec `x-entity` annotation → SDK `ResourceKind`. The SDK only hydrates
 * resource kinds it has a backing store for; unmapped entities (e.g.
 * `vendor_pricing_option`, `governance_plan`) are gracefully skipped.
 *
 * The annotation acts as a renaming-firewall: if the spec renames
 * `media_buy_id` → `mediabuy_id`, the `x-entity: "media_buy"` tag travels
 * with the field and the codegen step in `scripts/generate-entity-hydration.ts`
 * picks up the new field name automatically — no SDK code change required.
 *
 * Adding a new `ResourceKind` for hydration is a coordinated change: add
 * it to `ResourceKind` (in `ctx-metadata/store.ts`) and to this map.
 */
/** @internal Exported for the coverage test in `test/lib/x-entity-hydration.test.js`. */
export const ENTITY_TO_RESOURCE_KIND: Readonly<Record<string, ResourceKind>> = {
  media_buy: 'media_buy',
  package: 'package',
  creative: 'creative',
  audience: 'audience',
  // Spec quirk: `signal_activation_id` is a SEPARATE entity from `signal`
  // (per AdCP `core/x-entity-types.json` — the activation handle is
  // scoped to the issuing signals agent, not interchangeable with the
  // catalog's `signal_id`). The SDK collapses them onto the existing
  // `signal` ResourceKind for backward-compat: adopters already seed
  // the cache keyed by `signal_agent_segment_id` under `kind: 'signal'`.
  // Splitting `signal_activation` to its own ResourceKind would orphan
  // those entries. Tracked upstream — file an `adcp` issue if/when this
  // collapse causes confusion.
  signal_activation_id: 'signal',
  rights_grant: 'rights_grant',
  property_list: 'property_list',
  collection_list: 'collection_list',
  account: 'account',
  product: 'product',
};

/**
 * `x-entity` values the SDK does NOT hydrate today — graceful skip rather
 * than failure. Entries here are documented intentional skips so a future
 * code reader can distinguish "we forgot to map this" from "the SDK
 * doesn't model this kind."
 *
 * The codegen-derived `TOOL_ENTITY_FIELDS` map carries every `x-entity`
 * the spec emits on dispatchable tools (webhook-only payloads like
 * `creative_approval` are filtered out at codegen time); this allowlist
 * + `ENTITY_TO_RESOURCE_KIND` together must cover the full set,
 * enforced by a test (`test/lib/x-entity-hydration.test.js`) that
 * imports both.
 *
 * @internal Exported for the coverage test; not part of the public API.
 */
export const INTENTIONALLY_UNHYDRATED_ENTITIES: ReadonlySet<string> = new Set([
  'vendor_pricing_option', // Scoped to issuing vendor agent; adopters seed pricing context themselves.
  'governance_plan', // No SDK ResourceKind yet; campaign-governance follow-up.
  'governance_check', // Transient request envelope; not stored.
  'event_source', // No SDK ResourceKind yet.
  'si_session', // Session lifecycle owned by `SponsoredIntelligencePlatform`.
  'offering', // SI offering catalog; not stored as ctx-metadata.
  'rights_holder_brand', // Read-through `get_brand_identity`; not separately stored.
  'advertiser_brand', // Same as above.
]);

/**
 * Per-tool, per-field destination property name for hydrated resources.
 *
 * The hydrator's default is to derive the destination from the field name
 * by stripping the `_id` suffix (e.g. `media_buy_id` → attach as
 * `params.media_buy`). Three cases need explicit overrides because their
 * historical attach-fields don't match that convention — adopters already
 * read these in handler code and a rename would be wire-visible behavior:
 *
 *   - `acquire_rights.rights_id` → `params.rights` (NOT `rights_grant`).
 *     Predates the entity-driven hydrator. Kept for backward-compat.
 *   - `activate_signal.signal_agent_segment_id` → `params.signal`
 *     (NOT `signal_agent_segment` — `_id` suffix isn't on the boundary
 *     the convention strips).
 *   - `update_rights.rights_id` → `params.rights_grant` (NOT `rights`).
 *     Diverges from `acquire_rights`'s historical `params.rights` because
 *     the wire payloads model different things — acquire takes an
 *     offering selection, update modifies an existing grant.
 *
 * Other tools either follow the convention (`update_media_buy`,
 * `provide_performance_feedback`) or don't currently have hydration
 * registered (the unmapped `x-entity` skips above).
 */
const HYDRATION_ATTACH_FIELD_OVERRIDES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  acquire_rights: { rights_id: 'rights' },
  activate_signal: { signal_agent_segment_id: 'signal' },
  update_rights: { rights_id: 'rights_grant' },
};

function deriveAttachField(toolName: string, field: string): string {
  const override = HYDRATION_ATTACH_FIELD_OVERRIDES[toolName]?.[field];
  if (override) return override;
  // Default: strip the `_id` suffix so `media_buy_id` → `media_buy`,
  // `creative_id` → `creative`, etc. This is the convention every existing
  // hydration call site followed before the schema-driven refactor.
  return field.endsWith('_id') ? field.slice(0, -3) : field;
}

/**
 * Schema-driven auto-hydration for a tool's request payload.
 *
 * Walks the codegen-derived `TOOL_ENTITY_FIELDS` table for the named tool,
 * looks up each spec-tagged identifier on `params`, maps the `x-entity`
 * annotation to a `ResourceKind`, and attaches the resolved record at the
 * conventional destination field. Replaces the four hand-rolled
 * `hydrateSingleResource` call sites that hardcoded `(field_name, kind)`
 * pairs and were vulnerable to a silent break under a future spec rename
 * (protocol-expert review of #1086 → tracked as #1109).
 */
async function hydrateForTool(
  store: CtxMetadataStore | undefined,
  accountId: string | undefined,
  toolName: string,
  params: unknown,
  logger: AdcpLogger
): Promise<void> {
  if (!store || !accountId || params == null || typeof params !== 'object') return;
  const fields = TOOL_ENTITY_FIELDS[toolName];
  if (!fields || fields.length === 0) return;
  const paramsRecord = params as Record<string, unknown>;
  for (const { field, xEntity } of fields) {
    const id = paramsRecord[field];
    if (typeof id !== 'string' || id.length === 0) continue;
    const kind = ENTITY_TO_RESOURCE_KIND[xEntity];
    if (!kind) continue; // Unknown entity — graceful skip; don't break unknown verbs.
    const attachField = deriveAttachField(toolName, field);
    await hydrateSingleResource(store, accountId, kind, id, attachField, params, logger);
  }
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
 * **DNS rebinding caveat.** This validator only inspects the literal
 * hostname/IP in the URL. A buyer registers `https://rebind.attacker.com/`
 * whose A-record returns `8.8.8.8` at validate time and `127.0.0.1` /
 * `169.254.169.254` at fetch time bypasses this layer. The framework's
 * own `serve({ webhooks })`-wired emitter (RFC 9421-signed delivery via
 * `WebhookManager`) re-resolves the host at fetch time and DOES NOT
 * pin-and-bind to the validate-time IP. Adopters wiring a custom
 * `taskWebhookEmitter` SHOULD pin the resolved IP at validate time and
 * connect to that specific IP, OR run all webhook delivery through a
 * forward proxy with an egress allowlist. Tracking issue:
 * `adcp-client#TBD` for framework-side pin-and-bind.
 *
 * On rejection, throws `AdcpError('INVALID_REQUEST', { field })` so the
 * buyer sees the bad config at the request boundary. Previous silent-skip
 * posture lost buyer visibility.
 */
function extractPushConfig(
  params: unknown,
  _logger: AdcpLogger,
  opts: { allowPrivateWebhookUrls?: boolean } = {}
): { url?: string; token?: string } {
  if (!params || typeof params !== 'object') return {};
  const cfg = (params as { push_notification_config?: unknown }).push_notification_config;
  if (!cfg || typeof cfg !== 'object') return {};
  const rawUrl = (cfg as { url?: unknown }).url;
  const rawToken = (cfg as { token?: unknown }).token;

  let url: string | undefined;
  if (typeof rawUrl === 'string') {
    const validation = validatePushNotificationUrl(rawUrl, { allowPrivate: opts.allowPrivateWebhookUrls === true });
    if (!validation.ok) {
      // Fail fast: buyers thought they wired push and never saw it under
      // the previous silent-skip posture. Rejecting upfront with
      // `INVALID_REQUEST` and `field: 'push_notification_config.url'`
      // surfaces the problem at the request boundary so buyers can fix
      // their config before relying on webhooks. Buyers can still poll
      // via `tasks_get` if they need a fallback path.
      throw new AdcpError('INVALID_REQUEST', {
        message: `push_notification_config.url rejected: ${validation.reason}`,
        field: 'push_notification_config.url',
      });
    }
    url = rawUrl;
  }

  let token: string | undefined;
  if (typeof rawToken === 'string') {
    const validation = validatePushNotificationToken(rawToken);
    if (!validation.ok) {
      throw new AdcpError('INVALID_REQUEST', {
        message: `push_notification_config.token rejected: ${validation.reason}`,
        field: 'push_notification_config.token',
      });
    }
    token = rawToken;
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

function validatePushNotificationUrl(rawUrl: string, opts: { allowPrivate?: boolean } = {}): UrlValidationResult {
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
    return {
      ok: false,
      reason: 'http:// scheme not allowed (use https:// or set ADCP_DECISIONING_ALLOW_HTTP_WEBHOOKS=1)',
    };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `unsupported scheme "${parsed.protocol}" (only http: / https:)` };
  }

  // Adopter-set flag bypasses ONLY the private-IP / loopback rejection.
  // Malformed-URL and scheme checks above always fire — the relaxation
  // is scoped to "let sandbox webhook receivers bind to loopback" not
  // "trust everything." See CreateAdcpServerFromPlatformOptions.
  if (opts.allowPrivate === true) {
    return { ok: true };
  }

  // Node's `URL.hostname` returns IPv6 literals WITH brackets — so
  // `https://[::1]/` yields `[::1]`. Strip them so our IPv6 checks below
  // can match the unbracketed form. (`URL.host` includes the port, which
  // we don't want here.)
  let host = parsed.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }
  if (host === '' || host === 'localhost' || host === '0') {
    return { ok: false, reason: `host "${host}" rejected (loopback / unspecified)` };
  }

  // Note on IPv4 alternate forms (integer `2130706433`, hex `0x7f000001`,
  // octal `0177.0.0.1`): Node's WHATWG URL parser canonicalizes all of
  // these to dotted-decimal before we see `parsed.hostname`. So
  // `https://2130706433/` arrives here with host `127.0.0.1` and falls
  // through to the dotted-decimal range check below. Defense-in-depth
  // alternate-form regex rejectors are not needed at this layer.

  // IPv4 dotted-decimal check
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

  // IPv6 literal check — Node strips brackets so we match unbracketed forms.
  // A hostname containing `:` is an IPv6 literal (DNS hostnames disallow `:`).
  if (host.includes(':')) {
    // Loopback + unspecified — exact match
    if (host === '::1') return { ok: false, reason: 'IPv6 loopback ::1 rejected' };
    if (host === '::') return { ok: false, reason: 'IPv6 unspecified :: rejected' };
    // Link-local fe80::/10 — match strict prefix `fe80:` (not just `fe80`)
    if (host.startsWith('fe80:')) {
      return { ok: false, reason: 'IPv6 link-local fe80::/10 rejected' };
    }
    // Unique-local fc00::/7 — match strict prefix `fc` or `fd` followed
    // by exactly one more hex char (so fc00:, fcab:, fd00:, fdef:) and
    // then `:`. Old check `host.startsWith('fc')` would match the
    // hostname-not-IP `fc-cdn.example.com`; since IPv6 hostnames always
    // contain `:`, restrict to literals where char[2] is hex + `:`.
    if (/^f[cd][0-9a-f]{2}:/.test(host)) {
      return { ok: false, reason: 'IPv6 unique-local fc00::/7 rejected' };
    }
    // IPv4-mapped IPv6 — `::ffff:127.0.0.1` or `::ffff:7f00:0001`. Either
    // form: extract the embedded IPv4 (if dotted) or the last 32 bits and
    // re-run the IPv4 range checks. Simpler: reject any `::ffff:` prefix
    // pointing to a private IPv4 by recursive validation.
    const v4MappedMatch = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (v4MappedMatch) {
      const inner = v4MappedMatch[1];
      const innerCheck = validatePushNotificationUrl(`http://${inner}/`);
      if (!innerCheck.ok) {
        return { ok: false, reason: `IPv4-mapped IPv6 ${host}: ${innerCheck.reason}` };
      }
    }
    // Hex IPv4-mapped form (`::ffff:7f00:0001`): match the 32-bit
    // suffix and convert to dotted form for re-check.
    const v4MappedHexMatch = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (v4MappedHexMatch) {
      const high = parseInt(v4MappedHexMatch[1]!, 16);
      const low = parseInt(v4MappedHexMatch[2]!, 16);
      const dotted = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
      const innerCheck = validatePushNotificationUrl(`http://${dotted}/`);
      if (!innerCheck.ok) {
        return { ok: false, reason: `IPv4-mapped IPv6 ${host}: ${innerCheck.reason}` };
      }
    }
  }

  return { ok: true };
}

const TOKEN_MAX_LENGTH = 255;
const TOKEN_CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

function validatePushNotificationToken(token: string): UrlValidationResult {
  if (token.length === 0) {
    return { ok: false, reason: 'token is empty' };
  }
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
  logger: AdcpLogger,
  pushOpts: { allowPrivateWebhookUrls: boolean; autoEmitCompletionWebhooks: boolean },
  ctxFor: CtxForFn,
  ctxMetadataStore: CtxMetadataStore | undefined
): MediaBuyHandlers<Account> | undefined {
  const sales = platform.sales;
  if (!sales) return undefined;

  // Core lifecycle methods are optional on the SalesPlatform interface
  // (#1341) — the per-specialism mapping in `RequiredPlatformsFor<S>`
  // enforces "you claimed `sales-non-guaranteed`, therefore you must
  // implement getProducts" at the type level, while specialisms whose
  // upstream owns bidding (`sales-social`) skip them entirely. The
  // dispatcher mirrors that with conditional spreads — we don't register
  // a wire handler when the platform method is absent, so the merge seam
  // (`opts.mediaBuy.X`) can supply it OR the framework returns
  // `METHOD_NOT_FOUND` from `tools/list` for the unsupported tool.
  return {
    ...(sales.getProducts && {
      getProducts: async (params, ctx) => {
        const reqCtx = ctxFor(ctx);
        return projectSync(
          async () => {
            const result = await sales.getProducts!(params, reqCtx);
            // Auto-store products: persist each Product's wire shape +
            // ctx_metadata so subsequent createMediaBuy / updateMediaBuy
            // calls referencing product_id can hydrate the full Product
            // automatically (publisher sees `req.packages[i].product`).
            await autoStoreResources(
              ctxMetadataStore,
              reqCtx.account?.id,
              'product',
              (result as { products?: readonly unknown[] })?.products,
              'product_id',
              logger
            );
            return result;
          },
          r => r
        );
      },
    }),

    ...(sales.createMediaBuy && {
      createMediaBuy: async (params, ctx) => {
        const reqCtx = ctxFor(ctx);
        // Auto-hydrate: walk `params.packages`, attach the full Product object
        // (including `ctx_metadata`) at `pkg.product`. Publisher reads
        // `pkg.product.format_ids`, `pkg.product.ctx_metadata?.gam?.ad_unit_ids`
        // directly — no separate lookup, no boilerplate.
        await hydratePackagesWithProducts(
          ctxMetadataStore,
          reqCtx.account?.id,
          (params as { packages?: unknown[] })?.packages,
          logger
        );
        return projectSync(
          async () => {
            const push = extractPushConfig(params, logger, {
              allowPrivateWebhookUrls: pushOpts.allowPrivateWebhookUrls,
            });
            const result = await sales.createMediaBuy!(params, reqCtx);
            return routeIfHandoff(
              taskRegistry,
              {
                tool: 'create_media_buy',
                accountId: reqCtx.account.id,
                pushNotificationUrl: push.url,
                pushNotificationToken: push.token,
                emitWebhook: taskWebhookEmit ?? ctx.emitWebhook,
                autoEmitCompletion: pushOpts.autoEmitCompletionWebhooks,
                observability,
                logger,
              },
              result,
              r => r // identity projection for createMediaBuy
            );
          },
          r => r
        );
      },
    }),

    ...(sales.updateMediaBuy && {
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
          });
        }
        // Auto-hydrate: attach the full MediaBuy (wire shape + ctx_metadata)
        // at `req.media_buy`. Publisher reads `req.media_buy.ctx_metadata?.gam`
        // directly — no separate lookup. Misses are silent; publisher falls
        // back to its own DB. Schema-driven via `x-entity` (#1109).
        await hydrateForTool(ctxMetadataStore, reqCtx.account?.id, 'update_media_buy', params, logger);
        return projectSync(
          async () => {
            const push = extractPushConfig(params, logger, {
              allowPrivateWebhookUrls: pushOpts.allowPrivateWebhookUrls,
            });
            const result = await sales.updateMediaBuy!(media_buy_id, params, reqCtx);
            // F12 sync auto-emit. updateMediaBuy is sync-only on the
            // platform interface (no TaskHandoff arm — spec response
            // doesn't include Submitted), so we don't route through
            // routeIfHandoff. Fire-and-forget to keep slowloris webhook
            // receivers from blocking the sync response.
            if (pushOpts.autoEmitCompletionWebhooks && push.url) {
              const emitOpts = {
                tool: 'update_media_buy' as const,
                accountId: reqCtx.account.id,
                pushNotificationUrl: push.url,
                ...(push.token !== undefined && { pushNotificationToken: push.token }),
                emitWebhook: taskWebhookEmit ?? ctx.emitWebhook,
                ...(observability && { observability }),
                logger,
              };
              void emitSyncCompletionWebhook(emitOpts, result).catch((err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err);
                logger.warn(`[adcp/decisioning] sync completion webhook background-error: ${msg}`);
              });
            }
            return result;
          },
          r => r
        );
      },
    }),

    syncCreatives: async (params, ctx) => {
      const reqCtx = ctxFor(ctx);
      const creatives = params.creatives ?? [];
      if (!sales.syncCreatives) {
        return adcpError('UNSUPPORTED_FEATURE', {
          message: 'sync_creatives not supported by this sales platform',
        });
      }
      return projectSync(
        async () => {
          const push = extractPushConfig(params, logger, { allowPrivateWebhookUrls: pushOpts.allowPrivateWebhookUrls });
          const result = await sales.syncCreatives!(creatives, reqCtx);
          return routeIfHandoff(
            taskRegistry,
            {
              tool: 'sync_creatives',
              accountId: reqCtx.account.id,
              pushNotificationUrl: push.url,
              pushNotificationToken: push.token,
              emitWebhook: taskWebhookEmit ?? ctx.emitWebhook,
              autoEmitCompletion: pushOpts.autoEmitCompletionWebhooks,
              observability,
              logger,
            },
            result,
            rows => ({ creatives: rows.map(normalizeRowErrors) })
          );
        },
        r => r
      );
    },

    ...(sales.getMediaBuyDelivery && {
      getMediaBuyDelivery: async (params, ctx) => {
        const reqCtx = ctxFor(ctx);
        return projectSync(
          async () => {
            const result = await sales.getMediaBuyDelivery!(params, reqCtx);
            warnIfTruncatedMultiIdResponse(
              'getMediaBuyDelivery',
              (params as { media_buy_ids?: readonly string[] }).media_buy_ids,
              (result as { media_buy_deliveries?: readonly unknown[] })?.media_buy_deliveries,
              logger
            );
            return result;
          },
          actuals => actuals
        );
      },
    }),

    // Optional methods — return UNSUPPORTED_FEATURE when the platform omits
    // them. Adopters that haven't migrated to the v6 platform interface for
    // these specific tools can still pass raw handlers via opts.mediaBuy
    // (merge seam) — the merge runs AFTER buildMediaBuyHandlers, so opts
    // handlers fill in for the methods this platform omits.
    // `getMediaBuys` is REQUIRED at the type level, but we keep a runtime
    // guard for the merge-seam migration path: legacy adopters wire it via
    // `opts.mediaBuy.getMediaBuys` rather than on the platform interface.
    // Once the migration completes (every adopter implements it natively),
    // this conditional spreads can collapse — but for now, omitting the
    // platform-derived handler when absent lets `mergeHandlers` pick up the
    // adopter's custom handler from `opts.mediaBuy` instead of throwing
    // `sales.getMediaBuys is not a function`.
    ...(sales.getMediaBuys && {
      getMediaBuys: async (params, ctx) => {
        const reqCtx = ctxFor(ctx);
        return projectSync(
          async () => {
            const result = await sales.getMediaBuys!(params, reqCtx);
            warnIfTruncatedMultiIdResponse(
              'getMediaBuys',
              (params as { media_buy_ids?: readonly string[] }).media_buy_ids,
              (result as { media_buys?: readonly unknown[] })?.media_buys,
              logger
            );
            await autoStoreResources(
              ctxMetadataStore,
              reqCtx.account?.id,
              'media_buy',
              (result as { media_buys?: readonly unknown[] })?.media_buys,
              'media_buy_id',
              logger
            );
            return result;
          },
          r => r
        );
      },
    }),
    ...(sales.providePerformanceFeedback && {
      providePerformanceFeedback: async (params, ctx) => {
        const reqCtx = ctxFor(ctx);
        // Auto-hydrate `req.media_buy` from the prior createMediaBuy /
        // getMediaBuys store entry, plus `req.creative` when the buyer
        // scoped feedback to a specific creative, plus `req.package`
        // when scoped to a package. All three are optional hydration
        // targets — adopters who only care about the feedback payload
        // itself can ignore them. Schema-driven via `x-entity` (#1109);
        // package hydration is additive vs the prior hardcoded version
        // (silent no-op when packages aren't seeded).
        await hydrateForTool(ctxMetadataStore, reqCtx.account?.id, 'provide_performance_feedback', params, logger);
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

/**
 * Project an adopter `buildCreative` return value into the wire response
 * shape. Handles the four legal adopter shapes per `BuildCreativeReturn`:
 *
 *   - Already-shaped Single envelope (`creative_manifest` field present) →
 *     passthrough. Adopter set `sandbox` / `expires_at` / `preview` themselves.
 *   - Already-shaped Multi envelope (`creative_manifests` field present) →
 *     passthrough. Same metadata-controlled case for multi-format requests.
 *   - Bare array → wrap as `{ creative_manifests: <array> }` (multi, no metadata).
 *   - Plain `CreativeManifest` → wrap as `{ creative_manifest: <obj> }`
 *     (single, no metadata).
 *
 * The discriminator order matters: check shaped envelopes first so an
 * adopter that returned `{ creative_manifest, sandbox: true }` (a Single
 * envelope) doesn't get re-wrapped into
 * `{ creative_manifest: { creative_manifest, sandbox: true } }`. Same
 * concern applies symmetrically for Multi.
 */
function projectBuildCreativeReturn(ret: unknown): BuildCreativeSuccess | BuildCreativeMultiSuccess {
  if (ret != null && typeof ret === 'object' && !Array.isArray(ret)) {
    if ('creative_manifest' in ret) return ret as BuildCreativeSuccess;
    if ('creative_manifests' in ret) return ret as BuildCreativeMultiSuccess;
  }
  if (Array.isArray(ret)) {
    return { creative_manifests: ret as CreativeManifest[] };
  }
  return { creative_manifest: ret as CreativeManifest };
}

function buildCreativeHandlers<P extends DecisioningPlatform<any, any>>(
  platform: P,
  taskRegistry: TaskRegistry,
  taskWebhookEmit: NonNullable<HandlerContext<Account>['emitWebhook']> | undefined,
  observability: DecisioningObservabilityHooks | undefined,
  logger: AdcpLogger,
  pushOpts: { allowPrivateWebhookUrls: boolean; autoEmitCompletionWebhooks: boolean },
  ctxFor: CtxForFn
): CreativeHandlers<Account> | undefined {
  const creative = platform.creative;
  if (!creative) return undefined;

  return {
    buildCreative: async (params, ctx) => {
      const reqCtx = ctxFor(ctx);
      return projectSync(
        () => creative.buildCreative(params, reqCtx),
        ret => projectBuildCreativeReturn(ret)
      );
    },

    previewCreative: async (params, ctx) => {
      if (!('previewCreative' in creative) || (creative as CreativeBuilderPlatform).previewCreative == null) {
        return adcpError('UNSUPPORTED_FEATURE', {
          message:
            'preview_creative: this creative platform did not implement previewCreative. ' +
            'Add `previewCreative(req, ctx)` to your CreativeBuilderPlatform / CreativeAdServerPlatform literal.',
        });
      }
      const reqCtx = ctxFor(ctx);
      return projectSync(
        () => (creative as CreativeBuilderPlatform).previewCreative!(params, reqCtx),
        preview => preview
      );
    },

    // No-account tool — `list_creative_formats` request schema doesn't carry
    // `account`. The framework's `resolveAccountFromAuth` runs and accepts a
    // null return; the platform method receives `ctx.account` possibly
    // undefined per `NoAccountCtx`. Wired identically on both
    // `CreativeBuilderPlatform` and `CreativeAdServerPlatform`.
    listCreativeFormats: async (params, ctx) => {
      if (!('listCreativeFormats' in creative) || creative.listCreativeFormats == null) {
        return adcpError('UNSUPPORTED_FEATURE', {
          message:
            'list_creative_formats: this creative platform did not implement listCreativeFormats. ' +
            'Add `listCreativeFormats(req, ctx)` to your CreativeBuilderPlatform / CreativeAdServerPlatform literal, ' +
            'or delegate via `capabilities.creative_agents`.',
        });
      }
      const reqCtx = ctxFor(ctx);
      return projectSync(
        () => (creative as CreativeBuilderPlatform).listCreativeFormats!(params, reqCtx),
        r => r
      );
    },

    syncCreatives: async (params, ctx) => {
      const reqCtx = ctxFor(ctx);
      const creatives = params.creatives ?? [];
      if (!creative.syncCreatives) {
        return adcpError('UNSUPPORTED_FEATURE', {
          message: 'sync_creatives not supported by this creative platform',
        });
      }
      return projectSync(
        async () => {
          const push = extractPushConfig(params, logger, { allowPrivateWebhookUrls: pushOpts.allowPrivateWebhookUrls });
          const result = await creative.syncCreatives!(creatives, reqCtx);
          return routeIfHandoff(
            taskRegistry,
            {
              tool: 'sync_creatives',
              accountId: reqCtx.account.id,
              pushNotificationUrl: push.url,
              pushNotificationToken: push.token,
              emitWebhook: taskWebhookEmit ?? ctx.emitWebhook,
              autoEmitCompletion: pushOpts.autoEmitCompletionWebhooks,
              observability,
              logger,
            },
            result,
            rows => ({ creatives: rows.map(normalizeRowErrors) })
          );
        },
        r => r
      );
    },

    // Ad-server-specialism methods. Only the CreativeAdServerPlatform variant
    // implements these; framework returns UNSUPPORTED_FEATURE for the other
    // archetypes (template, generative).
    listCreatives: async (params, ctx) => {
      if (!('listCreatives' in creative)) {
        return adcpError('UNSUPPORTED_FEATURE', {
          message: 'list_creatives not supported by this platform',
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
  ctxFor: CtxForFn
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
  platform: P,
  ctxFor: CtxForFn,
  ctxMetadataStore: CtxMetadataStore | undefined,
  logger: AdcpLogger
): SignalsHandlers<Account> | undefined {
  const signals = platform.signals;
  if (!signals) return undefined;
  return {
    getSignals: async (params, ctx) => {
      const reqCtx = ctxFor(ctx);
      return projectSync(
        async () => {
          const result = await signals.getSignals(params, reqCtx);
          // Auto-store signals so subsequent activate_signal can hydrate
          // `req.signal` from the publisher's prior catalog entry.
          await autoStoreResources(
            ctxMetadataStore,
            reqCtx.account?.id,
            'signal',
            (result as { signals?: readonly unknown[] })?.signals,
            'signal_agent_segment_id',
            logger
          );
          return result;
        },
        r => r
      );
    },
    activateSignal: async (params, ctx) => {
      const reqCtx = ctxFor(ctx);
      // Auto-hydrate `req.signal` from the prior getSignals store entry —
      // publisher reads pricing options, agent segment id, ctx_metadata
      // directly without the buyer round-tripping the full signal object.
      // Schema-driven via `x-entity` (#1109): `signal_agent_segment_id`
      // carries `x-entity: "signal_activation_id"`, mapped to ResourceKind
      // `signal`; attached at `params.signal` per the override table.
      await hydrateForTool(ctxMetadataStore, reqCtx.account?.id, 'activate_signal', params, logger);
      return projectSync(
        () => signals.activateSignal(params, reqCtx),
        r => r
      );
    },
  };
}

function buildBrandRightsHandlers<P extends DecisioningPlatform<any, any>>(
  platform: P,
  ctxFor: CtxForFn,
  ctxMetadataStore: CtxMetadataStore | undefined,
  logger: AdcpLogger
): BrandRightsHandlers<Account> | undefined {
  const br = platform.brandRights;
  if (!br) return undefined;
  return {
    getBrandIdentity: async (params, ctx) => {
      const reqCtx = ctxFor(ctx);
      return projectSync(
        () => br.getBrandIdentity(params, reqCtx),
        r => r
      );
    },
    getRights: async (params, ctx) => {
      const reqCtx = ctxFor(ctx);
      return projectSync(
        async () => {
          const result = await br.getRights(params, reqCtx);
          // Auto-store rights offerings so subsequent acquire_rights can
          // hydrate `req.rights` (pricing_options + ctx_metadata) without
          // a separate publisher lookup.
          await autoStoreResources(
            ctxMetadataStore,
            reqCtx.account?.id,
            'rights_grant',
            (result as { rights?: readonly unknown[] })?.rights,
            'rights_id',
            logger
          );
          return result;
        },
        r => r
      );
    },
    // `acquire_rights` has 3 native wire-spec arms (Acquired / PendingApproval /
    // Rejected) handled by the platform directly. No framework task envelope —
    // adopters return the spec-defined arm. Async delivery for the
    // PendingApproval arm rides the buyer's `push_notification_config` webhook
    // (the spec doesn't define a polling tool for `acquire_rights`).
    acquireRights: async (params, ctx) => {
      const reqCtx = ctxFor(ctx);
      // Auto-hydrate `req.rights` from the prior getRights catalog entry.
      // Publisher reads selected pricing option + ctx_metadata directly.
      // Schema-driven via `x-entity` (#1109); destination field stays at
      // `params.rights` per the override table — historical, predates
      // the entity-driven hydrator and `updateRights`'s convention of
      // `params.rights_grant`. Adopters already read this field, so a
      // rename would be wire-visible behavior.
      await hydrateForTool(ctxMetadataStore, reqCtx.account?.id, 'acquire_rights', params, logger);
      return projectSync(
        () => br.acquireRights(params, reqCtx),
        r => r
      );
    },
    // `update_rights` modifies an existing grant. The framework hydrates
    // the grant record from `req.rights_id` so the implementation reads
    // the resolved state from `ctx.store` (or as `params.rights_grant`
    // — see field-name divergence note on `acquireRights` above; this
    // tool attaches under `rights_grant` because the wire payload has
    // no `rights` field). Schema-driven via `x-entity` (#1109). Async
    // delivery — when the change requires rights-holder counter-
    // signature — rides the buyer's `push_notification_config` webhook;
    // the immediate response carries `implementation_date: null` to
    // signal pending state.
    updateRights: async (params, ctx) => {
      const reqCtx = ctxFor(ctx);
      await hydrateForTool(ctxMetadataStore, reqCtx.account?.id, 'update_rights', params, logger);
      return projectSync(
        () => br.updateRights(params, reqCtx),
        r => r
      );
    },
  };
}

function buildGovernanceHandlers<P extends DecisioningPlatform<any, any>>(
  platform: P,
  ctxFor: CtxForFn
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

function buildAccountHandlers<P extends DecisioningPlatform<any, any>>(
  platform: P,
  ctxFor: CtxForFn
): AccountHandlers<Account> {
  const accounts = platform.accounts;

  // Only emit framework-derived handlers for methods the platform actually
  // implements. Emitting an UNSUPPORTED_FEATURE stub for an undefined
  // method shadows adopter-supplied `opts.accounts.{syncAccounts,listAccounts}`
  // fillers under the merge seam (platform-derived wins per-key), so the
  // adopter's working handler silently never runs. This pattern matches the
  // gating already used for `reportUsage` / `getAccountFinancials` below.
  // Adopters who claim sync_accounts / list_accounts capability without
  // implementing `accounts.upsert` / `accounts.list` AND without supplying a
  // merge-seam override get framework's "tool not registered" path —
  // closer to the truth than a fabricated UNSUPPORTED_FEATURE envelope.
  const handlers: AccountHandlers<Account> = {};

  if (accounts.upsert) {
    handlers.syncAccounts = async (params, ctx) => {
      const refs = (params.accounts ?? []) as AccountReference[];
      const resolveCtx = toResolveCtx(ctx, 'sync_accounts');
      return projectSync(
        () => accounts.upsert!(refs, resolveCtx),
        rows => ({ accounts: rows.map(toWireSyncAccountRow) })
      );
    };
  }

  if (accounts.list) {
    handlers.listAccounts = async (params, ctx) => {
      const filter = params as Parameters<NonNullable<typeof accounts.list>>[0];
      const resolveCtx = toResolveCtx(ctx, 'list_accounts');
      // Wrap in projectSync so adopter `throw new AdcpError('PERMISSION_DENIED', ...)`
      // from the list impl projects to the structured wire envelope rather
      // than falling through to the framework's `SERVICE_UNAVAILABLE` mapping.
      return projectSync(
        () => accounts.list!(filter, resolveCtx),
        page => ({
          accounts: page.items.map(toWireAccount),
          ...(page.nextCursor != null && { next_cursor: page.nextCursor }),
        })
      );
    };
  }

  if (accounts.reportUsage) {
    handlers.reportUsage = async (params, ctx) => {
      const resolveCtx = toResolveCtx(ctx, 'report_usage');
      return projectSync(
        () => accounts.reportUsage!(params, resolveCtx),
        r => r
      );
    };
  }

  if (accounts.getAccountFinancials) {
    handlers.getAccountFinancials = async (params, ctx) => {
      // Resolve the account first so `ctx.account` is populated when the
      // platform method runs. Adopters fronting an upstream platform read
      // tokens / upstream IDs off `ctx.account.ctx_metadata` without
      // having to re-resolve from `params.account`.
      const resolveCtx = toResolveCtx(ctx, 'get_account_financials');
      refuseImplicitAccountId(accounts.resolution, params.account);
      const resolved = await accounts.resolve(params.account, resolveCtx);
      if (!resolved) {
        throw new AdcpError('ACCOUNT_NOT_FOUND', {
          message: 'Account not found',
          recovery: 'terminal',
        });
      }
      const toolCtx = { ...resolveCtx, account: resolved };
      return projectSync(
        () => accounts.getAccountFinancials!(params, toolCtx),
        r => r,
        accounts.refreshToken ? { account: resolved, fn: accounts.refreshToken.bind(accounts) } : undefined
      );
    };
  }

  return handlers;
}

// ────────────────────────────────────────────────────────────
// Auto-seed helpers (catalog-backed comply sandbox; issue #1091)
// ────────────────────────────────────────────────────────────

// Auto-seed namespace key extractor. Used by both the write side (the
// `seed.product` / `seed.pricing_option` adapter closures injected
// inline in the auto-seed wiring) and the read side (`makeAutoSeedBridge`
// when `ctx.account?.id` is absent — i.e., the framework didn't
// pre-resolve the account on a custom dispatcher path).
//
// Write-side rationale: the adapter cannot reach the framework-resolved
// `ctx.account.id` (the comply-controller's `ComplyControllerContext`
// only exposes `{ input }`), and calling `platform.accounts.resolve`
// here without `authInfo` would let a caller spoof `account.account_id`
// and write into another tenant's resolved namespace. The architectural
// fix (widen `ComplyControllerContext` to surface the resolved account)
// is tracked at #1216 — until then, raw id is the secure choice.
function readAutoSeedAccountId(input: Record<string, unknown>): string | undefined {
  const account = input.account;
  if (account == null || typeof account !== 'object') return undefined;
  const id = (account as { account_id?: unknown }).account_id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function autoSeedStoreFor(store: Map<string, Map<string, unknown>>, accountId: string): Map<string, unknown> {
  let inner = store.get(accountId);
  if (inner == null) {
    inner = new Map<string, unknown>();
    store.set(accountId, inner);
  }
  return inner;
}

// Build a `TestControllerBridge` over the per-account auto-seed store. The
// bridge filters seeded products by the resolved account so multi-tenant
// servers (TenantRegistry-fronted, or single-tenant with multiple sandbox
// accounts) never leak fixtures across tenants. Reads
// `ctx.account?.id` first (set by `resolveAccount` at request time) and
// falls back to `ctx.input.account.account_id` when no resolver is wired.
function makeAutoSeedBridge(store: Map<string, Map<string, unknown>>): TestControllerBridge<unknown> {
  return {
    getSeededProducts: ctx => {
      const resolved = (ctx.account as { id?: unknown } | undefined)?.id;
      const accountId =
        typeof resolved === 'string' && resolved.length > 0 ? resolved : readAutoSeedAccountId(ctx.input);
      if (accountId == null) return [];
      const inner = store.get(accountId);
      if (inner == null || inner.size === 0) return [];
      const products: Product[] = [];
      for (const [productId, fixture] of inner.entries()) {
        const merged = mergeSeedProduct(
          {},
          {
            ...(fixture && typeof fixture === 'object' ? (fixture as Partial<Product>) : {}),
            product_id: productId,
          }
        );
        products.push(merged as Product);
      }
      return products;
    },
  };
}
