/**
 * Resolve the @adcp/sdk package root — the directory containing this
 * package's own `package.json` — independent of the calling module's own
 * directory depth or bundling shape.
 *
 * Replaces the per-file `__dirname` arithmetic that used to be hand-tuned to
 * each schema/data loader's own depth under `src/lib/` (one `..` for
 * `validation/`, two for `v2/projection/`, four for `testing/storyboard/`),
 * which silently breaks if any of those files ever moves.
 */

import { existsSync, readFileSync } from 'fs';
import path from 'path';

let cachedRoot: string | undefined;

/**
 * Primary: self-reference through this package's own `exports` map
 * (`"./package.json": "./package.json"`). Node resolves `require(...)` calls
 * (bare form, not `.resolve` chained) so tsup's conditional ESM shim still
 * detects this file needs `require` injected under `.mjs` output.
 */
function resolveViaModuleResolution(): string | undefined {
  try {
    const pkg = require('@adcp/sdk/package.json') as { name?: string };
    if (pkg.name !== '@adcp/sdk') return undefined;
    return path.dirname(require.resolve('@adcp/sdk/package.json'));
  } catch {
    return undefined;
  }
}

/**
 * Fallback: walk up from a starting directory looking for an ancestor
 * `package.json` whose `name` is `@adcp/sdk`. Covers environments where
 * module self-resolution is unavailable (e.g. an aggressive downstream
 * bundler that strips/rewrites `require.resolve`).
 *
 * Exported for direct testing; not part of the public API surface.
 */
export function _resolvePackageRootViaDirectoryWalk(start: string): string | undefined {
  let dir = start;
  for (;;) {
    const candidate = path.join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf-8')) as { name?: string };
        if (pkg.name === '@adcp/sdk') return dir;
      } catch {
        // Malformed/unrelated package.json — keep walking past it.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Resolve the package root, memoized after the first successful call.
 *
 * Throws if both resolution strategies fail — this indicates a broken
 * install or an aggressive bundler that stripped `package.json`, not a
 * recoverable runtime condition.
 */
export function getPackageRoot(): string {
  if (cachedRoot) return cachedRoot;
  const resolved = resolveViaModuleResolution() ?? _resolvePackageRootViaDirectoryWalk(__dirname);
  if (!resolved) {
    throw new Error(
      '@adcp/sdk: could not resolve the package root (require.resolve self-reference and directory walk ' +
        'both failed). This indicates a broken install or an aggressive bundler that stripped package.json.'
    );
  }
  cachedRoot = resolved;
  return cachedRoot;
}

/** Test hook: clear the memoized package root. */
export function _resetPackageRootCache(): void {
  cachedRoot = undefined;
}
