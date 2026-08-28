const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const {
  getComplianceStoryboardById,
  listAllComplianceStoryboards,
} = require('../../dist/lib/testing/storyboard/index.js');

const CLI = path.resolve(__dirname, '../../bin/adcp.js');

const STORYBOARD_IDS = [
  'media_buy_seller/compact_product_lifecycle',
  'media_buy_seller/compact_direct_buy_lifecycle',
  'media_buy_seller/declined_proposal_execution',
  'media_buy_seller/declined_proposal_refinement',
  'media_buy_seller/expired_proposal_execution',
];

function tasks(storyboard) {
  return storyboard.phases.flatMap(phase => phase.steps.map(step => step.task));
}

function steps(storyboard) {
  return storyboard.phases.flatMap(phase => phase.steps);
}

function assertTerminalError(storyboard, stepId, task, errorCode) {
  const step = steps(storyboard).find(candidate => candidate.id === stepId);
  assert.ok(step, `missing ${storyboard.id}/${stepId}`);
  assert.equal(step.task, task);
  assert.equal(step.expect_error, true, `${storyboard.id}/${stepId} must be a negative path`);
  assert.equal(step.negative_path, 'payload_well_formed');
  assert.ok(
    step.validations?.some(validation => validation.check === 'error_code' && validation.value === errorCode),
    `${storyboard.id}/${stepId} must require ${errorCode}`
  );
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    killSignal: 'SIGKILL',
  });
}

test('the AdCP 3.2 compact proposal lifecycle storyboards ship in the default cache', () => {
  const ids = new Set(listAllComplianceStoryboards().map(storyboard => storyboard.id));

  for (const id of STORYBOARD_IDS) {
    assert.ok(ids.has(id), `missing ${id} from the default compliance cache`);
  }
});

test('the positive proposal lifecycle uses the compact tool sequence without legacy aliases', () => {
  const storyboard = getComplianceStoryboardById('media_buy_seller/compact_product_lifecycle');
  assert.ok(storyboard);

  const businessTasks = tasks(storyboard).filter(task => task !== 'comply_test_controller');
  assert.deepEqual(businessTasks, [
    'list_products',
    'request_proposals',
    'refine_proposals',
    'accept_proposal',
    'control_media_buy',
    'get_media_buys',
  ]);
  assert.ok(!storyboard.required_tools.includes('get_products'));
  assert.ok(!storyboard.required_tools.includes('create_media_buy'));
  assert.ok(!storyboard.required_tools.includes('update_media_buy'));
});

test('the direct-buy lifecycle uses only compact purchase, control, and readback tools', () => {
  const storyboard = getComplianceStoryboardById('media_buy_seller/compact_direct_buy_lifecycle');
  assert.ok(storyboard);

  const businessTasks = tasks(storyboard).filter(task => task !== 'comply_test_controller');
  assert.deepEqual(businessTasks, ['list_products', 'buy_products', 'control_media_buy', 'get_media_buys']);
  assert.ok(!storyboard.required_tools.includes('get_products'));
  assert.ok(!storyboard.required_tools.includes('create_media_buy'));
  assert.ok(!storyboard.required_tools.includes('update_media_buy'));
});

test('both positive lifecycles chain seller-issued revisions into control and readback', () => {
  const proposal = getComplianceStoryboardById('media_buy_seller/compact_product_lifecycle');
  const direct = getComplianceStoryboardById('media_buy_seller/compact_direct_buy_lifecycle');
  assert.ok(proposal);
  assert.ok(direct);

  const proposalSteps = new Map(steps(proposal).map(step => [step.id, step]));
  assert.deepEqual(proposalSteps.get('accept_product_proposal').context_outputs, [
    { key: 'accepted_media_buy_id', name: 'accepted_media_buy_id', path: 'media_buy_id' },
    { key: 'accepted_media_buy_revision', name: 'accepted_media_buy_revision', path: 'revision' },
    { key: 'accepted_media_buy_status', name: 'accepted_media_buy_status', path: 'media_buy_status' },
  ]);
  assert.equal(
    proposalSteps.get('decrease_accepted_proposal_total_budget').sample_request.revision,
    '$context.accepted_media_buy_revision'
  );
  assert.deepEqual(proposalSteps.get('read_controlled_proposal_buy').sample_request.media_buy_ids, [
    '$context.proposal_controlled_media_buy_id',
  ]);

  const directSteps = new Map(steps(direct).map(step => [step.id, step]));
  assert.equal(
    directSteps.get('buy_compact_direct_product').sample_request.feed_version,
    '$context.direct_feed_version'
  );
  assert.equal(
    directSteps.get('cap_compact_direct_buy_daily_budget').sample_request.revision,
    '$context.direct_buy_revision'
  );
  assert.deepEqual(directSteps.get('read_compact_direct_buy').sample_request.media_buy_ids, [
    '$context.controlled_media_buy_id',
  ]);
});

test('decline and expiry storyboards pin exact terminal-state sequences and errors', () => {
  const declinedExecution = getComplianceStoryboardById('media_buy_seller/declined_proposal_execution');
  const declinedRefinement = getComplianceStoryboardById('media_buy_seller/declined_proposal_refinement');
  const expiredExecution = getComplianceStoryboardById('media_buy_seller/expired_proposal_execution');

  assert.ok(declinedExecution);
  assert.ok(declinedRefinement);
  assert.ok(expiredExecution);

  assert.deepEqual(tasks(declinedExecution), [
    'comply_test_controller',
    'request_proposals',
    'refine_proposals',
    'decline_proposals',
    'accept_proposal',
    'create_media_buy',
  ]);
  assert.deepEqual(tasks(declinedRefinement), [
    'comply_test_controller',
    'request_proposals',
    'decline_proposals',
    'refine_proposals',
  ]);
  assert.deepEqual(tasks(expiredExecution), [
    'comply_test_controller',
    'request_proposals',
    'refine_proposals',
    'comply_test_controller',
    'accept_proposal',
    'create_media_buy',
  ]);

  assertTerminalError(declinedExecution, 'accept_declined_proposal', 'accept_proposal', 'INVALID_STATE');
  assertTerminalError(declinedExecution, 'create_buy_from_declined_proposal', 'create_media_buy', 'INVALID_STATE');
  assertTerminalError(declinedRefinement, 'refine_declined_candidate', 'refine_proposals', 'INVALID_STATE');
  assertTerminalError(expiredExecution, 'accept_expired_proposal', 'accept_proposal', 'PROPOSAL_EXPIRED');
  assertTerminalError(expiredExecution, 'create_buy_from_expired_proposal', 'create_media_buy', 'PROPOSAL_EXPIRED');
});

test('every compact lifecycle mutation carries an explicit idempotency key', () => {
  const mutationTasks = new Set([
    'request_proposals',
    'refine_proposals',
    'decline_proposals',
    'buy_products',
    'accept_proposal',
    'control_media_buy',
  ]);

  for (const id of STORYBOARD_IDS) {
    const storyboard = getComplianceStoryboardById(id);
    assert.ok(storyboard);
    for (const phase of storyboard.phases) {
      for (const step of phase.steps) {
        if (!mutationTasks.has(step.task)) continue;
        assert.equal(
          typeof step.sample_request?.idempotency_key,
          'string',
          `${id}/${step.id} must carry idempotency_key`
        );
      }
    }
  }
});

test('the public CLI lists and renders both complete compact lifecycles', () => {
  const listResult = runCli(['storyboard', 'list', '--json']);
  assert.equal(listResult.status, 0, listResult.stderr);
  const listing = JSON.parse(listResult.stdout);
  for (const id of STORYBOARD_IDS.slice(0, 2)) {
    assert.ok(listing.storyboards.some(storyboard => storyboard.id === id));
  }

  const expectedTasks = new Map([
    [
      STORYBOARD_IDS[0],
      [
        'list_products',
        'request_proposals',
        'refine_proposals',
        'accept_proposal',
        'control_media_buy',
        'get_media_buys',
      ],
    ],
    [STORYBOARD_IDS[1], ['list_products', 'buy_products', 'control_media_buy', 'get_media_buys']],
  ]);
  for (const [id, expected] of expectedTasks) {
    const showResult = runCli(['storyboard', 'show', id, '--json']);
    assert.equal(showResult.status, 0, showResult.stderr);
    const detail = JSON.parse(showResult.stdout);
    assert.equal(detail.id, id);
    assert.deepEqual(
      detail.phases
        .flatMap(phase => phase.steps.map(step => step.task))
        .filter(task => task !== 'comply_test_controller'),
      expected
    );
  }
});
