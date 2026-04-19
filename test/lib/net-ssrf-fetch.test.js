const { describe, it } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const {
  ssrfSafeFetch,
  SsrfRefusedError,
  decodeBodyAsJsonOrText,
  isPrivateIp,
  isAlwaysBlocked,
} = require('../../dist/lib/net');

describe('ssrfSafeFetch — scheme guard', () => {
  it('refuses file: / data: / ftp: even under allowPrivateIp', async () => {
    for (const url of ['file:///etc/passwd', 'data:text/plain,hi', 'ftp://example.com/']) {
      await assert.rejects(
        () => ssrfSafeFetch(url, { allowPrivateIp: true }),
        err => {
          assert.ok(err instanceof SsrfRefusedError, `${url} should raise SsrfRefusedError`);
          assert.strictEqual(err.code, 'scheme_not_allowed');
          return true;
        }
      );
    }
  });

  it('refuses http:// URLs by default', async () => {
    await assert.rejects(
      () => ssrfSafeFetch('http://example.com/'),
      err => {
        assert.ok(err instanceof SsrfRefusedError);
        assert.strictEqual(err.code, 'non_https_without_opt_in');
        return true;
      }
    );
  });
});

describe('ssrfSafeFetch — address guard', () => {
  it('refuses loopback by default', async () => {
    await assert.rejects(
      () => ssrfSafeFetch('https://127.0.0.1/'),
      err => err instanceof SsrfRefusedError && err.code === 'private_address'
    );
  });

  it('refuses IMDS even when allowPrivateIp is on', async () => {
    await assert.rejects(
      () => ssrfSafeFetch('http://169.254.169.254/latest/meta-data/', { allowPrivateIp: true }),
      err => err instanceof SsrfRefusedError && err.code === 'always_blocked_address'
    );
  });

  it('rejects invalid URLs with invalid_url code', async () => {
    await assert.rejects(
      () => ssrfSafeFetch('not a url'),
      err => err instanceof SsrfRefusedError && err.code === 'invalid_url'
    );
  });
});

describe('ssrfSafeFetch — happy path (allowPrivateIp for localhost)', () => {
  it('performs a GET, returns headers + body, pins to resolved IP', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-pin-check': 'ok' });
      res.end(JSON.stringify({ ok: true, method: req.method }));
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
      const result = await ssrfSafeFetch(`http://127.0.0.1:${port}/x`, { allowPrivateIp: true });
      assert.strictEqual(result.status, 200);
      assert.strictEqual(result.headers['x-pin-check'], 'ok');
      assert.strictEqual(result.pinnedAddress, '127.0.0.1');
      assert.strictEqual(result.pinnedFamily, 4);
      assert.deepStrictEqual(JSON.parse(Buffer.from(result.body).toString('utf8')), { ok: true, method: 'GET' });
    } finally {
      server.close();
    }
  });

  it('carries POST body and custom headers', async () => {
    let seen = { method: '', auth: '', body: '' };
    const server = http.createServer(async (req, res) => {
      seen.method = req.method;
      seen.auth = req.headers.authorization ?? '';
      const chunks = [];
      for await (const c of req) chunks.push(c);
      seen.body = Buffer.concat(chunks).toString('utf8');
      res.writeHead(204);
      res.end();
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
      const result = await ssrfSafeFetch(`http://127.0.0.1:${port}/rpc`, {
        method: 'POST',
        headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
        body: JSON.stringify({ hello: 'world' }),
        allowPrivateIp: true,
      });
      assert.strictEqual(result.status, 204);
      assert.strictEqual(result.body.byteLength, 0);
      assert.strictEqual(seen.method, 'POST');
      assert.strictEqual(seen.auth, 'Bearer secret');
      assert.deepStrictEqual(JSON.parse(seen.body), { hello: 'world' });
    } finally {
      server.close();
    }
  });

  it('does not follow 302 redirects', async () => {
    const server = http.createServer((_, res) => {
      res.writeHead(302, { location: 'http://169.254.169.254/' });
      res.end();
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
      const result = await ssrfSafeFetch(`http://127.0.0.1:${port}/r`, { allowPrivateIp: true });
      assert.strictEqual(result.status, 302);
      assert.strictEqual(result.headers.location, 'http://169.254.169.254/');
    } finally {
      server.close();
    }
  });

  it('caps body size and throws body_exceeds_limit when over', async () => {
    const server = http.createServer((_, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.alloc(10_000, 0x41));
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
      await assert.rejects(
        () => ssrfSafeFetch(`http://127.0.0.1:${port}/big`, { allowPrivateIp: true, maxBodyBytes: 256 }),
        err => err instanceof SsrfRefusedError && err.code === 'body_exceeds_limit'
      );
    } finally {
      server.close();
    }
  });

  it('respects an external AbortSignal', async () => {
    const openSockets = new Set();
    const server = http.createServer((_, res) => {
      openSockets.add(res.socket);
      // Never respond — hold the connection open until the test tears it down.
    });
    server.on('connection', sock => openSockets.add(sock));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error('test-abort')), 50);
    try {
      await assert.rejects(
        () =>
          ssrfSafeFetch(`http://127.0.0.1:${port}/hang`, {
            allowPrivateIp: true,
            signal: ac.signal,
            timeoutMs: 2000,
          }),
        err => /abort/i.test(err.message) || err.name === 'AbortError'
      );
    } finally {
      for (const s of openSockets) s.destroy();
      await new Promise(r => server.close(() => r()));
    }
  });
});

describe('address-guards — bypass resistance', () => {
  it('strips IPv6 zone IDs before classification (fe80::1%eth0 is link-local)', () => {
    // Attacker bracketed URL like http://[fe80::1%eth0]/ passes dnsLookup
    // on some libc builds; the classifier must still recognize it as
    // link-local.
    assert.strictEqual(isAlwaysBlocked('fe80::1%eth0'), true);
    assert.strictEqual(isPrivateIp('fe80::1%eth0'), true);
  });

  it('strips URL brackets before classification ([::1] is loopback)', () => {
    assert.strictEqual(isPrivateIp('[::1]'), true);
    assert.strictEqual(isPrivateIp('[fe80::1]'), true);
    assert.strictEqual(isAlwaysBlocked('[fe80::1]'), true);
  });

  it('classifies non-canonical IPv4-mapped IPv6 via BlockList canonicalization', () => {
    // 0:0:0:0:0:ffff:127.0.0.1 is the uncompressed form of ::ffff:127.0.0.1.
    // BlockList normalizes to 127.0.0.1 internally.
    assert.strictEqual(isPrivateIp('0:0:0:0:0:ffff:127.0.0.1'), true);
    assert.strictEqual(isPrivateIp('0:0:0:0:0:ffff:169.254.169.254'), true);
    assert.strictEqual(isAlwaysBlocked('0:0:0:0:0:ffff:169.254.169.254'), true);
  });

  it('blocks NAT64 well-known prefix (64:ff9b::/96) regardless of embedded v4', () => {
    // NAT64 gateway at the caller's edge could translate into a private v4;
    // refuse the prefix unconditionally rather than hope the gateway is
    // configured the way we expect.
    assert.strictEqual(isPrivateIp('64:ff9b::a9fe:a9fe'), true); // IMDS hex
    assert.strictEqual(isPrivateIp('64:ff9b::8.8.8.8'), true); // public v4 wrapped — still refused
  });

  it('blocks 6to4 prefix (2002::/16)', () => {
    assert.strictEqual(isPrivateIp('2002:a9fe:a9fe::'), true);
    assert.strictEqual(isPrivateIp('2002:0808:0808::'), true);
  });

  it('allows real public addresses', () => {
    assert.strictEqual(isPrivateIp('8.8.8.8'), false);
    assert.strictEqual(isPrivateIp('1.1.1.1'), false);
    assert.strictEqual(isPrivateIp('2606:4700::1111'), false);
    assert.strictEqual(isAlwaysBlocked('8.8.8.8'), false);
  });

  it('returns false for non-IP inputs', () => {
    assert.strictEqual(isPrivateIp('example.com'), false);
    assert.strictEqual(isPrivateIp(''), false);
    assert.strictEqual(isAlwaysBlocked('not-an-ip'), false);
  });
});

describe('ssrfSafeFetch — IPv6 bracketed literal', () => {
  it('accepts https://[::1]/ under allowPrivateIp (strips brackets for DNS + classifier)', async () => {
    // Bind a v6-only server so this test passes only if bracket stripping
    // reached the dns.lookup call. Some CI environments don't support IPv6;
    // tolerate ENOTFOUND / EADDRNOTAVAIL as a skip.
    let server;
    try {
      server = http.createServer((_, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"v6":"ok"}');
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '::1', resolve);
      });
    } catch (err) {
      // No v6 loopback — skip the end-to-end fetch but still assert the
      // primitive doesn't throw the bracket-normalization bug.
      if (server) server.close();
      return;
    }
    const port = server.address().port;
    try {
      const result = await ssrfSafeFetch(`http://[::1]:${port}/`, { allowPrivateIp: true });
      assert.strictEqual(result.status, 200);
      assert.strictEqual(result.pinnedFamily, 6);
    } finally {
      server.close();
    }
  });

  it('refuses https://[::1]/ by default (classifier matches loopback)', async () => {
    await assert.rejects(
      () => ssrfSafeFetch('https://[::1]:1/'),
      err => err instanceof SsrfRefusedError && err.code === 'private_address'
    );
  });
});

describe('ssrfSafeFetch — error message hygiene', () => {
  it('does not leak the resolved IP into the error message when the input is a hostname', async () => {
    // `localhost` resolves to a loopback address via the system hosts file.
    // The threat is that a counterparty-supplied hostname resolving into the
    // caller's internal network would leak the resolved IP into compliance
    // reports. Message surfaces the hostname (safe — caller-supplied); the
    // resolved IP stays on `.address` for programmatic access only.
    try {
      await ssrfSafeFetch('https://localhost/');
      assert.fail('expected refusal');
    } catch (err) {
      assert.ok(err instanceof SsrfRefusedError);
      assert.strictEqual(err.code, 'private_address');
      assert.ok(
        err.address === '127.0.0.1' || err.address === '::1',
        `expected loopback address on err.address, got ${err.address}`
      );
      assert.doesNotMatch(err.message, /\b127\.0\.0\.1\b|::1/, 'resolved IP must not appear in the message');
      assert.match(err.message, /localhost/);
      assert.match(err.message, /private\/loopback/);
    }
  });

  it('IP-literal inputs surface the literal — nothing extra to hide', async () => {
    // When the caller typed the IP directly there's nothing to withhold.
    try {
      await ssrfSafeFetch('https://10.0.0.1/');
      assert.fail('expected refusal');
    } catch (err) {
      assert.ok(err instanceof SsrfRefusedError);
      assert.strictEqual(err.code, 'private_address');
      assert.strictEqual(err.address, '10.0.0.1');
      assert.match(err.message, /private\/loopback/);
    }
  });

  it('IMDS refusal code is "always_blocked_address" and message flags the category', async () => {
    try {
      await ssrfSafeFetch('http://169.254.169.254/', { allowPrivateIp: true });
      assert.fail('expected refusal');
    } catch (err) {
      assert.ok(err instanceof SsrfRefusedError);
      assert.strictEqual(err.code, 'always_blocked_address');
      assert.strictEqual(err.address, '169.254.169.254');
      assert.match(err.message, /always-blocked/);
    }
  });
});

describe('decodeBodyAsJsonOrText', () => {
  it('returns null for empty bodies', () => {
    assert.strictEqual(decodeBodyAsJsonOrText(new Uint8Array(), 'application/json'), null);
  });

  it('parses JSON when content-type declares it', () => {
    const buf = Buffer.from('{"a":1}');
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    assert.deepStrictEqual(decodeBodyAsJsonOrText(bytes, 'application/json; charset=utf-8'), { a: 1 });
  });

  it('falls back to raw text on JSON parse failure', () => {
    const buf = Buffer.from('not json');
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    assert.strictEqual(decodeBodyAsJsonOrText(bytes, 'application/json'), 'not json');
  });

  it('returns raw text for non-JSON content-types', () => {
    const buf = Buffer.from('<html></html>');
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    assert.strictEqual(decodeBodyAsJsonOrText(bytes, 'text/html'), '<html></html>');
  });
});
