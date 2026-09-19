#!/usr/bin/env node
/** Vendor the upstream canonical corpus at an explicitly reviewed immutable commit. */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'test/fixtures/supply-path');
const upstreamPath = 'static/compliance/source/test-vectors/supply-path/vectors.json';
const args = process.argv.slice(2);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
if (args.length === 2 && args[0] === '--commit' && /^[a-f0-9]{40}$/.test(args[1])) {
  const commit = args[1];
  const response = await fetch(`https://raw.githubusercontent.com/adcontextprotocol/adcp/${commit}/${upstreamPath}`, {
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Cannot fetch canonical corpus: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const corpus = JSON.parse(bytes.toString('utf8'));
  if (corpus.semantics_version !== '1' || !Array.isArray(corpus.vectors) || !corpus.vectors.length)
    throw new Error('Unsupported canonical corpus');
  await writeFile(path.join(directory, 'vectors.json'), bytes);
  await writeFile(
    path.join(directory, 'source.json'),
    JSON.stringify(
      {
        repository: 'adcontextprotocol/adcp',
        commit,
        path: upstreamPath,
        sha256: sha256(bytes),
        semantics_version: corpus.semantics_version,
      },
      null,
      2
    ) + '\n'
  );
  console.log(`Pinned canonical supply-path vectors at ${commit}`);
} else if (!args.length || (args.length === 1 && args[0] === '--check')) {
  const source = JSON.parse(await readFile(path.join(directory, 'source.json'), 'utf8'));
  const bytes = await readFile(path.join(directory, 'vectors.json'));
  if (
    source.repository !== 'adcontextprotocol/adcp' ||
    source.path !== upstreamPath ||
    !/^[a-f0-9]{40}$/.test(source.commit) ||
    source.sha256 !== sha256(bytes) ||
    source.semantics_version !== JSON.parse(bytes.toString('utf8')).semantics_version
  )
    throw new Error('Canonical supply-path fixture provenance mismatch');
  console.log(`Canonical supply-path fixture integrity verified (${source.commit})`);
} else {
  throw new Error('Usage: node scripts/sync-supply-path-vectors.mjs [--check | --commit <reviewed 40-character SHA>]');
}
