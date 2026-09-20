#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

function major(version) {
  const match = String(version).match(/^(\d+)\./);
  if (!match) throw new Error(`Cannot read semver major from ${JSON.stringify(version)}`);
  return Number(match[1]);
}

export function resolveLatestPolicy({ publishedVersion, latestVersion }) {
  const publishedMajor = major(publishedVersion);
  const latestMajor = major(latestVersion);
  if (latestMajor > publishedMajor) {
    return {
      action: 'preserve-latest',
      message:
        `Keep npm latest at ${latestVersion}; the ${publishedVersion} maintenance release is available only through ` +
        '`adcp-3.1` and exact versions.',
    };
  }
  if (latestMajor === publishedMajor) {
    return {
      action: 'promote-latest-with-credential',
      command: `npm dist-tag add @adcp/sdk@${publishedVersion} latest`,
      message:
        `npm latest is still on major ${latestMajor} (${latestVersion}). Promote this maintenance release to latest ` +
        'with a maintainer credential; GitHub trusted-publishing OIDC cannot mutate a second dist-tag.',
    };
  }
  return {
    action: 'review-registry-state',
    message: `npm latest (${latestVersion}) is older than the published maintenance line (${publishedVersion}); review manually.`,
  };
}

export function applyLatestPolicy(policy, options = {}) {
  const hasToken = Boolean(options.npmToken);
  if (policy.action !== 'promote-latest-with-credential') return policy;
  if (!options.apply || !hasToken) {
    return {
      ...policy,
      action: 'promotion-required-no-token',
      message: `${policy.message} No NPM_TOKEN was available, so this run was report-only.`,
    };
  }
  const run = options.run ?? ((command, args) => execFileSync(command, args, { stdio: 'inherit' }));
  run('npm', ['dist-tag', 'add', `@adcp/sdk@${options.publishedVersion}`, 'latest']);
  return {
    action: 'promoted-latest',
    command: policy.command,
    message: `Moved npm latest to @adcp/sdk@${options.publishedVersion}; registry latest was still on major 13.`,
  };
}

function readPublishedVersion() {
  return process.env.ADCP_PUBLISHED_VERSION || JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
}

function readLatestVersion() {
  if (process.env.ADCP_CURRENT_LATEST) return process.env.ADCP_CURRENT_LATEST;
  return execFileSync('npm', ['view', '@adcp/sdk@latest', 'version', '--json'], { encoding: 'utf8' })
    .trim()
    .replace(/^"|"$/g, '');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const publishedVersion = readPublishedVersion();
  const latestVersion = readLatestVersion();
  const policy = applyLatestPolicy(resolveLatestPolicy({ publishedVersion, latestVersion }), {
    apply: process.argv.includes('--apply'),
    npmToken: process.env.NPM_TOKEN,
    publishedVersion,
  });
  const lines = [
    '## npm dist-tag policy',
    '',
    `Published \`@adcp/sdk@${publishedVersion}\` under \`adcp-3.1\`.`,
    '',
    policy.message,
    ...(policy.action === 'promotion-required-no-token' && policy.command
      ? ['', `Credential-only follow-up: \`${policy.command}\``]
      : []),
    '',
  ];
  const output = lines.join('\n');
  console.log(output);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, output);
  if (policy.action === 'promotion-required-no-token') {
    console.log(`::warning title=npm latest follow-up::${policy.command}`);
  }
}
