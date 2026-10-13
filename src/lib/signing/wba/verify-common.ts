import { jwkToPublicKey, verifySignature } from '../crypto';
import type { AdcpJsonWebKey, AdcpSignAlg } from '../types';
import type { InnerList, Item } from 'structured-headers';
import { WBA_CLOCK_SKEW_SECONDS, WBA_MAX_SIGNATURE_LIFETIME_SECONDS } from './constants';
import { WebBotAuthError } from './errors';
import { directoryKeyAlgorithm } from './keys';
import { isInnerList } from './structured';

/**
 * Profile parameter and window checks. Request signatures: `expires` at most
 * 300 s after `created`, with 60 s of skew. Directory responses carry their
 * own lifetime and get no skew: a `created` in the future is rejected.
 */
export function wbaSignatureWindow(
  member: InnerList,
  now: number,
  options: { directory?: boolean; label?: string } = {}
): void {
  const params = member[1];
  const label = options.label;
  const fail = (reason: string) => new WebBotAuthError(reason, label !== undefined ? { label } : {});
  if (typeof params.get('tag') !== 'string') throw fail('signature tag must be an sf-string');
  const created = params.get('created');
  const expires = params.get('expires');
  if (
    typeof created !== 'number' ||
    !Number.isInteger(created) ||
    typeof expires !== 'number' ||
    !Number.isInteger(expires)
  ) {
    throw fail('missing integer created/expires parameter');
  }
  if (expires <= created || (options.directory !== true && expires - created > WBA_MAX_SIGNATURE_LIFETIME_SECONDS)) {
    throw fail('invalid signature lifetime');
  }
  const skew = options.directory === true ? 0 : WBA_CLOCK_SKEW_SECONDS;
  if (created > now + skew || expires < now - skew) throw fail('signature outside its validity window');
  const keyid = params.get('keyid');
  if (typeof keyid !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(keyid)) throw fail('missing thumbprint keyid');
}

/**
 * Verify one signature with a directory key. The algorithm comes from the
 * key; an `alg` parameter, when present, must be a string that matches it.
 */
export function verifyWbaSignatureBytes(
  member: InnerList,
  signature: Item | InnerList | undefined,
  jwk: AdcpJsonWebKey,
  base: string,
  label: string
): AdcpSignAlg {
  const alg = directoryKeyAlgorithm(jwk as Record<string, unknown>);
  const declared = member[1].get('alg');
  if (declared !== undefined && declared !== alg) {
    throw new WebBotAuthError('signature algorithm does not match key', { label });
  }
  if (!signature || isInnerList(signature) || !(signature[0] instanceof ArrayBuffer)) {
    throw new WebBotAuthError('signature must be an sf-binary item', { status: 400, label });
  }
  let valid = false;
  try {
    valid = verifySignature(alg, jwkToPublicKey(jwk), Buffer.from(base, 'utf8'), new Uint8Array(signature[0]));
  } catch (error) {
    throw new WebBotAuthError('invalid verification key', { label, cause: error });
  }
  if (!valid) throw new WebBotAuthError('signature did not verify', { label });
  return alg;
}
