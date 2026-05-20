// Unit tests for fetchAgentAuthorizationsFromDirectory (#1885 part 2).
//
// Adopts AdCP spec PR adcp#4828 (issue adcp#4823): inverse-lookup endpoint
// `GET /v1/agents/{agent_url}/publishers` against an AAO-compatible
// directory. Tests pin:
//  - URL construction (path encoding, query parameters)
//  - Async iteration across paginated responses
//  - Defensive parsing of counterparty-controlled fields
//  - SSRF-safe transport via the same loopback pattern as PropertyCrawler

// `ssrfSafeFetch` refuses non-https (loopback HTTP) unless the runtime has
// opted in to internal probes. Set BEFORE the SDK loads.
process.env.ADCP_ALLOW_INTERNAL_PROBES = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { fetchAgentAuthorizationsFromDirectory } = require('../../dist/lib/discovery/agent-directory.js');

function startServer(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise(r => server.close(() => r())),
      });
    });
  });
}

function publisherEntry(overrides = {}) {
  return {
    publisher_domain: 'news.example',
    discovery_method: 'direct',
    properties_authorized: 3,
    properties_total: 5,
    status: 'authorized',
    last_verified_at: '2026-05-20T10:00:00Z',
    ...overrides,
  };
}

describe('fetchAgentAuthorizationsFromDirectory — URL construction', () => {
  test('builds GET /v1/agents/{encoded}/publishers with no query params by default', async () => {
    let capturedPath = null;
    const server = await startServer((req, res) => {
      capturedPath = req.url;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          agent_url: 'https://agent.example/mcp',
          directory_indexed_at: '2026-05-20T10:00:00Z',
          publishers: [],
        })
      );
    });
    try {
      const iter = fetchAgentAuthorizationsFromDirectory('https://agent.example/mcp', {
        directoryUrl: server.url,
      });
      await iter.toArray();
      assert.strictEqual(capturedPath, '/v1/agents/' + encodeURIComponent('https://agent.example/mcp') + '/publishers');
    } finally {
      await server.close();
    }
  });

  test('appends since, status, cursor, limit query parameters', async () => {
    let capturedQuery = null;
    const server = await startServer((req, res) => {
      capturedQuery = new URL(req.url, 'http://127.0.0.1').searchParams;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          agent_url: 'https://agent.example/mcp',
          directory_indexed_at: null,
          publishers: [],
        })
      );
    });
    try {
      const iter = fetchAgentAuthorizationsFromDirectory('https://agent.example/mcp', {
        directoryUrl: server.url,
        since: new Date('2026-05-01T00:00:00Z'),
        status: ['authorized', 'revoked'],
        cursor: 'opaque-cursor',
        limit: 50,
      });
      await iter.toArray();
      assert.strictEqual(capturedQuery.get('since'), '2026-05-01T00:00:00.000Z');
      assert.deepStrictEqual(capturedQuery.getAll('status'), ['authorized', 'revoked']);
      assert.strictEqual(capturedQuery.get('cursor'), 'opaque-cursor');
      assert.strictEqual(capturedQuery.get('limit'), '50');
    } finally {
      await server.close();
    }
  });

  test('handles trailing slash on directoryUrl', async () => {
    let capturedPath = null;
    const server = await startServer((req, res) => {
      capturedPath = req.url;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          agent_url: 'a',
          directory_indexed_at: null,
          publishers: [],
        })
      );
    });
    try {
      const iter = fetchAgentAuthorizationsFromDirectory('a', {
        directoryUrl: server.url + '/',
      });
      await iter.toArray();
      assert.strictEqual(capturedPath, '/v1/agents/a/publishers');
    } finally {
      await server.close();
    }
  });
});

describe('fetchAgentAuthorizationsFromDirectory — pagination', () => {
  test('iterator yields entries across multiple pages, transparent cursor handling', async () => {
    const pages = [
      {
        agent_url: 'https://agent.example/mcp',
        directory_indexed_at: '2026-05-20T10:00:00Z',
        publishers: [publisherEntry({ publisher_domain: 'a.example' })],
        next_cursor: 'cursor-1',
      },
      {
        agent_url: 'https://agent.example/mcp',
        directory_indexed_at: '2026-05-20T10:00:00Z',
        publishers: [publisherEntry({ publisher_domain: 'b.example' })],
        next_cursor: 'cursor-2',
      },
      {
        agent_url: 'https://agent.example/mcp',
        directory_indexed_at: '2026-05-20T10:00:00Z',
        publishers: [publisherEntry({ publisher_domain: 'c.example' })],
        next_cursor: null,
      },
    ];
    let pageIndex = 0;
    const cursorsSeen = [];
    const server = await startServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      cursorsSeen.push(url.searchParams.get('cursor'));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(pages[pageIndex++]));
    });
    try {
      const iter = fetchAgentAuthorizationsFromDirectory('https://agent.example/mcp', {
        directoryUrl: server.url,
      });
      const domains = [];
      for await (const entry of iter) domains.push(entry.publisher_domain);
      assert.deepStrictEqual(domains, ['a.example', 'b.example', 'c.example']);
      assert.deepStrictEqual(cursorsSeen, [null, 'cursor-1', 'cursor-2']);
    } finally {
      await server.close();
    }
  });

  test('terminates on absent next_cursor', async () => {
    let requestCount = 0;
    const server = await startServer((_req, res) => {
      requestCount++;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          agent_url: 'a',
          directory_indexed_at: '2026-05-20T10:00:00Z',
          publishers: [publisherEntry()],
          // no next_cursor field at all
        })
      );
    });
    try {
      const iter = fetchAgentAuthorizationsFromDirectory('a', { directoryUrl: server.url });
      const out = await iter.toArray();
      assert.strictEqual(out.length, 1);
      assert.strictEqual(requestCount, 1);
    } finally {
      await server.close();
    }
  });

  test('empty page with next_cursor present continues to next page (iterator state-machine branch)', async () => {
    // The trickiest iterator branch: a page can be empty (no publishers)
    // but still have a non-null next_cursor — the iterator must advance to
    // the next page rather than terminate. The termination check requires
    // BOTH `publishers.length === 0` AND cursor undefined/null.
    const pages = [
      {
        agent_url: 'a',
        directory_indexed_at: '2026-05-20T10:00:00Z',
        publishers: [],
        next_cursor: 'cursor-1',
      },
      {
        agent_url: 'a',
        directory_indexed_at: '2026-05-20T10:00:00Z',
        publishers: [publisherEntry({ publisher_domain: 'late.example' })],
        next_cursor: null,
      },
    ];
    let pageIndex = 0;
    const server = await startServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(pages[pageIndex++]));
    });
    try {
      const iter = fetchAgentAuthorizationsFromDirectory('a', { directoryUrl: server.url });
      const out = await iter.toArray();
      assert.strictEqual(pageIndex, 2, 'iterator MUST advance past empty page when next_cursor is present');
      assert.strictEqual(out.length, 1);
      assert.strictEqual(out[0].publisher_domain, 'late.example');
    } finally {
      await server.close();
    }
  });

  test('terminates on empty first page with null next_cursor', async () => {
    let requestCount = 0;
    const server = await startServer((_req, res) => {
      requestCount++;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          agent_url: 'a',
          directory_indexed_at: null,
          publishers: [],
          next_cursor: null,
        })
      );
    });
    try {
      const iter = fetchAgentAuthorizationsFromDirectory('a', { directoryUrl: server.url });
      const out = await iter.toArray();
      assert.strictEqual(out.length, 0);
      assert.strictEqual(requestCount, 1);
    } finally {
      await server.close();
    }
  });
});

describe('fetchAgentAuthorizationsFromDirectory — parsing', () => {
  test('preserves all spec fields including optional manager_domain and signing_keys_pinned', async () => {
    const server = await startServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          agent_url: 'https://agent.example/mcp',
          directory_indexed_at: '2026-05-20T10:00:00Z',
          publishers: [
            publisherEntry({
              discovery_method: 'authoritative_location',
              manager_domain: 'manager.example',
              signing_keys_pinned: true,
            }),
          ],
        })
      );
    });
    try {
      const iter = fetchAgentAuthorizationsFromDirectory('https://agent.example/mcp', {
        directoryUrl: server.url,
      });
      const [entry] = await iter.toArray();
      assert.strictEqual(entry.discovery_method, 'authoritative_location');
      assert.strictEqual(entry.manager_domain, 'manager.example');
      assert.strictEqual(entry.signing_keys_pinned, true);
    } finally {
      await server.close();
    }
  });

  test('drops malformed publisher entries (defensive, witness-not-translator)', async () => {
    const server = await startServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          agent_url: 'a',
          directory_indexed_at: '2026-05-20T10:00:00Z',
          publishers: [
            publisherEntry({ publisher_domain: 'good.example' }),
            { publisher_domain: 'bad.example' /* missing required fields */ },
            publisherEntry({ status: 'bogus' }),
            // discovery_method !== 'direct' requires manager_domain per schema allOf
            publisherEntry({
              publisher_domain: 'no-manager.example',
              discovery_method: 'authoritative_location',
              // manager_domain intentionally omitted
            }),
            null,
          ],
        })
      );
    });
    try {
      const iter = fetchAgentAuthorizationsFromDirectory('a', { directoryUrl: server.url });
      const out = await iter.toArray();
      assert.strictEqual(out.length, 1);
      assert.strictEqual(out[0].publisher_domain, 'good.example');
    } finally {
      await server.close();
    }
  });

  test('rejects non-JSON-object response', async () => {
    const server = await startServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end('"not an object"');
    });
    try {
      const iter = fetchAgentAuthorizationsFromDirectory('a', { directoryUrl: server.url });
      await assert.rejects(iter.next(), /not a JSON object/);
    } finally {
      await server.close();
    }
  });

  test('rejects response missing agent_url', async () => {
    const server = await startServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ directory_indexed_at: null, publishers: [] }));
    });
    try {
      const iter = fetchAgentAuthorizationsFromDirectory('a', { directoryUrl: server.url });
      await assert.rejects(iter.next(), /missing 'agent_url'/);
    } finally {
      await server.close();
    }
  });

  test('rejects HTTP 4xx/5xx responses', async () => {
    const server = await startServer((_req, res) => {
      res.statusCode = 503;
      res.end('Service Unavailable');
    });
    try {
      const iter = fetchAgentAuthorizationsFromDirectory('a', { directoryUrl: server.url });
      await assert.rejects(iter.next(), /HTTP 503/);
    } finally {
      await server.close();
    }
  });
});

describe('fetchAgentAuthorizationsFromDirectory — argument validation', () => {
  test('throws on missing agentUrl', () => {
    assert.throws(
      () => fetchAgentAuthorizationsFromDirectory('', { directoryUrl: 'https://x' }),
      /agentUrl is required/
    );
  });

  test('throws on missing directoryUrl', () => {
    assert.throws(() => fetchAgentAuthorizationsFromDirectory('a', { directoryUrl: '' }), /directoryUrl is required/);
  });
});

describe('fetchAgentAuthorizationsFromDirectory — toArray drain', () => {
  test('returns empty array for empty directory', async () => {
    const server = await startServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          agent_url: 'a',
          directory_indexed_at: null,
          publishers: [],
        })
      );
    });
    try {
      const iter = fetchAgentAuthorizationsFromDirectory('a', { directoryUrl: server.url });
      const out = await iter.toArray();
      assert.deepStrictEqual(out, []);
    } finally {
      await server.close();
    }
  });
});
