import { redactSecrets, SECRET_KEY_PATTERN } from '../utils/redact-secrets';
import { redactCredentialPatterns } from '../utils/redact-credential-patterns';
import { MAX_JSON_DEPTH } from '../utils/json-depth';

/** Preserve protocol evidence while also scrubbing credentials inside text payloads. */
export function redactDiscoveryEvidence(value: unknown): unknown {
  const visit = (node: unknown, depth: number): unknown => {
    if (depth > MAX_JSON_DEPTH) return '[redacted]';
    if (typeof node === 'string') {
      return (redactCredentialPatterns(node, false) as string).replaceAll('<redacted>', '[redacted]');
    }
    if (Array.isArray(node)) return node.map(child => visit(child, depth + 1));
    if (node && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, visit(child, depth + 1)]));
    }
    return node;
  };
  const pattern = new RegExp(
    `${SECRET_KEY_PATTERN.source}|^(private[_-]?key|signing[_-]?key|signature|auth[_-]?token|jwt)$`,
    'i'
  );
  return visit(redactSecrets(value, pattern), 0);
}
