#!/usr/bin/env node
/**
 * Refresh the vendored canonical reporting-subscription vectors
 * (test/fixtures/reporting-subscriptions/canonical/) from the spec repository at one commit, byte for byte,
 * and rewrite PINNED.json with the commit and each file's sha256.
 *
 *   npm run sync:reporting-subscription-vectors -- --commit <sha>               # GitHub raw
 *   npm run sync:reporting-subscription-vectors -- --commit <sha> --from <dir>  # local spec checkout (git show)
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY = 'adcontextprotocol/adcp';
const UPSTREAM = 'static/compliance/source/test-vectors/reporting-subscriptions';
const FILES = ['case.schema.json', 'error-codes.json', 'reason-codes.json', 'vectors.json'];
const target = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'test',
  'fixtures',
  'reporting-subscriptions',
  'canonical'
);

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const commit = argument('--commit');
const from = argument('--from');
if (!commit || !/^[0-9a-f]{7,40}$/.test(commit)) {
  console.error('Usage: sync-reporting-subscription-vectors --commit <sha> [--from <spec checkout>]');
  process.exit(2);
}

async function read(file) {
  if (from) {
    return execFileSync('git', ['-C', from, 'show', `${commit}:${UPSTREAM}/${file}`], { maxBuffer: 64 * 1024 * 1024 });
  }
  const url = `https://raw.githubusercontent.com/${REPOSITORY}/${commit}/${UPSTREAM}/${file}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

const fullCommit = from ? execFileSync('git', ['-C', from, 'rev-parse', commit], { encoding: 'utf8' }).trim() : commit;
const pinPath = join(target, 'PINNED.json');
const pin = JSON.parse(readFileSync(pinPath, 'utf8'));
const sha256 = {};
for (const file of FILES) {
  const bytes = await read(file);
  writeFileSync(join(target, file), bytes);
  sha256[file] = createHash('sha256').update(bytes).digest('hex');
}
writeFileSync(pinPath, `${JSON.stringify({ ...pin, sha: fullCommit, sha256 }, null, 2)}\n`);
console.log(`Synced ${FILES.length} files from ${REPOSITORY}@${fullCommit}.`);
