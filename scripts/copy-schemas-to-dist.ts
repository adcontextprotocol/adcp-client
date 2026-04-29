#!/usr/bin/env tsx
/**
 * Copy `schemas/cache/<ver>/` directories into the built package so the
 * runtime validator (src/lib/validation/schema-loader.ts) can read them
 * without a dependency on the source tree.
 *
 * Source: schemas/cache/<ver>/{bundled,core,<domain>}/
 * Dest:   dist/lib/schemas-data/<ver>/{bundled,core,<domain>}/
 *
 * Stage 3 (per-instance schema selection) requires every supported AdCP
 * version's bundle ship inside the npm tarball. To keep the bundle from
 * growing linearly with patch releases, we ship at most one **stable**
 * patch per `MAJOR.MINOR` (the highest patch in the cache). Per the AdCP
 * spec convention patch releases don't change wire shape, so collapsing
 * `3.0.0` + `3.0.1` to just `3.0.1` is functionally equivalent for any
 * validator consumer. Prereleases (`3.1.0-beta.1`, `3.1.0-rc.2`, …) are
 * **never collapsed** — pinning a beta is intentional and bit-fidelity
 * matters for cross-version interop tests.
 *
 * Skipped from copy:
 *   - `latest` symlink — duplicates a real version directory
 *   - `*.previous` backup snapshots from `sync-schemas` replaceTree
 *   - older patch versions of stable releases — collapsed into the
 *     highest-patch sibling
 *   - `tmp/`, `compliance/` subtrees — runtime validator doesn't read them
 *
 * Invoked by the `build:lib` npm script after tsc emits JS.
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync } from 'fs';
import path from 'path';

interface ParsedVersion {
  version: string;
  major: number;
  minor: number;
  patch: number;
  prerelease: string | undefined;
}

/**
 * Parse the directory name as a semver. Returns `undefined` for anything
 * that doesn't look like an AdCP version (skipped at the call site).
 *
 * Handles:
 *   - `'3.0.1'` → { major:3, minor:0, patch:1, prerelease:undefined }
 *   - `'3.1.0-beta.1'` → { major:3, minor:1, patch:0, prerelease:'beta.1' }
 *   - `'v3'` / `'v2.5'` (legacy aliases) — returned as-is, no collapse
 *
 * Anything else (`'tmp'`, free-text directory) returns `undefined`.
 */
function parseSemver(version: string): ParsedVersion | undefined {
  // Legacy 'vN' / 'vN.M' aliases — never collapse, treat as opaque.
  if (/^v\d/.test(version)) {
    const m = version.match(/^v(\d+)(?:\.(\d+))?$/);
    if (!m) return undefined;
    return {
      version,
      major: parseInt(m[1]!, 10),
      minor: m[2] ? parseInt(m[2], 10) : 0,
      patch: 0,
      prerelease: 'legacy',
    };
  }
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (!m) return undefined;
  return {
    version,
    major: parseInt(m[1]!, 10),
    minor: parseInt(m[2]!, 10),
    patch: parseInt(m[3]!, 10),
    prerelease: m[4],
  };
}

/**
 * Apply the collapse-stable-by-minor rule.
 *
 * For each (major, minor) group of stable versions (no prerelease tag),
 * keep only the highest patch. Prereleases pass through unchanged.
 */
function selectVersionsToCopy(parsed: ParsedVersion[]): ParsedVersion[] {
  const stableHighestPatch = new Map<string, ParsedVersion>();
  const prereleases: ParsedVersion[] = [];

  for (const v of parsed) {
    if (v.prerelease !== undefined) {
      // Includes 'legacy' alias marker — keep all, no collapse.
      prereleases.push(v);
      continue;
    }
    const key = `${v.major}.${v.minor}`;
    const current = stableHighestPatch.get(key);
    if (!current || v.patch > current.patch) {
      stableHighestPatch.set(key, v);
    }
  }

  return [...stableHighestPatch.values(), ...prereleases];
}

function main(): void {
  const repoRoot = path.resolve(__dirname, '..');
  const cacheRoot = path.join(repoRoot, 'schemas', 'cache');
  if (!existsSync(cacheRoot)) {
    // The schema cache is fetched by `sync-schemas`. CI jobs that don't run
    // the full toolchain (e.g., the code-quality integrity check that does
    // `npm clean && build:lib` without a prior sync-schemas) would otherwise
    // break here. Skip quietly — the loader falls back to the same source
    // path, and any job that actually needs the schemas at runtime will get
    // a clear error at first use.
    console.warn(
      `[copy-schemas-to-dist] schemas/cache/ missing; skipping. ` +
        `Run \`npm run sync-schemas\` to populate it before shipping.`
    );
    return;
  }

  // Collect parseable version directories.
  const candidates: ParsedVersion[] = [];
  const skipped: string[] = [];
  for (const entry of readdirSync(cacheRoot, { withFileTypes: true })) {
    // `latest` is a symlink to the current default version; the loader
    // resolves versions by name, not via that alias.
    if (entry.name === 'latest') continue;
    // `*.previous` are sync-schemas replaceTree backup snapshots.
    if (entry.name.endsWith('.previous')) continue;
    if (!entry.isDirectory()) {
      // Defensive: skip non-directory entries (loose files, broken symlinks).
      // `lstatSync` rather than `entry.isDirectory()` so a symlink-to-dir
      // doesn't masquerade as a real version when the link target is gone.
      const abs = path.join(cacheRoot, entry.name);
      try {
        if (!lstatSync(abs).isDirectory()) continue;
      } catch {
        continue;
      }
    }
    const parsed = parseSemver(entry.name);
    if (!parsed) {
      skipped.push(entry.name);
      continue;
    }
    candidates.push(parsed);
  }

  const selected = selectVersionsToCopy(candidates);
  const collapsed = candidates.filter(c => !selected.some(s => s.version === c.version));

  const destBase = path.join(repoRoot, 'dist', 'lib', 'schemas-data');

  for (const v of selected) {
    const srcRoot = path.join(cacheRoot, v.version);
    const destRoot = path.join(destBase, v.version);
    mkdirSync(destRoot, { recursive: true });
    cpSync(srcRoot, destRoot, {
      recursive: true,
      filter: src => {
        const rel = path.relative(srcRoot, src);
        if (!rel) return true;
        const top = rel.split(path.sep)[0];
        if (top === 'tmp' || top === 'compliance') return false;
        return true;
      },
    });
    console.log(`[copy-schemas-to-dist] copied ${srcRoot} → ${destRoot}`);
  }

  for (const v of collapsed) {
    console.log(`[copy-schemas-to-dist] collapsed ${v.version} (older patch in ${v.major}.${v.minor}.x; not bundled)`);
  }

  for (const name of skipped) {
    console.log(`[copy-schemas-to-dist] skipped ${name} (not a parseable version)`);
  }

  if (selected.length === 0) {
    console.warn(`[copy-schemas-to-dist] no version directories under ${cacheRoot}; bundle ships without schemas.`);
  }
}

main();
