/** Per-call draft overlays. Never mutates the released schema or changes ADCP_VERSION. */
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { getValidator } from '../validation/schema-loader';
import type { ValidationOutcome } from '../validation/schema-validator';
import schemas from './schemas.draft';
const validators = new WeakMap<object, Map<string, ReturnType<Ajv['compile']>>>();
export function validateIdentity33Payload(
  tool: string,
  direction: 'request' | 'response',
  payload: unknown,
  version?: string
): ValidationOutcome {
  const key = JSON.stringify([tool, direction, version]);
  const stable = getValidator(tool, direction === 'request' ? 'request' : 'sync', version);
  if (!stable) return { valid: true, issues: [], variant: 'skipped' };
  let cache = validators.get(stable);
  if (!cache) {
    cache = new Map();
    validators.set(stable, cache);
  }
  let validator = cache.get(key);
  if (!validator) {
    const schema = structuredClone(stable.schema) as Record<string, unknown>;
    const relationship = schemas.find(s => s.$id === '/schemas/core/principal-relationship.json')!;
    const onboarding = schemas.find(s => s.$id === '/schemas/core/agent-onboarding.json')!;
    function walk(node: unknown, name = ''): void {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach(item => walk(item, name));
        return;
      }
      const object = node as Record<string, any>;
      if (
        (name === 'reporting_webhook' ||
          name === 'artifact_webhook' ||
          /Reporting Webhook|Artifact Webhook/i.test(object.title ?? '')) &&
        Array.isArray(object.required)
      )
        object.required = object.required.filter((field: string) => field !== 'authentication');
      if (name === 'reason' && Array.isArray(object.enum) && object.enum.includes('destination_state_changed'))
        object.enum = [...object.enum, 'relationship_changed', 'relationship_expiring'];
      if (object.properties?.url && object.properties?.authentication)
        object.properties.signing_profile = { type: 'string', enum: ['adcp/webhook-signing/v1', 'web-bot-auth'] };
      if (
        tool === 'get_principal' &&
        direction === 'response' &&
        object.properties?.kind &&
        ['current', 'recognized', 'unconfigured'].includes(object.properties.kind.const)
      )
        object.properties.relationship = { ...relationship, $id: undefined };
      if (tool === 'get_adcp_capabilities' && object.properties?.supported_billing)
        object.properties.agent_onboarding = { ...onboarding, $id: undefined };
      if (
        tool === 'get_adcp_capabilities' &&
        ['request_signing', 'webhook_signing'].includes(name) &&
        object.properties
      )
        object.properties.profiles = {
          type: 'array',
          items: {
            type: 'string',
            enum:
              name === 'request_signing'
                ? ['adcp/request-signing/v1', 'web-bot-auth']
                : ['adcp/webhook-signing/v1', 'web-bot-auth'],
          },
          minItems: 1,
          uniqueItems: true,
        };
      for (const [k, value] of Object.entries(object)) if (k !== '$id') walk(value, k);
    }
    walk(schema);
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    for (const draft of schemas) ajv.addSchema({ ...draft, $id: 'https://adcontextprotocol.org' + draft.$id });
    validator = ajv.compile(schema);
    cache.set(key, validator);
  }
  let valid = validator(payload) === true;
  if (valid && tool === 'get_adcp_capabilities' && payload && typeof payload === 'object') {
    const body = payload as {
      account?: {
        agent_onboarding?: { sandbox?: unknown; billing?: object };
        sandbox?: boolean;
        supported_billing?: string[];
      };
      experimental_features?: string[];
    };
    const posture = body.account?.agent_onboarding;
    if (
      posture &&
      (!body.experimental_features?.includes('account.agent_onboarding') ||
        (posture.sandbox !== undefined && body.account?.sandbox !== true) ||
        Object.keys(posture.billing ?? {}).some(k => !body.account?.supported_billing?.includes(k)))
    )
      return {
        valid: false,
        variant: 'sync',
        issues: [
          {
            pointer: '/account/agent_onboarding',
            keyword: 'experimental',
            schemaPath: '/identity33/agent_onboarding',
            message: 'Onboarding requires its feature declaration and supported account tiers',
          },
        ],
      };
  }
  return {
    valid,
    variant: direction === 'request' ? 'request' : 'sync',
    issues: valid
      ? []
      : (validator.errors ?? []).map(e => ({
          pointer: e.instancePath,
          keyword: e.keyword,
          message: e.message ?? 'Invalid value',
          params: e.params,
          schemaPath: e.schemaPath,
        })),
  };
}
