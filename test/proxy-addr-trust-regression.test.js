const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const proxyaddr = require('proxy-addr');

function clientIp(remoteAddress, forwardedFor, trust) {
  return proxyaddr({ socket: { remoteAddress }, headers: { 'x-forwarded-for': forwardedFor } }, trust);
}

describe('Express proxy trust CIDRs (GHSA-jqcg-44mw-7w3h)', () => {
  for (const subnets of ['::ffff:10.0.0.0/8', ['loopback', '::ffff:10.0.0.0/8'], '::/1', ['::/1', '10.0.0.0/8']]) {
    test(`${JSON.stringify(subnets)} does not let a public IPv4 peer spoof X-Forwarded-For`, () => {
      const trust = proxyaddr.compile(subnets);
      assert.equal(trust('203.0.113.9'), false);
      assert.equal(clientIp('203.0.113.9', '10.1.2.3', trust), '203.0.113.9');
    });
  }

  for (const subnet of ['10.0.0.0/8', '::ffff:10.0.0.0/104']) {
    test(`${subnet} still trusts the intended IPv4 proxy block`, () => {
      const trust = proxyaddr.compile(subnet);
      assert.equal(trust('10.2.3.4'), true);
      assert.equal(trust('203.0.113.9'), false);
      assert.equal(clientIp('10.2.3.4', '203.0.113.10', trust), '203.0.113.10');
      assert.equal(clientIp('203.0.113.9', '10.1.2.3', trust), '203.0.113.9');
    });
  }

  test('an IPv6 subnet retains its actual IPv6 trust semantics', () => {
    const trust = proxyaddr.compile('::/1');
    assert.equal(trust('2001:db8::1'), true);
    assert.equal(trust('8000::1'), false);
    assert.equal(clientIp('2001:db8::1', '2001:db8:1::2', trust), '2001:db8:1::2');
  });

  test('a mixed list retains its explicitly trusted IPv4 block', () => {
    const trust = proxyaddr.compile(['::/1', '10.0.0.0/8']);
    assert.equal(trust('10.2.3.4'), true);
    assert.equal(clientIp('10.2.3.4', '203.0.113.10', trust), '203.0.113.10');
  });
});
