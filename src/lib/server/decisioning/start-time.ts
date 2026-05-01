/**
 * Resolve a wire `start_time` into a concrete `Date`, with platform-aware
 * ASAP semantics.
 *
 * The wire shape is `string | undefined` where the string is either an
 * ISO 8601 timestamp OR the literal `'asap'`. Every platform method that
 * touches `start_time` has to:
 *   1. Handle the union (and the undefined case)
 *   2. Validate that an ISO timestamp parses + isn't in the past
 *   3. Interpret `'asap'` as a sensible date for THIS platform
 *
 * Step 3 is platform-specific. For programmatic sellers, ASAP means
 * `now()`. For guaranteed/broadcast sellers with a 1-3 day trafficker
 * approval pipeline, ASAP means `now() + approval lead time` because the
 * buy can't physically start before the operator signs off. This helper
 * takes a config object so each adopter injects their own semantics
 * consistently across `createMediaBuy(Task)` and `updateMediaBuy`.
 *
 * @example Programmatic seller (no approval)
 * ```ts
 * const startAt = resolveStartTime(req.start_time, {});
 * // 'asap' → now()
 * // '2026-05-01T00:00:00Z' → that date
 * // undefined → now()
 * ```
 *
 * @example Broadcast seller with 2-day IO sign-off + 1-day default lead
 * ```ts
 * const startAt = resolveStartTime(req.start_time, {
 *   asapLeadTimeMs: 2 * 86_400_000,
 *   defaultLeadTimeMs: 86_400_000,
 *   notBefore: new Date(),
 * });
 * // 'asap' → now() + 2 days
 * // past date → throws AdcpError(INVALID_REQUEST)
 * // undefined → now() + 1 day
 * ```
 *
 * @public
 */

import { AdcpError } from './async-outcome';

export interface ResolveStartTimeOptions {
  /**
   * When `start_time` is the literal `'asap'`, return `now() + this`.
   * Models the platform's approval / trafficking pipeline that runs
   * before a buy can actually start. Default `0` (interpret asap as
   * truly now, suitable for programmatic platforms).
   */
  asapLeadTimeMs?: number;
  /**
   * When `start_time` is `undefined`, return `now() + this`. Lets adopters
   * pick whether "no start_time specified" means "asap" (use the same
   * lead time) or some other default. Defaults to the value of
   * `asapLeadTimeMs`.
   */
  defaultLeadTimeMs?: number;
  /**
   * Reject parsed timestamps strictly before this. Most adopters pass
   * `new Date()` to forbid past start times. Omit to skip the check.
   */
  notBefore?: Date;
  /**
   * Override the field name on the error message when validation throws.
   * Defaults to `'start_time'`. Set to `'patch.start_time'` (or similar)
   * when calling from `updateMediaBuy`.
   */
  fieldName?: string;
}

/**
 * Normalize the wire `start_time` value into a guaranteed-non-null Date.
 *
 * Throws `AdcpError('INVALID_REQUEST')` when the string isn't a parseable
 * ISO 8601 timestamp OR when the parsed date is before `opts.notBefore`.
 * Returns `now() + lead time` for `'asap'` and `undefined` inputs.
 */
export function resolveStartTime(raw: string | undefined, opts: ResolveStartTimeOptions = {}): Date {
  const asapLead = opts.asapLeadTimeMs ?? 0;
  const defaultLead = opts.defaultLeadTimeMs ?? asapLead;
  const fieldName = opts.fieldName ?? 'start_time';

  if (raw === undefined) {
    return new Date(Date.now() + defaultLead);
  }
  if (raw === 'asap') {
    return new Date(Date.now() + asapLead);
  }

  const parsed = new Date(raw);
  if (isNaN(parsed.getTime())) {
    throw new AdcpError('INVALID_REQUEST', {
      message: `${fieldName} is not a valid ISO 8601 timestamp: '${raw}'`,
      field: fieldName,
      suggestion: "Use 'asap' or an ISO 8601 timestamp (e.g., '2026-05-01T00:00:00Z')",
    });
  }

  if (opts.notBefore && parsed.getTime() < opts.notBefore.getTime()) {
    throw new AdcpError('INVALID_REQUEST', {
      message: `${fieldName} is in the past: ${parsed.toISOString()} (cutoff ${opts.notBefore.toISOString()})`,
      field: fieldName,
      suggestion: 'Use a future timestamp or `asap`',
    });
  }

  return parsed;
}
