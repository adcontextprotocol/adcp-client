#!/usr/bin/env tsx
/**
 * Idempotent guard for the schema cache. Tests load schemas from
 * `schemas/cache/{3.0.x,v2.5}/` (gitignored, populated by
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
import { existsSync, readdirSync } from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const REPO_ROOT = path.join(__dirname, '..');
const CACHE_ROOT = path.join(REPO_ROOT, 'schemas/cache');

function hasV3Cache(): boolean {
  if (!existsSync(CACHE_ROOT)) return false;
  // Any `<major>.<minor>.<patch>` directory under cache satisfies the v3
  // bundle — `sync-schemas` writes the exact upstream version, currently
  // 3.0.1, but pin updates land here without needing a script change.
  return readdirSync(CACHE_ROOT, { withFileTypes: true }).some(
    e => e.isDirectory() && /^\d+\.\d+\.\d+$/.test(e.name)
  );
}

function hasV25Cache(): boolean {
  return existsSync(path.join(CACHE_ROOT, 'v2.5'));
}

const v3Ok = hasV3Cache();
const v25Ok = hasV25Cache();

if (v3Ok && v25Ok) process.exit(0);

// Only sync what's missing — each sync fetches a tarball, so resyncing
// a populated cache is ~3s of needless network call.
const scripts: string[] = [];
if (!v3Ok) scripts.push('sync-schemas');
if (!v25Ok) scripts.push('sync-schemas:v2.5');

console.log(`[schemas:ensure] Missing schema cache; running: ${scripts.join(', ')}`);

for (const script of scripts) {
  const result = spawnSync('npm', ['run', script], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
