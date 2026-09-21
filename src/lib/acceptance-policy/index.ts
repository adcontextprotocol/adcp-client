/**
 * Buyer-side resolution of seller acceptance-policy catalogs.
 *
 * Catalog discovery is advisory. A successfully resolved catalog describes
 * likely seller treatment; it never authorizes an exact media-buy request.
 */

import type { ErrorObject } from 'ajv';
import { canonicalJsonSha256 } from '../utils/jcs';
import { resolveCanonicalReference, type CanonicalReferenceFailureResult } from '../canonical-references';
import { getSchemaValidatorByRef } from '../validation/schema-loader';
import { ADCP_VERSION } from '../version';
import { isWellFormedUnicodeString } from '../utils/well-formed-unicode';
import type { ResolvePolicyResponse } from '../registry/types';

export { assessAcceptancePolicy } from './evaluator';

const CATALOG_SCHEMA_REF = 'media-buy/acceptance-policy-catalog.json';
const PROFILE_SCHEMA_REF = 'media-buy/acceptance-policy-profile.json';
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const MAX_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_CANONICAL_JSON_DEPTH = 128;
const MAX_CATALOG_JSON_DEPTH = 256;
const MAX_CATALOG_JSON_NODES = 100_000;
const MAX_CATALOG_JSON_STRING_CODE_UNITS = 1024 * 1024;
const DEFAULT_MAX_REGISTRY_PROFILES = 32;
const MAX_REGISTRY_PROFILES = 32;
const MAX_REGISTRY_CONCURRENCY = 4;
const MAX_SELECTED_PROFILE_IDS = 1024;
const MAX_REGISTRY_JSON_NODES = 50_000;
const MAX_REGISTRY_JSON_STRING_CODE_UNITS = 256 * 1024;

export interface AcceptancePolicyDiscoveryCapability {
  catalog_url: string;
  catalog_digest: string;
  default_profile_ids?: readonly string[];
}

export interface AcceptancePolicyReference {
  policy_id: string;
  version: string;
  content_digest: string;
}

export interface AcceptancePolicyRequirement {
  kind:
    | 'category_declaration'
    | 'advertiser_verification'
    | 'advertiser_eligibility'
    | 'funding_restriction'
    | 'certification'
    | 'license'
    | 'prior_authorization'
    | 'account_setup'
    | 'sales_assisted'
    | 'disclosure'
    | 'targeting_restriction'
    | 'creative_restriction'
    | 'destination_restriction'
    | 'format_restriction'
    | 'time_restriction'
    | 'transparency_reporting'
    | 'custom';
  [key: string]: unknown;
}

export type AcceptancePolicySurface =
  | 'account'
  | 'media_buy'
  | 'creative'
  | 'landing_page'
  | 'targeting'
  | 'delivery'
  | 'format';

export interface AcceptancePolicyRule {
  rule_id: string;
  subject_category: string;
  subject_facets?: string[];
  advertiser_roles?: string[];
  jurisdictions?: string[];
  jurisdiction_groups?: string[];
  applies_to: string[];
  disposition: 'allowed' | 'conditional' | 'prohibited';
  requirements?: AcceptancePolicyRequirement[];
  policy_ids?: string[];
  effective_at?: string;
  expires_at?: string;
  [key: string]: unknown;
}

export interface AcceptancePolicyProfile {
  profile_id: string;
  version: string;
  content_digest: string;
  policy_refs: AcceptancePolicyReference[];
  coverage: 'partial' | 'complete';
  scope?: {
    subject_categories?: string[];
    applies_to?: string[];
    jurisdictions?: string[];
    jurisdiction_groups?: string[];
    all_jurisdictions?: true;
    [key: string]: unknown;
  };
  region_aliases?: Record<string, string[]>;
  rules: AcceptancePolicyRule[];
  [key: string]: unknown;
}

export interface RegistryAcceptancePolicyProfileReference {
  policy_id: string;
  policy_version: string;
  policy_digest: string;
  profile_id: string;
  profile_version: string;
  profile_digest: string;
}

export interface AcceptancePolicyCatalog {
  catalog_version: string;
  generated_at?: string;
  profiles?: AcceptancePolicyProfile[];
  registry_profiles?: RegistryAcceptancePolicyProfileReference[];
  ext?: Record<string, unknown>;
}

export type ResolvedAcceptancePolicyDefault =
  | {
      source: 'seller';
      resolution: 'resolved';
      profileId: string;
      profile: AcceptancePolicyProfile;
    }
  | {
      source: 'registry';
      resolution: 'resolved';
      profileId: string;
      profile: AcceptancePolicyProfile;
      ref: RegistryAcceptancePolicyProfileReference;
    }
  | {
      source: 'registry';
      resolution: 'unresolved';
      profileId: string;
      ref: RegistryAcceptancePolicyProfileReference;
    };

export type AcceptancePolicyProfileResolution =
  | ResolvedAcceptancePolicyDefault
  | { source: 'catalog'; resolution: 'missing'; profileId: string };

export type AcceptancePolicyCatalogErrorCode =
  | 'invalid_capability'
  | 'invalid_options'
  | 'unsafe_url'
  | 'redirect_blocked'
  | 'fetch_failed'
  | 'http_error'
  | 'body_too_large'
  | 'digest_mismatch'
  | 'invalid_json'
  | 'catalog_document_invalid'
  | 'schema_unavailable'
  | 'schema_invalid'
  | 'duplicate_profile_id'
  | 'unresolved_profile_id'
  | 'profile_canonicalization_invalid'
  | 'profile_digest_mismatch'
  | 'reference_invalid'
  | 'registry_fetch_failed'
  | 'registry_reference_unresolved'
  | 'registry_policy_mismatch'
  | 'registry_policy_unverifiable'
  | 'registry_policy_digest_mismatch'
  | 'registry_profile_schema_invalid'
  | 'registry_profile_invalid'
  | 'registry_profile_mismatch'
  | 'registry_profile_digest_mismatch'
  | 'registry_resolution_limit_exceeded'
  | 'registry_timeout';

export interface AcceptancePolicyCatalogIssue {
  code: AcceptancePolicyCatalogErrorCode;
  message: string;
  /** JSON Pointer into the capability or catalog. Values are never echoed. */
  pointer: string;
  keyword?: string;
  retryable?: boolean;
  httpStatus?: number;
}

export interface AcceptancePolicyCatalogFailure {
  ok: false;
  fromCache: false;
  error: AcceptancePolicyCatalogIssue;
  issues?: AcceptancePolicyCatalogIssue[];
}

export interface AcceptancePolicyCatalogSuccess {
  ok: true;
  fromCache: boolean;
  catalog: AcceptancePolicyCatalog;
  defaultProfiles: ResolvedAcceptancePolicyDefault[];
  /** Non-fatal registry diagnostics. Affected profiles remain unresolved. */
  issues?: AcceptancePolicyCatalogIssue[];
}

export type AcceptancePolicyCatalogResult = AcceptancePolicyCatalogSuccess | AcceptancePolicyCatalogFailure;

/** Registry fields covered by acceptance-policy pin verification. */
export type AcceptancePolicyRegistryPolicy = Pick<
  ResolvePolicyResponse,
  'policy_id' | 'version' | 'content_digest' | 'canonical_content' | 'acceptance_profile'
>;

/** Minimal trusted-registry surface needed to resolve an immutable policy version. */
export interface AcceptancePolicyRegistryResolver {
  resolvePolicy(params: {
    policy_id: string;
    version?: string;
    signal?: AbortSignal;
  }): Promise<AcceptancePolicyRegistryPolicy | null>;
}

export interface ResolveVerifiedAcceptancePolicyProfilesOptions {
  registryResolver: AcceptancePolicyRegistryResolver;
  /** Schema bundle used to validate embedded profiles. Defaults to the SDK pin. */
  adcpVersion?: string;
  /** Overall deadline for all selected registry lookups. Default 5 seconds. */
  timeoutMs?: number;
  /** Maximum distinct registry profiles resolved in one call. Default and maximum 32. */
  maxRegistryProfiles?: number;
}

export interface VerifiedAcceptancePolicyProfilesSuccess {
  ok: true;
  profiles: AcceptancePolicyProfileResolution[];
  /** Per-profile failures. Each affected registry profile remains unresolved. */
  issues?: AcceptancePolicyCatalogIssue[];
}

export type VerifiedAcceptancePolicyProfilesResult =
  | VerifiedAcceptancePolicyProfilesSuccess
  | AcceptancePolicyCatalogFailure;

export interface ResolveAcceptancePolicyCatalogOptions {
  /** Schema bundle used to validate the fetched catalog. Defaults to the SDK pin. */
  adcpVersion?: string;
  /** Overall DNS/connect/body timeout for the catalog fetch. Default 5 seconds. */
  timeoutMs?: number;
  /** Hard response-body cap. Default and maximum 1 MiB; callers may lower it. */
  maxBodyBytes?: number;
  /** Test/dev-only HTTP opt-in; requires allowPrivateNetwork. Production callers must leave false. */
  allowUnsafeHttp?: boolean;
  /** Test/dev-only opt-in for private-network fixtures. Production callers must leave false. */
  allowPrivateNetwork?: boolean;
  /** Trusted AdCP registry client used to resolve and verify registry-backed defaults. */
  registryResolver?: AcceptancePolicyRegistryResolver;
  /** Overall deadline for registry resolution. Default 5 seconds. */
  registryTimeoutMs?: number;
  /** Maximum registry-backed defaults resolved in one call. Default and maximum 32. */
  maxRegistryProfiles?: number;
}

export interface AcceptancePolicyCatalogResolver {
  /**
   * Resolve the currently advertised catalog. A capability change atomically
   * invalidates the resolver's single-entry cache before the next fetch.
   */
  resolve(capability: AcceptancePolicyDiscoveryCapability): Promise<AcceptancePolicyCatalogResult>;
  /** Explicit invalidation hook for a capabilities-changed notification. */
  invalidate(): void;
}

function issue(
  code: AcceptancePolicyCatalogErrorCode,
  message: string,
  pointer: string,
  options: { keyword?: string; retryable?: boolean; httpStatus?: number } = {}
): AcceptancePolicyCatalogIssue {
  return {
    code,
    message,
    pointer,
    ...(options.keyword !== undefined && { keyword: options.keyword }),
    ...(options.retryable !== undefined && { retryable: options.retryable }),
    ...(options.httpStatus !== undefined && { httpStatus: options.httpStatus }),
  };
}

function fail(
  error: AcceptancePolicyCatalogIssue,
  issues?: AcceptancePolicyCatalogIssue[]
): AcceptancePolicyCatalogFailure {
  return { ok: false, fromCache: false, error, ...(issues !== undefined && { issues }) };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneCatalog(catalog: AcceptancePolicyCatalog): AcceptancePolicyCatalog {
  return cloneJson(catalog);
}

function cloneSuccess(result: AcceptancePolicyCatalogSuccess, fromCache: boolean): AcceptancePolicyCatalogSuccess {
  const catalog = cloneCatalog(result.catalog);
  const sellerProfiles = new Map((catalog.profiles ?? []).map(profile => [profile.profile_id, profile]));
  const registryRefs = new Map((catalog.registry_profiles ?? []).map(ref => [ref.profile_id, ref]));
  const registryProfiles = new Map<string, AcceptancePolicyProfile>();
  return {
    ok: true,
    fromCache,
    catalog,
    ...(result.issues !== undefined && {
      // cloneSuccess is used only by the capability-lifetime resolver. Its
      // cached success cannot retry registry work until invalidate().
      issues: cloneJson(
        result.issues.map(value => (value.retryable === true ? { ...value, retryable: false } : value))
      ),
    }),
    defaultProfiles: result.defaultProfiles.map(value => {
      if (value.source === 'seller') {
        return { ...value, profile: sellerProfiles.get(value.profileId) ?? cloneJson(value.profile) };
      }
      const ref = registryRefs.get(value.profileId) ?? cloneJson(value.ref);
      if (value.resolution === 'resolved') {
        let profile = registryProfiles.get(value.profileId);
        if (!profile) {
          profile = cloneJson(value.profile);
          registryProfiles.set(value.profileId, profile);
        }
        return { ...value, ref, profile };
      }
      return { ...value, ref };
    }),
  };
}

function snapshotCapability(capability: AcceptancePolicyDiscoveryCapability): AcceptancePolicyDiscoveryCapability {
  const snapshot = { ...capability };
  if (Array.isArray(snapshot.default_profile_ids)) {
    snapshot.default_profile_ids = [...snapshot.default_profile_ids];
  }
  return snapshot;
}

function validateCapability(
  capability: AcceptancePolicyDiscoveryCapability,
  options: ResolveAcceptancePolicyCatalogOptions
): AcceptancePolicyCatalogIssue | undefined {
  if (!capability || typeof capability.catalog_url !== 'string' || typeof capability.catalog_digest !== 'string') {
    return issue(
      'invalid_capability',
      'Acceptance-policy discovery must provide catalog_url and catalog_digest strings',
      '/media_buy/acceptance_policy_discovery'
    );
  }
  if (!DIGEST_RE.test(capability.catalog_digest)) {
    return issue(
      'invalid_capability',
      'catalog_digest must be sha256 followed by 64 lowercase hexadecimal characters',
      '/media_buy/acceptance_policy_discovery/catalog_digest'
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(capability.catalog_url);
  } catch {
    return issue('unsafe_url', 'catalog_url is not a valid URL', '/media_buy/acceptance_policy_discovery/catalog_url');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return issue(
      'unsafe_url',
      'catalog_url must not contain URL credentials',
      '/media_buy/acceptance_policy_discovery/catalog_url'
    );
  }
  const unsafeHttpAllowed = options.allowUnsafeHttp === true && parsed.protocol === 'http:';
  if (parsed.protocol !== 'https:' && !unsafeHttpAllowed) {
    return issue('unsafe_url', 'catalog_url must use HTTPS', '/media_buy/acceptance_policy_discovery/catalog_url');
  }

  const defaults = capability.default_profile_ids;
  if (defaults !== undefined) {
    if (
      !Array.isArray(defaults) ||
      defaults.length === 0 ||
      defaults.length > MAX_SELECTED_PROFILE_IDS ||
      defaults.some(value => typeof value !== 'string' || value.length === 0)
    ) {
      return issue(
        'invalid_capability',
        `default_profile_ids must contain 1-${MAX_SELECTED_PROFILE_IDS} non-empty strings`,
        '/media_buy/acceptance_policy_discovery/default_profile_ids'
      );
    }
    if (new Set(defaults).size !== defaults.length) {
      return issue(
        'invalid_capability',
        'default_profile_ids must be unique',
        '/media_buy/acceptance_policy_discovery/default_profile_ids'
      );
    }
  }
  return undefined;
}

function validateOptions(options: ResolveAcceptancePolicyCatalogOptions): AcceptancePolicyCatalogIssue | undefined {
  if (
    options.registryResolver !== undefined &&
    (options.registryResolver === null || typeof options.registryResolver.resolvePolicy !== 'function')
  ) {
    return issue(
      'invalid_options',
      'registryResolver must provide a resolvePolicy function',
      '/options/registryResolver'
    );
  }
  if (options.allowUnsafeHttp === true && options.allowPrivateNetwork !== true) {
    return issue(
      'invalid_options',
      'allowUnsafeHttp requires allowPrivateNetwork and is only intended for local test fixtures',
      '/options/allowUnsafeHttp'
    );
  }
  if (
    options.timeoutMs !== undefined &&
    (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > MAX_TIMEOUT_MS)
  ) {
    return issue(
      'invalid_options',
      `timeoutMs must be a positive safe integer no greater than ${MAX_TIMEOUT_MS}`,
      '/options/timeoutMs'
    );
  }
  if (
    options.registryTimeoutMs !== undefined &&
    (!Number.isSafeInteger(options.registryTimeoutMs) ||
      options.registryTimeoutMs <= 0 ||
      options.registryTimeoutMs > MAX_TIMEOUT_MS)
  ) {
    return issue(
      'invalid_options',
      `registryTimeoutMs must be a positive safe integer no greater than ${MAX_TIMEOUT_MS}`,
      '/options/registryTimeoutMs'
    );
  }
  if (
    options.maxRegistryProfiles !== undefined &&
    (!Number.isSafeInteger(options.maxRegistryProfiles) ||
      options.maxRegistryProfiles <= 0 ||
      options.maxRegistryProfiles > MAX_REGISTRY_PROFILES)
  ) {
    return issue(
      'invalid_options',
      `maxRegistryProfiles must be a positive safe integer no greater than ${MAX_REGISTRY_PROFILES}`,
      '/options/maxRegistryProfiles'
    );
  }
  if (
    options.maxBodyBytes !== undefined &&
    (!Number.isSafeInteger(options.maxBodyBytes) || options.maxBodyBytes <= 0 || options.maxBodyBytes > MAX_BODY_BYTES)
  ) {
    return issue(
      'invalid_options',
      `maxBodyBytes must be a positive safe integer no greater than ${MAX_BODY_BYTES}`,
      '/options/maxBodyBytes'
    );
  }
  return undefined;
}

function translateFetchFailure(result: CanonicalReferenceFailureResult): AcceptancePolicyCatalogFailure {
  const pointer = '/media_buy/acceptance_policy_discovery/catalog_url';
  const transport = { retryable: result.error.retryable, httpStatus: result.httpStatus };
  switch (result.error.code) {
    case 'redirect_blocked':
      return fail(issue('redirect_blocked', 'Acceptance-policy catalog redirects are disabled', pointer, transport));
    case 'body_too_large':
      return fail(
        issue('body_too_large', 'Acceptance-policy catalog exceeded the configured byte limit', pointer, transport)
      );
    case 'digest_mismatch':
      return fail(
        issue(
          'digest_mismatch',
          'Acceptance-policy catalog digest did not match the exact response bytes',
          '/media_buy/acceptance_policy_discovery/catalog_digest',
          transport
        )
      );
    case 'invalid_json':
      return fail(issue('invalid_json', 'Acceptance-policy catalog is not valid JSON', '/', transport));
    case 'document_too_deep':
      return fail(
        issue('catalog_document_invalid', 'Acceptance-policy catalog exceeds the safe JSON depth limit', '/', transport)
      );
    case 'http_error':
      return fail(
        issue('http_error', 'Acceptance-policy catalog returned a non-success HTTP status', pointer, transport)
      );
    case 'non_https_url':
    case 'unsafe_url':
    case 'invalid_ref':
      return fail(
        issue('unsafe_url', 'Acceptance-policy catalog URL was blocked by remote-resolution policy', pointer, transport)
      );
    default:
      return fail(issue('fetch_failed', 'Acceptance-policy catalog could not be fetched', pointer, transport));
  }
}

const SAFE_POINTER_SEGMENTS = new Set([
  'profiles',
  'registry_profiles',
  'catalog_version',
  'generated_at',
  'ext',
  'profile_id',
  'profile_version',
  'profile_digest',
  'version',
  'content_digest',
  'policy_id',
  'policy_version',
  'policy_digest',
  'policy_refs',
  'coverage',
  'scope',
  'region_aliases',
  'description',
  'rules',
  'rule_id',
  'subject_category',
  'subject_categories',
  'subject_facets',
  'advertiser_roles',
  'jurisdictions',
  'jurisdiction_groups',
  'all_jurisdictions',
  'applies_to',
  'disposition',
  'requirements',
  'policy_ids',
  'effective_at',
  'expires_at',
]);

const ARRAY_POINTER_SEGMENTS = new Set([
  'profiles',
  'registry_profiles',
  'policy_refs',
  'rules',
  'subject_categories',
  'subject_facets',
  'advertiser_roles',
  'jurisdictions',
  'jurisdiction_groups',
  'applies_to',
  'policy_ids',
]);

function sanitizePointer(pointer: string): string {
  if (!pointer || pointer === '/') return '/';
  let numericIndexAllowed = false;
  let regionAliasKeyExpected = false;
  const sanitized = pointer
    .split('/')
    .map((segment, index) => {
      if (index === 0) return segment;
      if (regionAliasKeyExpected) {
        regionAliasKeyExpected = false;
        numericIndexAllowed = true;
        return '<property>';
      }
      if (/^\d+$/.test(segment)) {
        const safe = numericIndexAllowed;
        numericIndexAllowed = false;
        return safe ? segment : '<property>';
      }
      if (SAFE_POINTER_SEGMENTS.has(segment)) {
        regionAliasKeyExpected = segment === 'region_aliases';
        numericIndexAllowed = ARRAY_POINTER_SEGMENTS.has(segment);
        return segment;
      }
      numericIndexAllowed = false;
      return '<property>';
    })
    .join('/');
  return sanitized.length <= 256 ? sanitized : `${sanitized.slice(0, 244)}/<truncated>`;
}

function schemaIssues(errors: ErrorObject[] | null | undefined): AcceptancePolicyCatalogIssue[] {
  return (errors ?? []).map(error =>
    issue(
      'schema_invalid',
      `Acceptance-policy catalog failed schema validation: ${error.message ?? 'validation failed'}`,
      sanitizePointer(error.instancePath || '/'),
      { keyword: error.keyword }
    )
  );
}

function semanticIssues(
  catalog: AcceptancePolicyCatalog,
  defaultProfileIds: readonly string[]
): AcceptancePolicyCatalogIssue[] {
  const issues: AcceptancePolicyCatalogIssue[] = [];
  // Keep diagnostics bounded even when a hostile, schema-valid catalog
  // repeats the same semantic defect thousands of times.
  const record = (value: AcceptancePolicyCatalogIssue): void => {
    if (issues.length < 32) issues.push(value);
  };
  const seenProfiles = new Set<string>();
  const allProfiles = [
    ...(catalog.profiles ?? []).map((profile, index) => ({ profile, pointer: `/profiles/${index}` })),
    ...(catalog.registry_profiles ?? []).map((profile, index) => ({
      profile,
      pointer: `/registry_profiles/${index}`,
    })),
  ];

  for (const entry of allProfiles) {
    if (seenProfiles.has(entry.profile.profile_id)) {
      record(
        issue(
          'duplicate_profile_id',
          'A profile_id must occur at most once across seller and registry profile lists',
          `${entry.pointer}/profile_id`
        )
      );
    }
    seenProfiles.add(entry.profile.profile_id);
  }

  for (const [index, profileId] of defaultProfileIds.entries()) {
    if (!seenProfiles.has(profileId)) {
      record(
        issue(
          'unresolved_profile_id',
          'An advertised default profile does not resolve in the catalog',
          `/media_buy/acceptance_policy_discovery/default_profile_ids/${index}`
        )
      );
    }
  }

  for (const [profileIndex, profile] of (catalog.profiles ?? []).entries()) {
    const profilePointer = `/profiles/${profileIndex}`;
    const { content_digest: _digest, ...digestInput } = profile;
    const canonicalInputIssue = validateCanonicalJson(digestInput, profilePointer);
    if (canonicalInputIssue) {
      record(canonicalInputIssue);
      continue;
    }
    let actualDigest: string;
    try {
      actualDigest = `sha256:${canonicalJsonSha256(digestInput)}`;
    } catch {
      record(
        issue(
          'profile_canonicalization_invalid',
          'A seller profile cannot be canonicalized as RFC 8785 I-JSON',
          profilePointer
        )
      );
      continue;
    }
    if (actualDigest !== profile.content_digest) {
      record(
        issue(
          'profile_digest_mismatch',
          'A seller profile content_digest did not match its RFC 8785 canonical content',
          `${profilePointer}/content_digest`
        )
      );
    }

    const policyIds = new Set<string>();
    for (const [refIndex, reference] of profile.policy_refs.entries()) {
      const policyId = reference.policy_id;
      if (policyIds.has(policyId)) {
        record(
          issue(
            'reference_invalid',
            'A seller profile must reference each policy_id at most once',
            `${profilePointer}/policy_refs/${refIndex}/policy_id`
          )
        );
      }
      policyIds.add(policyId);
    }

    const ruleIds = new Set<string>();
    const regionAliases = new Set(Object.keys(profile.region_aliases ?? {}));
    for (const [groupIndex, groupId] of (profile.scope?.jurisdiction_groups ?? []).entries()) {
      if (!regionAliases.has(groupId)) {
        record(
          issue(
            'reference_invalid',
            'A scope jurisdiction group must resolve in the profile region_aliases',
            `${profilePointer}/scope/jurisdiction_groups/${groupIndex}`
          )
        );
      }
    }
    for (const [ruleIndex, rule] of profile.rules.entries()) {
      const rulePointer = `${profilePointer}/rules/${ruleIndex}`;
      if (ruleIds.has(rule.rule_id)) {
        record(issue('reference_invalid', 'A seller profile must use unique rule_id values', `${rulePointer}/rule_id`));
      }
      ruleIds.add(rule.rule_id);
      for (const [policyIndex, policyId] of (rule.policy_ids ?? []).entries()) {
        if (!policyIds.has(policyId)) {
          record(
            issue(
              'reference_invalid',
              'A rule policy_id must resolve to exactly one profile policy_refs entry',
              `${rulePointer}/policy_ids/${policyIndex}`
            )
          );
        }
      }
      for (const [groupIndex, groupId] of (rule.jurisdiction_groups ?? []).entries()) {
        if (!regionAliases.has(groupId)) {
          record(
            issue(
              'reference_invalid',
              'A rule jurisdiction group must resolve in the profile region_aliases',
              `${rulePointer}/jurisdiction_groups/${groupIndex}`
            )
          );
        }
      }
    }
  }
  return issues;
}

function validateCanonicalJson(
  value: unknown,
  pointer: string,
  limits: { maxNodes?: number; maxStringCodeUnits?: number } = {}
): AcceptancePolicyCatalogIssue | undefined {
  const pending: Array<{ value: unknown; depth: number; exit?: boolean }> = [{ value, depth: 0 }];
  const ancestors = new WeakSet<object>();
  let nodes = 0;
  let stringCodeUnits = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.exit) {
      ancestors.delete(current.value as object);
      continue;
    }
    nodes += 1;
    if (limits.maxNodes !== undefined && nodes > limits.maxNodes) {
      return issue('profile_canonicalization_invalid', 'A seller profile exceeds the safe JSON node limit', pointer);
    }
    if (current.depth > MAX_CANONICAL_JSON_DEPTH) {
      return issue(
        'profile_canonicalization_invalid',
        `A seller profile exceeds the maximum canonical JSON depth of ${MAX_CANONICAL_JSON_DEPTH}`,
        pointer
      );
    }
    if (typeof current.value === 'number' && !Number.isFinite(current.value)) {
      return issue('profile_canonicalization_invalid', 'A seller profile contains a non-finite JSON number', pointer);
    }
    if (typeof current.value === 'string') {
      stringCodeUnits += current.value.length;
      if (limits.maxStringCodeUnits !== undefined && stringCodeUnits > limits.maxStringCodeUnits) {
        return issue(
          'profile_canonicalization_invalid',
          'A seller profile exceeds the safe string-size limit',
          pointer
        );
      }
      if (!isWellFormedUnicodeString(current.value)) {
        return issue(
          'profile_canonicalization_invalid',
          'A seller profile must contain well-formed Unicode before RFC 8785 canonicalization',
          pointer
        );
      }
      continue;
    }
    if (current.value === null || typeof current.value !== 'object') continue;
    if (ancestors.has(current.value)) {
      return issue('profile_canonicalization_invalid', 'A seller profile must not contain JSON cycles', pointer);
    }
    ancestors.add(current.value);
    pending.push({ ...current, exit: true });
    if (Array.isArray(current.value)) {
      for (const child of current.value) pending.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    for (const [key, child] of Object.entries(current.value as Record<string, unknown>)) {
      stringCodeUnits += key.length;
      if (limits.maxStringCodeUnits !== undefined && stringCodeUnits > limits.maxStringCodeUnits) {
        return issue(
          'profile_canonicalization_invalid',
          'A seller profile exceeds the safe string-size limit',
          pointer
        );
      }
      if (!isWellFormedUnicodeString(key)) {
        return issue(
          'profile_canonicalization_invalid',
          'A seller profile must contain well-formed Unicode before RFC 8785 canonicalization',
          pointer
        );
      }
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
  return undefined;
}

function validateCatalogDocument(value: unknown): AcceptancePolicyCatalogIssue | undefined {
  const pending: Array<{ value: unknown; depth: number; exit?: boolean }> = [{ value, depth: 0 }];
  const ancestors = new WeakSet<object>();
  let nodes = 0;
  let stringCodeUnits = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.exit) {
      ancestors.delete(current.value as object);
      continue;
    }
    nodes += 1;
    if (nodes > MAX_CATALOG_JSON_NODES) {
      return issue('catalog_document_invalid', 'Acceptance-policy catalog exceeds the safe JSON node limit', '/');
    }
    if (current.depth > MAX_CATALOG_JSON_DEPTH) {
      return issue(
        'catalog_document_invalid',
        `Acceptance-policy catalog exceeds the maximum JSON depth of ${MAX_CATALOG_JSON_DEPTH}`,
        '/'
      );
    }
    if (typeof current.value === 'number' && !Number.isFinite(current.value)) {
      return issue('catalog_document_invalid', 'Acceptance-policy catalog contains a non-finite JSON number', '/');
    }
    if (typeof current.value === 'string') {
      stringCodeUnits += current.value.length;
      if (stringCodeUnits > MAX_CATALOG_JSON_STRING_CODE_UNITS) {
        return issue('catalog_document_invalid', 'Acceptance-policy catalog exceeds the safe string-size limit', '/');
      }
      if (!isWellFormedUnicodeString(current.value)) {
        return issue('catalog_document_invalid', 'Acceptance-policy catalog must contain well-formed Unicode', '/');
      }
      continue;
    }
    if (current.value === null || typeof current.value !== 'object') continue;
    if (ancestors.has(current.value)) {
      return issue('catalog_document_invalid', 'Acceptance-policy catalog must not contain JSON cycles', '/');
    }
    ancestors.add(current.value);
    pending.push({ ...current, exit: true });
    if (Array.isArray(current.value)) {
      for (const child of current.value) pending.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    for (const [key, child] of Object.entries(current.value as Record<string, unknown>)) {
      stringCodeUnits += key.length;
      if (stringCodeUnits > MAX_CATALOG_JSON_STRING_CODE_UNITS) {
        return issue('catalog_document_invalid', 'Acceptance-policy catalog exceeds the safe string-size limit', '/');
      }
      if (!isWellFormedUnicodeString(key)) {
        return issue('catalog_document_invalid', 'Acceptance-policy catalog must contain well-formed Unicode', '/');
      }
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
  return undefined;
}

function resolveDefaults(
  catalog: AcceptancePolicyCatalog,
  profileIds: readonly string[]
): ResolvedAcceptancePolicyDefault[] {
  return resolveAcceptancePolicyProfiles(catalog, profileIds).filter(
    (value): value is ResolvedAcceptancePolicyDefault => value.resolution !== 'missing'
  );
}

/**
 * Resolve seller-local profiles and identify registry pins that still require
 * trusted registry resolution. Missing IDs and unresolved registry references
 * are never represented as usable policy rules.
 */
export function resolveAcceptancePolicyProfiles(
  catalog: AcceptancePolicyCatalog,
  profileIds: readonly string[]
): AcceptancePolicyProfileResolution[] {
  const sellerProfiles = new Map((catalog.profiles ?? []).map(profile => [profile.profile_id, profile]));
  const registryProfiles = new Map((catalog.registry_profiles ?? []).map(profile => [profile.profile_id, profile]));
  return profileIds.map(profileId => {
    const seller = sellerProfiles.get(profileId);
    if (seller) {
      return { source: 'seller' as const, resolution: 'resolved' as const, profileId, profile: seller };
    }
    const ref = registryProfiles.get(profileId);
    if (ref) return { source: 'registry' as const, resolution: 'unresolved' as const, profileId, ref };
    return { source: 'catalog' as const, resolution: 'missing' as const, profileId };
  });
}

function safeVersionLabel(version: string): string {
  return /^[0-9A-Za-z.-]{1,64}$/.test(version) ? version : '<requested version>';
}

const REGISTRY_TIMEOUT = Symbol('registry-timeout');

async function waitForRegistryPolicy(
  pending: Promise<AcceptancePolicyRegistryPolicy | null>,
  timeoutMs: number,
  controller: AbortController
): Promise<AcceptancePolicyRegistryPolicy | null | typeof REGISTRY_TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<typeof REGISTRY_TIMEOUT>(resolve => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(REGISTRY_TIMEOUT);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function resolveRegistryProfile(
  ref: RegistryAcceptancePolicyProfileReference,
  pointer: string,
  options: ResolveVerifiedAcceptancePolicyProfilesOptions,
  deadlineAt: number,
  controller: AbortController
): Promise<ResolvedAcceptancePolicyDefault | AcceptancePolicyCatalogFailure> {
  let policy: AcceptancePolicyRegistryPolicy | null;
  try {
    const remainingMs = deadlineAt - performance.now();
    if (controller.signal.aborted || remainingMs <= 0) {
      return fail(
        issue('registry_timeout', 'Registry profile resolution exceeded the overall deadline', pointer, {
          retryable: true,
        })
      );
    }
    const resolved = await waitForRegistryPolicy(
      options.registryResolver.resolvePolicy({
        policy_id: ref.policy_id,
        version: ref.policy_version,
        signal: controller.signal,
      }),
      remainingMs,
      controller
    );
    // An abort listener may settle a resolver promise before the timeout
    // sentinel wins the race. The batch deadline always takes precedence over
    // any value produced as part of cancellation.
    if (controller.signal.aborted || performance.now() >= deadlineAt) {
      return fail(
        issue('registry_timeout', 'Registry profile resolution exceeded the overall deadline', pointer, {
          retryable: true,
        })
      );
    }
    if (resolved === REGISTRY_TIMEOUT) {
      return fail(
        issue('registry_timeout', 'Registry profile resolution exceeded the overall deadline', pointer, {
          retryable: true,
        })
      );
    }
    policy = resolved;
  } catch {
    if (controller.signal.aborted || performance.now() >= deadlineAt) {
      return fail(
        issue('registry_timeout', 'Registry profile resolution exceeded the overall deadline', pointer, {
          retryable: true,
        })
      );
    }
    return fail(
      issue('registry_fetch_failed', 'The pinned registry policy could not be fetched', pointer, { retryable: true })
    );
  }
  if (!policy || typeof policy !== 'object') {
    return fail(
      issue('registry_reference_unresolved', 'The pinned registry policy version did not resolve', pointer, {
        retryable: false,
      })
    );
  }
  if (policy.policy_id !== ref.policy_id || policy.version !== ref.policy_version) {
    return fail(
      issue('registry_policy_mismatch', 'The registry returned a different policy identity or version', pointer)
    );
  }
  if (
    policy.canonical_content === null ||
    typeof policy.canonical_content !== 'object' ||
    Array.isArray(policy.canonical_content) ||
    typeof policy.content_digest !== 'string'
  ) {
    return fail(
      issue('registry_policy_unverifiable', 'The registry policy lacks verifiable canonical content', pointer)
    );
  }
  const registryJsonLimits = {
    maxNodes: MAX_REGISTRY_JSON_NODES,
    maxStringCodeUnits: MAX_REGISTRY_JSON_STRING_CODE_UNITS,
  };
  if (validateCanonicalJson(policy.canonical_content, pointer, registryJsonLimits)) {
    return fail(
      issue('registry_policy_unverifiable', 'The registry policy canonical content is not safe I-JSON', pointer)
    );
  }

  let policyDigest: string;
  try {
    policyDigest = `sha256:${canonicalJsonSha256(policy.canonical_content)}`;
  } catch {
    return fail(
      issue('registry_policy_unverifiable', 'The registry policy canonical content cannot be verified', pointer)
    );
  }
  if (policyDigest !== policy.content_digest || policyDigest !== ref.policy_digest) {
    return fail(
      issue('registry_policy_digest_mismatch', 'The registry policy digest does not match the catalog pin', pointer)
    );
  }

  const profileValue: unknown = policy.acceptance_profile;
  if (profileValue === null || typeof profileValue !== 'object' || Array.isArray(profileValue)) {
    return fail(
      issue('registry_profile_invalid', 'The pinned registry policy does not contain an acceptance profile', pointer)
    );
  }
  if (validateCanonicalJson(profileValue, pointer, registryJsonLimits)) {
    return fail(issue('registry_profile_invalid', 'The registry acceptance profile is not safe I-JSON', pointer));
  }

  const requestedVersion = options.adcpVersion ?? ADCP_VERSION;
  let validator;
  try {
    validator = getSchemaValidatorByRef(PROFILE_SCHEMA_REF, requestedVersion, undefined, { allErrors: false });
  } catch {
    return fail(
      issue(
        'schema_unavailable',
        `Acceptance-policy profile schema is unavailable for ${safeVersionLabel(requestedVersion)}`,
        pointer
      )
    );
  }
  if (!validator) {
    return fail(
      issue(
        'schema_unavailable',
        `Acceptance-policy profile schema is unavailable for ${safeVersionLabel(requestedVersion)}`,
        pointer
      )
    );
  }
  if (!validator(profileValue)) {
    const error = issue(
      'registry_profile_schema_invalid',
      'The registry acceptance profile is incompatible with the selected AdCP schema',
      pointer,
      {
        keyword: validator.errors?.[0]?.keyword,
      }
    );
    const details = schemaIssues(validator.errors).map(value => ({
      ...value,
      message: 'Acceptance-policy profile failed schema validation',
      pointer: `${pointer}/acceptance_profile${value.pointer === '/' ? '' : value.pointer}`,
    }));
    return fail(error, [error, ...details]);
  }

  const profile = profileValue as AcceptancePolicyProfile;
  if (profile.profile_id !== ref.profile_id || profile.version !== ref.profile_version) {
    return fail(
      issue('registry_profile_mismatch', 'The registry returned a different profile identity or version', pointer)
    );
  }
  if (profile.content_digest !== ref.profile_digest) {
    return fail(
      issue('registry_profile_digest_mismatch', 'The registry profile digest does not match the catalog pin', pointer)
    );
  }
  const { content_digest: _digest, ...profileDigestInput } = profile;
  let profileDigest: string;
  try {
    profileDigest = `sha256:${canonicalJsonSha256(profileDigestInput)}`;
  } catch {
    return fail(
      issue('registry_profile_digest_mismatch', 'The registry profile canonical digest cannot be verified', pointer)
    );
  }
  if (profileDigest !== profile.content_digest) {
    return fail(
      issue('registry_profile_digest_mismatch', 'The registry profile content does not match its digest', pointer)
    );
  }

  const semantic = semanticIssues({ catalog_version: 'registry', profiles: [profile] }, []);
  if (semantic.length > 0) {
    const error = issue('registry_profile_invalid', 'The registry profile failed integrity validation', pointer);
    const details = semantic.map(value => ({
      ...value,
      pointer: `${pointer}/acceptance_profile${value.pointer.replace(/^\/profiles\/0/, '')}`,
    }));
    return fail(error, [error, ...details]);
  }

  return {
    source: 'registry',
    resolution: 'resolved',
    profileId: ref.profile_id,
    profile: cloneJson(profile),
    ref,
  };
}

/**
 * Resolve selected seller-local and registry-backed profiles from a catalog
 * already obtained through the digest-pinned catalog resolver. Registry
 * content becomes usable only after both immutable policy and embedded profile
 * pins verify; each failed pin remains unresolved with an issue diagnostic.
 */
export async function resolveVerifiedAcceptancePolicyProfiles(
  catalog: AcceptancePolicyCatalog,
  profileIds: readonly string[],
  options: ResolveVerifiedAcceptancePolicyProfilesOptions
): Promise<VerifiedAcceptancePolicyProfilesResult> {
  // Do not retain the caller's mutable options object across registry awaits.
  // This also prevents a replacement resolver from redirecting queued work.
  const optionsSnapshot = { ...options };
  return resolveVerifiedAcceptancePolicyProfilesInternal(catalog, profileIds, optionsSnapshot, false);
}

async function resolveVerifiedAcceptancePolicyProfilesInternal(
  catalog: AcceptancePolicyCatalog,
  profileIds: readonly string[],
  options: ResolveVerifiedAcceptancePolicyProfilesOptions,
  catalogAlreadyValidated: boolean
): Promise<VerifiedAcceptancePolicyProfilesResult> {
  if (!options?.registryResolver || typeof options.registryResolver.resolvePolicy !== 'function') {
    return fail(
      issue('invalid_options', 'registryResolver must provide a resolvePolicy function', '/options/registryResolver')
    );
  }
  if (
    options.timeoutMs !== undefined &&
    (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > MAX_TIMEOUT_MS)
  ) {
    return fail(
      issue(
        'invalid_options',
        `timeoutMs must be a positive safe integer no greater than ${MAX_TIMEOUT_MS}`,
        '/options/timeoutMs'
      )
    );
  }
  if (
    options.maxRegistryProfiles !== undefined &&
    (!Number.isSafeInteger(options.maxRegistryProfiles) ||
      options.maxRegistryProfiles <= 0 ||
      options.maxRegistryProfiles > MAX_REGISTRY_PROFILES)
  ) {
    return fail(
      issue(
        'invalid_options',
        `maxRegistryProfiles must be a positive safe integer no greater than ${MAX_REGISTRY_PROFILES}`,
        '/options/maxRegistryProfiles'
      )
    );
  }
  if (
    !Array.isArray(profileIds) ||
    profileIds.some(profileId => typeof profileId !== 'string' || profileId.length === 0)
  ) {
    return fail(issue('invalid_options', 'profileIds must contain only non-empty strings', '/profileIds'));
  }
  if (profileIds.length > MAX_SELECTED_PROFILE_IDS) {
    return fail(
      issue(
        'invalid_options',
        `profileIds must contain no more than ${MAX_SELECTED_PROFILE_IDS} entries`,
        '/profileIds'
      )
    );
  }

  const requestedVersion = options.adcpVersion ?? ADCP_VERSION;
  let catalogSnapshot: AcceptancePolicyCatalog;
  if (catalogAlreadyValidated) {
    catalogSnapshot = catalog;
  } else {
    const documentIssue = validateCatalogDocument(catalog);
    if (documentIssue) return fail(documentIssue);
    let validator;
    try {
      validator = getSchemaValidatorByRef(CATALOG_SCHEMA_REF, requestedVersion, undefined, { allErrors: false });
    } catch {
      return fail(
        issue(
          'schema_unavailable',
          `Acceptance-policy catalog schema is unavailable for ${safeVersionLabel(requestedVersion)}`,
          '/'
        )
      );
    }
    if (!validator) {
      return fail(
        issue(
          'schema_unavailable',
          `Acceptance-policy catalog schema is unavailable for ${safeVersionLabel(requestedVersion)}`,
          '/'
        )
      );
    }
    if (!validator(catalog)) {
      const issues = schemaIssues(validator.errors);
      return fail(
        issues[0] ?? issue('schema_invalid', 'Acceptance-policy catalog failed schema validation', '/'),
        issues
      );
    }
    const integrityIssues = semanticIssues(catalog, []);
    if (integrityIssues.length > 0) return fail(integrityIssues[0]!, integrityIssues);
    catalogSnapshot = cloneCatalog(catalog);
  }
  const classified = resolveAcceptancePolicyProfiles(catalogSnapshot, [...profileIds]);
  const distinctRegistryProfiles = new Set(
    classified
      .filter(value => value.source === 'registry' && value.resolution === 'unresolved')
      .map(value => value.profileId)
  );
  const maxRegistryProfiles = options.maxRegistryProfiles ?? DEFAULT_MAX_REGISTRY_PROFILES;
  if (distinctRegistryProfiles.size > maxRegistryProfiles) {
    return {
      ok: true,
      profiles: classified,
      issues: [
        issue(
          'registry_resolution_limit_exceeded',
          'The selected registry profile count exceeds the configured resolution limit',
          '/registry_profiles'
        ),
      ],
    };
  }

  const registryIndexes = new Map(
    (catalogSnapshot.registry_profiles ?? []).map((ref, index) => [ref.profile_id, index])
  );
  const registryValues = new Map(
    classified
      .filter(
        (value): value is Extract<ResolvedAcceptancePolicyDefault, { source: 'registry'; resolution: 'unresolved' }> =>
          value.source === 'registry' && value.resolution === 'unresolved'
      )
      .map(value => [value.profileId, value])
  );
  const resolutionByProfileId = new Map<string, ResolvedAcceptancePolicyDefault | AcceptancePolicyCatalogFailure>();
  const registryEntries = [...registryValues.entries()];
  const controller = new AbortController();
  const deadlineAt = performance.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let nextRegistryIndex = 0;

  async function resolveWorker(): Promise<void> {
    while (nextRegistryIndex < registryEntries.length) {
      const entryIndex = nextRegistryIndex++;
      const [profileId, value] = registryEntries[entryIndex]!;
      const catalogIndex = registryIndexes.get(profileId);
      const resolved = await resolveRegistryProfile(
        value.ref,
        catalogIndex === undefined ? '/registry_profiles' : `/registry_profiles/${catalogIndex}`,
        options,
        deadlineAt,
        controller
      );
      resolutionByProfileId.set(profileId, resolved);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(MAX_REGISTRY_CONCURRENCY, registryEntries.length) }, async () => resolveWorker())
  );

  const profiles: AcceptancePolicyProfileResolution[] = [];
  const issues: AcceptancePolicyCatalogIssue[] = [];
  const reportedFailures = new Set<string>();

  for (const value of classified) {
    if (value.source !== 'registry' || value.resolution !== 'unresolved') {
      profiles.push(value);
      continue;
    }
    const resolved = resolutionByProfileId.get(value.profileId);
    if (!resolved || 'ok' in resolved) {
      profiles.push(value);
      if (resolved && !reportedFailures.has(value.profileId)) {
        issues.push(...(resolved.issues ?? [resolved.error]));
        reportedFailures.add(value.profileId);
      }
      continue;
    }
    // Registry lookups are coalesced by profile ID. Reuse the already-cloned,
    // verified result for duplicate selections instead of cloning a potentially
    // large profile once per occurrence.
    profiles.push(resolved);
  }

  return { ok: true, profiles, ...(issues.length > 0 && { issues }) };
}

async function resolveOnce(
  capability: AcceptancePolicyDiscoveryCapability,
  options: ResolveAcceptancePolicyCatalogOptions
): Promise<AcceptancePolicyCatalogResult> {
  const invalidOptions = validateOptions(options);
  if (invalidOptions) return fail(invalidOptions);
  const invalid = validateCapability(capability, options);
  if (invalid) return fail(invalid);

  let fetched;
  try {
    fetched = await resolveCanonicalReference(
      { uri: capability.catalog_url, digest: capability.catalog_digest },
      {
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
        allowUnsafeHttp: options.allowUnsafeHttp,
        allowPrivateNetwork: options.allowPrivateNetwork,
      }
    );
  } catch {
    return fail(
      issue(
        'fetch_failed',
        'Acceptance-policy catalog resolution failed safely',
        '/media_buy/acceptance_policy_discovery/catalog_url',
        { retryable: false }
      )
    );
  }
  if (!fetched.ok) return translateFetchFailure(fetched);

  // Catalog bytes are counterparty-controlled. Fail on the first schema
  // issue so a bounded body cannot amplify into an unbounded diagnostics set.
  const requestedVersion = options.adcpVersion ?? ADCP_VERSION;
  const displayVersion = safeVersionLabel(requestedVersion);
  let validator;
  try {
    validator = getSchemaValidatorByRef(CATALOG_SCHEMA_REF, requestedVersion, undefined, { allErrors: false });
  } catch {
    return fail(
      issue('schema_unavailable', `Acceptance-policy catalog schema is unavailable for ${displayVersion}`, '/')
    );
  }
  if (!validator) {
    return fail(
      issue('schema_unavailable', `Acceptance-policy catalog schema is unavailable for ${displayVersion}`, '/')
    );
  }
  if (!validator(fetched.document)) {
    const issues = schemaIssues(validator.errors);
    return fail(
      issues[0] ?? issue('schema_invalid', 'Acceptance-policy catalog failed schema validation', '/'),
      issues
    );
  }

  const catalog = fetched.document as AcceptancePolicyCatalog;
  const issues = semanticIssues(catalog, capability.default_profile_ids ?? []);
  if (issues.length > 0) return fail(issues[0]!, issues);

  const documentIssue = validateCatalogDocument(catalog);
  if (documentIssue) return fail(documentIssue);

  const clonedCatalog = cloneCatalog(catalog);
  let defaultProfiles = resolveDefaults(clonedCatalog, capability.default_profile_ids ?? []);
  let registryIssues: AcceptancePolicyCatalogIssue[] | undefined;
  if (options.registryResolver && defaultProfiles.some(value => value.resolution === 'unresolved')) {
    const verified = await resolveVerifiedAcceptancePolicyProfilesInternal(
      clonedCatalog,
      capability.default_profile_ids ?? [],
      {
        registryResolver: options.registryResolver,
        adcpVersion: requestedVersion,
        timeoutMs: options.registryTimeoutMs,
        maxRegistryProfiles: options.maxRegistryProfiles,
      },
      true
    );
    if (!verified.ok) return verified;
    registryIssues = verified.issues;
    defaultProfiles = verified.profiles.filter(
      (value): value is ResolvedAcceptancePolicyDefault => value.resolution !== 'missing'
    );
  }

  return {
    ok: true,
    fromCache: false,
    catalog: clonedCatalog,
    defaultProfiles,
    ...(registryIssues !== undefined && { issues: registryIssues }),
  };
}

/** Resolve once without retaining remote content. */
export async function resolveAcceptancePolicyCatalog(
  capability: AcceptancePolicyDiscoveryCapability,
  options: ResolveAcceptancePolicyCatalogOptions = {}
): Promise<AcceptancePolicyCatalogResult> {
  return resolveOnce(snapshotCapability(capability), { ...options });
}

/**
 * Create a capability-lifetime resolver. It retains only the current
 * capability's successful catalog and clears that entry whenever any
 * advertised catalog URL, digest, or default profile changes.
 */
export function createAcceptancePolicyCatalogResolver(
  options: ResolveAcceptancePolicyCatalogOptions = {}
): AcceptancePolicyCatalogResolver {
  const resolverOptions = { ...options };
  let capabilityKey: string | undefined;
  let cached: AcceptancePolicyCatalogSuccess | undefined;
  let generation = 0;
  let inFlight:
    | {
        key: string;
        generation: number;
        promise: Promise<AcceptancePolicyCatalogResult>;
      }
    | undefined;

  return {
    async resolve(capability) {
      const snapshot = snapshotCapability(capability);
      const nextKey = JSON.stringify({
        catalog_url: snapshot?.catalog_url,
        catalog_digest: snapshot?.catalog_digest,
        default_profile_ids: snapshot?.default_profile_ids,
      });
      if (nextKey !== capabilityKey) {
        capabilityKey = nextKey;
        cached = undefined;
        inFlight = undefined;
        generation += 1;
      }
      if (cached) return cloneSuccess(cached, true);
      if (inFlight?.key === nextKey && inFlight.generation === generation) {
        let shared: AcceptancePolicyCatalogResult;
        try {
          shared = await inFlight.promise;
        } catch {
          return fail(
            issue(
              'fetch_failed',
              'Acceptance-policy catalog resolution failed safely',
              '/media_buy/acceptance_policy_discovery/catalog_url',
              { retryable: false }
            )
          );
        }
        return shared.ok ? cloneSuccess(shared, false) : shared;
      }

      const startedGeneration = generation;
      const promise = resolveOnce(snapshot, resolverOptions);
      inFlight = { key: nextKey, generation: startedGeneration, promise };
      let result: AcceptancePolicyCatalogResult;
      try {
        result = await promise;
      } catch {
        result = fail(
          issue(
            'fetch_failed',
            'Acceptance-policy catalog resolution failed safely',
            '/media_buy/acceptance_policy_discovery/catalog_url',
            { retryable: false }
          )
        );
      } finally {
        if (inFlight?.promise === promise) inFlight = undefined;
      }
      if (!result.ok) return result;
      if (generation === startedGeneration && capabilityKey === nextKey) {
        cached = cloneSuccess(result, false);
      }
      return cloneSuccess(result, false);
    },
    invalidate() {
      capabilityKey = undefined;
      cached = undefined;
      inFlight = undefined;
      generation += 1;
    },
  };
}
