/**
 * Credential-shape redactor for diagnostic strings projected to the wire
 * via `error.details.reason`. Stage 4 of #1269 — defense-in-depth against
 * adopter-thrown errors whose `message` includes credential payloads
 * (raw bearer tokens, OAuth client secrets, signing keyids).
 *
 * **Production-default exposure is already gated** on
 * `exposeErrorDetails: process.env.NODE_ENV !== 'production'`. This
 * redactor closes the pre-production gap: adopters running in dev /
 * staging with `exposeErrorDetails: true` no longer leak credential
 * bytes when their resolver throws an error like
 * `Error('lookup failed for token=sk_live_abc')`.
 *
 * The redactor is intentionally conservative — it produces false
 * positives (legitimate IDs that match a credential pattern get
 * redacted too) rather than false negatives. Adopters who need the
 * unredacted error log it server-side, where the framework's logger
 * forwards `err.message` unchanged.
 *
 * @internal — used by the dispatcher's `err.message → details.reason`
 * projections (`create-adcp-server.ts`). Not part of the adopter
 * surface; adopters who want to sanitize `error.details` for their own
 * pipelines reach for `pickSafeDetails` instead.
 */

/**
 * Patterns the redactor scrubs. Applied in order; each pattern replaces
 * the matched substring with a placeholder. Patterns are case-insensitive
 * where the match makes sense.
 *
 * 1. `Authorization: Bearer <token>` and similar HTTP-Auth shapes.
 * 2. `key=`, `token=`, `secret=`, `password=`, `client_id=`,
 *    `client_secret=`, `api_key=`, `key_id=` patterns (with optional
 *    quoting and varied separators).
 * 3. Long alphanumeric strings (length ≥ 32) that look like tokens
 *    (no spaces, hex / base64 / base64url charsets). Catches tokens
 *    appearing without a labeling prefix.
 *
 * The 32-character threshold balances catching real tokens (most
 * production tokens are ≥ 32 chars) against false positives on shorter
 * IDs (UUIDs at 36 chars match, which is fine — a UUID embedded in
 * an error message gets redacted, the server-side log keeps it).
 */
// Credential-label alternation reused across multiple patterns. Captures
// common credential field names with both `_` and `-` separators.
const CREDENTIAL_LABEL =
  '(token|api[_-]?key|secret|password|passwd|pwd|client[_-]?secret|client[_-]?id|key[_-]?id|signing[_-]?key|jwt|bearer)';

export function redactCredentialPatterns(message: string): string {
  if (typeof message !== 'string' || message.length === 0) return message;
  return (
    message
      // 1. Authorization headers — `Bearer <token>`.
      .replace(/\bBearer\s+[A-Za-z0-9_\-.~+/=]{8,}/gi, 'Bearer <redacted>')
      // 2. JSON-quoted credential properties: "token":"value",
      //    "client_secret":"value", etc. Matches any non-empty quoted
      //    value (including short ones — labeled credentials are always
      //    secrets regardless of length).
      .replace(new RegExp(`"${CREDENTIAL_LABEL}"\\s*:\\s*"[^"]+"`, 'gi'), '"$1":"<redacted>"')
      // 3. Unquoted / single-quoted credential properties:
      //    `token=value`, `client_id: value`. Allows optional quote
      //    around both the label and the value.
      .replace(
        new RegExp(`\\b${CREDENTIAL_LABEL}['"]?\\s*[=:]\\s*['"]?[A-Za-z0-9_\\-.~+/=]{4,}['"]?`, 'gi'),
        '$1=<redacted>'
      )
      // 4. Long token-shaped strings (≥ 32 chars of base64/hex/url-safe)
      //    without an obvious label. Word-boundary anchored so legitimate
      //    prose / sentence fragments don't match. The lower bound is 32
      //    to avoid eating short hex IDs (8-char UUID prefixes etc.).
      .replace(/\b[A-Za-z0-9_\-.~+/=]{32,}\b/g, '<redacted-token>')
  );
}
