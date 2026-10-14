import { ParseError, parseDictionary, serializeInnerList, serializeItem, type InnerList } from 'structured-headers';
import { RequestSignatureError } from './errors';
import { isPaddedStandardBase64, type SfBinaryEncoding } from './content-digest';

export interface ParsedSignatureInput {
  label: string;
  components: string[];
  /**
   * The `Signature-Input` value verbatim for the selected label (minus the
   * `<label>=` prefix). Re-emitted as the `@signature-params` line in the
   * signature base so verifier and signer stay byte-identical regardless of
   * the sender's param ordering.
   */
  signatureParamsValue: string;
  params: {
    created: number;
    expires: number;
    nonce: string;
    keyid: string;
    alg: string;
    tag: string;
    [extra: string]: string | number | undefined;
  };
}

export interface ParsedSignature {
  label: string;
  bytes: Uint8Array;
}

const STRING_PARAMS = new Set(['nonce', 'keyid', 'alg', 'tag']);
const INTEGER_PARAMS = new Set(['created', 'expires']);

function malformed(message: string): never {
  throw new RequestSignatureError('request_signature_header_malformed', 1, message);
}

export function parseSignatureInput(headerValue: string, expectedLabel?: string): ParsedSignatureInput {
  rejectDuplicateDictionaryKeys(headerValue, 'Signature-Input');
  let dict;
  try {
    dict = parseDictionary(headerValue);
  } catch (e: unknown) {
    if (e instanceof ParseError) malformed(`Signature-Input header is malformed: ${e.message}`);
    throw e;
  }
  if (dict.size === 0) malformed('Signature-Input header is empty');
  const label = expectedLabel ?? (dict.has('sig1') ? 'sig1' : (dict.keys().next().value as string));
  if (!dict.has(label)) malformed('Signature-Input label is missing');
  const entry = dict.get(label)!;
  if (!isInnerList(entry)) {
    malformed('Signature-Input value must be a parenthesized component list');
  }
  const components: string[] = [];
  for (const [bare, itemParams] of entry[0]) {
    if (typeof bare !== 'string') malformed('Signature-Input components must all be strings');
    // Preserve parameters rather than verifying a different component when
    // a sender selects a dictionary member or an unsupported parameter.
    const serialized = serializeItem([bare, itemParams]);
    components.push(`${bare}${serialized.slice(serialized.indexOf('"', 1) + 1)}`);
  }
  const params: Record<string, string | number> = {};
  for (const [key, value] of entry[1]) {
    if (STRING_PARAMS.has(key)) {
      if (typeof value !== 'string') {
        malformed(`Signature parameter "${key}" must be a quoted string`);
      }
      params[key] = value;
    } else if (INTEGER_PARAMS.has(key)) {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        malformed(`Signature parameter "${key}" must be an integer`);
      }
      params[key] = value;
    } else if (typeof value === 'string' || typeof value === 'number') {
      params[key] = value;
    }
  }
  return {
    label,
    components,
    signatureParamsValue: serializeInnerList(entry),
    params: params as ParsedSignatureInput['params'],
  };
}

export function parseSignature(
  headerValue: string,
  expectedLabel: string,
  encoding: SfBinaryEncoding = 'legacy-base64url'
): ParsedSignature {
  rejectDuplicateDictionaryKeys(headerValue, 'Signature');
  const escapedLabel = expectedLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rawBytes = headerValue.match(new RegExp(`(?:^|,\\s*)${escapedLabel}\\s*=\\s*:([^:]+):`))?.[1];
  if (!rawBytes) malformed(`Signature header does not contain a byte sequence for label "${expectedLabel}"`);
  if (encoding === 'rfc8941-base64') {
    // AdCP 3.2: RFC 8941 sf-binary is padded standard Base64. Reject the
    // Base64URL alphabet (`-`/`_`) and missing padding here, at step 1, so a
    // legacy token never reaches the window or crypto checks.
    if (!isPaddedStandardBase64(rawBytes)) {
      malformed('Signature value must use padded standard Base64 for AdCP 3.2+');
    }
  } else if (!/^[A-Za-z0-9_-]+$/.test(rawBytes)) {
    malformed('Signature value must use unpadded Base64URL for AdCP 3.0/3.1');
  }
  let dict;
  try {
    // AdCP 3.2 parses the whole field as a strict RFC 8941 Dictionary, so a
    // Base64URL byte sequence under any label is malformed. The 3.0/3.1
    // profile encoded byte sequences as Base64URL (`-`/`_`); translate those
    // characters inside byte-sequence delimiters before the strict parser.
    dict = parseDictionary(encoding === 'rfc8941-base64' ? headerValue : normalizeByteSequenceBase64(headerValue));
  } catch (e: unknown) {
    if (e instanceof ParseError) {
      if (/base64/i.test(e.message)) malformed('Signature value contains non-base64 characters');
      malformed(`Signature header is malformed: ${e.message}`);
    }
    throw e;
  }
  const entry = dict.get(expectedLabel);
  if (!entry) {
    malformed(`Signature header does not contain label "${expectedLabel}"`);
  }
  if (!(entry[0] instanceof ArrayBuffer)) {
    malformed(`Signature value for "${expectedLabel}" must be a byte sequence`);
  }
  return { label: expectedLabel, bytes: new Uint8Array(entry[0].slice(0)) };
}

function isInnerList(entry: unknown): entry is InnerList {
  return Array.isArray(entry) && Array.isArray((entry as unknown[])[0]);
}

/**
 * RFC 8941 / RFC 9651 parsers deduplicate dictionary keys and parameter keys
 * by keeping the last value. The AdCP profile (step 1) overrides that:
 * duplicates are a cross-implementation differential and a downgrade vector
 * (a proxy could smuggle a weaker component set or a different `created`,
 * `keyid` or `tag` past a verifier that reads the first). Detect them at the
 * raw-header level before the library silently drops them: top-level
 * dictionary keys, parameters on members and inner lists, and parameters on
 * each inner-list item.
 */
export function rejectDuplicateDictionaryKeys(headerValue: string, headerName: string): void {
  const duplicate = findDuplicateStructuredKey(headerValue);
  if (duplicate?.kind === 'member') malformed(`${headerName} header declares key "${duplicate.key}" more than once`);
  if (duplicate) malformed(`${headerName} header declares parameter "${duplicate.key}" more than once`);
}

/**
 * Tolerant RFC 8941 dictionary walk that only reports duplicate keys. Syntax
 * it does not recognise ends the walk; the strict parser rejects it later.
 */
function findDuplicateStructuredKey(input: string): { kind: 'member' | 'parameter'; key: string } | undefined {
  let i = 0;
  const n = input.length;
  const ows = () => {
    while (i < n && (input[i] === ' ' || input[i] === '\t')) i++;
  };
  const key = () => {
    const start = i;
    while (i < n && /[A-Za-z0-9_.*-]/.test(input[i]!)) i++;
    return input.slice(start, i).toLowerCase();
  };
  const bareItem = () => {
    if (input[i] === '%' && input[i + 1] === '"') {
      // RFC 9651 display string: percent-encoded, so a backslash is an
      // ordinary character and the next '"' always ends it.
      i += 2;
      while (i < n && input[i] !== '"') i++;
      i++;
      return;
    }
    if (input[i] === '"') {
      i++;
      while (i < n) {
        if (input[i] === '\\') {
          i += 2;
          continue;
        }
        if (input[i++] === '"') return;
      }
      return;
    }
    if (input[i] === ':') {
      i++;
      while (i < n && input[i] !== ':') i++;
      i++;
      return;
    }
    while (i < n && !/[;,()\s"]/.test(input[i]!)) i++;
  };
  const parameters = (): string | undefined => {
    const seen = new Set<string>();
    while (i < n && input[i] === ';') {
      i++;
      ows();
      const k = key();
      if (!k) return undefined;
      if (seen.has(k)) return k;
      seen.add(k);
      if (input[i] === '=') {
        i++;
        bareItem();
      }
    }
    return undefined;
  };
  const members = new Set<string>();
  while (i < n) {
    ows();
    const k = key();
    if (!k) return undefined;
    if (members.has(k)) return { kind: 'member', key: k };
    members.add(k);
    let duplicate: string | undefined;
    if (input[i] === '=') {
      i++;
      if (input[i] === '(') {
        i++;
        for (;;) {
          while (i < n && input[i] === ' ') i++;
          if (i >= n) return undefined;
          if (input[i] === ')') {
            i++;
            break;
          }
          const before = i;
          bareItem();
          duplicate = parameters();
          if (duplicate) return { kind: 'parameter', key: `${k}: ${duplicate}` };
          if (i === before) return undefined;
        }
        duplicate = parameters();
      } else {
        bareItem();
        duplicate = parameters();
      }
    } else duplicate = parameters();
    if (duplicate) return { kind: 'parameter', key: `${k}: ${duplicate}` };
    ows();
    if (i >= n) return undefined;
    if (input[i] !== ',') return undefined;
    i++;
  }
  return undefined;
}

/**
 * Translate base64url (`-`/`_`) inside byte-sequence delimiters to standard
 * base64 (`+`/`/`) so the strict RFC 8941 parser accepts the value. Enforces
 * the spec's single-alphabet rule: a byte-sequence token that mixes
 * base64url (`[-_]`) with standard base64 (`[+/=]`) is ambiguous and MUST
 * be rejected (`webhook_signature_header_malformed` / `request_signature_header_malformed`
 * per profile).
 */
function normalizeByteSequenceBase64(input: string): string {
  let out = '';
  let inString = false;
  let inBytes = false;
  let sawStandardAlphabet = false;
  let sawUrlSafeAlphabet = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < input.length) {
        out += input[++i]!;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (inBytes) {
      if (ch === ':') {
        inBytes = false;
        out += ch;
        if (sawStandardAlphabet && sawUrlSafeAlphabet) {
          malformed('Signature value mixes base64url and standard-base64 alphabets');
        }
        sawStandardAlphabet = false;
        sawUrlSafeAlphabet = false;
      } else if (ch === '-') {
        sawUrlSafeAlphabet = true;
        out += '+';
      } else if (ch === '_') {
        sawUrlSafeAlphabet = true;
        out += '/';
      } else {
        if (ch === '+' || ch === '/' || ch === '=') sawStandardAlphabet = true;
        out += ch;
      }
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === ':') inBytes = true;
    out += ch;
  }
  return out;
}
