import { parse as parseTld } from 'tldts';

import { ssrfSafeFetch, type SsrfFetchOptions, type SsrfFetchResult } from '../net/ssrf-fetch';
import { isInternalProbesAllowed } from '../utils/probe-policy';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_WELL_KNOWN_REDIRECT_HOPS = 3;

export type AdAgentsRedirectRefusalCode =
  | 'redirect_refused'
  | 'redirect_missing_location'
  | 'redirect_scheme_changed'
  | 'redirect_cross_registrable_domain'
  | 'redirect_userinfo_not_allowed'
  | 'redirect_too_many';

export class AdAgentsRedirectRefusedError extends Error {
  readonly code: AdAgentsRedirectRefusalCode;
  readonly url: string;
  readonly location?: string;

  constructor(code: AdAgentsRedirectRefusalCode, message: string, meta: { url: string; location?: string }) {
    super(message);
    this.name = 'AdAgentsRedirectRefusedError';
    this.code = code;
    this.url = meta.url;
    this.location = meta.location;
  }
}

export type AdAgentsRedirectPolicy =
  | { mode: 'none' }
  | { mode: 'same-registrable-domain'; originUrl: string; maxRedirects?: number };

export async function ssrfSafeFetchAdAgents(
  url: string,
  options: SsrfFetchOptions,
  policy: AdAgentsRedirectPolicy
): Promise<SsrfFetchResult> {
  let currentUrl = url;
  let redirects = 0;
  const originUrl = policy.mode === 'same-registrable-domain' ? policy.originUrl : url;
  const maxRedirects =
    policy.mode === 'same-registrable-domain' ? (policy.maxRedirects ?? DEFAULT_WELL_KNOWN_REDIRECT_HOPS) : 0;

  while (true) {
    const result = await ssrfSafeFetch(currentUrl, options);
    if (!REDIRECT_STATUSES.has(result.status)) return result;

    const location = result.headers['location'];
    if (!location) {
      throw new AdAgentsRedirectRefusedError(
        'redirect_missing_location',
        `HTTP ${result.status} redirect with no Location header`,
        { url: currentUrl }
      );
    }

    let next: URL;
    try {
      next = new URL(location, currentUrl);
    } catch {
      throw new AdAgentsRedirectRefusedError('redirect_refused', 'Invalid adagents.json redirect URL', {
        url: currentUrl,
      });
    }
    const nextUrl = next.toString();
    if (next.username || next.password) {
      throw new AdAgentsRedirectRefusedError(
        'redirect_userinfo_not_allowed',
        'adagents.json redirect must not include userinfo',
        { url: currentUrl, location: scrubUrl(next) }
      );
    }

    if (policy.mode === 'none') {
      throw new AdAgentsRedirectRefusedError(
        'redirect_refused',
        'Redirect refused while fetching authoritative adagents.json',
        { url: currentUrl, location: scrubUrl(next) }
      );
    }

    if (redirects >= maxRedirects) {
      throw new AdAgentsRedirectRefusedError(
        'redirect_too_many',
        `Too many adagents.json redirects; maximum is ${maxRedirects}`,
        { url: currentUrl, location: scrubUrl(next) }
      );
    }

    validateSameRegistrableDomainRedirect(originUrl, currentUrl, nextUrl);
    redirects++;
    currentUrl = nextUrl;
  }
}

export function validateSameRegistrableDomainRedirect(originUrl: string, currentUrl: string, nextUrl: string): void {
  let origin: URL;
  let current: URL;
  let next: URL;
  try {
    origin = new URL(originUrl);
    current = new URL(currentUrl);
    next = new URL(nextUrl);
  } catch {
    throw new AdAgentsRedirectRefusedError('redirect_refused', 'Invalid adagents.json redirect URL', {
      url: currentUrl,
    });
  }

  if (next.protocol !== origin.protocol) {
    throw new AdAgentsRedirectRefusedError('redirect_scheme_changed', 'adagents.json redirect changed scheme', {
      url: currentUrl,
      location: scrubUrl(next),
    });
  }

  if (!sameRegistrableDomain(origin, next)) {
    throw new AdAgentsRedirectRefusedError(
      'redirect_cross_registrable_domain',
      'adagents.json redirect crosses registrable domain',
      { url: currentUrl, location: scrubUrl(next) }
    );
  }
}

export function sameRegistrableDomain(a: URL, b: URL): boolean {
  const aDomain = registrableDomain(a.hostname);
  const bDomain = registrableDomain(b.hostname);
  if (aDomain && bDomain) return aDomain === bDomain;

  // Loopback tests run through http://127.0.0.1 under the explicit internal
  // probe opt-in. Production publisher discovery should not treat IP literals
  // as registrable domains.
  return isInternalProbesAllowed() && a.hostname === b.hostname;
}

function registrableDomain(hostname: string): string | null {
  const parsed = parseTld(hostname, { allowPrivateDomains: true });
  if (parsed.isIp || !parsed.domain) return null;
  return parsed.domain.toLowerCase();
}

function scrubUrl(url: URL): string {
  const scrubbed = new URL(url.toString());
  scrubbed.username = '';
  scrubbed.password = '';
  scrubbed.search = '';
  scrubbed.hash = '';
  return scrubbed.toString();
}
