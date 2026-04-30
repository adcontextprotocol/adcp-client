/**
 * Adopter utility helpers for DecisioningPlatform implementations.
 *
 * All exports are opt-in convenience — nothing in the framework calls
 * these internally. They lift boilerplate that every adopter with the
 * corresponding pattern would otherwise rewrite from scratch.
 *
 * @public
 */

import { AdcpError, type ErrorCode } from './async-outcome';
import { pickSafeDetails } from '../pick-safe-details';

// ---------------------------------------------------------------------------
// batchPoll
// ---------------------------------------------------------------------------

/**
 * Project a per-id Result-returning lookup into the `pollAudienceStatuses`
 * `Map<id, status>` shape.
 *
 * Runs all lookups in parallel. Drops entries where `result.isOk()` is
 * false OR `result.value` is `undefined` — per the SDK contract, not-found
 * entries are omitted from the map (callers handle missing keys via
 * `Map.prototype.get`).
 *
 * Typical use in `AudiencePlatform.pollAudienceStatuses`:
 *
 * ```ts
 * import { batchPoll } from '@adcp/sdk/server/decisioning';
 *
 * async pollAudienceStatuses(audienceIds, ctx) {
 *   return batchPoll(audienceIds, async (id) =>
 *     this.myPlatform.getAudienceStatus(id, ctx.account.ctx_metadata.token)
 *   );
 * }
 * ```
 *
 * The `lookup` return type is structural — any object with `isOk(): boolean`
 * and `value?: TValue` matches (`neverthrow`, `fp-ts`, or custom Result types
 * all work without wrapping).
 *
 * @public
 */
export async function batchPoll<TKey extends string, TValue>(
  ids: readonly TKey[],
  lookup: (id: TKey) => Promise<{ isOk(): boolean; value?: TValue }>
): Promise<Map<TKey, TValue>> {
  const pairs = await Promise.all(
    ids.map(async id => {
      const r = await lookup(id);
      return [id, r] as const;
    })
  );
  const result = new Map<TKey, TValue>();
  for (const [id, r] of pairs) {
    if (r.isOk() && r.value !== undefined) {
      result.set(id, r.value);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Error factory helpers
// ---------------------------------------------------------------------------

/**
 * Construct an `AdcpError` for a buyer-correctable validation failure.
 * Shorthand for `new AdcpError('VALIDATION_ERROR', { recovery: 'correctable', ... })`.
 *
 * ```ts
 * import { validationError } from '@adcp/sdk/server/decisioning';
 *
 * if (!req.targeting?.geos?.length) {
 *   throw validationError('At least one geo is required', {
 *     field: 'targeting.geos',
 *   });
 * }
 * ```
 *
 * @param message - Human-readable explanation of the validation failure.
 * @param opts.field - Wire `field` path (e.g. `'targeting.geos'`).
 * @param opts.code - Override the error code (default `'VALIDATION_ERROR'`).
 * @public
 */
export function validationError(
  message: string,
  opts?: { field?: string; code?: ErrorCode | (string & {}) }
): AdcpError {
  return new AdcpError((opts?.code ?? 'VALIDATION_ERROR') as ErrorCode, {
    recovery: 'correctable',
    message,
    ...(opts?.field !== undefined && { field: opts.field }),
  });
}

/**
 * Construct an `AdcpError` for an upstream-platform failure (5xx /
 * rate-limited). `extraDetails` is run through {@link pickSafeDetails}
 * internally — depth-capped and size-capped — so credentials or stack
 * traces the caller accidentally included don't cross the wire boundary.
 *
 * HTTP 429 maps to `RATE_LIMITED` (with `retry_after: 60`). All other
 * upstream failures map to `SERVICE_UNAVAILABLE`. Both use
 * `recovery: 'transient'`.
 *
 * ```ts
 * import { upstreamError } from '@adcp/sdk/server/decisioning';
 *
 * try {
 *   return await this.gam.createOrder(req);
 * } catch (e) {
 *   throw upstreamError('GAM order creation failed', e, {
 *     gam_error_code: e.errorCode,
 *     request_id: e.requestId,
 *   });
 * }
 * ```
 *
 * @param prefix - Short description of the operation that failed
 *   (e.g. `'GAM order creation failed'`). Prepended to the upstream message.
 * @param e - Upstream error. Only `message`, `code`, and `status` are read;
 *   all other fields are ignored.
 * @param extraDetails - Optional pre-selected safe fields to surface to the
 *   buyer. Run through `pickSafeDetails` with depth/size caps before attaching
 *   to the wire envelope.
 * @public
 */
export function upstreamError(
  prefix: string,
  e: { message?: string; code?: number | string; status?: number },
  extraDetails?: Record<string, unknown>
): AdcpError {
  const statusCode = e.status ?? (typeof e.code === 'number' ? e.code : undefined);
  const isRateLimited = statusCode === 429;
  const errorCode: ErrorCode = isRateLimited ? 'RATE_LIMITED' : 'SERVICE_UNAVAILABLE';
  const upstreamMsg = typeof e.message === 'string' && e.message.length > 0 ? e.message : 'upstream error';
  const details = extraDetails !== undefined ? pickSafeDetails(extraDetails, Object.keys(extraDetails)) : undefined;

  return new AdcpError(errorCode, {
    recovery: 'transient',
    message: `${prefix}: ${upstreamMsg}`,
    ...(isRateLimited && { retry_after: 60 }),
    ...(details !== undefined && { details }),
  });
}

// ---------------------------------------------------------------------------
// RequestShape<T>
// ---------------------------------------------------------------------------

/**
 * Strip index signatures from a wire request type for back-compat with
 * v5-era task functions whose parameter types don't carry the spec's
 * `additionalProperties: true` index signature (`[x: string]: unknown`).
 *
 * Without this, passing a v6 wire type directly to a v5 task fn produces:
 *
 * ```
 * Type 'CreateMediaBuyRequest' is not assignable to type
 *   'Parameters<typeof createMediaBuyTask>[1]'
 * ```
 *
 * because generated v6 types include `[x: string]: unknown` for
 * forward-compat but v5 fn signatures were authored without it.
 *
 * ```ts
 * import type { RequestShape } from '@adcp/sdk/server/decisioning';
 *
 * const result = await createMediaBuyTask(
 *   snapCtx(account),
 *   req as RequestShape<typeof req>, // drops index sig for v5 adapter compat
 * );
 * ```
 *
 * @public
 */
export type RequestShape<T> = { [K in keyof T]: T[K] };
