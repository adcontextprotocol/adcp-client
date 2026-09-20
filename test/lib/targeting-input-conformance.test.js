const assert = require('node:assert/strict');
const { test } = require('node:test');

const { applyTargetingInput } = require('../../dist/lib/index.js');
const {
  TARGETING_GEOGRAPHY_CONFORMANCE_VECTORS,
  buildTargetingInputConformanceVectors,
  runTargetingInputConformance,
} = require('../../dist/lib/conformance/index.js');
const { getSchemaDocumentByRef } = require('../../dist/lib/validation/schema-loader.js');

test('targeting conformance generator emits six operation vectors for every schema dimension', () => {
  const dimensions = Object.keys(getSchemaDocumentByRef('core/targeting-input.json').schema.properties);
  const samples = Object.fromEntries(
    dimensions.map(dimension => [
      dimension,
      {
        initialValue: { vector: `initial-${dimension}` },
        replacementValue: { vector: `replacement-${dimension}` },
      },
    ])
  );
  const vectors = buildTargetingInputConformanceVectors(samples);

  assert.equal(vectors.length, dimensions.length * 6);
  for (const dimension of dimensions) {
    assert.deepEqual(
      vectors.filter(vector => vector.dimension === dimension).map(vector => vector.id),
      [
        `create/${dimension}/omitted`,
        `create/${dimension}/null`,
        `create/${dimension}/value`,
        `update/${dimension}/omitted`,
        `update/${dimension}/null`,
        `update/${dimension}/value`,
      ]
    );
  }
});

test('targeting conformance runner checks strict projection, null dispatch, and atomic geography rejection', async () => {
  const dimensionVectors = buildTargetingInputConformanceVectors({
    audience_include: { initialValue: ['audience-old'], replacementValue: ['audience-new'] },
    geo_countries: { initialValue: ['US'], replacementValue: ['US', 'CA'] },
  });
  const vectors = [...dimensionVectors, ...TARGETING_GEOGRAPHY_CONFORMANCE_VECTORS];

  const execute = async vector => {
    if (vector.id.endsWith('reject-incompatible-preserved-regions')) {
      return {
        outcome: 'rejected',
        state: structuredClone(vector.baseline),
        dispatchedInput: structuredClone(vector.input),
      };
    }
    return {
      outcome: 'accepted',
      state: applyTargetingInput(vector.baseline, vector.input),
      dispatchedInput: structuredClone(vector.input),
    };
  };
  const report = await runTargetingInputConformance(vectors, { create: execute, update: execute });

  assert.equal(report.passed, true, JSON.stringify(report.cases.filter(result => !result.passed)));
});

test('targeting conformance runner detects adapters that normalize away null before dispatch', async () => {
  const [vector] = buildTargetingInputConformanceVectors({
    audience_include: { initialValue: ['audience-old'], replacementValue: ['audience-new'] },
  }).filter(candidate => candidate.id.endsWith('/null'));

  const execute = async candidate => ({
    outcome: 'accepted',
    state: applyTargetingInput(candidate.baseline, candidate.input),
    dispatchedInput: {},
  });
  const report = await runTargetingInputConformance([vector], {
    create: execute,
    update: execute,
  });

  assert.equal(report.passed, false);
  assert.match(report.cases[0].failures.join('\n'), /dispatch changed the request overlay/);
});

test('targeting conformance runner invokes distinct create and update seams', async () => {
  const vectors = buildTargetingInputConformanceVectors({
    audience_include: { initialValue: ['audience-old'], replacementValue: ['audience-new'] },
  });
  const invoked = [];
  const execute = operation => async candidate => {
    invoked.push(`${operation}:${candidate.operation}`);
    return {
      outcome: 'accepted',
      state: applyTargetingInput(candidate.baseline, candidate.input),
      dispatchedInput: structuredClone(candidate.input),
    };
  };
  const report = await runTargetingInputConformance(vectors, {
    create: execute('create'),
    update: execute('update'),
  });

  assert.equal(report.passed, true);
  assert.deepEqual(
    invoked,
    vectors.map(vector => `${vector.operation}:${vector.operation}`)
  );
});

test('targeting conformance catches full-replace adapters that clear omitted dimensions', async () => {
  const [vector] = buildTargetingInputConformanceVectors({
    audience_include: { initialValue: ['audience-old'], replacementValue: ['audience-new'] },
    geo_countries: { initialValue: ['US'], replacementValue: ['CA'] },
  }).filter(candidate => candidate.id === 'update/audience_include/omitted');
  const execute = async candidate => ({
    outcome: 'accepted',
    state: candidate.input,
    dispatchedInput: structuredClone(candidate.input),
  });

  const report = await runTargetingInputConformance([vector], { create: execute, update: execute });

  assert.equal(report.passed, false);
  assert.match(report.cases[0].failures.join('\n'), /strict state mismatch/);
});

test('targeting conformance distinguishes rejected create state from atomic update state', async () => {
  const vectors = buildTargetingInputConformanceVectors({
    audience_include: {
      initialValue: ['audience-old'],
      replacementValue: ['audience-new'],
      expectedNullOutcome: 'rejected',
      expectedReplacementOutcome: 'rejected',
    },
  }).filter(candidate => !candidate.id.endsWith('/omitted'));
  const create = async candidate => ({ outcome: 'rejected', state: undefined, dispatchedInput: candidate.input });
  const update = async candidate => ({
    outcome: 'rejected',
    state: structuredClone(candidate.baseline),
    dispatchedInput: candidate.input,
  });

  const report = await runTargetingInputConformance(vectors, { create, update });

  assert.equal(report.passed, true, JSON.stringify(report.cases.filter(result => !result.passed)));
  for (const result of report.cases) {
    assert.deepEqual(
      result.vector.expectedState,
      result.vector.operation === 'create' ? undefined : { audience_include: ['audience-old'] }
    );
  }
});

test('targeting conformance supports canonical readback and rejects nested null state', async () => {
  const [vector] = buildTargetingInputConformanceVectors({
    geo_countries: {
      initialValue: ['US'],
      replacementValue: ['US', 'CA'],
      expectedReplacementValue: ['CA', 'US'],
    },
  }).filter(candidate => candidate.id === 'update/geo_countries/value');
  const execute = async candidate => ({
    outcome: 'accepted',
    state: { geo_countries: ['CA', 'US'], metadata: { leaked: null } },
    dispatchedInput: structuredClone(candidate.input),
  });

  const report = await runTargetingInputConformance(
    [vector],
    { create: execute, update: execute },
    {
      compareState: (observed, expected) => observed?.geo_countries?.join(',') === expected?.geo_countries?.join(','),
    }
  );

  assert.equal(report.passed, false);
  assert.match(report.cases[0].failures.join('\n'), /retained a request-only null command/);
});

test('targeting conformance refuses an empty corpus', async () => {
  await assert.rejects(
    runTargetingInputConformance([], {
      create: async () => assert.fail('must not run'),
      update: async () => assert.fail('must not run'),
    }),
    /at least one vector/
  );
});
