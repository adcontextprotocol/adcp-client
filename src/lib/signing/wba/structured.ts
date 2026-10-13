/**
 * Strict RFC 8941 dictionary parsing and the RFC 9421 signature base for the
 * Web Bot Auth profile.
 *
 * The profile's covered components include dictionary-member field
 * components (`"signature-agent";key="sig1"`, and a relay's
 * `"signature";key="brand"`), which the RFC 9421 request profile's
 * canonicalizer does not model, so this module builds WBA bases itself while
 * reusing the shared `@target-uri` / `@authority` canonicalization.
 */
import {
  ParseError,
  parseDictionary,
  serializeInnerList,
  serializeItem,
  type BareItem,
  type Dictionary,
  type InnerList,
  type Item,
} from 'structured-headers';
import { canonicalAuthority, canonicalTargetUri, getHeaderValue } from '../canonicalize';
import { WBA_MAX_SIGNATURE_FIELD_BYTES } from './constants';
import { WebBotAuthError } from './errors';

export type HeaderBag = Record<string, string | string[] | undefined>;

/**
 * Parse a Structured Fields dictionary, rejecting what RFC 8941 parsers would
 * silently repair: duplicate member keys and duplicate parameters keep their
 * last value in a conforming parser, which would let a proxy or an attacker
 * hide evidence a verifier relies on. Any failure is a `400`.
 */
export function parseStrictDictionary(value: string | undefined, field: string): Dictionary {
  if (value === undefined || value.length === 0 || Buffer.byteLength(value, 'utf8') > WBA_MAX_SIGNATURE_FIELD_BYTES) {
    throw new WebBotAuthError(`missing or oversized ${field} field`, { status: 400 });
  }
  if (!/^[\x20-\x7e]*$/.test(value)) {
    throw new WebBotAuthError(`${field} contains non-ASCII or control characters`, { status: 400 });
  }
  const duplicate = findDuplicateKeyOrParameter(value);
  if (duplicate) throw new WebBotAuthError(`duplicate ${duplicate} in ${field}`, { status: 400 });
  let dictionary: Dictionary;
  try {
    dictionary = parseDictionary(value);
  } catch (error) {
    if (error instanceof ParseError || error instanceof Error) {
      throw new WebBotAuthError(`malformed ${field} field`, { status: 400, cause: error });
    }
    throw error;
  }
  if (dictionary.size === 0) throw new WebBotAuthError(`empty ${field} field`, { status: 400 });
  return dictionary;
}

export function isInnerList(value: Item | InnerList | undefined): value is InnerList {
  return Array.isArray(value) && Array.isArray(value[0]);
}

/**
 * Walk the RFC 8941 dictionary grammar and report the first duplicate member
 * key or parameter key within one parameter scope. Syntax errors are left to
 * the real parser; this scan only looks for ambiguity a parser would hide.
 */
export function findDuplicateKeyOrParameter(input: string): string | undefined {
  let pos = 0;
  const len = input.length;
  const keyRe = /^[a-z*][a-z0-9_\-.*]*/;
  const skipSp = () => {
    while (pos < len && input[pos] === ' ') pos++;
  };
  const skipOws = () => {
    while (pos < len && (input[pos] === ' ' || input[pos] === '\t')) pos++;
  };
  const readKey = (): string | undefined => {
    const match = keyRe.exec(input.slice(pos));
    if (!match) return undefined;
    pos += match[0].length;
    return match[0];
  };
  const skipBareItem = (): boolean => {
    const ch = input[pos];
    if (ch === '"' || (ch === '%' && input[pos + 1] === '"')) {
      if (ch === '%') pos++;
      pos++;
      while (pos < len) {
        if (input[pos] === '\\') {
          pos += 2;
          continue;
        }
        if (input[pos] === '"') {
          pos++;
          return true;
        }
        pos++;
      }
      return false;
    }
    if (ch === ':') {
      const end = input.indexOf(':', pos + 1);
      if (end < 0) return false;
      pos = end + 1;
      return true;
    }
    const match = /^(?:\?[01]|@?-?[0-9]+(?:\.[0-9]+)?|[A-Za-z*][!#$%&'*+\-.^_`|~0-9A-Za-z:/]*)/.exec(input.slice(pos));
    if (!match) return false;
    pos += match[0].length;
    return true;
  };
  const scanParameters = (): string | undefined | false => {
    const seen = new Set<string>();
    while (pos < len && input[pos] === ';') {
      pos++;
      skipSp();
      const key = readKey();
      if (key === undefined) return false;
      if (seen.has(key)) return `parameter "${key}"`;
      seen.add(key);
      if (input[pos] === '=') {
        pos++;
        if (!skipBareItem()) return false;
      }
    }
    return undefined;
  };
  const members = new Set<string>();
  skipSp();
  while (pos < len) {
    const key = readKey();
    if (key === undefined) return undefined;
    if (members.has(key)) return `member "${key}"`;
    members.add(key);
    if (input[pos] === '=') {
      pos++;
      if (input[pos] === '(') {
        pos++;
        for (;;) {
          skipSp();
          if (pos >= len) return undefined;
          if (input[pos] === ')') {
            pos++;
            break;
          }
          if (!skipBareItem()) return undefined;
          const inner = scanParameters();
          if (inner === false) return undefined;
          if (inner) return inner;
          if (input[pos] !== ' ' && input[pos] !== ')') return undefined;
        }
      } else if (!skipBareItem()) {
        return undefined;
      }
    }
    const params = scanParameters();
    if (params === false) return undefined;
    if (params) return params;
    skipOws();
    if (pos >= len) return undefined;
    if (input[pos] !== ',') return undefined;
    pos++;
    skipOws();
  }
  return undefined;
}

/** Serialized component identifier, e.g. `"signature-agent";key="sig1"`. */
export function componentIdentifier(component: Item): string {
  return serializeItem(component);
}

export interface SignatureBaseRequest {
  method: string;
  url: string;
  headers: HeaderBag;
}

/**
 * RFC 9421 §2.5 signature base for one WBA `Signature-Input` member.
 * `directoryResponse` admits only `"@authority";req` as a parameterized
 * derived component, which a signed directory response covers (Appendix B.1).
 */
export function wbaSignatureBase(
  request: SignatureBaseRequest,
  member: InnerList,
  options: { directoryResponse?: boolean } = {}
): string {
  const lines: string[] = [];
  for (const component of member[0]) {
    const [name, params] = component;
    if (typeof name !== 'string') {
      throw new WebBotAuthError('covered component must be a string', { status: 400 });
    }
    let value: string;
    if (name.startsWith('@')) {
      const expected = options.directoryResponse === true && name === '@authority' ? ['req'] : [];
      if (params.size !== expected.length || expected.some(key => params.get(key) !== true)) {
        throw new WebBotAuthError('unsupported derived component parameters');
      }
      if (name === '@method') value = request.method.toUpperCase();
      else if (name === '@target-uri') value = canonicalTargetUri(request.url, '3.2');
      else if (name === '@authority') value = canonicalAuthority(request.url, '3.2');
      else throw new WebBotAuthError('unsupported derived component');
    } else {
      if (name !== name.toLowerCase()) throw new WebBotAuthError('field component names must be lowercase');
      const raw = getHeaderValue(request.headers, name);
      if (raw === undefined) throw new WebBotAuthError('covered field is missing');
      if (params.size > 0) {
        const key = params.get('key');
        if (params.size !== 1 || typeof key !== 'string') {
          throw new WebBotAuthError('unsupported field component parameters');
        }
        const dictionary = parseStrictDictionary(raw, name);
        const entry = dictionary.get(key);
        if (entry === undefined) throw new WebBotAuthError('covered dictionary member is missing');
        value = isInnerList(entry) ? serializeInnerList(entry) : serializeItem(entry);
      } else {
        value = raw;
      }
    }
    lines.push(`${componentIdentifier(component)}: ${value}`);
  }
  lines.push(`"@signature-params": ${serializeInnerList(member)}`);
  return lines.join('\n');
}

/** Read a typed parameter from a `Signature-Input` member. */
export function param(member: InnerList, name: string): BareItem | undefined {
  return member[1].get(name);
}

/** Build an inner list from component names and ordered parameters. */
export function innerList(
  components: ReadonlyArray<string | [string, Record<string, BareItem>]>,
  params: ReadonlyArray<[string, BareItem]>
): InnerList {
  return [
    components.map(component =>
      typeof component === 'string'
        ? ([component, new Map()] as Item)
        : ([component[0], new Map(Object.entries(component[1]))] as Item)
    ),
    new Map(params),
  ];
}
