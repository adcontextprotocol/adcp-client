import { RequestSignatureError } from './errors';

export interface ParsedSignatureInput {
  label: string;
  components: string[];
  /**
   * The `Signature-Input` value verbatim, minus the `<label>=` prefix. Used to
   * reconstruct the `@signature-params` line in the signature base so verifier
   * and signer stay byte-identical regardless of the sender's param ordering.
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

const LABEL_RE = /^([A-Za-z][A-Za-z0-9_-]*)=/;
const INTEGER_RE = /^-?\d+$/;
const NUMERIC_PARAMS = new Set(['created', 'expires']);
const STRING_PARAMS = new Set(['nonce', 'keyid', 'alg', 'tag']);

export function parseSignatureInput(headerValue: string): ParsedSignatureInput {
  const inputs = splitTopLevelLabels(headerValue, 'Signature-Input');
  let selected: string | undefined;
  for (const entry of inputs) {
    const labelMatch = entry.match(LABEL_RE);
    if (labelMatch && labelMatch[1] === 'sig1') {
      selected = entry;
      break;
    }
  }
  if (!selected) selected = inputs[0];
  if (!selected) {
    throw new RequestSignatureError('request_signature_header_malformed', 1, 'Signature-Input header is empty');
  }
  const labelMatch = selected.match(LABEL_RE);
  if (!labelMatch || !labelMatch[1]) {
    throw new RequestSignatureError(
      'request_signature_header_malformed',
      1,
      'Signature-Input header missing label prefix'
    );
  }
  const label = labelMatch[1];
  const remainder = selected.slice(labelMatch[0].length);
  const openParen = remainder.indexOf('(');
  const closeParen = remainder.indexOf(')');
  if (openParen !== 0 || closeParen < 0) {
    throw new RequestSignatureError(
      'request_signature_header_malformed',
      1,
      'Signature-Input value must begin with a parenthesized component list'
    );
  }
  const componentsRaw = remainder.slice(1, closeParen);
  const components: string[] = [];
  const compRe = /"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = compRe.exec(componentsRaw)) !== null) {
    if (m[1]) components.push(m[1]);
  }
  const paramsRaw = remainder.slice(closeParen + 1);
  const params = parseParams(paramsRaw);
  return { label, components, signatureParamsValue: remainder, params };
}

export function parseSignature(headerValue: string, expectedLabel: string): ParsedSignature {
  const entries = splitTopLevelLabels(headerValue, 'Signature');
  for (const raw of entries) {
    const labelMatch = raw.match(LABEL_RE);
    if (!labelMatch) continue;
    const label = labelMatch[1];
    if (label !== expectedLabel) continue;
    const rest = raw.slice(labelMatch[0].length).trim();
    // sf-binary values are ":<base64>:", optionally followed by `;param=value` pairs.
    if (!rest.startsWith(':')) {
      throw new RequestSignatureError(
        'request_signature_header_malformed',
        1,
        'Signature value must begin with a : byte-sequence delimiter'
      );
    }
    const closeIdx = rest.indexOf(':', 1);
    if (closeIdx < 0) {
      throw new RequestSignatureError(
        'request_signature_header_malformed',
        1,
        'Signature value is missing the closing : byte-sequence delimiter'
      );
    }
    const b64 = rest.slice(1, closeIdx);
    if (!isValidBase64(b64)) {
      throw new RequestSignatureError(
        'request_signature_header_malformed',
        1,
        'Signature value contains non-base64 characters'
      );
    }
    const bytes = Buffer.from(b64, 'base64');
    return { label: label as string, bytes: new Uint8Array(bytes) };
  }
  throw new RequestSignatureError(
    'request_signature_header_malformed',
    1,
    `Signature header does not contain label "${expectedLabel}"`
  );
}

function splitTopLevelLabels(headerValue: string, headerName: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let buf = '';
  for (let i = 0; i < headerValue.length; i++) {
    const ch = headerValue[i];
    if (inString) {
      // RFC 8941 §3.3.3: inside a string, `\` introduces a literal-escape
      // that consumes the following byte (either `\` or `"`). Track the pair
      // explicitly so `\\"` doesn't prematurely close the string.
      if (ch === '\\') {
        const next = headerValue[i + 1];
        if (next === undefined) {
          throw new RequestSignatureError(
            'request_signature_header_malformed',
            1,
            `${headerName} header ends mid-escape`
          );
        }
        buf += ch + next;
        i += 1;
        continue;
      }
      buf += ch;
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      buf += ch;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (inString) {
    throw new RequestSignatureError(
      'request_signature_header_malformed',
      1,
      `${headerName} header has an unterminated quoted string`
    );
  }
  if (buf.trim().length) parts.push(buf.trim());
  if (parts.length === 0) {
    throw new RequestSignatureError('request_signature_header_malformed', 1, `${headerName} header is empty`);
  }
  return parts;
}

function parseParams(raw: string): ParsedSignatureInput['params'] {
  const params: Record<string, string | number> = {};
  for (const pair of raw.split(';')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq < 0) {
      throw new RequestSignatureError(
        'request_signature_header_malformed',
        1,
        `Malformed signature parameter (no '=') in "${pair}"`
      );
    }
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (value === '') {
      throw new RequestSignatureError(
        'request_signature_header_malformed',
        1,
        `Signature parameter "${key}" has an empty value`
      );
    }
    if (STRING_PARAMS.has(key)) {
      if (!value.startsWith('"') || !value.endsWith('"') || value.length < 2) {
        throw new RequestSignatureError(
          'request_signature_header_malformed',
          1,
          `Signature parameter "${key}" must be a quoted string`
        );
      }
      params[key] = value.slice(1, -1);
    } else if (NUMERIC_PARAMS.has(key)) {
      if (!INTEGER_RE.test(value)) {
        throw new RequestSignatureError(
          'request_signature_header_malformed',
          1,
          `Signature parameter "${key}" must be an integer`
        );
      }
      params[key] = Number(value);
    } else if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      params[key] = value.slice(1, -1);
    } else if (INTEGER_RE.test(value)) {
      params[key] = Number(value);
    } else {
      throw new RequestSignatureError(
        'request_signature_header_malformed',
        1,
        `Signature parameter "${key}" is neither a quoted string nor an integer`
      );
    }
  }
  return params as ParsedSignatureInput['params'];
}

function isValidBase64(input: string): boolean {
  // Accept standard base64 + base64url, with or without padding; reject any
  // other characters (incl. whitespace) so truncated signatures don't silently
  // decode to a short-but-"valid" byte buffer.
  return /^[A-Za-z0-9+/_-]*={0,2}$/.test(input);
}
