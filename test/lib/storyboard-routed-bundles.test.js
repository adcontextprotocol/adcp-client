const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { loadStoryboardFile } = require('../../dist/lib/testing/storyboard/loader.js');
const { resolveBundleOrStoryboard } = require('../../dist/lib/testing/storyboard/compliance.js');
const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner.js');
const { hasAnyRequiredTool } = require('../../dist/lib/testing/storyboard/agent-routing.js');
const { partitionStoryboardsByRequiredTools } = require('../../dist/lib/testing/compliance/comply.js');
const root = path.join(__dirname, '../fixtures/routed-applicability');
const manifest = require('../fixtures/routed-applicability/manifest.json');

const seller = [
  'get_adcp_capabilities',
  'get_products',
  'create_media_buy',
  'sync_creatives',
  'sync_accounts',
  'comply_test_controller',
];
const signals = ['get_adcp_capabilities', 'get_signals', 'activate_signal', 'comply_test_controller'];
const scenarioIds = [
  'media_buy_seller/governance_approved',
  'media_buy_seller/governance_conditions',
  'media_buy_seller/provenance_audit_observation',
  'media_buy_seller/provenance_enforcement',
  'media_buy_seller/provenance_truth_of_claim',
];

for (const version of ['3.1.20', '3.1.23']) {
  describe(`exact ${version} declaration boundary`, () => {
    const storyboards = Object.values(manifest[version]).map(entry => loadStoryboardFile(path.join(root, entry.file)));

    test('preserves every upstream byte and scenario in the regression corpus', () => {
      for (const entry of Object.values(manifest[version])) {
        assert.equal(
          createHash('sha256')
            .update(fs.readFileSync(path.join(root, entry.file)))
            .digest('hex'),
          entry.sha256
        );
      }
      assert.deepEqual(
        storyboards.map(s => s.id),
        ['canonical_format_validate_input', 'billing_gate_dispatch', ...scenarioIds]
      );
      assert.deepEqual(
        storyboards.slice(2).map(s => s.phases.flatMap(p => p.steps).length),
        [5, 5, 4, 6, 3]
      );
    });

    test('suite selection and the shared runner gate preserve any-of and exact skip sets', () => {
      for (const [tools, expected] of [
        [
          seller,
          [
            ...(version === '3.1.20' ? ['canonical_format_validate_input'] : []),
            'billing_gate_dispatch',
            ...scenarioIds,
          ],
        ],
        [
          signals,
          [
            ...(version === '3.1.20' ? ['canonical_format_validate_input', 'billing_gate_dispatch'] : []),
            'media_buy_seller/provenance_audit_observation',
          ],
        ],
        [[], []],
      ]) {
        const suite = partitionStoryboardsByRequiredTools(storyboards, tools);
        assert.deepEqual(
          suite.runnable.map(s => s.id),
          expected
        );
        assert.deepEqual(
          suite.missing.map(s => s.storyboard_id),
          storyboards.map(s => s.id).filter(id => !expected.includes(id))
        );
        assert.deepEqual(
          storyboards.filter(s => hasAnyRequiredTool(s.required_tools, tools)).map(s => s.id),
          expected
        );
      }
    });

    test('canonical IDs and bundle aliases select the same original declarations', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-routed-bundle-'));
      try {
        for (const [name, entry] of Object.entries(manifest[version])) {
          fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
          fs.copyFileSync(path.join(root, entry.file), path.join(dir, name));
        }
        fs.writeFileSync(
          path.join(dir, 'index.json'),
          JSON.stringify({
            adcp_version: version,
            universal: ['canonical-format-validate-input', 'billing-gate-dispatch'],
            protocols: [{ id: 'media-buy', path: 'protocols/media-buy', has_baseline: true }],
            specialisms: [],
          })
        );
        for (const [alias, id] of [
          ['canonical-format-validate-input', 'canonical_format_validate_input'],
          ['billing-gate-dispatch', 'billing_gate_dispatch'],
        ]) {
          const options = { version, complianceDir: dir };
          assert.deepEqual(resolveBundleOrStoryboard(alias, options), resolveBundleOrStoryboard(id, options));
          assert.deepEqual(
            resolveBundleOrStoryboard(alias, options).map(s => s.id),
            [id]
          );
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('full governance/provenance declarations retain the explicit routed seeding boundary', async () => {
      for (const sb of storyboards.slice(2).filter(sb => sb.prerequisites?.controller_seeding === true)) {
        await assert.rejects(
          () =>
            runStoryboard('', sb, {
              adcpVersion: version,
              agents: {
                seller: { url: 'https://seller.example/mcp' },
                governance: { url: 'https://governance.example/mcp' },
              },
              default_agent: 'seller',
            }),
          /agents.*controller_seeding.*not yet supported/
        );
      }
    });

    test('remaining declaration defects cannot be repaired by changing any-of to all-of', () => {
      for (const sb of storyboards.slice(2, 4)) {
        assert.deepEqual(sb.required_tools, ['sync_governance', 'get_products', 'create_media_buy']);
        assert.equal(sb.requires_capability, undefined);
        assert.equal(sb.requires_all_capabilities, undefined);
      }
      for (const sb of storyboards.slice(4)) {
        // These fixture products are the exact origin of the reported
        // /products/0/format_ids rejection after deterministic seed/readback.
        assert.ok(sb.fixtures.products.length > 0);
        assert.ok(sb.fixtures.products.every(product => !Object.hasOwn(product, 'format_ids')));
      }
      // These two scenarios already satisfy all-of on the reporter's seller;
      // their format schema failures cannot be removed by a selector repair.
      assert.ok(storyboards.slice(5).every(sb => sb.required_tools.every(tool => seller.includes(tool))));
    });
  });
}

test('preserves the exact pre-edit +43 step / +4 failure evidence', () => {
  const evidenceDir = path.join(__dirname, '../../docs/development/evidence/routed-agent-7404');
  const evidence = JSON.parse(fs.readFileSync(path.join(evidenceDir, 'reproduction.json'), 'utf8'));
  const reports = evidence.runs.map(run => {
    const archive = fs.readFileSync(path.join(evidenceDir, run.archive));
    assert.equal(createHash('sha256').update(archive).digest('hex'), run.archive_sha256);
    const raw = require('node:zlib').gunzipSync(archive);
    assert.equal(createHash('sha256').update(raw).digest('hex'), run.raw_sha256);
    const report = JSON.parse(raw);
    for (const key of ['total_steps', 'steps_passed', 'steps_failed', 'steps_skipped']) {
      assert.equal(report.summary[key], run.summary[key]);
    }
    return report;
  });
  assert.deepEqual(
    reports.map(r => [r.summary.total_steps, r.summary.steps_failed]),
    [
      [306, 1],
      [349, 5],
      [331, 5],
    ]
  );
  assert.equal(reports[1].summary.total_steps - reports[0].summary.total_steps, 43);
  assert.equal(reports[1].summary.steps_failed - reports[0].summary.steps_failed, 4);
});
