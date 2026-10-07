import { existsSync, readFileSync, readdirSync } from 'fs';
import { basename, join, resolve } from 'path';
import { getComplianceCacheDir } from '../compliance';
import type { RequestSignatureErrorCode } from '../../../signing';
import { A2A_VECTOR_TIERS, CONTRACT_IDS } from './types';
import type {
  A2aExpectedOutcome,
  A2aNegativeVector,
  A2aPositiveVector,
  A2aVectorTier,
  ContractId,
  NegativeVector,
  PositiveVector,
  TestKeypair,
  TestKeyset,
  Vector,
} from './types';

export interface LoadVectorsOptions {
  complianceDir?: string;
  version?: string;
  /**
   * Explicit directory holding the A2A operation-resolution vectors
   * (`positive/` and `negative/` subdirectories). Takes precedence over the
   * compliance cache and the vendored copy; falls back to the
   * `ADCP_A2A_VECTORS_DIR` environment variable. A configured directory that
   * does not exist is an error, not a silent fall-through.
   */
  a2aVectorsDir?: string;
  /**
   * Allow falling back to the vendored `test/fixtures/request-signing-a2a`
   * copy when the compliance cache has no A2A vectors. Default `true`. Set
   * `false` to see exactly what an installed package sees (the fixtures are
   * not shipped), e.g. to test the "unavailable" report.
   */
  a2aVendoredFallback?: boolean;
}

export interface LoadedVectors {
  positive: PositiveVector[];
  negative: NegativeVector[];
  profiles: Record<string, { positive: PositiveVector[]; negative: NegativeVector[] }>;
  keys: TestKeyset;
  sourceDir: string;
}

/** A selected signing profile uses only its authored fixtures and wire encoding. */
export function selectRequestSigningVectors(
  loaded: LoadedVectors,
  signingProfileVersion?: '3.2'
): Pick<LoadedVectors, 'positive' | 'negative'> {
  const profile = signingProfileVersion ? loaded.profiles[signingProfileVersion] : undefined;
  if (!signingProfileVersion) return { positive: loaded.positive, negative: loaded.negative };
  if (!profile)
    throw new Error(`Request-signing profile ${signingProfileVersion} is unavailable in ${loaded.sourceDir}`);
  return profile;
}

export function signingProfileForAdcpVersion(version?: string): '3.2' | undefined {
  const match = /^(\d+)\.(\d+)/.exec(version ?? '');
  return match && (Number(match[1]) > 3 || (Number(match[1]) === 3 && Number(match[2]) >= 2)) ? '3.2' : undefined;
}

const ERROR_CODES: ReadonlySet<string> = new Set([
  'request_signature_required',
  'request_signature_header_malformed',
  'request_signature_params_incomplete',
  'request_signature_tag_invalid',
  'request_signature_alg_not_allowed',
  'request_signature_window_invalid',
  'request_signature_components_incomplete',
  'request_signature_components_unexpected',
  'request_target_uri_malformed',
  'request_signature_key_unknown',
  'request_signature_key_purpose_invalid',
  'request_signature_key_revoked',
  'request_signature_invalid',
  'request_signature_digest_mismatch',
  'request_signature_replayed',
  'request_signature_rate_abuse',
  'request_body_malformed',
]);

const CONTRACT_ID_SET: ReadonlySet<string> = new Set(CONTRACT_IDS);

// Memoized per sourceDir — loading 28 JSON fixtures + keys.json on every
// per-vector call in the runner path added up (~28 disk reads × 2-3 storyboard
// resolve calls per CLI run). Invariant: the compliance cache is immutable
// during a process lifetime — `npm run sync-schemas` runs before the process,
// never concurrently. Cache key is the absolute cacheDir so env-var overrides
// don't poison the entry.
const VECTOR_CACHE = new Map<string, LoadedVectors>();

export function loadRequestSigningVectors(options: LoadVectorsOptions = {}): LoadedVectors {
  const cacheDir = getComplianceCacheDir(options);
  const sourceDir = join(cacheDir, 'test-vectors', 'request-signing');
  const cached = VECTOR_CACHE.get(sourceDir);
  if (cached) return cached;

  if (!existsSync(sourceDir)) {
    throw new Error(
      `Request-signing vectors not found at ${sourceDir}. Run \`npm run sync-schemas\` or check your ADCP_COMPLIANCE_DIR.`
    );
  }

  const profile32Dir = join(sourceDir, 'profile-3.2');
  const loaded: LoadedVectors = {
    positive: loadDir(join(sourceDir, 'positive'), parsePositive),
    negative: loadDir(join(sourceDir, 'negative'), parseNegative),
    profiles: existsSync(profile32Dir)
      ? {
          '3.2': {
            positive: loadDir(join(profile32Dir, 'positive'), parsePositive, 'profile-3.2/positive/'),
            negative: loadDir(join(profile32Dir, 'negative'), parseNegative, 'profile-3.2/negative/'),
          },
        }
      : {},
    keys: loadRequestSigningKeys(options),
    sourceDir,
  };
  VECTOR_CACHE.set(sourceDir, loaded);
  return loaded;
}

/** Load only the shared signing keyset, without requiring the grader vectors. */
export function loadRequestSigningKeys(options: LoadVectorsOptions = {}): TestKeyset {
  const cacheDir = getComplianceCacheDir(options);
  return loadKeys(join(cacheDir, 'test-vectors', 'request-signing', 'keys.json'));
}

/** Test-only: clear the memoization cache so a fresh cache path is reread. */
export function __resetVectorCache(): void {
  VECTOR_CACHE.clear();
  A2A_VECTOR_CACHE.clear();
}

// ── A2A operation-resolution vectors (adcp#7945) ─────────────────

/** Where the A2A operation-resolution vectors came from. */
export type A2aVectorSource = 'override' | 'compliance_cache' | 'vendored_fixture' | 'none';

export interface LoadedA2aVectors {
  positive: A2aPositiveVector[];
  negative: A2aNegativeVector[];
  source: A2aVectorSource;
  /** Directory the vectors were read from; absent when `source` is `'none'`. */
  sourceDir?: string;
}

/** Reported verbatim when the grader finds no A2A operation-resolution vectors. */
export const A2A_VECTORS_UNAVAILABLE_MESSAGE = 'a2a operation-resolution vectors unavailable in this compliance bundle';

/** Env var naming an explicit A2A vector directory (tests, pre-release bundles). */
export const A2A_VECTORS_DIR_ENV = 'ADCP_A2A_VECTORS_DIR';

const A2A_VECTOR_CACHE = new Map<string, Pick<LoadedA2aVectors, 'positive' | 'negative'>>();

/**
 * Vendored copy of adcp PR #7945's vectors, used only until a released
 * compliance bundle carries `test-vectors/request-signing/a2a/`.
 *
 * Resolved relative to this module: `src/lib/testing/storyboard/request-signing`
 * and its compiled `dist/` twin are both five levels below the package root.
 * `test/` is not in the package's `files`, so an installed package has no such
 * directory and the existence check below yields "no vectors" rather than a
 * path into someone else's tree.
 */
function vendoredA2aVectorsDir(): string {
  return resolve(__dirname, '..', '..', '..', '..', '..', 'test', 'fixtures', 'request-signing-a2a');
}

function hasA2aVectorDirs(dir: string): boolean {
  return existsSync(join(dir, 'positive')) && existsSync(join(dir, 'negative'));
}

/**
 * Load the A2A operation-resolution vectors.
 *
 * Resolution order:
 *   1. `options.a2aVectorsDir`, else `$ADCP_A2A_VECTORS_DIR` (explicit; must exist).
 *   2. `<complianceCache>/test-vectors/request-signing/a2a/`.
 *   3. The vendored `test/fixtures/request-signing-a2a/` copy, when present
 *      (repo checkouts only; never shipped).
 *
 * Returns `source: 'none'` with empty arrays when none exist; callers MUST
 * report that rather than treating it as a pass.
 */
export function loadA2aOperationResolutionVectors(options: LoadVectorsOptions = {}): LoadedA2aVectors {
  const explicit = options.a2aVectorsDir ?? (process.env[A2A_VECTORS_DIR_ENV] || undefined);
  let source: A2aVectorSource;
  let dir: string;
  if (explicit) {
    if (!hasA2aVectorDirs(explicit)) {
      throw new Error(`A2A operation-resolution vectors not found at ${explicit} (expected positive/ and negative/).`);
    }
    source = 'override';
    dir = explicit;
  } else {
    const cacheDir = join(getComplianceCacheDir(options), 'test-vectors', 'request-signing', 'a2a');
    const vendored = vendoredA2aVectorsDir();
    if (hasA2aVectorDirs(cacheDir)) {
      source = 'compliance_cache';
      dir = cacheDir;
    } else if (options.a2aVendoredFallback !== false && hasA2aVectorDirs(vendored)) {
      source = 'vendored_fixture';
      dir = vendored;
    } else {
      return { positive: [], negative: [], source: 'none' };
    }
  }

  // Memoized per directory; `source` is how this call reached it, so it is not cached.
  let parsed = A2A_VECTOR_CACHE.get(dir);
  if (!parsed) {
    parsed = {
      positive: loadDir(join(dir, 'positive'), parseA2aPositive, 'a2a/positive/'),
      negative: loadDir(join(dir, 'negative'), parseA2aNegative, 'a2a/negative/'),
    };
    A2A_VECTOR_CACHE.set(dir, parsed);
  }
  return { ...parsed, source, sourceDir: dir };
}

function parseA2aTier(id: string, r: Record<string, unknown>): A2aVectorTier {
  const tier = r.tier;
  if (typeof tier !== 'string' || !(A2A_VECTOR_TIERS as readonly string[]).includes(tier)) {
    throw new Error(`${id}: tier must be one of ${A2A_VECTOR_TIERS.join(', ')} (got ${JSON.stringify(tier)})`);
  }
  return tier as A2aVectorTier;
}

function parseA2aOutcome(id: string, r: Record<string, unknown>): A2aExpectedOutcome {
  const o = r.expected_outcome as Record<string, unknown>;
  const resolved = o.resolved_operation;
  if (resolved !== undefined && resolved !== null && typeof resolved !== 'string') {
    throw new Error(`${id}: expected_outcome.resolved_operation must be a string or null`);
  }
  const status = o.status;
  if (status !== undefined && status !== 'verified' && status !== 'unsigned') {
    throw new Error(`${id}: expected_outcome.status must be "verified" or "unsigned"`);
  }
  return {
    success: o.success as boolean,
    ...(status !== undefined && { status }),
    ...(typeof o.error_code === 'string' && { error_code: o.error_code as A2aExpectedOutcome['error_code'] }),
    ...(o.failed_step !== undefined && { failed_step: o.failed_step as number | string }),
    ...(resolved !== undefined && { resolved_operation: resolved as string | null }),
    ...(typeof o.dispatched_operation === 'string' && { dispatched_operation: o.dispatched_operation }),
    ...(typeof o.dispatch === 'string' && { dispatch: o.dispatch }),
  };
}

function parseA2aPositive(id: string, raw: unknown): A2aPositiveVector {
  const r = raw as Record<string, unknown>;
  const base = parsePositive(id, raw);
  const expected_outcome = parseA2aOutcome(id, r);
  if (expected_outcome.status === undefined) {
    throw new Error(`${id}: positive A2A vector requires expected_outcome.status`);
  }
  return {
    ...base,
    tier: parseA2aTier(id, r),
    expected_outcome: expected_outcome as A2aPositiveVector['expected_outcome'],
  };
}

function parseA2aNegative(id: string, raw: unknown): A2aNegativeVector {
  const r = raw as Record<string, unknown>;
  const base = parseNegative(id, raw);
  return {
    ...base,
    tier: parseA2aTier(id, r),
    expected_outcome: parseA2aOutcome(id, r) as A2aNegativeVector['expected_outcome'],
  };
}

function loadDir<T extends Vector>(dir: string, parse: (id: string, raw: unknown) => T, idPrefix = ''): T[] {
  if (!existsSync(dir)) {
    throw new Error(`Vector directory missing: ${dir}`);
  }
  const files = readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort();
  return files.map(f => {
    const raw = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
    return parse(`${idPrefix}${vectorIdFromFilename(f)}`, raw);
  });
}

function vectorIdFromFilename(file: string): string {
  return basename(file, '.json');
}

function parsePositive(id: string, raw: unknown): PositiveVector {
  const r = raw as Record<string, unknown>;
  assertSuccess(id, r, true);
  const { jwks_ref, jwks_override } = parseJwksSelector(id, r);
  return {
    kind: 'positive',
    id,
    name: str(r.name, `${id}.name`),
    signing_profile_version: optionalSigningProfileVersion(r),
    reference_now: num(r.reference_now, `${id}.reference_now`),
    request: parseRequest(id, r.request),
    verifier_capability: parseCapability(id, r.verifier_capability),
    jwks_ref,
    jwks_override,
    expected_signature_base: typeof r.expected_signature_base === 'string' ? r.expected_signature_base : undefined,
    spec_reference: typeof r.spec_reference === 'string' ? r.spec_reference : undefined,
  };
}

function parseNegative(id: string, raw: unknown): NegativeVector {
  const r = raw as Record<string, unknown>;
  assertSuccess(id, r, false);
  const outcome = r.expected_outcome as Record<string, unknown>;
  const errorCode = str(outcome.error_code, `${id}.expected_outcome.error_code`);
  if (!ERROR_CODES.has(errorCode)) {
    throw new Error(`${id}: unknown expected_outcome.error_code "${errorCode}" (spec drift?)`);
  }
  const failedStep = outcome.failed_step;
  if (typeof failedStep !== 'number' && typeof failedStep !== 'string') {
    throw new Error(`${id}: expected_outcome.failed_step must be number or string`);
  }
  let contract: ContractId | undefined;
  if (r.requires_contract !== undefined) {
    const c = str(r.requires_contract, `${id}.requires_contract`);
    if (!CONTRACT_ID_SET.has(c)) {
      throw new Error(`${id}: unknown requires_contract "${c}" (spec drift?)`);
    }
    contract = c as ContractId;
  }
  const { jwks_ref, jwks_override } = parseJwksSelector(id, r);
  return {
    kind: 'negative',
    id,
    name: str(r.name, `${id}.name`),
    signing_profile_version: optionalSigningProfileVersion(r),
    reference_now: num(r.reference_now, `${id}.reference_now`),
    request: parseRequest(id, r.request),
    verifier_capability: parseCapability(id, r.verifier_capability),
    jwks_ref,
    jwks_override,
    expected_error_code: errorCode as RequestSignatureErrorCode,
    expected_failed_step: failedStep,
    requires_contract: contract,
    spec_reference: typeof r.spec_reference === 'string' ? r.spec_reference : undefined,
  };
}

function optionalSigningProfileVersion(vector: Record<string, unknown>): string {
  // Older cached bundles predate the explicit marker; every root vector in
  // those bundles exercises the legacy 3.1 binary profile.
  return typeof vector.signing_profile_version === 'string' ? vector.signing_profile_version : '3.1';
}

function parseJwksSelector(
  id: string,
  r: Record<string, unknown>
): { jwks_ref?: string[]; jwks_override?: { keys: Array<Record<string, unknown>> } } {
  const hasRef = r.jwks_ref !== undefined;
  const hasOverride = r.jwks_override !== undefined;
  if (hasRef && hasOverride) {
    throw new Error(`${id}: jwks_ref and jwks_override are mutually exclusive`);
  }
  if (!hasRef && !hasOverride) {
    throw new Error(`${id}: must declare either jwks_ref or jwks_override`);
  }
  if (hasOverride) {
    const override = r.jwks_override as Record<string, unknown>;
    const keys = override.keys;
    if (!Array.isArray(keys) || keys.length === 0) {
      throw new Error(`${id}.jwks_override.keys must be a non-empty array`);
    }
    for (const k of keys) {
      if (!k || typeof k !== 'object') {
        throw new Error(`${id}.jwks_override.keys[] entries must be objects`);
      }
    }
    return { jwks_override: { keys: keys as Array<Record<string, unknown>> } };
  }
  return { jwks_ref: strArray(r.jwks_ref, `${id}.jwks_ref`) };
}

function assertSuccess(id: string, vector: Record<string, unknown>, expected: boolean): void {
  const outcome = vector.expected_outcome as Record<string, unknown> | undefined;
  if (!outcome || outcome.success !== expected) {
    throw new Error(
      `${id}: expected_outcome.success must be ${expected} for ${expected ? 'positive' : 'negative'} vector`
    );
  }
}

function parseRequest(id: string, raw: unknown): PositiveVector['request'] {
  const r = raw as Record<string, unknown> | undefined;
  if (!r) throw new Error(`${id}.request missing`);
  const headers = r.headers as Record<string, string> | undefined;
  if (!headers) throw new Error(`${id}.request.headers missing`);
  return {
    method: str(r.method, `${id}.request.method`),
    url: str(r.url, `${id}.request.url`),
    headers: { ...headers },
    body: typeof r.body === 'string' ? r.body : undefined,
  };
}

function parseCapability(id: string, raw: unknown): PositiveVector['verifier_capability'] {
  const r = raw as Record<string, unknown> | undefined;
  if (!r) throw new Error(`${id}.verifier_capability missing`);
  const digest = str(r.covers_content_digest, `${id}.verifier_capability.covers_content_digest`);
  if (digest !== 'required' && digest !== 'forbidden' && digest !== 'either') {
    throw new Error(`${id}: invalid covers_content_digest "${digest}"`);
  }
  return {
    supported: bool(r.supported, `${id}.verifier_capability.supported`),
    covers_content_digest: digest,
    required_for: strArray(r.required_for, `${id}.verifier_capability.required_for`),
    supported_for: Array.isArray(r.supported_for) ? (r.supported_for as string[]) : undefined,
    protocol_methods_supported_for: Array.isArray(r.protocol_methods_supported_for)
      ? (r.protocol_methods_supported_for as string[])
      : undefined,
    protocol_methods_required_for: Array.isArray(r.protocol_methods_required_for)
      ? (r.protocol_methods_required_for as string[])
      : undefined,
  };
}

function loadKeys(keysPath: string): TestKeyset {
  if (!existsSync(keysPath)) {
    throw new Error(`keys.json missing at ${keysPath}`);
  }
  const raw = JSON.parse(readFileSync(keysPath, 'utf-8')) as { keys?: unknown };
  if (!Array.isArray(raw.keys)) {
    throw new Error(`keys.json must contain a "keys" array`);
  }
  return { keys: raw.keys.map((k, i) => parseKey(i, k)) };
}

function parseKey(index: number, raw: unknown): TestKeypair {
  const r = raw as Record<string, unknown>;
  const where = `keys.json[${index}]`;
  const privateD = r._private_d_for_test_only;
  if (typeof privateD !== 'string' || privateD.length === 0) {
    throw new Error(`${where}._private_d_for_test_only missing (required for dynamic signing)`);
  }
  return {
    kid: str(r.kid, `${where}.kid`),
    kty: str(r.kty, `${where}.kty`),
    crv: typeof r.crv === 'string' ? r.crv : undefined,
    alg: typeof r.alg === 'string' ? r.alg : undefined,
    use: typeof r.use === 'string' ? r.use : undefined,
    key_ops: Array.isArray(r.key_ops) ? (r.key_ops as string[]) : undefined,
    adcp_use: typeof r.adcp_use === 'string' ? r.adcp_use : undefined,
    x: typeof r.x === 'string' ? r.x : undefined,
    y: typeof r.y === 'string' ? r.y : undefined,
    private_d: privateD,
  };
}

export function findKey(keyset: TestKeyset, kid: string): TestKeypair {
  const match = keyset.keys.find(k => k.kid === kid);
  if (!match) {
    throw new Error(
      `No test keypair with kid="${kid}" in keys.json (available: ${keyset.keys.map(k => k.kid).join(', ')})`
    );
  }
  return match;
}

function str(v: unknown, where: string): string {
  if (typeof v !== 'string') throw new Error(`${where} must be string`);
  return v;
}

function num(v: unknown, where: string): number {
  if (typeof v !== 'number') throw new Error(`${where} must be number`);
  return v;
}

function bool(v: unknown, where: string): boolean {
  if (typeof v !== 'boolean') throw new Error(`${where} must be boolean`);
  return v;
}

function strArray(v: unknown, where: string): string[] {
  if (!Array.isArray(v) || v.some(item => typeof item !== 'string')) {
    throw new Error(`${where} must be string[]`);
  }
  return v as string[];
}
