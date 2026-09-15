'use strict';

require('tsx/cjs');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  ExistingPlatformTargeting,
  UnsupportedTargetingClearError,
} = require('../../examples/targeting-input-existing-platform.ts');

function harness(clearableDimensions = new Set()) {
  const providerCalls = [];
  const stored = new Map();
  const provider = {
    async applyPackageTargeting(packageId, operations) {
      providerCalls.push({ packageId, operations: structuredClone(operations) });
    },
  };
  const store = {
    async readAcceptedTargeting(packageId) {
      return structuredClone(stored.get(packageId));
    },
    async saveAcceptedTargeting(packageId, targeting) {
      if (targeting === undefined) stored.delete(packageId);
      else stored.set(packageId, structuredClone(targeting));
    },
  };
  return {
    integration: new ExistingPlatformTargeting(provider, store, clearableDimensions),
    providerCalls,
    stored,
  };
}

describe('targeting-input existing-platform example', () => {
  it('executes create clears before persisting strict accepted state', async () => {
    const { integration, providerCalls, stored } = harness(new Set(['geo_metros']));

    const accepted = await integration.create('package-1', {
      geo_countries: ['US'],
      geo_metros: null,
    });

    assert.deepEqual(accepted, { geo_countries: ['US'] });
    assert.deepEqual(providerCalls, [
      {
        packageId: 'package-1',
        operations: [
          { kind: 'set', field: 'countryCodes', value: ['US'] },
          { kind: 'clear', field: 'metroCodes' },
        ],
      },
    ]);
    assert.deepEqual(stored.get('package-1'), { geo_countries: ['US'] });
    assert.deepEqual(await integration.readback('package-1'), { geo_countries: ['US'] });
  });

  it('keeps omitted dimensions, replaces values, and removes cleared dimensions', async () => {
    const { integration, providerCalls } = harness(new Set(['geo_countries']));
    await integration.create('package-1', { geo_countries: ['US'] });

    const omitted = await integration.update('package-1', undefined);
    assert.deepEqual(omitted, { geo_countries: ['US'] });
    assert.equal(providerCalls.length, 1, 'omitted targeting must not call the provider');

    const set = await integration.update('package-1', { language: ['fr'] });
    assert.deepEqual(set, { geo_countries: ['US'], language: ['fr'] });
    assert.deepEqual(providerCalls[1], {
      packageId: 'package-1',
      operations: [{ kind: 'set', field: 'languageCodes', value: ['fr'] }],
    });

    const cleared = await integration.update('package-1', { geo_countries: null });
    assert.deepEqual(cleared, { language: ['fr'] });
    assert.deepEqual(providerCalls[2], {
      packageId: 'package-1',
      operations: [{ kind: 'clear', field: 'countryCodes' }],
    });
    assert.deepEqual(await integration.readback('package-1'), { language: ['fr'] });
  });

  it('refuses an unsupported clear before provider or durable-store mutation', async () => {
    const { integration, providerCalls, stored } = harness();
    await integration.create('package-1', { geo_countries: ['US'] });
    const callsBeforeRefusal = providerCalls.length;

    await assert.rejects(
      integration.update('package-1', { geo_countries: null }),
      error =>
        error instanceof UnsupportedTargetingClearError && error.field === 'packages[].targeting_overlay.geo_countries'
    );

    assert.equal(providerCalls.length, callsBeforeRefusal);
    assert.deepEqual(stored.get('package-1'), { geo_countries: ['US'] });
  });
});
