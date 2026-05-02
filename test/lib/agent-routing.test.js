// Per-specialism routing for the storyboard runner (#1066). Covers:
//   - protocol-index build from per-agent capability profiles
//   - multi-claim conflict detection (storyboard-build time, not per-step)
//   - per-step `agent:` override bypasses conflicts
//   - `default_agent` fallback for unmapped tools
//   - entry-guard validation in `runStoryboard()`

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  buildRoutingContextFromProfiles,
  resolveAgentForStep,
  RoutingError,
} = require('../../dist/lib/testing/storyboard/agent-routing.js');
const { runStoryboard } = require('../../dist/lib/testing/storyboard/index.js');

function makeStoryboard(steps) {
  return {
    id: 'test_storyboard',
    title: 'Test',
    phases: [{ id: 'p1', title: 'Phase 1', steps }],
  };
}

function makeProfile(specialisms, supportedProtocols, tools = []) {
  return {
    name: 'mock',
    tools,
    supported_protocols: supportedProtocols,
    specialisms,
  };
}

describe('agent-routing: protocol index + conflict detection', () => {
  test('routes a step to the unique agent that claims its protocol', () => {
    const profiles = new Map([
      ['signals', makeProfile(['signal-marketplace'], ['signals'])],
      ['sales', makeProfile(['sales-non-guaranteed'], ['media_buy'])],
    ]);
    const storyboard = makeStoryboard([
      { id: 's1', title: 'discover signals', task: 'get_signals' },
      { id: 's2', title: 'create buy', task: 'create_media_buy' },
    ]);
    const options = {
      agents: {
        signals: { url: 'https://signals.example/mcp' },
        sales: { url: 'https://sales.example/mcp' },
      },
    };
    const ctx = buildRoutingContextFromProfiles(storyboard, options, profiles);
    assert.strictEqual(resolveAgentForStep(storyboard.phases[0].steps[0], options, ctx), 'signals');
    assert.strictEqual(resolveAgentForStep(storyboard.phases[0].steps[1], options, ctx), 'sales');
  });

  test('throws RoutingError when two agents claim the same protocol and no override', () => {
    const profiles = new Map([
      ['sales-a', makeProfile(['sales-non-guaranteed'], ['media_buy'])],
      ['sales-b', makeProfile(['sales-guaranteed'], ['media_buy'])],
    ]);
    const storyboard = makeStoryboard([{ id: 's1', title: 't', task: 'create_media_buy' }]);
    const options = {
      agents: {
        'sales-a': { url: 'https://a.example/mcp' },
        'sales-b': { url: 'https://b.example/mcp' },
      },
    };
    assert.throws(
      () => buildRoutingContextFromProfiles(storyboard, options, profiles),
      err => err instanceof RoutingError && /create_media_buy.*sales-a.*sales-b/.test(err.message)
    );
  });

  test('per-step `agent:` override resolves multi-claim conflicts at build time', () => {
    const profiles = new Map([
      ['sales-a', makeProfile(['sales-non-guaranteed'], ['media_buy'])],
      ['sales-b', makeProfile(['sales-guaranteed'], ['media_buy'])],
    ]);
    const storyboard = makeStoryboard([{ id: 's1', title: 't', task: 'create_media_buy', agent: 'sales-a' }]);
    const options = {
      agents: {
        'sales-a': { url: 'https://a.example/mcp' },
        'sales-b': { url: 'https://b.example/mcp' },
      },
    };
    const ctx = buildRoutingContextFromProfiles(storyboard, options, profiles);
    assert.strictEqual(resolveAgentForStep(storyboard.phases[0].steps[0], options, ctx), 'sales-a');
  });

  test('falls back to default_agent for unmapped tools (sync_creatives is not in TASK_FEATURE_MAP)', () => {
    const profiles = new Map([
      ['sales', makeProfile(['sales-non-guaranteed'], ['media_buy'])],
      ['creative', makeProfile(['creative-template'], ['creative'])],
    ]);
    const storyboard = makeStoryboard([{ id: 's1', title: 't', task: 'sync_creatives' }]);
    const options = {
      agents: {
        sales: { url: 'https://sales.example/mcp' },
        creative: { url: 'https://creative.example/mcp' },
      },
      default_agent: 'creative',
    };
    const ctx = buildRoutingContextFromProfiles(storyboard, options, profiles);
    assert.strictEqual(resolveAgentForStep(storyboard.phases[0].steps[0], options, ctx), 'creative');
  });

  test('unmapped tool with no default_agent throws RoutingError naming the tool', () => {
    const profiles = new Map([['sales', makeProfile(['sales-non-guaranteed'], ['media_buy'])]]);
    const storyboard = makeStoryboard([{ id: 's1', title: 't', task: 'sync_creatives' }]);
    const options = { agents: { sales: { url: 'https://sales.example/mcp' } } };
    const ctx = buildRoutingContextFromProfiles(storyboard, options, profiles);
    assert.throws(
      () => resolveAgentForStep(storyboard.phases[0].steps[0], options, ctx),
      err => err instanceof RoutingError && /sync_creatives/.test(err.message)
    );
  });

  test('protocol claimed by zero agents falls back to default_agent', () => {
    const profiles = new Map([['sales', makeProfile(['sales-non-guaranteed'], ['media_buy'])]]);
    const storyboard = makeStoryboard([{ id: 's1', title: 't', task: 'get_signals' }]);
    const options = {
      agents: { sales: { url: 'https://sales.example/mcp' } },
      default_agent: 'sales',
    };
    const ctx = buildRoutingContextFromProfiles(storyboard, options, profiles);
    assert.strictEqual(resolveAgentForStep(storyboard.phases[0].steps[0], options, ctx), 'sales');
  });

  test('protocol unclaimed and no default_agent throws RoutingError', () => {
    const profiles = new Map([['sales', makeProfile(['sales-non-guaranteed'], ['media_buy'])]]);
    const storyboard = makeStoryboard([{ id: 's1', title: 't', task: 'get_signals' }]);
    const options = { agents: { sales: { url: 'https://sales.example/mcp' } } };
    const ctx = buildRoutingContextFromProfiles(storyboard, options, profiles);
    assert.throws(
      () => resolveAgentForStep(storyboard.phases[0].steps[0], options, ctx),
      err => err instanceof RoutingError && /signals/.test(err.message)
    );
  });
});

describe('runStoryboard entry guards for `agents` map', () => {
  const okStoryboard = makeStoryboard([{ id: 's1', title: 't', task: 'get_signals' }]);

  test('rejects empty agents map', async () => {
    await assert.rejects(() => runStoryboard('', okStoryboard, { agents: {} }), /agents.*no entries/i);
  });

  test('rejects entry without url', async () => {
    await assert.rejects(
      () =>
        runStoryboard('', okStoryboard, {
          agents: { signals: { url: '' } },
        }),
      /missing.*url/i
    );
  });

  test('rejects default_agent not in map', async () => {
    await assert.rejects(
      () =>
        runStoryboard('', okStoryboard, {
          agents: { signals: { url: 'https://signals.example/mcp' } },
          default_agent: 'missing',
        }),
      /default_agent.*missing.*not a key/i
    );
  });

  test('rejects step.agent not in map', async () => {
    const sb = makeStoryboard([{ id: 's1', title: 't', task: 'get_signals', agent: 'phantom' }]);
    await assert.rejects(
      () =>
        runStoryboard('', sb, {
          agents: { signals: { url: 'https://signals.example/mcp' } },
        }),
      /step "s1".*"phantom".*not in the agents map/i
    );
  });

  test('rejects agents + multi_instance_strategy combination', async () => {
    await assert.rejects(
      () =>
        runStoryboard('', okStoryboard, {
          agents: { signals: { url: 'https://signals.example/mcp' } },
          multi_instance_strategy: 'multi-pass',
        }),
      /agents.*incompatible.*multi_instance_strategy/i
    );
  });

  test('rejects positional URL alongside agents map', async () => {
    await assert.rejects(
      () =>
        runStoryboard('https://primary.example/mcp', okStoryboard, {
          agents: { signals: { url: 'https://signals.example/mcp' } },
        }),
      /pass.*""/i
    );
  });
});
