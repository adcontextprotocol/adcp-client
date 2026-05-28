import { createHash } from 'crypto';

export interface UnsafeRegexPattern {
  location: string;
  pattern: string;
  reason: 'nested_unbounded_quantifier' | 'ambiguous_repeated_alternation';
}

interface RegexGroup {
  body: string;
  end: number;
}

type QuantifierInfo = {
  min: number;
  max: number | null;
  end: number;
  unbounded: boolean;
  variable: boolean;
};

const SCHEMA_VALUE_KEYWORDS = new Set([
  'additionalItems',
  'additionalProperties',
  'contains',
  'contentSchema',
  'else',
  'if',
  'items',
  'not',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
]);

const SCHEMA_ARRAY_KEYWORDS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const SCHEMA_MAP_KEYWORDS = new Set(['$defs', 'definitions', 'dependentSchemas', 'properties']);

export function unsafeRegexDetails(pattern: UnsafeRegexPattern): Record<string, unknown> {
  return {
    location: pattern.location,
    reason: pattern.reason,
    patternLength: pattern.pattern.length,
    patternPreview: pattern.pattern.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?').slice(0, 120),
    patternSha256: createHash('sha256').update(pattern.pattern).digest('hex'),
  };
}

export function findUnsafeRegexPattern(root: unknown): UnsafeRegexPattern | undefined {
  const seen = new Set<unknown>();

  function walkSchema(node: unknown, pointer: string): UnsafeRegexPattern | undefined {
    if (!node || typeof node !== 'object') return undefined;
    if (seen.has(node)) return undefined;
    seen.add(node);

    if (Array.isArray(node)) return walkSchemaArray(node, pointer);

    const obj = node as Record<string, unknown>;

    if (typeof obj.pattern === 'string') {
      const unsafe = analyzeRegexPattern(obj.pattern, `${pointer}/pattern`);
      if (unsafe) return unsafe;
    }

    const patternProperties = obj.patternProperties;
    if (patternProperties && typeof patternProperties === 'object' && !Array.isArray(patternProperties)) {
      const basePointer = `${pointer}/patternProperties`;
      for (const [pattern, subschema] of Object.entries(patternProperties as Record<string, unknown>)) {
        const patternPointer = `${basePointer}/${escapeJsonPointer(pattern)}`;
        const unsafe = analyzeRegexPattern(pattern, patternPointer) ?? walkSchema(subschema, patternPointer);
        if (unsafe) return unsafe;
      }
    }

    for (const keyword of SCHEMA_VALUE_KEYWORDS) {
      const unsafe = walkSchemaValue(obj[keyword], `${pointer}/${keyword}`);
      if (unsafe) return unsafe;
    }

    for (const keyword of SCHEMA_ARRAY_KEYWORDS) {
      const unsafe = walkSchemaArrayValue(obj[keyword], `${pointer}/${keyword}`);
      if (unsafe) return unsafe;
    }

    for (const keyword of SCHEMA_MAP_KEYWORDS) {
      const unsafe = walkSchemaMap(obj[keyword], `${pointer}/${keyword}`);
      if (unsafe) return unsafe;
    }

    const dependencies = obj.dependencies;
    if (dependencies && typeof dependencies === 'object' && !Array.isArray(dependencies)) {
      for (const [key, value] of Object.entries(dependencies as Record<string, unknown>)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const unsafe = walkSchema(value, `${pointer}/dependencies/${escapeJsonPointer(key)}`);
        if (unsafe) return unsafe;
      }
    }

    return undefined;
  }

  function walkSchemaValue(value: unknown, pointer: string): UnsafeRegexPattern | undefined {
    if (Array.isArray(value)) return walkSchemaArray(value, pointer);
    return walkSchema(value, pointer);
  }

  function walkSchemaArrayValue(value: unknown, pointer: string): UnsafeRegexPattern | undefined {
    if (!Array.isArray(value)) return undefined;
    return walkSchemaArray(value, pointer);
  }

  function walkSchemaArray(value: readonly unknown[], pointer: string): UnsafeRegexPattern | undefined {
    for (let index = 0; index < value.length; index += 1) {
      const unsafe = walkSchema(value[index], `${pointer}/${index}`);
      if (unsafe) return unsafe;
    }
    return undefined;
  }

  function walkSchemaMap(value: unknown, pointer: string): UnsafeRegexPattern | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    for (const [key, subschema] of Object.entries(value as Record<string, unknown>)) {
      const unsafe = walkSchema(subschema, `${pointer}/${escapeJsonPointer(key)}`);
      if (unsafe) return unsafe;
    }
    return undefined;
  }

  return walkSchema(root, '');
}

function analyzeRegexPattern(pattern: string, location: string): UnsafeRegexPattern | undefined {
  for (const group of collectGroups(pattern)) {
    const quantifier = readQuantifier(pattern, group.end + 1);
    if (!quantifier?.unbounded) continue;

    if (isSingleVariableRepeat(group.body)) {
      return { location, pattern, reason: 'nested_unbounded_quantifier' };
    }
    if (hasAmbiguousAlternationByTokenPrefix(group.body)) {
      return { location, pattern, reason: 'ambiguous_repeated_alternation' };
    }
  }
  return undefined;
}

function collectGroups(pattern: string): RegexGroup[] {
  const groups: RegexGroup[] = [];
  const stack: number[] = [];
  let escaped = false;
  let inClass = false;

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '[') {
      inClass = true;
      continue;
    }
    if (char === ']' && inClass) {
      inClass = false;
      continue;
    }
    if (inClass) continue;
    if (char === '(') {
      stack.push(index);
      continue;
    }
    if (char === ')') {
      const start = stack.pop();
      if (start !== undefined) {
        groups.push({ body: pattern.slice(start + 1, index), end: index });
      }
    }
  }

  return groups;
}

function isSingleVariableRepeat(source: string): boolean {
  const normalized = stripGroupPrefix(source);
  const first = readRegexAtom(normalized, 0);
  if (!first) return false;

  const quantifier = readQuantifier(normalized, first.end);
  if (!quantifier?.variable) return false;

  return quantifier.end === normalized.length;
}

function readRegexAtom(source: string, index: number): { end: number } | undefined {
  const char = source[index];
  if (!char) return undefined;

  if (char === '\\') {
    return index + 1 < source.length ? { end: index + 2 } : undefined;
  }
  if (char === '[') {
    return readCharacterClass(source, index);
  }
  if (char === '(') {
    return readGroup(source, index);
  }
  if ('^$|?*+{}'.includes(char)) return undefined;
  return { end: index + 1 };
}

function readCharacterClass(source: string, index: number): { end: number } | undefined {
  let escaped = false;

  for (let cursor = index + 1; cursor < source.length; cursor += 1) {
    const char = source[cursor];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === ']') return { end: cursor + 1 };
  }

  return undefined;
}

function readGroup(source: string, index: number): { end: number } | undefined {
  let escaped = false;
  let inClass = false;
  let depth = 0;

  for (let cursor = index; cursor < source.length; cursor += 1) {
    const char = source[cursor];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '[') {
      inClass = true;
      continue;
    }
    if (char === ']' && inClass) {
      inClass = false;
      continue;
    }
    if (inClass) continue;
    if (char === '(') {
      depth += 1;
      continue;
    }
    if (char === ')') {
      depth -= 1;
      if (depth === 0) return { end: cursor + 1 };
    }
  }

  return undefined;
}

function readQuantifier(source: string, index: number): QuantifierInfo | undefined {
  const char = source[index];
  if (char === '?') return { min: 0, max: 1, end: index + 1, unbounded: false, variable: true };
  if (char === '*') return { min: 0, max: null, end: index + 1, unbounded: true, variable: true };
  if (char === '+') return { min: 1, max: null, end: index + 1, unbounded: true, variable: true };
  if (char !== '{') return undefined;

  const match = /^\{(\d+)(?:,(\d*))?\}/.exec(source.slice(index));
  if (!match) return undefined;

  const min = Number(match[1]);
  const max = match[2] === '' ? null : Number(match[2] ?? match[1]);
  return {
    min,
    max,
    end: index + match[0].length,
    unbounded: max === null,
    variable: max === null || min !== max,
  };
}

function hasAmbiguousAlternationByTokenPrefix(source: string): boolean {
  const alternatives = splitTopLevelAlternatives(stripGroupPrefix(source));
  if (alternatives.length < 2) return false;

  const tokenized = alternatives.map(tokenizeRegexAtoms).filter(tokens => tokens.length > 0);
  for (let left = 0; left < tokenized.length; left += 1) {
    for (let right = 0; right < tokenized.length; right += 1) {
      const leftTokens = tokenized[left];
      const rightTokens = tokenized[right];
      if (leftTokens && rightTokens && left !== right && tokensStartWith(rightTokens, leftTokens)) return true;
    }
  }
  return false;
}

function tokenizeRegexAtoms(source: string): string[] {
  const tokens: string[] = [];
  let cursor = 0;

  while (cursor < source.length) {
    const atom = readRegexAtom(source, cursor);
    if (!atom) break;
    const raw = source.slice(cursor, atom.end);
    const quantifier = readQuantifier(source, atom.end);
    tokens.push(`${raw}${quantifier ? source.slice(atom.end, quantifier.end) : ''}`);
    cursor = quantifier?.end ?? atom.end;
  }

  return tokens;
}

function tokensStartWith(tokens: readonly string[], prefix: readonly string[]): boolean {
  if (prefix.length >= tokens.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (tokens[index] !== prefix[index]) return false;
  }
  return true;
}

function splitTopLevelAlternatives(source: string): string[] {
  const alternatives: string[] = [];
  let start = 0;
  let escaped = false;
  let inClass = false;
  let depth = 0;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '[') {
      inClass = true;
      continue;
    }
    if (char === ']' && inClass) {
      inClass = false;
      continue;
    }
    if (inClass) continue;
    if (char === '(') {
      depth += 1;
      continue;
    }
    if (char === ')' && depth > 0) {
      depth -= 1;
      continue;
    }
    if (char === '|' && depth === 0) {
      alternatives.push(source.slice(start, index));
      start = index + 1;
    }
  }
  alternatives.push(source.slice(start));
  return alternatives;
}

function stripGroupPrefix(source: string): string {
  if (source.startsWith('?:') || source.startsWith('?=') || source.startsWith('?!')) return source.slice(2);
  if (source.startsWith('?<=') || source.startsWith('?<!')) return source.slice(3);
  if (source.startsWith('?<')) {
    const end = source.indexOf('>');
    if (end > 2) return source.slice(end + 1);
  }
  return source;
}

function escapeJsonPointer(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}
