/**
 * Compile-time checks for the authored shapes the adopter guide documents.
 *
 * Excluded from the lib build by `tsconfig.lib.json`; checked by
 * `npm run typecheck`, which the pre-push hook runs.
 *
 * These exist because the four behavioural suites are `.js`, so nothing
 * caught the first head typing the predicate operand as the POST-DEFAULTS
 * form — which made the guide's own minimal `{ collection_targeting: 'fixed' }` a compile
 * error while still accepting a typo'd key. A documented form that does not
 * type-check is a worse failure than a missing one: the adopter trusts it.
 */

import type { FixtureContextOutput, FixtureMatchClause } from './types';
import type { CollectionSelectionSelector, ResolvedCollectionSelectionSelector } from './collection-selection';

// ── Guide § 1: the minimal authored operand ──
// `minimum_pairs` and `require_cross_publisher_collection` are optional, exactly as the
// loader accepts them.
export const minimalFixedClause: FixtureMatchClause = {
  path: '',
  operator: 'collection_selection_satisfies',
  value: { collection_targeting: 'fixed' },
};

export const minimalSelectableClause: FixtureMatchClause = {
  path: '',
  operator: 'collection_selection_satisfies',
  value: { collection_targeting: 'selectable' },
};

// ── Guide § 1: every knob, explicitly ──
export const fullyQualifiedClause: FixtureMatchClause = {
  path: '',
  operator: 'collection_selection_satisfies',
  value: { collection_targeting: 'any', minimum_pairs: 2, require_cross_publisher_collection: true },
};

// ── Guide § 2: all three capture forms ──
export const captures: FixtureContextOutput[] = [
  { key: '__adcp_fixture_product_id', path: 'product_id' },
  { key: '__adcp_fixture_subset', witness: 'strict_subset' },
  { key: '__adcp_fixture_price', snapshot: 'selected_entity' },
];

// The resolved form stays assignable to the authored one, so the evaluator's
// public signature accepts output from `normalizeCollectionSelectionSelector`
// as readily as a hand-written literal.
export const resolvedIsAssignable: CollectionSelectionSelector = {
  collection_targeting: 'fixed',
  minimum_pairs: 1,
  require_cross_publisher_collection: false,
} satisfies ResolvedCollectionSelectionSelector;

// ── Shapes that MUST NOT compile ──
// Each is the mistake the closed operand and the three-arm capture union
// exist to catch; `@ts-expect-error` fails the build if one starts compiling.

export const typoedOperandKey: FixtureMatchClause = {
  path: '',
  operator: 'collection_selection_satisfies',
  // @ts-expect-error - `minimum_pair` is a typo; the operand is closed.
  value: { collection_targeting: 'fixed', minimum_pair: 2 },
};

// @ts-expect-error - 3 is out of the supported range.
export const unsupportedPairCount: FixtureMatchClause = {
  path: '',
  operator: 'collection_selection_satisfies',
  value: { collection_targeting: 'fixed', minimum_pairs: 3 },
};

export const bothPathAndWitness: FixtureContextOutput = {
  key: '__adcp_fixture_x',
  path: 'product_id',
  // @ts-expect-error - `path` and `witness` are mutually exclusive.
  witness: 'strict_subset',
};

// @ts-expect-error - a capture must set one of the three forms.
export const neitherForm: FixtureContextOutput = { key: '__adcp_fixture_x' };

export const unknownSnapshotScope: FixtureContextOutput = {
  key: '__adcp_fixture_x',
  // @ts-expect-error - `selected_entity` is the only snapshot scope.
  snapshot: 'whole_catalog',
};
