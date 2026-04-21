/**
 * SSRF policy enforcement for `preview_url` fetches. The deny lists
 * below mirror the contract's normative policy block — a verifier
 * consumer MUST enforce every rule to claim AdCP Verified grading.
 */

import { BlockList, isIP, isIPv4, isIPv6 } from 'node:net';
import type { PolicyResult, SsrfPolicy } from '../types';

/**
 * Canonical policy from
 * `compliance/cache/latest/test-kits/substitution-observer-runner.yaml`.
 * Callers SHOULD use this constant — overriding the policy is
 * intended for local-dev workflows (`host_literal_policy: 'allow'`),
 * not for loosening deny lists.
 */
export const DEFAULT_SSRF_POLICY: SsrfPolicy = Object.freeze({
  schemes_allowed: Object.freeze(['https']),
  schemes_denied: Object.freeze(['http', 'file', 'gopher', 'ftp', 'ftps', 'data', 'javascript', 'about', 'ws', 'wss']),
  hosts_denied_ipv4_cidrs: Object.freeze([
    '0.0.0.0/8',
    '10.0.0.0/8',
    '100.64.0.0/10',
    '127.0.0.0/8',
    '169.254.0.0/16',
    '172.16.0.0/12',
    '192.0.0.0/24',
    '192.168.0.0/16',
    '224.0.0.0/4',
    '240.0.0.0/4',
  ]),
  hosts_denied_ipv6_cidrs: Object.freeze([
    '::1/128',
    '::/128',
    '::ffff:0:0/96',
    '64:ff9b::/96',
    'fc00::/7',
    'fe80::/10',
    'ff00::/8',
  ]),
  hosts_denied_metadata: Object.freeze([
    'metadata.google.internal',
    'metadata',
    'metadata.packet.net',
    'fd00:ec2::254',
  ]),
  host_literal_policy: 'reject',
}) as SsrfPolicy;

interface CompiledPolicy {
  policy: SsrfPolicy;
  ipv4: BlockList;
  ipv6: BlockList;
  metadataHostnames: Set<string>;
  schemesAllowed: Set<string>;
  schemesDenied: Set<string>;
}

const POLICY_CACHE = new WeakMap<SsrfPolicy, CompiledPolicy>();

function compile(policy: SsrfPolicy): CompiledPolicy {
  const cached = POLICY_CACHE.get(policy);
  if (cached) return cached;
  const ipv4 = new BlockList();
  const ipv6 = new BlockList();
  for (const cidr of policy.hosts_denied_ipv4_cidrs) {
    const [ip = '', prefix = '0'] = cidr.split('/');
    ipv4.addSubnet(ip, Number(prefix), 'ipv4');
  }
  for (const cidr of policy.hosts_denied_ipv6_cidrs) {
    const [ip = '', prefix = '0'] = cidr.split('/');
    ipv6.addSubnet(normalizeIpv6(ip), Number(prefix), 'ipv6');
  }
  const compiled: CompiledPolicy = {
    policy,
    ipv4,
    ipv6,
    metadataHostnames: new Set(policy.hosts_denied_metadata.map(h => h.toLowerCase())),
    schemesAllowed: new Set(policy.schemes_allowed.map(s => s.toLowerCase())),
    schemesDenied: new Set(policy.schemes_denied.map(s => s.toLowerCase())),
  };
  POLICY_CACHE.set(policy, compiled);
  return compiled;
}

/**
 * Evaluate `url` against the policy's synchronous rules: scheme, bare-
 * IP-literal rejection, metadata hostname, and IP-literal CIDR deny.
 * DNS revalidation (required when the host is a name) is handled by
 * {@link enforceSsrfPolicyWithResolution}; this pure check covers every
 * non-DNS case without touching the network.
 */
export function enforceSsrfPolicy(url: URL, policy: SsrfPolicy = DEFAULT_SSRF_POLICY): PolicyResult {
  const compiled = compile(policy);
  const scheme = url.protocol.replace(/:$/, '').toLowerCase();

  if (compiled.schemesDenied.has(scheme)) {
    return {
      allowed: false,
      rule: `schemes_denied:${scheme}`,
      message: `URL scheme ${scheme} is on the deny list.`,
    };
  }
  if (!compiled.schemesAllowed.has(scheme)) {
    return {
      allowed: false,
      rule: `schemes_allowed:${scheme}`,
      message: `URL scheme ${scheme} is not in the allow list.`,
    };
  }

  const hostname = stripBrackets(url.hostname).toLowerCase();

  if (compiled.metadataHostnames.has(hostname)) {
    return {
      allowed: false,
      rule: `hosts_denied_metadata:${hostname}`,
      message: `Hostname ${hostname} is a known cloud metadata endpoint.`,
    };
  }

  if (isIP(hostname) !== 0) {
    if (policy.host_literal_policy === 'reject') {
      return {
        allowed: false,
        rule: 'host_literal_policy:reject',
        message: `Bare IP literal ${hostname} rejected under Verified host policy.`,
      };
    }
    return checkIp(hostname, compiled);
  }

  return { allowed: true };
}

/**
 * Evaluate `url` after DNS resolution. Every resolved address must
 * pass the CIDR deny list. Callers pin the request to the first
 * allowed address to prevent DNS rebinding between lookup and connect.
 */
export function enforceSsrfPolicyResolved(
  url: URL,
  addresses: readonly string[],
  policy: SsrfPolicy = DEFAULT_SSRF_POLICY
): PolicyResult {
  const syncResult = enforceSsrfPolicy(url, policy);
  if (!syncResult.allowed) return syncResult;
  const compiled = compile(policy);
  if (addresses.length === 0) {
    return {
      allowed: false,
      rule: 'dns_revalidation:no_addresses',
      message: `DNS resolution returned no addresses for ${url.hostname}.`,
    };
  }
  for (const addr of addresses) {
    const r = checkIp(addr, compiled);
    if (!r.allowed) return r;
  }
  return { allowed: true };
}

function checkIp(ip: string, compiled: CompiledPolicy): PolicyResult {
  if (isIPv4(ip)) {
    if (compiled.ipv4.check(ip, 'ipv4')) {
      return {
        allowed: false,
        rule: matchIpv4Rule(ip, compiled),
        message: `Resolved address ${ip} is in a denied IPv4 range.`,
      };
    }
    return { allowed: true };
  }
  if (isIPv6(ip)) {
    const normalized = normalizeIpv6(ip);
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) is re-checked against v4 deny.
    const v4Suffix = extractMappedIpv4(normalized);
    if (v4Suffix && compiled.ipv4.check(v4Suffix, 'ipv4')) {
      return {
        allowed: false,
        rule: matchIpv4Rule(v4Suffix, compiled),
        message: `IPv4-mapped address ${ip} resolves to denied IPv4 ${v4Suffix}.`,
      };
    }
    if (compiled.ipv6.check(normalized, 'ipv6')) {
      return {
        allowed: false,
        rule: matchIpv6Rule(normalized, compiled),
        message: `Resolved address ${ip} is in a denied IPv6 range.`,
      };
    }
    return { allowed: true };
  }
  return {
    allowed: false,
    rule: 'invalid_ip',
    message: `Address ${ip} is not a valid IPv4 or IPv6 literal.`,
  };
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function normalizeIpv6(ip: string): string {
  // BlockList expects normalized lowercase; URL hostname is lowercase
  // but IPv6 literals may arrive with varied compression.
  return stripBrackets(ip).toLowerCase();
}

function extractMappedIpv4(ipv6: string): string | null {
  const m = /^::ffff:([0-9a-f:]+)$/i.exec(ipv6);
  if (!m) return null;
  const tail = m[1] ?? '';
  if (isIPv4(tail)) return tail;
  // ::ffff:c0a8:0101 form — convert four hex halves to dotted quad.
  const parts = tail.split(':');
  if (parts.length === 2 && parts.every(p => /^[0-9a-f]{1,4}$/.test(p))) {
    const hi = parseInt(parts[0] ?? '0', 16);
    const lo = parseInt(parts[1] ?? '0', 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

function matchIpv4Rule(ip: string, compiled: CompiledPolicy): string {
  for (const cidr of compiled.policy.hosts_denied_ipv4_cidrs) {
    const [base = '', prefix = '0'] = cidr.split('/');
    const bl = new BlockList();
    bl.addSubnet(base, Number(prefix), 'ipv4');
    if (bl.check(ip, 'ipv4')) return `hosts_denied_ipv4_cidrs:${cidr}`;
  }
  return 'hosts_denied_ipv4_cidrs:unknown';
}

function matchIpv6Rule(ip: string, compiled: CompiledPolicy): string {
  for (const cidr of compiled.policy.hosts_denied_ipv6_cidrs) {
    const [base = '', prefix = '0'] = cidr.split('/');
    const bl = new BlockList();
    bl.addSubnet(normalizeIpv6(base), Number(prefix), 'ipv6');
    if (bl.check(ip, 'ipv6')) return `hosts_denied_ipv6_cidrs:${cidr}`;
  }
  return 'hosts_denied_ipv6_cidrs:unknown';
}
