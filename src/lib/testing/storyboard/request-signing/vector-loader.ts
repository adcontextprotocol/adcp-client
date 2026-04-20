import { existsSync, readFileSync, readdirSync } from 'fs';
import { basename, join } from 'path';
import { getComplianceCacheDir } from '../compliance';
import type { RequestSignatureErrorCode } from '../../../signing';
import { CONTRACT_IDS } from './types';
import type { ContractId, NegativeVector, PositiveVector, TestKeypair, TestKeyset, Vector } from './types';

export interface LoadVectorsOptions {
  complianceDir?: string;
  version?: string;
}

export interface LoadedVectors {
  positive: PositiveVector[];
  negative: NegativeVector[];
  keys: TestKeyset;
  sourceDir: string;
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
  'request_signature_key_unknown',
  'request_signature_key_purpose_invalid',
  'request_signature_key_revoked',
  'request_signature_invalid',
  'request_signature_digest_mismatch',
  'request_signature_replayed',
  'request_signature_rate_abuse',
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

  const loaded: LoadedVectors = {
    positive: loadDir(join(sourceDir, 'positive'), parsePositive),
    negative: loadDir(join(sourceDir, 'negative'), parseNegative),
    keys: loadKeys(join(sourceDir, 'keys.json')),
    sourceDir,
  };
  VECTOR_CACHE.set(sourceDir, loaded);
  return loaded;
}

/** Test-only: clear the memoization cache so a fresh cache path is reread. */
export function __resetVectorCache(): void {
  VECTOR_CACHE.clear();
}

function loadDir<T extends Vector>(dir: string, parse: (id: string, raw: unknown) => T): T[] {
  if (!existsSync(dir)) {
    throw new Error(`Vector directory missing: ${dir}`);
  }
  const files = readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort();
  return files.map(f => {
    const raw = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
    return parse(vectorIdFromFilename(f), raw);
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
