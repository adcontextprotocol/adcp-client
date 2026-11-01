/**
 * The frozen coverage reason-code vocabulary (experimental `media_buy.reporting_subscriptions`, AdCP
 * 3.3): why one period of one (media buy, resolved offering) pair under one subscription version is
 * or is not owed. Copied verbatim from the spec's
 * `static/compliance/source/test-vectors/reporting-subscriptions/reason-codes.json`
 * (`vocabulary_version` 1); `test/lib/reporting-subscription-explain.test.js` fails when it drifts
 * from the vendored, sha-pinned copy. Buyer and seller SDKs use these codes verbatim in
 * `CoverageTrace.reason` and `PeriodLine.reason`, so two explanations of one period compare by code.
 */

/** The vocabulary version these codes are frozen at. */
export const COVERAGE_REASON_VOCABULARY_VERSION = 1;

/**
 * The fixed order coverage rules are evaluated in. A period takes the reason of the first rule that
 * rejects it.
 */
export const COVERAGE_RULE_ORDER = [
  'scope',
  'authorization',
  'version',
  'activity',
  'offering',
  'flight',
  'confirmation',
  'exception',
  'gap',
  'cutover',
  'timezone',
] as const;

/** One coverage rule. */
export type CoverageRule = (typeof COVERAGE_RULE_ORDER)[number];

/** Every coverage reason code, with its verdict, the rule that assigns it, and the side that may report it. */
export const COVERAGE_REASONS = [
  { code: 'not_in_scope', verdict: 'not_owed', rule: 'scope', side: 'both' },
  { code: 'excluded:excluded_by_buyer', verdict: 'not_owed', rule: 'scope', side: 'both' },
  { code: 'not_authorized', verdict: 'not_owed', rule: 'authorization', side: 'both' },
  { code: 'before_coverage_start', verdict: 'not_owed', rule: 'version', side: 'both' },
  { code: 'subscription_inactive', verdict: 'not_owed', rule: 'activity', side: 'both' },
  { code: 'excluded:offering_unsupported', verdict: 'not_owed', rule: 'offering', side: 'both' },
  { code: 'outside_flight', verdict: 'not_owed', rule: 'flight', side: 'both' },
  { code: 'after_stop', verdict: 'not_owed', rule: 'flight', side: 'both' },
  { code: 'before_confirmation', verdict: 'not_owed', rule: 'confirmation', side: 'both' },
  { code: 'excluded:capacity', verdict: 'not_owed', rule: 'exception', side: 'both' },
  { code: 'excluded:overridden', verdict: 'not_owed', rule: 'exception', side: 'both' },
  { code: 'excluded:action_required', verdict: 'not_owed', rule: 'exception', side: 'both' },
  { code: 'gap:unauthorized', verdict: 'not_owed', rule: 'gap', side: 'both' },
  { code: 'cutover_stretch', verdict: 'not_owed', rule: 'cutover', side: 'both' },
  { code: 'owed_under_other_version', verdict: 'not_owed', rule: 'cutover', side: 'both' },
  { code: 'period_not_ended', verdict: 'not_owed', rule: null, side: 'both' },
  { code: 'owed', verdict: 'owed', rule: null, side: 'both' },
  { code: 'owed:regrant_backfill', verdict: 'owed', rule: null, side: 'both' },
  { code: 'owed:withheld', verdict: 'owed', rule: null, side: 'both' },
  { code: 'buy_not_visible', verdict: 'not_owed', rule: 'scope', side: 'seller' },
] as const satisfies ReadonlyArray<{
  code: string;
  verdict: 'owed' | 'not_owed';
  rule: CoverageRule | null;
  side: 'both' | 'seller';
}>;

/** Why one period is or is not owed. */
export type CoverageReason = (typeof COVERAGE_REASONS)[number]['code'];
