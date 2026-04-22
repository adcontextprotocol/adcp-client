/**
 * Public envelope helper for AdCP handler responses.
 *
 * `wrapEnvelope` attaches protocol envelope fields (`replayed`, `context`,
 * `operation_id`) to a handler's inner response object. Sellers that wire
 * their own MCP or A2A handlers — without going through `createAdcpServer` —
 * can use this to produce responses that round-trip with the framework's
 * replay, context echo, and async-operation semantics.
 *
 * Error responses (detected via `inner.adcp_error?.code`) may opt into a
 * per-code field allowlist. `IDEMPOTENCY_CONFLICT` ships with an allowlist
 * that permits `context` and `operation_id` and deliberately drops
 * `replayed` — a conflict isn't a replay, and advertising `replayed:true`
 * on an error that was NOT served from cache would mislead the caller.
 *
 * The helper shallow-clones the input and never mutates it.
 */

/**
 * Options accepted by {@link wrapEnvelope}.
 *
 * Every field is optional. When omitted, the corresponding envelope key is
 * NOT attached (as opposed to emitted with `undefined`). When `replayed`
 * is passed explicitly — including `replayed: false` — the value is
 * attached; the conformance storyboards require `replayed:false` on
 * fresh-path mutations so the field must round-trip when explicitly set.
 */
export interface WrapEnvelopeOptions {
  /**
   * Replay marker. Attached as-is when explicitly set. `false` is a
   * meaningful value (fresh-path mutation) and MUST be emitted when
   * passed. Dropped on error codes whose allowlist excludes it (e.g.
   * `IDEMPOTENCY_CONFLICT`).
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

/**
 * Per-error-code envelope-field allowlist.
 *
 * A code listed here restricts which envelope fields `wrapEnvelope` will
 * attach on top of the error's inner payload. Fields NOT in the allowlist
 * are silently dropped. A code NOT listed here falls back to the
 * success-envelope behavior (all fields attached when provided).
 *
 * `IDEMPOTENCY_CONFLICT` deliberately excludes `replayed`: the conflict
 * path in `create-adcp-server.ts` builds its error via `finalize()`,
 * which only echoes `context` and never calls `injectReplayed`. The
 * exported allowlist keeps the public helper aligned with that behavior.
 *
 * This is the sibling-field allowlist (keys attached AS SIBLINGS of
 * `adcp_error`). The keys allowed INSIDE the `adcp_error` block itself
 * are governed by `CONFLICT_ALLOWED_ENVELOPE_KEYS` in
 * `src/lib/testing/storyboard/default-invariants.ts` — two separate
 * concerns, keep them in sync if extending.
 *
 * **Invariant**: every allowlist set MUST include `'context'`. The helper
 * enforces this at module load so new error codes can't accidentally drop
 * context echo (which sellers rely on for correlation tracing across both
 * success and error paths). See `ensureContextEcho` below.
 *
 * **Consumer use case**: custom MCP / A2A handlers that emit envelope
 * fields beyond `replayed` / `context` / `operation_id` can read this set
 * to preflight their outputs, or extend it locally via
 * `new Set([...existing, 'my_field'])` (do NOT mutate in place — the
 * exported object is frozen).
 */
export const ERROR_ENVELOPE_FIELD_ALLOWLIST: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  IDEMPOTENCY_CONFLICT: new Set(['context', 'operation_id']),
});

/**
 * Sanity check: every allowlist entry must permit `context` echo. Future
 * error codes can't silently drop context without thinking — missing
 * entries fail at module load, not at runtime request time.
 */
function ensureContextEcho(allowlist: Readonly<Record<string, ReadonlySet<string>>>): void {
  for (const [code, fields] of Object.entries(allowlist)) {
    if (!fields.has('context')) {
      throw new Error(
        `ERROR_ENVELOPE_FIELD_ALLOWLIST['${code}'] is missing 'context'. ` +
          `Every error-code allowlist must include 'context' so correlation ` +
          `ids can round-trip on error envelopes.`
      );
    }
  }
}
ensureContextEcho(ERROR_ENVELOPE_FIELD_ALLOWLIST);

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
 *     // Fresh-path success: emit replayed:false so storyboards can assert
 *     // the absence of a replay, and echo request.context for tracing.
 *     return wrapEnvelope(inner, {
 *       replayed: false,
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
 * @example Success path
 * ```ts
 * const response = wrapEnvelope(
 *   { media_buy_id: 'mb_1', status: 'active' },
 *   { replayed: false, context: { correlation_id: 'abc' }, operationId: 'op_123' }
 * );
 * // => { media_buy_id, status, replayed: false, context: {...}, operation_id: 'op_123' }
 * ```
 *
 * @example Conflict error — `replayed` is dropped, `context` is echoed
 * ```ts
 * const response = wrapEnvelope(
 *   { adcp_error: { code: 'IDEMPOTENCY_CONFLICT', message: '...', recovery: 'terminal' } },
 *   { replayed: true, context: { correlation_id: 'abc' }, operationId: 'op_123' }
 * );
 * // => { adcp_error: {...}, context: {...}, operation_id: 'op_123' }  // no `replayed`
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
  const allowlist = errorCode != null ? ERROR_ENVELOPE_FIELD_ALLOWLIST[errorCode] : undefined;

  const fieldAllowed = (field: string): boolean => {
    // Unknown error code falls back to success-envelope semantics.
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
