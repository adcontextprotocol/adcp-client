#!/usr/bin/env tsx
/**
 * Sync the AdCP 3.1.0-beta.7 schema bundle into
 * `schemas/cache/3.1.0-beta.7/`. Clients pinning `adcpVersion:
 * "3.1.0-beta.7"` or `"3.1-beta"` get strict validation against these
 * schemas.
 *
 * Wraps `syncSchemas()` so we inherit cosign verification, sha256 check,
 * and tarball extraction. For a side-bundle, `syncSchemas()` populates only the
 * version-scoped caches — it leaves the shared surfaces (protocol skills, the
 * `latest/` pointer) at the primary pin and never writes the registry spec — so
 * the wrapper's only cleanup is a defensive re-affirmation of the `latest`
 * symlink against the primary pin.
 */

import { existsSync, lstatSync, readFileSync, rmSync, symlinkSync } from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { syncSchemas } from './sync-schemas';

const REPO_ROOT = path.join(__dirname, '..');
const SCHEMA_CACHE_DIR = path.join(REPO_ROOT, 'schemas/cache');
const COMPLIANCE_CACHE_DIR = path.join(REPO_ROOT, 'compliance/cache');
const BETA_VERSION = '3.1.0-beta.7';
const GITHUB_DIST_BASE_URL = 'https://raw.githubusercontent.com/adcontextprotocol/adcp/main/dist';

function getPrimaryAdcpVersion(): string {
  const versionFile = path.join(REPO_ROOT, 'ADCP_VERSION');
  if (!existsSync(versionFile)) {
    throw new Error('ADCP_VERSION file not found at repo root.');
  }
  return readFileSync(versionFile, 'utf8').trim();
}

function restoreLatestSymlink(cacheRoot: string, primaryVersion: string): void {
  const latestLink = path.join(cacheRoot, 'latest');
  const target = path.join(cacheRoot, primaryVersion);
  if (!existsSync(target)) {
    console.warn(
      `⚠️  Cannot restore latest symlink in ${cacheRoot}: target ${target} is missing. ` +
        `Run \`npm run sync-schemas\` to populate the primary cache first.`
    );
    return;
  }
  if (existsSync(latestLink) || lstatSync(latestLink, { throwIfNoEntry: false })?.isSymbolicLink()) {
    rmSync(latestLink, { recursive: true, force: true });
  }
  symlinkSync(primaryVersion, latestLink);
  console.log(`🔗 ${cacheRoot}/latest → ${primaryVersion}`);
}

function hasBetaCache(): boolean {
  return (
    existsSync(path.join(SCHEMA_CACHE_DIR, BETA_VERSION)) && existsSync(path.join(COMPLIANCE_CACHE_DIR, BETA_VERSION))
  );
}

async function main(): Promise<void> {
  const primary = getPrimaryAdcpVersion();
  console.log(`🔄 Opt-in sync: AdCP ${BETA_VERSION} (primary pin stays at ${primary})`);
  if (primary === BETA_VERSION && hasBetaCache()) {
    console.log(`✅ ${BETA_VERSION} is already synced as the primary pin; skipping duplicate beta sync.`);
    restoreLatestSymlink(SCHEMA_CACHE_DIR, primary);
    restoreLatestSymlink(COMPLIANCE_CACHE_DIR, primary);
    return;
  }
  const delegatedToFallback = await syncBetaSchemasWithFallback(primary);
  if (delegatedToFallback) return;
  // As a side-bundle, `syncSchemas` no longer repoints `latest/` at the beta
  // (it gates the pointer behind the primary pin). Re-affirm it defensively so
  // the primary GA pin stays the default bundle regardless of prior cache state.
  restoreLatestSymlink(SCHEMA_CACHE_DIR, primary);
  restoreLatestSymlink(COMPLIANCE_CACHE_DIR, primary);
  // No skill restore needed: unless the beta is itself the primary pin,
  // `syncSchemas` runs schemas-only and never touches the shared skills, so
  // they already hold the primary pin's committed content.
  console.log(`✅ ${BETA_VERSION} schemas at schemas/cache/${BETA_VERSION}/`);
}

async function syncBetaSchemasWithFallback(primary: string): Promise<boolean> {
  try {
    // Only write the shared surfaces (skills, `latest/` pointer) when the beta
    // IS the primary pin. As a side-bundle they stay at the primary pin's state.
    await syncSchemas(BETA_VERSION, { includeSharedSurfaces: primary === BETA_VERSION });
    return false;
  } catch (err) {
    if (process.env.ADCP_BASE_URL || process.env.ADCP_BETA_GITHUB_FALLBACK === '0') {
      throw err;
    }
    console.warn(`⚠️  ${BETA_VERSION} was not reachable from adcontextprotocol.org; retrying against GitHub dist.`);
    const result = spawnSync('npx', ['tsx', 'scripts/sync-3-1-beta-schemas.ts'], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        ADCP_BASE_URL: GITHUB_DIST_BASE_URL,
        ADCP_BETA_GITHUB_FALLBACK: '0',
      },
    });
    if (result.status !== 0) {
      throw err;
    }
    return true;
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('❌ Sync failed:', err);
    process.exit(1);
  });
}
