export const WEBHOOK_AUTH_TRAVERSAL_DEPTH = 64;

/**
 * Scan a parsed JSON value for a non-empty authentication object. The false
 * positive cost is over-signing; the false negative cost is an unsigned
 * webhook-credential registration.
 *
 * Inspection-budget exhaustion fails closed by returning true.
 */
export function containsWebhookAuthentication(value: unknown, depthRemaining = WEBHOOK_AUTH_TRAVERSAL_DEPTH): boolean {
  if (depthRemaining <= 0) return true;
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    return value.some(item => containsWebhookAuthentication(item, depthRemaining - 1));
  }

  const obj = value as Record<string, unknown>;
  if (hasNonEmptyAuthenticationObject(obj.authentication)) return true;

  for (const [key, nested] of Object.entries(obj)) {
    if (key === 'authentication') continue;
    if (containsWebhookAuthentication(nested, depthRemaining - 1)) return true;
  }
  return false;
}

function hasNonEmptyAuthenticationObject(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.keys(value).length > 0;
}
