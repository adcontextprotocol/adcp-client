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
// Match both `blob/main/<path>` (file) and `tree/main/<path>` (directory)
// references. Pinned-commit forms (`blob/<sha>/...`) are intentionally NOT
// matched — those don't rot because the SHA pins the content.
const URL_RE = /https:\/\/github\.com\/adcontextprotocol\/adcp-client\/(?:blob|tree)\/main\/([^ "'`)\]]+)/g;

// Paths that may appear in URL form but legitimately don't resolve at the
// current commit — e.g. a doc that ships only on the published site, or a
// link to a directory rather than a file. Add an entry with the
// justification before adding; the goal is zero exemptions over time.
const EXEMPT_PATHS: ReadonlySet<string> = new Set([]);

// Scanned surface: source we author. Excludes generated TS (re-emitted on
// every schema sync; any URLs there land via the upstream spec text, not
// SDK authoring) and `dist/` (build output mirrors `src/`).
function isScannedFile(rel: string): boolean {
  if (rel.startsWith('src/') && rel.endsWith('.ts') && !rel.endsWith('.generated.ts')) {
    return true;
  }
  if (rel.startsWith('bin/') && rel.endsWith('.js')) return true;
  if (rel.startsWith('docs/') && (rel.endsWith('.md') || rel.endsWith('.mdx'))) return true;
  if (rel.startsWith('packages/') && (rel.endsWith('.ts') || rel.endsWith('.md')) && !rel.endsWith('.generated.ts')) {
    return true;
  }
  return rel === 'CLAUDE.md' || rel === 'README.md';
}

function listFiles(): string[] {
  // Minimal walker: avoids pulling in a glob dep for a single CI script.
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
      } else if (entry.isFile() && isScannedFile(path.relative(REPO_ROOT, full))) {
        result.push(full);
      }
    }
  };
  walk(REPO_ROOT);
  return result;
}

interface BrokenLink {
  source: string;
  line: number;
  pathRef: string;
}

function checkLinks(): BrokenLink[] {
  const broken: BrokenLink[] = [];
  for (const file of listFiles()) {
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
    '\nFix (preferred): update the reference shown above to point at the new path.\n' +
      'The reference is a `blob/main/...` or `tree/main/...` URL in source code or docs — fix the URL,\n' +
      'or rename the file back if the rename was unintended.\n' +
      '\n' +
      'Last resort: add the path to EXEMPT_PATHS in scripts/check-doc-links.ts with a one-line\n' +
      'justification — only if the link legitimately points at content not in this repo\n' +
      "(published-site-only docs, etc.). Don't use this to silence broken in-repo references."
  );
  process.exit(1);
}
console.log('✅ All SDK→docs URLs resolve to existing files.');
