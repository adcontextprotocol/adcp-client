#!/usr/bin/env node
/**
 * Build-time check for SDK→docs URL rot.
 *
 * Walks source files (src/, bin/, docs/, packages/) for hardcoded URLs of
 * the form `https://github.com/adcontextprotocol/adcp-client/blob/main/<path>`
 * and asserts that `<path>` exists at the local checkout root. Surfaces any
 * 404-prone links before they ship to users.
 *
 * Why this exists: when a runtime warning or JSDoc comment links to a docs
 * file by its `blob/main` URL, a file rename or move on `main` silently
 * 404s the link. The warning still fires but the user has no path to
 * context. This script catches the rot at the source — runs in CI so a
 * PR that moves a doc without updating the back-references fails.
 *
 * Closes adcontextprotocol/adcp-client#1790.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const URL_RE = /https:\/\/github\.com\/adcontextprotocol\/adcp-client\/blob\/main\/([^ "'`)\]]+)/g;

// Files to scan. Excludes generated TS (re-emitted on every schema sync;
// any URLs there land via the upstream spec text, not SDK authoring) and
// `dist/` (build output mirrors `src/`).
const SCAN_GLOBS: ReadonlyArray<string> = [
  'src/**/*.ts',
  'bin/**/*.js',
  'docs/**/*.md',
  'docs/**/*.mdx',
  'packages/*/src/**/*.ts',
  'packages/*/README.md',
  'CLAUDE.md',
  'README.md',
];

// Paths that may appear in URL form but legitimately don't resolve at the
// current commit — e.g. a doc that ships only on the published site, or a
// link to a directory rather than a file. Add an entry with the
// justification before adding; the goal is zero exemptions over time.
const EXEMPT_PATHS: ReadonlySet<string> = new Set([]);

function listFiles(globs: ReadonlyArray<string>): string[] {
  // Minimal glob matcher: walk the repo, match by suffix patterns. Avoids
  // pulling in a glob dependency for a single CI script.
  const result: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name === 'dist') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const rel = path.relative(REPO_ROOT, full);
        if (
          (rel.startsWith('src/') && rel.endsWith('.ts') && !rel.endsWith('.generated.ts')) ||
          (rel.startsWith('bin/') && rel.endsWith('.js')) ||
          (rel.startsWith('docs/') && (rel.endsWith('.md') || rel.endsWith('.mdx'))) ||
          (rel.startsWith('packages/') &&
            (rel.endsWith('.ts') || rel.endsWith('.md')) &&
            !rel.endsWith('.generated.ts')) ||
          rel === 'CLAUDE.md' ||
          rel === 'README.md'
        ) {
          result.push(full);
        }
      }
    }
  };
  walk(REPO_ROOT);
  void globs;
  return result;
}

interface BrokenLink {
  source: string;
  line: number;
  pathRef: string;
}

function checkLinks(): BrokenLink[] {
  const broken: BrokenLink[] = [];
  for (const file of listFiles(SCAN_GLOBS)) {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n');
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx]!;
      URL_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = URL_RE.exec(line)) !== null) {
        let pathRef = match[1]!;
        // Strip URL fragment (`#anchor`) — anchor presence/absence isn't
        // a file-existence concern. Markdown link anchors inside docs are
        // best validated by a docs build, not this script.
        const hashIdx = pathRef.indexOf('#');
        if (hashIdx !== -1) pathRef = pathRef.slice(0, hashIdx);
        if (EXEMPT_PATHS.has(pathRef)) continue;
        const absolute = path.join(REPO_ROOT, pathRef);
        if (!fs.existsSync(absolute)) {
          broken.push({
            source: path.relative(REPO_ROOT, file),
            line: lineIdx + 1,
            pathRef,
          });
        }
      }
    }
  }
  return broken;
}

const broken = checkLinks();
if (broken.length > 0) {
  console.error('❌ Found broken SDK→docs URLs:');
  for (const b of broken) {
    console.error(`  ${b.source}:${b.line} → ${b.pathRef}`);
  }
  console.error(
    '\nFix: rename the doc back, OR update the reference, OR add the path to EXEMPT_PATHS\n' +
      'in scripts/check-doc-links.ts with a one-line justification.'
  );
  process.exit(1);
}
console.log('✅ All SDK→docs URLs resolve to existing files.');
