/**
 * Normative reporting period generation (`core/reporting-schedule.json` `period_generation`).
 *
 * Producer and consumer must derive identical half-open periods from `period_duration`,
 * `alignment`, `period_anchor` and `period_timezone`:
 *
 * - `utc` uses 1970-01-01T00:00:00Z as interval zero.
 * - `account_timezone` and `source_timezone` use local midnight on 1970-01-01 in the
 *   resolved IANA timezone.
 * - `billing_cycle` uses its `period_anchor`, read in `period_timezone`.
 *
 * Every boundary is computed directly from the origin and the interval ordinal, never by
 * stepping from a previous boundary: each duration component is multiplied by the ordinal,
 * then years and months are added to the origin's local calendar date (keeping its local day,
 * clamped to the target month's last day), then days, all as local civil-time arithmetic.
 * The resulting local wall time is resolved to an instant: a nonexistent local time advances
 * by the timezone gap, and an ambiguous one takes the earlier instant. Hours, minutes and
 * seconds are then added as exact elapsed time; they are not calendar components, so `PT24H`
 * and `P1D` differ across a DST change. This matches how the SDK resolves calendar
 * `delivery_sla` durations in buyer reconciliation.
 *
 * @packageDocumentation
 */
import { CoverageInputError } from '../../errors';

const DAY_MS = 86_400_000;
/** Nominal lengths used only to estimate an ordinal before exact correction. */
const NOMINAL_YEAR_MS = 365.2425 * DAY_MS;
const NOMINAL_MONTH_MS = NOMINAL_YEAR_MS / 12;
/** RFC 3339 year range, so every boundary renders as a valid `date-time`. */
const MIN_INSTANT = -62_135_596_800_000; // 0001-01-01T00:00:00Z
const MAX_INSTANT = 253_402_300_799_999; // 9999-12-31T23:59:59.999Z
const MAX_CORRECTION_STEPS = 4_096;

/**
 * A parsed ISO 8601 duration as the `reporting-schedule.json` pattern admits it.
 *
 * @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingIsoDurationPartsV1 {
  years: number;
  months: number;
  days: number;
  /** Hours, minutes and seconds folded into exact seconds. */
  seconds: number;
}

/**
 * Alignments defined by `core/reporting-schedule.json`.
 *
 * @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export type ReportingPeriodAlignmentV1 = 'utc' | 'account_timezone' | 'source_timezone' | 'billing_cycle';

/** @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md */
export interface ReportingPeriodCalendarSpecV1 {
  /** Strictly positive ISO 8601 duration, such as `P1D`, `PT1H` or `P1M`. */
  period_duration: string;
  alignment: ReportingPeriodAlignmentV1;
  /**
   * IANA timezone for the calendar arithmetic. Ignored for `utc`. Required for every
   * other alignment: the account's timezone for `account_timezone`, the explicit or
   * account-resolved period timezone for `source_timezone` and `billing_cycle`.
   */
  timezone?: string;
  /** Required for `billing_cycle`: the immutable instant that is interval zero. */
  period_anchor?: string;
}

/**
 * Ordered, half-open reporting periods derived from one published schedule.
 *
 * @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingPeriodCalendarV1 {
  readonly spec: Readonly<ReportingPeriodCalendarSpecV1>;
  /**
   * Epoch milliseconds of boundary `ordinal`. Boundary 0 is the schedule origin. Sub-daily
   * local calendars (#8588) have no ordinal addressing and throw; use `ceil`/`next`.
   */
  boundary(ordinal: number): number;
  /** Smallest ordinal whose boundary is at or after `instant`. */
  ceilOrdinal(instant: number): number;
  /** Largest ordinal whose boundary is at or before `instant`. */
  floorOrdinal(instant: number): number;
  /** First boundary at or after `instant`, in epoch milliseconds. */
  ceil(instant: number): number;
  /** Last boundary at or before `instant`, in epoch milliseconds. */
  floor(instant: number): number;
  /**
   * First boundary strictly after `instant`. Iterating `next` from a boundary yields every
   * period exactly once and skips zero-length periods (a repeated boundary).
   */
  next(instant: number): number;
  /** Stable identity: two calendars with equal keys produce identical boundaries. */
  readonly key: string;
}

const DURATION = /^P(?=.*[1-9])(?=\d|T)(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?=\d)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/**
 * Parse a strictly positive reporting `period_duration`. Throws on anything else.
 *
 * @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export function parseReportingPeriodDurationV1(value: string): ReportingIsoDurationPartsV1 {
  if (typeof value !== 'string' || value.length > 64)
    throw new CoverageInputError(
      'COVERAGE_INPUT_INVALID',
      'Invalid reporting period_duration',
      'invalid_period_duration'
    );
  const match = DURATION.exec(value);
  if (!match)
    throw new CoverageInputError(
      'COVERAGE_INPUT_INVALID',
      `Invalid reporting period_duration ${JSON.stringify(value)}`,
      'invalid_period_duration'
    );
  const [, years, months, days, hours, minutes, seconds] = match;
  const parts = {
    years: Number(years ?? 0),
    months: Number(months ?? 0),
    days: Number(days ?? 0),
    seconds: Number(hours ?? 0) * 3_600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0),
  };
  if (!Object.values(parts).every(Number.isSafeInteger)) {
    throw new CoverageInputError(
      'COVERAGE_INPUT_INVALID',
      `Reporting period_duration ${JSON.stringify(value)} is out of range`,
      'invalid_period_duration'
    );
  }
  return parts;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const MAX_FORMATTERS = 64;

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    hourCycle: 'h23',
    era: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  if (formatters.size >= MAX_FORMATTERS) formatters.delete(formatters.keys().next().value!);
  formatters.set(timeZone, formatter);
  return formatter;
}

/**
 * Validate an IANA zone name or link. Numeric offsets are refused: they define no DST
 * transitions, which is exactly the substitution `iana_timezone` forbids.
 *
 * @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export function assertReportingIanaTimezoneV1(value: unknown, field = 'timezone'): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255 || /^[+-]/.test(value)) {
    throw new CoverageInputError(
      'COVERAGE_INPUT_INVALID',
      `${field} must be an IANA timezone name`,
      'invalid_timezone'
    );
  }
  try {
    formatterFor(value);
  } catch {
    throw new CoverageInputError(
      'COVERAGE_INPUT_INVALID',
      `${field} ${JSON.stringify(value)} is not a recognized IANA timezone`,
      'invalid_timezone'
    );
  }
}

/** Local wall-clock time of `instant` in `timeZone`, as epoch milliseconds of that wall time read as UTC. */
function wallTime(instant: number, timeZone: string): number {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const field = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(part => part.type === type)?.value);
  if (parts.find(part => part.type === 'era')?.value !== 'AD') {
    throw new CoverageInputError(
      'COVERAGE_INPUT_INVALID',
      'Reporting period boundary is outside the supported civil year range',
      'invalid_instant'
    );
  }
  const wall = new Date(0);
  wall.setUTCFullYear(field('year'), field('month') - 1, field('day'));
  wall.setUTCHours(field('hour'), field('minute'), field('second'), 0);
  return wall.getTime() + (((instant % 1_000) + 1_000) % 1_000);
}

/**
 * The instant at which `timeZone` reads `wall`. A nonexistent wall time advances by the
 * gap; an ambiguous one takes the earlier instant. Both follow from preferring the offset
 * in effect before the transition.
 */
function instantForWall(wall: number, timeZone: string): number {
  if (timeZone === 'UTC') return wall;
  const offsetBefore = wallTime(wall - DAY_MS, timeZone) - (wall - DAY_MS);
  const offsetAfter = wallTime(wall + DAY_MS, timeZone) - (wall + DAY_MS);
  const fromBefore = wall - offsetBefore;
  if (wallTime(fromBefore, timeZone) === wall) return fromBefore;
  const fromAfter = wall - offsetAfter;
  if (wallTime(fromAfter, timeZone) === wall) return fromAfter;
  return fromBefore;
}

/**
 * Every instant at which `timeZone` reads `wall`: none inside a DST gap, two inside a fold
 * (earlier offset first), otherwise one.
 */
function instantsForWall(wall: number, timeZone: string): number[] {
  if (timeZone === 'UTC') return [wall];
  const offsetBefore = wallTime(wall - DAY_MS, timeZone) - (wall - DAY_MS);
  const offsetAfter = wallTime(wall + DAY_MS, timeZone) - (wall + DAY_MS);
  const found = new Set<number>();
  for (const candidate of [wall - offsetBefore, wall - offsetAfter]) {
    if (wallTime(candidate, timeZone) === wall) found.add(candidate);
  }
  return [...found].sort((left, right) => left - right);
}

function parseInstant(value: string, field: string): number {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
  ) {
    throw new CoverageInputError('COVERAGE_INPUT_INVALID', `${field} must be an RFC 3339 date-time`, 'invalid_instant');
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed))
    throw new CoverageInputError('COVERAGE_INPUT_INVALID', `${field} must be an RFC 3339 date-time`, 'invalid_instant');
  return parsed;
}

/**
 * Build the calendar a published schedule implies. Throws a `TypeError` for a schedule the
 * protocol does not define (a `billing_cycle` without anchor, a missing or numeric timezone).
 *
 * @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export function createReportingPeriodCalendarV1(spec: ReportingPeriodCalendarSpecV1): ReportingPeriodCalendarV1 {
  const duration = parseReportingPeriodDurationV1(spec.period_duration);
  const hasDate = duration.years !== 0 || duration.months !== 0 || duration.days !== 0;
  const hasTime = duration.seconds !== 0;
  if (spec.alignment !== 'utc' && hasDate && hasTime) {
    // adcontextprotocol/adcp#8588: under a local alignment a duration cannot mix date and
    // time components.
    throw new CoverageInputError(
      'COVERAGE_INPUT_INVALID',
      `Reporting period_duration ${JSON.stringify(spec.period_duration)} mixes date and time components under ${spec.alignment} alignment`,
      'invalid_period_duration'
    );
  }
  if (spec.alignment === 'billing_cycle' && !hasDate) {
    // A billing cycle is anchored on period_anchor; a sub-daily one would have to honour the
    // anchor's time of day, which the local sub-daily calendar cannot. adcontextprotocol/adcp#8622
    // makes a sub-daily billing_cycle invalid, so refuse it rather than align to local midnight.
    throw new CoverageInputError(
      'COVERAGE_INPUT_INVALID',
      `Reporting period_duration ${JSON.stringify(spec.period_duration)} is sub-daily, which billing_cycle alignment does not allow (adcp#8622). Use a period of at least one day.`,
      'invalid_period_duration'
    );
  }
  if (spec.alignment !== 'utc' && !hasDate) {
    return createSubDailyLocalCalendar(spec, duration.seconds * 1_000);
  }
  let timeZone: string;
  let originWall: number;
  let anchorKey = '';
  let anchorInstant: number | undefined;
  switch (spec.alignment) {
    case 'utc':
      timeZone = 'UTC';
      originWall = 0;
      break;
    case 'account_timezone':
    case 'source_timezone':
      assertReportingIanaTimezoneV1(spec.timezone, `${spec.alignment} timezone`);
      timeZone = spec.timezone;
      originWall = 0;
      break;
    case 'billing_cycle': {
      assertReportingIanaTimezoneV1(spec.timezone, 'billing_cycle period_timezone');
      if (spec.period_anchor === undefined)
        throw new CoverageInputError(
          'COVERAGE_INPUT_INVALID',
          'billing_cycle alignment requires period_anchor',
          'invalid_input'
        );
      timeZone = spec.timezone;
      const anchor = parseInstant(spec.period_anchor, 'period_anchor');
      originWall = wallTime(anchor, timeZone);
      anchorKey = new Date(anchor).toISOString();
      anchorInstant = anchor;
      break;
    }
    default:
      throw new CoverageInputError(
        'COVERAGE_INPUT_INVALID',
        `Unknown reporting period alignment ${JSON.stringify((spec as { alignment?: unknown }).alignment)}`,
        'invalid_input'
      );
  }
  const origin = new Date(originWall);
  const originYear = origin.getUTCFullYear();
  const originMonth = origin.getUTCMonth();
  const originDay = origin.getUTCDate();
  const timeOfDay = ((originWall % DAY_MS) + DAY_MS) % DAY_MS;
  const calendarMonths = duration.years * 12 + duration.months;
  const exactMs = duration.seconds * 1_000;
  const nominal =
    duration.years * NOMINAL_YEAR_MS + duration.months * NOMINAL_MONTH_MS + duration.days * DAY_MS + exactMs;
  const cache = new Map<number, number>();

  function boundary(ordinal: number): number {
    if (!Number.isSafeInteger(ordinal))
      throw new CoverageInputError(
        'COVERAGE_INPUT_INVALID',
        'Reporting period ordinal must be a safe integer',
        'invalid_input'
      );
    // Interval zero is the anchor instant itself, even when it falls in a DST fold whose
    // wall time would otherwise resolve to the earlier offset.
    if (ordinal === 0 && anchorInstant !== undefined) return anchorInstant;
    const cached = cache.get(ordinal);
    if (cached !== undefined) return cached;
    let wall = originWall;
    if (calendarMonths !== 0 || duration.days !== 0) {
      const totalMonths = originMonth + ordinal * calendarMonths;
      const year = originYear + Math.floor(totalMonths / 12);
      const month = ((totalMonths % 12) + 12) % 12;
      const date = new Date(0);
      date.setUTCFullYear(year, month + 1, 0); // last day of the target month
      const clampedDay = Math.min(originDay, date.getUTCDate());
      date.setUTCFullYear(year, month, clampedDay + ordinal * duration.days);
      date.setUTCHours(0, 0, 0, 0);
      wall = date.getTime() + timeOfDay;
    }
    const value = instantForWall(wall, timeZone) + ordinal * exactMs;
    if (!Number.isFinite(value) || value < MIN_INSTANT || value > MAX_INSTANT) {
      throw new CoverageInputError(
        'COVERAGE_INPUT_INVALID',
        'Reporting period boundary is outside the RFC 3339 instant range',
        'invalid_instant'
      );
    }
    if (cache.size > 4_096) cache.clear();
    cache.set(ordinal, value);
    return value;
  }

  const originInstant = boundary(0);

  function ceilOrdinal(instant: number): number {
    if (!Number.isFinite(instant))
      throw new CoverageInputError('COVERAGE_INPUT_INVALID', 'Reporting instant must be finite', 'invalid_instant');
    let ordinal = Math.ceil((instant - originInstant) / nominal);
    let steps = 0;
    while (boundary(ordinal) < instant) {
      ordinal += 1;
      if (++steps > MAX_CORRECTION_STEPS) throw new RangeError('Reporting period ordinal did not converge');
    }
    while (boundary(ordinal - 1) >= instant) {
      ordinal -= 1;
      if (++steps > MAX_CORRECTION_STEPS) throw new RangeError('Reporting period ordinal did not converge');
    }
    return ordinal;
  }

  function floorOrdinal(instant: number): number {
    let ordinal = ceilOrdinal(instant);
    if (boundary(ordinal) > instant) return ordinal - 1;
    // Equal: a zero-length period (a skipped civil date) can repeat a boundary; take the last.
    while (boundary(ordinal + 1) <= instant) ordinal += 1;
    return ordinal;
  }

  const frozenSpec = Object.freeze({ ...spec });
  return {
    spec: frozenSpec,
    boundary,
    ceilOrdinal,
    floorOrdinal,
    ceil: instant => boundary(ceilOrdinal(instant)),
    floor: instant => boundary(floorOrdinal(instant)),
    next: instant => {
      let ordinal = floorOrdinal(instant) + 1;
      let steps = 0;
      while (boundary(ordinal) <= instant) {
        ordinal += 1;
        if (++steps > MAX_CORRECTION_STEPS) throw new RangeError('Reporting period ordinal did not converge');
      }
      return boundary(ordinal);
    },
    key: JSON.stringify([spec.period_duration, spec.alignment, timeZone, anchorKey]),
  };
}

/**
 * Sub-daily periods under a local alignment (adcontextprotocol/adcp#8588): boundaries are the
 * instants whose local wall-clock time is a whole multiple of the duration after local
 * midnight, counted afresh each local day. A wall time inside a DST gap yields no boundary;
 * one inside a fold yields one boundary per offset. The duration must divide 24 hours.
 */
function createSubDailyLocalCalendar(spec: ReportingPeriodCalendarSpecV1, stepMs: number): ReportingPeriodCalendarV1 {
  if (spec.alignment === 'billing_cycle') {
    assertReportingIanaTimezoneV1(spec.timezone, 'billing_cycle period_timezone');
  } else {
    assertReportingIanaTimezoneV1(spec.timezone, `${spec.alignment} timezone`);
  }
  if (!(stepMs > 0) || DAY_MS % stepMs !== 0) {
    throw new CoverageInputError(
      'COVERAGE_INPUT_INVALID',
      `Sub-daily period_duration ${JSON.stringify(spec.period_duration)} must divide 24 hours under ${spec.alignment} alignment`,
      'invalid_period_duration'
    );
  }
  const timeZone = spec.timezone;
  const slots = DAY_MS / stepMs;
  const dayCache = new Map<number, number[]>();
  /** Boundaries of local day `day` (days since local 1970-01-01), ascending. */
  function boundariesOfDay(day: number): number[] {
    const cached = dayCache.get(day);
    if (cached) return cached;
    const values: number[] = [];
    for (let slot = 0; slot < slots; slot += 1) {
      for (const value of instantsForWall(day * DAY_MS + slot * stepMs, timeZone)) {
        if (value < MIN_INSTANT || value > MAX_INSTANT) {
          throw new CoverageInputError(
            'COVERAGE_INPUT_INVALID',
            'Reporting period boundary is outside the RFC 3339 instant range',
            'invalid_instant'
          );
        }
        values.push(value);
      }
    }
    values.sort((left, right) => left - right);
    if (dayCache.size > 512) dayCache.clear();
    dayCache.set(day, values);
    return values;
  }
  const localDay = (instant: number) => Math.floor(wallTime(instant, timeZone) / DAY_MS);
  function ceil(instant: number): number {
    if (!Number.isFinite(instant))
      throw new CoverageInputError('COVERAGE_INPUT_INVALID', 'Reporting instant must be finite', 'invalid_instant');
    for (let day = localDay(instant) - 1; day <= localDay(instant) + 2; day += 1) {
      const found = boundariesOfDay(day).find(value => value >= instant);
      if (found !== undefined) return found;
    }
    throw new RangeError('Reporting period boundary did not converge');
  }
  function next(instant: number): number {
    return ceil(instant + 1);
  }
  function floor(instant: number): number {
    if (!Number.isFinite(instant))
      throw new CoverageInputError('COVERAGE_INPUT_INVALID', 'Reporting instant must be finite', 'invalid_instant');
    for (let day = localDay(instant) + 1; day >= localDay(instant) - 2; day -= 1) {
      const found = [...boundariesOfDay(day)].reverse().find(value => value <= instant);
      if (found !== undefined) return found;
    }
    throw new RangeError('Reporting period boundary did not converge');
  }
  const unsupported = (): never => {
    throw new TypeError('Sub-daily local reporting calendars have no ordinal addressing; use ceil, floor and next');
  };
  return {
    spec: Object.freeze({ ...spec }),
    boundary: unsupported,
    ceilOrdinal: unsupported,
    floorOrdinal: unsupported,
    ceil,
    floor,
    next,
    key: JSON.stringify([spec.period_duration, spec.alignment, timeZone, 'local-sub-daily']),
  };
}
