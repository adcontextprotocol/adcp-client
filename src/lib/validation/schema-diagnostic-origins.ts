/** Exact schema origins for AJV's separately generated validation functions. */
type SchemaObject = Record<string, unknown>;
interface SchemaEnvironment {
  schema: unknown;
  root: { schema: unknown };
  baseId?: string;
}

export interface SchemaDiagnosticOrigin {
  schema: unknown;
  schemaId?: string;
  /** Original AJV function-relative spelling; exact origins remain internal. */
  schemaPath: string;
}
export interface SchemaDiagnosticOrigins {
  process: (source: string, environment?: SchemaEnvironment) => string;
  resolve: (schemaPath: string) => unknown;
  origin: (schemaPath: string) => SchemaDiagnosticOrigin | undefined;
}

function object(value: unknown): value is SchemaObject {
  return value !== null && typeof value === 'object';
}

/**
 * Locate static schemaPath property values without matching text inside strings
 * or comments. Unknown code spellings fail closed: validation is unchanged and
 * that function does not acquire an origin used for diagnostic enrichment.
 */
function schemaPathLiterals(source: string): Array<{ start: number; end: number; value: string }> | undefined {
  const paths: Array<{ start: number; end: number; value: string }> = [];
  const stringEnd = (start: number): number => {
    const quote = source[start];
    for (let index = start + 1; index < source.length; index++) {
      if (source[index] === '\\') index++;
      else if (source[index] === quote) return index + 1;
    }
    return -1;
  };
  for (let index = 0; index < source.length; ) {
    const start = index;
    let key: string | undefined;
    if (source[index] === '"' || source[index] === "'") {
      index = stringEnd(index);
      if (index < 0) return undefined;
      try {
        key = JSON.parse(source.slice(start, index));
      } catch {
        /* Single-quoted non-property text. */
      }
    } else if (/[A-Za-z_$]/.test(source[index]!)) {
      while (index < source.length && /[\w$]/.test(source[index]!)) index++;
      key = source.slice(start, index);
    } else if (source.startsWith('//', index)) {
      index = source.indexOf('\n', index + 2);
      if (index < 0) break;
    } else if (source.startsWith('/*', index)) {
      index = source.indexOf('*/', index + 2);
      if (index < 0) return undefined;
      index += 2;
    } else {
      // AJV's supported generator emits JSON strings and hoisted patterns.
      // Do not guess at template/regex literals from unknown custom code.
      if (source[index] === '`') return undefined;
      if (source[index] === '/') {
        // AJV escapes dynamic record keys with these two exact regexes.
        // Recognize only their complete literal spelling in .replace(...).
        const pointerEscape = source.startsWith('/~/g', index)
          ? '/~/g'
          : source.startsWith('/\\//g', index)
            ? '/\\//g'
            : undefined;
        if (pointerEscape && /\.replace\(\s*$/.test(source.slice(0, index))) {
          index += pointerEscape.length;
          continue;
        }
        // AJV multipleOf divides a data/dataN variable by the schema value.
        // Accept only that known expression token. return/throw/control-flow
        // regex literals remain unsupported and leave the function untouched.
        const previous = source.slice(0, index).match(/(?:^|[^\w$])(data\d*)\s*$/);
        if (!previous) return undefined;
      }
      index++;
    }
    if (key !== 'schemaPath') continue;
    let valueStart = index;
    while (/\s/.test(source[valueStart] ?? '') && valueStart < source.length) valueStart++;
    if (source[valueStart] !== ':') continue;
    valueStart++;
    while (/\s/.test(source[valueStart] ?? '') && valueStart < source.length) valueStart++;
    if (source[valueStart] !== '"') return undefined;
    const end = stringEnd(valueStart);
    if (end < 0) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(source.slice(valueStart, end));
    } catch {
      return undefined;
    }
    if (typeof value !== 'string' || !value.startsWith('#')) return undefined;
    paths.push({ start: valueStart, end, value });
    index = end;
  }
  return paths;
}

/** Use AJV's supported code.process hook; only diagnostic string literals change. */
export function createSchemaDiagnosticOrigins(): SchemaDiagnosticOrigins {
  const indexes = new WeakMap<object, WeakMap<object, string>>();
  const anonymousIds = new WeakMap<object, string>();
  const origins = new Map<string, { schema: SchemaObject; schemaId?: string } | undefined>();
  let anonymousId = 0;
  const indexRoot = (root: object): WeakMap<object, string> => {
    const cached = indexes.get(root);
    if (cached) return cached;
    const paths = new WeakMap<object, string>();
    const pending: Array<[object, string]> = [[root, '#']];
    while (pending.length) {
      const [node, pointer] = pending.pop()!;
      if (paths.has(node)) continue;
      paths.set(node, pointer);
      for (const [key, child] of Object.entries(node)) {
        if (object(child))
          pending.push([child, `${pointer}/${encodeURIComponent(key.replace(/~/g, '~0').replace(/\//g, '~1'))}`]);
      }
    }
    indexes.set(root, paths);
    return paths;
  };
  const origin = (schemaPath: string): SchemaDiagnosticOrigin | undefined => {
    const hash = schemaPath.indexOf('#');
    if (hash < 0) return undefined;
    let prefix = schemaPath;
    while (prefix.length >= hash + 1) {
      if (origins.has(prefix)) {
        const entry = origins.get(prefix);
        if (!entry) return undefined;
        let cursor: unknown = entry.schema;
        let schemaId = entry.schemaId;
        const relative = schemaPath.slice(prefix.length);
        if (relative)
          for (const segment of relative.slice(1).split('/')) {
            let key: string;
            try {
              key = decodeURIComponent(segment).replace(/~1/g, '/').replace(/~0/g, '~');
            } catch {
              return undefined;
            }
            if (
              key === '__proto__' ||
              key === 'constructor' ||
              key === 'prototype' ||
              !object(cursor) ||
              !Object.hasOwn(cursor, key)
            )
              return undefined;
            cursor = cursor[key];
            if (object(cursor) && typeof cursor.$id === 'string') {
              try {
                schemaId = new URL(cursor.$id, schemaId).href;
              } catch {
                schemaId = cursor.$id;
              }
            }
          }
        return { schema: cursor, ...(schemaId && { schemaId }), schemaPath: `#${relative}` };
      }
      const slash = prefix.lastIndexOf('/');
      if (slash <= hash) {
        if (prefix.length === hash + 1) break;
        prefix = prefix.slice(0, hash + 1);
      } else prefix = prefix.slice(0, slash);
    }
    return undefined;
  };
  return {
    process(source, environment) {
      const literals = schemaPathLiterals(source);
      if (!environment || !literals?.length || !object(environment.schema) || !object(environment.root.schema))
        return source;
      const root = environment.root.schema;
      const pointer = indexRoot(root).get(environment.schema);
      const document = pointer !== undefined ? root : environment.schema;
      let id = typeof document.$id === 'string' ? document.$id.replace(/#.*$/, '') : undefined;
      if (!id) {
        id = anonymousIds.get(document);
        if (!id) {
          id = `urn:adcp:schema-origin:${anonymousId++}`;
          anonymousIds.set(document, id);
        }
      }
      const prefix = `${id}${pointer ?? '#'}`;
      // A conflicting identity cannot justify precise enrichment. Retain the
      // real validation errors but never fall through to a different origin.
      if (origins.has(prefix) && origins.get(prefix)?.schema !== environment.schema) origins.set(prefix, undefined);
      else if (!origins.has(prefix)) {
        // baseId is AJV's resolved effective resource identity, including an
        // embedded $id. It is independent of the exact compiled pointer.
        const schemaId =
          environment.baseId || (typeof environment.schema.$id === 'string' ? environment.schema.$id : undefined);
        origins.set(prefix, { schema: environment.schema, ...(schemaId && { schemaId }) });
      }
      const fragments: string[] = [];
      let cursor = 0;
      for (const literal of literals) {
        fragments.push(source.slice(cursor, literal.start), JSON.stringify(prefix + literal.value.slice(1)));
        cursor = literal.end;
      }
      fragments.push(source.slice(cursor));
      return fragments.join('');
    },
    resolve(schemaPath) {
      return origin(schemaPath)?.schema;
    },
    origin,
  };
}
