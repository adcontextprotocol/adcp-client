const { describe, it } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner');
const { parseStoryboard } = require('../../dist/lib/testing/storyboard/loader');

/**
 * Build a minimal http stub that answers every request with the given status
 * and JSON body. Used as the "agent" target so the runner has a deterministic
 * transport response to assert against.
 */
async function startStub(status, body) {
  const server = http.createServer((_, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise(r => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  return { server, url };
}

/**
 * Build a branch-set storyboard with two optional peer phases and a final
 * required assert_contribution phase. `acceptExpectedStatus` / `rejectExpectedStatus`
 * drive which phase's validation will pass against a 500 stub, so the test
 * can choose which branch contributes.
 */
function branchSetStoryboard({ acceptExpectedStatus, rejectExpectedStatus }) {
  return {
    id: 'bs_sb',
    version: '1.0.0',
    title: 'Branch set grading',
    category: 'test',
    summary: '',
    narrative: '',
    agent: { interaction_model: '*', capabilities: [] },
    caller: { role: 'buyer_agent' },
    phases: [
      {
        id: 'past_start_accept',
        title: 'Accept branch',
        optional: true,
        branch_set: { id: 'past_start_handled', semantics: 'any_of' },
        steps: [
          {
            id: 'accept_step',
            title: 'accept',
            task: 'list_creatives',
            auth: 'none',
            expect_error: true,
            contributes_to: 'past_start_handled',
            validations: [
              {
                check: 'http_status',
                value: acceptExpectedStatus,
                description: 'accept branch expects this status',
              },
            ],
          },
        ],
      },
      {
        id: 'past_start_reject',
        title: 'Reject branch',
        optional: true,
        branch_set: { id: 'past_start_handled', semantics: 'any_of' },
        steps: [
          {
            id: 'reject_step',
            title: 'reject',
            task: 'list_creatives',
            auth: 'none',
            expect_error: true,
            contributes_to: 'past_start_handled',
            validations: [
              {
                check: 'http_status',
                value: rejectExpectedStatus,
                description: 'reject branch expects this status',
              },
            ],
          },
        ],
      },
      {
        id: 'gate',
        title: 'gate',
        steps: [
          {
            id: 'assert',
            title: 'assert',
            task: 'assert_contribution',
            validations: [{ check: 'any_of', allowed_values: ['past_start_handled'], description: '' }],
          },
        ],
      },
    ],
  };
}

const runOpts = {
  protocol: 'mcp',
  allow_http: true,
  agentTools: ['list_creatives'],
  _profile: { name: 'T', tools: ['list_creatives'] },
  _client: { getAgentInfo: async () => ({ name: 'T', tools: [{ name: 'list_creatives' }] }) },
};

describe('branch_set any_of: peer_branch_taken grading', () => {
  it('re-grades non-contributing peer failures as skipped with the schema-mandated detail string', async () => {
    const { server, url } = await startStub(500, {});
    try {
      // Accept branch expects 500 → passes, contributes the flag.
      // Reject branch expects 200 → fails; should re-grade as peer_branch_taken.
      const storyboard = branchSetStoryboard({
        acceptExpectedStatus: 500,
        rejectExpectedStatus: 200,
      });
      const result = await runStoryboard(url, storyboard, runOpts);

      const acceptStep = result.phases[0].steps[0];
      const rejectStep = result.phases[1].steps[0];

      assert.strictEqual(acceptStep.passed, true, 'accept branch contributes');
      assert.notStrictEqual(acceptStep.skipped, true);

      assert.strictEqual(rejectStep.skipped, true, 'reject branch re-graded to skipped');
      assert.strictEqual(rejectStep.skip_reason, 'peer_branch_taken');
      assert.strictEqual(rejectStep.skip.reason, 'peer_branch_taken');
      assert.strictEqual(
        rejectStep.skip.detail,
        'past_start_handled contributed by past_start_accept.accept_step — past_start_reject is moot',
        'detail must match the runner-output contract exactly'
      );
      assert.strictEqual(rejectStep.error, undefined, 'residual error string cleared on re-grade');

      assert.strictEqual(result.phases[1].passed, true, 'peer phase with all steps skipped grades passed');
      assert.strictEqual(result.phases[2].passed, true, 'gate passes via accumulated flag');
      assert.strictEqual(result.overall_passed, true);
      assert.strictEqual(result.failed_count, 0);
    } finally {
      server.close();
    }
  });

  it('leaves failures as failed when NO peer contributes (assert_contribution must be the single failure signal)', async () => {
    const { server, url } = await startStub(500, {});
    try {
      // Both branches expect 200 → both fail → nothing contributes → gate fails.
      const storyboard = branchSetStoryboard({
        acceptExpectedStatus: 200,
        rejectExpectedStatus: 200,
      });
      const result = await runStoryboard(url, storyboard, runOpts);

      const acceptStep = result.phases[0].steps[0];
      const rejectStep = result.phases[1].steps[0];
      const gateStep = result.phases[2].steps[0];

      assert.strictEqual(acceptStep.passed, false, 'accept branch failed');
      assert.notStrictEqual(acceptStep.skipped, true, 'not re-graded — no peer took the flag');
      assert.strictEqual(rejectStep.passed, false, 'reject branch failed');
      assert.notStrictEqual(rejectStep.skipped, true, 'not re-graded — no peer took the flag');

      assert.strictEqual(gateStep.passed, false, 'assert_contribution fails when no branch contributed');
      assert.strictEqual(result.overall_passed, false);
    } finally {
      server.close();
    }
  });

  it('wires through the parseStoryboard shorthand — `contributes: true` resolves and grades the same way', async () => {
    const { server, url } = await startStub(500, {});
    try {
      const yaml = `
id: bs_yaml
version: "1.0"
title: Branch set via shorthand
category: test
summary: ""
narrative: ""
agent:
  interaction_model: "*"
  capabilities: []
caller:
  role: buyer_agent
phases:
  - id: accept
    title: Accept
    optional: true
    branch_set:
      id: handled
      semantics: any_of
    steps:
      - id: a
        title: a
        task: list_creatives
        auth: none
        expect_error: true
        contributes: true
        validations:
          - { check: http_status, value: 500, description: "" }
  - id: reject
    title: Reject
    optional: true
    branch_set:
      id: handled
      semantics: any_of
    steps:
      - id: r
        title: r
        task: list_creatives
        auth: none
        expect_error: true
        contributes: true
        validations:
          - { check: http_status, value: 200, description: "" }
  - id: gate
    title: gate
    steps:
      - id: g
        title: g
        task: assert_contribution
        validations:
          - { check: any_of, allowed_values: [handled], description: "" }
`;
      const storyboard = parseStoryboard(yaml);
      // Sanity: shorthand was resolved at parse time.
      assert.strictEqual(storyboard.phases[0].steps[0].contributes_to, 'handled');
      assert.strictEqual(storyboard.phases[1].steps[0].contributes_to, 'handled');

      const result = await runStoryboard(url, storyboard, runOpts);
      assert.strictEqual(result.phases[1].steps[0].skip_reason, 'peer_branch_taken');
      assert.strictEqual(result.phases[1].steps[0].skip.detail, 'handled contributed by accept.a — reject is moot');
      assert.strictEqual(result.overall_passed, true);
    } finally {
      server.close();
    }
  });

  it('implicit detection: storyboard without branch_set declarations still re-grades peers', async () => {
    // Pre-adcp#2646 shape — no `branch_set:` keyword on the phases; runner
    // must infer branch-set membership from the shared `contributes_to`
    // flag + a later any_of assert_contribution. Guarantees existing
    // storyboards in the compliance cache keep working unchanged.
    const { server, url } = await startStub(500, {});
    try {
      const storyboard = {
        id: 'implicit_sb',
        version: '1.0.0',
        title: 'Implicit branch set',
        category: 'test',
        summary: '',
        narrative: '',
        agent: { interaction_model: '*', capabilities: [] },
        caller: { role: 'buyer_agent' },
        phases: [
          {
            id: 'impl_accept',
            title: 'accept',
            optional: true,
            steps: [
              {
                id: 'acc_step',
                title: 'acc',
                task: 'list_creatives',
                auth: 'none',
                expect_error: true,
                contributes_to: 'impl_handled',
                validations: [{ check: 'http_status', value: 500, description: '' }],
              },
            ],
          },
          {
            id: 'impl_reject',
            title: 'reject',
            optional: true,
            steps: [
              {
                id: 'rej_step',
                title: 'rej',
                task: 'list_creatives',
                auth: 'none',
                expect_error: true,
                contributes_to: 'impl_handled',
                validations: [{ check: 'http_status', value: 200, description: '' }],
              },
            ],
          },
          {
            id: 'gate',
            title: 'gate',
            steps: [
              {
                id: 'g',
                title: 'g',
                task: 'assert_contribution',
                validations: [{ check: 'any_of', allowed_values: ['impl_handled'], description: '' }],
              },
            ],
          },
        ],
      };
      const result = await runStoryboard(url, storyboard, runOpts);
      const rejectStep = result.phases[1].steps[0];
      assert.strictEqual(rejectStep.skip_reason, 'peer_branch_taken');
      assert.strictEqual(
        rejectStep.skip.detail,
        'impl_handled contributed by impl_accept.acc_step — impl_reject is moot'
      );
      assert.strictEqual(result.overall_passed, true);
    } finally {
      server.close();
    }
  });

  it('three-peer branch set: one contributes, two fail — both moot peers cite the same contributor', async () => {
    const { server, url } = await startStub(500, {});
    try {
      const phase = (id, stepId, expectedStatus) => ({
        id,
        title: id,
        optional: true,
        branch_set: { id: 'tri_flag', semantics: 'any_of' },
        steps: [
          {
            id: stepId,
            title: stepId,
            task: 'list_creatives',
            auth: 'none',
            expect_error: true,
            contributes_to: 'tri_flag',
            validations: [{ check: 'http_status', value: expectedStatus, description: '' }],
          },
        ],
      });
      const storyboard = {
        id: 'tri_sb',
        version: '1.0.0',
        title: 'three peers',
        category: 'test',
        summary: '',
        narrative: '',
        agent: { interaction_model: '*', capabilities: [] },
        caller: { role: 'buyer_agent' },
        phases: [
          phase('winner', 'w', 500),
          phase('loser_a', 'la', 200),
          phase('loser_b', 'lb', 201),
          {
            id: 'gate',
            title: 'gate',
            steps: [
              {
                id: 'g',
                title: 'g',
                task: 'assert_contribution',
                validations: [{ check: 'any_of', allowed_values: ['tri_flag'], description: '' }],
              },
            ],
          },
        ],
      };
      const result = await runStoryboard(url, storyboard, runOpts);
      const expectedDetail = 'tri_flag contributed by winner.w — ';
      assert.strictEqual(result.phases[1].steps[0].skip_reason, 'peer_branch_taken');
      assert.strictEqual(result.phases[1].steps[0].skip.detail, expectedDetail + 'loser_a is moot');
      assert.strictEqual(result.phases[2].steps[0].skip_reason, 'peer_branch_taken');
      assert.strictEqual(result.phases[2].steps[0].skip.detail, expectedDetail + 'loser_b is moot');
      assert.strictEqual(result.overall_passed, true);
    } finally {
      server.close();
    }
  });

  it('multiple branch sets in one storyboard do not bleed flags across each other', async () => {
    const { server, url } = await startStub(500, {});
    try {
      // Branch set A: accept_a passes (contributes flag_a), reject_a fails.
      // Branch set B: accept_b fails, reject_b passes (contributes flag_b).
      // Each failing peer must cite ITS OWN branch-set contributor — never
      // the other set's.
      const mkPeer = (id, stepId, flag, expectedStatus) => ({
        id,
        title: id,
        optional: true,
        branch_set: { id: flag, semantics: 'any_of' },
        steps: [
          {
            id: stepId,
            title: stepId,
            task: 'list_creatives',
            auth: 'none',
            expect_error: true,
            contributes_to: flag,
            validations: [{ check: 'http_status', value: expectedStatus, description: '' }],
          },
        ],
      });
      const storyboard = {
        id: 'multi_bs_sb',
        version: '1.0.0',
        title: 'multi branch sets',
        category: 'test',
        summary: '',
        narrative: '',
        agent: { interaction_model: '*', capabilities: [] },
        caller: { role: 'buyer_agent' },
        phases: [
          mkPeer('accept_a', 'a_step', 'flag_a', 500),
          mkPeer('reject_a', 'ra_step', 'flag_a', 200),
          mkPeer('accept_b', 'b_step', 'flag_b', 200),
          mkPeer('reject_b', 'rb_step', 'flag_b', 500),
          {
            id: 'gate',
            title: 'gate',
            steps: [
              {
                id: 'gate_a',
                title: 'gate_a',
                task: 'assert_contribution',
                validations: [{ check: 'any_of', allowed_values: ['flag_a'], description: '' }],
              },
              {
                id: 'gate_b',
                title: 'gate_b',
                task: 'assert_contribution',
                validations: [{ check: 'any_of', allowed_values: ['flag_b'], description: '' }],
              },
            ],
          },
        ],
      };
      const result = await runStoryboard(url, storyboard, runOpts);
      assert.strictEqual(
        result.phases[1].steps[0].skip.detail,
        'flag_a contributed by accept_a.a_step — reject_a is moot'
      );
      assert.strictEqual(
        result.phases[2].steps[0].skip.detail,
        'flag_b contributed by reject_b.rb_step — accept_b is moot'
      );
      assert.strictEqual(result.overall_passed, true);
    } finally {
      server.close();
    }
  });

  it('runStoryboard rejects programmatic storyboards that violate branch_set invariants', async () => {
    // Security-review concern: a caller bypassing parseStoryboard must not
    // reach the grading path with spec-drift inputs. The runtime validator
    // mirrors the loader's rules.
    const { server, url } = await startStub(500, {});
    try {
      const bad = {
        id: 'bad_sb',
        version: '1.0.0',
        title: 'bad',
        category: 'test',
        summary: '',
        narrative: '',
        agent: { interaction_model: '*', capabilities: [] },
        caller: { role: 'buyer_agent' },
        phases: [
          {
            id: 'p',
            title: 'P',
            optional: true,
            branch_set: { id: 'flag', semantics: 'all_of' }, // unsupported
            steps: [],
          },
        ],
      };
      await assert.rejects(() => runStoryboard(url, bad, runOpts), /semantics='all_of' is not supported/);
    } finally {
      server.close();
    }
  });

  it('contributes_if that evaluates false suppresses contribution and leaves peer failures raw', async () => {
    // Accept branch's step passes locally but `contributes_if` points at a
    // prior step that failed → contribution is NOT recorded. Reject branch
    // fails. Since no peer contributed the flag, the reject failure must
    // stay raw (not re-graded peer_branch_taken) and the gate must fail —
    // that's the "no_branch_taken" path implementors need to see.
    const { server, url } = await startStub(500, {});
    try {
      const storyboard = {
        id: 'cond_sb',
        version: '1.0.0',
        title: 'contributes_if false',
        category: 'test',
        summary: '',
        narrative: '',
        agent: { interaction_model: '*', capabilities: [] },
        caller: { role: 'buyer_agent' },
        phases: [
          {
            id: 'setup',
            title: 'setup',
            optional: true,
            steps: [
              {
                id: 'doomed_precursor',
                title: 'doomed precursor',
                task: 'list_creatives',
                auth: 'none',
                validations: [{ check: 'http_status', value: 200, description: 'stub is 500' }],
              },
            ],
          },
          {
            id: 'accept',
            title: 'accept',
            optional: true,
            branch_set: { id: 'cond_flag', semantics: 'any_of' },
            steps: [
              {
                id: 'acc',
                title: 'acc',
                task: 'list_creatives',
                auth: 'none',
                expect_error: true,
                contributes_to: 'cond_flag',
                contributes_if: 'prior_step.doomed_precursor.passed',
                validations: [{ check: 'http_status', value: 500, description: '' }],
              },
            ],
          },
          {
            id: 'reject',
            title: 'reject',
            optional: true,
            branch_set: { id: 'cond_flag', semantics: 'any_of' },
            steps: [
              {
                id: 'rej',
                title: 'rej',
                task: 'list_creatives',
                auth: 'none',
                expect_error: true,
                contributes_to: 'cond_flag',
                validations: [{ check: 'http_status', value: 200, description: '' }],
              },
            ],
          },
          {
            id: 'gate',
            title: 'gate',
            steps: [
              {
                id: 'g',
                title: 'g',
                task: 'assert_contribution',
                validations: [{ check: 'any_of', allowed_values: ['cond_flag'], description: '' }],
              },
            ],
          },
        ],
      };
      const result = await runStoryboard(url, storyboard, runOpts);
      const rejectStep = result.phases[2].steps[0];
      assert.strictEqual(rejectStep.passed, false, 'reject branch stays failed — no peer contributed');
      assert.notStrictEqual(rejectStep.skipped, true);
      assert.strictEqual(result.phases[3].steps[0].passed, false, 'gate fails');
      assert.strictEqual(result.overall_passed, false);
    } finally {
      server.close();
    }
  });
});
