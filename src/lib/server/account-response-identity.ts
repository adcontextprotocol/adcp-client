import type { SyncAccountsSuccess } from '../types/tools.generated';
import { projectToDeclaredMembers } from '../adapters/version/schema-projection';
import { exceedsJsonDepth, MAX_JSON_DEPTH } from '../utils/json-depth';
import { getSchemaDocumentByRef, getSchemaValidatorByRef } from '../validation/schema-loader';
import { scanArgsForCredentials } from './credential-policy';

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
 * Members that never belong in an account response object: the SDK's own
 * internal account fields, and the write-only staged billing identity of an
 * operator-domain handoff, which MUST NOT be echoed while approval is pending.
 */
const NON_RESPONSE_ACCOUNT_MEMBERS: ReadonlySet<string> = new Set([
  'ctx_metadata',
  'authInfo',
  'destination_billing_entity',
  // Write-only billing data: `business-entity` `bank` MUST NOT be echoed, and
  // no identity object or delivery state declares these members.
  'bank',
  'billing_entity',
  'invoice_recipient',
]);

/**
 * Storage and client-secret key names beyond the request credential policy's
 * defaults. None is a declared member of the identity or delivery-state graphs
 * in the maintained 3.2 or 3.3 releases.
 */
const RESPONSE_CREDENTIAL_PATTERNS = {
  extend: [
    /secret/i,
    /access[._-]?key/i,
    /[a-z]Token$/,
    /connection[._-]?string/i,
    /^sas$/i,
    /passphrase/i,
    /(?:signing|hmac|account)[._-]?key/i,
  ],
};

/**
 * Whether `value` retains a member that must not reach an account response or
 * replay cache, at any depth: a credential-shaped key, an SDK-internal field,
 * or a write-only member. Used where AdCP 3.3.0-beta.6 opened a schema that
 * previously refused these by closure.
 */
export function retainsNonResponseAccountMember(value: unknown): boolean {
  return scanArgsForCredentials(value, RESPONSE_CREDENTIAL_PATTERNS).length > 0 || hasNonResponseMember(value);
}

function hasNonResponseMember(value: unknown, depth = 0): boolean {
  // Too deep to inspect counts as retained, rather than overflowing the stack.
  if (depth > MAX_JSON_DEPTH) return true;
  if (Array.isArray(value)) return value.some(member => hasNonResponseMember(member, depth + 1));
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(
    ([key, member]) => NON_RESPONSE_ACCOUNT_MEMBERS.has(key) || hasNonResponseMember(member, depth + 1)
  );
}

/**
 * Validate and emit a detached snapshot of each canonical identity object, so
 * retained DB/request fields or later mutations cannot enter a response or
 * replay cache, even with whole-response validation off. These four core
 * contracts are shared by the maintained 3.2 and 3.3 bundles. Up to
 * 3.3.0-beta.5 their schemas were closed, so validation alone refused retained
 * fields; 3.3.0-beta.6 opened them (adcontextprotocol/adcp#8866). The
 * projection now refuses credential-shaped keys, SDK-internal fields and
 * write-only members outright, and strips every other member the schema does
 * not declare, so only declared identity reaches the wire.
 */
export function projectAccountResponseIdentityFields(account: object): IdentityFields {
  const fields = account as Record<string, unknown>;
  const projected: IdentityFields = {};
  for (const [field, schemaRef] of Object.entries(IDENTITY_RESPONSE_SCHEMAS)) {
    const value = fields[field];
    if (value === undefined) continue;
    if (exceedsJsonDepth(value)) throw new Error(`Account response ${field} exceeds the maximum JSON depth.`);
    const snapshot: unknown = structuredClone(value);
    const validate = getSchemaValidatorByRef(schemaRef);
    if (!validate) throw new Error(`Account response identity schema unavailable: ${schemaRef}.`);
    if (!validate(snapshot) || retainsNonResponseAccountMember(snapshot)) {
      // Do not include retained property names or values in seller diagnostics.
      throw new Error(
        `Account response ${field} must match its canonical identity schema without retained internal fields.`
      );
    }
    Object.assign(projected, { [field]: projectToDeclaredMembers(schemaRef, snapshot).value });
  }
  return projected;
}
