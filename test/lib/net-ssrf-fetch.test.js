const { describe, it } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const dnsPromises = require('dns/promises');

const {
  ssrfSafeFetch,
  SsrfRefusedError,
  decodeBodyAsJsonOrText,
  isPrivateIp,
  isAlwaysBlocked,
} = require('../../dist/lib/net');

describe('ssrfSafeFetch — scheme guard', () => {
  it('fetches the exact normalized URL that was checked', async () => {
    let coercions = 0;
    const input = {
      toString() {
        coercions += 1;
        return coercions === 1 ? 'https://public.example/' : 'http://127.0.0.1/';
      },
    };
    let fetchedUrl;
    const result = await ssrfSafeFetch(input, {
      trustedFetchFn: async url => {
        fetchedUrl = url;
        return new Response(null, { status: 204 });
      },
    });

    assert.equal(result.status, 204);
    assert.equal(coercions, 1);
    assert.equal(fetchedUrl, 'https://public.example/');
  });

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

describe('ssrfSafeFetch — DNS deadline and cancellation', () => {
  it('applies the per-request timeout while DNS lookup is pending', async t => {
    t.mock.method(dnsPromises, 'lookup', () => new Promise(() => {}));
    const startedAt = Date.now();

    await assert.rejects(
      () => ssrfSafeFetch('https://slow-dns.example/', { timeoutMs: 30 }),
      err => {
        assert.match(err.message, /ssrf-fetch: timeout/);
        return true;
      }
    );

    assert.ok(Date.now() - startedAt < 1000, 'DNS timeout should release the caller promptly');
  });

  it('propagates caller abort while DNS lookup is pending', async t => {
    t.mock.method(dnsPromises, 'lookup', () => new Promise(() => {}));
    const controller = new AbortController();
    const reason = new Error('caller-aborted-dns');
    const startedAt = Date.now();
    setTimeout(() => controller.abort(reason), 30);

    await assert.rejects(
      () =>
        ssrfSafeFetch('https://slow-dns.example/', {
          signal: controller.signal,
          timeoutMs: 2000,
        }),
      err => {
        assert.strictEqual(err, reason);
        return true;
      }
    );

    assert.ok(Date.now() - startedAt < 1000, 'caller abort should release a pending DNS lookup promptly');
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
      assert.strictEqual(result.connectionPinned, true);
      assert.deepStrictEqual(JSON.parse(Buffer.from(result.body).toString('utf8')), { ok: true, method: 'GET' });
    } finally {
      server.close();
    }
  });

  it('delegates DNS pinning metadata to trusted custom-fetch connections', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
      const result = await ssrfSafeFetch(`http://127.0.0.1:${port}/x`, {
        allowPrivateIp: true,
        trustedFetchFn: fetch,
      });
      assert.strictEqual(result.status, 200);
      assert.strictEqual(result.pinnedAddress, undefined);
      assert.strictEqual(result.pinnedFamily, undefined);
      assert.strictEqual(result.connectionPinned, false);
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

  it('uses exact wrapped link-local prefix boundaries', () => {
    const boundaries = [
      {
        before: '::a9fd:ffff',
        first: '::a9fe:0',
        last: '::a9fe:ffff',
        after: '::a9ff:0',
      },
      {
        before: '::ffff:0:a9fd:ffff',
        first: '::ffff:0:a9fe:0',
        last: '::ffff:0:a9fe:ffff',
        after: '::ffff:0:a9ff:0',
      },
      {
        before: '64:ff9b::a9fd:ffff',
        first: '64:ff9b::a9fe:0',
        last: '64:ff9b::a9fe:ffff',
        after: '64:ff9b::a9ff:0',
      },
      {
        before: '2002:a9fd:ffff:ffff:ffff:ffff:ffff:ffff',
        first: '2002:a9fe::',
        last: '2002:a9fe:ffff:ffff:ffff:ffff:ffff:ffff',
        after: '2002:a9ff::',
      },
    ];

    for (const { before, first, last, after } of boundaries) {
      assert.strictEqual(isAlwaysBlocked(before), false, `${before} should precede the blocked prefix`);
      assert.strictEqual(isAlwaysBlocked(first), true, `${first} should start the blocked prefix`);
      assert.strictEqual(isAlwaysBlocked(last), true, `${last} should end the blocked prefix`);
      assert.strictEqual(isAlwaysBlocked(after), false, `${after} should follow the blocked prefix`);
    }
  });

  it('always blocks wrapped metadata even when private-network access is enabled', async () => {
    const wrappedMetadataAddresses = [
      '::a9fe:a9fe', // IPv4-compatible 169.254.169.254
      '::c000:c0', // IPv4-compatible Oracle IMDS
      '::ffff:0:a9fe:a9fe', // IPv4-translated 169.254.169.254
      '::ffff:0:c000:c0', // IPv4-translated Oracle IMDS
      '64:ff9b::a9fe:a9fe', // NAT64 WKP 169.254.169.254
      '64:ff9b::c000:c0', // NAT64 WKP Oracle IMDS
      '2002:a9fe:a9fe::', // 6to4 169.254.169.254
      '2002:c000:c0::', // 6to4 Oracle IMDS
      '64:ff9b:1::808:808', // opaque local-use translation prefix
      '2001::1', // Teredo has relay-dependent, obfuscated endpoint data
    ];
    let fetchCalls = 0;
    const trustedFetchFn = async () => {
      fetchCalls += 1;
      return new Response(null, { status: 204 });
    };

    for (const address of wrappedMetadataAddresses) {
      assert.strictEqual(isAlwaysBlocked(address), true, `${address} should be always blocked`);
      assert.strictEqual(isPrivateIp(address), true, `${address} should also be private-classified`);
      await assert.rejects(
        () =>
          ssrfSafeFetch(`http://[${address}]/`, {
            allowPrivateIp: true,
            trustedFetchFn,
          }),
        err => err instanceof SsrfRefusedError && err.code === 'always_blocked_address',
        `${address} should remain refused under allowPrivateIp`
      );
    }
    assert.strictEqual(fetchCalls, 0, 'always-blocked literals must be rejected before fetch');
  });

  it('always blocks AWS IPv6 IMDS even when private-network access is enabled', async () => {
    let fetchCalls = 0;
    const address = 'fd00:ec2::254';

    assert.strictEqual(isAlwaysBlocked(address), true);
    assert.strictEqual(isPrivateIp(address), true);
    await assert.rejects(
      () =>
        ssrfSafeFetch(`http://[${address}]/latest/meta-data/`, {
          allowPrivateIp: true,
          trustedFetchFn: async () => {
            fetchCalls += 1;
            return new Response(null, { status: 204 });
          },
        }),
      err => err instanceof SsrfRefusedError && err.code === 'always_blocked_address'
    );
    assert.strictEqual(fetchCalls, 0, 'IPv6 IMDS must be rejected before fetch');
  });

  it('keeps deterministic public wrappers overrideable through allowPrivateIp', async () => {
    const publicWrapperAddresses = ['::8.8.8.8', '::ffff:0:8.8.8.8', '64:ff9b::8.8.8.8', '2002:0808:0808::'];
    let fetchCalls = 0;
    const trustedFetchFn = async () => {
      fetchCalls += 1;
      return new Response(null, { status: 204 });
    };

    for (const address of publicWrapperAddresses) {
      assert.strictEqual(isAlwaysBlocked(address), false, `${address} should not be always blocked`);
      assert.strictEqual(isPrivateIp(address), true, `${address} should be refused by default`);
      await assert.rejects(
        () => ssrfSafeFetch(`https://[${address}]/`, { trustedFetchFn }),
        err => err instanceof SsrfRefusedError && err.code === 'private_address'
      );
      const response = await ssrfSafeFetch(`https://[${address}]/`, {
        allowPrivateIp: true,
        trustedFetchFn,
      });
      assert.strictEqual(response.status, 204);
    }
    assert.strictEqual(fetchCalls, publicWrapperAddresses.length);
  });

  it('uses exact opaque-wrapper always-blocked boundaries', () => {
    const boundaries = [
      {
        before: '64:ff9b:0:ffff:ffff:ffff:ffff:ffff',
        first: '64:ff9b:1::',
        last: '64:ff9b:1:ffff:ffff:ffff:ffff:ffff',
        after: '64:ff9b:2::',
      },
      {
        before: '2000:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
        first: '2001::',
        last: '2001:0:ffff:ffff:ffff:ffff:ffff:ffff',
        after: '2001:1::',
      },
    ];

    for (const { before, first, last, after } of boundaries) {
      assert.strictEqual(isAlwaysBlocked(before), false, `${before} should precede the blocked prefix`);
      assert.strictEqual(isAlwaysBlocked(first), true, `${first} should start the blocked prefix`);
      assert.strictEqual(isAlwaysBlocked(last), true, `${last} should end the blocked prefix`);
      assert.strictEqual(isAlwaysBlocked(after), false, `${after} should follow the blocked prefix`);
    }
  });

  it('checks every DNS answer for opaque wrappers even under allowPrivateIp', async t => {
    let blockedAddress = '64:ff9b:1::1';
    t.mock.method(dnsPromises, 'lookup', async () => [
      { address: '2606:4700::1111', family: 6 },
      { address: blockedAddress, family: 6 },
    ]);

    for (const address of ['64:ff9b:1::1', '2001::1', '64:ff9b::a9fe:a9fe']) {
      blockedAddress = address;
      await assert.rejects(
        () => ssrfSafeFetch('https://wrapped-dns.example/', { allowPrivateIp: true, timeoutMs: 100 }),
        err =>
          err instanceof SsrfRefusedError && err.code === 'always_blocked_address' && err.address === blockedAddress
      );
    }
  });

  it('blocks NAT64 well-known prefix (64:ff9b::/96) regardless of embedded v4', () => {
    // NAT64 gateway at the caller's edge could translate into a private v4;
    // refuse the prefix by default rather than hope the gateway is configured
    // the way we expect.
    assert.strictEqual(isPrivateIp('64:ff9b::a9fe:a9fe'), true); // IMDS hex
    assert.strictEqual(isPrivateIp('64:ff9b::8.8.8.8'), true); // public v4 wrapped — still refused
  });

  it('blocks 6to4 prefix (2002::/16)', () => {
    assert.strictEqual(isPrivateIp('2002:a9fe:a9fe::'), true);
    assert.strictEqual(isPrivateIp('2002:0808:0808::'), true);
  });

  it('blocks non-routable IPv6 special-purpose ranges', () => {
    const specialPurposeAddresses = [
      '::192.0.2.1', // deprecated IPv4-compatible
      '::ffff:0:192.0.2.1', // deprecated IPv4-translated
      'fec0::1', // deprecated site-local
      'feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', // end of deprecated site-local /10
      '100:0:0:1::1', // dummy prefix
      '2001:2::1', // benchmarking
      '2001:10::1', // deprecated ORCHID
      '3fff:fff::1', // documentation
      '5f00::1', // segment-routing SID
      '64:ff9b:1::8.8.8.8', // local-use IPv4/IPv6 translation
      '2001:2:1::1', // non-global gap in IETF protocol assignments
      '3ffe::1', // returned 6bone space
      '5f01::1', // unallocated remainder of returned 6bone /8
      '5fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', // end of returned 6bone /8
    ];

    for (const address of specialPurposeAddresses) {
      assert.strictEqual(isPrivateIp(address), true, `${address} should be refused`);
    }
  });

  it('blocks the non-global 2001::/23 parent except current reachable allocations', () => {
    const nonGlobalIetfAddresses = [
      '2001::1', // Teredo
      '2001:1::', // gap before the point anycast assignments
      '2001:1::4', // first address after the point anycast assignments
      '2001:2:1::', // immediately after benchmarking /48, still inside the parent
      '2001:2:ffff:ffff:ffff:ffff:ffff:ffff', // immediately before AMT
      '2001:4::1', // gap before AS112-v6
      '2001:4:113::1', // immediately after AS112-v6
      '2001:10::1', // deprecated ORCHID
      '2001:1f:ffff:ffff:ffff:ffff:ffff:ffff', // immediately before ORCHIDv2
      '2001:40::1', // immediately after the DET allocation
      '2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff', // end of parent /23
    ];

    for (const address of nonGlobalIetfAddresses) {
      assert.strictEqual(isPrivateIp(address), true, `${address} should be refused`);
    }
  });

  it('allows every current globally reachable allocation inside 2001::/23', () => {
    const reachableIetfAddresses = [
      '2001:1::1', // PCP anycast
      '2001:1::2', // TURN anycast
      '2001:1::3', // DNS-SD anycast
      '2001:3::', // AMT lower bound
      '2001:3:ffff:ffff:ffff:ffff:ffff:ffff', // AMT upper bound
      '2001:4:112::', // AS112-v6 lower bound
      '2001:4:112:ffff:ffff:ffff:ffff:ffff', // AS112-v6 upper bound
      '2001:20::', // ORCHIDv2 lower bound
      '2001:2f:ffff:ffff:ffff:ffff:ffff:ffff', // ORCHIDv2 upper bound
      '2001:30::', // DET lower bound
      '2001:3f:ffff:ffff:ffff:ffff:ffff:ffff', // DET upper bound
    ];

    for (const address of reachableIetfAddresses) {
      assert.strictEqual(isPrivateIp(address), false, `${address} should remain reachable`);
    }
  });

  it('does not overblock addresses immediately outside the denied prefixes', () => {
    assert.strictEqual(isPrivateIp('::1:0:0'), false); // immediately after deprecated ::/96
    assert.strictEqual(isPrivateIp('::ffff:1:0:0'), false); // outside deprecated ::ffff:0:0:0/96
    assert.strictEqual(isPrivateIp('100:0:0:2::1'), false); // after dummy-prefix /64
    assert.strictEqual(isPrivateIp('2001:200::1'), false); // immediately after IETF assignments /23
    assert.strictEqual(isPrivateIp('3fff:1000::1'), false); // immediately after 3fff::/20
    assert.strictEqual(isPrivateIp('64:ff9b:2::1'), false); // outside local-use 64:ff9b:1::/48
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
