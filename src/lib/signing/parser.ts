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

function normalizeByteSequenceBase64(input: string): string {
  let out = '';
  let inString = false;
  let inBytes = false;
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
      } else if (ch === '-') out += '+';
      else if (ch === '_') out += '/';
      else out += ch;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === ':') inBytes = true;
    out += ch;
  }
  return out;
}
