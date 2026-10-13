import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { IDENTITY_PREVIEW_SCHEMA_BUNDLE } from './identity-schema-bundle.generated';

/** Schemas in the pinned identity preview, by source path. */
export type IdentityPreviewSchema =
  | 'trust/v1/trust.json'
  | 'core/agent-onboarding.json'
  | 'core/agent-onboarding-tier.json'
  | 'core/agent-onboarding-requirement.json'
  | 'core/buyer-onboarding-posture.json'
  | 'core/principal-relationship.json'
  | 'enums/agent-onboarding-mode.json'
  | 'enums/agent-onboarding-requirement-kind.json'
  | 'enums/buyer-onboarding-mode.json';

let ajv: Ajv | undefined;
const validators = new Map<string, ValidateFunction>();

function definitionKey(schemaPath: string): string {
  return schemaPath.replace(/\.json$/, '').replace(/[/-]/g, '_');
}

/**
 * Validate a value against the pinned, offline AdCP 3.3 identity preview
 * schemas (draft commits recorded in `schemas/identity-preview/UPSTREAM.json`).
 * Returns the ajv error list, empty when valid.
 */
export function identityPreviewSchemaErrors(value: unknown, schemaPath: IdentityPreviewSchema): string[] {
  const key = definitionKey(schemaPath);
  let validate = validators.get(key);
  if (!validate) {
    ajv ??= (() => {
      const instance = new Ajv({ allErrors: false, strict: false, validateFormats: true });
      addFormats(instance);
      instance.addSchema(JSON.parse(JSON.stringify(IDENTITY_PREVIEW_SCHEMA_BUNDLE)), 'identity-preview');
      return instance;
    })();
    validate = ajv.compile({ $ref: `identity-preview#/definitions/${key}` });
    validators.set(key, validate);
  }
  if (validate(value)) return [];
  return (validate.errors ?? []).map(error => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`);
}

/** Known onboarding requirement kinds in the pinned preview. */
export function knownOnboardingRequirementKinds(): readonly string[] {
  return (IDENTITY_PREVIEW_SCHEMA_BUNDLE.definitions.enums_agent_onboarding_requirement_kind?.enum ??
    []) as readonly string[];
}
