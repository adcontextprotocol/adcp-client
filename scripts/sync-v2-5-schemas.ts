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

import { createHash } from 'crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import path from 'path';
import * as tar from 'tar';

const REPO_ROOT = path.join(__dirname, '..');
const SCHEMA_CACHE_DIR = path.join(REPO_ROOT, 'schemas/cache');

// Pinned source — change all three constants together to refresh from a newer
// 2.5-maintenance commit. Keep them explicit so CI builds are reproducible
// and a downstream `additionalProperties` flip can't silently land via the
// implicit "HEAD".
const SOURCE_REPO = 'adcontextprotocol/adcp';
const SOURCE_BRANCH = '2.5-maintenance';
const SOURCE_SHA = '4e553ad955f83b49c7d221ab5c3ff78237ad02e3';
// SHA-256 of the codeload tarball at the pinned SHA. Defense-in-depth: the
// codeload URL is content-addressed by GitHub but TLS substitution / a
// compromised CI runner could still swap bytes. Mismatch fails the sync
// before any extraction. Refresh by running:
//   curl -sL "https://codeload.github.com/<repo>/tar.gz/<sha>" | shasum -a 256
const SOURCE_TARBALL_SHA256 = '580656d6466ef9f0d1119985e6726c2efea718dc671e2ad30957fcb2fd54af0f';
const TARGET_BUNDLE_KEY = 'v2.5';

async function fetchBinary(url: string): Promise<Buffer> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Reject any symlinks anywhere under `root`. We only ship JSON-Schema
 * files; an upstream symlink (legitimate or hostile) would let `cpSync`'s
 * default symlink-following pivot a copy outside the source tree.
 */
function assertNoSymlinks(root: string): void {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink() || lstatSync(abs).isSymbolicLink()) {
        throw new Error(
          `Refusing to sync v2.5 bundle: symlink detected at ${abs}. The upstream schema tree should be plain files only.`
        );
      }
      if (entry.isDirectory()) stack.push(abs);
    }
  }
}

async function main(): Promise<void> {
  console.log(`📥 Fetching ${SOURCE_REPO}@${SOURCE_SHA} (${SOURCE_BRANCH})`);
  const tarballUrl = `https://codeload.github.com/${SOURCE_REPO}/tar.gz/${SOURCE_SHA}`;

  mkdirSync(REPO_ROOT, { recursive: true });
  const workDir = mkdtempSync(path.join(REPO_ROOT, '.adcp-v2-5-sync-'));
  try {
    const tgz = await fetchBinary(tarballUrl);
    const actualSha = createHash('sha256').update(tgz).digest('hex');
    if (actualSha !== SOURCE_TARBALL_SHA256) {
      throw new Error(
        `Tarball sha256 mismatch.\n  expected: ${SOURCE_TARBALL_SHA256}\n  actual:   ${actualSha}\n` +
          `Refresh by running:\n  curl -sL "${tarballUrl}" | shasum -a 256\n` +
          `and updating SOURCE_TARBALL_SHA256.`
      );
    }
    console.log(`✅ tarball sha256 verified (${actualSha.slice(0, 12)}…)`);

    const tgzPath = path.join(workDir, 'bundle.tgz');
    writeFileSync(tgzPath, tgz);
    // node-tar 7+ defaults to defending against `..` and absolute paths.
    // `strict: true` upgrades suspicious entries from warning to throw.
    await tar.x({ file: tgzPath, cwd: workDir, strict: true });

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

    // Reject any symlinks the tarball might have shipped — `cpSync`
    // follows them by default, which would let an upstream link copy
    // through to anywhere on disk. node-tar's default extraction blocks
    // symlinks-out-of-cwd, but explicit symlinks staying inside the
    // source tree would still be honoured by cpSync.
    assertNoSymlinks(sourceTree);

    const dest = path.join(SCHEMA_CACHE_DIR, TARGET_BUNDLE_KEY);
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(sourceTree, dest, { recursive: true, verbatimSymlinks: true });

    // Provenance file: lets downstream consumers diff bundles across
    // refreshes without re-running this script.
    writeFileSync(
      path.join(dest, '_provenance.json'),
      JSON.stringify(
        {
          source_repo: SOURCE_REPO,
          source_branch: SOURCE_BRANCH,
          source_sha: SOURCE_SHA,
          source_tarball_sha256: SOURCE_TARBALL_SHA256,
          upstream_adcp_version: upstreamVersion,
          synced_at: new Date().toISOString(),
        },
        null,
        2
      ) + '\n'
    );

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
