/**
 * Compliance-cache loader.
 *
 * Storyboards live on disk under `compliance/cache/{version}/` after
 * `npm run sync-schemas` pulls the `/protocol/{version}.tgz` bundle.
 * This module reads that tree, resolves `get_adcp_capabilities` →
 * storyboards to run, and supports ad-hoc single-storyboard loads for
 * spec evolution.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { loadStoryboardFile } from './loader';
import { ADCP_VERSION } from '../../version';
import { ADCPError } from '../../errors';
import { isAdcpVersionSupported } from '../../utils/adcp-version-config';
import { hasSchemaBundle, resolveBundleKey } from '../../validation/schema-loader';
import { synthesizeRequestSigningSteps } from './request-signing/synthesize';
import type { RunnerSelectionResult, Storyboard } from './types';

/**
 * Discriminator for configuration faults `resolveStoryboardsForCapabilities`
 * surfaces. `unknown_protocol` is reserved for future use — today it emits a
 * `console.warn` rather than throwing.
 */
export type CapabilityResolutionCode =
  | 'specialism_parent_protocol_missing'
  | 'unknown_specialism'
  | 'unknown_protocol'
  | 'unsupported_adcp_version';

/**
 * Thrown when the agent's declared capabilities cannot be mapped onto the
 * compliance cache. These are agent-configuration faults, not network or
 * cache-integrity problems — callers should branch on `code` to distinguish
 * them from runtime failures rather than regexing `message`.
 */
export class CapabilityResolutionError extends ADCPError {
  readonly code: CapabilityResolutionCode;
  readonly specialism?: string;
  readonly parentProtocol?: string;
  readonly protocol?: string;

  constructor(params: {
    code: CapabilityResolutionCode;
    message: string;
    specialism?: string;
    parentProtocol?: string;
    protocol?: string;
  }) {
    super(params.message);
    this.code = params.code;
    if (params.specialism !== undefined) this.specialism = params.specialism;
    if (params.parentProtocol !== undefined) this.parentProtocol = params.parentProtocol;
    if (params.protocol !== undefined) this.protocol = params.protocol;
  }
}

/**
 * Maps `supported_protocols` enum values (snake_case) to compliance-cache
 * path segments (kebab-case).
 *
 * Exported so the drift-alarm test can assert every spec enum value has a mapping.
 */
export const PROTOCOL_TO_PATH: Readonly<Record<string, string>> = Object.freeze({
  media_buy: 'media-buy',
  creative: 'creative',
  signals: 'signals',
  governance: 'governance',
  brand: 'brand',
  sponsored_intelligence: 'sponsored-intelligence',
  measurement: 'measurement',
});

export const UNBASELINED_SUPPORTED_PROTOCOLS: ReadonlySet<string> = new Set([
  // Declared in get_adcp_capabilities.supported_protocols, but 3.1.0-beta.3
  // ships no standalone compliance/protocols/measurement baseline yet.
  'measurement',
]);

export interface ComplianceIndexProtocol {
  id: string;
  title: string | null;
  has_baseline: boolean;
  path: string;
}

export interface ComplianceIndexSpecialism {
  id: string;
  protocol: string;
  title: string | null;
  status: string;
  path: string;
}

export interface ComplianceIndex {
  published_version?: string;
  adcp_version: string;
  generated_at: string;
  universal: string[];
  protocols: ComplianceIndexProtocol[];
  specialisms: ComplianceIndexSpecialism[];
}

export type BundleKind = 'universal' | 'protocol' | 'specialism';

export interface BundleRef {
  kind: BundleKind;
  /** `capability-discovery` for universal, `media-buy` for protocol, `sales-guaranteed` for specialism. */
  id: string;
  /** Path to the bundle directory (or YAML file, for universal bundles). */
  path: string;
  /** AdCP cache version this bundle came from. */
  adcp_version?: string;
}

export interface AgentCapabilities {
  /** AdCP protocols the agent implements. Snake_case per schema. */
  supported_protocols?: string[];
  /** Optional specialisms the agent claims. */
  specialisms?: string[];
  /**
   * AdCP major versions the agent declared (from `get_adcp_capabilities.adcp.major_versions`).
   * When set, storyboards carrying `introduced_in: <major.minor>` whose major
   * isn't in this list are filtered into `not_applicable` instead of being
   * run against an agent that predates them. Unset → no version gating.
   */
  major_versions?: number[];
  /**
   * Exact/release-precision AdCP versions the seller supports, from
   * `get_adcp_capabilities.adcp.supported_versions`. When present, the
   * runner treats it as more specific than `major_versions`.
   */
  supported_versions?: string[];
}

/** Reason a storyboard was not run against an agent. */
export interface NotApplicableStoryboard {
  storyboard_id: string;
  storyboard_title: string;
  /** Track this storyboard would have contributed to, if known. */
  track?: string;
  reason: string;
  /** Selection reason when the storyboard was excluded before execution. */
  selection_result?: RunnerSelectionResult;
}

export interface ResolveOptions {
  /** Explicit version override; defaults to the client's pinned ADCP_VERSION. */
  version?: string;
  /** Override the compliance cache root (tests use this to point at fixtures). */
  complianceDir?: string;
  /**
   * Explicit schema bundle root to use with the selected compliance cache.
   * The path must point at the schema-data directory for the cache version,
   * for example `.../dist/lib/schemas-data/3.0`.
   */
  schemaRoot?: string;
  /**
   * Hosted badge compatibility alias. When set, a prerelease compliance cache
   * for this stable line (for example cache `3.1.0-beta.7` with alias `3.1`)
   * may be selected for a seller that advertises the stable line in
   * `adcp.supported_versions`.
   *
   * This is deliberately scoped to a single resolver call. Normal wire-version
   * negotiation and explicit beta diagnostic targets stay strict unless the
   * caller opts in here.
   */
  hostedStableLineAlias?: string;
}

export interface ResolvedBundle {
  ref: BundleRef;
  storyboards: Storyboard[];
}

export interface ResolvedStoryboards {
  bundles: ResolvedBundle[];
  storyboards: Storyboard[];
  /**
   * Storyboards the agent's declared `major_versions` predates. Surfaced so
   * callers can render a `not_applicable` row — silently dropping them would
   * mean an agent that hasn't certified against a later spec version passes
   * vacuously.
   */
  not_applicable: NotApplicableStoryboard[];
}

function getRepoRoot(): string {
  // Walks from src/lib/testing/storyboard/ (or dist/lib/testing/storyboard/) → package root.
  return resolve(__dirname, '..', '..', '..', '..');
}

/**
 * Resolve the compliance cache directory.
 *
 * Priority:
 *   1. `options.complianceDir` (explicit override, used by tests)
 *   2. `ADCP_COMPLIANCE_DIR` env var (full path including version dir, for packaged consumers)
 *   3. `{package-root}/compliance/cache/{version}` (default, ships with the npm package)
 */
export function getComplianceCacheDir(options: ResolveOptions = {}): string {
  const configured = getConfiguredComplianceDir(options);
  if (configured) return configured;
  const version = options.version || readAdcpVersion();
  return join(getRepoRoot(), 'compliance', 'cache', version);
}

function readAdcpVersion(): string {
  // Compile-time ADCP_VERSION from src/lib/version.ts is the single source of truth
  // at runtime. scripts/sync-schemas.ts still reads the text file — sync-version.ts
  // keeps them aligned so the cache directory the lib expects matches what sync wrote.
  return ADCP_VERSION;
}

function complianceMissingMessage(what: string, path: string): string {
  return (
    `${what} not found at ${path}. ` +
    `The compliance cache ships with @adcp/sdk — run \`npm i @adcp/sdk@latest\` (or \`npx @adcp/sdk@latest …\`) to pick up the current cache. ` +
    `If developing locally, run \`npm run sync-schemas\` to populate the cache.`
  );
}

/** Load and parse `index.json` from the compliance cache. */
export function loadComplianceIndex(options: ResolveOptions = {}): ComplianceIndex {
  const dir = getComplianceCacheDir(options);
  const indexPath = join(dir, 'index.json');
  if (!existsSync(indexPath)) {
    throw new Error(complianceMissingMessage('Compliance cache', dir));
  }
  const index = JSON.parse(readFileSync(indexPath, 'utf-8')) as ComplianceIndex;
  return normalizeComplianceIndex(index, options, indexPath);
}

export function getExternalSchemaRootForCompliance(options: ResolveOptions, adcpVersion: string): string | undefined {
  const configuredSchemaRoot = getConfiguredSchemaRoot(options);
  if (configuredSchemaRoot) return configuredSchemaRoot;
  const complianceDir = getConfiguredComplianceDir(options);
  const siblingSchemaRoot = complianceDir ? findExternalSchemaRoot(complianceDir, adcpVersion) : undefined;
  if (siblingSchemaRoot) return siblingSchemaRoot;
  if (options.version !== undefined || complianceDir !== undefined) {
    assertComplianceSchemaBundleAvailable(options, adcpVersion, complianceDir);
  }
  return undefined;
}

function assertComplianceSchemaBundleAvailable(
  options: ResolveOptions,
  adcpVersion: string,
  complianceDir: string | undefined
): void {
  if (hasSchemaBundle(adcpVersion)) return;
  const selector = options.version ? `--compliance-version ${options.version}` : `compliance cache ${complianceDir}`;
  const bundleKey = resolveBundleKey(adcpVersion);
  throw new Error(
    `${selector} selected AdCP compliance version "${adcpVersion}", but no matching schema bundle was found. ` +
      `Refusing to validate storyboard responses with the installed default schemas. ` +
      `Pass --schema-root PATH or set ADCP_SCHEMA_ROOT to a schema-data root for "${adcpVersion}" ` +
      `(for example dist/lib/schemas-data/${bundleKey} or schemas/cache/${adcpVersion}), ` +
      `or install/sync an @adcp/sdk package that includes that schema bundle.`
  );
}

function getConfiguredComplianceDir(options: Pick<ResolveOptions, 'complianceDir'>): string | undefined {
  return options.complianceDir ?? process.env.ADCP_COMPLIANCE_DIR;
}

function getConfiguredSchemaRoot(options: Pick<ResolveOptions, 'schemaRoot'>): string | undefined {
  return options.schemaRoot ?? process.env.ADCP_SCHEMA_ROOT;
}

function normalizeComplianceIndex(index: ComplianceIndex, options: ResolveOptions, indexPath: string): ComplianceIndex {
  if (index.adcp_version === 'latest') {
    const repairedVersion = findReplacementForLatestComplianceVersion(index, options);
    if (repairedVersion) {
      return { ...index, adcp_version: repairedVersion };
    }
  }

  assertValidComplianceIndexVersion(index.adcp_version, indexPath);
  return index;
}

function findReplacementForLatestComplianceVersion(
  index: ComplianceIndex,
  options: ResolveOptions
): string | undefined {
  if (isValidComplianceIndexVersion(index.published_version)) return index.published_version;

  const schemaRoot = getConfiguredSchemaRoot(options);
  const configuredVersion = schemaRoot ? readSchemaRootAdcpVersion(schemaRoot) : undefined;
  if (configuredVersion) return configuredVersion;

  if (!options.complianceDir) return undefined;
  return readSiblingSchemaAdcpVersion(options.complianceDir);
}

function readSchemaRootAdcpVersion(schemaRoot: string): string | undefined {
  const roots = [schemaRoot];
  if (basename(schemaRoot) === 'bundled') roots.push(dirname(schemaRoot));

  for (const root of roots) {
    const indexPath = join(root, 'index.json');
    if (!existsSync(indexPath)) continue;
    try {
      const parsed = JSON.parse(readFileSync(indexPath, 'utf-8')) as { adcp_version?: unknown };
      if (isValidComplianceIndexVersion(parsed.adcp_version)) return parsed.adcp_version;
    } catch {
      // Schema-root discovery is best-effort; the final compliance-index
      // validation below owns the actionable error when no replacement exists.
    }
  }
  for (const root of roots) {
    const version = readSchemaIdVersion(root);
    if (version) return version;
  }
  return undefined;
}

function readSchemaIdVersion(root: string): string | undefined {
  const versions = new Set<string>();
  const scanRoot = existsSync(join(root, 'bundled')) ? join(root, 'bundled') : root;
  for (const file of walkJsonFiles(scanRoot)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { $id?: unknown };
      if (typeof parsed.$id !== 'string') continue;
      const version = parsed.$id.match(/\/schemas\/([^/]+)\//)?.[1];
      if (isValidComplianceIndexVersion(version)) versions.add(version);
    } catch {
      // Best-effort discovery; malformed schemas are handled by validation.
    }
  }
  return versions.size === 1 ? [...versions][0] : undefined;
}

function readSiblingSchemaAdcpVersion(complianceDir: string): string | undefined {
  for (const schemaRoot of schemaRootCandidatesForComplianceDir(complianceDir)) {
    const version = readSchemaRootAdcpVersion(schemaRoot);
    if (version) return version;
  }
  return undefined;
}

function isValidComplianceIndexVersion(version: unknown): version is string {
  if (typeof version !== 'string') return false;
  try {
    resolveBundleKey(version);
    return true;
  } catch {
    return false;
  }
}

function assertValidComplianceIndexVersion(version: string, indexPath: string): void {
  try {
    resolveBundleKey(version);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Compliance cache ${indexPath} declares invalid adcp_version ${JSON.stringify(version)}. ` +
        `adcp_version must be a real AdCP bundle version, not a selector alias such as "latest". ` +
        `If this is a local development bundle, pass ADCP_SCHEMA_ROOT or --schema-root pointing at the matching schema bundle. ` +
        reason
    );
  }
}

function findExternalSchemaRoot(complianceDir: string, adcpVersion: string): string | undefined {
  const candidates = [complianceDir, ...schemaRootCandidatesForComplianceDir(complianceDir, adcpVersion)];
  return candidates.find(hasSchemaRootShape);
}

function schemaRootCandidatesForComplianceDir(complianceDir: string, adcpVersion?: string): string[] {
  const candidates = new Set<string>();
  const packageRoots = packageRootCandidatesForComplianceDir(complianceDir);
  const add = (candidate: string) => candidates.add(candidate);

  for (const packageRoot of packageRoots) {
    addVersionedSchemaRoots(packageRoot, adcpVersion ?? ADCP_VERSION, add);
  }
  for (const packageRoot of packageRoots) {
    add(join(packageRoot, 'dist', 'schemas', 'latest'));
    add(join(packageRoot, 'schemas', 'cache', 'latest'));
    add(join(packageRoot, 'dist', 'lib', 'schemas-data', 'latest'));
  }
  if (adcpVersion === undefined) {
    for (const packageRoot of packageRoots) {
      addSchemaContainerChildren(join(packageRoot, 'dist', 'lib', 'schemas-data'), add);
      addSchemaContainerChildren(join(packageRoot, 'dist', 'schemas'), add);
      addSchemaContainerChildren(join(packageRoot, 'schemas', 'cache'), add);
    }
  }

  return [...candidates];
}

function addVersionedSchemaRoots(packageRoot: string, adcpVersion: string, add: (candidate: string) => void): void {
  const key = resolveBundleKey(adcpVersion);
  add(join(packageRoot, 'dist', 'lib', 'schemas-data', key));
  add(join(packageRoot, 'dist', 'schemas', adcpVersion));
  add(join(packageRoot, 'dist', 'schemas', key));
  add(join(packageRoot, 'schemas', 'cache', adcpVersion));
  add(join(packageRoot, 'schemas', 'cache', key));
}

function addSchemaContainerChildren(container: string, add: (candidate: string) => void): void {
  if (!existsSync(container)) return;
  for (const entry of readdirSync(container).sort().reverse()) {
    const full = join(container, entry);
    try {
      if (statSync(full).isDirectory()) add(full);
    } catch {
      // Best-effort sibling discovery; ignore entries that disappear mid-scan.
    }
  }
}

function packageRootCandidatesForComplianceDir(complianceDir: string): string[] {
  const roots = new Set<string>();
  const resolved = resolve(complianceDir);
  let current = resolved;

  while (true) {
    if (basename(current) === 'compliance') {
      const parent = dirname(current);
      if (basename(parent) === 'dist') roots.add(dirname(parent));
      roots.add(parent);
    }
    const next = dirname(current);
    if (next === current) break;
    current = next;
  }

  roots.add(dirname(dirname(dirname(resolved))));
  return [...roots];
}

function hasSchemaRootShape(root: string): boolean {
  if (!existsSync(root)) return false;
  const scanRoot = existsSync(join(root, 'bundled')) ? join(root, 'bundled') : root;
  return walkJsonFiles(scanRoot).some(file => {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { $id?: unknown; $schema?: unknown };
      return typeof parsed.$id === 'string' || typeof parsed.$schema === 'string';
    } catch {
      return false;
    }
  });
}

function walkJsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJsonFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.json')) out.push(full);
  }
  return out;
}

/**
 * Load every storyboard YAML under a directory tree (non-recursive for files at the top
 * level of a bundle, recursive for nested `scenarios/`). YAMLs that don't have a top-level
 * `id:` (schema / fixture files) are skipped.
 */
function loadStoryboardsFromDir(dir: string): Storyboard[] {
  if (!existsSync(dir)) return [];
  const storyboards: Storyboard[] = [];
  const visit = (current: string) => {
    // Sort entries so ordering is deterministic across filesystems.
    const entries = readdirSync(current).sort();
    // Prefer index.yaml first so bundle-as-id lookups resolve to the main storyboard.
    entries.sort((a, b) => {
      if (a === 'index.yaml') return -1;
      if (b === 'index.yaml') return 1;
      return 0;
    });
    for (const entry of entries) {
      const full = join(current, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        visit(full);
      } else if (entry.endsWith('.yaml') || entry.endsWith('.yml')) {
        try {
          storyboards.push(loadStoryboardFile(full));
        } catch (err) {
          // Peek at the file — if it has an `id:` line it was meant to be a
          // storyboard and the error is a real problem; otherwise it's a schema
          // or fixture file (e.g., storyboard-schema.yaml) and silence is fine.
          try {
            const text = readFileSync(full, 'utf-8');
            if (/^id:\s*\S/m.test(text)) {
              console.warn(`[compliance] Failed to parse storyboard ${full}: ${(err as Error).message}`);
            }
          } catch {
            /* unreadable file — treat as non-storyboard */
          }
        }
      }
    }
  };
  visit(dir);
  return storyboards;
}

/** Load storyboards for a single bundle (universal YAML file, domain dir, or specialism dir). */
export function loadBundleStoryboards(ref: BundleRef): Storyboard[] {
  const raw = ref.kind === 'universal' ? safeLoadUniversal(ref.path) : loadStoryboardsFromDir(ref.path);
  return raw.map(sb => annotateStoryboardVersion(postProcessStoryboard(sb), ref.adcp_version));
}

function annotateStoryboardVersion(storyboard: Storyboard, adcpVersion: string | undefined): Storyboard {
  return adcpVersion === undefined ? storyboard : { ...storyboard, adcp_version: adcpVersion };
}

function safeLoadUniversal(path: string): Storyboard[] {
  try {
    return [loadStoryboardFile(path)];
  } catch {
    return [];
  }
}

/**
 * Post-process storyboards loaded from the cache. The signed-requests
 * specialism ships phases whose steps are generated at runtime from the
 * request-signing test vectors; synthesize them here so downstream callers
 * (the runner, CLI tooling, reporting) see a fully-populated storyboard.
 */
function postProcessStoryboard(storyboard: Storyboard): Storyboard {
  if (storyboard.id === 'signed_requests') {
    try {
      return synthesizeRequestSigningSteps(storyboard);
    } catch (err) {
      // Synthesis failure = infrastructural problem (cache missing vectors,
      // schema drift, etc.). Emit a synthetic failing phase so the runner's
      // existing reporting surfaces the cause — silent empty-phase fallback
      // would render as a green pass with 0 steps, which is the worst
      // possible outcome for CI pipelines.
      return withSynthesisErrorPhase(storyboard, err);
    }
  }
  return storyboard;
}

function withSynthesisErrorPhase(storyboard: Storyboard, err: unknown): Storyboard {
  const message = err instanceof Error ? err.message : String(err);
  const errorPhase = {
    id: 'synthesis_error',
    title: 'Request-signing vector synthesis failed',
    narrative:
      'The signed-requests specialism requires its phases to be synthesized at load time ' +
      'from the compliance cache. Synthesis failed — the runner cannot grade against the ' +
      'conformance vectors. Run `npm run sync-schemas` to refresh the cache.',
    steps: [
      {
        id: 'synthesis_error',
        title: 'Synthesize vector phases',
        task: 'synthesis_error',
        narrative: message,
        expect_error: false,
      },
    ],
  };
  return { ...storyboard, phases: [errorPhase, ...storyboard.phases] };
}

/** Enumerate every bundle present in the cache (universal + protocols + specialisms). */
export function listBundles(options: ResolveOptions = {}): BundleRef[] {
  const dir = getComplianceCacheDir(options);
  const index = loadComplianceIndex(options);
  const bundles: BundleRef[] = [];

  for (const name of index.universal) {
    bundles.push({
      kind: 'universal',
      id: name,
      path: join(dir, 'universal', `${name}.yaml`),
      adcp_version: index.adcp_version,
    });
  }
  for (const protocol of index.protocols) {
    if (!protocol.has_baseline) continue;
    bundles.push({
      kind: 'protocol',
      id: protocol.id,
      path: join(dir, 'protocols', protocol.id),
      adcp_version: index.adcp_version,
    });
  }
  for (const specialism of index.specialisms) {
    bundles.push({
      kind: 'specialism',
      id: specialism.id,
      path: join(dir, 'specialisms', specialism.id),
      adcp_version: index.adcp_version,
    });
  }
  return bundles;
}

/** List every storyboard the cache can produce, across all bundles. */
export function listAllComplianceStoryboards(options: ResolveOptions = {}): Storyboard[] {
  const seen = new Set<string>();
  const storyboards: Storyboard[] = [];
  for (const ref of listBundles(options)) {
    for (const sb of loadBundleStoryboards(ref)) {
      if (seen.has(sb.id)) continue;
      seen.add(sb.id);
      storyboards.push(sb);
    }
  }
  return storyboards;
}

/**
 * Find a storyboard by its internal `id` (the YAML's `id:` field).
 * Scans every bundle in the cache. Returns undefined if no match.
 */
export function getComplianceStoryboardById(id: string, options: ResolveOptions = {}): Storyboard | undefined {
  for (const sb of listAllComplianceStoryboards(options)) {
    if (sb.id === id) return sb;
  }
  return undefined;
}

/** Find a bundle by its directory/file id (`media-buy`, `sales-guaranteed`, `capability-discovery`). */
export function findBundleById(id: string, options: ResolveOptions = {}): BundleRef | undefined {
  return listBundles(options).find(b => b.id === id);
}

/**
 * Resolved view of a specialism for the `adcp specialism show` CLI: the
 * specialism's own storyboard plus every protocol scenario it pulls in via
 * `requires_scenarios`. Useful as a pre-flight "what will CI actually run
 * against my server?" answer.
 */
export interface SpecialismDetail {
  slug: string;
  protocol: string;
  status: string;
  /** Title from index.json (kept separate from storyboard.title for fallback). */
  index_title: string | null;
  /** The specialism's own index.yaml parsed as a Storyboard. */
  storyboard: Storyboard;
  /**
   * Required scenarios pulled in from protocol bundles via the index.yaml's
   * `requires_scenarios` field. Each entry is a fully-resolved Storyboard;
   * `unresolved` lists references that did not match a storyboard in the cache.
   */
  required_scenarios: Storyboard[];
  unresolved_scenarios: string[];
  /** Required tools declared by the specialism (from the index entry). */
  required_tools: string[];
}

export function loadSpecialismDetail(slug: string, options: ResolveOptions = {}): SpecialismDetail {
  const index = loadComplianceIndex(options);
  const entry = index.specialisms.find(s => s.id === slug);
  if (!entry) {
    const known = index.specialisms.map(s => s.id).join(', ');
    throw new Error(`Unknown specialism "${slug}". Known specialisms: ${known}`);
  }

  const bundleStoryboards = loadBundleStoryboards({
    kind: 'specialism',
    id: slug,
    path: join(getComplianceCacheDir(options), 'specialisms', slug),
    adcp_version: index.adcp_version,
  });
  const storyboard = bundleStoryboards.find(sb => sb.category === entry.id.replace(/-/g, '_')) ?? bundleStoryboards[0];
  if (!storyboard) {
    throw new Error(
      `Specialism "${slug}" loaded no storyboards from ${join(getComplianceCacheDir(options), 'specialisms', slug)}`
    );
  }

  const required: Storyboard[] = [];
  const unresolved: string[] = [];
  for (const ref of storyboard.requires_scenarios ?? []) {
    // Scenario YAMLs declare `id: <category>/<scenario_id>` — the slash
    // form is the storyboard's own id and the only safe lookup. Bare-id
    // fallbacks would silently match across categories once future caches
    // ship scenarios with colliding tail segments — better to surface drift
    // through `unresolved_scenarios` than mask it with a wrong-category hit.
    const sb = getComplianceStoryboardById(ref, options);
    if (sb) required.push(sb);
    else unresolved.push(ref);
  }

  // index.json carries the canonical required_tools list — fall back to the
  // storyboard's own field if the index entry is missing it.
  const requiredTools =
    (entry as ComplianceIndexSpecialism & { required_tools?: string[] }).required_tools ??
    storyboard.required_tools ??
    [];

  return {
    slug,
    protocol: entry.protocol,
    status: entry.status,
    index_title: entry.title,
    storyboard,
    required_scenarios: required,
    unresolved_scenarios: unresolved,
    required_tools: requiredTools,
  };
}

export function listSpecialisms(options: ResolveOptions = {}): ComplianceIndexSpecialism[] {
  return loadComplianceIndex(options).specialisms;
}

/**
 * Resolve either a bundle id or a storyboard id to a storyboard set.
 * Bundle ids expand to every storyboard in the bundle (index + scenarios).
 * Storyboard ids resolve to that single storyboard.
 *
 * Used for targeted `storyboard run <agent> <id>` invocations.
 */
export function resolveBundleOrStoryboard(id: string, options: ResolveOptions = {}): Storyboard[] {
  const bundle = findBundleById(id, options);
  if (bundle) return loadBundleStoryboards(bundle);
  const sb = getComplianceStoryboardById(id, options);
  return sb ? [sb] : [];
}

/**
 * Given the agent's `get_adcp_capabilities` response, resolve the set of
 * storyboards the compliance runner should execute:
 *
 *   universal   — every universal bundle (mandatory for every agent)
 *   protocols   — baseline for each declared `supported_protocols` entry
 *   specialisms — every declared specialism
 *
 * Throws `CapabilityResolutionError` (fail-closed) when the declared
 * capabilities cannot be mapped onto the cache:
 *
 *   - `unknown_specialism` — declared specialism has no bundle (usually stale
 *     cache — run `npm run sync-schemas`).
 *   - `specialism_parent_protocol_missing` — declared specialism rolls up to
 *     a protocol the agent didn't include in `supported_protocols`.
 *
 * Unknown `supported_protocols` entries are logged as warnings and skipped
 * rather than thrown (fail-open), so a single bad entry doesn't block the run.
 */
export function resolveStoryboardsForCapabilities(
  caps: AgentCapabilities,
  options: ResolveOptions = {}
): ResolvedStoryboards {
  const index = loadComplianceIndex(options);
  assertSupportedComplianceVersion(index.adcp_version, caps.supported_versions, options);
  const cacheDir = getComplianceCacheDir(options);
  const bundles: ResolvedBundle[] = [];
  const storyboards: Storyboard[] = [];
  const notApplicable: NotApplicableStoryboard[] = [];
  const seenStoryboards = new Set<string>();

  const push = (ref: BundleRef) => {
    const sbs = loadBundleStoryboards(ref);
    bundles.push({ ref, storyboards: sbs });
    for (const sb of sbs) {
      if (seenStoryboards.has(sb.id)) continue;
      seenStoryboards.add(sb.id);
      const gate = checkVersionGate(sb, caps.major_versions);
      if (gate) {
        notApplicable.push({
          storyboard_id: sb.id,
          storyboard_title: sb.title,
          track: sb.track,
          reason: gate,
          selection_result: { reason: 'version_excluded', detail: gate },
        });
        continue;
      }
      storyboards.push(sb);
    }
  };

  for (const name of index.universal) {
    push({
      kind: 'universal',
      id: name,
      path: join(cacheDir, 'universal', `${name}.yaml`),
      adcp_version: index.adcp_version,
    });
  }

  const declaredProtocols = caps.supported_protocols ?? [];
  const declaredProtocolIds = new Set<string>();
  for (const protocol of declaredProtocols) {
    // Legacy: older agents listed `compliance_testing` under supported_protocols.
    // The current schema declares it via the top-level `compliance_testing`
    // capability block instead, and it has no compliance baseline. Skip silently.
    if (protocol === 'compliance_testing' || UNBASELINED_SUPPORTED_PROTOCOLS.has(protocol)) continue;

    const protocolId = PROTOCOL_TO_PATH[protocol];
    if (!protocolId) {
      // Unknown protocol — likely a newer spec version or a typo. Mirror the
      // fail-closed posture on specialisms: surface it loudly, but as a warning
      // on stderr so a single bad entry doesn't block the full run.
      console.warn(
        `[resolveStoryboardsForCapabilities] Unknown supported_protocols entry "${protocol}". ` +
          `This is ignored; compliance cache may be stale or the agent is on a newer AdCP version.`
      );
      continue;
    }
    const entry = index.protocols.find(d => d.id === protocolId);
    if (!entry || !entry.has_baseline) continue;
    declaredProtocolIds.add(protocolId);
    push({
      kind: 'protocol',
      id: protocolId,
      path: join(cacheDir, 'protocols', protocolId),
      adcp_version: index.adcp_version,
    });
  }

  const declaredSpecialisms = caps.specialisms ?? [];
  for (const specialism of declaredSpecialisms) {
    const entry = index.specialisms.find(s => s.id === specialism);
    if (!entry) {
      throw new CapabilityResolutionError({
        code: 'unknown_specialism',
        specialism,
        message:
          `Agent declared specialism "${specialism}" but no bundle exists at ` +
          `${join(cacheDir, 'specialisms', specialism)}. ` +
          `Known specialisms: ${index.specialisms.map(s => s.id).join(', ')}. ` +
          `Compliance cache version: ${index.adcp_version}. ` +
          `This usually means the cache is stale — run \`npm run sync-schemas\`.`,
      });
    }
    // Each specialism rolls up to one parent protocol; the spec requires the parent
    // to also be declared in supported_protocols. AAO enforces this server-side,
    // but catching it client-side stops us from running orphan scenarios.
    if (entry.protocol && !declaredProtocolIds.has(entry.protocol)) {
      throw new CapabilityResolutionError({
        code: 'specialism_parent_protocol_missing',
        specialism,
        parentProtocol: entry.protocol,
        message:
          `Agent declared specialism "${specialism}" (parent protocol: ${entry.protocol}) ` +
          `but did not include "${entry.protocol}" in supported_protocols. ` +
          `Every specialism must roll up to a declared protocol per the AdCP spec.`,
      });
    }
    push({
      kind: 'specialism',
      id: specialism,
      path: join(cacheDir, 'specialisms', specialism),
      adcp_version: index.adcp_version,
    });
  }

  return { bundles, storyboards, not_applicable: notApplicable };
}

export function isComplianceVersionSupported(
  cacheVersion: string,
  supportedVersions: readonly string[],
  options: Pick<ResolveOptions, 'hostedStableLineAlias'> = {}
): boolean {
  return (
    isAdcpVersionSupported(cacheVersion, supportedVersions) ||
    isHostedStableLineAliasSupported(cacheVersion, supportedVersions, options.hostedStableLineAlias)
  );
}

function assertSupportedComplianceVersion(
  cacheVersion: string,
  supportedVersions: string[] | undefined,
  options: Pick<ResolveOptions, 'hostedStableLineAlias'> = {}
): void {
  if (!supportedVersions || supportedVersions.length === 0) return;
  if (isComplianceVersionSupported(cacheVersion, supportedVersions, options)) return;
  throw new CapabilityResolutionError({
    code: 'unsupported_adcp_version',
    message:
      `Compliance cache version ${cacheVersion} is not supported by this seller. ` +
      `Seller advertises adcp.supported_versions [${supportedVersions.join(', ')}]. ` +
      `Install or select a compatible compliance cache instead of relying on major_versions alone.`,
  });
}

function isHostedStableLineAliasSupported(
  cacheVersion: string,
  supportedVersions: readonly string[],
  hostedStableLineAlias: string | undefined
): boolean {
  if (!hostedStableLineAlias || supportedVersions.length === 0) return false;
  const cacheLine = stableLineOf(cacheVersion);
  const aliasLine = stableLineOf(hostedStableLineAlias);
  if (!cacheLine || !aliasLine || cacheLine !== aliasLine) return false;
  if (!isPrereleaseVersion(cacheVersion)) return false;
  return isAdcpVersionSupported(hostedStableLineAlias, supportedVersions);
}

function stableLineOf(version: string): string | undefined {
  const match = /^(?:v)?(\d+)\.(\d+)(?:\.|$|-)/.exec(version);
  return match?.[1] && match?.[2] ? `${match[1]}.${match[2]}` : undefined;
}

function isPrereleaseVersion(version: string): boolean {
  return /^\d+\.\d+(?:\.\d+)?-/.test(version);
}

/**
 * Compare a storyboard's `introduced_in` (e.g., "3.1") against an agent's
 * declared `major_versions` (e.g., `[3]`). Returns a reason string when the
 * storyboard should be gated out; undefined when it applies.
 *
 * Grammar: `introduced_in` is `<major>` or `<major>.<minor>` — only the major
 * is consulted for filtering. Minor/patch components are kept on the storyboard
 * for reporting but don't drive the gate because the spec's `major_versions`
 * array only carries majors.
 *
 * When either side is absent the gate is a no-op: agents that don't declare
 * `major_versions` (v2 synthetic profiles, discovery failures) run every
 * storyboard, and storyboards without `introduced_in` always apply.
 */
function checkVersionGate(sb: Storyboard, agentMajors: number[] | undefined): string | undefined {
  if (!sb.introduced_in || !agentMajors || agentMajors.length === 0) return undefined;
  const parsed = parseIntroducedIn(sb.introduced_in);
  if (parsed === undefined) return undefined; // unparseable → don't block
  if (agentMajors.includes(parsed)) return undefined;
  const declared = agentMajors
    .slice()
    .sort((a, b) => a - b)
    .join(', ');
  return `Introduced in AdCP ${sb.introduced_in}; agent declares major_versions [${declared}].`;
}

function parseIntroducedIn(value: string): number | undefined {
  const match = /^\s*(\d+)(?:\.\d+)*\s*$/.exec(value);
  if (!match?.[1]) return undefined;
  const major = Number.parseInt(match[1], 10);
  return Number.isFinite(major) ? major : undefined;
}
