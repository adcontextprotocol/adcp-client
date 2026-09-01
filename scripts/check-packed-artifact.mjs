#!/usr/bin/env node

/** Validate documentation and examples exactly as npm will publish them. */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNpmPackOutput } from './check-package-size.mjs';

const MARKDOWN_LINK_RE = /!?\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\)/g;
const LOCAL_DOC_PATH_RE = /(?:^|[`\s([])(docs\/[A-Za-z0-9_./-]+\.md)\b/gm;
const LOCAL_EXAMPLE_PATH_RE = /(?:^|[`\s([])((?:examples\/)?[A-Za-z0-9_./-]+\.ts)\b/gm;
const SOURCE_ONLY_IMPORT_RE = /(?:from\s+|import\s*\(|require\s*\()\s*["'](?:\.\.\/)+(?:src|test)(?:\/|["'])/g;

function isExternalLink(target) {
  return target.startsWith('#') || target.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(target);
}

function normalizeLink(source, target) {
  const withoutFragment = target.split('#', 1)[0].split('?', 1)[0];
  let decoded;
  try {
    decoded = decodeURIComponent(withoutFragment);
  } catch {
    decoded = withoutFragment;
  }
  return path.posix.normalize(path.posix.join(path.posix.dirname(source), decoded));
}

export function checkPackedArtifact(repoRoot, packageInfo) {
  const packed = new Set(packageInfo.files.map(file => file.path));
  const brokenLinks = [];
  const sourceImports = [];
  const exampleTsconfig = JSON.parse(readFileSync(path.join(repoRoot, 'tsconfig.examples.json'), 'utf8'));
  const compiledExamples = new Set(exampleTsconfig.include ?? []);

  for (const file of packageInfo.files) {
    const relative = file.path;
    const absolute = path.join(repoRoot, relative);
    if (relative.endsWith('.md') || relative.endsWith('.txt')) {
      const source = readFileSync(absolute, 'utf8');
      MARKDOWN_LINK_RE.lastIndex = 0;
      let match;
      while ((match = MARKDOWN_LINK_RE.exec(source)) !== null) {
        const target = match[1] ?? match[2];
        if (!target || isExternalLink(target)) continue;
        const resolved = normalizeLink(relative, target);
        const directoryPrefix = resolved.endsWith('/') ? resolved : `${resolved}/`;
        if (!packed.has(resolved) && ![...packed].some(candidate => candidate.startsWith(directoryPrefix))) {
          brokenLinks.push(`${relative} -> ${target}`);
        }
      }
      if (relative === 'docs/llms.txt') {
        LOCAL_DOC_PATH_RE.lastIndex = 0;
        while ((match = LOCAL_DOC_PATH_RE.exec(source)) !== null) {
          if (!packed.has(match[1])) brokenLinks.push(`${relative} -> ${match[1]}`);
        }
      }
      if (relative === 'examples/README.md') {
        LOCAL_EXAMPLE_PATH_RE.lastIndex = 0;
        while ((match = LOCAL_EXAMPLE_PATH_RE.exec(source)) !== null) {
          const target = path.posix.normalize(match[1].startsWith('examples/') ? match[1] : `examples/${match[1]}`);
          if (!packed.has(target)) brokenLinks.push(`${relative} -> ${target}`);
        }
      }
    }

    if (relative.startsWith('examples/') && /\.[cm]?[jt]sx?$/.test(relative)) {
      const source = readFileSync(absolute, 'utf8');
      SOURCE_ONLY_IMPORT_RE.lastIndex = 0;
      if (SOURCE_ONLY_IMPORT_RE.test(source)) sourceImports.push(relative);
    }
  }

  const uncompiledExamples = [...packed]
    .filter(relative => relative.startsWith('examples/') && relative.endsWith('.ts'))
    .filter(relative => !compiledExamples.has(relative));

  if (brokenLinks.length > 0 || sourceImports.length > 0 || uncompiledExamples.length > 0) {
    const messages = [];
    if (brokenLinks.length > 0) {
      messages.push(`broken packed documentation links:\n  ${[...new Set(brokenLinks)].sort().join('\n  ')}`);
    }
    if (sourceImports.length > 0) {
      messages.push(`packed examples importing omitted source/test paths:\n  ${sourceImports.sort().join('\n  ')}`);
    }
    if (uncompiledExamples.length > 0) {
      messages.push(
        `packed TypeScript examples missing from tsconfig.examples.json:\n  ${uncompiledExamples.sort().join('\n  ')}`
      );
    }
    throw new Error(messages.join('\n'));
  }

  console.log(
    `✅ Packed artifact links resolve and ${compiledExamples.size} shipped TypeScript examples are compile-gated with installed-package imports.`
  );
}

const scriptPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (scriptPath === fileURLToPath(import.meta.url)) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts', '--loglevel=error'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      maxBuffer: 64 * 1024 * 1024,
    });
    const [packageInfo] = parseNpmPackOutput(output);
    if (!packageInfo?.files) throw new Error('npm pack returned no file inventory');
    checkPackedArtifact(repoRoot, packageInfo);
  } catch (error) {
    console.error(`❌ Packed artifact check failed:\n${error.message ?? error}`);
    process.exitCode = 1;
  }
}
