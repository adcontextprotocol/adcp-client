import { createHash } from 'node:crypto';

import { canonicalize } from '../../utils/jcs';
import { reportingIsoDurationMillisecondsV1, type ReportingSourceOfferingV1 } from '../source';
import type { ReportingLedgerConfigurationV1 } from './types';

const DAY = 86_400_000;
const HORIZON = 400 * DAY;
type Schedule = ReportingLedgerConfigurationV1['schedule'];
type ConfigurationInput = Omit<
  ReportingLedgerConfigurationV1,
  'configurationId' | 'installedAt' | 'semanticFingerprint'
>;

interface PeriodSchedule {
  boundary(ordinal: number): number;
  floor(instant: number): number;
  ceil(instant: number): number;
}

/** Only this explicit identity opts into civil days. Numeric schedules stay numeric. */
export function isReportingCalendarDay(schedule: Schedule, sourceTimezone: string): boolean {
  return (
    typeof sourceTimezone === 'string' &&
    sourceTimezone.length > 0 &&
    schedule.periodDuration === 'P1D' &&
    schedule.alignment === 'source_timezone' &&
    schedule.periodTimezone === sourceTimezone &&
    (schedule.deliverySlaDuration === undefined || /^PT/.test(schedule.deliverySlaDuration))
  );
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function wallTime(instant: number, timeZone: string): number {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    // Intl also accepts numeric offsets in newer runtimes; the contract requires IANA.
    if (/^[+-]/.test(timeZone)) throw new TypeError('Reporting calendar days require an IANA timezone');
    formatter = new Intl.DateTimeFormat('en-US', {
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
    formatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(instant);
  const field = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(part => part.type === type)?.value);
  if (parts.find(part => part.type === 'era')?.value !== 'AD') {
    throw new RangeError('Reporting calendar boundary is outside the supported civil year range');
  }
  const wall = new Date(0);
  wall.setUTCFullYear(field('year'), field('month') - 1, field('day'));
  wall.setUTCHours(field('hour'), field('minute'), field('second'), 0);
  return wall.getTime();
}

/** Direct origin + ordinal resolution; never add elapsed days to a prior boundary. */
function civilBoundary(civilOrdinal: number, timeZone: string, timeOfDay = 0): number {
  const wall = civilOrdinal * DAY + timeOfDay; // Civil date counted from local 1970-01-01.
  if (!Number.isSafeInteger(civilOrdinal) || wall < -62_135_596_800_000 || wall > 253_402_214_400_000) {
    throw new RangeError('Reporting calendar boundary is outside the supported civil year range');
  }
  const before = wallTime(wall - DAY, timeZone) - (wall - DAY);
  const after = wallTime(wall + DAY, timeZone) - (wall + DAY);
  const candidates = [wall - before, wall - after].sort((a, b) => a - b);
  // On a fold choose the earlier instant; on a gap advance by the gap by
  // applying the offset that preceded it (reporting-schedule period_generation).
  return candidates.find(value => wallTime(value, timeZone) === wall) ?? wall - before;
}

export function reportingCalendarDayOrigin(timeZone: string): number {
  return civilBoundary(0, timeZone);
}

export function reportingCalendarDaySchedule(schedule: Schedule, sourceTimezone: string): PeriodSchedule {
  if (!isReportingCalendarDay(schedule, sourceTimezone) || schedule.periodMilliseconds !== DAY) {
    throw new TypeError('Reporting calendar days require P1D, source_timezone and a nominal one-day period');
  }
  const anchor = Date.parse(schedule.anchor);
  const anchorOrdinal = Math.floor(wallTime(anchor, sourceTimezone) / DAY);
  if (civilBoundary(anchorOrdinal, sourceTimezone) !== anchor) {
    throw new TypeError(
      "Reporting configuration anchor is not on a 'source_timezone' period boundary derived from its protocol calendar origin"
    );
  }
  const boundary = (ordinal: number) => civilBoundary(anchorOrdinal + ordinal, sourceTimezone);
  const floor = (instant: number): number => {
    if (!Number.isFinite(instant)) return instant;
    let ordinal = Math.floor(wallTime(instant, sourceTimezone) / DAY) - anchorOrdinal;
    // The local date identifies the boundary directly. These adjustments also
    // cover a midnight gap/fold or a skipped civil date without iterative drift.
    if (boundary(ordinal) > instant) ordinal -= 1;
    if (boundary(ordinal + 1) <= instant) ordinal += 1;
    return ordinal;
  };
  return {
    boundary,
    floor,
    ceil: instant => {
      const ordinal = floor(instant);
      return Number.isFinite(instant) && boundary(ordinal) !== instant ? ordinal + 1 : ordinal;
    },
  };
}

/**
 * A new variable-boundary generation needs a different semantic identity from
 * an old fixed-width generation with otherwise identical optional wire labels.
 * This domain separator uses the existing opaque fingerprint, not a new wire
 * field. Exact replays continue to return the original fingerprint unchanged.
 */
export function reportingCalendarDayFingerprint(input: ConfigurationInput): string {
  return `sha256:${createHash('sha256')
    .update(canonicalize(['reporting-source-calendar-day-v1', input]))
    .digest('hex')}`;
}

function calendarOrdinals(schedule: Schedule, timezone: string, now: number) {
  const calendar = reportingCalendarDaySchedule(schedule, timezone);
  const start = Math.max(Date.parse(schedule.anchor), now);
  return { calendar, first: calendar.ceil(start), last: calendar.ceil(start + HORIZON) };
}

export function reportingCalendarDayNeedsNewIdentity(input: ConfigurationInput, now: number): boolean {
  if (!isReportingCalendarDay(input.schedule, input.sourceTimezone)) return false;
  const { calendar, first, last } = calendarOrdinals(input.schedule, input.sourceTimezone, now);
  const anchor = Date.parse(input.schedule.anchor);
  for (let ordinal = first; ordinal <= last; ordinal += 1) {
    if (calendar.boundary(ordinal) !== anchor + ordinal * DAY) return true;
  }
  return false;
}

/** Shared by planning, coverage, projections and consumer status eligibility. */
export function reportingPeriodSchedule(configuration: ReportingLedgerConfigurationV1): PeriodSchedule {
  const { schedule, sourceTimezone } = configuration;
  const anchor = Date.parse(schedule.anchor);
  const duration = schedule.periodMilliseconds;
  if (!isReportingCalendarDay(schedule, sourceTimezone)) {
    return {
      boundary: ordinal => anchor + ordinal * duration,
      floor: instant => Math.floor((instant - anchor) / duration),
      ceil: instant => Math.ceil((instant - anchor) / duration),
    };
  }
  const calendar = reportingCalendarDaySchedule(schedule, sourceTimezone);
  const { configurationId: _id, installedAt, semanticFingerprint, ...input } = configuration;
  if (semanticFingerprint === reportingCalendarDayFingerprint(input)) return calendar;
  // Legacy P1D labels are safe only where civil and stored numeric arithmetic
  // agree. Never reinterpret an existing generation across an offset change,
  // including one introduced by a later timezone database update.
  const assertUnchanged = (ordinal: number): number => {
    const value = calendar.boundary(ordinal);
    if (value !== anchor + ordinal * duration) {
      throw new Error(
        'Reporting calendar boundaries differ from this stored fixed-period generation; install a new configuration generation'
      );
    }
    return value;
  };
  const guard = (instant: number, ordinal: number): number => {
    if (Number.isFinite(instant) && instant >= Math.max(anchor, Date.parse(installedAt))) {
      assertUnchanged(ordinal);
    }
    return ordinal;
  };
  return {
    boundary: assertUnchanged,
    floor: instant => guard(instant, calendar.floor(instant)),
    ceil: instant => {
      const ordinal = calendar.ceil(instant);
      return guard(instant, ordinal);
    },
  };
}

/** Refuse a day the declared source cannot produce losslessly before accepting it. */
export function assertReportingCalendarDaySource(
  schedule: Schedule,
  sourceTimezone: string,
  source: ReportingSourceOfferingV1,
  now: number
): void {
  const { calendar, first, last } = calendarOrdinals(schedule, sourceTimezone, now);
  for (let ordinal = first; ordinal < last; ordinal += 1) {
    assertReportingCalendarDayPeriod(
      schedule,
      sourceTimezone,
      source,
      calendar.boundary(ordinal),
      calendar.boundary(ordinal + 1)
    );
  }
}

/** Recheck the actual period before writing, including periods beyond the install horizon. */
export function assertReportingCalendarDayPeriod(
  schedule: Schedule,
  sourceTimezone: string,
  source: ReportingSourceOfferingV1,
  start: number,
  end: number
): void {
  const minimum = reportingIsoDurationMillisecondsV1(source.windowing.minimumWindow);
  const maximum = reportingIsoDurationMillisecondsV1(source.windowing.maximumWindow);
  const hasDays = (duration: string) => Number(/^P(?:(\d+)D)?/.exec(duration)?.[1] ?? 0) > 0;
  const localStart = wallTime(start, sourceTimezone);
  const localEnd = wallTime(end, sourceTimezone);
  if (end <= start || localStart % DAY !== 0 || localEnd % DAY !== 0 || localEnd - localStart !== DAY) {
    throw new TypeError('Reporting calendar day cannot be expressed as lossless source-local midnight boundaries');
  }
  if (
    (hasDays(source.windowing.minimumWindow) ? DAY : end - start) < minimum ||
    (hasDays(source.windowing.maximumWindow) ? DAY : end - start) > maximum ||
    source.sourceExecution.maximumWindowDaysPerRequest < 1
  ) {
    throw new TypeError('Reporting calendar day is outside its source window bounds');
  }
  if (source.publicationClass === 'AUTHORITATIVE') {
    const { schedule: finalization, worstCaseAvailabilityLag } = source.finalization;
    const [hour, minute, second = 0] = finalization.sourceLocalReadyTime.split(':').map(Number);
    const ready = civilBoundary(
      Math.floor(localEnd / DAY) + finalization.daysAfterPeriodEnd,
      sourceTimezone,
      (hour! * 3_600 + minute! * 60 + second) * 1_000
    );
    if (ready + reportingIsoDurationMillisecondsV1(worstCaseAvailabilityLag) > end + schedule.deliverySlaMilliseconds) {
      throw new TypeError(
        'Official reporting delivery SLA is shorter than the source calendar finalization and availability lag'
      );
    }
  }
}
