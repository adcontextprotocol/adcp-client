import { ParseError, parseDictionary, serializeInnerList, type InnerList } from 'structured-headers';
import { RequestSignatureError } from './errors';

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

export function parseSignatureInput(headerValue: string): ParsedSignatureInput {
  rejectDuplicateDictionaryKeys(headerValue, 'Signature-Input');
  let dict;
  try {
    dict = parseDictionary(headerValue);
  } catch (e: unknown) {
    if (e instanceof ParseError) malformed(`Signature-Input header is malformed: ${e.message}`);
    throw e;
  }
  if (dict.size === 0) malformed('Signature-Input header is empty');
  const label = dict.has('sig1') ? 'sig1' : (dict.keys().next().value as string);
  const entry = dict.get(label)!;
  if (!isInnerList(entry)) {
    malformed('Signature-Input value must be a parenthesized component list');
  }
  const components: string[] = [];
  for (const [bare] of entry[0]) {
    if (typeof bare !== 'string') malformed('Signature-Input components must all be strings');
    components.push(bare);
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

export function parseSignature(headerValue: string, expectedLabel: string): ParsedSignature {
  let dict;
  try {
    // RFC 9421 signatures commonly use base64url (`-`/`_`); RFC 8941 byte
    // sequences only permit standard base64. Translate the characters inside
    // byte-sequence delimiters before handing to the strict parser.
    dict = parseDictionary(normalizeByteSequenceBase64(headerValue));
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
 * RFC 8941 §3.2 parsers deduplicate by keeping the last value. The AdCP
 * profile (step 1) overrides that: duplicate keys are a downgrade vector —
 * a proxy could smuggle a weaker component set past a verifier that reads
 * the first. Detect duplicates at the raw-header level before the library
 * silently drops them.
 */
export function rejectDuplicateDictionaryKeys(headerValue: string, headerName: string): void {
  const keys = extractTopLevelDictKeys(headerValue);
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) {
      malformed(`${headerName} header declares key "${key}" more than once`);
    }
    seen.add(key);
  }
}

function extractTopLevelDictKeys(input: string): string[] {
  const keys: string[] = [];
  let i = 0;
  const len = input.length;
  let atEntryStart = true;
  while (i < len) {
    if (atEntryStart) {
      while (i < len && (input[i] === ' ' || input[i] === '\t')) i++;
      const keyStart = i;
      while (i < len && /[A-Za-z0-9_*-]/.test(input[i]!)) i++;
      if (i > keyStart) keys.push(input.slice(keyStart, i).toLowerCase());
      atEntryStart = false;
      continue;
    }
    const ch = input[i]!;
    if (ch === '"') {
      i++;
      while (i < len) {
        if (input[i] === '\\' && i + 1 < len) {
          i += 2;
          continue;
        }
        if (input[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === ':') {
      i++;
      while (i < len && input[i] !== ':') i++;
      if (i < len) i++;
      continue;
    }
    if (ch === '(') {
      i++;
      let depth = 1;
      while (i < len && depth > 0) {
        const c = input[i]!;
        if (c === '"') {
          i++;
          while (i < len) {
            if (input[i] === '\\' && i + 1 < len) {
              i += 2;
              continue;
            }
            if (input[i] === '"') {
              i++;
              break;
            }
            i++;
          }
          continue;
        }
        if (c === '(') depth++;
        else if (c === ')') depth--;
        i++;
      }
      continue;
    }
    if (ch === ',') {
      atEntryStart = true;
      i++;
      continue;
    }
    i++;
  }
  return keys;
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
