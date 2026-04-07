/**
 * Tests for userAgent config threading (issue #427)
 *
 * Verifies that userAgent flows through:
 * 1. PropertyCrawlerConfig → From header on direct fetches, SingleAgentClient headers
 * 2. SingleAgentClientConfig → agent.headers['User-Agent']
 * 3. TestOptions → createTestClient → ADCPMultiAgentClient
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

// Mock fetch globally for PropertyCrawler tests
let originalFetch;

beforeEach(() => {
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('userAgent config', () => {
  describe('PropertyCrawler', () => {
    test('includes custom userAgent in From header when configured', async () => {
      let capturedHeaders = null;

      global.fetch = async (url, options) => {
        capturedHeaders = options?.headers || {};
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({
            authorized_agents: [],
            properties: [
              {
                property_type: 'website',
                name: 'example.com',
                identifiers: [{ type: 'domain', value: 'example.com' }],
              },
            ],
          }),
        };
      };

      const { PropertyCrawler } = require('../../dist/lib/discovery/property-crawler.js');
      const crawler = new PropertyCrawler({
        logLevel: 'silent',
        userAgent: 'AAO-PropertyCrawler/1.0',
      });

      await crawler.fetchAdAgentsJson('example.com');

      assert.ok(capturedHeaders, 'Headers should be captured');
      assert.ok(
        capturedHeaders['From'].startsWith('AAO-PropertyCrawler/1.0 '),
        `From header should start with custom userAgent, got: ${capturedHeaders['From']}`
      );
      assert.ok(
        capturedHeaders['From'].includes('adcp-property-crawler'),
        'From header should still include standard crawler identifier'
      );
    });

    test('From header is unchanged when no userAgent configured', async () => {
      let capturedHeaders = null;

      global.fetch = async (url, options) => {
        capturedHeaders = options?.headers || {};
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({
            authorized_agents: [],
            properties: [],
          }),
        };
      };

      const { PropertyCrawler } = require('../../dist/lib/discovery/property-crawler.js');
      const crawler = new PropertyCrawler({ logLevel: 'silent' });

      await crawler.fetchAdAgentsJson('example.com');

      assert.ok(
        capturedHeaders['From'].startsWith('adcp-property-crawler@'),
        `From header should start with standard identifier, got: ${capturedHeaders['From']}`
      );
    });
  });

  describe('SingleAgentClient', () => {
    test('injects User-Agent header into agent config when userAgent is set', () => {
      const { SingleAgentClient } = require('../../dist/lib/core/SingleAgentClient.js');

      const client = new SingleAgentClient(
        {
          id: 'test',
          name: 'Test',
          agent_uri: 'https://agent.example.com/mcp',
          protocol: 'mcp',
        },
        { userAgent: 'AAO-ComplianceCheck/1.0' }
      );

      const agent = client.getAgent();
      assert.strictEqual(
        agent.headers?.['User-Agent'],
        'AAO-ComplianceCheck/1.0',
        'Agent headers should include User-Agent from config'
      );
    });

    test('preserves existing agent headers when injecting User-Agent', () => {
      const { SingleAgentClient } = require('../../dist/lib/core/SingleAgentClient.js');

      const client = new SingleAgentClient(
        {
          id: 'test',
          name: 'Test',
          agent_uri: 'https://agent.example.com/mcp',
          protocol: 'mcp',
          headers: { 'x-api-key': 'my-key' },
        },
        { userAgent: 'AAO-ComplianceCheck/1.0' }
      );

      const agent = client.getAgent();
      assert.strictEqual(agent.headers?.['User-Agent'], 'AAO-ComplianceCheck/1.0');
      assert.strictEqual(agent.headers?.['x-api-key'], 'my-key', 'Existing headers should be preserved');
    });

    test('existing agent User-Agent header takes precedence over config', () => {
      const { SingleAgentClient } = require('../../dist/lib/core/SingleAgentClient.js');

      const client = new SingleAgentClient(
        {
          id: 'test',
          name: 'Test',
          agent_uri: 'https://agent.example.com/mcp',
          protocol: 'mcp',
          headers: { 'User-Agent': 'Agent-Specific/2.0' },
        },
        { userAgent: 'Config-Level/1.0' }
      );

      const agent = client.getAgent();
      assert.strictEqual(
        agent.headers?.['User-Agent'],
        'Agent-Specific/2.0',
        'Per-agent User-Agent should take precedence over config-level userAgent'
      );
    });

    test('does not modify agent headers when no userAgent configured', () => {
      const { SingleAgentClient } = require('../../dist/lib/core/SingleAgentClient.js');

      const client = new SingleAgentClient(
        {
          id: 'test',
          name: 'Test',
          agent_uri: 'https://agent.example.com/mcp',
          protocol: 'mcp',
        },
        {}
      );

      const agent = client.getAgent();
      assert.strictEqual(agent.headers, undefined, 'Headers should remain undefined when no userAgent');
    });
  });

  describe('CRLF validation', () => {
    test('SingleAgentClient rejects userAgent containing CRLF', () => {
      const { SingleAgentClient } = require('../../dist/lib/core/SingleAgentClient.js');

      assert.throws(
        () =>
          new SingleAgentClient(
            { id: 'test', name: 'Test', agent_uri: 'https://agent.example.com/mcp', protocol: 'mcp' },
            { userAgent: 'Evil/1.0\r\nX-Injected: true' }
          ),
        /newline/
      );
    });

    test('SingleAgentClient rejects userAgent containing bare newline', () => {
      const { SingleAgentClient } = require('../../dist/lib/core/SingleAgentClient.js');

      assert.throws(
        () =>
          new SingleAgentClient(
            { id: 'test', name: 'Test', agent_uri: 'https://agent.example.com/mcp', protocol: 'mcp' },
            { userAgent: 'Evil/1.0\nX-Injected: true' }
          ),
        /newline/
      );
    });

    test('PropertyCrawler rejects userAgent containing CRLF', () => {
      const { PropertyCrawler } = require('../../dist/lib/discovery/property-crawler.js');

      assert.throws(
        () => new PropertyCrawler({ logLevel: 'silent', userAgent: 'Evil/1.0\r\nX-Injected: true' }),
        /newline/
      );
    });
  });

  describe('createTestClient', () => {
    test('passes userAgent from TestOptions to the underlying client', () => {
      const { createTestClient } = require('../../dist/lib/testing/client.js');

      // createTestClient returns an AgentClient which wraps SingleAgentClient
      // We verify by checking the agent config it was constructed with
      const client = createTestClient('https://agent.example.com/mcp', 'mcp', {
        userAgent: 'AAO-ComplianceCheck/1.0',
        dry_run: true,
      });

      // The client's getAgent() should reflect the injected User-Agent
      const agent = client.getAgent();
      assert.strictEqual(
        agent.headers?.['User-Agent'],
        'AAO-ComplianceCheck/1.0',
        'Test client agent should have User-Agent from TestOptions.userAgent'
      );
    });

    test('does not inject User-Agent when userAgent option is not set', () => {
      const { createTestClient } = require('../../dist/lib/testing/client.js');

      const client = createTestClient('https://agent.example.com/mcp', 'mcp', {
        dry_run: true,
      });

      const agent = client.getAgent();
      // Headers may have X-Dry-Run but should not have User-Agent
      assert.strictEqual(
        agent.headers?.['User-Agent'],
        undefined,
        'Agent should not have User-Agent header when option is not set'
      );
    });
  });
});
