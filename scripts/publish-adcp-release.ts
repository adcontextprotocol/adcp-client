#!/usr/bin/env tsx
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

type ChangesetPreState = {
  mode?: string;
  tag?: string;
  [key: string]: unknown;
};

const PRE_STATE_PATH = resolve('.changeset/pre.json');
const PACKAGE_PATH = resolve('package.json');
const DEFAULT_RELEASE_TAG = 'latest';
const isDryRun = process.argv.includes('--dry-run');

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
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

function resolvePublishTag(preState?: ChangesetPreState): string {
  // A prerelease must never inherit a stable-line override such as
  // `adcp-3.1`: doing so would publish an rc/beta under a stable tag.
  if (preState?.mode === 'pre' && preState.tag) return preState.tag;
  if (process.env.ADCP_NPM_TAG) return process.env.ADCP_NPM_TAG;
  return DEFAULT_RELEASE_TAG;
}

function assertStableTagHasStableSdkVersion(tag: string): void {
  if (tag !== 'latest' && !/^adcp-\d+\.\d+$/.test(tag)) return;
  const version = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8')).version;
  if (typeof version === 'string' && version.includes('-')) {
    throw new Error(
      `Refusing to publish prerelease @adcp/sdk@${version} under stable npm dist-tag ${tag}; ` +
        'restore Changesets pre-mode or choose an explicit prerelease tag.'
    );
  }
}

function main(): void {
  if (!existsSync(PRE_STATE_PATH)) {
    const tag = resolvePublishTag();
    assertStableTagHasStableSdkVersion(tag);
    const publishArgs = ['publish', '--tag', tag];
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
  const tag = resolvePublishTag(preState);
  assertStableTagHasStableSdkVersion(tag);
  const publishArgs = ['publish', '--tag', tag];

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
