/**
 * Coverage explanations (experimental `media_buy.reporting_subscriptions`, AdCP 3.3): why one period
 * of one (media buy, offering) pair is or is not owed, as a `CoverageTrace`.
 *
 * The verdict is the owed rule's own (`owedSubscriptionPeriodsV1`), so an explanation never disagrees
 * with the owed set. The reason is the first rule, in the frozen order of the spec's
 * `reason-codes.json`, that rejects the period, and each rule applied records the facts it read as
 * one step. Buyer (`client.reporting.explain`) and seller (`reporting.explainCoverage`) produce the
 * same JSON, as the Python SDK does (`explain_subscription_coverage`): the same steps and facts, the
 * same template sentences, and an `inputs_digest` over the same wire-visible document. Equal digests
 * with different verdicts are a logic bug in one SDK; different digests mean one side read different
 * (often stale) state.
 *
 * @packageDocumentation
 */
import { createHash } from 'node:crypto';

import { CoverageInputError } from '../../errors';
import { canonicalJsonV1 } from '../source/manifest';
import { calendarInternalsV1, createReportingPeriodCalendarV1, type ReportingPeriodCalendarV1 } from './calendar';
import {
  coverageInternalsV1 as internals,
  owedSubscriptionPeriodsV1,
  type OwedSubscriptionPeriodsInputV1,
  type OwedSubscriptionPeriodV1,
  type ReportingSubscriptionBuyV1,
  type ReportingSubscriptionVersionRecordV1,
} from './coverage';
import { COVERAGE_REASONS, COVERAGE_RULE_ORDER, type CoverageReason, type CoverageRule } from './reason-codes';
import {
  compareReportingIdsByteOrderV1,
  effectiveReportingSubscriptionMatchV1,
  reportingSubscriptionScopeIncludesV1,
  type ReportingSubscriptionOfferingV1,
} from './selection';

/** The `CoverageTrace` document version. */
export const COVERAGE_TRACE_VERSION = 1;
/** The version of {@link EXPLAIN_TEMPLATES}. */
export const EXPLAIN_TEMPLATES_VERSION = 1;

/** One rule as applied to the period, with the facts it read. */
export interface CoverageTraceStep {
  rule: CoverageRule;
  result: 'pass' | 'fail' | 'not_applicable';
  /** What the rule read. Instants are RFC 3339 UTC strings; unknown values are `null`. */
  facts: Record<string, unknown>;
}

/**
 * Why one period of one (media buy, offering) under one subscription is or is not owed. The same
 * JSON in both SDKs and on both sides of the wire.
 *
 * @experimental Reporting subscriptions (AdCP 3.3).
 */
export interface CoverageTrace {
  trace_version: 1;
  side: 'buyer' | 'seller';
  subject: {
    /** The seller's name for the caller; a buyer trace omits it. */
    principal_id?: string;
    account_id: string;
    subscription_id: string;
    /** The version that owes the period, or the version in effect at its start. */
    subscription_version: number;
    media_buy_id: string;
    /** `null` when none of the buy's packages lists an offering. */
    offering_id: string | null;
    period: { start: string; end: string; timezone: string };
  };
  verdict: 'owed' | 'not_owed';
  reason: CoverageReason;
  /** One sentence from {@link EXPLAIN_TEMPLATES}. */
  explanation: string;
  /** The rules in their fixed order, through the first that failed. */
  steps: CoverageTraceStep[];
  /** `sha256:<hex>` over the wire-visible facts local to the period. `now` is not one of them. */
  inputs_digest: string;
  /** Seller-side facts. Never sent to a buyer: send `coverageTraceForBuyer(trace)`. */
  seller_only?: Record<string, unknown>;
}

/** A period to explain: a `YYYY-MM-DD` date read in the offering's zone, an instant, or explicit bounds. */
export type CoveragePeriodSelector = string | { start: string; end: string };

/** Input to {@link explainSubscriptionCoverageV1}: the coverage input plus what to explain. */
export interface ExplainSubscriptionCoverageInputV1 extends OwedSubscriptionPeriodsInputV1 {
  /**
   * A `YYYY-MM-DD` date selects every period of the offering that starts on that date in its zone.
   * An instant selects the period containing it. `{ start, end }` must be exactly one period of the
   * offering's schedule.
   */
  period: CoveragePeriodSelector;
  /** Only this buy. Default: every buy in `buys`. */
  media_buy_id?: string;
  /** Only this offering. Default: every offering the buy's packages list. */
  offering_id?: string;
  side?: 'buyer' | 'seller';
  principal_id?: string;
  /** Seller only: buys in the account the caller cannot see (`buy_not_visible`). */
  invisible_media_buy_ids?: readonly string[];
  /** Seller only: extra `seller_only` facts. */
  seller_only?: Record<string, unknown>;
}

/** One classified period, for listing what is not owed next to what is. */
export interface ClassifiedSubscriptionPeriodV1 {
  subscription_id: string;
  subscription_version: number;
  account_id: string;
  media_buy_id: string;
  offering_id: string;
  report_definition_id: string;
  period_start: string;
  period_end: string;
  timezone: string;
  stub?: true;
  verdict: 'owed' | 'not_owed';
  reason: CoverageReason;
  /** The template sentence, as a trace's `explanation`. */
  explanation: string;
}

/**
 * One sentence per reason code. Placeholders are filled from the trace's subject and the failing
 * step's facts; instants render as RFC 3339 UTC with minute precision when the seconds are zero, and
 * an unknown value renders as "an unknown time". Both SDKs ship this table verbatim.
 *
 * @experimental Reporting subscriptions (AdCP 3.3).
 */
export const EXPLAIN_TEMPLATES: Readonly<Record<CoverageReason, string>> = {
  owed: 'Owed: {media_buy_id} under {offering_id} for the period {period_start} to {period_end}, due at {expected_at}.',
  'owed:regrant_backfill':
    'Owed as a re-grant backfill: the period {period_start} to {period_end} falls in the interruption from {unauthorized_at} to {regranted_at}, which the seller backfills; due at {expected_at}.',
  'owed:withheld':
    'Owed but withheld: the caller lost authority for {account_id} at {unauthorized_at}, so the period {period_start} to {period_end} is due again only after a re-grant.',
  period_not_ended:
    'Not owed yet: the period {period_start} to {period_end} has not ended. It becomes owed when it ends unless a later change removes it.',
  not_in_scope: 'Not owed: version {subscription_version} of {subscription_id} does not select account {account_id}.',
  'excluded:excluded_by_buyer': 'Not owed: the buyer excluded account {account_id} from {subscription_id} from {from}.',
  not_authorized:
    'Not owed: the caller held no authority for {account_id} over the period {period_start} to {period_end}.',
  before_coverage_start: 'Not owed: the period starts {period_start}, before coverage starts at {coverage_start}.',
  subscription_inactive:
    'Not owed: {subscription_id} was inactive from {deactivated_at} when the period started at {period_start}.',
  'excluded:offering_unsupported':
    'Not owed: {offering_id} does not report {media_buy_id} under the selector of version {subscription_version}.',
  outside_flight: 'Not owed: the period ends {period_end}, at or before {media_buy_id} starts at {start_time}.',
  after_stop: 'Not owed: the period starts {period_start}, at or after {media_buy_id} stopped at {stop_time}.',
  before_confirmation: 'Not owed: the period ends {period_end}, before {media_buy_id} was confirmed{confirmed_clause}.',
  'excluded:capacity': "Not owed: account {account_id} is beyond the seller's subscription capacity from {from}.",
  'excluded:overridden':
    "Not owed: another of the caller's delivery configurations takes {account_id} for this feed from {from}.",
  'excluded:action_required':
    'Not owed: the seller serves account {account_id} only after a pending action completes; excluded from {from}.',
  'gap:unauthorized': 'Not owed: the period falls in the authorization gap from {from} to {until}.',
  cutover_stretch:
    'Not owed: the period {period_start} to {period_end} in {timezone} lies outside the span its side owes around the handoff at {handoff}.',
  owed_under_other_version:
    'Not owed under version {subscription_version}: the side before the handoff at {handoff} owes this time.',
  buy_not_visible: 'Not owed: the caller cannot see {media_buy_id} through get_media_buys.',
};

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const UNKNOWN = 'an unknown time';

/** RFC 3339 UTC with a `Z` suffix and no fractional seconds when whole (as the Python SDK prints). */
function isoZ(value: number): string {
  const text = new Date(value).toISOString();
  return value % 1_000 === 0 ? `${text.slice(0, 19)}Z` : `${text.slice(0, 23)}000Z`;
}

const z = (value: number | undefined | null): string | null =>
  value === undefined || value === null || !Number.isFinite(value) ? null : isoZ(value);

/** An instant for an explanation: RFC 3339 UTC, minutes when the seconds are zero. */
function textInstant(value: unknown): string {
  if (value === undefined || value === null) return UNKNOWN;
  const instantValue = typeof value === 'number' ? value : Date.parse(String(value));
  if (!Number.isFinite(instantValue)) return String(value);
  return instantValue % 60_000 === 0 ? `${new Date(instantValue).toISOString().slice(0, 16)}Z` : isoZ(instantValue);
}

/** Render a reason's sentence from a trace subject and the failing step's parameters, as both SDKs do. */
export function renderCoverageExplanation(
  reason: CoverageReason,
  subject: Pick<CoverageTrace['subject'], 'account_id' | 'subscription_id' | 'subscription_version' | 'period'> &
    Partial<Pick<CoverageTrace['subject'], 'media_buy_id' | 'offering_id'>>,
  params: Record<string, unknown> = {}
): string {
  const values: Record<string, unknown> = {
    account_id: subject.account_id,
    subscription_id: subject.subscription_id,
    subscription_version: subject.subscription_version,
    media_buy_id: subject.media_buy_id || 'the buy',
    offering_id: subject.offering_id || 'no offering',
    period_start: textInstant(subject.period.start),
    period_end: textInstant(subject.period.end),
    timezone: subject.period.timezone || 'UTC',
  };
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'number' || (typeof value === 'string' && RFC3339.test(value))) {
      values[key] = textInstant(value);
    } else if (value === undefined || value === null) values[key] = UNKNOWN;
    else values[key] = value;
  }
  if (params.timezone) values.timezone = params.timezone;
  return EXPLAIN_TEMPLATES[reason].replace(/\{([a-z_]+)\}/g, (_match, name: string) =>
    values[name] === undefined ? UNKNOWN : String(values[name])
  );
}

/** A trace without `seller_only`, the form that may leave the seller. */
export function coverageTraceForBuyer(trace: CoverageTrace): CoverageTrace {
  const { seller_only: _sellerOnly, ...rest } = trace;
  return structuredClone(rest);
}

/** Where two traces of the same period first disagree. */
export interface CoverageTraceDifference {
  field: 'subject' | 'steps' | 'verdict' | 'reason' | 'inputs_digest';
  /** The first rule whose result or facts differ, when the difference is in a step. */
  rule: CoverageRule | null;
  left: unknown;
  right: unknown;
  /** Equal digests: one SDK applied a rule differently. Otherwise the two sides read different state. */
  same_inputs: boolean;
  /** One sentence naming the difference and what it means. */
  description: string;
}

/**
 * The first difference between two traces of one period, or `null`: the subject (without
 * `principal_id`), then each rule's result and facts in rule order, then the verdict and reason.
 * `side`, the explanation wording and `seller_only` are not compared.
 *
 * @experimental Reporting subscriptions (AdCP 3.3).
 */
export function diffCoverageTraces(left: CoverageTrace, right: CoverageTrace): CoverageTraceDifference | null {
  const same = left.inputs_digest === right.inputs_digest;
  const plain = (value: unknown) => canonicalJsonV1(stripUndefined(value));
  const make = (
    field: CoverageTraceDifference['field'],
    rule: CoverageRule | null,
    a: unknown,
    b: unknown
  ): CoverageTraceDifference => ({
    field,
    rule,
    left: a,
    right: b,
    same_inputs: same,
    description: `First difference at ${rule ? `rule ${JSON.stringify(rule)}` : field}: ${JSON.stringify(a)} != ${JSON.stringify(b)}. ${
      same
        ? 'Equal inputs_digest: one SDK applied the rule differently.'
        : 'Different inputs_digest: the two sides read different state.'
    }`,
  });
  const subjects = [left, right].map(trace => {
    const { principal_id: _principal, ...rest } = trace.subject;
    return rest;
  });
  if (plain(subjects[0]) !== plain(subjects[1])) return make('subject', null, subjects[0], subjects[1]);
  for (const rule of COVERAGE_RULE_ORDER) {
    const a = left.steps.find(step => step.rule === rule) ?? null;
    const b = right.steps.find(step => step.rule === rule) ?? null;
    if (a === null && b === null) continue;
    if (plain(a) !== plain(b)) return make('steps', rule, a, b);
  }
  if (left.verdict !== right.verdict) return make('verdict', null, left.verdict, right.verdict);
  if (left.reason !== right.reason) return make('reason', null, left.reason, right.reason);
  if (!same) return make('inputs_digest', null, left.inputs_digest, right.inputs_digest);
  return null;
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, stripUndefined(item)])
    );
  }
  return value;
}

// -- context -------------------------------------------------------------------------------------

interface Removal {
  reason: string;
  from: number;
  until: number;
  media_buy_id?: string;
  offering_id?: string;
  package_ids?: string[];
}

interface VersionWindow {
  version: ReportingSubscriptionVersionRecordV1;
  acceptedAt: number;
  /** `superseded_at`, else the next version's `accepted_at`. */
  endsAt: number | undefined;
  /** The readback's `inactive_intervals`, which apply to every version, plus this version's deactivation. */
  inactive: Array<{ from: number; until: number | undefined }>;
}

type Chains = ReturnType<typeof internals.authorityChains>;
type Regimes = ReturnType<typeof internals.regimesForBuy>;

interface Context {
  input: OwedSubscriptionPeriodsInputV1;
  now: number;
  offerings: Map<string, ReportingSubscriptionOfferingV1>;
  windows: VersionWindow[];
  inScope: Map<number, boolean>;
  chains: Chains;
  timezones: ReturnType<typeof internals.timezoneTimeline>;
  removals: Removal[];
  packageRemovals: Removal[];
  membershipIntervals: boolean;
  calendars: Map<string, ReportingPeriodCalendarV1>;
  regimes: Map<string, Regimes>;
  owed: Map<string, OwedSubscriptionPeriodV1>;
  owedHorizon: number;
}

const rowKey = (buy: string, offering: string, start: number, end: number) =>
  JSON.stringify([buy, offering, start, end]);

function context(input: OwedSubscriptionPeriodsInputV1): Context {
  const offerings = new Map(input.offerings.map(offering => [offering.offering_id, offering]));
  const records = input.versions;
  const shared = internals.inactiveWindows(input.inactive_intervals).map(window => ({
    from: window.from,
    until: Number.isFinite(window.until) ? window.until : undefined,
  }));
  const windows: VersionWindow[] = records.map((version, index) => {
    const next = records[index + 1];
    const acceptedAt = internals.instant(version.accepted_at, 'accepted_at');
    const endsAt =
      version.superseded_at !== undefined
        ? internals.instant(version.superseded_at, 'superseded_at')
        : next !== undefined
          ? internals.instant(next.accepted_at, 'accepted_at')
          : undefined;
    const inactive = [...shared];
    if (version.deactivated_at !== undefined) {
      inactive.push({ from: internals.instant(version.deactivated_at, 'deactivated_at'), until: undefined });
    }
    return { version, acceptedAt, endsAt, inactive };
  });
  const toRemoval = (entry: {
    reason: string;
    from: string;
    until?: string;
    media_buy_id?: string;
    offering_id?: string;
    package_ids?: string[];
  }): Removal => ({
    reason: entry.reason,
    from: internals.instant(entry.from, 'from'),
    until: entry.until === undefined ? Number.POSITIVE_INFINITY : internals.instant(entry.until, 'until'),
    ...(entry.media_buy_id !== undefined ? { media_buy_id: entry.media_buy_id } : {}),
    ...(entry.offering_id !== undefined ? { offering_id: entry.offering_id } : {}),
    ...(entry.package_ids !== undefined ? { package_ids: [...entry.package_ids] } : {}),
  });
  const excluded = (input.coverage?.excluded ?? []).map(toRemoval);
  const gaps = (input.coverage?.gaps ?? []).map(gap => toRemoval({ ...gap, reason: 'unauthorized' }));
  const membershipIntervals = (input.coverage?.excluded ?? []).some(
    entry => entry.reason === 'excluded_by_buyer' && entry.media_buy_id === undefined
  );
  const scopeAccount = {
    account_id: input.account.account_id,
    ...(input.account.operator !== undefined ? { operator: input.account.operator } : {}),
  };
  const inScope = new Map<number, boolean>();
  for (const version of records) {
    const configuration = version.configuration;
    inScope.set(
      version.subscription_version,
      reportingSubscriptionScopeIncludesV1(
        membershipIntervals
          ? {
              scope: { all_authorized_accounts: true },
              ...(configuration.operator_domains ? { operator_domains: configuration.operator_domains } : {}),
            }
          : configuration,
        scopeAccount
      )
    );
  }
  return {
    input,
    now: internals.instant(input.now, 'now'),
    offerings,
    windows,
    inScope,
    chains: internals.authorityChains(input.account.grants, input.status_retention_days),
    timezones: internals.timezoneTimeline(input.account.timezone, input.coverage?.timezone_cutovers),
    removals: [...excluded.filter(item => item.package_ids === undefined), ...gaps],
    packageRemovals: excluded.filter(item => item.package_ids !== undefined),
    membershipIntervals,
    calendars: new Map(),
    regimes: new Map(),
    owed: new Map(),
    owedHorizon: Number.NEGATIVE_INFINITY,
  };
}

const removes = (removal: Removal, start: number, buyId: string, offeringId?: string | null) =>
  (removal.media_buy_id === undefined || removal.media_buy_id === buyId) &&
  (removal.offering_id === undefined ||
    offeringId === undefined ||
    offeringId === null ||
    removal.offering_id === offeringId) &&
  start >= removal.from &&
  start < removal.until;

/** Run the owed rule once, at a horizon covering every period asked about (the set is prefix-stable). */
function ensureOwed(ctx: Context, horizon: number): void {
  if (horizon <= ctx.owedHorizon) return;
  const at = Math.max(horizon, ctx.now);
  ctx.owed.clear();
  for (const row of owedSubscriptionPeriodsV1({ ...ctx.input, now: isoZ(at) })) {
    ctx.owed.set(
      rowKey(row.media_buy_id, row.offering_id, Date.parse(row.period_start), Date.parse(row.period_end)),
      row
    );
  }
  ctx.owedHorizon = at;
}

function windowAt(ctx: Context, at: number): VersionWindow {
  for (const window of ctx.windows) {
    if (window.acceptedAt <= at && (window.endsAt === undefined || at < window.endsAt)) return window;
  }
  return at < ctx.windows[0]!.acceptedAt ? ctx.windows[0]! : ctx.windows.at(-1)!;
}

function regimesOf(ctx: Context, buy: ReportingSubscriptionBuyV1): Regimes {
  let regimes = ctx.regimes.get(buy.media_buy_id);
  if (!regimes) {
    regimes = internals.regimesForBuy(ctx.input, buy);
    ctx.regimes.set(buy.media_buy_id, regimes);
  }
  return regimes;
}

function calendarFor(ctx: Context, offering: ReportingSubscriptionOfferingV1, zone: string): ReportingPeriodCalendarV1 {
  const schedule = offering.schedule;
  const spec =
    schedule.alignment === 'utc'
      ? { period_duration: schedule.period_duration, alignment: 'utc' as const }
      : {
          period_duration: schedule.period_duration,
          alignment: schedule.alignment,
          timezone: zone,
          ...(schedule.alignment === 'billing_cycle' ? { period_anchor: schedule.period_anchor! } : {}),
        };
  const key = JSON.stringify(spec);
  let calendar = ctx.calendars.get(key);
  if (!calendar) {
    calendar = createReportingPeriodCalendarV1(spec);
    ctx.calendars.set(key, calendar);
  }
  return calendar;
}

/** The zone an offering's periods use at an instant, honoring a version's `period_timezone`. */
function zoneAt(
  ctx: Context,
  offering: ReportingSubscriptionOfferingV1,
  override: string | undefined,
  at: number
): string {
  const accountZone =
    offering.schedule.alignment === 'account_timezone' && override === undefined
      ? internals.timezoneFor(ctx.timezones, offering.offering_id, at)
      : undefined;
  const spec = internals.calendarSpec(offering, override, accountZone, ctx.input.account.source_timezone) as {
    timezone?: string;
  };
  return spec.timezone ?? 'UTC';
}

/** Every zone the offering's periods can take: both sides of a timezone cutover, and each override. */
function zonesOf(ctx: Context, offering: ReportingSubscriptionOfferingV1, around: readonly number[]): string[] {
  const overrides = [...new Set(ctx.windows.map(window => window.version.configuration.selector.period_timezone))];
  const accounts: Array<string | undefined> = [ctx.input.account.timezone];
  for (const cutover of ctx.timezones.cutovers) {
    if (cutover.offeringId === undefined || cutover.offeringId === offering.offering_id) {
      accounts.push(cutover.previous, cutover.timezone);
    }
  }
  for (const at of around) {
    try {
      accounts.push(internals.timezoneFor(ctx.timezones, offering.offering_id, at));
    } catch {
      // A cutover without previous_timezone is reported by the owed rule.
    }
  }
  const zones: string[] = [];
  let firstError: unknown;
  for (const override of overrides) {
    for (const accountZone of accounts) {
      try {
        const spec = internals.calendarSpec(
          offering,
          override,
          offering.schedule.alignment === 'account_timezone' && override === undefined ? accountZone : undefined,
          ctx.input.account.source_timezone
        ) as { timezone?: string };
        const zone = spec.timezone ?? 'UTC';
        if (!zones.includes(zone)) zones.push(zone);
      } catch (error) {
        firstError ??= error;
      }
    }
  }
  if (zones.length === 0) throw firstError;
  return zones;
}

function localDay(date: string, zone: string): { start: number; end: number } {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const wall = Date.UTC(year, month - 1, day);
  const toInstant = (value: number) => (zone === 'UTC' ? value : calendarInternalsV1.instantForWall(value, zone));
  return { start: toInstant(wall), end: toInstant(wall + DAY_MS) };
}

function localDate(instantValue: number, zone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    instantValue
  );
}

type Selection =
  | { kind: 'date'; value: string }
  | { kind: 'instant'; value: number }
  | { kind: 'range'; start: number; end: number };

function selection(period: CoveragePeriodSelector): Selection {
  if (typeof period === 'string') {
    if (DATE.test(period)) return { kind: 'date', value: period };
    return { kind: 'instant', value: internals.instant(period, 'period') };
  }
  if (period && typeof period === 'object') {
    const start = internals.instant(period.start, 'period.start');
    const end = internals.instant(period.end, 'period.end');
    if (end <= start) {
      throw new CoverageInputError('COVERAGE_INPUT_INVALID', 'period needs a start before its end', 'invalid_input');
    }
    return { kind: 'range', start, end };
  }
  throw new CoverageInputError(
    'COVERAGE_INPUT_INVALID',
    "period is a YYYY-MM-DD date read in the offering's zone, an instant, or { start, end }",
    'invalid_input'
  );
}

function periodsFor(
  calendar: ReportingPeriodCalendarV1,
  chosen: Selection,
  zone: string
): Array<{ start: number; end: number }> {
  if (chosen.kind === 'range') {
    return calendar.floor(chosen.start) === chosen.start && calendar.next(chosen.start) === chosen.end
      ? [{ start: chosen.start, end: chosen.end }]
      : [];
  }
  if (chosen.kind === 'instant') {
    const start = calendar.floor(chosen.value);
    return [{ start, end: calendar.next(start) }];
  }
  const day = localDay(chosen.value, zone);
  const periods: Array<{ start: number; end: number }> = [];
  for (let start = calendar.ceil(day.start); start < day.end && periods.length < 1_440; ) {
    const end = calendar.next(start);
    periods.push({ start, end });
    start = end;
  }
  return periods;
}

// -- classification ------------------------------------------------------------------------------

interface Candidate {
  buy: ReportingSubscriptionBuyV1;
  offering: ReportingSubscriptionOfferingV1 | null;
  calendar: ReportingPeriodCalendarV1 | null;
  start: number;
  end: number;
  zone: string;
}

interface Walk {
  steps: CoverageTraceStep[];
  reason?: CoverageReason;
  params: Record<string, unknown>;
}

function chainFacts(chains: Chains): Record<string, unknown> {
  const chain = chains.at(-1);
  if (!chain) return { authorized_at: null, chain: 'not_advertised' };
  const regrants = chain.interruptions.flatMap(item => (item.regrantedAt !== undefined ? [item.regrantedAt] : []));
  return {
    authorized_at: z(chain.start),
    unauthorized_at: z(chain.end),
    regranted_at: regrants.length > 0 ? z(Math.max(...regrants)) : null,
    chain: chain.interruptions.length > 0 ? 'continued' : chains.length > 1 ? 'new' : 'single',
  };
}

function interruptionOf(chains: Chains, start: number, end: number): [number, number] | undefined {
  for (const chain of chains) {
    for (const item of chain.interruptions) {
      if (item.regrantedAt !== undefined && end > item.revokedAt && start < item.regrantedAt) {
        return [item.revokedAt, item.regrantedAt];
      }
    }
  }
  return undefined;
}

function exceptionFacts(item: Removal): Record<string, unknown> {
  return {
    reason: item.reason === 'unauthorized' ? 'gap' : item.reason,
    from: z(item.from),
    until: z(item.until),
    ...(item.media_buy_id !== undefined ? { media_buy_id: item.media_buy_id } : {}),
    ...(item.offering_id !== undefined ? { offering_id: item.offering_id } : {}),
    ...(item.package_ids !== undefined ? { package_ids: [...item.package_ids].sort() } : {}),
  };
}

function listedOfferings(buy: ReportingSubscriptionBuyV1): string[] {
  return [...new Set(buy.packages.flatMap(pkg => [...pkg.reporting_delivery_offering_ids]))].sort(
    compareReportingIdsByteOrderV1
  );
}

function slaMilliseconds(offering: ReportingSubscriptionOfferingV1): number {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(offering.schedule.delivery_sla ?? '');
  if (!match) return 0;
  const [, days, hours, minutes, seconds] = match.map(part => Number(part ?? 0)) as number[];
  return (((days! * 24 + hours!) * 60 + minutes!) * 60 + seconds!) * 1_000;
}

function classify(
  ctx: Context,
  candidate: Candidate,
  owed: OwedSubscriptionPeriodV1 | undefined,
  elsewhere: OwedSubscriptionPeriodV1 | undefined,
  invisible: boolean
): { walk: Walk; version: number } {
  const walk: Walk = { steps: [], params: {} };
  const pass = (rule: CoverageRule, facts: Record<string, unknown> = {}) =>
    walk.steps.push({ rule, result: 'pass', facts });
  const skip = (rule: CoverageRule, facts: Record<string, unknown> = {}) =>
    walk.steps.push({ rule, result: 'not_applicable', facts });
  const fail = (
    rule: CoverageRule,
    reason: CoverageReason,
    facts: Record<string, unknown>,
    params: Record<string, unknown> = {}
  ) => {
    walk.steps.push({ rule, result: 'fail', facts });
    walk.reason = reason;
    Object.assign(walk.params, params);
  };
  const { buy, offering, start, end } = candidate;
  const offeringId = offering?.offering_id ?? null;
  const window = windowAt(ctx, start);
  const version = owed?.subscription_version ?? window.version.subscription_version;
  const configuration = window.version.configuration;
  const scope = configuration.scope as { account_ids?: string[] };
  const account = ctx.input.account;
  const done = () => ({ walk, version });

  // scope
  const scopeFacts = {
    scope: scope.account_ids !== undefined ? 'account_ids' : 'all_authorized_accounts',
    operator_domains: configuration.operator_domains?.length ? [...configuration.operator_domains].sort() : null,
    operator: account.operator ?? null,
  };
  if (invisible) {
    fail('scope', 'buy_not_visible', { ...scopeFacts, buy_visible: false });
    return done();
  }
  const buyerExclusion = ctx.removals.find(
    item => item.reason === 'excluded_by_buyer' && removes(item, start, buy.media_buy_id)
  );
  if (
    buyerExclusion !== undefined ||
    (!ctx.membershipIntervals && configuration.exclude_account_ids?.includes(account.account_id))
  ) {
    fail(
      'scope',
      'excluded:excluded_by_buyer',
      { ...scopeFacts, excluded_by_buyer: true, ...(buyerExclusion ? exceptionFacts(buyerExclusion) : {}) },
      { from: buyerExclusion ? buyerExclusion.from : window.acceptedAt }
    );
    return done();
  }
  if (!ctx.inScope.get(window.version.subscription_version)) {
    fail('scope', 'not_in_scope', scopeFacts);
    return done();
  }
  pass('scope', scopeFacts);

  // authorization
  const chains = ctx.chains;
  const authorizationFacts = chainFacts(chains);
  if (chains.length > 0 && start >= chains[0]!.start) {
    const held = chains.some(chain => start >= chain.start && (chain.end === undefined || end <= chain.end));
    if (!held) {
      const lost = chains.find(chain => chain.end !== undefined && end > chain.end);
      fail('authorization', 'not_authorized', authorizationFacts, { unauthorized_at: lost?.end ?? null });
      return done();
    }
  }
  pass('authorization', authorizationFacts);

  // version
  const selecting = ctx.windows
    .filter(item => ctx.inScope.get(item.version.subscription_version))
    .map(item => item.acceptedAt);
  let coverageStart = Math.max(Math.min(...selecting), ...(chains.length > 0 ? [chains[0]!.start] : []));
  if (candidate.calendar !== null) coverageStart = candidate.calendar.ceil(coverageStart);
  const versionFacts = {
    subscription_version: window.version.subscription_version,
    accepted_at: z(window.acceptedAt),
    coverage_start: z(coverageStart),
  };
  if (start < coverageStart) {
    fail('version', 'before_coverage_start', versionFacts, { coverage_start: coverageStart });
    return done();
  }
  pass('version', versionFacts);

  // activity
  const activityFacts: Record<string, unknown> = {
    inactive_intervals: window.inactive.map(item => ({ from: z(item.from), until: z(item.until) })),
  };
  const interval = window.inactive.find(item => item.from <= start && (item.until === undefined || start < item.until));
  const last = ctx.windows.at(-1)!;
  const deactivated = window === last && window.endsAt !== undefined && start >= window.endsAt;
  if (interval !== undefined || deactivated) {
    const deactivatedAt = interval !== undefined ? interval.from : window.endsAt!;
    fail(
      'activity',
      'subscription_inactive',
      { ...activityFacts, deactivated_at: z(deactivatedAt) },
      { deactivated_at: deactivatedAt }
    );
    return done();
  }
  pass('activity', activityFacts);

  // offering
  const confirmed = buy.confirmed_at !== undefined && buy.confirmed_at !== null;
  const regime = confirmed
    ? regimesOf(ctx, buy).find(item => item !== null && item.from <= start && start < item.until)
    : undefined;
  const candidates = listedOfferings(buy);
  const resolved = regime ? [...regime.resolved] : [];
  const offeringFacts = {
    match: effectiveReportingSubscriptionMatchV1(configuration.selector),
    candidates,
    resolved,
    selected: offeringId,
  };
  const unsupported = ctx.removals.find(
    item => item.reason === 'offering_unsupported' && removes(item, start, buy.media_buy_id, offeringId)
  );
  if (unsupported) {
    fail('offering', 'excluded:offering_unsupported', { ...offeringFacts, ...exceptionFacts(unsupported) });
    return done();
  }
  const resolves =
    offeringId !== null && (resolved.includes(offeringId) || (!confirmed && candidates.includes(offeringId)));
  if (!resolves) {
    fail('offering', 'excluded:offering_unsupported', offeringFacts);
    return done();
  }
  pass('offering', offeringFacts);

  // flight
  const flight = internals.flightAt(internals.flightTimeline(buy), end);
  const flightFacts = { start_time: z(flight.start), stop_time: z(flight.stop), as_of: z(end) };
  if (flight.stop <= flight.start || end <= flight.start) {
    fail('flight', 'outside_flight', flightFacts, { start_time: flight.start });
    return done();
  }
  if (start >= flight.stop) {
    fail('flight', 'after_stop', flightFacts, { stop_time: flight.stop });
    return done();
  }
  pass('flight', flightFacts);

  // confirmation
  const confirmedAt = confirmed ? internals.instant(buy.confirmed_at, 'confirmed_at') : undefined;
  const confirmationFacts = { confirmed_at: z(confirmedAt) };
  if (confirmedAt === undefined || end <= confirmedAt) {
    fail('confirmation', 'before_confirmation', confirmationFacts, {
      confirmed_clause: confirmedAt !== undefined ? ` at ${textInstant(confirmedAt)}` : ' (it is not confirmed yet)',
    });
    return done();
  }
  pass('confirmation', confirmationFacts);

  // exception
  const exception = ctx.removals.find(
    item =>
      (item.reason === 'capacity' || item.reason === 'overridden' || item.reason === 'action_required') &&
      removes(item, start, buy.media_buy_id, offeringId)
  );
  if (exception) {
    fail('exception', `excluded:${exception.reason}` as CoverageReason, exceptionFacts(exception), {
      from: exception.from,
      until: Number.isFinite(exception.until) ? exception.until : null,
    });
    return done();
  }
  pass('exception', { open: [] });

  // gap
  const backfill = ctx.input.backfill_on_regrant === true;
  const gap = ctx.removals.find(
    item => item.reason === 'unauthorized' && removes(item, start, buy.media_buy_id, offeringId)
  );
  const interruption = interruptionOf(chains, start, end);
  if (gap) {
    fail('gap', 'gap:unauthorized', exceptionFacts(gap), { from: gap.from, until: gap.until });
    return done();
  }
  const gapFacts = {
    backfill_on_regrant: backfill,
    interruption: interruption ? { unauthorized_at: z(interruption[0]), regranted_at: z(interruption[1]) } : null,
  };
  if (interruption && !backfill) {
    fail('gap', 'gap:unauthorized', gapFacts, { from: interruption[0], until: interruption[1] });
    return done();
  }
  pass('gap', gapFacts);

  // cutover and timezone
  const handoff = regime && offeringId !== null ? regime.handoffs.get(offeringId) : undefined;
  const cutoverFacts: Record<string, unknown> = { handoff: z(handoff) };
  const timezoneRule = offering !== null && offering.schedule.alignment === 'account_timezone';
  let zoneNow: string | null = null;
  if (offering !== null) {
    try {
      zoneNow = internals.timezoneFor(ctx.timezones, offering.offering_id, start) ?? null;
    } catch {
      zoneNow = null;
    }
  }
  const zoneFacts = { timezone: candidate.zone, zone_in_effect: zoneNow };
  if (owed === undefined) {
    if (timezoneRule && configuration.selector.period_timezone === undefined && zoneNow !== candidate.zone) {
      pass('cutover', cutoverFacts);
      const change = ctx.timezones.cutovers.find(
        item => item.offeringId === undefined || item.offeringId === offeringId
      );
      fail('timezone', 'cutover_stretch', zoneFacts, { handoff: change?.at ?? null, timezone: candidate.zone });
      return done();
    }
    const straddles = handoff !== undefined && start < handoff && handoff < end;
    if (elsewhere) cutoverFacts.owed_under_version = elsewhere.subscription_version;
    fail(
      'cutover',
      straddles || elsewhere === undefined ? 'cutover_stretch' : 'owed_under_other_version',
      cutoverFacts,
      { handoff: handoff ?? null, timezone: candidate.zone }
    );
    return done();
  }
  pass('cutover', cutoverFacts);
  if (timezoneRule) pass('timezone', zoneFacts);
  else skip('timezone', zoneFacts);

  // outcome
  walk.params.expected_at = offering ? end + slaMilliseconds(offering) : null;
  const lastChain = chains.at(-1);
  if (end > ctx.now) walk.reason = 'period_not_ended';
  else if (lastChain?.end !== undefined && end <= lastChain.end) {
    walk.reason = 'owed:withheld';
    walk.params.unauthorized_at = lastChain.end;
  } else if (backfill && interruption) {
    // Due at the re-grant plus the offering's delivery_sla (reason-codes.json).
    if (offering) walk.params.expected_at = Math.max(end, interruption[1]) + slaMilliseconds(offering);
    walk.reason = 'owed:regrant_backfill';
    walk.params.unauthorized_at = interruption[0];
    walk.params.regranted_at = interruption[1];
  } else walk.reason = 'owed';
  return done();
}

// -- the digest ----------------------------------------------------------------------------------

/** A version's configuration as both sides read it: sets sorted, defaults spelled out. */
function normalizedConfiguration(
  configuration: ReportingSubscriptionVersionRecordV1['configuration']
): Record<string, unknown> {
  const {
    active: _active,
    replace_account_configs: _replace,
    context: _context,
    ext: _ext,
    ...payload
  } = structuredClone(configuration) as unknown as Record<string, unknown>;
  const scope = { ...((payload.scope as Record<string, unknown> | undefined) ?? {}) };
  if (Array.isArray(scope.account_ids)) scope.account_ids = [...(scope.account_ids as string[])].sort();
  payload.scope = scope;
  for (const name of ['exclude_account_ids', 'operator_domains']) {
    if (Array.isArray(payload[name])) payload[name] = [...(payload[name] as string[])].sort();
  }
  if (Array.isArray(payload.destination_overrides)) {
    payload.destination_overrides = (payload.destination_overrides as Array<Record<string, unknown>>)
      .map(item => {
        const copy = { ...item };
        for (const name of ['account_ids', 'operator_domains']) {
          if (Array.isArray(copy[name])) copy[name] = [...(copy[name] as string[])].sort();
        }
        return copy;
      })
      .sort((left, right) => (String(left.destination_id) < String(right.destination_id) ? -1 : 1));
  }
  const selector = { ...((payload.selector as Record<string, unknown> | undefined) ?? {}) };
  if (Array.isArray(selector.dimensions)) selector.dimensions = [...(selector.dimensions as string[])].sort();
  selector.match ??= 'dimensions' in selector ? 'exact' : 'finest';
  payload.selector = selector;
  return payload;
}

function buyFacts(buy: ReportingSubscriptionBuyV1): Record<string, unknown> {
  const instant = (value: string | null | undefined) =>
    value === undefined || value === null ? null : z(internals.instant(value, 'buy'));
  return {
    media_buy_id: buy.media_buy_id,
    confirmed_at: instant(buy.confirmed_at),
    start_time: instant(buy.start_time),
    end_time: instant(buy.end_time),
    canceled_at: instant(buy.canceled_at),
    cancellation_effective_at: instant(buy.cancellation_effective_at),
    completed_at: instant(buy.completed_at),
    packages: [...buy.packages]
      .sort((left, right) => compareReportingIdsByteOrderV1(left.package_id, right.package_id))
      .map(pkg => ({
        package_id: pkg.package_id,
        reporting_delivery_offering_ids: [...pkg.reporting_delivery_offering_ids].sort(),
      })),
    flight_history: (buy.flight_history ?? []).map(entry => ({
      superseded_at: instant(entry.recorded_at),
      start_time: instant(entry.start_time),
      stop_time: instant(entry.stop_time),
    })),
  };
}

function offeringFacts(offering: ReportingSubscriptionOfferingV1 | null): Record<string, unknown> | null {
  if (offering === null) return null;
  const schedule = offering.schedule as {
    period_duration: string;
    alignment: string;
    delivery_sla: string;
    period_timezone?: string;
    period_anchor?: string;
  };
  const instant = (value: string | undefined) => (value === undefined ? null : z(internals.instant(value, 'offering')));
  return {
    offering_id: offering.offering_id,
    report_definition_id: offering.report_definition_id,
    feed_purpose: offering.feed_purpose,
    period_duration: schedule.period_duration,
    alignment: schedule.alignment,
    delivery_sla: schedule.delivery_sla,
    period_timezone: schedule.period_timezone ?? null,
    period_anchor: instant(schedule.period_anchor),
    available_from: instant(offering.available_from),
    withdrawn_at: instant(offering.withdrawn_at),
  };
}

/** The wire-visible authorization: chain start, latest re-grant, and a current loss. */
function authorizationProjection(chains: Chains): Record<string, unknown> {
  const chain = chains.at(-1);
  if (!chain) return {};
  const regrants = chain.interruptions.flatMap(item => (item.regrantedAt !== undefined ? [item.regrantedAt] : []));
  return {
    authorized_at: z(chain.start),
    regranted_at: regrants.length > 0 ? z(Math.max(...regrants)) : null,
    ...(chain.end !== undefined ? { unauthorized_at: z(chain.end) } : {}),
  };
}

/**
 * The wire-visible document both sides hash. `now` itself is not part of it, but whether the period
 * has ended is: two traces taken either side of the period end differ in their inputs, never only in
 * their verdict (as in the Python SDK's `period_ended`).
 */
function inputsDigest(ctx: Context, candidate: Candidate, subject: CoverageTrace['subject']): string {
  const { start, end, buy, offering } = candidate;
  const window = windowAt(ctx, start);
  const offeringId = offering?.offering_id ?? null;
  const byJson = (left: Record<string, unknown>, right: Record<string, unknown>) =>
    canonicalJsonV1(left) < canonicalJsonV1(right) ? -1 : 1;
  const covering = ctx.removals
    .filter(item => item.reason !== 'unauthorized' && removes(item, start, buy.media_buy_id, offeringId))
    .map(exceptionFacts)
    .sort(byJson);
  const packages = ctx.packageRemovals
    .filter(
      item =>
        (item.media_buy_id === undefined || item.media_buy_id === buy.media_buy_id) &&
        item.from <= start &&
        start < item.until
    )
    .map(exceptionFacts)
    .sort(byJson);
  const backfill = ctx.input.backfill_on_regrant === true;
  const gap =
    ctx.removals.some(item => item.reason === 'unauthorized' && removes(item, start, buy.media_buy_id, offeringId)) ||
    (!backfill && interruptionOf(ctx.chains, start, end) !== undefined);
  let zone: string | null = null;
  if (offering !== null) {
    try {
      zone = internals.timezoneFor(ctx.timezones, offering.offering_id, start) ?? null;
    } catch {
      zone = null;
    }
  }
  const selecting = ctx.windows
    .filter(item => ctx.inScope.get(item.version.subscription_version))
    .map(item => item.acceptedAt);
  const { principal_id: _principal, ...visibleSubject } = subject;
  const document = {
    trace_version: COVERAGE_TRACE_VERSION,
    subject: visibleSubject,
    version: {
      subscription_version: window.version.subscription_version,
      accepted_at: z(window.acceptedAt),
      ends_at: z(window.endsAt),
      inactive_intervals: window.inactive.map(item => [z(item.from), z(item.until)]),
      configuration: normalizedConfiguration(window.version.configuration),
    },
    first_selecting_accepted_at: selecting.length > 0 ? z(Math.min(...selecting)) : null,
    account: { operator: ctx.input.account.operator ?? null, zone_in_effect: zone },
    authorization: authorizationProjection(ctx.chains),
    buy: buyFacts(buy),
    offering: offeringFacts(offering),
    exceptions: covering,
    package_exceptions: packages,
    authorization_gap: gap,
    backfill_on_regrant: backfill,
    status_retention_days: ctx.input.status_retention_days ?? null,
    period_ended: end <= ctx.now,
  };
  return `sha256:${createHash('sha256')
    .update(canonicalJsonV1(stripUndefined(document)), 'utf8')
    .digest('hex')}`;
}

// -- entry points --------------------------------------------------------------------------------

function candidatesFor(
  ctx: Context,
  buys: readonly ReportingSubscriptionBuyV1[],
  chosen: Selection,
  onlyOffering: string | undefined
): Candidate[] {
  const candidates: Candidate[] = [];
  const stubs = new Map<string, { start: number; end: number }>();
  for (const row of ctx.owed.values()) {
    if (row.stub) {
      stubs.set(`${row.media_buy_id}\n${row.offering_id}`, {
        start: Date.parse(row.period_start),
        end: Date.parse(row.period_end),
      });
    }
  }
  for (const buy of buys) {
    const listed = listedOfferings(buy);
    const wanted = onlyOffering !== undefined ? [onlyOffering] : listed.filter(id => ctx.offerings.has(id));
    if (wanted.length === 0) {
      const zone = ctx.input.account.timezone ?? 'UTC';
      const periods =
        chosen.kind === 'range'
          ? [{ start: chosen.start, end: chosen.end }]
          : [localDay(chosen.kind === 'date' ? chosen.value : localDate(chosen.value, zone), zone)];
      for (const { start, end } of periods) candidates.push({ buy, offering: null, calendar: null, start, end, zone });
      continue;
    }
    for (const id of wanted) {
      const offering = ctx.offerings.get(id)!;
      const reference =
        chosen.kind === 'range'
          ? chosen.start
          : chosen.kind === 'instant'
            ? chosen.value
            : localDay(chosen.value, ctx.input.account.timezone ?? 'UTC').start;
      const seen = new Set<string>();
      for (const zone of zonesOf(ctx, offering, [reference, reference + DAY_MS])) {
        const calendar = calendarFor(ctx, offering, zone);
        let periods = periodsFor(calendar, chosen, zone);
        const stub = stubs.get(`${buy.media_buy_id}\n${id}`);
        if (
          chosen.kind === 'range' &&
          periods.length === 0 &&
          stub?.start === chosen.start &&
          stub.end === chosen.end
        ) {
          periods = [{ start: chosen.start, end: chosen.end }];
        }
        for (const { start, end } of periods) {
          const key = `${start}:${end}`;
          if (seen.has(key)) continue;
          seen.add(key);
          candidates.push({ buy, offering, calendar, start, end, zone });
        }
      }
      if (chosen.kind === 'range' && seen.size === 0) {
        throw new CoverageInputError(
          'COVERAGE_INPUT_INVALID',
          `${isoZ(chosen.start)}/${isoZ(chosen.end)} is not a period of offering ${JSON.stringify(id)}. Pass a period of its schedule, a date or an instant.`,
          'invalid_input'
        );
      }
    }
  }
  return candidates;
}

function traceOf(
  ctx: Context,
  candidate: Candidate,
  options: { side: 'buyer' | 'seller'; principalId?: string; invisible: boolean; sellerOnly?: Record<string, unknown> }
): CoverageTrace {
  ensureOwed(ctx, candidate.end);
  const offeringId = candidate.offering?.offering_id ?? null;
  const owed =
    offeringId === null || options.invisible
      ? undefined
      : ctx.owed.get(rowKey(candidate.buy.media_buy_id, offeringId, candidate.start, candidate.end));
  let elsewhere: OwedSubscriptionPeriodV1 | undefined;
  if (owed === undefined && offeringId !== null) {
    for (const row of ctx.owed.values()) {
      if (
        row.media_buy_id === candidate.buy.media_buy_id &&
        row.offering_id === offeringId &&
        Date.parse(row.period_start) < candidate.end &&
        Date.parse(row.period_end) > candidate.start
      ) {
        elsewhere = row;
        break;
      }
    }
  }
  const { walk, version } = classify(ctx, candidate, owed, elsewhere, options.invisible);
  const reason = walk.reason!;
  const subject: CoverageTrace['subject'] = {
    ...(options.principalId !== undefined ? { principal_id: options.principalId } : {}),
    account_id: ctx.input.account.account_id,
    subscription_id: ctx.input.subscription_id,
    subscription_version: version,
    media_buy_id: candidate.buy.media_buy_id,
    offering_id: offeringId,
    period: { start: isoZ(candidate.start), end: isoZ(candidate.end), timezone: candidate.zone },
  };
  const verdict = COVERAGE_REASONS.find(item => item.code === reason)!.verdict;
  return {
    trace_version: 1,
    side: options.side,
    subject,
    verdict,
    reason,
    explanation: renderCoverageExplanation(reason, subject, walk.params),
    steps: walk.steps,
    inputs_digest: inputsDigest(ctx, candidate, subject),
    ...(options.side === 'seller'
      ? { seller_only: { buy_visible: !options.invisible, ...(options.sellerOnly ?? {}) } }
      : {}),
  };
}

/**
 * Explain one subscription's coverage of one account for a period: one `CoverageTrace` per (buy,
 * offering, period) the selection names, sorted by period start, buy and offering. A buy none of
 * whose packages lists an offering yields one trace with `offering_id: null`.
 *
 * Throws `CoverageInputError` for incomplete input, as `owedSubscriptionPeriodsV1` does, and for
 * explicit bounds that are not one period of the schedule.
 *
 * @experimental Reporting subscriptions (AdCP 3.3).
 */
export function explainSubscriptionCoverageV1(input: ExplainSubscriptionCoverageInputV1): CoverageTrace[] {
  const {
    period,
    media_buy_id: buyId,
    offering_id: onlyOffering,
    side = 'buyer',
    principal_id,
    invisible_media_buy_ids: invisibleIds = [],
    seller_only: sellerOnly,
    ...rest
  } = input;
  if (side !== 'buyer' && side !== 'seller') {
    throw new CoverageInputError('COVERAGE_INPUT_INVALID', "side is 'buyer' or 'seller'", 'invalid_input');
  }
  if (invisibleIds.length > 0 && side !== 'seller') {
    throw new CoverageInputError('COVERAGE_INPUT_INVALID', 'invisible_media_buy_ids is seller-only', 'invalid_input');
  }
  const hidden = new Set(invisibleIds);
  const ctx = context({ ...rest, buys: rest.buys.filter(buy => !hidden.has(buy.media_buy_id)) });
  ensureOwed(ctx, ctx.now);
  const buys = rest.buys.filter(buy => buyId === undefined || buy.media_buy_id === buyId);
  if (buyId !== undefined && buys.length === 0) {
    throw new CoverageInputError(
      'COVERAGE_INPUT_INVALID',
      `media_buy_id ${JSON.stringify(buyId)} is not among the buys of account ${rest.account.account_id}. Check get_media_buys for the account.`,
      'invalid_input'
    );
  }
  if (onlyOffering !== undefined && !ctx.offerings.has(onlyOffering)) {
    throw new CoverageInputError(
      'COVERAGE_INPUT_INVALID',
      `offering_id ${JSON.stringify(onlyOffering)} is not among the seller's offerings. Check get_adcp_capabilities.`,
      'invalid_input'
    );
  }
  const traces = candidatesFor(ctx, buys, selection(period), onlyOffering).map(candidate =>
    traceOf(ctx, candidate, {
      side,
      ...(principal_id !== undefined ? { principalId: principal_id } : {}),
      invisible: hidden.has(candidate.buy.media_buy_id),
      ...(sellerOnly ? { sellerOnly } : {}),
    })
  );
  return traces.sort(
    (left, right) =>
      Date.parse(left.subject.period.start) - Date.parse(right.subject.period.start) ||
      compareReportingIdsByteOrderV1(left.subject.media_buy_id, right.subject.media_buy_id) ||
      compareReportingIdsByteOrderV1(left.subject.offering_id ?? '', right.subject.offering_id ?? '') ||
      (left.subject.period.timezone < right.subject.period.timezone ? -1 : 1)
  );
}

/**
 * Every schedule period of each (buy, listed offering) that overlaps `[from, until)`, owed or not,
 * with its reason. `until` defaults to `now`. The owed ones are exactly `owedSubscriptionPeriodsV1`'s
 * rows in the window (billing stubs included).
 *
 * @experimental Reporting subscriptions (AdCP 3.3).
 */
export function classifySubscriptionPeriodsV1(
  input: OwedSubscriptionPeriodsInputV1 & { from: string; until?: string; max_periods?: number }
): ClassifiedSubscriptionPeriodV1[] {
  const ctx = context(input);
  const from = internals.instant(input.from, 'from');
  const until = input.until === undefined ? ctx.now : internals.instant(input.until, 'until');
  const budget = input.max_periods ?? 100_000;
  ensureOwed(ctx, until);
  const result: ClassifiedSubscriptionPeriodV1[] = [];
  const push = (candidate: Candidate) => {
    const offering = candidate.offering!;
    const trace = traceOf(ctx, candidate, { side: 'buyer', invisible: false });
    const row = ctx.owed.get(rowKey(candidate.buy.media_buy_id, offering.offering_id, candidate.start, candidate.end));
    result.push({
      subscription_id: input.subscription_id,
      subscription_version: trace.subject.subscription_version,
      account_id: input.account.account_id,
      media_buy_id: candidate.buy.media_buy_id,
      offering_id: offering.offering_id,
      report_definition_id: offering.report_definition_id,
      period_start: new Date(candidate.start).toISOString(),
      period_end: new Date(candidate.end).toISOString(),
      timezone: candidate.zone,
      ...(row?.stub ? { stub: true as const } : {}),
      verdict: trace.verdict,
      reason: trace.reason,
      explanation: trace.explanation,
    });
    if (result.length > budget) {
      throw new CoverageInputError(
        'COVERAGE_BUDGET_EXCEEDED',
        `Classified periods exceed max_periods (${budget}). Narrow the window or raise max_periods.`
      );
    }
  };
  for (const buy of input.buys) {
    const flights = internals.flightTimeline(buy);
    const firstStart = Math.min(...flights.map(entry => entry.flight.start));
    const lastStop = Math.max(...flights.map(entry => entry.flight.stop));
    for (const id of listedOfferings(buy).filter(item => ctx.offerings.has(item))) {
      const offering = ctx.offerings.get(id)!;
      const override = (at: number) => windowAt(ctx, at).version.configuration.selector.period_timezone;
      const seen = new Set<string>();
      const take = (start: number, end: number) => {
        const key = `${start}:${end}`;
        if (seen.has(key)) return;
        seen.add(key);
        const zone = zoneAt(ctx, offering, override(start), start);
        push({ buy, offering, calendar: calendarFor(ctx, offering, zone), start, end, zone });
      };
      // Owed rows first (they include billing stubs), then the schedule's other periods.
      for (const row of ctx.owed.values()) {
        if (row.media_buy_id !== buy.media_buy_id || row.offering_id !== id) continue;
        const start = Date.parse(row.period_start);
        const end = Date.parse(row.period_end);
        if (end > from && start < until) take(start, end);
      }
      let start = Math.max(from, firstStart);
      start = calendarFor(ctx, offering, zoneAt(ctx, offering, override(start), start)).floor(start);
      while (start < until && start < lastStop) {
        const calendar = calendarFor(ctx, offering, zoneAt(ctx, offering, override(start), start));
        const end = calendar.next(start);
        const overlapsOwed = [...ctx.owed.values()].some(
          row =>
            row.media_buy_id === buy.media_buy_id &&
            row.offering_id === id &&
            Date.parse(row.period_start) < end &&
            Date.parse(row.period_end) > start
        );
        if (!overlapsOwed) take(start, end);
        start = end;
      }
    }
  }
  return result.sort(
    (left, right) =>
      Date.parse(left.period_start) - Date.parse(right.period_start) ||
      compareReportingIdsByteOrderV1(left.offering_id, right.offering_id) ||
      compareReportingIdsByteOrderV1(left.media_buy_id, right.media_buy_id)
  );
}
