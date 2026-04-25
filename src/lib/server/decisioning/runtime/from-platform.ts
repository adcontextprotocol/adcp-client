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
 * **v6.0 alpha scope** (this commit): wires `accounts.resolve()` and one
 * tool — `get_products` from `SalesPlatform` — end-to-end. Subsequent
 * commits expand the wired surface to the rest of the v1.0 specialism
 * methods, then to async outcome → wire projection (submitted +
 * partialResult), then to per-tenant `getCapabilitiesFor`.
 *
 * Status: Preview / 6.0. Not yet exported from the public `./server`
 * subpath; reach in via `@adcp/client/server/decisioning/runtime` for
 * spike experimentation only.
 *
 * @public
 */

import type { AdcpServer } from '../../adcp-server';
import { createAdcpServer, type AdcpServerConfig, type MediaBuyHandlers } from '../../create-adcp-server';
import type { DecisioningPlatform, RequiredPlatformsFor } from '../platform';
import type { Account } from '../account';
import type { AsyncOutcome } from '../async-outcome';
import { AccountNotFoundError } from '../account';
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
  };

  return createAdcpServer(config);
}

// ---------------------------------------------------------------------------
// Specialism → handler-map adapters
//
// v6.0 alpha: only `getProducts` is wired through. Subsequent commits expand
// to the rest of `SalesPlatform`, then `CreativeTemplatePlatform` /
// `CreativeGenerativePlatform`, then `AudiencePlatform`.
// ---------------------------------------------------------------------------

function buildMediaBuyHandlers<P extends DecisioningPlatform>(platform: P): MediaBuyHandlers<Account> | undefined {
  const sales = platform.sales;
  if (!sales) return undefined;
  return {
    getProducts: async (params, ctx) => {
      const reqCtx = buildRequestContext(ctx);
      return sales.getProducts(params, reqCtx);
    },
  };
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
): TOut | AdcpErrorResponse {
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
    case 'submitted':
      throw new Error('AsyncOutcome.submitted projection not yet wired in v6.0 alpha');
  }
}
