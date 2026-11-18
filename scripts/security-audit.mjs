#!/usr/bin/env node
// CI security gate: fail on any high or critical `npm audit` advisory, except
// advisories listed in ACCEPTED_ADVISORIES.
//
// An advisory belongs in ACCEPTED_ADVISORIES only when no patched release
// exists, so neither `npm audit fix` nor an `overrides` pin can clear it. Each
// entry records why the exposure is acceptable and is removed as soon as a
// fixed version ships. Everything else at high or critical still fails the job.

import { spawnSync } from 'node:child_process';

const ACCEPTED_ADVISORIES = new Map([
  [
    'GHSA-fc5q-39xc-vjpf',
    'picomatch <=4.0.7 ReDoS via single-branch repeated extglobs. No patched release exists ' +
      '(upstream fix micromatch/picomatch#194 is unmerged; 4.0.7 is the latest version). ' +
      'picomatch is reached only through build, lint and release tooling (tinyglobby/fdir under ' +
      'tsup, typescript-eslint, @changesets/cli, ts-to-zod, json-schema-to-typescript, and the ' +
      'typescript-eslint parser that @adcp/eslint-plugin depends on), which matches glob patterns ' +
      'from repository and project configuration, not request input. The @adcp/sdk runtime does ' +
      'not depend on it. Remove this entry once picomatch ships a fix.',
  ],
]);

const BLOCKING_SEVERITIES = new Set(['high', 'critical']);

const result = spawnSync('npm', ['audit', '--json'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});

let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  console.error('npm audit did not return JSON.');
  console.error(result.stderr || result.stdout);
  process.exit(1);
}

if (report.error) {
  console.error(`npm audit failed: ${report.error.summary ?? JSON.stringify(report.error)}`);
  process.exit(1);
}

// Every package npm marks high or critical traces back to at least one
// advisory object in some package's `via` list, so checking the advisory
// objects themselves covers the whole tree.
const blocking = new Map();
const accepted = new Map();
for (const [name, vulnerability] of Object.entries(report.vulnerabilities ?? {})) {
  for (const via of vulnerability.via ?? []) {
    if (typeof via !== 'object' || !BLOCKING_SEVERITIES.has(via.severity)) continue;
    const id = typeof via.url === 'string' ? via.url.split('/').pop() : String(via.source);
    const target = ACCEPTED_ADVISORIES.has(id) ? accepted : blocking;
    const entry = target.get(id) ?? { title: via.title, severity: via.severity, url: via.url, packages: new Set() };
    entry.packages.add(`${name} ${via.range}`);
    target.set(id, entry);
  }
}

for (const [id, entry] of accepted) {
  console.log(`::warning title=Accepted advisory ${id}::${entry.title} (${[...entry.packages].join(', ')})`);
  console.log(`  ${ACCEPTED_ADVISORIES.get(id)}`);
}

for (const id of ACCEPTED_ADVISORIES.keys()) {
  if (!accepted.has(id)) {
    console.log(
      `::warning title=Stale accepted advisory ${id}::${id} no longer appears in npm audit; remove it from scripts/security-audit.mjs.`
    );
  }
}

const counts = report.metadata?.vulnerabilities ?? {};
console.log(
  `npm audit: ${counts.total ?? 0} total (${counts.critical ?? 0} critical, ${counts.high ?? 0} high, ` +
    `${counts.moderate ?? 0} moderate, ${counts.low ?? 0} low); ${accepted.size} accepted high/critical advisory(ies).`
);

if (blocking.size > 0) {
  console.error('❌ High or critical vulnerabilities found:');
  for (const [id, entry] of blocking) {
    console.error(`  ${entry.severity} ${id} ${entry.title}`);
    console.error(`    ${entry.url}`);
    console.error(`    affects: ${[...entry.packages].join(', ')}`);
  }
  process.exit(1);
}

console.log('✅ No unaccepted high or critical vulnerabilities found');
