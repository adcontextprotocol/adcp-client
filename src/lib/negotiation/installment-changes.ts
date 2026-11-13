/**
 * Experimental AdCP 3.3 installment refinement (`media_buy.installment_refinement`):
 * shape and identity checks shared by the buyer request validator and the
 * response verifier. Not exported from the package root.
 */

import { canonicalize } from '../utils/jcs';

export const MAX_INSTALLMENT_CHANGES = 500;

const PUBLISHER_DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** `core/canonical-installment-ref.json` is closed by design, so only its identity members are accepted. */
export function isCanonicalInstallmentRef(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ['collection_ref', 'installment_id'])) return false;
  const collection = value.collection_ref;
  return (
    isRecord(collection) &&
    hasExactKeys(collection, ['publisher_domain', 'collection_id']) &&
    typeof collection.publisher_domain === 'string' &&
    collection.publisher_domain.length <= 253 &&
    PUBLISHER_DOMAIN_PATTERN.test(collection.publisher_domain) &&
    isBoundedString(collection.collection_id, 255) &&
    isBoundedString(value.installment_id, 255)
  );
}

/** Whether `value` carries a well-formed product, installment reference, and include/omit action. */
export function isInstallmentChange(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    typeof value.product_id === 'string' &&
    value.product_id.length > 0 &&
    isCanonicalInstallmentRef(value.installment_ref) &&
    (value.action === 'include' || value.action === 'omit')
  );
}

/** Uniqueness key: entries are unique by `(product_id, installment_ref)`. */
export function installmentChangeKey(change: { product_id: unknown; installment_ref: unknown }): string {
  return canonicalize([change.product_id, change.installment_ref]);
}

/** Exact identity of a request entry, which an unsatisfied entry must repeat. */
export function installmentChangeIdentity(change: {
  product_id: unknown;
  installment_ref: unknown;
  action: unknown;
}): string {
  return canonicalize([change.product_id, change.installment_ref, change.action]);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function isBoundedString(value: unknown, max: number): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
