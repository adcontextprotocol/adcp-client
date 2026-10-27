import type { SyncAccountsSuccess } from '../types/tools.generated';
import { getSchemaValidatorByRef } from '../validation/schema-loader';

const IDENTITY_RESPONSE_SCHEMAS = {
  account: 'core/account-ref.json',
  operator_unit: 'core/operator-unit.json',
  identity_change: 'core/account-identity-change.json',
  identity_change_preview: 'core/account-identity-change-preview.json',
} as const;

type IdentityFields = Pick<SyncAccountsSuccess['accounts'][number], keyof typeof IDENTITY_RESPONSE_SCHEMAS>;

/**
 * These canonical identity objects have closed schemas, including their nested
 * operator identities. Validate and emit the same detached snapshot so retained
 * DB/request fields or later mutations cannot enter a response or replay cache,
 * even with whole-response validation off. These four core contracts are shared
 * by the maintained 3.2 and 3.3 bundles.
 */
export function projectAccountResponseIdentityFields(account: object): IdentityFields {
  const fields = account as Record<string, unknown>;
  const projected: IdentityFields = {};
  for (const [field, schemaRef] of Object.entries(IDENTITY_RESPONSE_SCHEMAS)) {
    const value = fields[field];
    if (value === undefined) continue;
    const snapshot: unknown = structuredClone(value);
    const validate = getSchemaValidatorByRef(schemaRef);
    if (!validate) throw new Error(`Account response identity schema unavailable: ${schemaRef}.`);
    if (!validate(snapshot)) {
      // Do not include retained property names or values in seller diagnostics.
      throw new Error(
        `Account response ${field} must match its canonical identity schema without retained internal fields.`
      );
    }
    Object.assign(projected, { [field]: snapshot });
  }
  return projected;
}
