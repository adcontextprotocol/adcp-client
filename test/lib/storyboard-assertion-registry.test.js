/**
 * Storyboard cross-step assertion registry + runner hooks.
 *
 * Covers the registry (register/get/duplicate/unknown-id) and the three
 * runner lifecycle hooks (onStart/onStep/onEnd) end-to-end against a
 * minimal HTTP agent. See adcontextprotocol/adcp#2639.
 */

const { describe, test, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const {
  registerAssertion,
  getAssertion,
  listAssertions,
  clearAssertionRegistry,
  resolveAssertions,
} = require('../../dist/lib/testing/storyboard/assertions.js');
const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner.js');

describe('assertion registry', () => {
  beforeEach(() => clearAssertionRegistry());

  test('register + get returns the registered spec', () => {
    const spec = { id: 'a.one', description: 'one' };
    registerAssertion(spec);
    assert.strictEqual(getAssertion('a.one'), spec);
  });

  test('listAssertions reflects current registrations', () => {
    registerAssertion({ id: 'a.one', description: 'one' });
    registerAssertion({ id: 'a.two', description: 'two' });
    assert.deepStrictEqual(listAssertions().sort(), ['a.one', 'a.two']);
  });

  test('register throws on duplicate id', () => {
    registerAssertion({ id: 'dup', description: 'first' });
    assert.throws(() => registerAssertion({ id: 'dup', description: 'second' }), /already registered/);
  });

  test('register with { override: true } replaces an existing registration', () => {
    const first = { id: 'dup', description: 'first' };
    const second = { id: 'dup', description: 'second (override)' };
    registerAssertion(first);
    assert.strictEqual(getAssertion('dup'), first);
    assert.doesNotThrow(() => registerAssertion(second, { override: true }));
    assert.strictEqual(getAssertion('dup'), second);
  });

  test('register with { override: false } still throws on duplicate', () => {
    registerAssertion({ id: 'dup', description: 'first' });
    assert.throws(
      () => registerAssertion({ id: 'dup', description: 'second' }, { override: false }),
      /already registered/
    );
  });

  test('register with { override: true } on a fresh id registers normally (no prior entry required)', () => {
    const spec = { id: 'fresh', description: 'first registration of this id' };
    assert.doesNotThrow(() => registerAssertion(spec, { override: true }));
    assert.strictEqual(getAssertion('fresh'), spec);
  });

  test('register throws on missing id', () => {
    assert.throws(() => registerAssertion({ description: 'no id' }), /spec\.id is required/);
  });

  test('clearAssertionRegistry removes all registrations', () => {
    registerAssertion({ id: 'a.one', description: 'one' });
    clearAssertionRegistry();
    assert.strictEqual(getAssertion('a.one'), undefined);
    assert.deepStrictEqual(listAssertions(), []);
  });

  test('resolveAssertions returns specs in order, throws on unknown ids listing all missing', () => {
    registerAssertion({ id: 'known.one', description: 'one' });
    registerAssertion({ id: 'known.two', description: 'two' });
    const resolved = resolveAssertions(['known.one', 'known.two']);
    assert.deepStrictEqual(
      resolved.map(s => s.id),
      ['known.one', 'known.two']
    );
    assert.throws(() => resolveAssertions(['known.one', 'missing.a', 'missing.b']), /missing\.a, missing\.b/);
  });

  test('resolveAssertions returns [] on undefined or empty', () => {
    assert.deepStrictEqual(resolveAssertions(undefined), []);
    assert.deepStrictEqual(resolveAssertions([]), []);
  });
});

/**
 * Minimal MCP stub: responds 200 to every tool call with a canned structured
 * response. Lets us drive runStoryboard end-to-end without spinning a real
 * agent — the point here is the runner's assertion plumbing, not the handler.
 */
function startStubAgent() {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const rpcId = rpc.id ?? 1;
    const body = {
      jsonrpc: '2.0',
      id: rpcId,
      result: {
        structuredContent: { ok: true, tool: rpc.params?.name },
        content: [{ type: 'text', text: '{}' }],
      },
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  return new Promise(resolve => {
    server.listen(0, () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/mcp` }));
  });
}

function buildStoryboard({ invariants } = {}) {
  const sb = {
    id: 'assertion_sb',
    version: '1.0.0',
    title: 'Assertion runner hooks',
    category: 'compliance',
    summary: '',
    narrative: '',
    agent: { interaction_model: '*', capabilities: [] },
    caller: { role: 'buyer_agent' },
    phases: [
      {
        id: 'p',
        title: 'steps',
        steps: [
          { id: 's1', title: 'first', task: 'list_creatives', sample_request: { list_id: 'pl-1' } },
          { id: 's2', title: 'second', task: 'list_creatives', sample_request: { list_id: 'pl-2' } },
        ],
      },
    ],
  };
  if (invariants) sb.invariants = invariants;
  return sb;
}

const runnerOptions = {
  protocol: 'mcp',
  allow_http: true,
  agentTools: ['list_creatives'],
  _profile: { name: 'Test', tools: ['list_creatives'] },
  _client: { getAgentInfo: async () => ({ name: 'Test', tools: [{ name: 'list_creatives' }] }) },
};

describe('runStoryboard: assertion hooks', () => {
  beforeEach(() => clearAssertionRegistry());

  it('calls onStart once with a fresh state object per assertion', async () => {
    const startCalls = [];
    registerAssertion({
      id: 'obs.start',
      description: 'observes start',
      onStart(ctx) {
        startCalls.push({ id: 'obs.start', state: ctx.state, agentUrl: ctx.agentUrl });
        ctx.state.initialized = true;
      },
    });
    registerAssertion({
      id: 'obs.start2',
      description: 'second',
      onStart(ctx) {
        startCalls.push({ id: 'obs.start2', state: ctx.state });
      },
    });
    const { server, url } = await startStubAgent();
    try {
      await runStoryboard(url, buildStoryboard({ invariants: ['obs.start', 'obs.start2'] }), runnerOptions);
    } finally {
      server.close();
    }
    assert.strictEqual(startCalls.length, 2);
    assert.strictEqual(startCalls[0].id, 'obs.start');
    assert.strictEqual(startCalls[0].agentUrl, url);
    assert.notStrictEqual(startCalls[0].state, startCalls[1].state, 'each assertion must get its own state object');
  });

  it('calls onStep after every step (including for a 2-step storyboard, twice)', async () => {
    const stepIds = [];
    registerAssertion({
      id: 'obs.step',
      description: 'observes steps',
      onStep(ctx, stepResult) {
        stepIds.push(stepResult.step_id);
        return [];
      },
    });
    const { server, url } = await startStubAgent();
    try {
      await runStoryboard(url, buildStoryboard({ invariants: ['obs.step'] }), runnerOptions);
    } finally {
      server.close();
    }
    assert.deepStrictEqual(stepIds, ['s1', 's2']);
  });

  it('onStep failures flip overall_passed and surface under result.assertions + step.validations', async () => {
    registerAssertion({
      id: 'fail.on.second',
      description: 'fails on the second step',
      onStep(_ctx, stepResult) {
        if (stepResult.step_id === 's2') {
          return [{ passed: false, description: 'step 2 broke the rule', error: 'demo' }];
        }
        return [];
      },
    });
    const { server, url } = await startStubAgent();
    let result;
    try {
      result = await runStoryboard(url, buildStoryboard({ invariants: ['fail.on.second'] }), runnerOptions);
    } finally {
      server.close();
    }
    assert.strictEqual(result.overall_passed, false, 'a failed assertion must flip overall_passed');
    assert.ok(Array.isArray(result.assertions), 'assertions[] must be present on the result');
    const stepFailures = result.assertions.filter(a => !a.passed && a.scope === 'step');
    assert.strictEqual(stepFailures.length, 1);
    assert.strictEqual(stepFailures[0].step_id, 's2');
    assert.strictEqual(stepFailures[0].assertion_id, 'fail.on.second');

    const s2 = result.phases[0].steps.find(s => s.step_id === 's2');
    const asValidation = s2.validations.find(v => v.check === 'assertion');
    assert.ok(asValidation, 'step.validations must carry an assertion-check entry');
    assert.strictEqual(asValidation.passed, false);
    assert.match(asValidation.description, /fail\.on\.second: step 2 broke the rule/);
  });

  it('onEnd failures surface storyboard-scoped and flip overall_passed even with all validations green', async () => {
    registerAssertion({
      id: 'end.only',
      description: 'only runs at end',
      onEnd(_ctx) {
        return [{ passed: false, description: 'global property broke', error: 'seen-twice' }];
      },
    });
    const { server, url } = await startStubAgent();
    let result;
    try {
      result = await runStoryboard(url, buildStoryboard({ invariants: ['end.only'] }), runnerOptions);
    } finally {
      server.close();
    }
    assert.strictEqual(result.overall_passed, false);
    const globals = result.assertions.filter(a => a.scope === 'storyboard');
    assert.strictEqual(globals.length, 1);
    assert.strictEqual(globals[0].step_id, undefined);
    assert.strictEqual(globals[0].assertion_id, 'end.only');
  });

  it('state carries across onStart → onStep → onEnd on the same assertion', async () => {
    let observedEnd = null;
    registerAssertion({
      id: 'state.carrier',
      description: 'tracks state across hooks',
      onStart(ctx) {
        ctx.state.seen = [];
      },
      onStep(ctx, stepResult) {
        ctx.state.seen.push(stepResult.step_id);
        return [];
      },
      onEnd(ctx) {
        observedEnd = ctx.state.seen;
        return [];
      },
    });
    const { server, url } = await startStubAgent();
    try {
      await runStoryboard(url, buildStoryboard({ invariants: ['state.carrier'] }), runnerOptions);
    } finally {
      server.close();
    }
    assert.deepStrictEqual(observedEnd, ['s1', 's2']);
  });

  it('storyboards without `invariants` run unaffected — no assertions on result', async () => {
    registerAssertion({
      id: 'never.fires',
      description: 'should not be invoked',
      onStep() {
        throw new Error('onStep was invoked for a storyboard that did not opt in');
      },
    });
    const { server, url } = await startStubAgent();
    let result;
    try {
      result = await runStoryboard(url, buildStoryboard(), runnerOptions);
    } finally {
      server.close();
    }
    assert.strictEqual(result.assertions, undefined);
  });

  it('unknown assertion id in storyboard.invariants throws at run start', async () => {
    const { server, url } = await startStubAgent();
    try {
      await assert.rejects(
        () => runStoryboard(url, buildStoryboard({ invariants: ['nope.missing'] }), runnerOptions),
        /unregistered assertion.*nope\.missing/
      );
    } finally {
      server.close();
    }
  });

  it('onStep passing results surface but do not change overall_passed vs baseline', async () => {
    registerAssertion({
      id: 'always.passes',
      description: 'always emits a passing assertion',
      onStep(_ctx, stepResult) {
        return [{ passed: true, description: `${stepResult.step_id} ok` }];
      },
    });
    const { server, url } = await startStubAgent();
    let baseline, withAssertion;
    try {
      baseline = await runStoryboard(url, buildStoryboard(), runnerOptions);
      withAssertion = await runStoryboard(url, buildStoryboard({ invariants: ['always.passes'] }), runnerOptions);
    } finally {
      server.close();
    }
    assert.strictEqual(
      withAssertion.overall_passed,
      baseline.overall_passed,
      'passing assertions must not change overall_passed'
    );
    assert.strictEqual(withAssertion.assertions.length, 2);
    assert.ok(withAssertion.assertions.every(a => a.passed));
  });
});
