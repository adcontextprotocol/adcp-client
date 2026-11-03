const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');

// Run the identical regression against a previously published build when reproducing a failure.
const dist = process.env.SDK_WEBHOOK_TEST_DIST || path.join(__dirname, '../../dist');
const { executeWebhookAssertionStep } = require(path.join(dist, 'lib/testing/storyboard/webhook-assertions.js'));
const { createWebhookReceiver } = require(path.join(dist, 'lib/testing/storyboard/webhook-receiver.js'));
const { createRunnerVariables } = require(path.join(dist, 'lib/testing/storyboard/context.js'));
const { getSchemaDocumentByRef, withExternalSchemaRoot } = require(path.join(dist, 'lib/validation/schema-loader.js'));
const { ADCP_VERSION } = require(path.join(dist, 'lib/version.js'));

const schemaRef = 'core/mcp-webhook-payload.json';
const envelope = (task_type, result) => ({
  idempotency_key: 'evt_schema_version_0123456789',
  operation_id: 'op_schema_version',
  task_id: 'task_schema_version',
  task_type,
  status: 'completed',
  timestamp: '2026-05-26T09:00:44.582Z',
  result,
});
const legacy = () =>
  envelope('create_media_buy', {
    media_buy_id: 'mb_legacy',
    status: 'pending_creatives',
    packages: [],
    confirmed_at: '2026-05-26T09:00:44.000Z',
    revision: 1,
  });
const current = () =>
  envelope('request_proposals', {
    status: 'completed',
    outcome: 'rejected',
    reason: 'No matching inventory.',
  });

async function grade(body, options = {}, legacyRef = false) {
  const receiver = await createWebhookReceiver();
  try {
    const response = await fetch(`${receiver.base_url}/step/emission/op_schema_version`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.ok, true, `webhook receiver returned ${response.status}`);
    const captured = structuredClone(receiver.all()[0].body);
    const result = await executeWebhookAssertionStep(
      {
        id: 'observe',
        title: 'Observe webhook',
        task: 'expect_webhook',
        timeout_seconds: 1,
        ...(legacyRef ? { response_schema_webhook_ref: schemaRef } : { webhook_payload_schema_ref: schemaRef }),
      },
      'webhooks',
      {},
      [],
      options,
      {
        contributions: new Set(),
        priorStepResults: new Map(),
        priorProbes: new Map(),
        agentUrl: '',
        webhookReceiver: receiver,
        runnerVars: createRunnerVariables({ webhookBase: receiver.base_url }),
      }
    );
    assert.deepEqual(receiver.all()[0].body, captured, 'grading preserves captured seller evidence');
    assert.deepEqual(captured, body);
    return result;
  } finally {
    await receiver.close();
  }
}

function identity(version) {
  return `/schemas/${getSchemaDocumentByRef(schemaRef, version).resolvedVersion}/${schemaRef}`;
}

// Synthetic test roots have their own marker constraint. No released bundle
// is copied, relabeled, or changed to construct these fixtures.
function externalFixture(version) {
  const root = mkdtempSync(path.join(tmpdir(), 'adcp-webhook-schema-'));
  mkdirSync(path.join(root, 'core'));
  writeFileSync(path.join(root, 'index.json'), JSON.stringify({ adcp_version: version }));
  writeFileSync(
    path.join(root, schemaRef),
    JSON.stringify({
      $id: `/schemas/${version}/${schemaRef}`,
      type: 'object',
      properties: { fixture_marker: { const: 'external-root' } },
      required: ['fixture_marker'],
    })
  );
  return root;
}

test('legacy business-status webhooks use the explicitly selected 3.0 schema and exact diagnostic release', async () => {
  const result = await grade(legacy(), { adcpVersion: '3.0' });
  assert.equal(result.passed, true, JSON.stringify(result.validations));
  const validation = result.validations.find(check => check.schema_id);
  assert.match(validation.schema_id, /^\/schemas\/3\.0\.\d+\/core\/mcp-webhook-payload\.json$/);
  assert.equal(validation.schema_id, identity('3.0'));
  assert.equal(validation.schema_url, `https://adcontextprotocol.org${identity('3.0')}`);
});

test('a current proposal webhook passes its selected release and fails the older task-type contract', async () => {
  const accepted = await grade(current(), { adcpVersion: ADCP_VERSION });
  assert.equal(accepted.passed, true, JSON.stringify(accepted.validations));
  const refused = await grade(current(), { adcpVersion: '3.0' });
  assert.equal(refused.passed, false);
  assert.equal(refused.validations[0].schema_id, identity('3.0'));
  assert.ok(refused.validations[0].actual.issues.some(issue => issue.instance_path === '/task_type'));
});

test('incoming version claims cannot downgrade a selected current contract', async () => {
  const result = await grade({ ...legacy(), adcp_version: '3.0' }, { adcpVersion: ADCP_VERSION });
  assert.equal(result.passed, false);
  assert.equal(result.validations[0].schema_id, identity(ADCP_VERSION));
  assert.ok(result.validations[0].actual.issues.some(issue => issue.instance_path === '/result/status'));
});

test('the legacy schema-ref spelling uses the same selected release', async () => {
  const result = await grade(legacy(), { adcpVersion: '3.0' }, true);
  assert.equal(result.passed, true, JSON.stringify(result.validations));
  assert.equal(result.validations.find(check => check.schema_id).schema_id, identity('3.0'));
});

test('an unbundled external fixture supplies its own validator and exact diagnostic identity', async () => {
  const version = '3.0.0-beta.999';
  const root = externalFixture(version);
  try {
    await withExternalSchemaRoot(version, root, async () => {
      const result = await grade({ ...legacy(), fixture_marker: 'external-root' }, { adcpVersion: version });
      assert.equal(result.passed, true, JSON.stringify(result.validations));
      assert.equal(result.validations.find(check => check.schema_id).schema_id, `/schemas/${version}/${schemaRef}`);
      const missingMarker = await grade(legacy(), { adcpVersion: version });
      assert.equal(missingMarker.passed, false);
      assert.ok(missingMarker.validations[0].actual.issues.some(issue => issue.message.includes('fixture_marker')));
    });
    await assert.rejects(() => grade(legacy(), { adcpVersion: version }), /3\.0(?:\.0)?-beta\.999/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a same-version external fixture cannot share the bundled validator cache or leak outside its scope', async () => {
  const root = externalFixture('3.0.25');
  try {
    assert.equal((await grade(legacy(), { adcpVersion: '3.0' })).passed, true);
    await withExternalSchemaRoot('3.0', root, async () => {
      const result = await grade(legacy(), { adcpVersion: '3.0' });
      assert.equal(result.passed, false);
      assert.equal(result.validations[0].schema_id, `/schemas/3.0.25/${schemaRef}`);
      assert.ok(result.validations[0].actual.issues.some(issue => issue.message.includes('fixture_marker')));
    });
    assert.equal((await grade(legacy(), { adcpVersion: '3.0' })).passed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('no selected version preserves the SDK default and sequential runs do not change it', async () => {
  assert.equal((await grade(legacy(), { adcpVersion: '3.0' })).passed, true);
  assert.equal((await grade(legacy(), { adcpVersion: ADCP_VERSION })).passed, false);
  const result = await grade(current());
  assert.equal(result.passed, true, JSON.stringify(result.validations));
  assert.equal(result.validations.find(check => check.schema_id).schema_id, `/schemas/${ADCP_VERSION}/${schemaRef}`);
});
