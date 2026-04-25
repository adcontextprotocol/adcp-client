#!/usr/bin/env tsx
/**
 * Post-`npm run sync-schemas` lint.
 *
 * Two regressions this catches:
 *
 * 1. **Missing skills.** The seven protocol-managed skills
 *    (`call-adcp-agent`, `adcp-{brand,creative,governance,media-buy,si,signals}`)
 *    must each exist with a non-empty `SKILL.md` after sync. Catches accidental
 *    deletion and the silent-no-op failure mode where the pinned tarball
 *    predates `manifest.contents.skills`.
 *
 * 2. **Path-base drift in `call-adcp-agent`.** The cross-cutting buyer skill
 *    is loaded by coding agents in SDK contexts and tells them where to find
 *    bundled JSON Schemas. Every `<base>/schemas/...`-style reference in the
 *    skill must resolve to a directory that actually exists in the SDK layout.
 *    Spec-repo paths (`dist/schemas/...`) drifting into the SDK is the exact
 *    failure mode we want to flag.
 *
 * Allow-list: regressions known to be upstream-blocked are listed in
 * `KNOWN_UPSTREAM_BLOCKS` with the issue number that resolves them. Each
 * entry should be deleted as the upstream issue is closed and the next
 * `sync-schemas` lands.
 *
 * Exit codes: 0 = clean, 1 = at least one new violation.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..');
const SKILLS_DIR = join(REPO_ROOT, 'skills');

const PROTOCOL_MANAGED_SKILLS = [
  'adcp-brand',
  'adcp-creative',
  'adcp-governance',
  'adcp-media-buy',
  'adcp-si',
  'adcp-signals',
  'call-adcp-agent',
] as const;

interface KnownBlock {
  /** GitHub issue tracking the upstream fix. */
  issue: string;
  /** Substring match against violation messages. */
  match: string;
  /** Why we're tolerating this in CI. */
  rationale: string;
}

/**
 * Violations expected to remain until the cited upstream issue resolves and
 * the next `sync-schemas` lands. Drop entries as fixes ship; the lint will
 * stop reporting that violation as "known" and start failing if it recurs.
 */
const KNOWN_UPSTREAM_BLOCKS: KnownBlock[] = [
  {
    issue: 'https://github.com/adcontextprotocol/adcp/issues/3117',
    // Scoped to the specific file + path-base so a future legitimate
    // dist/schemas/ tree (e.g., a published-bundle layout) doesn't get its
    // broken references silently swallowed by this allow-list.
    match: 'call-adcp-agent/SKILL.md references `dist/schemas/`',
    rationale:
      'Canonical call-adcp-agent skill references the spec-repo schema layout; SDK consumers extract to schemas/cache/<version>/bundled/. Pending upstream rewrite to consumer-aware phrasing.',
  },
];

interface Violation {
  kind: 'missing-skill' | 'unresolved-path';
  detail: string;
}

function checkSkillsPresent(): Violation[] {
  const out: Violation[] = [];
  for (const name of PROTOCOL_MANAGED_SKILLS) {
    const skillFile = join(SKILLS_DIR, name, 'SKILL.md');
    if (!existsSync(skillFile)) {
      out.push({ kind: 'missing-skill', detail: `${name}/SKILL.md does not exist` });
      continue;
    }
    // Strip leading frontmatter and check the body — catches the
    // "shipped but stubbed" regression where a tarball ships a skill
    // with only frontmatter and no content.
    const raw = readFileSync(skillFile, 'utf8');
    const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
    if (body.length === 0) {
      out.push({ kind: 'missing-skill', detail: `${name}/SKILL.md has no body content (frontmatter-only or empty)` });
    }
  }
  return out;
}

/**
 * Scan call-adcp-agent for filesystem path bases. We deliberately match the
 * directory prefix (e.g. `dist/schemas/`, `schemas/cache/`) rather than full
 * paths — the canonical skill uses placeholders like `<adcp-version>` that
 * never resolve as literals. The base prefix is what tells the reader
 * which tree to look in, and that's what must exist in the SDK layout.
 */
function checkCallAdcpAgentPaths(): Violation[] {
  const skillPath = join(SKILLS_DIR, 'call-adcp-agent', 'SKILL.md');
  if (!existsSync(skillPath)) return [];
  const raw = readFileSync(skillPath, 'utf8');

  // Strip fenced ```...``` blocks first — their backticks otherwise unbalance
  // the inline-span scan and swallow real path references in surrounding prose.
  const text = raw.replace(/```[\s\S]*?```/g, '');

  // Inside backtick-fenced spans, look for path-shaped content: at least two
  // segments separated by `/`, lowercase identifiers only, no spaces / parens /
  // colons (filters out shell commands, function calls, URLs, npm specifiers).
  // The base prefix (`<seg>/<seg>/`) is what tells the reader which tree to
  // navigate, and that's what must exist in the SDK layout.
  // `<placeholder>` text inside a path span is permitted on purpose — that's
  // exactly the canonical-skill pattern we want to flag (e.g.
  // `dist/schemas/<adcp-version>/bundled/`).
  const codeSpan = /`([^`]+)`/g;
  const pathLike = /^([a-z][a-z0-9_-]*)\/([a-z][a-z0-9_.-]*)\//;

  const seenBases = new Map<string, number>();
  for (const match of text.matchAll(codeSpan)) {
    const span = match[1];
    if (/[\s():]/.test(span)) continue;
    const m = pathLike.exec(span);
    if (!m) continue;
    const base = `${m[1]}/${m[2]}/`;
    seenBases.set(base, (seenBases.get(base) ?? 0) + 1);
  }

  const out: Violation[] = [];
  for (const [base, count] of seenBases) {
    const absolute = join(REPO_ROOT, base);
    if (!existsSync(absolute)) {
      out.push({
        kind: 'unresolved-path',
        detail: `call-adcp-agent/SKILL.md references \`${base}\` (${count} occurrence${count === 1 ? '' : 's'}) but ${absolute} does not exist`,
      });
    }
  }
  return out;
}

function partition(violations: Violation[]): {
  active: Violation[];
  known: Array<{ v: Violation; block: KnownBlock }>;
} {
  const active: Violation[] = [];
  const known: Array<{ v: Violation; block: KnownBlock }> = [];
  for (const v of violations) {
    const block = KNOWN_UPSTREAM_BLOCKS.find(b => v.detail.includes(b.match));
    if (block) known.push({ v, block });
    else active.push(v);
  }
  return { active, known };
}

function main(): void {
  const violations = [...checkSkillsPresent(), ...checkCallAdcpAgentPaths()];
  const { active, known } = partition(violations);

  if (known.length > 0) {
    console.log(`ℹ️  ${known.length} known upstream-blocked issue${known.length === 1 ? '' : 's'}:`);
    for (const { v, block } of known) {
      console.log(`   [known-upstream] ${v.detail}`);
      console.log(`                    tracked: ${block.issue}`);
    }
    console.log();
  }

  if (active.length === 0) {
    console.log(
      `✅ check-skill-sync: ${PROTOCOL_MANAGED_SKILLS.length} protocol-managed skills present, all path bases resolve.`
    );
    process.exit(0);
  }

  console.error(`❌ check-skill-sync: ${active.length} new violation${active.length === 1 ? '' : 's'}:`);
  for (const v of active) {
    console.error(`   [${v.kind}] ${v.detail}`);
  }
  console.error();
  console.error('To fix:');
  console.error('  - Re-run `npm run sync-schemas`, or');
  console.error('  - Edit `skills/<name>/SKILL.md` so the path resolves, or');
  console.error('  - If the regression is upstream-blocked, add an entry to');
  console.error('    `KNOWN_UPSTREAM_BLOCKS` in `scripts/check-skill-sync.ts` with a tracking issue.');
  process.exit(1);
}

main();
