import type { CreativeFormatWireMode } from '../v2/projection/creative-delivery';

/** Inspect reachable input schemas without fetching references or treating unused definitions as evidence. */
export function creativeSchemaSupport(inputSchema: unknown): CreativeFormatWireMode {
  const visited = new WeakSet<object>();
  let remaining = 10_000;
  let truncated = false;

  function resolvePointer(reference: string, root: unknown): { value: unknown; root: unknown } | undefined {
    if (!reference.startsWith('#')) return undefined;
    let pointer: string;
    try {
      pointer = decodeURIComponent(reference.slice(1));
    } catch {
      return undefined;
    }
    if (pointer === '') return { value: root, root };
    if (!pointer.startsWith('/') || /~(?![01])/.test(pointer)) return undefined;
    let value = root;
    for (const token of pointer.slice(1).split('/')) {
      const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
      if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
      const resource = value as Record<string, unknown>;
      if (typeof resource.$id === 'string' && resource.$id !== '' && !resource.$id.startsWith('#')) root = resource;
      value = (value as Record<string, unknown>)[key];
    }
    return { value, root };
  }

  function visit(value: unknown, root: unknown, depth: number): CreativeFormatWireMode {
    if (value === null || typeof value !== 'object' || visited.has(value)) {
      return 'unknown';
    }
    if (--remaining < 0 || depth > 64) {
      truncated = true;
      return 'unknown';
    }
    visited.add(value);
    let legacy = false;
    const inspect = (child: unknown): boolean => {
      const mode = visit(child, root, depth + 1);
      if (mode === 'legacy') legacy = true;
      return mode === 'canonical';
    };
    if (Array.isArray(value)) {
      for (const child of value) if (inspect(child)) return 'canonical';
      return legacy ? 'legacy' : 'unknown';
    }

    const schema = value as Record<string, unknown>;
    // Embedded $id resources give fragment references a new local root.
    if (typeof schema.$id === 'string' && schema.$id !== '' && !schema.$id.startsWith('#')) root = schema;
    const properties = schema.properties;
    if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
      const fields = properties as Record<string, unknown>;
      if (Object.hasOwn(fields, 'creative_id') && fields.creative_id !== false) {
        if (Object.hasOwn(fields, 'format_kind') && fields.format_kind !== false) return 'canonical';
        if (Object.hasOwn(fields, 'format_id') && fields.format_id !== false) legacy = true;
      }
    }
    if (typeof schema.$ref === 'string') {
      const target = resolvePointer(schema.$ref, root);
      if (target) {
        const mode = visit(target.value, target.root, depth + 1);
        if (mode === 'canonical') return mode;
        if (mode === 'legacy') legacy = true;
      }
    }

    // Only positive schema positions contribute evidence. Definitions are
    // reached through $ref; annotations and `not` are not accepted shapes.
    for (const keyword of ['properties', 'patternProperties', 'dependentSchemas']) {
      const children = schema[keyword];
      if (children !== null && typeof children === 'object' && !Array.isArray(children)) {
        for (const child of Object.values(children)) if (inspect(child)) return 'canonical';
      }
    }
    for (const keyword of [
      'items',
      'prefixItems',
      'contains',
      'additionalItems',
      'additionalProperties',
      'unevaluatedItems',
      'unevaluatedProperties',
      'allOf',
      'anyOf',
      'oneOf',
    ]) {
      if (inspect(schema[keyword])) return 'canonical';
    }
    return legacy ? 'legacy' : 'unknown';
  }

  const mode = visit(inputSchema, inputSchema, 0);
  return truncated ? 'unknown' : mode;
}
