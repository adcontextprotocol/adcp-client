/**
 * Experimental (AdCP 3.3): sign the revocation list a Web Bot Auth identity
 * publishes at `https://O/.well-known/governance-revocations.json`.
 */
import { sign as nodeSign, type KeyObject } from 'node:crypto';
import type { AdcpJsonWebKey } from '../types';
import { ORIGIN_REVOCATION_PATH, REVOCATION_LIST_TYP } from './constants';
import { directoryKeyAlgorithm, publicDirectoryKey, toPrivateKeyObject } from './keys';
import { webBotAuthOrigin } from './origin';

/** RFC 5280 reason codes accepted in `revocation_details`. */
export type RevocationListReason =
  | 'unspecified'
  | 'keyCompromise'
  | 'cACompromise'
  | 'affiliationChanged'
  | 'superseded'
  | 'cessationOfOperation'
  | 'certificateHold'
  | 'removeFromCRL'
  | 'privilegeWithdrawn'
  | 'aACompromise';

export interface SignRevocationListOptions {
  agentOrigin: string;
  /** A key the origin's directory publishes. */
  privateKey: AdcpJsonWebKey | KeyObject | string;
  /** Thumbprints of revoked keys. Keep every key ever revoked: lists never un-revoke. */
  revokedKids?: readonly string[];
  /** Optional RFC 5280 detail per revoked kid. */
  revocationDetails?: Record<string, { reason?: RevocationListReason; invalidity_date?: string }>;
  /** Epoch seconds for `updated`. Defaults to now. */
  updated?: number;
  /** Seconds until `next_update`: 60–1800 (the polling floor and ceiling). Default 900. */
  nextUpdateInSeconds?: number;
}

export interface SignedRevocationList {
  /** Compact JWS (`typ: adcp-gov-revocation+jws`) to serve as the body. */
  body: string;
  /** URL to serve it at. */
  url: string;
  payload: Record<string, unknown>;
  /** Re-sign and republish before this instant (epoch seconds). */
  nextUpdate: number;
}

/**
 * Produce the compact JWS revocation list. Verifiers poll it on
 * `next_update` and fail closed for spend-committing requests once it is
 * stale, so publish on a schedule shorter than `nextUpdateInSeconds`.
 */
export function signRevocationList(options: SignRevocationListOptions): SignedRevocationList {
  const origin = webBotAuthOrigin(options.agentOrigin);
  const privateKey = toPrivateKeyObject(options.privateKey);
  const jwk = publicDirectoryKey(privateKey);
  const alg = directoryKeyAlgorithm(jwk);
  const updated = options.updated ?? Math.floor(Date.now() / 1000);
  const cadence = options.nextUpdateInSeconds ?? 900;
  if (!Number.isInteger(updated) || updated < 0) throw new TypeError('updated must be a non-negative integer');
  if (!Number.isInteger(cadence) || cadence < 60 || cadence > 1800) {
    throw new TypeError('nextUpdateInSeconds must be an integer from 60 to 1800');
  }
  const revokedKids = [...new Set(options.revokedKids ?? [])];
  for (const kid of revokedKids) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(kid)) throw new TypeError(`revoked kid ${kid} is not an RFC 7638 thumbprint`);
  }
  for (const kid of Object.keys(options.revocationDetails ?? {})) {
    if (!revokedKids.includes(kid)) throw new TypeError('revocationDetails may only describe revokedKids');
  }
  const iso = (seconds: number) => new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const payload: Record<string, unknown> = {
    version: 1,
    issuer: origin,
    updated: iso(updated),
    next_update: iso(updated + cadence),
    revoked_kids: revokedKids,
    revoked_jtis: [],
    ...(options.revocationDetails !== undefined && { revocation_details: options.revocationDetails }),
  };
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = b64({ alg: alg === 'ed25519' ? 'EdDSA' : 'ES256', kid: jwk.kid, typ: REVOCATION_LIST_TYP });
  const body = b64(payload);
  const input = Buffer.from(`${header}.${body}`, 'ascii');
  const signature =
    alg === 'ed25519'
      ? nodeSign(null, input, privateKey)
      : nodeSign('sha256', input, { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return {
    body: `${header}.${body}.${signature.toString('base64url')}`,
    url: origin + ORIGIN_REVOCATION_PATH,
    payload,
    nextUpdate: updated + cadence,
  };
}
