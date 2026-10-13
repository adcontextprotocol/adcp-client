/**
 * Experimental (AdCP 3.3) fetch wrapper that signs outbound requests under
 * the Web Bot Auth profile. Opt-in only: the RFC 9421 wrappers never emit
 * `Signature-Agent`.
 */
import { assertFetchTargetCanBeSigned, type FetchLike } from '../fetch';
import type { SigningProvider } from '../provider';
import type { AdcpJsonWebKey } from '../types';
import { WEB_BOT_AUTH_TAG } from './constants';
import { publicDirectoryKey, toPrivateKeyObject } from './keys';
import { webBotAuthOrigin } from './origin';
import { signWebBotAuthRequest, signWebBotAuthRequestAsync, type WebBotAuthSignerKey } from './sign';

const RESERVED = new Set(['signature', 'signature-input', 'signature-agent', 'content-digest']);

export interface WebBotAuthSigningFetchOptions {
  /** This agent's origin; its key directory must publish the key. */
  agentOrigin: string;
  /** Decide per request; defaults to signing every non-GET request. */
  shouldSign?: (url: string, init: RequestInit | undefined) => boolean;
  /** Called before signing; throw to refuse (e.g. the seller does not accept the profile). */
  beforeSign?: (url: string, init: RequestInit | undefined) => void;
  now?: () => number;
}

export type WebBotAuthSigner =
  | WebBotAuthSignerKey
  | (Pick<SigningProvider, 'keyid' | 'algorithm' | 'sign'> & { publicKey?: AdcpJsonWebKey });

/** Wrap `upstream` so selected requests are signed with the Web Bot Auth profile. */
export function createWebBotAuthSigningFetch(
  upstream: FetchLike,
  signer: WebBotAuthSigner,
  options: WebBotAuthSigningFetchOptions
): FetchLike {
  const agentOrigin = webBotAuthOrigin(options.agentOrigin);
  if ('privateKey' in signer) {
    const kid = publicDirectoryKey(toPrivateKeyObject(signer.privateKey)).kid;
    if (signer.keyid !== undefined && signer.keyid !== kid) {
      throw new TypeError('Web Bot Auth keyid must be the key’s RFC 7638 thumbprint');
    }
  } else if (!/^[A-Za-z0-9_-]{43}$/.test(signer.keyid)) {
    throw new TypeError('Web Bot Auth provider keyid must be the key’s RFC 7638 thumbprint');
  }
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const shouldSign = options.shouldSign ?? (() => method !== 'GET');
    if (!shouldSign(url, init)) return upstream(input, init);
    if (input instanceof Request) {
      throw new TypeError('Web Bot Auth signing fetch does not accept Request objects; pass a URL and init');
    }
    assertFetchTargetCanBeSigned(url, 'createWebBotAuthSigningFetch');
    options.beforeSign?.(url, init);
    const headers = headersToRecord(init?.headers);
    for (const name of Object.keys(headers)) if (RESERVED.has(name.toLowerCase())) delete headers[name];
    const body = bodyToString(init?.body);
    if (body !== undefined && body.length > 0 && !Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) {
      headers['content-type'] = 'application/json';
    }
    const request = { method, url, headers, ...(body !== undefined && { body }) };
    const signOptions = { agentOrigin, ...(options.now !== undefined && { now: options.now }) };
    const signed =
      'privateKey' in signer
        ? signWebBotAuthRequest(request, signer, signOptions)
        : await signWebBotAuthRequestAsync(request, signer, signOptions);
    const mergedInit: RequestInit = { ...init, method, headers: signed.headers };
    if (body !== undefined && mergedInit.body === undefined) mergedInit.body = body;
    return upstream(url, mergedInit);
  };
}

/** Whether a capability block lists the Web Bot Auth profile. Omission means RFC 9421 only. */
export function acceptsWebBotAuth(capability: { profiles?: readonly string[] } | undefined): boolean {
  return Array.isArray(capability?.profiles) && capability!.profiles.includes(WEB_BOT_AUTH_TAG);
}

function headersToRecord(headers: HeadersInit | Headers | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...(headers as Record<string, string>) };
}

function bodyToString(body: RequestInit['body']): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  const bytes = body instanceof Uint8Array ? body : body instanceof ArrayBuffer ? new Uint8Array(body) : undefined;
  if (!bytes) {
    throw new TypeError('Web Bot Auth signing requires a string, Uint8Array, or ArrayBuffer body');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError('Web Bot Auth signing received a body that is not valid UTF-8');
  }
}
