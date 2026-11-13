/**
 * Response-boundary projection for resolved reporting delivery configuration
 * states. The protocol deliberately makes these records secret-free: they
 * describe a seller's resolved delivery state, not the credentials used to
 * reach the delivery destination.
 */
import type { ReportingDeliveryConfigurationState } from '../types/tools.generated';
import { getSchemaValidatorByRef } from '../validation/schema-loader';
import { retainsNonResponseAccountMember } from './account-response-identity';

const MAX_REPORTING_DELIVERY_CONFIGS = 16;
const CREDENTIAL_LIKE_URL_COMPONENT =
  /\b(?:access[_-]?token|api[_-]?key|assertion|authorization|bearer|code|credential|password|passwd|secret|session|signature|token|x-amz-credential|x-amz-security-token|x-amz-signature)\b/i;

function isCredentialLikeUrlComponent(value: string): boolean {
  try {
    return CREDENTIAL_LIKE_URL_COMPONENT.test(decodeURIComponent(value));
  } catch {
    return CREDENTIAL_LIKE_URL_COMPONENT.test(value);
  }
}

function assertSafeSetupUrl(value: unknown): void {
  if (typeof value !== 'string') return;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // The raw schema supplies the normal malformed-URL diagnostic. This guard
    // only adds the protocol's credential-bearing URL constraint.
    return;
  }

  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('reporting_delivery_configs setup.url must not contain credentials');
  }
  for (const [key, queryValue] of url.searchParams) {
    if (isCredentialLikeUrlComponent(key) || isCredentialLikeUrlComponent(queryValue)) {
      throw new Error('reporting_delivery_configs setup.url must not contain credential-like query parameters');
    }
  }
  if (url.hash && isCredentialLikeUrlComponent(url.hash.slice(1))) {
    throw new Error('reporting_delivery_configs setup.url must not contain credential-like fragments');
  }
}

/**
 * Validate resolved reporting delivery states before placing them in a wire
 * response. This remains necessary when an adopter disables whole-response
 * validation in production. Credentials accidentally retained by a handler or
 * persistence model fail closed, so they never reach a buyer or an
 * idempotency/replay cache. AdCP 3.3.0-beta.6 opened these schemas
 * (adcontextprotocol/adcp#8866), so schema validation alone no longer rejects
 * an unknown member; a credential-shaped key or SDK-internal field anywhere in
 * the record is refused explicitly.
 */
export function projectReportingDeliveryConfigStates(
  states: readonly ReportingDeliveryConfigurationState[]
): ReportingDeliveryConfigurationState[] {
  if (!Array.isArray(states) || states.length > MAX_REPORTING_DELIVERY_CONFIGS) {
    throw new Error(`reporting_delivery_configs must contain at most ${MAX_REPORTING_DELIVERY_CONFIGS} state records`);
  }

  const validateState = getSchemaValidatorByRef('core/reporting-delivery-config-state.json');
  if (!validateState) {
    throw new Error('Bundled schema core/reporting-delivery-config-state.json is unavailable');
  }

  // Check and emit the same detached snapshots, so a later mutation (or a
  // toJSON) cannot change what is sent after the check.
  const snapshots = states.map(state => structuredClone(state));
  for (const state of snapshots) {
    if (!validateState(state) || retainsNonResponseAccountMember(state)) {
      throw new Error('reporting_delivery_configs contains a state that is not a valid secret-free protocol record');
    }
    assertSafeSetupUrl((state as { setup?: { url?: unknown } }).setup?.url);
  }

  return snapshots;
}
