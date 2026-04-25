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
 * Reserved for upcoming commits: `taskHandle.notify` integration with the
 * framework's task store + webhook emitter, `partialResult` projection
 * onto submitted envelopes, per-tenant `getCapabilitiesFor` runtime,
 * "framework always calls accounts.resolve(authPrincipal)" behavior for
 * `'derived'` and `'implicit'` resolution modes.
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

export interface CreateAdcpServerFromPlatformOptions extends Omit<
  AdcpServerConfig,
  'mediaBuy' | 'creative' | 'accounts' | 'eventTracking' | 'resolveAccount' | 'capabilities' | 'name' | 'version'
> {
  name: string;
  version: string;
}

/**
 * Build an `AdcpServer` from a `DecisioningPlatform`. Validates specialism
 * × platform-interface invariants at construction (in addition to the
 * compile-time `RequiredPlatformsFor<S>` gate).
 */
export function createAdcpServerFromPlatform<P extends DecisioningPlatform>(
  platform: P & RequiredPlatformsFor<P['capabilities']['specialisms'][number]>,
  opts: CreateAdcpServerFromPlatformOptions
): AdcpServer {
  validatePlatform(platform);

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
    mediaBuy: buildMediaBuyHandlers(platform),
    creative: buildCreativeHandlers(platform),
    eventTracking: buildEventTrackingHandlers(platform),
    accounts: buildAccountHandlers(platform),
  };

  return createAdcpServer(config);
}

// ---------------------------------------------------------------------------
// Specialism → handler-map adapters
// ---------------------------------------------------------------------------

function buildMediaBuyHandlers<P extends DecisioningPlatform>(platform: P): MediaBuyHandlers<Account> | undefined {
  const sales = platform.sales;
  if (!sales) return undefined;
  return {
    getProducts: async (params, ctx) => {
      const reqCtx = buildRequestContext(ctx);
      return sales.getProducts(params, reqCtx);
    },

    createMediaBuy: async (params, ctx) => {
      const reqCtx = buildRequestContext(ctx);
      const outcome = await sales.createMediaBuy(params, reqCtx);
      return projectMediaBuyOutcome(outcome);
    },

    updateMediaBuy: async (params, ctx) => {
      const reqCtx = buildRequestContext(ctx);
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
      const reqCtx = buildRequestContext(ctx);
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
      const reqCtx = buildRequestContext(ctx);
      const outcome = await sales.getMediaBuyDelivery(params, reqCtx);
      // get_media_buy_delivery wire spec has no Submitted arm. Async report
      // jobs surface via the framework's task envelope flow elsewhere; for
      // now, INVALID_STATE if the platform returns submitted.
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

function buildCreativeHandlers<P extends DecisioningPlatform>(platform: P): CreativeHandlers<Account> | undefined {
  const creative = platform.creative;
  if (!creative) return undefined;
  return {
    buildCreative: async (params, ctx) => {
      const reqCtx = buildRequestContext(ctx);
      const outcome = await creative.buildCreative(params, reqCtx);
      // BuildCreativeResponse has no Submitted arm in the wire spec — async
      // generation completes asynchronously via separate task surfaces.
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
      // previewCreative only exists on CreativeTemplatePlatform.
      if (!('previewCreative' in creative)) {
        return adcpError('UNSUPPORTED_FEATURE', {
          message: 'preview_creative not supported by this platform',
          recovery: 'terminal',
        });
      }
      const reqCtx = buildRequestContext(ctx);
      const outcome = await (creative as CreativeTemplatePlatform).previewCreative(params, reqCtx);
      return projectAsyncOutcome(outcome, preview => preview) as never;
    },

    syncCreatives: async (params, ctx) => {
      const reqCtx = buildRequestContext(ctx);
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
  platform: P
): EventTrackingHandlers<Account> | undefined {
  const audiences = platform.audiences;
  if (!audiences) return undefined;
  return {
    syncAudiences: async (params, ctx) => {
      const reqCtx = buildRequestContext(ctx);
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
