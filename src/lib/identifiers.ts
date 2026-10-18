import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import type { PropertyIdentifierTypes } from './types/core.generated';

export type IdentifierValidationErrorCode =
  | 'invalid_identifier'
  | 'unsupported_identifier_type'
  | 'invalid_publisher_domain';

export class IdentifierValidationError extends TypeError {
  readonly name = 'IdentifierValidationError';
  constructor(
    readonly code: IdentifierValidationErrorCode,
    readonly identifierType: string,
    message: string
  ) {
    super(message);
  }
}

export interface IdentifierRewrite {
  from: string;
  to: string;
}

export type IdentifierValidationResult =
  | { ok: true; value: string; rewrite?: IdentifierRewrite }
  | { ok: false; error: IdentifierValidationError };

const PUBLISHER_DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

function isDomain(value: string): boolean {
  if (
    value.length > 253 ||
    !PUBLISHER_DOMAIN.test(value) ||
    value.split('.').some(label => label.length > 63) ||
    isIP(value)
  )
    return false;
  try {
    return !isIP(new URL(`https://${value}`).hostname);
  } catch {
    return false;
  }
}

function accepted(input: string, value: string): IdentifierValidationResult {
  return { ok: true, value, ...(input === value ? {} : { rewrite: { from: input, to: value } }) };
}

function rejected(
  type: string,
  code: IdentifierValidationErrorCode = 'invalid_identifier'
): IdentifierValidationResult {
  return {
    ok: false,
    error: new IdentifierValidationError(
      code,
      type,
      code === 'invalid_publisher_domain'
        ? 'publisher_domain must be a canonical lowercase hostname without wildcards, URLs, or IP addresses'
        : `Invalid ${type} identifier`
    ),
  };
}

/** Validate a registration hostname as supplied. This deliberately does not repair URLs or wildcards. */
export function validatePublisherDomain(value: string): IdentifierValidationResult {
  return typeof value === 'string' && isDomain(value)
    ? accepted(value, value)
    : rejected('publisher_domain', 'invalid_publisher_domain');
}

function normalizeHostname(input: string, type: 'domain' | 'subdomain'): IdentifierValidationResult {
  if (typeof input !== 'string') return rejected(type);
  let value = input.trim();
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.username || url.password) return rejected(type);
      value = url.hostname;
    } catch {
      return rejected(type);
    }
  }
  const wildcard = value.startsWith('*.');
  if (wildcard && type !== 'domain') return rejected(type);
  if (/[\s/\\:@?#%]/.test(wildcard ? value.slice(2) : value)) return rejected(type);
  const host = domainToASCII((wildcard ? value.slice(2) : value).toLowerCase().replace(/\.$/, ''));
  if (!isDomain(host)) return rejected(type);
  return accepted(input, `${wildcard ? '*.' : ''}${host}`);
}

export const normalizeDomainIdentifier = (value: string): IdentifierValidationResult =>
  normalizeHostname(value, 'domain');
export const normalizeSubdomainIdentifier = (value: string): IdentifierValidationResult =>
  normalizeHostname(value, 'subdomain');

function normalizePattern(type: string, input: string, pattern: RegExp, uppercase = false): IdentifierValidationResult {
  if (typeof input !== 'string') return rejected(type);
  const value = uppercase ? input.trim().toUpperCase() : input.trim();
  return pattern.test(value) ? accepted(input, value) : rejected(type);
}

/** Bundle identifiers are case-sensitive; normalization preserves their case. */
export const normalizeIosBundleIdentifier = (value: string): IdentifierValidationResult =>
  normalizePattern('ios_bundle', value, /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/);
export const normalizeAndroidPackageIdentifier = (value: string): IdentifierValidationResult =>
  normalizePattern('android_package', value, /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/);
export const normalizeAppleAppStoreIdentifier = (value: string): IdentifierValidationResult =>
  normalizePattern('apple_app_store_id', value, /^[1-9][0-9]*$/);
export const normalizeGooglePlayIdentifier = (value: string): IdentifierValidationResult =>
  normalizePattern('google_play_id', value, /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/);
export const normalizeRokuStoreIdentifier = (value: string): IdentifierValidationResult =>
  normalizePattern('roku_store_id', value, /^[1-9][0-9]*$/);
export const normalizeFireTvAsinIdentifier = (value: string): IdentifierValidationResult =>
  normalizePattern('fire_tv_asin', value, /^[A-Z0-9]{10}$/, true);
export const normalizeSamsungAppIdentifier = (value: string): IdentifierValidationResult =>
  normalizePattern('samsung_app_id', value, /^[A-Za-z0-9._-]+$/);
export const normalizeAppleTvBundleIdentifier = (value: string): IdentifierValidationResult =>
  normalizePattern('apple_tv_bundle', value, /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/);
export const normalizeBundleIdentifier = (value: string): IdentifierValidationResult =>
  normalizePattern('bundle_id', value, /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/);

/**
 * Validate and canonicalize an AdCP identifier. Opaque identifier families keep
 * their spelling and case; only surrounding whitespace is removed. No network
 * lookup or existence/ownership assertion is performed.
 */
export function normalizePropertyIdentifier(
  type: PropertyIdentifierTypes | string,
  value: string
): IdentifierValidationResult {
  switch (type) {
    case 'domain':
      return normalizeDomainIdentifier(value);
    case 'subdomain':
      return normalizeSubdomainIdentifier(value);
    case 'ios_bundle':
      return normalizeIosBundleIdentifier(value);
    case 'android_package':
      return normalizeAndroidPackageIdentifier(value);
    case 'apple_app_store_id':
      return normalizeAppleAppStoreIdentifier(value);
    case 'google_play_id':
      return normalizeGooglePlayIdentifier(value);
    case 'roku_store_id':
      return normalizeRokuStoreIdentifier(value);
    case 'fire_tv_asin':
      return normalizeFireTvAsinIdentifier(value);
    case 'samsung_app_id':
      return normalizeSamsungAppIdentifier(value);
    case 'apple_tv_bundle':
      return normalizeAppleTvBundleIdentifier(value);
    case 'bundle_id':
      return normalizeBundleIdentifier(value);
    case 'apple_podcast_id':
      return normalizePattern(type, value, /^[1-9][0-9]*$/);
    case 'rss_url': {
      if (typeof value !== 'string') return rejected(type);
      try {
        const url = new URL(value.trim());
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !isDomain(url.hostname))
          return rejected(type);
        return accepted(value, url.toString());
      } catch {
        return rejected(type);
      }
    }
    case 'network_id':
    case 'venue_id':
    case 'screen_id':
    case 'openooh_venue_type':
    case 'spotify_collection_id':
    case 'podcast_guid':
    case 'station_id':
    case 'facility_id':
      // The protocol defines these as opaque identifiers without a narrower grammar.
      return normalizePattern(type, value, /^[^\x00-\x1f\x7f]+$/);
    default:
      return rejected(type, 'unsupported_identifier_type');
  }
}

/** Validation includes the same explicit rewrite report as normalization. */
export const validatePropertyIdentifier = normalizePropertyIdentifier;

// Per-type validators expose the same canonical value/rewrite contract.
export const validateDomainIdentifier = normalizeDomainIdentifier;
export const validateSubdomainIdentifier = normalizeSubdomainIdentifier;
export const validateIosBundleIdentifier = normalizeIosBundleIdentifier;
export const validateAndroidPackageIdentifier = normalizeAndroidPackageIdentifier;
export const validateAppleAppStoreIdentifier = normalizeAppleAppStoreIdentifier;
export const validateGooglePlayIdentifier = normalizeGooglePlayIdentifier;
export const validateRokuStoreIdentifier = normalizeRokuStoreIdentifier;
export const validateFireTvAsinIdentifier = normalizeFireTvAsinIdentifier;
export const validateSamsungAppIdentifier = normalizeSamsungAppIdentifier;
export const validateAppleTvBundleIdentifier = normalizeAppleTvBundleIdentifier;
export const validateBundleIdentifier = normalizeBundleIdentifier;
