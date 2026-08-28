const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const YAML = require('yaml');

const COMPLIANCE_ROOT = path.resolve(__dirname, '../../compliance/cache/latest/specialisms');

function loadSpecialism(directory) {
  return YAML.parse(readFileSync(path.join(COMPLIANCE_ROOT, directory, 'index.yaml'), 'utf8'));
}

function steps(storyboard) {
  return storyboard.phases.flatMap(phase => phase.steps);
}

function assertVersionAtLeast(actual, minimum) {
  const parse = value => value.split('.').map(component => Number.parseInt(component, 10));
  const [actualMajor, actualMinor, actualPatch] = parse(actual);
  const [minimumMajor, minimumMinor, minimumPatch] = parse(minimum);
  const actualOrdinal = actualMajor * 1_000_000 + actualMinor * 1_000 + actualPatch;
  const minimumOrdinal = minimumMajor * 1_000_000 + minimumMinor * 1_000 + minimumPatch;
  assert.ok(actualOrdinal >= minimumOrdinal, `expected ${actual} to be at least ${minimum}`);
}

for (const [directory, minimumVersion] of [
  ['sales-non-guaranteed', '1.0.1'],
  ['sales-guaranteed', '1.0.2'],
]) {
  test(`${directory} ships the corrected ungoverned sales baseline`, () => {
    const storyboard = loadSpecialism(directory);
    const storyboardSteps = steps(storyboard);

    assertVersionAtLeast(storyboard.version, minimumVersion);
    assert.ok(!storyboard.required_tools.includes('sync_governance'));
    assert.ok(!storyboardSteps.some(step => step.task === 'sync_governance'));

    let creativesSynced = false;
    let preSyncCreateCount = 0;
    for (const step of storyboardSteps) {
      if (step.task === 'sync_creatives') creativesSynced = true;
      if (step.task !== 'create_media_buy' || creativesSynced) continue;

      preSyncCreateCount += 1;
      for (const mediaPackage of step.sample_request?.packages ?? []) {
        assert.ok(
          !Object.hasOwn(mediaPackage, 'creative_assignments'),
          `${directory}/${step.id} assigns creatives before sync_creatives`
        );
      }
    }

    assert.ok(preSyncCreateCount > 0, `${directory} must exercise a pre-sync create_media_buy`);
  });
}
