import type { AccountReference } from '../types';

/** Stable identity; never includes billing details or credentials. */
export function accountReferenceKey(ref: AccountReference): string {
  if ('account_id' in ref) return JSON.stringify(['id', ref.account_id]);
  return JSON.stringify([
    'natural',
    ref.brand.domain,
    ref.brand.brand_id ?? null,
    ref.brand.countries ? [...ref.brand.countries].sort() : null,
    ref.operator,
    ref.operator_unit?.id ?? null,
    ref.currency ?? null,
    ref.timezone ?? null,
    ref.sandbox === true,
  ]);
}
