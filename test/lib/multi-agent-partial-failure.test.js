const { test, describe, beforeEach, mock } = require('node:test');
const assert = require('node:assert');

const { AgentCollection } = require('../../dist/lib/core/ADCPMultiAgentClient.js');

describe('AgentCollection partial failure handling', () => {
  const agent1Config = {
    id: 'agent1',
    name: 'Agent One',
    agent_uri: 'https://agent1.example.com',
    protocol: 'mcp',
  };

  const agent2Config = {
    id: 'agent2',
    name: 'Agent Two',
    agent_uri: 'https://agent2.example.com',
    protocol: 'a2a',
  };

  describe('getProducts with partial failure', () => {
    test('returns results from successful agents when one fails', async () => {
      const collection = new AgentCollection([agent1Config, agent2Config]);
      const clients = collection.getAllAgents();

      const successResult = {
        success: true,
        status: 'completed',
        data: { products: [{ name: 'Product A' }] },
        metadata: {
          taskId: 'task-1',
          taskName: 'get_products',
          agent: { id: 'agent1', name: 'Agent One', protocol: 'mcp' },
          responseTimeMs: 100,
          timestamp: new Date().toISOString(),
          clarificationRounds: 0,
          status: 'completed',
        },
      };

      clients[0].getProducts = mock.fn(async () => successResult);
      clients[1].getProducts = mock.fn(async () => {
        throw new Error('Network timeout');
      });

      const results = await collection.getProducts({ brief: 'test brief' });

      assert.strictEqual(results.length, 2);
      assert.strictEqual(results[0].success, true);
      assert.strictEqual(results[1].success, false);
      assert.deepStrictEqual(results[0].data, { products: [{ name: 'Product A' }] });
    });

    test('failed agent result contains error message', async () => {
      const collection = new AgentCollection([agent1Config, agent2Config]);
      const clients = collection.getAllAgents();

      clients[0].getProducts = mock.fn(async () => ({
        success: true,
        status: 'completed',
        data: { products: [] },
        metadata: {
          taskId: 'task-1',
          taskName: 'get_products',
          agent: { id: 'agent1', name: 'Agent One', protocol: 'mcp' },
          responseTimeMs: 100,
          timestamp: new Date().toISOString(),
          clarificationRounds: 0,
          status: 'completed',
        },
      }));
      clients[1].getProducts = mock.fn(async () => {
        throw new Error('Connection refused');
      });

      const results = await collection.getProducts({ brief: 'test' });

      assert.strictEqual(results[1].success, false);
      assert.strictEqual(results[1].error, 'Connection refused');
    });

    test('failed agent result contains agent metadata', async () => {
      const collection = new AgentCollection([agent1Config, agent2Config]);
      const clients = collection.getAllAgents();

      clients[0].getProducts = mock.fn(async () => ({
        success: true,
        status: 'completed',
        data: { products: [] },
        metadata: {
          taskId: 'task-1',
          taskName: 'get_products',
          agent: { id: 'agent1', name: 'Agent One', protocol: 'mcp' },
          responseTimeMs: 100,
          timestamp: new Date().toISOString(),
          clarificationRounds: 0,
          status: 'completed',
        },
      }));
      clients[1].getProducts = mock.fn(async () => {
        throw new Error('Agent unavailable');
      });

      const results = await collection.getProducts({ brief: 'test' });

      assert.ok(results[1].metadata);
      assert.ok(results[1].metadata.agent);
      assert.strictEqual(results[1].metadata.agent.id, 'agent2');
      assert.strictEqual(results[1].metadata.agent.name, 'Agent Two');
      assert.strictEqual(results[1].metadata.agent.protocol, 'a2a');
      assert.strictEqual(results[1].metadata.status, 'failed');
    });

    test('handles non-Error thrown values', async () => {
      const collection = new AgentCollection([agent1Config]);
      const clients = collection.getAllAgents();

      clients[0].getProducts = mock.fn(async () => {
        throw 'String error message';
      });

      const results = await collection.getProducts({ brief: 'test' });

      assert.strictEqual(results[0].success, false);
      assert.strictEqual(results[0].error, 'String error message');
    });

    test('all agents succeed returns all successful results', async () => {
      const collection = new AgentCollection([agent1Config, agent2Config]);
      const clients = collection.getAllAgents();

      const makeSuccessResult = (agentId, agentName, protocol) => ({
        success: true,
        status: 'completed',
        data: { products: [{ name: `Product from ${agentId}` }] },
        metadata: {
          taskId: `task-${agentId}`,
          taskName: 'get_products',
          agent: { id: agentId, name: agentName, protocol },
          responseTimeMs: 100,
          timestamp: new Date().toISOString(),
          clarificationRounds: 0,
          status: 'completed',
        },
      });

      clients[0].getProducts = mock.fn(async () => makeSuccessResult('agent1', 'Agent One', 'mcp'));
      clients[1].getProducts = mock.fn(async () => makeSuccessResult('agent2', 'Agent Two', 'a2a'));

      const results = await collection.getProducts({ brief: 'test' });

      assert.strictEqual(results.length, 2);
      assert.strictEqual(results[0].success, true);
      assert.strictEqual(results[1].success, true);
    });

    test('all agents fail returns all failure results', async () => {
      const collection = new AgentCollection([agent1Config, agent2Config]);
      const clients = collection.getAllAgents();

      clients[0].getProducts = mock.fn(async () => {
        throw new Error('Agent 1 error');
      });
      clients[1].getProducts = mock.fn(async () => {
        throw new Error('Agent 2 error');
      });

      const results = await collection.getProducts({ brief: 'test' });

      assert.strictEqual(results.length, 2);
      assert.strictEqual(results[0].success, false);
      assert.strictEqual(results[1].success, false);
      assert.strictEqual(results[0].error, 'Agent 1 error');
      assert.strictEqual(results[1].error, 'Agent 2 error');
    });
  });

  describe('execute() returns PromiseSettledResult array', () => {
    test('execute returns fulfilled result for successful operation', async () => {
      const collection = new AgentCollection([agent1Config]);
      const clients = collection.getAllAgents();

      clients[0].getProducts = mock.fn(async () => ({
        success: true,
        data: { products: [] },
      }));

      const results = await collection.execute(async client => {
        return client.getProducts({ brief: 'test' });
      });

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].status, 'fulfilled');
      assert.ok('value' in results[0]);
      assert.strictEqual(results[0].value.success, true);
    });

    test('execute returns rejected result for throwing operation', async () => {
      const collection = new AgentCollection([agent1Config]);
      const clients = collection.getAllAgents();

      const results = await collection.execute(async () => {
        throw new Error('Custom executor error');
      });

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].status, 'rejected');
      assert.ok('reason' in results[0]);
      assert.strictEqual(results[0].reason.message, 'Custom executor error');
    });

    test('execute returns mixed results for partial failures', async () => {
      const collection = new AgentCollection([agent1Config, agent2Config]);
      const clients = collection.getAllAgents();

      let callCount = 0;
      const results = await collection.execute(async client => {
        callCount++;
        if (client.getAgentId() === 'agent2') {
          throw new Error('Agent 2 failed');
        }
        return { result: 'success', agentId: client.getAgentId() };
      });

      assert.strictEqual(results.length, 2);

      const fulfilled = results.filter(r => r.status === 'fulfilled');
      const rejected = results.filter(r => r.status === 'rejected');

      assert.strictEqual(fulfilled.length, 1);
      assert.strictEqual(rejected.length, 1);

      assert.strictEqual(fulfilled[0].value.result, 'success');
      assert.strictEqual(rejected[0].reason.message, 'Agent 2 failed');
    });
  });
});
