/**
 * Locating and rewriting account natural keys inside a request, for the
 * client's `accountIdentityDowngrade: 'reduce'` bookkeeping.
 *
 * When a request reaches a seller on an older release, its account keys can
 * lose fields the older release cannot express (AdCP 3.2's `operator_unit`,
 * `currency`, `timezone` and `brand.countries`). The client records which
 * reduced key each buyer key reached the seller with, refuses a second buyer
 * key that would land on the same seller account, and keeps addressing the
 * account by its reduced key after the seller upgrades, until the buyer moves
 * it to the full key.
 */

import type { AccountReference } from '../types';
import { accountReferenceKey } from './account-key';

type Json = Record<string, unknown>;
type Path = ReadonlyArray<string | number>;

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Fields an older release's account key may lack. */
const REDUCIBLE_FIELDS = ['operator_unit', 'currency', 'timezone'] as const;

/** The natural-key projection of an account reference or `sync_accounts` row. */
export function naturalAccountKey(value: unknown): AccountReference | undefined {
  if (!isObject(value) || typeof value.account_id === 'string') return undefined;
  const brand = value.brand;
  if (!isObject(brand) || typeof brand.domain !== 'string' || typeof value.operator !== 'string') return undefined;
  return {
    brand: {
      domain: brand.domain,
      ...(typeof brand.brand_id === 'string' && { brand_id: brand.brand_id }),
      ...(Array.isArray(brand.countries) && { countries: brand.countries as string[] }),
    },
    operator: value.operator,
    ...(isObject(value.operator_unit) && { operator_unit: value.operator_unit as { id: string } }),
    ...(typeof value.currency === 'string' && { currency: value.currency }),
    ...(typeof value.timezone === 'string' && { timezone: value.timezone }),
    ...(typeof value.sandbox === 'boolean' && { sandbox: value.sandbox }),
  } as AccountReference;
}

export interface AccountKeySite {
  path: Path;
  key: AccountReference;
}

/**
 * Natural account keys in a request: every `account` object and every entry
 * of an `accounts` array (sync_accounts rows, list filters), at any depth.
 */
export function accountKeySites(params: unknown): AccountKeySite[] {
  const sites: AccountKeySite[] = [];
  const visit = (value: unknown, path: Path, depth: number) => {
    if (depth > 8) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...path, index], depth + 1));
      return;
    }
    if (!isObject(value)) return;
    for (const [field, child] of Object.entries(value)) {
      if (field === 'account') {
        const key = naturalAccountKey(child);
        if (key) sites.push({ path: [...path, field], key });
      } else if (field === 'accounts' && Array.isArray(child)) {
        child.forEach((entry, index) => {
          const key = naturalAccountKey(entry);
          if (key) sites.push({ path: [...path, field, index], key });
        });
      }
      visit(child, [...path, field], depth + 1);
    }
  };
  visit(params, [], 0);
  return sites;
}

export function valueAt(root: unknown, path: Path): unknown {
  let current = root;
  for (const segment of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

/**
 * Return `root` with the account key at `path` replaced by `reduced`: the
 * reducible fields `reduced` lacks are removed and the rest of the object
 * (billing, settings) is kept. Unchanged branches keep their identity.
 */
export function withReducedKeyAt<T>(root: T, path: Path, reduced: AccountReference): T {
  if (path.length === 0) {
    if (!isObject(root) || 'account_id' in reduced) return root;
    const next: Json = { ...root };
    for (const field of REDUCIBLE_FIELDS) {
      if ((reduced as Json)[field] === undefined) delete next[field];
    }
    if (isObject(next.brand) && reduced.brand.countries === undefined && 'countries' in next.brand) {
      const { countries: _, ...brand } = next.brand;
      next.brand = brand;
    }
    return next as T;
  }
  const [head, ...rest] = path;
  if (Array.isArray(root) && typeof head === 'number') {
    const copy = [...root];
    copy[head] = withReducedKeyAt(copy[head], rest, reduced);
    return copy as T;
  }
  if (isObject(root) && typeof head === 'string') {
    return { ...root, [head]: withReducedKeyAt(root[head], rest, reduced) } as T;
  }
  return root;
}

/** Fields present on `full` but absent from `reduced`, as account-relative paths. */
export function reducedFields(full: AccountReference, reduced: AccountReference): string[] {
  if ('account_id' in full || 'account_id' in reduced) return [];
  const fields: string[] = REDUCIBLE_FIELDS.filter(
    field => (full as Json)[field] !== undefined && (reduced as Json)[field] === undefined
  );
  if (full.brand.countries !== undefined && reduced.brand.countries === undefined) fields.push('brand.countries');
  return fields;
}

export function sameAccountKey(left: AccountReference, right: AccountReference): boolean {
  return accountReferenceKey(left) === accountReferenceKey(right);
}
