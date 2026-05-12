/**
 * Tests for `validateAdAgents` — the ads.txt MANAGERDOMAIN one-hop
 * fallback for `adagents.json` discovery (adcp-client#1717,
 * adcontextprotocol/adcp#4175 / PR #4173).
 *
 * Like discovery-ssrf-policy.test.js, these run against real loopback
 * HTTP servers — `ssrfSafeFetch` uses undici directly and ignores
 * `globalThis.fetch` monkey-patches.
 */

// `ssrfSafeFetch` refuses non-https (loopback HTTP) unless the runtime
// has opted in to internal probes. Set BEFORE the SDK loads so the
// probe-policy module reads the env flag at module-init time.
process.env.ADCP_ALLOW_INTERNAL_PROBES = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { validateAdAgents, parseManagerDomain } = require('../../dist/lib/discovery/validate-adagents.js');

/**
 * Start a loopback HTTP server with a per-path response map.
 *
 * @param {Record<string, { status?: number, body?: string, contentType?: string }>} routes
 *   Map from request path to response config. Unmapped paths → 404.
 */
function startRoutedServer(routes) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const route = routes[req.url];
      if (!route) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }
      res.writeHead(route.status ?? 200, {
        'Content-Type': route.contentType ?? 'application/json',
      });
      res.end(route.body ?? '');
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        host: `127.0.0.1:${port}`,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise(r => server.close(() => r())),
      });
    });
  });
}

function adAgentsJson(agentUrl = 'https://agent.example.com/mcp') {
  return JSON.stringify({
    $schema: 'https://adcontextprotocol.org/schemas/v1/adagents.json',
    authorized_agents: [{ url: agentUrl, authorized_for: 'Programmatic sales' }],
    properties: [
      {
        property_type: 'website',
        name: 'example.com',
        identifiers: [{ type: 'domain', value: 'example.com' }],
      },
    ],
  });
}

describe('parseManagerDomain', () => {
  test('extracts a single MANAGERDOMAIN= directive (case-insensitive key)', () => {
    assert.strictEqual(parseManagerDomain('MANAGERDOMAIN=manager.example'), 'manager.example');
    assert.strictEqual(parseManagerDomain('managerdomain=manager.example'), 'manager.example');
    assert.strictEqual(parseManagerDomain('ManagerDomain=manager.example'), 'manager.example');
  });

  test('rejects the comment form `# managerdomain=...`', () => {
    assert.strictEqual(parseManagerDomain('# managerdomain=manager.example'), undefined);
    assert.strictEqual(parseManagerDomain('   #managerdomain=manager.example'), undefined);
  });

  test('last-wins on duplicate MANAGERDOMAIN entries', () => {
    const adsTxt = ['MANAGERDOMAIN=first.example', 'MANAGERDOMAIN=second.example', 'MANAGERDOMAIN=third.example'].join(
      '\n'
    );
    assert.strictEqual(parseManagerDomain(adsTxt), 'third.example');
  });

  test('ignores `#noagents` opt-out comment on a MANAGERDOMAIN line', () => {
    assert.strictEqual(parseManagerDomain('MANAGERDOMAIN=manager.example #noagents'), undefined);
    assert.strictEqual(parseManagerDomain('MANAGERDOMAIN=manager.example #NoAgents'), undefined);
    // A noagents entry followed by a clean entry: clean one wins.
    const adsTxt = ['MANAGERDOMAIN=skip.example #noagents', 'MANAGERDOMAIN=keep.example'].join('\n');
    assert.strictEqual(parseManagerDomain(adsTxt), 'keep.example');
  });

  test('rejects URL-shaped values (not host tokens)', () => {
    assert.strictEqual(parseManagerDomain('MANAGERDOMAIN=https://manager.example'), undefined);
    assert.strictEqual(parseManagerDomain('MANAGERDOMAIN=//manager.example'), undefined);
    assert.strictEqual(parseManagerDomain('MANAGERDOMAIN=manager.example/path'), undefined);
  });

  test('returns undefined when no eligible directive present', () => {
    assert.strictEqual(parseManagerDomain(''), undefined);
    assert.strictEqual(parseManagerDomain('# nothing relevant'), undefined);
    assert.strictEqual(parseManagerDomain('OWNERDOMAIN=example.com'), undefined);
  });

  test('skips full-line comments and blank lines mixed with directive', () => {
    const adsTxt = ['# header comment', '', 'OWNERDOMAIN=example.com', 'MANAGERDOMAIN=manager.example', ''].join('\n');
    assert.strictEqual(parseManagerDomain(adsTxt), 'manager.example');
  });
});

describe('validateAdAgents — discovery_method', () => {
  test("direct path: publisher hosts its own adagents.json → discovery_method 'direct'", async () => {
    const server = await startRoutedServer({
      '/.well-known/adagents.json': { body: adAgentsJson() },
    });
    try {
      const result = await validateAdAgents(server.host, {
        urlForDomain: (domain, path) => `http://${domain}${path}`,
      });
      assert.strictEqual(result.valid, true, `expected valid, got errors=${JSON.stringify(result.errors)}`);
      assert.strictEqual(result.discovery_method, 'direct');
      assert.strictEqual(result.manager_domain, undefined);
      assert.ok(result.adagents?.authorized_agents?.length, 'adagents.json should be populated');
    } finally {
      await server.close();
    }
  });

  test("authoritative_location pointer → discovery_method 'authoritative_location'", async () => {
    // Manager hosts the real file. Publisher hosts a pointer.
    const manager = await startRoutedServer({
      '/.well-known/adagents.json': { body: adAgentsJson() },
    });
    const publisher = await startRoutedServer({
      '/.well-known/adagents.json': {
        body: JSON.stringify({
          authoritative_location: `http://${manager.host}/.well-known/adagents.json`,
        }),
      },
    });
    try {
      const result = await validateAdAgents(publisher.host, {
        urlForDomain: (domain, path) => `http://${domain}${path}`,
      });
      assert.strictEqual(result.valid, true, `expected valid, got errors=${JSON.stringify(result.errors)}`);
      assert.strictEqual(result.discovery_method, 'authoritative_location');
      assert.ok(result.adagents?.authorized_agents?.length);
    } finally {
      await Promise.all([publisher.close(), manager.close()]);
    }
  });

  test("managerdomain fallback on 404 → discovery_method 'ads_txt_managerdomain', manager_domain populated", async () => {
    // Manager hosts adagents.json; publisher only has ads.txt.
    const manager = await startRoutedServer({
      '/.well-known/adagents.json': { body: adAgentsJson() },
    });
    const publisher = await startRoutedServer({
      '/ads.txt': {
        body: `OWNERDOMAIN=example.com\nMANAGERDOMAIN=${manager.host}\n`,
        contentType: 'text/plain',
      },
      // No `/.well-known/adagents.json` route → 404
    });
    try {
      const result = await validateAdAgents(publisher.host, {
        urlForDomain: (domain, path) => `http://${domain}${path}`,
      });
      assert.strictEqual(result.valid, true, `expected valid, got errors=${JSON.stringify(result.errors)}`);
      assert.strictEqual(result.discovery_method, 'ads_txt_managerdomain');
      assert.strictEqual(result.manager_domain, manager.host);
      assert.ok(result.adagents?.authorized_agents?.length);
    } finally {
      await Promise.all([publisher.close(), manager.close()]);
    }
  });

  test('manager domain 404 → terminal validation failure (not silent pass)', async () => {
    // Manager 404s on adagents.json. Publisher 404s + has ads.txt
    // pointing at it. Validator must surface failure, NOT treat as
    // direct-path missing.
    const manager = await startRoutedServer({});
    const publisher = await startRoutedServer({
      '/ads.txt': {
        body: `MANAGERDOMAIN=${manager.host}\n`,
        contentType: 'text/plain',
      },
    });
    try {
      const result = await validateAdAgents(publisher.host, {
        urlForDomain: (domain, path) => `http://${domain}${path}`,
      });
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.discovery_method, 'ads_txt_managerdomain');
      assert.strictEqual(result.manager_domain, manager.host);
      assert.ok(result.adagents === undefined);
      assert.ok(result.errors.length >= 1, 'expected at least one error message');
    } finally {
      await Promise.all([publisher.close(), manager.close()]);
    }
  });

  test('comment-form `# managerdomain=` in ads.txt is not followed', async () => {
    // Manager hosts a perfectly valid adagents.json. Publisher's ads.txt
    // uses the comment form. We must NOT follow it — validation fails.
    const manager = await startRoutedServer({
      '/.well-known/adagents.json': { body: adAgentsJson() },
    });
    const publisher = await startRoutedServer({
      '/ads.txt': {
        body: `# managerdomain=${manager.host}\n`,
        contentType: 'text/plain',
      },
    });
    try {
      const result = await validateAdAgents(publisher.host, {
        urlForDomain: (domain, path) => `http://${domain}${path}`,
      });
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.discovery_method, 'direct');
      assert.strictEqual(result.manager_domain, undefined);
    } finally {
      await Promise.all([publisher.close(), manager.close()]);
    }
  });

  test('duplicate MANAGERDOMAIN lines → last entry wins', async () => {
    const skip = await startRoutedServer({});
    const keep = await startRoutedServer({
      '/.well-known/adagents.json': { body: adAgentsJson('https://keep.example/mcp') },
    });
    const publisher = await startRoutedServer({
      '/ads.txt': {
        body: `MANAGERDOMAIN=${skip.host}\nMANAGERDOMAIN=${keep.host}\n`,
        contentType: 'text/plain',
      },
    });
    try {
      const result = await validateAdAgents(publisher.host, {
        urlForDomain: (domain, path) => `http://${domain}${path}`,
      });
      assert.strictEqual(result.valid, true, `expected valid, got errors=${JSON.stringify(result.errors)}`);
      assert.strictEqual(result.discovery_method, 'ads_txt_managerdomain');
      assert.strictEqual(result.manager_domain, keep.host);
      // The agent URL proves we used `keep`, not `skip`.
      assert.strictEqual(result.adagents?.authorized_agents?.[0]?.url, 'https://keep.example/mcp');
    } finally {
      await Promise.all([publisher.close(), skip.close(), keep.close()]);
    }
  });

  test('non-404 publisher failure (5xx) does NOT trigger fallback', async () => {
    const manager = await startRoutedServer({
      '/.well-known/adagents.json': { body: adAgentsJson() },
    });
    const publisher = await startRoutedServer({
      '/.well-known/adagents.json': { status: 503, body: 'maintenance' },
      '/ads.txt': {
        body: `MANAGERDOMAIN=${manager.host}\n`,
        contentType: 'text/plain',
      },
    });
    try {
      const result = await validateAdAgents(publisher.host, {
        urlForDomain: (domain, path) => `http://${domain}${path}`,
      });
      assert.strictEqual(result.valid, false);
      // We must stay on the direct path; fallback may only fire on 404.
      assert.strictEqual(result.discovery_method, 'direct');
      assert.strictEqual(result.manager_domain, undefined);
    } finally {
      await Promise.all([publisher.close(), manager.close()]);
    }
  });
});
