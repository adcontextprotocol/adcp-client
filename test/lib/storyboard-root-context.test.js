const { describe, it } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { runStoryboard, runStoryboardStep } = require('../../dist/lib/testing/storyboard/runner.js');

function buildStoryboard(context = { seed_value: 'root-default' }) {
  return {
    id: 'root_context_sb',
    version: '1.0.0',
    title: 'Root context',
    category: 'compliance',
    summary: '',
    narrative: '',
    agent: { interaction_model: '*', capabilities: [] },
    caller: { role: 'buyer_agent' },
    context,
    phases: [
      {
        id: 'p',
        title: 'root context phase',
        steps: [
          {
            id: 's1',
            title: 'uses root context',
            task: 'get_products',
            auth: 'none',
            sample_request: { brief: '$context.seed_value' },
            validations: [{ check: 'http_status_in', allowed_values: [401], description: '' }],
          },
        ],
      },
    ],
  };
}

const runnerOptions = {
  protocol: 'mcp',
  allow_http: true,
  agentTools: ['get_products'],
  _profile: { name: 'Test', tools: ['get_products'] },
  _client: { getAgentInfo: async () => ({ name: 'Test', tools: [{ name: 'get_products' }] }) },
};

async function startCaptureAgent() {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (rpc.params?.name) {
      seen.push({ name: rpc.params.name, args: rpc.params.arguments });
    }
    res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="x"' });
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, resolve));
  return { server, seen, url: `http://127.0.0.1:${server.address().port}/mcp` };
}

function closeServer(server) {
  return new Promise(resolve => server.close(resolve));
}

describe('runStoryboard: root context seeding', () => {
  it('injects storyboard root context into full-run sample requests', async () => {
    const { server, seen, url } = await startCaptureAgent();
    try {
      await runStoryboard(url, buildStoryboard(), runnerOptions);

      assert.strictEqual(seen.length, 1);
      assert.strictEqual(seen[0].args.brief, 'root-default');
    } finally {
      await closeServer(server);
    }
  });

  it('lets caller-supplied options.context override storyboard root defaults', async () => {
    const { server, seen, url } = await startCaptureAgent();
    try {
      await runStoryboard(url, buildStoryboard(), {
        ...runnerOptions,
        context: { seed_value: 'caller-override' },
      });

      assert.strictEqual(seen.length, 1);
      assert.strictEqual(seen[0].args.brief, 'caller-override');
    } finally {
      await closeServer(server);
    }
  });

  it('injects storyboard root context into single-step sample requests', async () => {
    const { server, seen, url } = await startCaptureAgent();
    try {
      await runStoryboardStep(url, buildStoryboard(), 's1', runnerOptions);

      assert.strictEqual(seen.length, 1);
      assert.strictEqual(seen[0].args.brief, 'root-default');
    } finally {
      await closeServer(server);
    }
  });
});
