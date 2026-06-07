#!/usr/bin/env tsx
/**
 * Idempotent guard for the schema cache. Tests load schemas from
 * `schemas/cache/{current,3.0.x,v2.5}/` (gitignored, populated by
 * `npm run sync-schemas:all`). Fresh clones, branch switches that wipe
 * the cache, and `git clean -fdx` all leave a dev environment that
 * silently fails ~9 test suites with "AdCP schema data for version 'v2.5'
 * not found" — CI passes because it runs `sync-schemas:all` explicitly,
 * but local dev hits a paper cut.
 *
 * This script runs as a `pretest` hook. It checks whether both caches
 * exist and runs `sync-schemas:all` only when something is missing. The
 * check is ~10ms when caches are present (filesystem stat); the sync
 * fetches a tarball and takes ~5s, but only the first time after a
 * cache wipe.
 *
 * No CI-time cost: CI's explicit `sync-schemas:all` populates both
 * caches before tests run, so this guard is a no-op there.
 */
import { existsSync, lstatSync, readFileSync, rmSync, symlinkSync } from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const REPO_ROOT = path.join(__dirname, '..');
const CACHE_ROOT = path.join(REPO_ROOT, 'schemas/cache');
const COMPLIANCE_CACHE_ROOT = path.join(REPO_ROOT, 'compliance/cache');
const STABLE_3_0_SCHEMA_VERSION = '3.0.12';

function currentAdcpVersion(): string {
  return readFileSync(path.join(REPO_ROOT, 'ADCP_VERSION'), 'utf8').trim();
}

function hasCurrentV3Cache(): boolean {
  const current = currentAdcpVersion();
  return existsSync(path.join(CACHE_ROOT, current));
}

function hasStableV30Cache(): boolean {
  return existsSync(path.join(CACHE_ROOT, STABLE_3_0_SCHEMA_VERSION));
}

function hasCurrentComplianceCache(): boolean {
  return existsSync(path.join(COMPLIANCE_CACHE_ROOT, currentAdcpVersion()));
}

function hasStableV30ComplianceCache(): boolean {
  return existsSync(path.join(COMPLIANCE_CACHE_ROOT, STABLE_3_0_SCHEMA_VERSION));
}

function hasV25Cache(): boolean {
  return existsSync(path.join(CACHE_ROOT, 'v2.5'));
}

function pointLatestAtCurrent(cacheRoot: string, current: string): void {
  if (!existsSync(path.join(cacheRoot, current))) return;
  const latest = path.join(cacheRoot, 'latest');
  if (existsSync(latest) || lstatSync(latest, { throwIfNoEntry: false })?.isSymbolicLink()) {
    rmSync(latest, { recursive: true, force: true });
  }
  symlinkSync(current, latest);
}

const currentV3Ok = hasCurrentV3Cache();
const stableV30Ok = hasStableV30Cache();
const currentComplianceOk = hasCurrentComplianceCache();
const stableV30ComplianceOk = hasStableV30ComplianceCache();
const v25Ok = hasV25Cache();

const current = currentAdcpVersion();
if (currentV3Ok && stableV30Ok && currentComplianceOk && stableV30ComplianceOk && v25Ok) {
  pointLatestAtCurrent(CACHE_ROOT, current);
  pointLatestAtCurrent(COMPLIANCE_CACHE_ROOT, current);
  process.exit(0);
}

// Only sync what's missing — each sync fetches a tarball, so resyncing
// a populated cache is ~3s of needless network call.
const scripts: string[] = [];
if (!currentV3Ok || !currentComplianceOk) scripts.push('sync-schemas');
if (!stableV30Ok || !stableV30ComplianceOk) scripts.push(`sync-schemas -- ${STABLE_3_0_SCHEMA_VERSION}`);
if (!v25Ok) scripts.push('sync-schemas:v2.5');

console.log(`[schemas:ensure] Missing schema cache; running: ${scripts.join(', ')}`);

for (const script of scripts) {
  const [name, ...args] = script.split(' ');
  const result = spawnSync('npm', ['run', name!, ...args], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// `sync-schemas -- 3.0.12` and `sync-schemas:v2.5` update the `latest`
// symlink as a side effect. If the current cache was already present and only
// support caches were missing, restore `latest` to the ADCP_VERSION pin so
// subsequent generators do not accidentally read an older bundle.
pointLatestAtCurrent(CACHE_ROOT, current);
pointLatestAtCurrent(COMPLIANCE_CACHE_ROOT, current);
