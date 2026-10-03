const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { releaseNotes } = require('./create-package-releases.cjs');
const createReleases = require('./create-package-releases.cjs');

test('extracts the requested version without older release notes', () => {
  const changelog = '# Changelog\n\n## 14.1.0\n\n### Minor Changes\n\n- New behavior\n\n## 14.0.0\n\n- Old behavior\n';
  assert.equal(
    releaseNotes(changelog, '14.1.0', 'https://example.com/changelog'),
    '### Minor Changes\n\n- New behavior'
  );
  assert.throws(() => releaseNotes(changelog, '14.2.0', 'https://example.com/changelog'), /Missing changelog/);
});

test('the SDK 14.0 changelog that exceeded GitHub limits becomes a complete-changelog link', () => {
  const changelog = readFileSync(path.resolve(__dirname, '../../CHANGELOG.md'), 'utf8');
  const url = 'https://github.com/adcontextprotocol/adcp-client/blob/%40adcp%2Fsdk%4014.0.0/CHANGELOG.md';
  const notes = releaseNotes(changelog, '14.0.0', url);
  assert.ok(Buffer.byteLength(notes) < 120_000);
  assert.ok(notes.includes(`[complete changelog](${url})`));
});

test('keeps notes at the byte ceiling and bounds multibyte notes', () => {
  const url = 'https://example.com/changelog';
  const atLimit = 'é'.repeat(60_000);
  assert.equal(releaseNotes(`## 1.0.0\n\n${atLimit}`, '1.0.0', url), atLimit);
  assert.match(releaseNotes(`## 1.0.0\n\n${atLimit}é`, '1.0.0', url), /complete changelog/);
});

test('an existing release is skipped before validating stale checkout metadata or reading notes', async () => {
  const info = [];
  let writes = 0;
  await createReleases({
    github: { rest: { repos: { getReleaseByTag: async () => ({}), createRelease: async () => writes++ } } },
    context: { repo: { owner: 'adcontextprotocol', repo: 'adcp-client' } },
    core: { info: message => info.push(message) },
    publishedPackages: [{ name: '@adcp/sdk', version: '0.0.0' }],
    cwd: path.resolve(__dirname, '../..'),
  });
  assert.equal(writes, 0);
  assert.match(info[0], /already exists/);
});

test('creates releases for the actual SDK root and wildcard workspaces', async () => {
  const cwd = path.resolve(__dirname, '../..');
  const metadata = ['package.json', 'packages/reference-renderers/package.json'].map(file =>
    JSON.parse(readFileSync(path.join(cwd, file), 'utf8'))
  );
  const created = [];
  await createReleases({
    github: {
      rest: {
        repos: {
          getReleaseByTag: async () => {
            throw Object.assign(new Error('Not found'), { status: 404 });
          },
          createRelease: async release => created.push(release),
        },
      },
    },
    context: { repo: { owner: 'adcontextprotocol', repo: 'adcp-client' } },
    core: { info: () => {} },
    publishedPackages: metadata.map(({ name, version }) => ({ name, version })),
    cwd,
  });
  assert.deepEqual(
    created.map(release => release.tag_name),
    metadata.map(pkg => `${pkg.name}@${pkg.version}`)
  );
  assert.ok(created.every(release => release.body.length > 0 && Buffer.byteLength(release.body) <= 120_000));
});
