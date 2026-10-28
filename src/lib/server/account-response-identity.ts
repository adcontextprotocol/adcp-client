import type { SyncAccountsSuccess } from '../types/tools.generated';
import { getSchemaDocumentByRef, getSchemaValidatorByRef } from '../validation/schema-loader';

export const ACCOUNT_REQUEST_RESULT_KEYS = ['request_id', 'resolution'] as const;
export type AccountRequestResultFields = Pick<
  SyncAccountsSuccess['accounts'][number],
  Extract<keyof SyncAccountsSuccess['accounts'][number], (typeof ACCOUNT_REQUEST_RESULT_KEYS)[number]>
>;

/** Preserve request results only after the source protocol bundle declares them. */
export function projectAccountRequestResultFields(account: object): AccountRequestResultFields {
  const source = account as Record<string, unknown>;
  const projected: AccountRequestResultFields = {};
  if (ACCOUNT_REQUEST_RESULT_KEYS.every(key => source[key] === undefined)) return projected;

  const schema = getSchemaDocumentByRef('account/sync-accounts-response.json')?.schema;
  const branches = schema?.oneOf;
  const success = Array.isArray(branches)
    ? branches.find(branch => branch && typeof branch === 'object' && branch.title === 'SyncAccountsSuccess')
    : undefined;
  const fields = success?.properties?.accounts?.items?.properties;
  for (const key of ACCOUNT_REQUEST_RESULT_KEYS) {
    const value = source[key];
    // On beta.0 these reserved fields are unknown to both source and legacy
    // schemas, so ordinary schema-diff downgrade would preserve them as extensions.
    if (value === undefined || !fields || !Object.hasOwn(fields, key)) continue;
    if (typeof value !== 'string') {
      throw new Error(`Account request result ${key} must be a string.`);
    }
    Object.assign(projected, { [key]: value });
  }
  return projected;
}

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
