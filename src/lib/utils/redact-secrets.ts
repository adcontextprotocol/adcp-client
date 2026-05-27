/**
 * Recursive secret-key redaction.
 *
 * The runner-output-contract.yaml security block (`payload_redaction`) and
 * the `comply-test-controller-response.json` `recorded_calls[].payload`
 * description both mandate the same recursive walk: any property whose
 * final-path-segment key matches the canonical pattern below has its scalar
 * value replaced with the literal string `"[redacted]"`. The walk is capped
 * at the same depth the upstream-recorder accepts for JSON canonicalization;
 * the recorder rejects deeper structured payloads after redaction so it does
 * not store subtrees beyond this cap.
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

import { MAX_JSON_DEPTH } from './json-depth';

/**
 * Canonical secret-key pattern from the AdCP runner-output contract. Mirrors
 * the spec block: `Authorization`, `Credentials`, tokens, API keys,
 * passwords, secrets, OAuth refresh / access bearers, session tokens,
 * cookies. Case-insensitive.
 */
export const SECRET_KEY_PATTERN =
  /^(authorization|credentials?|token|api[_-]?key|password|secret|client[_-]secret|refresh[_-]token|access[_-]token|bearer|session[_-]token|session[_-]id|offering[_-]token|cookie|set[_-]cookie)$/i;

/**
 * Maximum recursion depth for the redaction walk. Keep this aligned with the
 * upstream-recorder JSON canonicalization depth; recorder paths also run the
 * depth gate after redaction so structured payloads beyond the cap are
 * rejected instead of stored with unvisited subtrees.
 */
/**
 * Recursively walk `value`, returning a structurally-identical clone with
 * scalar values at secret-shaped keys replaced by `"[redacted]"`. Pass an
 * optional `pattern` to override the canonical pattern (typically by
 * extending it — adopters MAY add internal vendor headers but MUST NOT
 * narrow the contract floor).
 *
 * Non-mutating — the input is never touched.
 */
export function redactSecrets(
  value: unknown,
  pattern: RegExp = SECRET_KEY_PATTERN,
  depth = 0,
  seen: WeakSet<object> = new WeakSet()
): unknown {
  if (depth > MAX_JSON_DEPTH) return value;
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const out = value.map(v => redactSecrets(v, pattern, depth + 1, seen));
    seen.delete(value);
    return out;
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] =
        pattern.test(k) && (typeof v === 'string' || typeof v === 'number')
          ? '[redacted]'
          : redactSecrets(v, pattern, depth + 1, seen);
    }
    seen.delete(value);
    return out;
  }
  return value;
}
