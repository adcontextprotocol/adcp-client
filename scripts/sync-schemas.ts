#!/usr/bin/env tsx

import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
  lstatSync,
  rmSync,
  unlinkSync,
  symlinkSync,
  renameSync,
  copyFileSync,
  cpSync,
} from 'fs';
import { mkdtempSync } from 'fs';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import path from 'path';
import * as tar from 'tar';

const DEFAULT_ADCP_BASE_URL = 'https://adcontextprotocol.org';
const ADCP_BASE_URL = process.env.ADCP_BASE_URL || DEFAULT_ADCP_BASE_URL;
const GITHUB_DIST_BASE_URL = 'https://raw.githubusercontent.com/adcontextprotocol/adcp/main/dist';
const ADCP_SEMANTIC_VERSION =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const REPO_ROOT = path.join(__dirname, '..');
const SCHEMA_CACHE_DIR = path.join(REPO_ROOT, 'schemas/cache');
const COMPLIANCE_CACHE_DIR = path.join(REPO_ROOT, 'compliance/cache');
const SKILLS_DIR = path.join(REPO_ROOT, 'skills');

/**
 * GitHub mirrors used when adcontextprotocol.org is unavailable.
 *
 * Prefer the version tag: release bundles can be removed from the moving
 * `main/dist` snapshot after a release line advances, while the tag keeps the
 * exact historical bundle and its checksum/cosign sidecars addressable.
 */
function getGithubDistFallbackBaseUrls(version: string): string[] {
  if (version === 'latest') return [GITHUB_DIST_BASE_URL];
  return [
    `https://raw.githubusercontent.com/adcontextprotocol/adcp/v${encodeURIComponent(version)}/dist`,
    GITHUB_DIST_BASE_URL,
  ];
}

// Sigstore keyless identity used by the upstream release workflow (adcontextprotocol/adcp#2273).
// Accepts any branch or tag ref — the trust gate is upstream `release.yml`'s
// `on.push.branches` allowlist (currently main, 3.0.x, 2.6.x), which is what
// determines which refs can produce a signature in the first place. Mirroring
// that list here added no defense and silently broke whenever a new release
// line was added (e.g. v3.0.1+ signed from refs/heads/3.0.x rejected by an
// older `(main|2.6.x)` regex). Aligned with adcp-client-python and adcp-go,
// which both use the wildcard form. `refs/tags/*` is forward-compat for any
// future post-tag re-signing flow.
const COSIGN_IDENTITY_REGEX =
  '^https://github\\.com/adcontextprotocol/adcp/\\.github/workflows/release\\.yml@refs/(heads|tags)/.*$';
const COSIGN_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';

function getTargetAdCPVersion(): string {
  const versionFilePath = path.join(REPO_ROOT, 'ADCP_VERSION');
  if (!existsSync(versionFilePath)) {
    throw new Error('ADCP_VERSION file not found at repo root.');
  }
  const version = readFileSync(versionFilePath, 'utf8').trim();
  if (!version) throw new Error('ADCP_VERSION file is empty.');
  return version;
}

function assertValidAdcpVersion(version: string): void {
  if (version !== 'latest' && !ADCP_SEMANTIC_VERSION.test(version)) {
    throw new Error(`Invalid AdCP version ${JSON.stringify(version)}; expected a semantic version or "latest".`);
  }
}

function assertBundleVersion(requestedVersion: string, bundledVersion: unknown): asserts bundledVersion is string {
  if (typeof bundledVersion !== 'string' || !ADCP_SEMANTIC_VERSION.test(bundledVersion)) {
    throw new Error('Protocol bundle has an invalid or missing adcp_version.');
  }
  if (requestedVersion !== 'latest' && bundledVersion !== requestedVersion) {
    throw new Error(`Protocol bundle version mismatch: requested ${requestedVersion}, received ${bundledVersion}.`);
  }
}

interface DomainEntry {
  schemas?: Record<string, { $ref: string; description?: string }>;
  tasks?: Record<string, { request?: { $ref: string }; response?: { $ref: string } }>;
}

interface SchemaIndex {
  adcp_version: string;
  schemas: Record<string, DomainEntry>;
}

class SchemaSyncAvailabilityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SchemaSyncAvailabilityError';
  }
}

function fetchStatusError(url: string, response: Response): Error {
  const message = `Failed to fetch ${url}: ${response.status} ${response.statusText}`;
  const rateLimited =
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')));
  if (response.status === 404 || response.status === 408 || rateLimited || response.status >= 500) {
    return new SchemaSyncAvailabilityError(message);
  }
  return new Error(message);
}

async function fetchAvailable(url: string, init?: RequestInit): Promise<Response> {
  const delaysMs = [0, 250, 750];
  let lastCause: unknown;
  for (let attempt = 0; attempt < delaysMs.length; attempt += 1) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, delaysMs[attempt]));
    try {
      return await fetch(url, init);
    } catch (cause) {
      lastCause = cause;
      if (init?.signal?.aborted) break;
    }
  }
  const detail = lastCause instanceof Error ? lastCause.message : String(lastCause);
  throw new SchemaSyncAvailabilityError(`Failed to fetch ${url}: network error (${detail})`, { cause: lastCause });
}

async function fetchJson(url: string): Promise<any> {
  return JSON.parse(await fetchText(url));
}

// Normalize $ref paths to use the target version instead of "latest".
// Upstream serves `/schemas/latest/` refs inside the tarball for the latest snapshot;
// when we pin to a semantic version, rewrite so local resolvers can find the cached file.
function normalizeSchemaRefs(schema: any, semanticVersion: string): void {
  if (typeof schema !== 'object' || schema === null) return;
  if (typeof schema.$ref === 'string' && schema.$ref.includes('/schemas/latest/')) {
    schema.$ref = schema.$ref.replace('/schemas/latest/', `/schemas/${semanticVersion}/`);
  }
  for (const key of Object.keys(schema)) {
    if (typeof schema[key] === 'object' && schema[key] !== null) {
      normalizeSchemaRefs(schema[key], semanticVersion);
    }
  }
}

function normalizeRefsInTree(dir: string, semanticVersion: string): void {
  if (semanticVersion === 'latest') return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      normalizeRefsInTree(full, semanticVersion);
    } else if (entry.name.endsWith('.json')) {
      try {
        const json = JSON.parse(readFileSync(full, 'utf8'));
        normalizeSchemaRefs(json, semanticVersion);
        writeFileSync(full, JSON.stringify(json, null, 2));
      } catch {
        // Skip unparseable files (shouldn't happen in a clean tarball extract)
      }
    }
  }
}

/**
 * renameSync that survives EXDEV. Inside `docker build`, /app is overlayfs and
 * a directory that came from a lower image layer (e.g. via `COPY . .`) cannot
 * be renamed — the kernel returns EXDEV even though src and dest are on the
 * same mount. Fall back to copy + delete, which overlayfs handles fine.
 */
function moveTreeSync(src: string, dest: string): void {
  try {
    renameSync(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    cpSync(src, dest, { recursive: true });
    rmSync(src, { recursive: true, force: true });
  }
}

function replaceTree(srcDir: string, destDir: string): void {
  if (!existsSync(srcDir)) {
    throw new Error(`Expected tarball entry ${srcDir} is missing.`);
  }
  if (existsSync(destDir)) {
    // Keep the outgoing tree as a sibling snapshot so `npm run schema-diff` can
    // compare the incoming sync against the immediately-previous one.
    const snapshotDir = `${destDir}.previous`;
    if (existsSync(snapshotDir)) {
      // If `.previous` is a symlink, unlink only — don't let `rm -rf` follow it
      // into the target directory.
      if (lstatSync(snapshotDir).isSymbolicLink()) {
        unlinkSync(snapshotDir);
      } else {
        rmSync(snapshotDir, { recursive: true, force: true });
      }
    }
    moveTreeSync(destDir, snapshotDir);
    console.log(`📸 Previous tree snapshotted → ${snapshotDir}`);
  }
  mkdirSync(path.dirname(destDir), { recursive: true });
  moveTreeSync(srcDir, destDir);
}

function updateLatestSymlink(cacheRoot: string, version: string): void {
  if (version === 'latest') return;
  const latestLink = path.join(cacheRoot, 'latest');
  if (existsSync(latestLink)) rmSync(latestLink, { recursive: true, force: true });
  symlinkSync(version, latestLink);
}

/**
 * Reject symlinks anywhere under a verified protocol bundle before copying
 * extracted trees into the repo. node-tar blocks path traversal by default;
 * this guards the later file-copy/cache steps from preserving suspicious links.
 */
function assertNoSymlinks(root: string): void {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink() || lstatSync(abs).isSymbolicLink()) {
        throw new Error(
          `Refusing to sync protocol bundle: symlink detected at ${abs}. The upstream bundle should contain plain files only.`
        );
      }
      if (entry.isDirectory()) stack.push(abs);
    }
  }
}

async function fetchBinary(url: string): Promise<Buffer> {
  const res = await fetchAvailable(url);
  if (!res.ok) throw fetchStatusError(url, res);
  try {
    return Buffer.from(await res.arrayBuffer());
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new SchemaSyncAvailabilityError(`Failed to read ${url}: network error (${detail})`, { cause });
  }
}

async function fetchText(url: string): Promise<string> {
  const res = await fetchAvailable(url);
  if (!res.ok) throw fetchStatusError(url, res);
  try {
    return await res.text();
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new SchemaSyncAvailabilityError(`Failed to read ${url}: network error (${detail})`, { cause });
  }
}

/**
 * If cosign sidecars exist for this tarball, verify them. Local development
 * degrades gracefully unless ADCP_REQUIRE_SIGNATURE=1; artifact-producing CI
 * sets that flag and fails closed.
 *   - `latest.tgz` is intentionally unsigned upstream (rebuilt too frequently) — skip.
 *   - Missing sidecars (404) → checksum-only trust, log and continue.
 *   - Sidecars present but `cosign` binary missing → checksum-only, log install hint.
 *   - Sidecars present and `cosign` available → verify; throw on failure.
 */
async function verifyCosignSignature(tgzPath: string, version: string, baseUrl = ADCP_BASE_URL): Promise<void> {
  const requireSignature = process.env.ADCP_REQUIRE_SIGNATURE === '1';
  if (version === 'latest') {
    if (requireSignature) {
      throw new Error('Refusing unsigned latest.tgz because ADCP_REQUIRE_SIGNATURE=1. Pin a signed release.');
    }
    console.log('ℹ️  latest.tgz is intentionally unsigned upstream (checksum-only trust).');
    return;
  }

  const sigUrl = `${baseUrl}/protocol/${version}.tgz.sig`;
  const crtUrl = `${baseUrl}/protocol/${version}.tgz.crt`;

  const [sigProbe, crtProbe] = await Promise.all([
    fetchAvailable(sigUrl, { method: 'HEAD' }),
    fetchAvailable(crtUrl, { method: 'HEAD' }),
  ]);

  if (sigProbe.status === 404 && crtProbe.status === 404) {
    if (requireSignature) {
      throw new SchemaSyncAvailabilityError(
        `Cosign sidecars are required for v${version} but were not published at ${baseUrl}.`
      );
    }
    console.log(`ℹ️  No cosign sidecars for v${version} (checksum-only trust — upstream predates signing).`);
    return;
  }

  if (sigProbe.status === 404 || crtProbe.status === 404) {
    throw new SchemaSyncAvailabilityError(
      `Incomplete cosign sidecars for v${version}: sig ${sigProbe.status}, crt ${crtProbe.status}.`
    );
  }

  if (!sigProbe.ok || !crtProbe.ok) {
    if (!sigProbe.ok) throw fetchStatusError(sigUrl, sigProbe);
    throw fetchStatusError(crtUrl, crtProbe);
  }

  const cosign = spawnSync('cosign', ['version'], { stdio: 'ignore' });
  if (cosign.error || cosign.status !== 0) {
    if (requireSignature) {
      throw new Error(`cosign is required for v${version} because ADCP_REQUIRE_SIGNATURE=1, but it is unavailable.`);
    }
    console.warn(
      `⚠️  cosign sidecars are published for v${version} but \`cosign\` is not installed. ` +
        `Proceeding with checksum-only trust — install cosign (\`brew install cosign\` / ` +
        `https://docs.sigstore.dev/cosign/installation/) to enable signature verification.`
    );
    return;
  }

  const [sigBuf, crtBuf] = await Promise.all([fetchBinary(sigUrl), fetchBinary(crtUrl)]);
  const sigPath = `${tgzPath}.sig`;
  const crtPath = `${tgzPath}.crt`;
  writeFileSync(sigPath, sigBuf);
  writeFileSync(crtPath, crtBuf);

  console.log(`🔐 Verifying cosign signature for v${version}…`);
  const verify = spawnSync(
    'cosign',
    [
      'verify-blob',
      '--signature',
      sigPath,
      '--certificate',
      crtPath,
      '--certificate-identity-regexp',
      COSIGN_IDENTITY_REGEX,
      '--certificate-oidc-issuer',
      COSIGN_OIDC_ISSUER,
      tgzPath,
    ],
    { encoding: 'utf8' }
  );

  if (verify.status !== 0) {
    throw new Error(
      `cosign verify-blob failed for v${version}:\n` +
        `  exit ${verify.status}\n` +
        `  stderr: ${verify.stderr}\n` +
        `  stdout: ${verify.stdout}`
    );
  }
  console.log(`✅ cosign signature verified (identity: adcontextprotocol/adcp release workflow).`);
}

/**
 * Copy a skill directory tree into the SDK, replacing the destination but
 * skipping nested `schemas/` subdirs (duplicates of `schemas/cache/<version>/`).
 */
function copySkillTree(srcDir: string, destDir: string): void {
  if (existsSync(destDir)) {
    // Snapshot the outgoing tree the same way replaceTree does so the
    // schema-diff helper can pick up changes between syncs.
    const previous = `${destDir}.previous`;
    if (existsSync(previous)) rmSync(previous, { recursive: true, force: true });
    moveTreeSync(destDir, previous);
  }
  mkdirSync(destDir, { recursive: true });
  copyTreeFiltered(srcDir, destDir);
}

function copyTreeFiltered(srcDir: string, destDir: string): void {
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dst = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      // The spec repo's per-protocol skills bundle a copy of the AdCP schemas
      // for self-contained agent consumption; the SDK has them in
      // `schemas/cache/` already, so this would just duplicate ~1.4MB per
      // protocol. Skip.
      if (entry.name === 'schemas') continue;
      mkdirSync(dst, { recursive: true });
      copyTreeFiltered(src, dst);
    } else {
      copyFileSync(src, dst);
    }
  }
}

/**
 * Skills the SDK maintains locally even when the protocol bundle ships its
 * own copy. `call-adcp-agent` carries SDK-version-specific addenda (e.g.
 * `SDK ≥6.7` discriminator/schemaId, `SDK ≥6.8` hint) that don't belong in
 * the protocol bundle, so we never overwrite it from upstream.
 */
const SDK_LOCAL_SKILLS = new Set(['call-adcp-agent']);

/**
 * Sync protocol-managed skills from the extracted bundle into the SDK's
 * top-level `skills/` tree. Driven by `manifest.contents.skills` (a list of
 * skill directory names) so we only overwrite the entries the spec repo
 * publishes — leaves SDK-local skills (`build-seller-agent/`, etc.) alone.
 */
function syncSkillsFromBundle(extractRoot: string): void {
  const skillsInBundle = path.join(extractRoot, 'skills');
  const manifestPath = path.join(extractRoot, 'manifest.json');
  if (!existsSync(skillsInBundle) || !existsSync(manifestPath)) {
    return;
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    console.warn(`⚠️  Skill sync skipped: manifest unparseable (${err instanceof Error ? err.message : err}).`);
    return;
  }
  const skillNames = (manifest as { contents?: { skills?: unknown } }).contents?.skills;
  if (!Array.isArray(skillNames)) {
    // Older tarballs predate manifest.contents.skills enumeration. Skip silently.
    return;
  }
  let synced = 0;
  for (const name of skillNames) {
    if (typeof name !== 'string' || name.includes('/') || name.includes('..')) {
      continue;
    }
    if (SDK_LOCAL_SKILLS.has(name)) continue;
    const src = path.join(skillsInBundle, name);
    const dst = path.join(SKILLS_DIR, name);
    if (!existsSync(src) || !statSync(src).isDirectory()) continue;
    // Skip nested `schemas/` subdirs — those duplicate `schemas/cache/<version>/`
    // already extracted from the same tarball. Per-protocol skills in the spec
    // repo bundle them for self-contained agent consumption; the SDK has them
    // in `schemas/cache/` already, so re-copying inflates the package by ~1.4MB
    // per protocol with no functional gain.
    copySkillTree(src, dst);
    synced++;
  }
  if (synced > 0) {
    console.log(`📁 Skills:     ${SKILLS_DIR} (${synced} protocol-managed)`);
  }
}

/**
 * Fetch /protocol/{version}.tgz, verify sha256, and extract schemas + compliance
 * into their cache directories. Returns true on success.
 *
 * Throws on sha256 mismatch or extraction failure. Returns false if the tarball
 * endpoint returns 404 (caller may fall back to per-file schema sync).
 *
 * `schemas/cache/<version>/` and `compliance/cache/<version>/` are version-scoped,
 * so any version can populate them without disturbing another. The protocol
 * skills (`skills/adcp-*`) and the `latest/` pointer are NOT version-scoped —
 * they are shared surfaces that track the primary pin. `includeSharedSurfaces`
 * gates both so a side-bundle sync (an older legacy version, an opt-in beta)
 * never overwrites the primary pin's skills or repoints its default bundle.
 */
async function syncFromTarball(
  version: string,
  baseUrl = ADCP_BASE_URL,
  includeSharedSurfaces = true
): Promise<boolean> {
  const tgzUrl = `${baseUrl}/protocol/${version}.tgz`;
  const shaUrl = `${tgzUrl}.sha256`;

  const probe = await fetchAvailable(tgzUrl, { method: 'HEAD' });
  if (probe.status === 404) {
    console.warn(`⚠️  Tarball not found at ${tgzUrl} (404).`);
    return false;
  }

  console.log(`📥 Fetching protocol bundle: ${tgzUrl}`);
  const [tgzBuf, shaText] = await Promise.all([fetchBinary(tgzUrl), fetchText(shaUrl)]);

  const expectedSha = shaText.trim().split(/\s+/)[0];
  const actualSha = createHash('sha256').update(tgzBuf).digest('hex');
  if (actualSha !== expectedSha) {
    throw new Error(`Tarball sha256 mismatch for ${tgzUrl}\n  expected: ${expectedSha}\n  actual:   ${actualSha}`);
  }
  console.log(`✅ sha256 verified (${expectedSha.slice(0, 12)}…)`);

  // Keep the work dir inside the repo so renameSync never crosses filesystems (EXDEV).
  mkdirSync(REPO_ROOT, { recursive: true });
  const workDir = mkdtempSync(path.join(REPO_ROOT, '.adcp-sync-'));
  try {
    const tgzPath = path.join(workDir, 'bundle.tgz');
    writeFileSync(tgzPath, tgzBuf);

    // Cosign keyless signature verification (adcontextprotocol/adcp#2273).
    // Best-effort: latest is unsigned, sidecars may be absent on older releases.
    await verifyCosignSignature(tgzPath, version, baseUrl);

    await tar.x({ file: tgzPath, cwd: workDir, strict: true });

    const extractRoot = path.join(workDir, `adcp-${version}`);
    if (!existsSync(extractRoot)) {
      throw new Error(`Tarball root ${extractRoot} not found — upstream wrapping directory may have changed.`);
    }
    assertNoSymlinks(extractRoot);

    const bundleIndex = JSON.parse(readFileSync(path.join(extractRoot, 'schemas/index.json'), 'utf8'));
    const bundledVersion: string | undefined = bundleIndex.adcp_version;
    assertBundleVersion(version, bundledVersion);

    replaceTree(path.join(extractRoot, 'schemas'), path.join(SCHEMA_CACHE_DIR, version));
    replaceTree(path.join(extractRoot, 'compliance'), path.join(COMPLIANCE_CACHE_DIR, version));

    // Skills sync is manifest-driven and per-name. SDK-local skills like
    // build-seller-agent/ stay untouched; protocol-canonical ones (the
    // call-adcp-agent buyer skill plus per-protocol skills) are kept aligned
    // with the pinned spec version. Older tarballs (no manifest.contents.skills
    // array) are silently skipped — the SDK-local copies stay as-is. Skipped
    // entirely for side-bundle syncs so they keep the primary pin's skills.
    if (includeSharedSurfaces) {
      syncSkillsFromBundle(extractRoot);
    }

    // Refs inside the tarball point to /schemas/latest/; rewrite for pinned versions.
    const schemaDest = path.join(SCHEMA_CACHE_DIR, version);
    const semanticVersion: string = bundledVersion || version;
    normalizeRefsInTree(schemaDest, semanticVersion);

    // schemas/registry/registry.yaml is intentionally NOT written here. Although
    // the protocol tarball ships an openapi/registry.yaml, the registry spec has
    // its own upstream (agenticadvertising.org) and its own owner,
    // `generate-registry-types --sync`. That live spec runs ahead of the pinned
    // protocol bundle, so copying the tarball's copy only downgraded the checked-in
    // file and left a spurious diff in every working tree after a plain sync.

    // `latest/` is a shared, non-version-scoped pointer that resolves to the
    // default bundle — so it tracks the primary pin, not whichever side-bundle
    // is being synced. Repointing it for a legacy/beta sync would silently make
    // the SDK validate against an older version by default. Gate it like skills.
    if (includeSharedSurfaces) {
      updateLatestSymlink(SCHEMA_CACHE_DIR, version);
      updateLatestSymlink(COMPLIANCE_CACHE_DIR, version);
    }

    console.log(`📁 Schemas:    ${path.join(SCHEMA_CACHE_DIR, version)}`);
    console.log(`📁 Compliance: ${path.join(COMPLIANCE_CACHE_DIR, version)}`);
    if (existsSync(`${path.join(SCHEMA_CACHE_DIR, version)}.previous`)) {
      console.log(`💡 Wire-level deltas: npm run schema-diff`);
    }
    return true;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

// Per-file schema fallback. Used only if the tarball endpoint is unavailable.
// Compliance is NOT synced by this path — requires the tarball.
async function syncSchemasPerFile(
  version: string,
  baseUrl = ADCP_BASE_URL,
  includeSharedSurfaces = true
): Promise<void> {
  const indexUrl = `${baseUrl}/schemas/${version}/index.json`;
  console.log(`📥 Fetching schema index ${indexUrl}`);
  const schemaIndex: SchemaIndex = await fetchJson(indexUrl);
  assertBundleVersion(version, schemaIndex.adcp_version);

  const versionCacheDir = path.join(SCHEMA_CACHE_DIR, version);
  mkdirSync(versionCacheDir, { recursive: true });
  writeFileSync(path.join(versionCacheDir, 'index.json'), JSON.stringify(schemaIndex, null, 2));

  const allRefs = new Set<string>();
  for (const domain of Object.values(schemaIndex.schemas)) {
    if (!domain || typeof domain !== 'object') continue;
    if (domain.schemas) {
      for (const s of Object.values(domain.schemas)) {
        if (s?.$ref) allRefs.add(s.$ref);
      }
    }
    if (domain.tasks) {
      for (const t of Object.values(domain.tasks)) {
        if (t?.request?.$ref) allRefs.add(t.request.$ref);
        if (t?.response?.$ref) allRefs.add(t.response.$ref);
      }
    }
  }
  allRefs.add('/schemas/v1/adagents.json');

  const semanticVersion = schemaIndex.adcp_version;
  await Promise.allSettled(
    Array.from(allRefs).map(ref => downloadSchema(ref, versionCacheDir, semanticVersion, baseUrl))
  );

  // Resolve transitive $refs
  const attempted = new Set<string>();
  for (let depth = 0; depth < 10; depth++) {
    const missing = findMissingRefs(versionCacheDir, attempted);
    if (missing.size === 0) break;
    await Promise.allSettled(
      Array.from(missing).map(ref => downloadSchema(ref, versionCacheDir, semanticVersion, baseUrl))
    );
    missing.forEach(r => attempted.add(r));
  }

  // Shared `latest/` pointer tracks the primary pin only (see syncFromTarball).
  if (includeSharedSurfaces) {
    updateLatestSymlink(SCHEMA_CACHE_DIR, version);
  }
  console.warn(
    '⚠️  Compliance tree unavailable (per-file fallback only syncs schemas). ' +
      'Storyboard tooling will fail until the tarball endpoint is reachable.'
  );
}

async function downloadSchema(
  schemaRef: string,
  cacheDir: string,
  semanticVersion: string,
  baseUrl = ADCP_BASE_URL
): Promise<void> {
  const url = `${baseUrl}${schemaRef}`;
  const localPath = refToLocalPath(schemaRef, cacheDir);
  mkdirSync(path.dirname(localPath), { recursive: true });
  try {
    const schema = await fetchJson(url);
    if (semanticVersion) normalizeSchemaRefs(schema, semanticVersion);
    writeFileSync(localPath, JSON.stringify(schema, null, 2));
  } catch (error) {
    console.warn(`⚠️  Failed to download ${schemaRef}:`, (error as Error).message);
  }
}

function refToLocalPath(ref: string, cacheDir: string): string {
  const cacheRoot = path.resolve(cacheDir);
  let relativePath: string;
  if (ref.startsWith('/schemas/')) {
    relativePath = ref.substring('/schemas/'.length);
    const firstSlash = relativePath.indexOf('/');
    if (firstSlash > 0) relativePath = relativePath.substring(firstSlash + 1);
  } else {
    relativePath = path.basename(ref);
  }
  const candidate = path.resolve(cacheRoot, relativePath);
  if (candidate !== cacheRoot && !candidate.startsWith(`${cacheRoot}${path.sep}`)) {
    throw new Error(`Schema ref escapes the cache directory: ${JSON.stringify(ref)}`);
  }
  return candidate;
}

function extractRefs(schema: any, refs: Set<string> = new Set()): Set<string> {
  if (typeof schema === 'object' && schema !== null) {
    if (typeof schema.$ref === 'string' && schema.$ref.startsWith('/schemas/')) {
      refs.add(schema.$ref);
    }
    for (const value of Object.values(schema)) extractRefs(value, refs);
  }
  return refs;
}

function findMissingRefs(cacheDir: string, alreadyAttempted: Set<string>): Set<string> {
  const missing = new Set<string>();
  const scan = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        scan(full);
      } else if (entry.endsWith('.json')) {
        try {
          const refs = extractRefs(JSON.parse(readFileSync(full, 'utf8')));
          for (const ref of refs) {
            if (alreadyAttempted.has(ref)) continue;
            if (!existsSync(refToLocalPath(ref, cacheDir))) missing.add(ref);
          }
        } catch {
          /* skip */
        }
      }
    }
  };
  scan(cacheDir);
  return missing;
}

/**
 * Sync a protocol bundle into the caches.
 *
 * `options.includeSharedSurfaces` controls the non-version-scoped surfaces this
 * script owns: the protocol skills (`skills/adcp-*`) and the `latest/` pointer.
 * It defaults to `true` only when syncing the primary pin (the `ADCP_VERSION`
 * file), so `npm run sync-schemas` refreshes them but a side-bundle sync
 * (`sync-schemas -- 3.0.12`, the opt-in beta) leaves the primary pin's skills
 * and its default bundle untouched. This is what stops legacy/beta syncs from
 * clobbering the checked-in skills or silently repointing `latest/` — callers
 * no longer need to restore them afterward.
 */
async function sync(version?: string, options: { includeSharedSurfaces?: boolean } = {}): Promise<void> {
  const adcpVersion = version || getTargetAdCPVersion();
  assertValidAdcpVersion(adcpVersion);
  const primaryPin = getTargetAdCPVersion();
  const includeSharedSurfaces = options.includeSharedSurfaces ?? adcpVersion === primaryPin;
  console.log(
    `🔄 Syncing AdCP @ ${adcpVersion}` +
      (includeSharedSurfaces ? '' : ' (schemas only — skills + latest pointer stay at the primary pin)')
  );

  const syncSource = await syncSchemasWithFallbacks(
    {
      version: adcpVersion,
      primaryBaseUrl: ADCP_BASE_URL,
      includeSharedSurfaces,
      githubFallbackEnabled: ADCP_BASE_URL === DEFAULT_ADCP_BASE_URL && process.env.ADCP_GITHUB_FALLBACK !== '0',
      requireSignature: process.env.ADCP_REQUIRE_SIGNATURE === '1',
    },
    { syncFromTarball, syncSchemasPerFile, warn: message => console.warn(message) }
  );

  if (includeSharedSurfaces && process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `primary_schema_source=${syncSource}\n`);
  }

  console.log(`✅ Sync complete for AdCP ${adcpVersion}`);
}

interface SchemaSyncOperations {
  syncFromTarball: typeof syncFromTarball;
  syncSchemasPerFile: typeof syncSchemasPerFile;
  warn: (message: string) => void;
}

interface SchemaSyncFallbackOptions {
  version: string;
  primaryBaseUrl: string;
  includeSharedSurfaces: boolean;
  githubFallbackEnabled: boolean;
  requireSignature: boolean;
}

async function syncSchemasWithFallbacks(
  options: SchemaSyncFallbackOptions,
  operations: SchemaSyncOperations
): Promise<'primary' | 'github'> {
  const { version, primaryBaseUrl, includeSharedSurfaces, githubFallbackEnabled, requireSignature } = options;

  let primaryUnavailable = false;
  try {
    if (await operations.syncFromTarball(version, primaryBaseUrl, includeSharedSurfaces)) return 'primary';
  } catch (error) {
    if (!(error instanceof SchemaSyncAvailabilityError)) throw error;
    primaryUnavailable = true;
    if (!githubFallbackEnabled) throw error;
    operations.warn(
      `⚠️  Sync from ${primaryBaseUrl} failed for AdCP ${version}; retrying against GitHub dist bundles. ` +
        `Original error: ${error.message}`
    );
  }

  if (githubFallbackEnabled) {
    if (!primaryUnavailable) {
      operations.warn(
        `⚠️  AdCP ${version} tarball was not reachable from ${primaryBaseUrl}; ` +
          `retrying against GitHub dist bundles before schema-only fallback.`
      );
    }
    for (const baseUrl of getGithubDistFallbackBaseUrls(version)) {
      try {
        if (await operations.syncFromTarball(version, baseUrl, includeSharedSurfaces)) return 'github';
      } catch (error) {
        if (!(error instanceof SchemaSyncAvailabilityError)) throw error;
        operations.warn(`⚠️  GitHub bundle fallback unavailable at ${baseUrl}: ${error.message}`);
      }
    }
  }

  if (requireSignature) {
    throw new Error(
      `Signed protocol tarball required for AdCP ${version}; refusing unsigned per-file schema fallback.`
    );
  }

  // After a primary-host outage, prefer immutable tagged schemas but retain
  // moving main/dist compatibility for versions whose tag is unavailable.
  if (primaryUnavailable && githubFallbackEnabled) {
    let lastAvailabilityError: SchemaSyncAvailabilityError | undefined;
    for (const baseUrl of getGithubDistFallbackBaseUrls(version)) {
      try {
        await operations.syncSchemasPerFile(version, baseUrl, includeSharedSurfaces);
        return 'github';
      } catch (error) {
        if (!(error instanceof SchemaSyncAvailabilityError)) throw error;
        lastAvailabilityError = error;
        operations.warn(`⚠️  GitHub per-file fallback unavailable at ${baseUrl}: ${error.message}`);
      }
    }
    throw lastAvailabilityError ?? new Error(`No GitHub schema fallback configured for AdCP ${version}.`);
  }

  // A clean primary tarball 404 retains the primary host's per-file fallback.
  await operations.syncSchemasPerFile(version, primaryBaseUrl, includeSharedSurfaces);
  return 'primary';
}

if (require.main === module) {
  const version = process.argv[2];
  sync(version).catch(error => {
    console.error('❌ Sync failed:', error);
    process.exit(1);
  });
}

export {
  assertBundleVersion,
  assertValidAdcpVersion,
  getGithubDistFallbackBaseUrls,
  SchemaSyncAvailabilityError,
  sync as syncSchemas,
  syncFromTarball,
  syncSchemasPerFile,
  syncSchemasWithFallbacks,
};
