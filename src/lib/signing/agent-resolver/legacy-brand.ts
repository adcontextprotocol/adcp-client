import { fetchBrandJson, BrandJsonResolverError } from '../brand-jwks';
import type { SsrfDnsLookup } from '../../net';
import { eTldPlusOne } from './etld';
import { SafeFetchError, classifyDiscoveryFailure } from './fetch-helpers';

/** 3.x webhook compatibility only; explicit capability URLs never use this path. */
export async function fetchLegacyBrandJson(
  agentUrl: string,
  options: { allowPrivateIp?: boolean; timeoutMs?: number; maxBodyBytes: number; lookup?: SsrfDnsLookup }
) {
  const agent = new URL(agentUrl);
  let startUrl = `${agent.origin}/.well-known/brand.json`;
  const fetch = (url: string) => fetchBrandJson({ ...options, startUrl: url, domainDerived: true, maxRedirects: 1 });
  let result;
  try {
    try {
      result = await fetch(startUrl);
    } catch (err) {
      if (!(err instanceof BrandJsonResolverError) || (err.httpStatus !== 404 && err.httpStatus !== 410)) throw err;
      const domain = eTldPlusOne(agentUrl);
      if (domain === agent.hostname) throw err;
      startUrl = `https://${domain}/.well-known/brand.json`;
      result = await fetch(startUrl);
    }
  } catch (err) {
    throw new SafeFetchError(
      'brand.json',
      classifyDiscoveryFailure(err).dns_error,
      err instanceof BrandJsonResolverError && err.code === 'invalid_body'
        ? 'brand.json body failed strict-JSON parse'
        : 'Legacy brand.json discovery failed',
      err instanceof BrandJsonResolverError ? err.httpStatus : undefined
    );
  }
  return {
    body: result.data,
    url: result.finalUrl,
    fetchedAt: Math.floor(Date.now() / 1000),
    headers: { 'cache-control': result.cacheControl },
  };
}
