#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SDK_PACKAGE = '@adcp/sdk';

function parseVersion(version) {
  const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) throw new Error(`Cannot parse npm semver ${JSON.stringify(version)}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
  };
}

function compareStableVersions(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  return 0;
}

export function readPublishedSdkVersion(value) {
  if (!value) throw new Error('Changesets did not provide ADCP_PUBLISHED_PACKAGES');
  let packages;
  try {
    packages = JSON.parse(value);
  } catch (error) {
    throw new Error(
      `Could not parse Changesets publishedPackages JSON: ${error instanceof Error ? error.message : error}`
    );
  }
  if (!Array.isArray(packages)) throw new Error('Changesets publishedPackages output was not an array');
  const sdk = packages.find(item => item && item.name === SDK_PACKAGE);
  if (!sdk) return undefined;
  if (typeof sdk.version !== 'string') throw new Error(`Changesets published ${SDK_PACKAGE} without a version`);
  parseVersion(sdk.version);
  return sdk.version;
}

export function resolvePublishTag(env = process.env, preStatePath = '.changeset/pre.json') {
  if (existsSync(preStatePath)) {
    const preState = JSON.parse(readFileSync(preStatePath, 'utf8'));
    if (preState?.mode === 'pre' && typeof preState.tag === 'string' && preState.tag.length > 0) {
      return preState.tag;
    }
  }
  return env.ADCP_NPM_TAG || 'latest';
}

export function resolveLatestPolicy({ publishedVersion, latestVersion, publishTag = 'adcp-3.1' }) {
  const published = parseVersion(publishedVersion);
  const latest = parseVersion(latestVersion);

  if (published.prerelease) {
    return {
      action: 'preserve-prerelease',
      message: `Do not move stable npm tags for prerelease ${publishedVersion}; its Changesets prerelease tag is authoritative.`,
    };
  }
  if (latest.major > published.major) {
    return {
      action: 'preserve-latest',
      message:
        `Keep npm latest at ${latestVersion}; the ${publishedVersion} maintenance release is available only through ` +
        `\`${publishTag}\` and exact versions.`,
    };
  }
  if (latest.major === published.major) {
    const comparison = compareStableVersions(published, latest);
    if (comparison < 0) {
      return {
        action: 'preserve-newer-latest',
        message: `Keep npm latest at newer ${latestVersion}; refusing to move it backward to ${publishedVersion}.`,
      };
    }
    if (comparison === 0 && !latest.prerelease) {
      return {
        action: 'latest-already-current',
        message: `npm latest already points to ${publishedVersion}; no second tag mutation is needed.`,
      };
    }
    return {
      action: 'promote-latest-with-credential',
      command: `npm dist-tag add ${SDK_PACKAGE}@${publishedVersion} latest`,
      message:
        `npm latest is still on major ${latest.major} (${latestVersion}). Promote this maintenance release to latest ` +
        'with a maintainer credential; GitHub trusted-publishing OIDC cannot mutate a second dist-tag.',
    };
  }
  return {
    action: 'review-registry-state',
    message: `npm latest (${latestVersion}) is older than the published maintenance line (${publishedVersion}); review manually.`,
  };
}

function defaultReadLatestVersion() {
  try {
    return execFileSync('npm', ['view', `${SDK_PACKAGE}@latest`, 'version', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .trim()
      .replace(/^"|"$/g, '');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read ${SDK_PACKAGE}@latest from npm: ${detail}`);
  }
}

export function applyLatestPolicy(policy, options = {}) {
  if (policy.action !== 'promote-latest-with-credential') return policy;
  if (!options.apply) {
    return {
      ...policy,
      action: 'promotion-report-only',
      message: `${policy.message} This invocation was report-only.`,
    };
  }
  if (!options.npmToken) {
    return {
      ...policy,
      action: 'promotion-required-no-token',
      message: `${policy.message} NPM_TOKEN was unavailable, so no registry mutation was attempted.`,
    };
  }

  // Re-read immediately before mutation. The shared release-job lock serializes
  // main/13.x publish and reconciliation after interop, preventing a stale
  // maintenance run from moving latest backward without locking long interop jobs.
  const readLatestVersion = options.readLatestVersion ?? defaultReadLatestVersion;
  const latestVersion = readLatestVersion();
  const currentPolicy = resolveLatestPolicy({
    publishedVersion: options.publishedVersion,
    latestVersion,
    publishTag: options.publishTag,
  });
  if (currentPolicy.action !== 'promote-latest-with-credential') return currentPolicy;

  const run = options.run ?? ((command, args) => execFileSync(command, args, { stdio: 'inherit' }));
  run('npm', ['dist-tag', 'add', `${SDK_PACKAGE}@${options.publishedVersion}`, 'latest']);
  return {
    action: 'promoted-latest',
    command: currentPolicy.command,
    message: `Moved npm latest to ${SDK_PACKAGE}@${options.publishedVersion}; the just-in-time registry check still permitted promotion.`,
  };
}

function renderReport({ publishedVersion, publishTag, policy }) {
  return [
    '## npm dist-tag policy',
    '',
    publishedVersion
      ? `Changesets published \`${SDK_PACKAGE}@${publishedVersion}\` under \`${publishTag}\`.`
      : `Changesets did not publish \`${SDK_PACKAGE}\`; no SDK dist-tag action was taken.`,
    '',
    policy.message,
    ...(['promotion-required-no-token', 'promotion-report-only'].includes(policy.action) && policy.command
      ? ['', `Credential-only follow-up: \`${policy.command}\``]
      : []),
    '',
  ].join('\n');
}

function appendReport(output, env) {
  console.log(output);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, output);
}

export function runCli(options = {}) {
  const env = options.env ?? process.env;
  const args = options.args ?? process.argv.slice(2);
  let publishedVersion;
  let publishTag;
  try {
    publishTag = resolvePublishTag(env, options.preStatePath);
    publishedVersion = readPublishedSdkVersion(env.ADCP_PUBLISHED_PACKAGES);
    if (!publishedVersion) {
      appendReport(
        renderReport({
          publishedVersion,
          publishTag,
          policy: { action: 'sdk-not-published', message: 'Only other workspace packages were published.' },
        }),
        env
      );
      return 0;
    }
    const latestVersion = env.ADCP_CURRENT_LATEST || defaultReadLatestVersion();
    const initialPolicy = resolveLatestPolicy({ publishedVersion, latestVersion, publishTag });
    const policy = applyLatestPolicy(initialPolicy, {
      apply: args.includes('--apply'),
      npmToken: env.NPM_TOKEN,
      publishedVersion,
      publishTag,
      readLatestVersion: env.ADCP_CURRENT_LATEST ? () => env.ADCP_CURRENT_LATEST : undefined,
    });
    appendReport(renderReport({ publishedVersion, publishTag, policy }), env);
    if (policy.action === 'promotion-required-no-token') {
      console.error(`::error title=npm latest promotion blocked::${policy.command}`);
      return 1;
    }
    if (policy.action === 'review-registry-state') {
      console.error('::error title=npm registry state requires review::Refusing to guess a latest-tag mutation.');
      return 1;
    }
    return 0;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const versionText = publishedVersion
      ? `${SDK_PACKAGE}@${publishedVersion} was published under ${publishTag ?? 'the selected npm tag'}, but `
      : '';
    const recovery = publishedVersion
      ? ` Inspect with \`npm view ${SDK_PACKAGE} dist-tags --json\`; if latest is still major 13 and older, run \`npm dist-tag add ${SDK_PACKAGE}@${publishedVersion} latest\`.`
      : '';
    const message = `${versionText}dist-tag reconciliation failed: ${detail}.${recovery}`;
    appendReport(
      renderReport({
        publishedVersion,
        publishTag: publishTag ?? 'unknown',
        policy: { action: 'reconciliation-error', message },
      }),
      env
    );
    console.error(`::error title=npm dist-tag reconciliation failed::${message}`);
    return 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exitCode = runCli();
