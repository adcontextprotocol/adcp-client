import type { ErrorObject, FuncKeywordDefinition, KeywordDefinition } from 'ajv';
import { canonicalize } from '../utils/jcs';

type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function pointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

// The schema support audit runs first. This keyword therefore sees only the
// reviewed contracts, on the actual schema-selected branch and instance path.
// Pricing and change-right cross-purchase checks remain in verification.ts.
function validate(
  metadata: RecordValue,
  data: unknown,
  _schema?: unknown,
  context?: { instancePath: string; parentData?: unknown }
): boolean {
  validate.errors = undefined;
  function fail(suffix: string, message: string): false {
    validate.errors = [
      {
        keyword: 'x-adcp-validation',
        instancePath: `${context?.instancePath ?? ''}${suffix}`,
        schemaPath: '',
        params: {},
        message,
      },
    ];
    return false;
  }
  if (record(metadata.disjoint_place_fields) && record(data)) {
    const { include, exclude, identity } = metadata.disjoint_place_fields;
    if (typeof include === 'string' && typeof exclude === 'string' && Array.isArray(identity)) {
      const included = new Set<string>();
      const includedAreas = data[include];
      const excludedAreas = data[exclude];
      const key = (area: RecordValue, value: unknown) =>
        canonicalize(identity.map(field => (field === 'value' ? value : (area[String(field)] ?? null))));
      if (Array.isArray(includedAreas)) {
        for (const area of includedAreas) {
          if (record(area) && Array.isArray(area.values)) {
            for (const value of area.values) included.add(key(area, value));
          }
        }
      }
      if (Array.isArray(excludedAreas)) {
        for (const [index, area] of excludedAreas.entries()) {
          if (record(area) && Array.isArray(area.values)) {
            for (const [valueIndex, value] of area.values.entries()) {
              if (included.has(key(area, value)))
                return fail(
                  `/${pointer(exclude)}/${index}/values/${valueIndex}`,
                  'included and excluded place identities must be disjoint'
                );
            }
          }
        }
      }
    }
  }
  if (typeof metadata.disjoint_with === 'string' && Array.isArray(data) && record(context?.parentData)) {
    const included = context.parentData[metadata.disjoint_with];
    if (Array.isArray(included)) {
      const keys = new Set(included.map(value => canonicalize(value)));
      const overlap = data.findIndex(value => keys.has(canonicalize(value)));
      if (overlap !== -1) return fail(`/${overlap}`, 'included and excluded regions must be disjoint');
    }
  }
  if (record(metadata.map_keys_subset_of_array) && record(data)) {
    const { map_field, array_field } = metadata.map_keys_subset_of_array;
    if (typeof map_field === 'string' && typeof array_field === 'string') {
      const labels = data[map_field];
      const values = data[array_field];
      if (record(labels) && Array.isArray(values)) {
        const keys = new Set(values);
        for (const key of Object.keys(labels)) {
          if (!keys.has(key))
            return fail(`/${pointer(map_field)}/${pointer(key)}`, 'label keys must identify a declared value');
        }
      }
    }
  }
  if (metadata.iana_timezone !== undefined && typeof data === 'string') {
    try {
      new Intl.DateTimeFormat('en', { timeZone: data });
    } catch {
      return fail('', 'timezone must resolve in the runtime IANA timezone database');
    }
  }
  if (
    record(metadata.verifier_constraints) &&
    metadata.verifier_constraints.well_formed === 'rfc5646' &&
    typeof data === 'string'
  ) {
    // AJV enforces the AdCP casing/extension pattern. Intl additionally rejects
    // duplicate variants and extension singletons. Private-use-only tags are
    // valid RFC 5646 but intentionally unsupported by Intl's locale API.
    if (!/^x(?:-[a-z0-9]{1,8})+$/.test(data)) {
      try {
        Intl.getCanonicalLocales(data);
      } catch {
        return fail('', 'language tag must satisfy RFC 5646 grammar');
      }
    }
  }
  return true;
}
validate.errors = undefined as ErrorObject[] | undefined;

export const COMMERCIAL_TERMS_KEYWORDS: ReadonlyArray<KeywordDefinition> = Object.freeze([
  Object.freeze<FuncKeywordDefinition>({ keyword: 'x-adcp-validation', schemaType: 'object', errors: true, validate }),
]);
