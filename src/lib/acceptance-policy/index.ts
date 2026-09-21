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

const CATALOG_SCHEMA_REF = 'media-buy/acceptance-policy-catalog.json';
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const MAX_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_CANONICAL_JSON_DEPTH = 128;
const MAX_CATALOG_JSON_DEPTH = 256;

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

export interface AcceptancePolicyRule {
  rule_id: string;
  subject_category: string;
  jurisdiction_groups?: string[];
  applies_to: string[];
  disposition: 'allowed' | 'conditional' | 'prohibited';
  policy_ids?: string[];
  [key: string]: unknown;
}

export interface AcceptancePolicyProfile {
  profile_id: string;
  version: string;
  content_digest: string;
  policy_refs: AcceptancePolicyReference[];
  coverage: 'partial' | 'complete';
  scope?: {
    jurisdiction_groups?: string[];
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
  | 'reference_invalid';

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
}

export type AcceptancePolicyCatalogResult = AcceptancePolicyCatalogSuccess | AcceptancePolicyCatalogFailure;

export interface ResolveAcceptancePolicyCatalogOptions {
  /** Schema bundle used to validate the fetched catalog. Defaults to the SDK pin. */
  adcpVersion?: string;
  /** Overall DNS/connect/body timeout. Default 5 seconds. */
  timeoutMs?: number;
  /** Hard response-body cap. Default and maximum 1 MiB; callers may lower it. */
  maxBodyBytes?: number;
  /** Test/dev-only HTTP opt-in; requires allowPrivateNetwork. Production callers must leave false. */
  allowUnsafeHttp?: boolean;
  /** Test/dev-only opt-in for private-network fixtures. Production callers must leave false. */
  allowPrivateNetwork?: boolean;
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

function cloneCatalog(catalog: AcceptancePolicyCatalog): AcceptancePolicyCatalog {
  return JSON.parse(JSON.stringify(catalog)) as AcceptancePolicyCatalog;
}

function cloneSuccess(result: AcceptancePolicyCatalogSuccess, fromCache: boolean): AcceptancePolicyCatalogSuccess {
  const catalog = cloneCatalog(result.catalog);
  return {
    ok: true,
    fromCache,
    catalog,
    defaultProfiles: resolveDefaults(
      catalog,
      result.defaultProfiles.map(value => value.profileId)
    ),
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
      defaults.some(value => typeof value !== 'string' || value.length === 0)
    ) {
      return issue(
        'invalid_capability',
        'default_profile_ids must be a non-empty array of non-empty strings',
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

function validateCanonicalJson(value: unknown, pointer: string): AcceptancePolicyCatalogIssue | undefined {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.pop()!;
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
    if (Array.isArray(current.value)) {
      for (const child of current.value) pending.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    for (const [key, child] of Object.entries(current.value as Record<string, unknown>)) {
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
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.pop()!;
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
      if (!isWellFormedUnicodeString(current.value)) {
        return issue('catalog_document_invalid', 'Acceptance-policy catalog must contain well-formed Unicode', '/');
      }
      continue;
    }
    if (current.value === null || typeof current.value !== 'object') continue;
    if (Array.isArray(current.value)) {
      for (const child of current.value) pending.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    for (const [key, child] of Object.entries(current.value as Record<string, unknown>)) {
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
  const displayVersion =
    typeof requestedVersion === 'string' && /^[0-9A-Za-z.-]{1,64}$/.test(requestedVersion)
      ? requestedVersion
      : '<requested version>';
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

  return {
    ok: true,
    fromCache: false,
    catalog: clonedCatalog,
    defaultProfiles: resolveDefaults(clonedCatalog, capability.default_profile_ids ?? []),
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
