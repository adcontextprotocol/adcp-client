import { canonicalize } from '../utils/jcs';
import {
  ABSENT_COMMERCIAL_CONTRACTS_BY_RELEASE,
  REVIEWED_COMMERCIAL_TERMS_SEMANTICS,
  REVIEWED_COMMERCIAL_ENUM_ANNOTATIONS,
  COMMERCIAL_SEMANTIC_OVERRIDES_BY_RELEASE,
} from './commercial-terms-semantics';
import { fullFormats } from 'ajv-formats/dist/formats.js';
import { toReleasePrecisionWire } from '../validation/schema-loader';

type Schema = Readonly<Record<string, unknown>>;

// JSON Schema Draft-07 vocabulary and reviewed annotation-only keywords.
// This is intentionally a schema-language list, never a commercial-field list.
const KEYWORDS = new Set([
  '$id',
  '$ref',
  '$schema',
  '$comment',
  'title',
  'description',
  'default',
  'examples',
  'type',
  'enum',
  'const',
  'multipleOf',
  'maximum',
  'exclusiveMaximum',
  'minimum',
  'exclusiveMinimum',
  'maxLength',
  'minLength',
  'pattern',
  'format',
  'items',
  'additionalItems',
  'maxItems',
  'minItems',
  'uniqueItems',
  'contains',
  'maxProperties',
  'minProperties',
  'required',
  'properties',
  'patternProperties',
  'additionalProperties',
  'dependencies',
  'propertyNames',
  'if',
  'then',
  'else',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'definitions',
  'readOnly',
  'writeOnly',
  'contentMediaType',
  'contentEncoding',
  'deprecated',
  'discriminator',
  'enumDescriptions',
  'x-adcp-schema-uri',
  'x-adcp-validation',
  'x-added-in',
  'x-entity',
  'x-extensible',
  'x-pattern',
  'x-status',
]);

/** Audit the whole reachable schema before trusting AJV's permissive compilation. */
export function commercialTermsSchemaSupportError(
  schema: Schema,
  version: string,
  load: (ref: string) => Schema | undefined
): string | undefined {
  const rootRef = 'media-buy/commercial-terms.json';
  if (typeof schema.$id !== 'string') return 'commercial-terms schema must declare its identity';
  const rootId = new URL(schema.$id, 'https://adcontextprotocol.org');
  if (
    rootId.origin !== 'https://adcontextprotocol.org' ||
    rootId.hash ||
    rootId.search ||
    !/^\/schemas\/[^/]+\/media-buy\/commercial-terms\.json$/.test(rootId.pathname)
  )
    return 'unsupported commercial-terms schema identity';
  const prefix = rootId.href.slice(0, -rootRef.length);
  const declaredVersion = rootId.pathname.match(/\/schemas\/([^/]+)\//)![1]!;
  const schemaVersion = declaredVersion === 'latest' ? load('index.json')?.adcp_version : declaredVersion;
  if (typeof schemaVersion !== 'string') return 'latest schema identities require a release-pinned bundle index';
  if (schemaVersion !== version && toReleasePrecisionWire(schemaVersion) !== version) {
    return 'commercial-terms schema identity does not match the selected release';
  }
  const reviewedSemantics = {
    ...REVIEWED_COMMERCIAL_TERMS_SEMANTICS,
    ...(Object.hasOwn(COMMERCIAL_SEMANTIC_OVERRIDES_BY_RELEASE, schemaVersion)
      ? COMMERCIAL_SEMANTIC_OVERRIDES_BY_RELEASE[schemaVersion]
      : {}),
  };
  const seen = new Set<string>();
  const locations = new Set<string>();

  function failure(message: string, location: string): string {
    return `${message} at ${Array.from(location).slice(0, 256).join('')}`;
  }

  function contract(value: unknown): string {
    // Explanatory metadata is not a verifier rule. Prose inside an actual
    // verifier_constraints value remains normative and requires review.
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return canonicalize(
        Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'description' && key !== 'spec'))
      );
    }
    return canonicalize(value);
  }

  function visit(node: unknown, location: string, document: string): string | undefined {
    locations.add(location);
    if (typeof node === 'boolean') {
      return !Object.hasOwn(reviewedSemantics, location) &&
        !Object.hasOwn(REVIEWED_COMMERCIAL_ENUM_ANNOTATIONS, location)
        ? undefined
        : failure('removed commercial-term validation semantics', location);
    }
    if (!node || typeof node !== 'object' || Array.isArray(node)) return failure('invalid schema node', location);
    const value = node as Schema;
    const unknownKeyword = Object.keys(value).find(key => !KEYWORDS.has(key));
    if (unknownKeyword !== undefined) return failure('unsupported schema keyword', `${location}/${unknownKeyword}`);
    if (value.format !== undefined && (typeof value.format !== 'string' || !Object.hasOwn(fullFormats, value.format))) {
      return failure('unsupported schema format', `${location}/format`);
    }
    if (value.$schema !== undefined && value.$schema !== 'http://json-schema.org/draft-07/schema#') {
      return failure('unsupported schema dialect', `${location}/$schema`);
    }
    if (
      value.$id !== undefined &&
      (typeof value.$id !== 'string' || new URL(value.$id, `${prefix}${document}`).href !== `${prefix}${document}`)
    )
      return failure('schema identity does not match the selected bundle', `${location}/$id`);
    const semantics = value['x-adcp-validation'];
    const reviewed = Object.hasOwn(reviewedSemantics, location) ? reviewedSemantics[location] : undefined;
    if (semantics !== undefined || reviewed !== undefined) {
      if (semantics === undefined || reviewed === undefined || contract(semantics) !== contract(reviewed)) {
        return failure('unreviewed commercial-term validation semantics', `${location}/x-adcp-validation`);
      }
    }
    const enumAnnotations = Object.fromEntries(
      Object.entries(value).filter(([key]) => key === 'x-extensible' || key === 'x-pattern')
    );
    const reviewedEnum = Object.hasOwn(REVIEWED_COMMERCIAL_ENUM_ANNOTATIONS, location)
      ? REVIEWED_COMMERCIAL_ENUM_ANNOTATIONS[location]
      : undefined;
    if (reviewedEnum !== undefined || Object.keys(enumAnnotations).length > 0) {
      if (canonicalize(enumAnnotations) !== canonicalize(reviewedEnum ?? {})) {
        return failure('unreviewed commercial-term enum annotations', location);
      }
    }
    if (typeof value.$ref === 'string') {
      const url = new URL(value.$ref, `${prefix}${document}`);
      if (!url.href.startsWith(prefix) || url.search)
        return failure('schema reference leaves the selected bundle', `${location}/$ref`);
      const ref = url.href.slice(prefix.length).split('#')[0]!;
      if (!seen.has(ref)) {
        seen.add(ref);
        const dependency = load(ref);
        if (!dependency) return failure('referenced schema is unavailable', ref);
        const error = visit(dependency, ref, ref);
        if (error) return error;
      }
    }
    for (const key of ['properties', 'patternProperties', 'definitions', 'dependencies']) {
      const children = value[key];
      if (children && typeof children === 'object' && !Array.isArray(children)) {
        for (const [name, child] of Object.entries(children)) {
          if (key === 'dependencies' && Array.isArray(child)) continue;
          const error = visit(child, `${location}/${key}/${name}`, document);
          if (error) return error;
        }
      }
    }
    for (const key of [
      'items',
      'additionalItems',
      'additionalProperties',
      'contains',
      'propertyNames',
      'if',
      'then',
      'else',
      'not',
      'allOf',
      'anyOf',
      'oneOf',
    ]) {
      const child = value[key];
      if (child === undefined) continue;
      if (Array.isArray(child)) {
        for (const [index, branch] of child.entries()) {
          const error = visit(branch, `${location}/${key}/${index}`, document);
          if (error) return error;
        }
      } else {
        const error = visit(child, `${location}/${key}`, document);
        if (error) return error;
      }
    }
    return undefined;
  }

  seen.add('media-buy/commercial-terms.json');
  const error = visit(schema, 'media-buy/commercial-terms.json', 'media-buy/commercial-terms.json');
  if (error) return error;
  for (const location of [...Object.keys(reviewedSemantics), ...Object.keys(REVIEWED_COMMERCIAL_ENUM_ANNOTATIONS)]) {
    if (locations.has(location)) continue;
    if (
      Object.hasOwn(ABSENT_COMMERCIAL_CONTRACTS_BY_RELEASE, schemaVersion) &&
      ABSENT_COMMERCIAL_CONTRACTS_BY_RELEASE[schemaVersion]?.includes(location)
    )
      continue;
    return failure('removed commercial-term validation semantics', location);
  }
  return undefined;
}
