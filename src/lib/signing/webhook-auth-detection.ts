export const WEBHOOK_AUTH_TRAVERSAL_DEPTH = 64;

const WEBHOOK_AUTH_CONFIG_KEYS = new Set([
  'push_notification_config',
  'pushNotificationConfig',
  'reporting_webhook',
  'reportingWebhook',
  'artifact_webhook',
  'artifactWebhook',
  'revocation_webhook',
  'revocationWebhook',
]);

/**
 * Scan a parsed JSON value for a non-empty webhook authentication object.
 * Inspection-budget exhaustion fails closed by returning true.
 */
export function containsWebhookAuthentication(value: unknown, depthRemaining = WEBHOOK_AUTH_TRAVERSAL_DEPTH): boolean {
  if (depthRemaining <= 0) return true;
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    return value.some(item => containsWebhookAuthentication(item, depthRemaining - 1));
  }

  const obj = value as Record<string, unknown>;
  for (const key of WEBHOOK_AUTH_CONFIG_KEYS) {
    if (hasNonEmptyWebhookAuthentication(obj[key])) return true;
  }

  for (const [key, nested] of Object.entries(obj)) {
    if (WEBHOOK_AUTH_CONFIG_KEYS.has(key)) continue;
    if (containsWebhookAuthentication(nested, depthRemaining - 1)) return true;
  }
  return false;
}

function hasNonEmptyWebhookAuthentication(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const auth = (value as Record<string, unknown>).authentication;
  return !!auth && typeof auth === 'object' && !Array.isArray(auth) && Object.keys(auth).length > 0;
}
