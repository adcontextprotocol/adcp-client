import { parse as parseTld } from 'tldts';

import { canonicalizeHost } from '../signing/agent-resolver/canonicalize';

const DOTTED_WIRE_DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const DEVELOPMENT_SUFFIXES = ['localhost', 'test', 'example', 'invalid'] as const;
const DEVELOPMENT_EXACT_NAMES = new Set(['example.com', 'example.net', 'example.org']);

export type BrandDomainValidationCode = 'invalid_syntax' | 'not_registrable' | 'special_use_not_allowed';

export class BrandDomainValidationError extends Error {
  constructor(
    readonly code: BrandDomainValidationCode,
    readonly domain: string
  ) {
    const messages: Record<BrandDomainValidationCode, string> = {
      invalid_syntax: 'Brand domain must be a bare, lowercase-compatible dotted hostname',
      not_registrable: 'Brand domain must have a registrable public or private-suffix domain',
      special_use_not_allowed: 'IANA special-use brand domain is not allowed in production',
    };
    super(messages[code]);
    this.name = 'BrandDomainValidationError';
  }
}

export interface ValidateBrandDomainOptions {
  /**
   * Admit the protocol's narrow development-name set: subdomains of
   * `.localhost`, `.test`, `.example`, or `.invalid`, plus the reserved
   * `example.com`, `example.net`, and `example.org` names. Default false.
   *
   * This option is deliberately explicit and is never inferred from
   * `NODE_ENV`. Bare `localhost` remains invalid because BrandRef wire syntax
   * always requires a dotted domain. `.local` remains forbidden because it
   * participates in multicast DNS.
   */
  allowDevelopmentDomains?: boolean;
}

/**
 * Validate and canonicalize a BrandRef/BrandKey domain.
 *
 * The JSON Schema enforces portable dotted wire syntax. This helper adds the
 * runtime policy needed before brand discovery: a production name must have a
 * registrable domain in the pinned ICANN+PRIVATE Public Suffix List and must
 * not be an IANA special-use name.
 */
export function validateBrandDomain(domain: string, options: ValidateBrandDomainOptions = {}): string {
  if (typeof domain !== 'string' || domain.length === 0 || /[\s/:@?#]/.test(domain)) {
    throw new BrandDomainValidationError('invalid_syntax', domain);
  }

  let canonical: string;
  try {
    canonical = canonicalizeHost(domain);
  } catch {
    throw new BrandDomainValidationError('invalid_syntax', domain);
  }
  if (!DOTTED_WIRE_DOMAIN.test(canonical)) {
    throw new BrandDomainValidationError('invalid_syntax', domain);
  }

  const developmentName = isDevelopmentBrandDomain(canonical);
  if (developmentName && options.allowDevelopmentDomains === true) return canonical;

  const parsed = parseTld(canonical, {
    allowPrivateDomains: true,
    detectSpecialUse: true,
    extractHostname: false,
  });
  if (parsed.isSpecialUse || developmentName) {
    throw new BrandDomainValidationError('special_use_not_allowed', domain);
  }
  if (parsed.isIp || !parsed.domain || (!parsed.isIcann && !parsed.isPrivate)) {
    throw new BrandDomainValidationError('not_registrable', domain);
  }
  return canonical;
}

export function isDevelopmentBrandDomain(domain: string): boolean {
  if (DEVELOPMENT_EXACT_NAMES.has(domain)) return true;
  return DEVELOPMENT_SUFFIXES.some(suffix => domain.endsWith(`.${suffix}`));
}
