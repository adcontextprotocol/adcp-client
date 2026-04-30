#!/usr/bin/env tsx
/**
 * Fetch the AdCP v2.5.x schema bundle from `adcontextprotocol/adcp` and drop
 * it at `schemas/cache/v2.5/` so the existing `resolveBundleKey('v2.5')`
 * legacy alias finds it.
 *
 * Why a separate script: upstream's published spec site (`adcontextprotocol.org`)
 * only serves released spec versions (latest v2.5 release is v2.5.1, Dec 2025).
 * The actual v2.5.3 cut — including `additionalProperties: true` for forward
 * compat, the `error.json` typing fix, and the `impressions` / `paused`
 * package-request fields — was bumped in `package.json` and `CHANGELOG.md`
 * on the `2.5-maintenance` branch but never tagged or released
 * (adcontextprotocol/adcp#3689). Until that's resolved we pull from a pinned
 * branch SHA so we get the actually-shipping shape, not the stale tagged one.
 *
 * The v3 sync flow (`sync-schemas.ts`) stays as-is. This is purely additive.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import * as tar from 'tar';

const REPO_ROOT = path.join(__dirname, '..');
const SCHEMA_CACHE_DIR = path.join(REPO_ROOT, 'schemas/cache');

// Pinned source — change this constant to refresh from a newer 2.5-maintenance
// commit. Keep it explicit so CI builds are reproducible and a downstream
// `additionalProperties` flip can't silently land via the implicit "HEAD".
const SOURCE_REPO = 'adcontextprotocol/adcp';
const SOURCE_BRANCH = '2.5-maintenance';
const SOURCE_SHA = '4e553ad955f83b49c7d221ab5c3ff78237ad02e3';
const TARGET_BUNDLE_KEY = 'v2.5';

async function fetchBinary(url: string): Promise<Buffer> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main(): Promise<void> {
  console.log(`📥 Fetching ${SOURCE_REPO}@${SOURCE_SHA} (${SOURCE_BRANCH})`);
  const tarballUrl = `https://codeload.github.com/${SOURCE_REPO}/tar.gz/${SOURCE_SHA}`;

  mkdirSync(REPO_ROOT, { recursive: true });
  const workDir = mkdtempSync(path.join(REPO_ROOT, '.adcp-v2-5-sync-'));
  try {
    const tgz = await fetchBinary(tarballUrl);
    const tgzPath = path.join(workDir, 'bundle.tgz');
    writeFileSync(tgzPath, tgz);
    await tar.x({ file: tgzPath, cwd: workDir });

    // GitHub archives wrap content in `<repo-name>-<sha>/`.
    const wrapper = `adcp-${SOURCE_SHA}`;
    const sourceTree = path.join(workDir, wrapper, 'static', 'schemas', 'source');
    if (!existsSync(sourceTree)) {
      throw new Error(`Expected ${sourceTree} in tarball — upstream layout may have changed.`);
    }

    // Read the upstream-declared adcp_version so we can fail loud if the SHA
    // we pinned no longer points at a 2.5.x build.
    const indexJson = JSON.parse(readFileSync(path.join(sourceTree, 'index.json'), 'utf8'));
    const upstreamVersion: string = indexJson.adcp_version ?? '<unknown>';
    if (!upstreamVersion.startsWith('2.5.')) {
      throw new Error(
        `Pinned SHA reports adcp_version ${JSON.stringify(upstreamVersion)} — expected 2.5.x. ` +
          `Update SOURCE_SHA or pull from a different branch.`
      );
    }
    console.log(`✅ Upstream reports adcp_version=${upstreamVersion}`);

    const dest = path.join(SCHEMA_CACHE_DIR, TARGET_BUNDLE_KEY);
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(sourceTree, dest, { recursive: true });

    console.log(`📁 Schemas:    ${dest}`);
    console.log(`📌 Source:     ${SOURCE_REPO}@${SOURCE_SHA}`);
    console.log(`💡 Bundle key resolves via legacy alias 'v2.5' in resolveBundleKey().`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
