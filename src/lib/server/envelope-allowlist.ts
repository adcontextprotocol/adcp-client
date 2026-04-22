/**
 * Envelope-allowlist governance for AdCP error responses.
 *
 * Two orthogonal concerns both govern what round-trips on an AdCP error
 * envelope. They live side-by-side here so that a change to one forces
 * the reviewer to weigh the other (security review M4 on #788 — the
 * pair is conceptually related and can drift in separate files).
 *
 * - `ERROR_ENVELOPE_FIELD_ALLOWLIST` governs keys that may appear as
 *   SIBLINGS of `adcp_error` on the wire response. Enforced by
 *   `wrapEnvelope` in `./wrap-envelope.ts`.
 * - `ADCP_ERROR_FIELD_ALLOWLIST` governs keys that may appear INSIDE
 *   the `adcp_error` block, keyed by error code. Consumed by
 *   `adcpError()` (which filters its output to the allowlisted set) and
 *   by the `idempotency.conflict_no_payload_leak` invariant in
 *   `../testing/storyboard/default-invariants.ts`. The legacy
 *   `CONFLICT_ADCP_ERROR_ALLOWLIST` export is a convenience alias for
 *   the `IDEMPOTENCY_CONFLICT` entry.
 *
 * Both sets apply to the same wire response but at different nesting
 * levels. A seller that needs to extend one should audit whether the
 * other also needs updating.
 */

/**
 * Fail-closed default allowlist for unknown error codes.
 *
 * An error code without an explicit entry in
 * `ERROR_ENVELOPE_FIELD_ALLOWLIST` gets this set — only `context`
 * round-trips (matching the invariant that every allowlist permits
 * correlation tracing). Sellers that want `replayed` or `operation_id`
 * on a bespoke error code must register it explicitly.
 *
 * This is the fail-closed posture — sellers MUST opt in to any field
 * they want on an error envelope, rather than inheriting success-path
 * semantics by default. Security review M3 on #788.
 */
export const DEFAULT_ERROR_ENVELOPE_FIELDS: ReadonlySet<string> = Object.freeze(new Set(['context']));

/**
 * Per-error-code envelope-field allowlist.
 *
 * A code listed here restricts which envelope fields `wrapEnvelope`
 * will attach on top of the error's inner payload. Codes NOT listed
 * here receive `DEFAULT_ERROR_ENVELOPE_FIELDS` (fail-closed —
 * `context` only).
 *
 * `IDEMPOTENCY_CONFLICT` deliberately excludes `replayed`: the
 * conflict path in `create-adcp-server.ts` builds its error via
 * `finalize()`, which only echoes `context` and never calls
 * `injectReplayed`. The framework's own behavior is preserved.
 *
 * **Invariant**: every allowlist set MUST include `'context'`.
 * `ensureContextEcho` enforces this at module load so new error codes
 * can't accidentally drop context echo (which sellers rely on for
 * correlation tracing across both success and error paths).
 */
export const ERROR_ENVELOPE_FIELD_ALLOWLIST: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  // Spec-defined: conflict is not a replay; `replayed` intentionally
  // dropped. `operation_id` round-trips for async-op correlation.
  IDEMPOTENCY_CONFLICT: new Set(['context', 'operation_id']),
});

/**
 * Per-error-code allowlist for keys permitted INSIDE the `adcp_error`
 * block. The `adcpError()` builder consults this table and drops any
 * field the caller passes that isn't allowlisted for the given code —
 * the allowlist IS the contract for what a framework-emitted error may
 * carry. Storyboard invariants enforce the same contract on the wire.
 *
 * A code without an explicit entry permits everything `adcpError()`
 * would otherwise emit — the default case is pass-through. Sellers who
 * want a bespoke code to be strict should register it here (or wrap
 * `adcpError()` with their own sanitizer).
 *
 * `IDEMPOTENCY_CONFLICT` is narrow on purpose: a conflict response MUST
 * NOT echo the prior request payload or cached response (stolen-key
 * read oracle defence). `recovery` is deliberately excluded — the
 * classifier is redundant with `code` (same information, derivable from
 * the standard error-code table), and adding it widens the surface the
 * invariant has to defend for future fields. `adcpError()` filters
 * `recovery` out of its output when the code is in this map.
 */
export const ADCP_ERROR_FIELD_ALLOWLIST: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  IDEMPOTENCY_CONFLICT: new Set(['code', 'message', 'status', 'retry_after', 'correlation_id', 'request_id', 'operation_id']),
});

/**
 * Convenience alias for the `IDEMPOTENCY_CONFLICT` entry in
 * {@link ADCP_ERROR_FIELD_ALLOWLIST}. Kept as a named export because
 * the default `idempotency.conflict_no_payload_leak` invariant and a
 * handful of consumer tests reach for it by name; new code should use
 * `ADCP_ERROR_FIELD_ALLOWLIST.IDEMPOTENCY_CONFLICT` directly.
 */
export const CONFLICT_ADCP_ERROR_ALLOWLIST: ReadonlySet<string> = ADCP_ERROR_FIELD_ALLOWLIST.IDEMPOTENCY_CONFLICT as ReadonlySet<string>;

/**
 * Sanity check: every registered allowlist must permit `context` echo.
 * Missing entries fail at module load, not at runtime request time —
 * correlation tracing breaks if any error path silently stops echoing it.
 */
function ensureContextEcho(allowlist: Readonly<Record<string, ReadonlySet<string>>>): void {
  if (!DEFAULT_ERROR_ENVELOPE_FIELDS.has('context')) {
    throw new Error(
      "DEFAULT_ERROR_ENVELOPE_FIELDS must include 'context' so correlation " + 'ids can round-trip on error envelopes.'
    );
  }
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

/**
 * Sanity check: every inside-`adcp_error` allowlist MUST permit `code`
 * and `message` — they are the only two required fields in the AdCP
 * error schema and `adcpError()` can't produce a valid payload without
 * them. Fail at module load so new allowlist entries can't silently ship
 * a shape that would drop the fields every consumer expects.
 */
function ensureCoreAdcpErrorFields(allowlist: Readonly<Record<string, ReadonlySet<string>>>): void {
  for (const [code, fields] of Object.entries(allowlist)) {
    for (const required of ['code', 'message']) {
      if (!fields.has(required)) {
        throw new Error(
          `ADCP_ERROR_FIELD_ALLOWLIST['${code}'] is missing '${required}'. ` +
            `Every inside-adcp_error allowlist must include 'code' and 'message' — ` +
            `they are the only two required fields on the AdCP error schema.`
        );
      }
    }
  }
}
ensureCoreAdcpErrorFields(ADCP_ERROR_FIELD_ALLOWLIST);
