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
   * Echo-back context block. Always allowed on both success and error
   * envelopes. Non-object values (string, null, array) are ignored to
   * match the framework's `injectContextIntoResponse` behavior — SI tools
   * override request `context` to a string, and echoing a string into the
   * response envelope would violate response-schema validation.
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
 * `src/lib/testing/storyboard/default-invariants.ts`.
 */
export const ERROR_ENVELOPE_FIELD_ALLOWLIST: Readonly<
  Record<string, ReadonlySet<string>>
> = Object.freeze({
  IDEMPOTENCY_CONFLICT: new Set(['context', 'operation_id']),
});

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
): T {
  const clone: Record<string, unknown> = {
    ...(inner as Record<string, unknown>),
  };

  const errorCode = detectErrorCode(inner, opts.errorCode);
  const allowlist =
    errorCode != null ? ERROR_ENVELOPE_FIELD_ALLOWLIST[errorCode] : undefined;

  const fieldAllowed = (field: string): boolean => {
    // `context` is always allowed (success + error).
    if (field === 'context') return true;
    // Unknown error code falls back to success-envelope semantics.
    if (allowlist == null) return true;
    return allowlist.has(field);
  };

  if ('replayed' in opts && fieldAllowed('replayed')) {
    clone.replayed = opts.replayed;
  }

  if ('context' in opts && isEchoableContext(opts.context)) {
    clone.context = opts.context;
  }

  if (opts.operationId != null && fieldAllowed('operation_id')) {
    clone.operation_id = opts.operationId;
  }

  return clone as T;
}
