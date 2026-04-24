/**
 * Public envelope helper for AdCP handler responses.
 *
 * `wrapEnvelope` attaches protocol envelope fields (`replayed`, `context`,
 * `operation_id`) to a handler's inner response object. Sellers that wire
 * their own MCP or A2A handlers — without going through `createAdcpServer` —
 * can use this to produce responses that round-trip with the framework's
 * replay, context echo, and async-operation semantics.
 *
 * Error responses (detected via `inner.adcp_error?.code`) are subject to a
 * per-code field allowlist (`ERROR_ENVELOPE_FIELD_ALLOWLIST` in
 * `./envelope-allowlist.ts`). `IDEMPOTENCY_CONFLICT` ships with an
 * allowlist that permits `context` and `operation_id` and deliberately
 * drops `replayed` — a conflict isn't a replay, and advertising
 * `replayed:true` on an error that was NOT served from cache would
 * mislead the caller.
 *
 * Unregistered error codes fail-closed to `DEFAULT_ERROR_ENVELOPE_FIELDS`
 * (`context` only). Sellers that want `replayed` or `operation_id` on a
 * bespoke error code must register it explicitly.
 *
 * The helper shallow-clones the input and never mutates it.
 */

import { DEFAULT_ERROR_ENVELOPE_FIELDS, ERROR_ENVELOPE_FIELD_ALLOWLIST } from './envelope-allowlist';

/**
 * Options accepted by {@link wrapEnvelope}.
 *
 * Every field is optional. When omitted, the corresponding envelope key is
 * NOT attached (as opposed to emitted with `undefined`). When `replayed`
 * is passed explicitly — including `replayed: false` — the value is
 * attached as-is, so sellers that want to emit an explicit marker on fresh
 * execution can. The framework's own replay bookkeeping stamps `true` on
 * replay and omits the field on fresh (envelope spec permits both).
 */
export interface WrapEnvelopeOptions {
  /**
   * Replay marker. Attached as-is when explicitly set. `protocol-envelope.json`
   * permits the field to be "omitted when the request was executed fresh",
   * so the framework's internal idempotency path omits it on fresh and
   * stamps `true` on replay. Sellers calling this helper directly may
   * pass `false` explicitly if they want the marker in-band. Dropped on
   * error codes whose allowlist excludes it (e.g. `IDEMPOTENCY_CONFLICT`).
   *
   * The asymmetry between the framework path (omits on fresh) and
   * wrapEnvelope callers (round-trip explicit `false`) is intentional:
   * the framework optimizes for spec-clean payloads, while wrapEnvelope
   * respects the caller's explicit intent. Don't "fix" this by collapsing
   * `false` to absent.
   */
  replayed?: boolean;

  /**
   * Echo-back context block. `context` must be a plain object. String,
   * `null`, array, and other non-object values are silently dropped to
   * match the framework's `injectContextIntoResponse` behavior — SI tools
   * (`si_get_offering`, `si_initiate_session`) legitimately override the
   * request `context` to a domain-specific string that must NOT echo into
   * the response envelope, because the response schema requires the
   * protocol echo object there. Pass an object explicitly if you want the
   * field to appear on the envelope.
   *
   * Subject to the per-error-code allowlist when `inner` carries an
   * `adcp_error.code`. Every shipped allowlist includes `context`.
   */
  context?: unknown;

  /**
   * Async operation identifier. Emitted on the envelope as snake_case
   * `operation_id` to match the AdCP field-naming convention.
   */
  operationId?: string;

  /**
   * Override the error-code lookup. When omitted, the helper reads
   * `inner.adcp_error?.code`. Pass this when the inner object isn't
   * shaped like an AdCP error envelope but you still want error-code
   * semantics (for example, when composing with a custom A2A error
   * representation).
   */
  errorCode?: string;
}

interface AdcpErrorLike {
  adcp_error?: { code?: unknown };
}

function detectErrorCode(inner: object, override?: string): string | undefined {
  if (override != null) return override;
  const code = (inner as AdcpErrorLike).adcp_error?.code;
  return typeof code === 'string' ? code : undefined;
}

function isEchoableContext(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Wrap an inner AdCP response object with envelope fields. Returns a
 * shallow clone — the original `inner` is never mutated.
 *
 * @param inner Handler response. For success this is the structured
 *   response payload (e.g. `{ media_buy_id, status }`). For error this
 *   is the AdCP error envelope (`{ adcp_error: { code, message, ... } }`).
 * @param opts Envelope fields to attach. See {@link WrapEnvelopeOptions}.
 *
 * @example Seller handler — success + IDEMPOTENCY_CONFLICT error paths
 * ```ts
 * import { wrapEnvelope } from '@adcp/client/server';
 *
 * async function handleCreateMediaBuy(request) {
 *   try {
 *     const inner = await buyService.create(request.params);
 *     // Fresh-path success: omit `replayed` — envelope spec reads absence
 *     // as fresh execution. Echo request.context for correlation tracing.
 *     return wrapEnvelope(inner, {
 *       context: request.context,
 *       operationId: inner.operation_id,
 *     });
 *   } catch (err) {
 *     if (err.code === 'IDEMPOTENCY_CONFLICT') {
 *       // Conflict is NOT a replay — replayed is dropped by the allowlist,
 *       // but context still echoes for correlation tracing.
 *       return wrapEnvelope(
 *         { adcp_error: { code: 'IDEMPOTENCY_CONFLICT', message: err.message, recovery: 'terminal' } },
 *         { context: request.context }
 *       );
 *     }
 *     throw err;
 *   }
 * }
 * ```
 *
 * @example Success path (fresh execution, no explicit replayed)
 * ```ts
 * const response = wrapEnvelope(
 *   { media_buy_id: 'mb_1', status: 'active' },
 *   { context: { correlation_id: 'abc' }, operationId: 'op_123' }
 * );
 * // => { media_buy_id, status, context: {...}, operation_id: 'op_123' }
 * ```
 *
 * @example Replay path (stamp true)
 * ```ts
 * const response = wrapEnvelope(
 *   { media_buy_id: 'mb_1', status: 'active' },
 *   { replayed: true, context: { correlation_id: 'abc' }, operationId: 'op_123' }
 * );
 * // => { media_buy_id, status, replayed: true, context: {...}, operation_id: 'op_123' }
 * ```
 *
 * @example Conflict error — `replayed` is dropped, `context` is echoed
 * ```ts
 * const response = wrapEnvelope(
 *   { adcp_error: { code: 'IDEMPOTENCY_CONFLICT', message: '...', recovery: 'terminal' } },
 *   { replayed: true, context: { correlation_id: 'abc' }, operationId: 'op_123' }
 * );
 * // `replayed: true` is intentionally dropped — IDEMPOTENCY_CONFLICT's
 * // per-code allowlist excludes it (a conflict is not a cached replay).
 * // => { adcp_error: {...}, context: {...}, operation_id: 'op_123' }
 * ```
 *
 * @example Bespoke error code — fail-closed default
 * ```ts
 * const response = wrapEnvelope(
 *   { adcp_error: { code: 'MY_CUSTOM_ERROR', message: '...', recovery: 'terminal' } },
 *   { replayed: false, context: { correlation_id: 'abc' }, operationId: 'op_123' }
 * );
 * // An unregistered error code inherits DEFAULT_ERROR_ENVELOPE_FIELDS
 * // ({ context } only). `replayed` and `operation_id` are silently
 * // dropped. Sellers that need those fields on bespoke codes should
 * // build the envelope directly rather than calling wrapEnvelope, or
 * // open an issue to register the code in ERROR_ENVELOPE_FIELD_ALLOWLIST.
 * // => { adcp_error: {...}, context: {...} }
 * ```
 */
export function wrapEnvelope<T extends object>(
  inner: T,
  opts: WrapEnvelopeOptions
): T & { replayed?: boolean; context?: object; operation_id?: string } {
  const clone: Record<string, unknown> = {
    ...(inner as Record<string, unknown>),
  };

  const errorCode = detectErrorCode(inner, opts.errorCode);
  // Error responses: registered codes use their explicit allowlist;
  // unregistered codes fail closed to DEFAULT_ERROR_ENVELOPE_FIELDS
  // (context only). Success responses (no error code) allow all fields.
  const allowlist =
    errorCode != null ? (ERROR_ENVELOPE_FIELD_ALLOWLIST[errorCode] ?? DEFAULT_ERROR_ENVELOPE_FIELDS) : undefined;

  const fieldAllowed = (field: string): boolean => {
    if (allowlist == null) return true;
    return allowlist.has(field);
  };

  if ('replayed' in opts && fieldAllowed('replayed')) {
    clone.replayed = opts.replayed;
  }

  // Context parity with `injectContextIntoResponse`: only attach when the
  // inner payload doesn't already carry a context the handler placed
  // itself. And honor the per-error-code allowlist — `context` is
  // listed explicitly in every shipped entry.
  if ('context' in opts && isEchoableContext(opts.context) && !('context' in clone) && fieldAllowed('context')) {
    clone.context = opts.context;
  }

  if (opts.operationId != null && fieldAllowed('operation_id')) {
    clone.operation_id = opts.operationId;
  }

  return clone as T & {
    replayed?: boolean;
    context?: object;
    operation_id?: string;
  };
}
