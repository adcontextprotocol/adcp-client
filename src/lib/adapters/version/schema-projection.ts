/**
 * Schema-driven projection between two AdCP releases.
 *
 * Converting a payload down from a newer release to an older one removes what
 * the older release cannot express: properties the newer schema declares but
 * the older one does not, enum values the older release does not define, and
 * union variants whose discriminator the older release does not know.
 * Everything the projection removes is reported so callers can surface it.
 *
 * The projection is a diff of the two schemas, not a whitelist of the older
 * one. A property neither release declares (an adopter extension at an open
 * object, say) is left alone, as is anything under an object whose older
 * schema declares no properties (a free-form map such as `ext`).
 */

import { getSchemaDocumentByRef, getToolSchemaDocument, type Direction } from '../../validation/schema-loader';

type Schema = Record<string, unknown>;

interface SchemaDocument {
  root: Schema;
  base: string;
  version: string;
}

interface SchemaNode {
  schema: Schema;
  doc: SchemaDocument;
}

export interface ProjectionDrop {
  /** JSON path of the removed value, e.g. `packages[0].bidding`. */
  path: string;
  /** What kind of value the older release could not express. */
  kind: 'field' | 'enum_value' | 'variant';
}

export interface ProjectionResult<T = unknown> {
  value: T;
  dropped: ProjectionDrop[];
}

const OMIT = Symbol('omit');
const MAX_DEPTH = 64;
const SCHEMA_HOST = 'https://adcontextprotocol.org';

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function absoluteBase(id: unknown): string {
  if (typeof id !== 'string' || id.length === 0) return `${SCHEMA_HOST}/schemas/unknown/root.json`;
  if (id.startsWith('/')) return `${SCHEMA_HOST}${id}`;
  return id;
}

function documentFor(version: string, ref: string): SchemaDocument | undefined {
  let url: URL;
  try {
    url = new URL(ref);
  } catch {
    return undefined;
  }
  const match = /^\/schemas\/[^/]+\/(.+)$/.exec(url.pathname);
  if (!match?.[1]) return undefined;
  const resolved = getSchemaDocumentByRef(match[1], version);
  if (!resolved) return undefined;
  return { root: resolved.schema as Schema, base: url.origin + url.pathname, version };
}

function pointer(root: Schema, fragment: string): Schema | undefined {
  if (fragment === '' || fragment === '/') return root;
  let current: unknown = root;
  for (const encoded of fragment.replace(/^\//, '').split('/')) {
    if (!isObject(current)) return undefined;
    current = current[decodeURIComponent(encoded).replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return isObject(current) ? current : undefined;
}

function resolveRef(node: SchemaNode, depth: number): SchemaNode {
  let current = node;
  for (let hop = 0; hop < 16 && depth + hop < MAX_DEPTH; hop++) {
    const ref = current.schema.$ref;
    if (typeof ref !== 'string') return current;
    if (ref.startsWith('#')) {
      const target = pointer(current.doc.root, ref.slice(1));
      if (!target) return current;
      current = { schema: target, doc: current.doc };
      continue;
    }
    let absolute: URL;
    try {
      absolute = new URL(ref, current.doc.base);
    } catch {
      return current;
    }
    const doc = documentFor(current.doc.version, absolute.origin + absolute.pathname);
    if (!doc) return current;
    const target = pointer(doc.root, absolute.hash.replace(/^#/, ''));
    if (!target) return current;
    current = { schema: target, doc };
  }
  return current;
}

function child(node: SchemaNode, value: unknown): SchemaNode | undefined {
  return isObject(value) ? { schema: value, doc: node.doc } : undefined;
}

/** Const-valued properties of a branch, used to pick oneOf/anyOf variants. */
function discriminatorMatch(node: SchemaNode, value: unknown, depth: number): boolean | undefined {
  if (!isObject(value)) return undefined;
  const resolved = resolveRef(node, depth);
  const properties = resolved.schema.properties;
  if (!isObject(properties)) return undefined;
  let found = false;
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!isObject(propertySchema)) continue;
    const prop = resolveRef({ schema: propertySchema, doc: resolved.doc }, depth + 1).schema;
    if (!Object.hasOwn(prop, 'const')) continue;
    found = true;
    if (!Object.hasOwn(value, key) || value[key] !== prop.const) return false;
  }
  return found ? true : undefined;
}

interface Expansion {
  nodes: SchemaNode[];
  /** A union whose const discriminators were present but none matched. */
  unmatchedVariant: boolean;
}

/**
 * Expand a schema into every subschema that applies to `value`: the node
 * itself, `allOf` members, `if/then/else` arms, and the `oneOf`/`anyOf`
 * branches whose const discriminators match (all branches when none carry
 * discriminators).
 */
function expand(node: SchemaNode, value: unknown, depth = 0): Expansion {
  if (depth > MAX_DEPTH) return { nodes: [], unmatchedVariant: false };
  const resolved = resolveRef(node, depth);
  const nodes: SchemaNode[] = [resolved];
  let unmatchedVariant = false;
  const add = (expansion: Expansion) => {
    nodes.push(...expansion.nodes);
    unmatchedVariant ||= expansion.unmatchedVariant;
  };
  for (const keyword of ['allOf'] as const) {
    const branches = resolved.schema[keyword];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      const branchNode = child(resolved, branch);
      if (branchNode) add(expand(branchNode, value, depth + 1));
    }
  }
  for (const keyword of ['then', 'else'] as const) {
    const branchNode = child(resolved, resolved.schema[keyword]);
    if (branchNode) add(expand(branchNode, value, depth + 1));
  }
  for (const keyword of ['oneOf', 'anyOf'] as const) {
    const branches = resolved.schema[keyword];
    if (!Array.isArray(branches)) continue;
    const branchNodes = branches.map(branch => child(resolved, branch)).filter((b): b is SchemaNode => !!b);
    const matches = branchNodes.map(branch => discriminatorMatch(branch, value, depth + 1));
    const matched = branchNodes.filter((_, index) => matches[index] === true);
    const discriminated = matches.some(match => match !== undefined);
    if (discriminated && matched.length === 0 && matches.every(match => match === false)) unmatchedVariant = true;
    for (const branch of matched.length > 0 ? matched : branchNodes) add(expand(branch, value, depth + 1));
  }
  return { nodes, unmatchedVariant };
}

function allowedScalars(nodes: SchemaNode[]): unknown[] | undefined {
  let values: unknown[] | undefined;
  for (const { schema } of nodes) {
    if (Array.isArray(schema.enum)) values = [...(values ?? []), ...schema.enum];
    if (Object.hasOwn(schema, 'const')) values = [...(values ?? []), schema.const];
  }
  return values;
}

function hasScalarConstraint(nodes: SchemaNode[]): boolean {
  return nodes.some(({ schema }) => Array.isArray(schema.enum) || Object.hasOwn(schema, 'const'));
}

function scalarType(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

/**
 * Whether some subschema accepts the scalar without an enum, e.g. the
 * free-string arm of `anyOf: [{ enum: [...] }, { type: 'string' }]`.
 */
function acceptsScalarOpenly(nodes: SchemaNode[], value: unknown): boolean {
  const type = scalarType(value);
  return nodes.some(({ schema }) => {
    if (Array.isArray(schema.enum) || Object.hasOwn(schema, 'const')) return false;
    const declared = Array.isArray(schema.type) ? schema.type : schema.type === undefined ? [] : [schema.type];
    return declared.includes(type) || (type === 'integer' && declared.includes('number'));
  });
}

interface PropertyIndex {
  declares: boolean;
  schemas: Map<string, SchemaNode[]>;
  patterns: Array<{ pattern: RegExp; node: SchemaNode }>;
  additional: SchemaNode[];
}

function indexProperties(nodes: SchemaNode[]): PropertyIndex {
  const index: PropertyIndex = { declares: false, schemas: new Map(), patterns: [], additional: [] };
  for (const node of nodes) {
    const { properties, patternProperties, additionalProperties } = node.schema;
    if (isObject(properties)) {
      index.declares = true;
      for (const [key, value] of Object.entries(properties)) {
        const propertyNode = child(node, value);
        if (!propertyNode) continue;
        index.schemas.set(key, [...(index.schemas.get(key) ?? []), propertyNode]);
      }
    }
    if (isObject(patternProperties)) {
      index.declares = true;
      for (const [pattern, value] of Object.entries(patternProperties)) {
        const propertyNode = child(node, value);
        if (!propertyNode) continue;
        try {
          index.patterns.push({ pattern: new RegExp(pattern, 'u'), node: propertyNode });
        } catch {
          // Unparseable patterns cannot match; skip them.
        }
      }
    }
    const additionalNode = child(node, additionalProperties);
    if (additionalNode) index.additional.push(additionalNode);
  }
  return index;
}

function schemasForKey(index: PropertyIndex, key: string): SchemaNode[] | undefined {
  const declared = index.schemas.get(key);
  const patterned = index.patterns.filter(({ pattern }) => pattern.test(key)).map(({ node }) => node);
  if (declared || patterned.length > 0) return [...(declared ?? []), ...patterned];
  return undefined;
}

function nonEmpty<T>(values: T[]): T[] | undefined {
  return values.length > 0 ? values : undefined;
}

function joinPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function project(
  value: unknown,
  source: SchemaNode[],
  target: SchemaNode[],
  path: string,
  dropped: ProjectionDrop[],
  depth: number
): unknown {
  if (depth > MAX_DEPTH || source.length === 0 || target.length === 0) return value;
  const sourceExpansions = source.map(node => expand(node, value, depth));
  const targetExpansions = target.map(node => expand(node, value, depth));
  const sourceNodes = sourceExpansions.flatMap(e => e.nodes);
  const targetNodes = targetExpansions.flatMap(e => e.nodes);

  // A discriminated variant the source knows but the target does not.
  if (
    targetExpansions.some(e => e.unmatchedVariant) &&
    !sourceExpansions.some(e => e.unmatchedVariant) &&
    path !== ''
  ) {
    dropped.push({ path, kind: 'variant' });
    return OMIT;
  }

  if (!isObject(value) && !Array.isArray(value)) {
    if (!hasScalarConstraint(targetNodes) || acceptsScalarOpenly(targetNodes, value)) return value;
    const targetAllowed = allowedScalars(targetNodes) ?? [];
    if (targetAllowed.some(allowed => Object.is(allowed, value))) return value;
    const sourceAllowed = allowedScalars(sourceNodes);
    // Only remove values the newer release defines. A value neither release
    // allows is the caller's error and is left for validation to report.
    if (sourceAllowed?.some(allowed => Object.is(allowed, value))) {
      dropped.push({ path, kind: 'enum_value' });
      return OMIT;
    }
    return value;
  }

  if (Array.isArray(value)) {
    const sourceItems = sourceNodes.map(node => child(node, node.schema.items)).filter((n): n is SchemaNode => !!n);
    const targetItems = targetNodes.map(node => child(node, node.schema.items)).filter((n): n is SchemaNode => !!n);
    if (sourceItems.length === 0 || targetItems.length === 0) return value;
    let changed = false;
    const items: unknown[] = [];
    value.forEach((item, index) => {
      const projected = project(item, sourceItems, targetItems, `${path}[${index}]`, dropped, depth + 1);
      if (projected !== item) changed = true;
      if (projected !== OMIT) items.push(projected);
    });
    return changed ? items : value;
  }

  const sourceIndex = indexProperties(sourceNodes);
  const targetIndex = indexProperties(targetNodes);
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    // An undefined value never reaches the wire, so it cannot be lost.
    if (entry === undefined) {
      out[key] = entry;
      continue;
    }
    // A typed `additionalProperties` schema accepts undeclared keys; the
    // boolean `true` of an open object does not count, because a seller on
    // the older release ignores (or rejects) what it does not declare.
    const sourceSchemas = schemasForKey(sourceIndex, key) ?? nonEmpty(sourceIndex.additional);
    const targetSchemas = schemasForKey(targetIndex, key) ?? nonEmpty(targetIndex.additional);
    const entryPath = joinPath(path, key);
    if (sourceIndex.declares && targetIndex.declares && schemasForKey(sourceIndex, key) && !targetSchemas) {
      dropped.push({ path: entryPath, kind: 'field' });
      changed = true;
      continue;
    }
    if (!sourceSchemas?.length || !targetSchemas?.length) {
      out[key] = entry;
      continue;
    }
    const projected = project(entry, sourceSchemas, targetSchemas, entryPath, dropped, depth + 1);
    if (projected === OMIT) {
      changed = true;
      continue;
    }
    if (projected !== entry) changed = true;
    out[key] = projected;
  }
  return changed ? out : value;
}

function toolRoot(toolName: string, direction: Direction, version: string): SchemaNode | undefined {
  let document;
  try {
    document = getToolSchemaDocument(toolName, direction, version);
  } catch {
    return undefined;
  }
  if (!document) return undefined;
  const root = document.schema as Schema;
  return { schema: root, doc: { root, base: absoluteBase(root.$id), version } };
}

/**
 * Project a tool payload from the `fromVersion` schema to the `toVersion`
 * schema. Returns the original reference unchanged (and no drops) when
 * nothing needs removing or when either release has no schema for the tool.
 */
export function projectToolPayload<T>(
  toolName: string,
  direction: Direction,
  payload: T,
  fromVersion: string,
  toVersion: string
): ProjectionResult<T> {
  const source = toolRoot(toolName, direction, fromVersion);
  const target = toolRoot(toolName, direction, toVersion);
  if (!source || !target || !isObject(payload)) return { value: payload, dropped: [] };
  const dropped: ProjectionDrop[] = [];
  const projected = project(payload, [source], [target], '', dropped, 0);
  return { value: (projected === OMIT ? payload : projected) as T, dropped };
}

/** Whether the release's schema bundle defines a request schema for the tool. */
export function releaseDefinesTool(toolName: string, version: string): boolean {
  try {
    return getToolSchemaDocument(toolName, 'request', version) !== undefined;
  } catch {
    return false;
  }
}
