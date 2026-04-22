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
 * - `CONFLICT_ADCP_ERROR_ALLOWLIST` governs keys that may appear INSIDE
 *   the `adcp_error` block on an IDEMPOTENCY_CONFLICT payload. Enforced
 *   by the `idempotency.conflict_no_payload_leak` invariant in
 *   `../testing/storyboard/default-invariants.ts`.
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
 * Keys permitted INSIDE the `adcp_error` block on an IDEMPOTENCY_CONFLICT
 * response. Anything else inside the block is flagged as a potential
 * payload leak by `idempotency.conflict_no_payload_leak` (stolen-key
 * read oracle defence — a conflict response must NOT echo the prior
 * request payload or cached response).
 *
 * The allowlist is narrow on purpose: sellers that need more fields
 * should push back on the spec, not silently leak cached state.
 *
 * `recovery` is permitted because `adcpError()` emits it unconditionally
 * from the standard error-code table, it's a first-class `core/error.json`
 * field, and it carries no payload-fingerprint risk (it's a
 * closed enum of `transient | correctable | terminal`).
 */
export const CONFLICT_ADCP_ERROR_ALLOWLIST: ReadonlySet<string> = Object.freeze(
  new Set(['code', 'message', 'recovery', 'status', 'retry_after', 'correlation_id', 'request_id', 'operation_id'])
);

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
