#!/usr/bin/env tsx
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  describeHeldBack,
  findUnbootstrappedPackages,
  listWorkspacePackages,
  withPackagesHeldBack,
} from './lib/hold-back-unbootstrapped-packages.mjs';

type ChangesetPreState = {
  mode?: string;
  tag?: string;
  [key: string]: unknown;
};

const PRE_STATE_PATH = resolve('.changeset/pre.json');
const DEFAULT_RELEASE_TAG = 'latest';
const isDryRun = process.argv.includes('--dry-run');

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Run `changeset publish`, without a workspace package the registry has never seen. npm trusted publishing
 * cannot do a package's first publish, and a failure there must not take the other packages' release down
 * with it. See scripts/lib/hold-back-unbootstrapped-packages.mjs and docs/development/NPM-DIST-TAGS.md.
 */
function changesetPublish(args: string[]): number {
  const held = findUnbootstrappedPackages(listWorkspacePackages(resolve('.')));
  if (held.length > 0) {
    const message = describeHeldBack(held);
    console.warn(message);
    if (process.env.GITHUB_ACTIONS) console.log(`::warning title=First publish needed::${message}`);
  }
  if (isDryRun) {
    console.log(`[dry-run] changeset ${args.join(' ')}`);
    return 0;
  }
  const result = withPackagesHeldBack(held, () =>
    spawnSync('changeset', args, {
      stdio: 'inherit',
      env: process.env,
      shell: process.platform === 'win32',
    })
  );
  return result.status ?? 1;
}

function runChangesetPublish(): number {
  return changesetPublish(['publish']);
}

function resolvePublishTag(preState?: ChangesetPreState): string {
  if (process.env.ADCP_NPM_TAG) return process.env.ADCP_NPM_TAG;
  if (preState?.mode === 'pre' && preState.tag) return preState.tag;
  return DEFAULT_RELEASE_TAG;
}

function main(): void {
  if (!existsSync(PRE_STATE_PATH)) {
    const tag = resolvePublishTag();
    const publishArgs = ['publish', '--tag', tag];
    console.log(`Publishing packages under npm dist-tag ${tag}.`);
    process.exit(changesetPublish(publishArgs));
  }

  const originalPreStateText = readFileSync(PRE_STATE_PATH, 'utf8');
  const preState = JSON.parse(originalPreStateText) as ChangesetPreState;
  const tag = resolvePublishTag(preState);
  const publishArgs = ['publish', '--tag', tag];

  if (preState.mode !== 'pre') {
    console.log(`Publishing packages under npm dist-tag ${tag}.`);
    process.exit(changesetPublish(publishArgs));
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
