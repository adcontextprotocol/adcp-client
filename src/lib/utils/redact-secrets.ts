/**
 * Recursive secret-key redaction.
 *
 * The runner-output-contract.yaml security block (`payload_redaction`) and
 * the `comply-test-controller-response.json` `recorded_calls[].payload`
 * description both mandate the same recursive walk: any property whose
 * final-path-segment key matches the canonical pattern below has its scalar
 * value replaced with the literal string `"[redacted]"`. Walks at any depth.
 *
 * Spec: `static/compliance/source/universal/runner-output-contract.yaml`
 * (`payload_redaction.pattern`). The runner uses this to redact request /
 * response payloads on `validation_result.request` / `.response`. The
 * `@adcp/sdk/upstream-recorder` uses this at *recording* time so plaintext
 * secrets never sit in the recorded-calls buffer in memory, even briefly.
 *
 * Matching is case-insensitive and structural — the pattern matches against
 * the property KEY, not the value. Adopters MAY extend the pattern via the
 * recorder's `redactPattern` option, but MUST NOT narrow it.
 */

/**
 * Canonical secret-key pattern from the AdCP runner-output contract. Mirrors
 * the spec block: `Authorization`, `Credentials`, tokens, API keys,
 * passwords, secrets, OAuth refresh / access bearers, session tokens,
 * cookies. Case-insensitive.
 */
export const SECRET_KEY_PATTERN =
  /^(authorization|credentials?|token|api[_-]?key|password|secret|client[_-]secret|refresh[_-]token|access[_-]token|bearer|session[_-]token|session[_-]id|offering[_-]token|cookie|set[_-]cookie)$/i;

/**
 * Maximum recursion depth for the redaction walk. Cheap cycle / hostile-
 * payload guard — a payload deeper than this stops being recursed (the
 * remaining structure passes through verbatim, which is acceptable: a
 * 32-deep nested object would already be an attack surface for any
 * downstream consumer).
 */
const REDACT_MAX_DEPTH = 32;

/**
 * Recursively walk `value`, returning a structurally-identical clone with
 * scalar values at secret-shaped keys replaced by `"[redacted]"`. Pass an
 * optional `pattern` to override the canonical pattern (typically by
 * extending it — adopters MAY add internal vendor headers but MUST NOT
 * narrow the contract floor).
 *
 * Non-mutating — the input is never touched.
 */
export function redactSecrets(value: unknown, pattern: RegExp = SECRET_KEY_PATTERN, depth = 0): unknown {
  if (depth > REDACT_MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map(v => redactSecrets(v, pattern, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] =
        pattern.test(k) && (typeof v === 'string' || typeof v === 'number')
          ? '[redacted]'
          : redactSecrets(v, pattern, depth + 1);
    }
    return out;
  }
  return value;
}
