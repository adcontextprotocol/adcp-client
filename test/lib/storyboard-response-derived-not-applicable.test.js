const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { runStoryboard, runStoryboardStep } = require('../../dist/lib/testing/storyboard/runner.js');

function account(id) {
  return {
    account_id: id,
    name: id,
    status: 'active',
    brand: { domain: 'example.com' },
    operator: 'example.com',
    billing: 'operator',
    account_scope: 'brand',
  };
}

function taskResult(data) {
  return {
    success: true,
    status: 'completed',
    data,
    metadata: {
      taskId: 'task-test',
      taskName: 'list_accounts',
      agent: { id: 'test', name: 'Test Agent', protocol: 'mcp' },
      responseTimeMs: 1,
      timestamp: new Date(0).toISOString(),
      clarificationRounds: 0,
    },
  };
}

function createClient(firstPageResponse, syncResponse = { accounts: [] }) {
  const calls = [];
  return {
    calls,
    syncAccounts: async params => {
      calls.push({ tool: 'sync_accounts', params });
      return taskResult(syncResponse);
    },
    getAdcpCapabilities: async params => {
      calls.push({ tool: 'get_adcp_capabilities', params });
      return taskResult({ adcp: { major_versions: [3] }, supported_protocols: ['mcp'] });
    },
    listAccounts: async params => {
      calls.push({ tool: 'list_accounts', params });
      return taskResult(firstPageResponse);
    },
  };
}

function storyboard() {
  return {
    id: 'pagination_integrity_list_accounts',
    version: '1.0.0',
    title: 'Pagination cursor integrity',
    category: 'schema_validation',
    summary: '',
    narrative: '',
    required_tools: ['list_accounts'],
    agent: { interaction_model: 'stateful_preloaded', capabilities: [] },
    caller: { role: 'buyer_agent' },
    phases: [
      {
        id: 'pagination_walk',
        title: 'Walk pages',
        steps: [
          {
            id: 'first_page',
            title: 'First page',
            task: 'list_accounts',
            stateful: true,
            context_outputs: [{ key: 'next_cursor', path: 'pagination.cursor' }],
            sample_request: { pagination: { max_results: 2 } },
            validations: [
              {
                check: 'field_value',
                path: 'pagination.has_more',
                value: true,
                description: 'first page should continue',
              },
              {
                check: 'field_present',
                path: 'pagination.cursor',
                description: 'continuation cursor is present',
              },
            ],
          },
          {
            id: 'terminal_page',
            title: 'Terminal page',
            task: 'list_accounts',
            stateful: true,
            sample_request: { pagination: { cursor: '$context.next_cursor', max_results: 2 } },
            validations: [
              {
                check: 'field_value',
                path: 'pagination.has_more',
                value: false,
                description: 'terminal page should stop',
              },
            ],
          },
        ],
      },
    ],
  };
}

function addThreeAccountSetup(sb) {
  sb.phases.unshift({
    id: 'setup',
    title: 'Setup',
    steps: [
      {
        id: 'sync_three_accounts',
        title: 'Sync three accounts',
        task: 'sync_accounts',
        stateful: true,
        sample_request: {
          accounts: [
            { brand: { domain: 'a.example' } },
            { brand: { domain: 'b.example' } },
            { brand: { domain: 'c.example' } },
          ],
        },
        validations: [{ check: 'field_present', path: 'accounts', description: 'accounts present' }],
      },
    ],
  });
}

async function run(firstPageResponse) {
  const client = createClient(firstPageResponse);
  const result = await runStoryboard('http://127.0.0.1:1/mcp', storyboard(), {
    protocol: 'mcp',
    allow_http: true,
    agentTools: ['list_accounts'],
    _client: client,
    _profile: { name: 'fake', tools: ['list_accounts'], raw_capabilities: {} },
  });
  return { client, result };
}

async function runWithStaleKeyReplacement() {
  const client = createClient({ accounts: [account('acc_1')] });
  const sb = storyboard();
  sb.phases[0].steps.splice(
    1,
    0,
    {
      id: 'replacement_capture',
      title: 'Replacement capture',
      task: 'get_adcp_capabilities',
      stateful: false,
      context_outputs: [{ key: 'next_cursor', path: 'missing.cursor' }],
      sample_request: {},
      validations: [],
    },
    {
      id: 'consumer_after_replacement',
      title: 'Consumer after replacement',
      task: 'list_accounts',
      stateful: true,
      sample_request: { pagination: { cursor: '$context.next_cursor', max_results: 2 } },
      validations: [],
    }
  );
  const result = await runStoryboard('http://127.0.0.1:1/mcp', sb, {
    protocol: 'mcp',
    allow_http: true,
    agentTools: ['get_adcp_capabilities', 'list_accounts'],
    _client: client,
    _profile: { name: 'fake', tools: ['get_adcp_capabilities', 'list_accounts'], raw_capabilities: {} },
  });
  return { client, result };
}

async function runAfterSetup(firstPageResponse, syncResponse) {
  const client = createClient(firstPageResponse, syncResponse);
  const sb = storyboard();
  addThreeAccountSetup(sb);
  const result = await runStoryboard('http://127.0.0.1:1/mcp', sb, {
    protocol: 'mcp',
    allow_http: true,
    agentTools: ['sync_accounts', 'list_accounts'],
    _client: client,
    _profile: { name: 'fake', tools: ['sync_accounts', 'list_accounts'], raw_capabilities: {} },
  });
  return { client, result };
}

describe('response-derived not_applicable pagination gates', () => {
  test('single-page list_accounts response without pagination skips the cursor walk', async () => {
    const { client, result } = await run({ accounts: [account('acc_1')] });

    assert.equal(result.failed_count, 0);
    assert.equal(result.phases[0].passed, true);
    assert.equal(result.skipped_count, 2);
    assert.equal(client.calls.filter(c => c.tool === 'list_accounts').length, 1);

    const [first, terminal] = result.phases[0].steps;
    assert.equal(first.skip_reason, 'not_applicable');
    assert.match(first.skip.detail, /single_page_result: list_accounts response is terminal/);
    assert.deepEqual(first.validations, []);

    assert.equal(terminal.skip_reason, 'not_applicable');
    assert.match(terminal.skip.detail, /single_page_result: list_accounts response is terminal/);
    assert.deepEqual(terminal.validations, []);
  });

  test('has_more=false with trustworthy total_count<=accounts.length skips the cursor walk', async () => {
    const { result } = await run({
      accounts: [account('acc_1'), account('acc_2')],
      pagination: { has_more: false, total_count: 2 },
    });

    const first = result.phases[0].steps[0];
    assert.equal(result.failed_count, 0);
    assert.equal(first.skip_reason, 'not_applicable');
    assert.match(first.skip.detail, /single_page_result/);
  });

  test('short page with total_count above returned accounts does not skip', async () => {
    const { result } = await run({
      accounts: [account('acc_1')],
      pagination: { has_more: false, total_count: 5 },
    });

    const first = result.phases[0].steps[0];
    assert.notEqual(first.skipped, true);
    assert.equal(first.passed, false);
    assert.ok(first.validations.some(v => v.check === 'field_value' && v.passed === false));
  });

  test('has_more=false at max_results without total_count still fails', async () => {
    const { result } = await run({
      accounts: [account('acc_1'), account('acc_2')],
      pagination: { has_more: false },
    });

    const first = result.phases[0].steps[0];
    assert.equal(result.overall_passed, false);
    assert.notEqual(first.skipped, true);
    assert.equal(first.passed, false);
    assert.ok(first.validations.some(v => v.check === 'field_value' && v.passed === false));
  });

  test('short page that still advertises continuation does not skip', async () => {
    const { result } = await run({
      accounts: [account('acc_1')],
      pagination: { has_more: true, cursor: 'next' },
    });

    const first = result.phases[0].steps[0];
    assert.notEqual(first.skipped, true);
    assert.equal(first.passed, true);
  });

  test('short page with malformed pagination object does not skip', async () => {
    const { result } = await run({
      accounts: [account('acc_1')],
      pagination: { cursor: 'next' },
    });

    const first = result.phases[0].steps[0];
    assert.notEqual(first.skipped, true);
    assert.equal(first.passed, false);
    assert.ok(first.validations.some(v => v.check === 'field_value' && v.passed === false));
  });

  test('full-size page without pagination does not prove terminality', async () => {
    const { result } = await run({
      accounts: [account('acc_1'), account('acc_2')],
    });

    const first = result.phases[0].steps[0];
    assert.notEqual(first.skipped, true);
    assert.equal(first.passed, false);
    assert.ok(first.validations.some(v => v.check === 'field_value' && v.passed === false));
  });

  test('three-account setup keeps first-page continuation assertions live', async () => {
    const { result } = await runAfterSetup(
      { accounts: [account('acc_1')] },
      { accounts: [account('acc_1'), account('acc_2'), account('acc_3')] }
    );

    const first = result.phases[1].steps[0];
    assert.notEqual(first.skipped, true);
    assert.equal(first.passed, false);
    assert.ok(first.validations.some(v => v.check === 'field_value' && v.passed === false));
  });

  test('standalone seeded first_page keeps continuation assertions live without prior setup result', async () => {
    const client = createClient({ accounts: [account('acc_1')] });
    const sb = storyboard();
    addThreeAccountSetup(sb);

    const result = await runStoryboardStep('http://127.0.0.1:1/mcp', sb, 'first_page', {
      protocol: 'mcp',
      allow_http: true,
      agentTools: ['sync_accounts', 'list_accounts'],
      _client: client,
      _profile: { name: 'fake', tools: ['sync_accounts', 'list_accounts'], raw_capabilities: {} },
    });

    assert.notEqual(result.skipped, true);
    assert.equal(result.passed, false);
    assert.ok(result.validations.some(v => v.check === 'field_value' && v.passed === false));
  });

  test('runStoryboardStep preserves response-derived skip provenance for cursor consumers', async () => {
    const client = createClient({ accounts: [account('acc_1')] });
    const sb = storyboard();

    const first = await runStoryboardStep('http://127.0.0.1:1/mcp', sb, 'first_page', {
      protocol: 'mcp',
      allow_http: true,
      agentTools: ['list_accounts'],
      _client: client,
      _profile: { name: 'fake', tools: ['list_accounts'], raw_capabilities: {} },
    });

    assert.equal(first.skip_reason, 'not_applicable');
    assert.equal(
      first.response_derived_not_applicable_context_keys.next_cursor,
      'single_page_result: list_accounts response is terminal; cursor-walk not applicable'
    );

    const terminal = await runStoryboardStep('http://127.0.0.1:1/mcp', sb, 'terminal_page', {
      protocol: 'mcp',
      allow_http: true,
      agentTools: ['list_accounts'],
      _client: client,
      _profile: { name: 'fake', tools: ['list_accounts'], raw_capabilities: {} },
      context: first.context,
      response_derived_not_applicable_context_keys: first.response_derived_not_applicable_context_keys,
    });

    assert.equal(terminal.skip_reason, 'not_applicable');
    assert.deepEqual(terminal.validations, []);
    assert.equal(client.calls.filter(c => c.tool === 'list_accounts').length, 1);
  });

  test('reused context key clears stale response-derived not_applicable provenance', async () => {
    const { result } = await runWithStaleKeyReplacement();

    const consumer = result.phases[0].steps.find(s => s.step_id === 'consumer_after_replacement');
    assert.equal(consumer.skip_reason, 'prerequisite_failed');
    assert.equal(consumer.validations[0].check, 'unresolved_substitution');
  });
});
