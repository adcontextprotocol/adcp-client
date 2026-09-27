#!/usr/bin/env node
/** Smoke the actual npm tarball's buyer subpath under both Node module modes. */
import { execFileSync } from 'node:child_process';
import { accessSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = mkdtempSync(join(tmpdir(), 'adcp-reporting-consumer-pack-'));
try {
  const packOutput = execFileSync(
    'npm',
    ['pack', '--silent', '--json', '--ignore-scripts', '--pack-destination', temporary],
    {
      cwd: root,
      encoding: 'utf8',
    }
  );
  // The repository's npm prepare hook writes a status line before pack's JSON.
  const jsonStart = packOutput.lastIndexOf('\n[');
  const tarball = JSON.parse(jsonStart < 0 ? packOutput : packOutput.slice(jsonStart + 1))[0]?.filename;
  if (!tarball) throw new Error('npm pack did not return a tarball');
  const packageDir = join(temporary, 'node_modules', '@adcp', 'sdk');
  mkdirSync(packageDir, { recursive: true });
  execFileSync('tar', ['-xzf', join(temporary, tarball), '-C', packageDir, '--strip-components=1']);
  symlinkSync(join(root, 'node_modules'), join(packageDir, 'node_modules'), 'dir');
  for (const file of ['index.js', 'index.mjs', 'index.d.ts', 'index.d.mts']) {
    accessSync(join(packageDir, 'dist', 'lib', 'reporting', 'consumer', file));
  }
  const packedWorker = join(packageDir, 'examples', 'reliable-reporting-buyer', 'worker.mjs');
  accessSync(packedWorker);
  const { startBuyerReporting } = await import(pathToFileURL(packedWorker).href);
  if (typeof startBuyerReporting !== 'function') throw new Error('packed buyer example does not export its worker');
  writeFileSync(
    join(temporary, 'consumer.cjs'),
    `
    const assert = require('node:assert/strict');
    const buyer = require('@adcp/sdk/reporting/consumer');
    for (const name of ['reconcileReporting', 'reconcileReportingCoreV1', 'detectReportingContentMismatch', 'isReportingCoverageEvidence', 'createPostgresReportingConsumerRuntimeV1', 'createReliableReportingConsumerV1']) {
      assert.equal(typeof buyer[name], 'function', name);
    }
    assert.equal(buyer.createReliableReportingServiceV1, undefined);
  `
  );
  writeFileSync(
    join(temporary, 'consumer.mjs'),
    `
    import assert from 'node:assert/strict';
    import * as buyer from '@adcp/sdk/reporting/consumer';
    for (const name of ['reconcileReporting', 'reconcileReportingCoreV1', 'detectReportingContentMismatch', 'isReportingCoverageEvidence', 'createPostgresReportingConsumerRuntimeV1', 'createReliableReportingConsumerV1']) {
      assert.equal(typeof buyer[name], 'function', name);
    }
    assert.equal(buyer.createReliableReportingServiceV1, undefined);
  `
  );
  for (const file of ['consumer.cjs', 'consumer.mjs']) {
    execFileSync('node', [join(temporary, file)], { cwd: temporary, stdio: 'inherit' });
  }
  console.log('✅ Packed reporting consumer imports resolve in CJS and ESM with both declaration files.');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
