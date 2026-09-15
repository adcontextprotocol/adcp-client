'use strict';

require('tsx/cjs');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  ExistingPlatformTargeting,
  UnsupportedTargetingClearError,
  UnsupportedTargetingDimensionError,
} = require('../../examples/targeting-input-existing-platform.ts');

function harness(clearableDimensions = new Set()) {
  const providerCalls = [];
  const storeCalls = [];
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
      storeCalls.push({ packageId, targeting: structuredClone(targeting) });
      if (targeting === undefined) stored.delete(packageId);
      else stored.set(packageId, structuredClone(targeting));
    },
  };
  return {
    integration: new ExistingPlatformTargeting(provider, store, clearableDimensions),
    providerCalls,
    storeCalls,
    stored,
  };
}

describe('targeting-input existing-platform example', () => {
  it('executes create clears before persisting strict accepted state', async () => {
    const { integration, providerCalls, stored } = harness(new Set(['geo_metros']));

    const accepted = await integration.create(
      'package-1',
      { geo_metros: [{ system: 'nielsen_dma', values: ['501'] }], language: ['en'] },
      { geo_countries: ['US'], geo_metros: null }
    );

    assert.deepEqual(accepted, { language: ['en'], geo_countries: ['US'] });
    assert.deepEqual(providerCalls, [
      {
        packageId: 'package-1',
        operations: [
          { kind: 'set', field: 'countryCodes', value: ['US'] },
          { kind: 'clear', field: 'metroCodes' },
        ],
      },
    ]);
    assert.deepEqual(stored.get('package-1'), { language: ['en'], geo_countries: ['US'] });
    assert.deepEqual(await integration.readback('package-1'), { language: ['en'], geo_countries: ['US'] });
  });

  it('keeps omitted dimensions, replaces values, and removes cleared dimensions', async () => {
    const { integration, providerCalls } = harness(new Set(['geo_countries']));
    await integration.create('package-1', undefined, { geo_countries: ['US'] });

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
    const { integration, providerCalls, storeCalls, stored } = harness();
    await integration.create('package-1', undefined, { geo_countries: ['US'] });
    const callsBeforeRefusal = providerCalls.length;
    const writesBeforeRefusal = storeCalls.length;

    await assert.rejects(
      integration.update('package-1', { geo_countries: null }),
      error =>
        error instanceof UnsupportedTargetingClearError && error.field === 'packages[].targeting_overlay.geo_countries'
    );

    assert.equal(providerCalls.length, callsBeforeRefusal);
    assert.equal(storeCalls.length, writesBeforeRefusal);
    assert.deepEqual(stored.get('package-1'), { geo_countries: ['US'] });
  });

  it('refuses an unmapped dimension before provider or durable-store mutation', async () => {
    const { integration, providerCalls, storeCalls, stored } = harness();

    await assert.rejects(
      integration.create('package-1', undefined, { audience_include: ['audience-1'] }),
      error =>
        error instanceof UnsupportedTargetingDimensionError &&
        error.field === 'purchases[].targeting_overlay.audience_include'
    );

    assert.deepEqual(providerCalls, []);
    assert.deepEqual(storeCalls, []);
    assert.equal(stored.has('package-1'), false);
  });
});
