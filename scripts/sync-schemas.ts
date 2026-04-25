#!/usr/bin/env tsx

import {
  readFileSync,
  writeFileSync,
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
} from 'fs';
import { mkdtempSync } from 'fs';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import path from 'path';
import * as tar from 'tar';

const ADCP_BASE_URL = process.env.ADCP_BASE_URL || 'https://adcontextprotocol.org';
const REPO_ROOT = path.join(__dirname, '..');
const SCHEMA_CACHE_DIR = path.join(REPO_ROOT, 'schemas/cache');
const COMPLIANCE_CACHE_DIR = path.join(REPO_ROOT, 'compliance/cache');
const SKILLS_DIR = path.join(REPO_ROOT, 'skills');
const REGISTRY_SPEC_PATH = path.join(REPO_ROOT, 'schemas/registry/registry.yaml');

// Sigstore keyless identity used by the upstream release workflow (adcontextprotocol/adcp#2273).
// Branch alternation must mirror release.yml's `on.push.branches` exactly — when a new release
// line is added upstream (e.g. a future LTS branch), update both ends together.
const COSIGN_IDENTITY_REGEX =
  '^https://github\\.com/adcontextprotocol/adcp/\\.github/workflows/release\\.yml@refs/heads/(main|2\\.6\\.x)$';
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

interface DomainEntry {
  schemas?: Record<string, { $ref: string; description?: string }>;
  tasks?: Record<string, { request?: { $ref: string }; response?: { $ref: string } }>;
}

interface SchemaIndex {
  adcp_version: string;
  schemas: Record<string, DomainEntry>;
}

async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return response.json();
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
    renameSync(destDir, snapshotDir);
    console.log(`📸 Previous tree snapshotted → ${snapshotDir}`);
  }
  mkdirSync(path.dirname(destDir), { recursive: true });
  renameSync(srcDir, destDir);
}

function updateLatestSymlink(cacheRoot: string, version: string): void {
  if (version === 'latest') return;
  const latestLink = path.join(cacheRoot, 'latest');
  if (existsSync(latestLink)) rmSync(latestLink, { recursive: true, force: true });
  symlinkSync(version, latestLink);
}

async function fetchBinary(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  return res.text();
}

/**
 * If cosign sidecars exist for this tarball, verify them. Graceful degradation:
 *   - `latest.tgz` is intentionally unsigned upstream (rebuilt too frequently) — skip.
 *   - Missing sidecars (404) → checksum-only trust, log and continue.
 *   - Sidecars present but `cosign` binary missing → checksum-only, log install hint.
 *   - Sidecars present and `cosign` available → verify; throw on failure.
 */
async function verifyCosignSignature(tgzPath: string, version: string): Promise<void> {
  if (version === 'latest') {
    console.log('ℹ️  latest.tgz is intentionally unsigned upstream (checksum-only trust).');
    return;
  }

  const sigUrl = `${ADCP_BASE_URL}/protocol/${version}.tgz.sig`;
  const crtUrl = `${ADCP_BASE_URL}/protocol/${version}.tgz.crt`;

  const [sigProbe, crtProbe] = await Promise.all([
    fetch(sigUrl, { method: 'HEAD' }),
    fetch(crtUrl, { method: 'HEAD' }),
  ]);

  if (sigProbe.status === 404 || crtProbe.status === 404) {
    console.log(`ℹ️  No cosign sidecars for v${version} (checksum-only trust — upstream predates signing).`);
    return;
  }

  if (!sigProbe.ok || !crtProbe.ok) {
    throw new Error(`Unexpected status for cosign sidecars: sig ${sigProbe.status}, crt ${crtProbe.status}`);
  }

  const cosign = spawnSync('cosign', ['version'], { stdio: 'ignore' });
  if (cosign.error || cosign.status !== 0) {
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
    renameSync(destDir, previous);
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
 */
async function syncFromTarball(version: string): Promise<boolean> {
  const tgzUrl = `${ADCP_BASE_URL}/protocol/${version}.tgz`;
  const shaUrl = `${tgzUrl}.sha256`;

  const probe = await fetch(tgzUrl, { method: 'HEAD' });
  if (probe.status === 404) {
    console.warn(`⚠️  Tarball not found at ${tgzUrl} (404). Falling back to per-file sync.`);
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
    await verifyCosignSignature(tgzPath, version);

    await tar.x({ file: tgzPath, cwd: workDir });

    const extractRoot = path.join(workDir, `adcp-${version}`);
    if (!existsSync(extractRoot)) {
      throw new Error(`Tarball root ${extractRoot} not found — upstream wrapping directory may have changed.`);
    }

    replaceTree(path.join(extractRoot, 'schemas'), path.join(SCHEMA_CACHE_DIR, version));
    replaceTree(path.join(extractRoot, 'compliance'), path.join(COMPLIANCE_CACHE_DIR, version));

    // Skills sync is manifest-driven and per-name. SDK-local skills like
    // build-seller-agent/ stay untouched; protocol-canonical ones (the
    // call-adcp-agent buyer skill plus per-protocol skills) are kept aligned
    // with the pinned spec version. Older tarballs (no manifest.contents.skills
    // array) are silently skipped — the SDK-local copies stay as-is.
    syncSkillsFromBundle(extractRoot);

    // Refs inside the tarball point to /schemas/latest/; rewrite for pinned versions.
    const schemaDest = path.join(SCHEMA_CACHE_DIR, version);
    const indexJson = JSON.parse(readFileSync(path.join(schemaDest, 'index.json'), 'utf8'));
    const semanticVersion: string = indexJson.adcp_version || version;
    normalizeRefsInTree(schemaDest, semanticVersion);

    // Registry spec lives in the same bundle; keep writing to its legacy location
    // for downstream generators that import from schemas/registry/registry.yaml.
    const registryInBundle = path.join(extractRoot, 'openapi/registry.yaml');
    if (existsSync(registryInBundle)) {
      mkdirSync(path.dirname(REGISTRY_SPEC_PATH), { recursive: true });
      copyFileSync(registryInBundle, REGISTRY_SPEC_PATH);
      console.log(`✅ Registry spec extracted → ${REGISTRY_SPEC_PATH}`);
    }

    updateLatestSymlink(SCHEMA_CACHE_DIR, version);
    updateLatestSymlink(COMPLIANCE_CACHE_DIR, version);

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
async function syncSchemasPerFile(version: string): Promise<void> {
  const indexUrl = `${ADCP_BASE_URL}/schemas/${version}/index.json`;
  console.log(`📥 Fetching schema index ${indexUrl}`);
  const schemaIndex: SchemaIndex = await fetchJson(indexUrl);

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
  await Promise.allSettled(Array.from(allRefs).map(ref => downloadSchema(ref, versionCacheDir, semanticVersion)));

  // Resolve transitive $refs
  const attempted = new Set<string>();
  for (let depth = 0; depth < 10; depth++) {
    const missing = findMissingRefs(versionCacheDir, attempted);
    if (missing.size === 0) break;
    await Promise.allSettled(Array.from(missing).map(ref => downloadSchema(ref, versionCacheDir, semanticVersion)));
    missing.forEach(r => attempted.add(r));
  }

  updateLatestSymlink(SCHEMA_CACHE_DIR, version);
  console.warn(
    '⚠️  Compliance tree unavailable (per-file fallback only syncs schemas). ' +
      'Storyboard tooling will fail until the tarball endpoint is reachable.'
  );
}

async function downloadSchema(schemaRef: string, cacheDir: string, semanticVersion: string): Promise<void> {
  const url = `${ADCP_BASE_URL}${schemaRef}`;
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
  if (ref.startsWith('/schemas/')) {
    let relativePath = ref.substring('/schemas/'.length);
    const firstSlash = relativePath.indexOf('/');
    if (firstSlash > 0) relativePath = relativePath.substring(firstSlash + 1);
    return path.join(cacheDir, relativePath);
  }
  return path.join(cacheDir, path.basename(ref));
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

async function sync(version?: string): Promise<void> {
  const adcpVersion = version || getTargetAdCPVersion();
  console.log(`🔄 Syncing AdCP @ ${adcpVersion}`);

  const viaTarball = await syncFromTarball(adcpVersion);
  if (!viaTarball) {
    await syncSchemasPerFile(adcpVersion);
  }

  console.log(`✅ Sync complete for AdCP ${adcpVersion}`);
}

if (require.main === module) {
  const version = process.argv[2];
  sync(version).catch(error => {
    console.error('❌ Sync failed:', error);
    process.exit(1);
  });
}

export { sync as syncSchemas };
