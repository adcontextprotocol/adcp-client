/** Optional receiver account authorization, separate from agent origin binding. */
import type { ResolveAgentOptions } from './resolve-agent';

interface ActiveOperatorDelegation {
  validUntil?: number;
}

const AUTHORIZED_OPERATOR_SCOPES = new Set<string>([
  'all',
  'media_buying',
  'creative_generation',
  'rights_clearance',
  'governance',
  'measurement',
  'agent_operations',
]);
const AUTHORIZED_OPERATOR_DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/**
 * Evaluate the complete cross-origin delegation tuple. Domain matching is
 * against the exact agent eTLD+1 to match step 3 of the
 * discovery algorithm; brand, activity, country, and time remain independent
 * authorization dimensions and must all match the same entry.
 */
export function checkDelegatedOperatorAuthorization(
  brandJson: unknown,
  agentEtld1: string,
  now: number,
  options: Pick<
    ResolveAgentOptions,
    'requiredOperatorBrand' | 'requiredOperatorScope' | 'requiredOperatorCountry' | 'allowPrivateIp'
  >
): ActiveOperatorDelegation | undefined {
  if (!brandJson || typeof brandJson !== 'object') return undefined;
  const operators = (brandJson as { authorized_operators?: unknown }).authorized_operators;
  if (!Array.isArray(operators)) return undefined;
  let latestValidUntil: number | undefined;
  let matched = false;
  for (const op of operators) {
    if (!op || typeof op !== 'object' || Array.isArray(op)) continue;
    const candidate = op as Record<string, unknown>;
    const domain = candidate.domain;
    const brands = candidate.brands;
    if (typeof domain !== 'string' || !AUTHORIZED_OPERATOR_DOMAIN.test(domain) || !isValidBrandGrant(brands)) {
      continue;
    }
    if (domain !== agentEtld1) continue;

    const scopes = candidate.scopes;
    if (scopes !== undefined && !isValidScopeGrant(scopes)) continue;
    const countries = candidate.countries;
    if (countries !== undefined && !isValidCountryGrant(countries)) continue;

    const validFrom = parseOptionalRfc3339(candidate.valid_from);
    const validUntil = parseOptionalRfc3339(candidate.valid_until);
    if (validFrom === null || validUntil === null) continue;
    if (validFrom !== undefined && validUntil !== undefined && validFrom >= validUntil) continue;
    if (validFrom !== undefined && now < validFrom) continue;
    if (validUntil !== undefined && now >= validUntil) continue;

    if (!matchesGrant(brands, options.requiredOperatorBrand, '*')) continue;
    if (scopes !== undefined && !matchesGrant(scopes, options.requiredOperatorScope, 'all')) continue;
    if (countries !== undefined && !matchesGrant(countries, options.requiredOperatorCountry)) continue;

    matched = true;
    // Any unbounded active sibling keeps the same authorization tuple active.
    if (validUntil === undefined) return {};
    latestValidUntil = Math.max(latestValidUntil ?? Number.NEGATIVE_INFINITY, validUntil);
  }
  return matched ? { validUntil: latestValidUntil } : undefined;
}

function isValidBrandGrant(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(item => typeof item === 'string' && (item === '*' || /^[a-z0-9_]+$/.test(item)))
  );
}

function isValidScopeGrant(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    new Set(value).size === value.length &&
    value.every(item => typeof item === 'string' && AUTHORIZED_OPERATOR_SCOPES.has(item))
  );
}

function isValidCountryGrant(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && /^[A-Z]{2}$/.test(item));
}

function matchesGrant(grants: readonly string[], required: string | undefined, wildcard?: string): boolean {
  if (wildcard !== undefined && grants.includes(wildcard)) return true;
  return required !== undefined && grants.includes(required);
}

function parseOptionalRfc3339(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|([+-])(\d{2}):(\d{2}))$/.exec(
    value
  );
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return null;
  }
  const parsed = Date.parse(value) / 1000;
  return Number.isFinite(parsed) ? parsed : null;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
