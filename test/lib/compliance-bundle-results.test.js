const { describe, test } = require('node:test');
const assert = require('node:assert');

const { buildComplianceBundleResults } = require('../../dist/lib/testing/compliance/comply.js');

function bundle(...storyboardIds) {
  return {
    ref: { kind: 'specialism', id: 'sales-test', path: '/unused' },
    storyboards: storyboardIds.map(id => ({ id, phases: [{ id: 'test' }] })),
  };
}

function result(storyboardId, overrides = {}) {
  return {
    storyboard_id: storyboardId,
    overall_passed: true,
    passed_count: 1,
    failed_count: 0,
    skipped_count: 0,
    phases: [],
    ...overrides,
  };
}

describe('buildComplianceBundleResults', () => {
  test('fails a multi-storyboard specialism when any storyboard fails', () => {
    const [assessment] = buildComplianceBundleResults(
      [bundle('root', 'secondary')],
      [result('root'), result('secondary', { overall_passed: false, passed_count: 0, failed_count: 1 })]
    );

    assert.deepStrictEqual(assessment, {
      kind: 'specialism',
      id: 'sales-test',
      storyboard_ids: ['root', 'secondary'],
      status: 'failing',
    });
  });

  test('reports partial when selected coverage is unstarted or inapplicable', () => {
    assert.strictEqual(
      buildComplianceBundleResults([bundle('root', 'secondary')], [result('root')])[0].status,
      'partial'
    );
    assert.strictEqual(
      buildComplianceBundleResults([bundle('root', 'secondary')], [result('root')], {
        missingTools: [{ storyboard_id: 'secondary' }],
      })[0].status,
      'partial'
    );
  });

  test('distinguishes wholly untested and wholly not-applicable bundles', () => {
    assert.strictEqual(buildComplianceBundleResults([bundle('root', 'secondary')], [])[0].status, 'untested');
    assert.strictEqual(
      buildComplianceBundleResults([bundle('root', 'secondary')], [], {
        notApplicable: [{ storyboard_id: 'root' }, { storyboard_id: 'secondary' }],
      })[0].status,
      'not_applicable'
    );
  });

  test('reports empty preview placeholder storyboards as untested', () => {
    const previewBundle = bundle('preview-root');
    previewBundle.storyboards[0].phases = [];

    assert.strictEqual(
      buildComplianceBundleResults(
        [previewBundle],
        [result('preview-root', { overall_passed: false, passed_count: 0, skipped_count: 1 })]
      )[0].status,
      'untested'
    );
  });

  test('requires every storyboard to run cleanly before passing', () => {
    assert.strictEqual(
      buildComplianceBundleResults([bundle('root', 'secondary')], [result('root'), result('secondary')])[0].status,
      'passing'
    );
    assert.strictEqual(
      buildComplianceBundleResults([bundle('root')], [result('root', { validations_not_applicable: 1 })])[0].status,
      'partial'
    );
  });

  test('keeps neutral alternative-path skips passing', () => {
    for (const reason of ['peer_branch_taken', 'peer_substituted']) {
      const passingWithPeerSkip = result('root', {
        skipped_count: 1,
        phases: [
          {
            steps: [{ skip: { reason } }],
          },
        ],
      });

      assert.strictEqual(buildComplianceBundleResults([bundle('root')], [passingWithPeerSkip])[0].status, 'passing');
    }
  });

  test('only treats not-applicable skips as neutral inside a successful authored branch set', () => {
    const branchBundle = bundle('root');
    branchBundle.storyboards[0].phases = [{ id: 'auth-choice', branch_set: { id: 'auth', semantics: 'any_of' } }];
    const notApplicableResult = result('root', {
      skipped_count: 1,
      phases: [
        {
          phase_id: 'auth-choice',
          steps: [{ skip: { reason: 'not_applicable' } }],
        },
      ],
    });

    assert.strictEqual(buildComplianceBundleResults([branchBundle], [notApplicableResult])[0].status, 'passing');
    assert.strictEqual(buildComplianceBundleResults([bundle('root')], [notApplicableResult])[0].status, 'partial');
  });

  test('honors an overall pass when an optional phase contains a failed step', () => {
    assert.strictEqual(
      buildComplianceBundleResults(
        [bundle('root')],
        [result('root', { overall_passed: true, passed_count: 1, failed_count: 1 })]
      )[0].status,
      'passing'
    );
  });

  test('reports incomplete coverage without failure evidence as partial', () => {
    assert.strictEqual(
      buildComplianceBundleResults(
        [bundle('root')],
        [result('root', { overall_passed: false, failed_count: 0, skipped_count: 1 })]
      )[0].status,
      'partial'
    );
  });

  test('reports mixed passed and missing-tool coverage as partial', () => {
    const partialResult = result('root', {
      skipped_count: 1,
      phases: [
        {
          steps: [{ skip: { reason: 'missing_tool' } }],
        },
      ],
    });

    assert.strictEqual(buildComplianceBundleResults([bundle('root')], [partialResult])[0].status, 'partial');
  });

  test('reports observation-based checks with no evidence as partial', () => {
    const silentResult = result('root', {
      assertions: [{ passed: true, observation_count: 0 }],
    });

    assert.strictEqual(buildComplianceBundleResults([bundle('root')], [silentResult])[0].status, 'partial');
  });

  test('assigns synthetic conformance failures to their affected bundle', () => {
    assert.strictEqual(
      buildComplianceBundleResults([bundle('root')], [result('root')], {
        failingBundleIds: ['sales-test'],
      })[0].status,
      'failing'
    );
  });
});
