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
const {
  validateSameRegistrableDomainRedirect,
  AdAgentsRedirectRefusedError,
} = require('../../dist/lib/discovery/adagents-redirects.js');

/**
 * Start a loopback HTTP server with a per-path response map.
 *
 * @param {Record<string, { status?: number, body?: string, contentType?: string, headers?: Record<string, string> }>} routes
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
        ...(route.headers ?? {}),
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

function startChunkedServer(path, chunks, contentType = 'application/json') {
  return new Promise(resolve => {
    const server = http.createServer(async (req, res) => {
      if (req.url !== path) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType });
      for (const chunk of chunks) {
        res.write(chunk);
        await new Promise(r => setImmediate(r));
      }
      res.end();
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

function assertRedirectAllowed(originUrl, currentUrl, nextUrl) {
  assert.doesNotThrow(() => validateSameRegistrableDomainRedirect(originUrl, currentUrl, nextUrl));
}

function assertRedirectRefused(originUrl, currentUrl, nextUrl, code) {
  assert.throws(
    () => validateSameRegistrableDomainRedirect(originUrl, currentUrl, nextUrl),
    err => err instanceof AdAgentsRedirectRefusedError && err.code === code
  );
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
  test('rejects invalid maxBodyBytes values before fetching', async () => {
    await assert.rejects(
      () => validateAdAgents('example.com', { maxBodyBytes: Infinity }),
      /maxBodyBytes must be an integer between 1 and 10485760/
    );
    await assert.rejects(
      () => validateAdAgents('example.com', { maxBodyBytes: 10 * 1024 * 1024 + 1 }),
      /maxBodyBytes must be an integer between 1 and 10485760/
    );
  });

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

  test('managerdomain fallback honors 10 MiB opt-in for large network adagents.json', async () => {
    const largeAdagents = JSON.stringify({
      $schema: 'https://adcontextprotocol.org/schemas/v1/adagents.json',
      authorized_agents: [{ url: 'https://agent.example.com/mcp', authorized_for: 'Programmatic sales' }],
      properties: [
        {
          property_type: 'website',
          name: 'example.com',
          identifiers: [{ type: 'domain', value: 'example.com' }],
        },
      ],
      padding: 'x'.repeat(3 * 1024 * 1024 + 512 * 1024),
    });
    assert.ok(largeAdagents.length > 3.5 * 1024 * 1024, `fixture too small: ${largeAdagents.length}`);

    const manager = await startRoutedServer({
      '/.well-known/adagents.json': { body: largeAdagents },
    });
    const publisher = await startRoutedServer({
      '/ads.txt': {
        body: `MANAGERDOMAIN=${manager.host}\n`,
        contentType: 'text/plain',
      },
    });
    try {
      const defaultResult = await validateAdAgents(publisher.host, {
        urlForDomain: (domain, path) => `http://${domain}${path}`,
      });
      assert.strictEqual(defaultResult.valid, false);
      assert.strictEqual(defaultResult.discovery_method, 'ads_txt_managerdomain');
      assert.ok(
        defaultResult.errors.some(e => e.includes('Response body exceeded 262144 bytes')),
        `expected default body cap failure, got: ${JSON.stringify(defaultResult.errors)}`
      );

      const raisedCapResult = await validateAdAgents(publisher.host, {
        maxBodyBytes: 10 * 1024 * 1024,
        urlForDomain: (domain, path) => `http://${domain}${path}`,
      });
      assert.strictEqual(
        raisedCapResult.valid,
        true,
        `expected raised maxBodyBytes to pass, got errors=${JSON.stringify(raisedCapResult.errors)}`
      );
      assert.strictEqual(raisedCapResult.discovery_method, 'ads_txt_managerdomain');
      assert.strictEqual(raisedCapResult.manager_domain, manager.host);
      assert.ok(raisedCapResult.adagents?.authorized_agents?.length);
    } finally {
      await Promise.all([publisher.close(), manager.close()]);
    }
  });

  test('direct path keeps the 256 KiB default but accepts a valid 3.5 MiB adagents.json with explicit opt-in', async () => {
    const largeAdagents = JSON.stringify({
      $schema: 'https://adcontextprotocol.org/schemas/v1/adagents.json',
      authorized_agents: [{ url: 'https://agent.example.com/mcp', authorized_for: 'Programmatic sales' }],
      properties: [
        {
          property_type: 'website',
          name: 'example.com',
          identifiers: [{ type: 'domain', value: 'example.com' }],
        },
      ],
      padding: 'x'.repeat(3 * 1024 * 1024 + 512 * 1024),
    });
    assert.ok(largeAdagents.length > 3.5 * 1024 * 1024, `fixture too small: ${largeAdagents.length}`);

    const publisher = await startRoutedServer({
      '/.well-known/adagents.json': { body: largeAdagents },
    });
    try {
      const defaultResult = await validateAdAgents(publisher.host, {
        urlForDomain: (domain, path) => `http://${domain}${path}`,
      });
      assert.strictEqual(defaultResult.valid, false);
      assert.strictEqual(defaultResult.discovery_method, 'direct');
      assert.ok(
        defaultResult.errors.some(e => e.includes('Response body exceeded 262144 bytes')),
        `expected default body cap failure, got: ${JSON.stringify(defaultResult.errors)}`
      );

      const optedInResult = await validateAdAgents(publisher.host, {
        maxBodyBytes: 10 * 1024 * 1024,
        urlForDomain: (domain, path) => `http://${domain}${path}`,
      });
      assert.strictEqual(
        optedInResult.valid,
        true,
        `expected 10 MiB maxBodyBytes to pass, got errors=${JSON.stringify(optedInResult.errors)}`
      );
      assert.strictEqual(optedInResult.discovery_method, 'direct');
      assert.ok(optedInResult.adagents?.authorized_agents?.length);
    } finally {
      await publisher.close();
    }
  });

  test('direct path rejects chunked responses over the configured maxBodyBytes while streaming', async () => {
    const publisher = await startChunkedServer('/.well-known/adagents.json', ['{"padding":"', 'x'.repeat(2048), '"}']);
    try {
      const result = await validateAdAgents(publisher.host, {
        maxBodyBytes: 1024,
        urlForDomain: (domain, path) => `http://${domain}${path}`,
      });
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.discovery_method, 'direct');
      assert.ok(
        result.errors.some(e => e.includes('Response body exceeded 1024 bytes')),
        `expected streaming body cap failure, got: ${JSON.stringify(result.errors)}`
      );
    } finally {
      await publisher.close();
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

  test('redirected ads.txt reports an HTTP status, not an adagents redirect refusal', async () => {
    const publisher = await startRoutedServer({
      '/ads.txt': {
        status: 301,
        headers: { Location: '/ads2.txt' },
        contentType: 'text/plain',
      },
      '/ads2.txt': {
        body: 'MANAGERDOMAIN=manager.example\n',
        contentType: 'text/plain',
      },
    });
    try {
      const result = await validateAdAgents(publisher.host, {
        urlForDomain: (domain, path) => `http://${domain}${path}`,
      });
      assert.strictEqual(result.valid, false);
      assert.ok(
        result.errors.some(e => e.includes('ads.txt unavailable: HTTP 301')),
        `expected ads.txt HTTP 301 error, got: ${JSON.stringify(result.errors)}`
      );
      assert.ok(
        result.errors.every(e => !e.includes('authoritative adagents.json')),
        `ads.txt error should not use adagents redirect wording: ${JSON.stringify(result.errors)}`
      );
    } finally {
      await publisher.close();
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

  test('authoritative_location bounce variants caught by normalized cycle check', async () => {
    // Bind the server first so we know its port, then hand-craft a
    // self-pointer with `?x=1` tacked on. Naive string equality would
    // miss this (`http://host/path` vs `http://host/path?x=1`).
    // Origin+path normalization must catch it.
    const http = require('node:http');
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/.well-known/adagents.json')) {
        const port = server.address().port;
        const selfPointer = `http://127.0.0.1:${port}/.well-known/adagents.json?x=1`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ authoritative_location: selfPointer }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const host = `127.0.0.1:${server.address().port}`;
    try {
      const result = await validateAdAgents(host, {
        urlForDomain: (domain, path) => `http://${domain}${path}`,
      });
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.discovery_method, 'authoritative_location');
      assert.ok(
        result.errors.some(e => e.toLowerCase().includes('cycle')),
        `expected cycle error, got: ${JSON.stringify(result.errors)}`
      );
    } finally {
      await new Promise(r => server.close(r));
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

  // ---- #1720 edge-case coverage (review follow-ups) ----

  test('publisher returns 200 + empty body → terminal parse_error on direct path', async () => {
    const publisher = await startRoutedServer({
      '/.well-known/adagents.json': { body: '' },
    });
    try {
      const result = await validateAdAgents(publisher.host, {
        urlForDomain: (domain, path) => `http://${domain}${path}`,
      });
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.discovery_method, 'direct');
      assert.ok(
        result.errors.some(e => e.toLowerCase().includes('invalid json')),
        `expected invalid JSON error, got: ${JSON.stringify(result.errors)}`
      );
    } finally {
      await publisher.close();
    }
  });

  test('manager-domain pointer file with its own authoritative_location is NOT recursed (one hop only)', async () => {
    // Per RFC 4175: "Validators MUST NOT recursively follow managerdomain
    // declarations from the manager domain's own ads.txt." Same principle
    // applies to `authoritative_location` indirection on the manager's
    // adagents.json — we read it as-is, do not chase another hop.
    const downstream = await startRoutedServer({
      '/.well-known/adagents.json': { body: adAgentsJson('https://downstream.example/mcp') },
    });
    const manager = await startRoutedServer({
      // Manager file declares a SECOND-hop pointer. The validator must
      // NOT follow this — the file is consumed as-is.
      '/.well-known/adagents.json': {
        body: JSON.stringify({
          authoritative_location: `http://${downstream.host}/.well-known/adagents.json`,
          authorized_agents: [{ url: 'https://manager-agent.example/mcp', authorized_for: 'manager' }],
        }),
      },
    });
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
      assert.strictEqual(result.valid, true, `expected valid, got: ${JSON.stringify(result.errors)}`);
      assert.strictEqual(result.discovery_method, 'ads_txt_managerdomain');
      // The result must reflect the MANAGER's file, not the downstream
      // pointed at by manager's authoritative_location.
      assert.strictEqual(result.adagents?.authorized_agents?.[0]?.url, 'https://manager-agent.example/mcp');
    } finally {
      await Promise.all([publisher.close(), manager.close(), downstream.close()]);
    }
  });

  test('manager-domain returns 5xx → terminal failure on managerdomain path', async () => {
    const manager = await startRoutedServer({
      '/.well-known/adagents.json': { status: 503, body: 'maintenance' },
    });
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
      assert.ok(
        result.errors.some(e => e.includes('HTTP 503')),
        `expected HTTP 503 error, got: ${JSON.stringify(result.errors)}`
      );
    } finally {
      await Promise.all([publisher.close(), manager.close()]);
    }
  });

  test('mixed-case publisher domain is lowercased through to result', async () => {
    const publisher = await startRoutedServer({
      '/.well-known/adagents.json': { body: adAgentsJson() },
    });
    try {
      // Pass mixed-case input — `127.0.0.1` doesn't lowercase visibly,
      // but the validator's public_domain field MUST match the
      // lowercased canonical form regardless of caller casing.
      const result = await validateAdAgents(publisher.host.toUpperCase(), {
        urlForDomain: (domain, path) => `http://${domain.toLowerCase()}${path}`,
      });
      // Even if input was 127.0.0.1:PORT (numeric — no case to lose),
      // the result MUST carry the lowercased form.
      assert.strictEqual(result.publisher_domain, publisher.host);
    } finally {
      await publisher.close();
    }
  });
});

describe('validateAdAgents — adagents.json HTTP redirect policy', () => {
  test('well-known redirect policy matches cross-SDK registrable-domain vectors', () => {
    assertRedirectAllowed(
      'https://ladepeche.fr/.well-known/adagents.json',
      'https://ladepeche.fr/.well-known/adagents.json',
      'https://www.ladepeche.fr/.well-known/adagents.json'
    );
    assertRedirectAllowed(
      'https://www.example.com/.well-known/adagents.json',
      'https://www.example.com/.well-known/adagents.json',
      'https://example.com/.well-known/adagents.json'
    );
    assertRedirectAllowed(
      'https://pub.example/.well-known/adagents.json',
      'https://pub.example/.well-known/adagents.json',
      'https://cdn.pub.example/.well-known/adagents.json'
    );
    assertRedirectAllowed(
      'https://example.co.uk/.well-known/adagents.json',
      'https://example.co.uk/.well-known/adagents.json',
      'https://www.example.co.uk/.well-known/adagents.json'
    );
    assertRedirectAllowed(
      'https://victim.github.io/.well-known/adagents.json',
      'https://victim.github.io/.well-known/adagents.json',
      'https://www.victim.github.io/.well-known/adagents.json'
    );

    assertRedirectRefused(
      'https://ladepeche.fr/.well-known/adagents.json',
      'https://ladepeche.fr/.well-known/adagents.json',
      'https://claire.pub/.well-known/adagents.json',
      'redirect_cross_registrable_domain'
    );
    assertRedirectRefused(
      'https://example.co.uk/.well-known/adagents.json',
      'https://example.co.uk/.well-known/adagents.json',
      'https://example.com/.well-known/adagents.json',
      'redirect_cross_registrable_domain'
    );
    assertRedirectRefused(
      'https://victim.github.io/.well-known/adagents.json',
      'https://victim.github.io/.well-known/adagents.json',
      'https://attacker.github.io/.well-known/adagents.json',
      'redirect_cross_registrable_domain'
    );
    assertRedirectRefused(
      'https://pub.example/.well-known/adagents.json',
      'https://www.pub.example/.well-known/adagents.json',
      'https://attacker.example/.well-known/adagents.json',
      'redirect_cross_registrable_domain'
    );
    assertRedirectRefused(
      'https://pub.example/.well-known/adagents.json',
      'https://pub.example/.well-known/adagents.json',
      'http://pub.example/.well-known/adagents.json',
      'redirect_scheme_changed'
    );
  });

  test('initial .well-known fetch follows same-site HTTP redirects', async () => {
    const publisher = await startRoutedServer({
      '/.well-known/adagents.json': {
        status: 301,
        headers: { Location: '/v2/adagents.json' },
      },
      '/v2/adagents.json': { body: adAgentsJson('https://redirected.example/mcp') },
    });
    try {
      const result = await validateAdAgents(publisher.host, {
        urlForDomain: (domain, path) => `http://${domain}${path}`,
      });
      assert.strictEqual(result.valid, true, `expected valid, got errors=${JSON.stringify(result.errors)}`);
      assert.strictEqual(result.discovery_method, 'direct');
      assert.ok(result.resolved_url.endsWith('/v2/adagents.json'), `unexpected resolved_url=${result.resolved_url}`);
      assert.strictEqual(result.adagents?.authorized_agents?.[0]?.url, 'https://redirected.example/mcp');
    } finally {
      await publisher.close();
    }
  });

  test('initial .well-known fetch enforces three redirect hop cap', async () => {
    const publisher = await startRoutedServer({
      '/.well-known/adagents.json': { status: 301, headers: { Location: '/r1' } },
      '/r1': { status: 301, headers: { Location: '/r2' } },
      '/r2': { status: 301, headers: { Location: '/r3' } },
      '/r3': { status: 301, headers: { Location: '/r4' } },
      '/r4': { body: adAgentsJson('https://too-late.example/mcp') },
    });
    try {
      const result = await validateAdAgents(publisher.host, {
        urlForDomain: (domain, path) => `http://${domain}${path}`,
      });
      assert.strictEqual(result.valid, false);
      assert.ok(
        result.errors.some(e => e.includes('Too many adagents.json redirects')),
        `expected hop-cap error, got: ${JSON.stringify(result.errors)}`
      );
    } finally {
      await publisher.close();
    }
  });

  test('authoritative_location dereference refuses any HTTP redirect', async () => {
    const authoritative = await startRoutedServer({
      '/authoritative/adagents.json': {
        status: 301,
        headers: { Location: '/canonical/adagents.json' },
      },
      '/canonical/adagents.json': { body: adAgentsJson('https://must-not-fetch.example/mcp') },
    });
    const publisher = await startRoutedServer({
      '/.well-known/adagents.json': {
        body: JSON.stringify({
          authoritative_location: `${authoritative.url}/authoritative/adagents.json`,
        }),
      },
    });
    try {
      const result = await validateAdAgents(publisher.host, {
        urlForDomain: (domain, path) => `http://${domain}${path}`,
      });
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.discovery_method, 'authoritative_location');
      assert.ok(
        result.errors.some(e => e.includes('Redirect refused while fetching authoritative adagents.json')),
        `expected authoritative redirect refusal, got: ${JSON.stringify(result.errors)}`
      );
    } finally {
      await Promise.all([publisher.close(), authoritative.close()]);
    }
  });

  test('redirect errors reject userinfo and do not echo credentials or query strings', async () => {
    const publisher = await startRoutedServer({
      '/.well-known/adagents.json': {
        status: 301,
        headers: { Location: `http://user:pass@placeholder.invalid/v2/adagents.json?sig=secret123#frag` },
      },
    });
    try {
      const target = `http://user:pass@${publisher.host}/v2/adagents.json?sig=secret123#frag`;
      const result = await validateAdAgents(publisher.host, {
        urlForDomain: (domain, path) => `http://${domain}${path}`,
      });
      assert.strictEqual(result.valid, false);
      assert.ok(
        result.errors.some(e => e.includes('adagents.json redirect must not include userinfo')),
        `expected userinfo refusal, got: ${JSON.stringify(result.errors)}`
      );
      assert.ok(
        result.errors.every(e => !e.includes('user:pass') && !e.includes('sig=secret123')),
        `redirect error leaked sensitive URL parts from ${target}: ${JSON.stringify(result.errors)}`
      );
    } finally {
      await publisher.close();
    }
  });
});
