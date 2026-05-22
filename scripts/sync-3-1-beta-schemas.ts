#!/usr/bin/env tsx
/**
 * Opt-in sync of the AdCP 3.1.0-beta.3 schema bundle into
 * `schemas/cache/3.1.0-beta.3/`. The SDK's primary pin stays at the
 * `ADCP_VERSION` file value (3.0.x GA); clients pinning `adcpVersion:
 * "3.1.0-beta.3"` or `"3.1-beta"` get strict validation against the beta
 * schemas (conditional wholesale-feed fetch, wholesale signals, wholesale
 * feed webhook registration).
 *
 * Wraps `syncSchemas()` so we inherit cosign verification, sha256 check,
 * and tarball extraction. The wrapper restores the `latest` symlink to
 * the SDK's primary pin afterwards — `syncSchemas()` always points
 * `latest/` at whatever it just synced, which is correct for a pin bump
 * but wrong for an opt-in side-bundle.
 */

import { existsSync, lstatSync, readFileSync, rmSync, symlinkSync } from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { syncSchemas } from './sync-schemas';

const REPO_ROOT = path.join(__dirname, '..');
const SCHEMA_CACHE_DIR = path.join(REPO_ROOT, 'schemas/cache');
const COMPLIANCE_CACHE_DIR = path.join(REPO_ROOT, 'compliance/cache');
const BETA_VERSION = '3.1.0-beta.3';
const GITHUB_DIST_BASE_URL = 'https://raw.githubusercontent.com/adcontextprotocol/adcp/main/dist';

/**
 * Paths that `syncSchemas` overwrites as a side effect of any tarball
 * extraction — protocol-managed skills, the registry OpenAPI spec, and any
 * other check-in surfaces that piggyback on the primary sync. An opt-in
 * beta sync MUST NOT bump these against the SDK's primary pin, so we
 * restore them from `HEAD` after the sync runs.
 *
 * If you add a new check-in surface to `syncSchemas`, add the path here
 * (or refactor `syncSchemas` to expose a schemas-only mode).
 */
const RESTORE_PATHS = [
  'schemas/registry/registry.yaml',
  'skills/adcp-brand/SKILL.md',
  'skills/adcp-creative/SKILL.md',
  'skills/adcp-media-buy/SKILL.md',
];

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

function restoreFromHead(paths: readonly string[]): void {
  const tracked = paths.filter(p => existsSync(path.join(REPO_ROOT, p)));
  if (tracked.length === 0) return;
  // `git checkout HEAD --` is the narrowest restoration: it touches only the
  // listed paths, never the working-tree state of anything else, and fails
  // loudly if the paths aren't tracked. Run from REPO_ROOT so paths resolve
  // relative to the git work tree.
  const result = spawnSync('git', ['checkout', 'HEAD', '--', ...tracked], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `Failed to restore side-effect paths from HEAD:\n  ${result.stderr || result.stdout}\n` +
        `Run \`git status\` and restore manually before re-running.`
    );
  }
  console.log(`♻️  Restored ${tracked.length} side-effect path(s) from HEAD (primary-pin state preserved).`);
}

async function main(): Promise<void> {
  const primary = getPrimaryAdcpVersion();
  console.log(`🔄 Opt-in sync: AdCP ${BETA_VERSION} (primary pin stays at ${primary})`);
  const delegatedToFallback = await syncBetaSchemasWithFallback();
  if (delegatedToFallback) return;
  // `syncSchemas` repointed `latest/` at the beta. Move it back so the
  // primary GA pin remains the default bundle for downstream consumers.
  restoreLatestSymlink(SCHEMA_CACHE_DIR, primary);
  restoreLatestSymlink(COMPLIANCE_CACHE_DIR, primary);
  // `syncSchemas` also overwrites tracked artifacts (registry.yaml, protocol
  // skills) from the synced tarball. Those track the primary pin, not the
  // opt-in beta — restore them from HEAD.
  restoreFromHead(RESTORE_PATHS);
  console.log(`✅ ${BETA_VERSION} schemas at schemas/cache/${BETA_VERSION}/`);
}

async function syncBetaSchemasWithFallback(): Promise<boolean> {
  try {
    await syncSchemas(BETA_VERSION);
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
