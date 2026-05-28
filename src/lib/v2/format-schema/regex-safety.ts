export interface UnsafeRegexPattern {
  location: string;
  pattern: string;
  reason: 'nested_unbounded_quantifier' | 'ambiguous_repeated_alternation';
}

interface RegexGroup {
  body: string;
  end: number;
}

export function findUnsafeRegexPattern(root: unknown): UnsafeRegexPattern | undefined {
  const seen = new Set<unknown>();

  function walk(node: unknown, pointer: string): UnsafeRegexPattern | undefined {
    if (!node || typeof node !== 'object') return undefined;
    if (seen.has(node)) return undefined;
    seen.add(node);

    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
        const unsafe = walk(node[index], `${pointer}/${index}`);
        if (unsafe) return unsafe;
      }
      return undefined;
    }

    const obj = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(obj)) {
      const keyPointer = `${pointer}/${escapeJsonPointer(key)}`;
      if (key === 'pattern' && typeof value === 'string') {
        const unsafe = analyzeRegexPattern(value, keyPointer);
        if (unsafe) return unsafe;
      }
      if (key === 'patternProperties' && value && typeof value === 'object' && !Array.isArray(value)) {
        for (const pattern of Object.keys(value as Record<string, unknown>)) {
          const unsafe = analyzeRegexPattern(pattern, `${keyPointer}/${escapeJsonPointer(pattern)}`);
          if (unsafe) return unsafe;
        }
      }
      const unsafe = walk(value, keyPointer);
      if (unsafe) return unsafe;
    }
    return undefined;
  }

  return walk(root, '');
}

function analyzeRegexPattern(pattern: string, location: string): UnsafeRegexPattern | undefined {
  for (const group of collectGroups(pattern)) {
    const quantifier = readQuantifier(pattern, group.end + 1);
    if (!quantifier.unbounded) continue;

    if (containsUnboundedQuantifier(group.body)) {
      return { location, pattern, reason: 'nested_unbounded_quantifier' };
    }
    if (hasAmbiguousAlternation(group.body)) {
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

function containsUnboundedQuantifier(source: string): boolean {
  let escaped = false;
  let inClass = false;

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
    if (char === '*' || char === '+') return true;
    if (char === '{' && readQuantifier(source, index).unbounded) return true;
  }

  return false;
}

function readQuantifier(source: string, index: number): { unbounded: boolean } {
  const char = source[index];
  if (char === '*' || char === '+') return { unbounded: true };
  if (char !== '{') return { unbounded: false };

  const match = /^\{(\d+)(?:,(\d*))?\}/.exec(source.slice(index));
  if (!match) return { unbounded: false };
  return { unbounded: match[2] === '' };
}

function hasAmbiguousAlternation(source: string): boolean {
  const alternatives = splitTopLevelAlternatives(stripGroupPrefix(source));
  if (alternatives.length < 2) return false;

  const prefixes = alternatives.map(literalPrefix).filter(prefix => prefix.length > 0);
  for (let left = 0; left < prefixes.length; left += 1) {
    for (let right = 0; right < prefixes.length; right += 1) {
      const leftPrefix = prefixes[left];
      const rightPrefix = prefixes[right];
      if (leftPrefix && rightPrefix && left !== right && rightPrefix.startsWith(leftPrefix)) return true;
    }
  }
  return false;
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

function literalPrefix(source: string): string {
  let prefix = '';
  let escaped = false;

  for (const char of source) {
    if (escaped) {
      prefix += `\\${char}`;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if ('^$.*+?()[]{}|'.includes(char)) break;
    prefix += char;
  }

  return prefix;
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
