import { readFileSync } from 'node:fs';
import { isAlwaysBlocked, isPrivateIp } from '../../../net/address-guards';
import { SsrfRefusedError } from '../../../net/ssrf-fetch';
import { gradeOAuthMetadataGraphWithTransport } from './grader';
import type { OAuthMetadataFetchResponse, OAuthMetadataFetchTransport, OAuthMetadataGraphGrade } from './types';

interface VectorResponse {
  status?: number;
  content_type?: string;
  json?: unknown;
  body?: string;
  headers?: Record<string, string>;
  network_error?: string;
  connected_peer_address?: string;
}

interface VectorDnsFixture {
  addresses?: string[];
  fixture_address_classes?: string[];
}

export interface OAuthMetadataGraphVector {
  id: string;
  agent_url: string;
  coverage?: string[];
  responses: Record<string, VectorResponse>;
  dns?: Record<string, VectorDnsFixture>;
  expected_outcome: { success: boolean; error_code?: string };
}

export interface OAuthMetadataGraphVectorCorpus {
  positive: OAuthMetadataGraphVector[];
  negative: OAuthMetadataGraphVector[];
}

export function loadOAuthMetadataGraphVectors(file: string): OAuthMetadataGraphVectorCorpus {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<OAuthMetadataGraphVectorCorpus>;
  if (!Array.isArray(parsed.positive) || !Array.isArray(parsed.negative)) {
    throw new Error('OAuth metadata graph vector corpus must contain positive and negative arrays.');
  }
  return { positive: parsed.positive, negative: parsed.negative };
}

export async function gradeOAuthMetadataGraphVector(
  vector: OAuthMetadataGraphVector
): Promise<OAuthMetadataGraphGrade> {
  const transport = new VectorTransport(vector);
  return gradeOAuthMetadataGraphWithTransport(vector.agent_url, { transport });
}

class VectorTransport implements OAuthMetadataFetchTransport {
  constructor(private readonly vector: OAuthMetadataGraphVector) {}

  async fetch(
    url: string,
    options: { signal: AbortSignal; maxBodyBytes: number }
  ): Promise<OAuthMetadataFetchResponse> {
    if (options.signal.aborted) throw options.signal.reason;
    this.enforceFixtureAddressPolicy(url);
    const response = this.vector.responses[`GET ${url}`];
    if (!response) throw new Error(`Offline vector has no response for GET ${url}`);
    if (response.network_error) throw new Error(`Offline vector network error: ${response.network_error}`);
    const bodyText = response.body ?? (response.json === undefined ? '' : JSON.stringify(response.json));
    const body = new TextEncoder().encode(bodyText);
    if (body.byteLength > options.maxBodyBytes) {
      throw new SsrfRefusedError('body_exceeds_limit', 'Offline vector response exceeds the response-byte limit.', {
        url,
        hostname: new URL(url).hostname,
      });
    }
    const headers = lowerCaseHeaders(response.headers ?? {});
    if (response.content_type) headers['content-type'] = response.content_type;
    return {
      status: response.status ?? 0,
      headers,
      body,
      ...(response.connected_peer_address && { connectedPeerAddress: response.connected_peer_address }),
    };
  }

  private enforceFixtureAddressPolicy(value: string): void {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (isAlwaysBlocked(hostname) || isPrivateIp(hostname)) {
      throw new SsrfRefusedError('private_address', 'Vector target is blocked by SSRF policy.', {
        url: value,
        hostname,
      });
    }
    const dns = this.vector.dns?.[hostname];
    if (!dns?.addresses) return;
    for (let index = 0; index < dns.addresses.length; index++) {
      const fixtureClass = dns.fixture_address_classes?.[index];
      if (fixtureClass && fixtureClass !== 'globally_routable_fixture_only') {
        throw new SsrfRefusedError('private_address', 'Vector DNS answer is blocked by SSRF policy.', {
          url: value,
          hostname,
        });
      }
      const address = dns.addresses[index]!;
      if (!fixtureClass && (isAlwaysBlocked(address) || isPrivateIp(address))) {
        throw new SsrfRefusedError('private_address', 'Vector DNS answer is blocked by SSRF policy.', {
          url: value,
          hostname,
        });
      }
    }
  }
}

function lowerCaseHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}
