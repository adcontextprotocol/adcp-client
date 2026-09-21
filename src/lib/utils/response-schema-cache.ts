import { LIBRARY_VERSION } from '../version';

export type ResponseSchemasModule = Pick<
  typeof import('./response-schemas'),
  'prepareResponseForSchemaValidation' | 'TOOL_RESPONSE_SCHEMAS'
>;

const RESPONSE_SCHEMAS_KEY = Symbol.for(`@adcp/sdk@${LIBRARY_VERSION}/response-schemas`);

function registry(): Record<symbol, ResponseSchemasModule | undefined> {
  return globalThis as unknown as Record<symbol, ResponseSchemasModule | undefined>;
}

export function getCachedResponseSchemas(): ResponseSchemasModule | undefined {
  return registry()[RESPONSE_SCHEMAS_KEY];
}

export function cacheResponseSchemas(module: ResponseSchemasModule): ResponseSchemasModule {
  const existing = registry()[RESPONSE_SCHEMAS_KEY];
  if (existing) {
    return existing;
  }

  registry()[RESPONSE_SCHEMAS_KEY] = module;
  return module;
}
