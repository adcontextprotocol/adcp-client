const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { releaseNotes } = require('./create-package-releases.cjs');

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
