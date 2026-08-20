const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { enforceSsrfPolicy, enforceSsrfPolicyResolved, DEFAULT_SSRF_POLICY } = require('../../dist/lib/index.js');

describe('enforceSsrfPolicy — scheme deny list', () => {
  for (const scheme of ['http', 'file', 'gopher', 'ftp', 'ftps', 'data', 'javascript', 'about', 'ws', 'wss']) {
    it(`denies ${scheme}:`, () => {
      const host = scheme === 'file' ? '/etc/passwd' : 'example.com/x';
      const url = new URL(`${scheme}://${host}`);
      const r = enforceSsrfPolicy(url);
      assert.equal(r.allowed, false, `${scheme}: should be denied`);
      assert.ok(r.rule?.startsWith('schemes_'));
    });
  }

  it('allows https:', () => {
    const r = enforceSsrfPolicy(new URL('https://example.com/preview'));
    assert.equal(r.allowed, true);
  });
});

describe('enforceSsrfPolicy — bare IPv4 literal policy', () => {
  it('rejects bare IPv4 literal in Verified mode (default)', () => {
    const r = enforceSsrfPolicy(new URL('https://192.0.2.1/preview'));
    assert.equal(r.allowed, false);
    assert.equal(r.rule, 'host_literal_policy:reject');
  });

  it('accepts bare IPv4 literal when host_literal_policy is allow, then runs CIDR check', () => {
    const permissive = { ...DEFAULT_SSRF_POLICY, host_literal_policy: 'allow' };
    assert.equal(enforceSsrfPolicy(new URL('https://8.8.8.8/preview'), permissive).allowed, true);
    const deny = enforceSsrfPolicy(new URL('https://169.254.169.254/latest/meta-data'), permissive);
    assert.equal(deny.allowed, false);
    assert.ok(deny.rule?.startsWith('hosts_denied_ipv4_cidrs:'));
  });
});

describe('enforceSsrfPolicy — IPv4 CIDR deny (via enforceSsrfPolicyResolved)', () => {
  const cases = [
    ['0.0.0.0', '0.0.0.0/8'],
    ['10.1.2.3', '10.0.0.0/8'],
    ['100.64.1.1', '100.64.0.0/10'],
    ['127.0.0.1', '127.0.0.0/8'],
    ['169.254.169.254', '169.254.0.0/16'],
    ['172.16.1.1', '172.16.0.0/12'],
    ['192.0.0.1', '192.0.0.0/24'],
    ['192.168.1.1', '192.168.0.0/16'],
    ['224.0.0.1', '224.0.0.0/4'],
    ['240.0.0.1', '240.0.0.0/4'],
  ];
  for (const [ip, cidr] of cases) {
    it(`denies ${ip} (in ${cidr})`, () => {
      const r = enforceSsrfPolicyResolved(new URL('https://example.test/p'), [ip]);
      assert.equal(r.allowed, false);
      assert.equal(r.rule, `hosts_denied_ipv4_cidrs:${cidr}`);
    });
  }

  it('allows a public IPv4 outside every deny CIDR', () => {
    const r = enforceSsrfPolicyResolved(new URL('https://example.test/p'), ['8.8.8.8']);
    assert.equal(r.allowed, true);
  });

  it('fails when at least one resolved address is denied, even if others pass', () => {
    const r = enforceSsrfPolicyResolved(new URL('https://example.test/p'), ['8.8.8.8', '169.254.169.254']);
    assert.equal(r.allowed, false);
    assert.ok(r.rule?.startsWith('hosts_denied_ipv4_cidrs:169.254.0.0/16'));
  });

  it('fails when DNS returns zero addresses', () => {
    const r = enforceSsrfPolicyResolved(new URL('https://example.test/p'), []);
    assert.equal(r.allowed, false);
    assert.equal(r.rule, 'dns_revalidation:no_addresses');
  });
});

describe('enforceSsrfPolicy — IPv6 CIDR deny', () => {
  const cases = [
    ['::1', '::1/128'],
    ['fe80::1', 'fe80::/10'],
    ['fc00::1', 'fc00::/7'],
    ['ff02::1', 'ff00::/8'],
  ];
  for (const [ip, cidr] of cases) {
    it(`denies ${ip} (in ${cidr})`, () => {
      const r = enforceSsrfPolicyResolved(new URL('https://example.test/p'), [ip]);
      assert.equal(r.allowed, false);
      assert.equal(r.rule, `hosts_denied_ipv6_cidrs:${cidr}`);
    });
  }

  it('allows a public IPv6 outside every deny CIDR', () => {
    const r = enforceSsrfPolicyResolved(new URL('https://example.test/p'), ['2606:4700:4700::1111']);
    assert.equal(r.allowed, true);
  });

  it('applies the shared non-routable and always-blocked IPv6 tiers', () => {
    for (const ip of ['64:ff9b:1::1', '2001::1', '2001:2::1', '2002:a9fe:a9fe::', '3ffe::1', '3fff::1', '5f00::1']) {
      const r = enforceSsrfPolicyResolved(new URL('https://example.test/p'), [ip]);
      assert.equal(r.allowed, false, `${ip} must be refused`);
    }
  });

  it('lets custom policies own private ranges but never bypass the always-blocked tier', () => {
    const custom = {
      ...DEFAULT_SSRF_POLICY,
      hosts_denied_ipv4_cidrs: [],
      hosts_denied_ipv6_cidrs: [],
      shared_private_address_policy: 'allow',
    };

    assert.equal(enforceSsrfPolicyResolved(new URL('https://example.test/p'), ['3ffe::1'], custom).allowed, true);
    assert.equal(enforceSsrfPolicyResolved(new URL('https://example.test/p'), ['64:ff9b:1::1'], custom).allowed, false);
  });

  it('preserves shared private blocking across spread-based default-policy overrides', () => {
    for (const policy of [{ ...DEFAULT_SSRF_POLICY }, { ...DEFAULT_SSRF_POLICY, host_literal_policy: 'allow' }]) {
      assert.equal(enforceSsrfPolicyResolved(new URL('https://example.test/p'), ['3ffe::1'], policy).allowed, false);
    }
  });

  it('allows only native loopback representations under allow_loopback', () => {
    const policy = {
      ...DEFAULT_SSRF_POLICY,
      hosts_denied_ipv4_cidrs: [],
      hosts_denied_ipv6_cidrs: [],
      shared_private_address_policy: 'allow_loopback',
    };

    for (const ip of ['127.0.0.1', '::1']) {
      assert.equal(enforceSsrfPolicyResolved(new URL('https://example.test/p'), [ip], policy).allowed, true);
    }
    for (const ip of ['::ffff:127.0.0.1', '0:0:0:0:0:ffff:7f00:1']) {
      assert.equal(enforceSsrfPolicyResolved(new URL('https://example.test/p'), [ip], policy).allowed, false);
    }
  });

  it('rejects a bare IPv6 literal in Verified mode before CIDR check', () => {
    const url = new URL('https://[2001:db8::1]/p');
    const r = enforceSsrfPolicy(url);
    assert.equal(r.allowed, false);
    assert.equal(r.rule, 'host_literal_policy:reject');
  });
});

describe('enforceSsrfPolicy — cloud metadata hostnames', () => {
  for (const host of ['metadata.google.internal', 'metadata', 'metadata.packet.net']) {
    it(`denies hostname ${host}`, () => {
      const r = enforceSsrfPolicy(new URL(`https://${host}/computeMetadata/v1/`));
      assert.equal(r.allowed, false);
      assert.equal(r.rule, `hosts_denied_metadata:${host}`);
    });
  }

  it('normalizes a trailing DNS root dot before metadata matching', () => {
    const r = enforceSsrfPolicy(new URL('https://metadata.google.internal./computeMetadata/v1/'));
    assert.equal(r.allowed, false);
    assert.equal(r.rule, 'hosts_denied_metadata:metadata.google.internal');
  });
});

describe('DEFAULT_SSRF_POLICY mirrors and hardens the contract', () => {
  it('exposes readonly schemes_allowed / schemes_denied / deny lists', () => {
    assert.deepEqual([...DEFAULT_SSRF_POLICY.schemes_allowed], ['https']);
    assert.ok(DEFAULT_SSRF_POLICY.schemes_denied.includes('javascript'));
    assert.ok(DEFAULT_SSRF_POLICY.hosts_denied_ipv4_cidrs.includes('169.254.0.0/16'));
    assert.ok(DEFAULT_SSRF_POLICY.hosts_denied_ipv6_cidrs.includes('::1/128'));
    assert.equal(DEFAULT_SSRF_POLICY.host_literal_policy, 'reject');
    assert.equal(DEFAULT_SSRF_POLICY.shared_private_address_policy, 'deny');
  });
});
