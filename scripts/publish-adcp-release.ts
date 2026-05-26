#!/usr/bin/env tsx
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

type PackageJson = {
  adcp_version?: string;
};

type ChangesetPreState = {
  mode?: string;
  tag?: string;
  [key: string]: unknown;
};

const PACKAGE_JSON_PATH = resolve('package.json');
const PRE_STATE_PATH = resolve('.changeset/pre.json');
const isDryRun = process.argv.includes('--dry-run');

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function adcpMinorLine(adcpVersion: string): string {
  const match = /^(\d+)\.(\d+)(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?$/.exec(adcpVersion);
  if (match == null) {
    throw new Error(
      `Cannot derive AdCP minor line from ${JSON.stringify(adcpVersion)}. ` +
        'Expected MAJOR.MINOR[.PATCH][-PRERELEASE].'
    );
  }
  return `${match[1]}.${match[2]}`;
}

function adcpPublishTag(): string {
  const packageJson = readJson<PackageJson>(PACKAGE_JSON_PATH);
  const adcpVersion = packageJson.adcp_version;
  if (!adcpVersion) throw new Error('Missing package.json#adcp_version.');
  return `adcp-${adcpMinorLine(adcpVersion)}`;
}

function runChangesetPublish(): number {
  if (isDryRun) {
    console.log('[dry-run] changeset publish');
    return 0;
  }

  const result = spawnSync('changeset', ['publish'], {
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
  });
  return result.status ?? 1;
}

function main(): void {
  const tag = process.env.ADCP_NPM_TAG || adcpPublishTag();
  const publishArgs = ['publish', '--tag', tag];

  if (!existsSync(PRE_STATE_PATH)) {
    console.log(`Publishing packages under npm dist-tag ${tag}.`);
    if (isDryRun) {
      console.log(`[dry-run] changeset ${publishArgs.join(' ')}`);
      return;
    }
    const result = spawnSync('changeset', publishArgs, {
      stdio: 'inherit',
      env: process.env,
      shell: process.platform === 'win32',
    });
    process.exit(result.status ?? 1);
  }

  const originalPreStateText = readFileSync(PRE_STATE_PATH, 'utf8');
  const preState = JSON.parse(originalPreStateText) as ChangesetPreState;

  if (preState.mode !== 'pre') {
    console.log(`Publishing packages under npm dist-tag ${tag}.`);
    if (isDryRun) {
      console.log(`[dry-run] changeset ${publishArgs.join(' ')}`);
      return;
    }
    const result = spawnSync('changeset', publishArgs, {
      stdio: 'inherit',
      env: process.env,
      shell: process.platform === 'win32',
    });
    process.exit(result.status ?? 1);
  }

  console.log(
    `Publishing Changesets pre-mode packages under npm dist-tag ${tag}; ` +
      `package versions keep their existing ${preState.tag} prerelease identifier.`
  );

  let exitCode = 1;
  try {
    writeJson(PRE_STATE_PATH, {
      ...preState,
      tag,
    });
    exitCode = runChangesetPublish();
  } finally {
    writeFileSync(PRE_STATE_PATH, originalPreStateText);
  }
  process.exit(exitCode);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
