interface ReportingInstantParts {
  epochSecond: bigint;
  fraction: string;
}

const REPORTING_INSTANT = /^(.*:\d{2})(?:\.(\d+))?([zZ]|[+-]\d{2}:\d{2})$/;

function parseReportingInstant(value: string): ReportingInstantParts {
  const match = REPORTING_INSTANT.exec(value);
  if (!match) throw new TypeError('value must be an RFC 3339 instant');
  const leapSecond = match[1]!.endsWith(':60');
  const wholeSecond = Date.parse(`${leapSecond ? match[1]!.replace(/:60$/, ':59') : match[1]}${match[3]}`);
  if (!Number.isFinite(wholeSecond) || wholeSecond % 1_000 !== 0) {
    throw new TypeError('value must be an RFC 3339 instant');
  }
  return { epochSecond: BigInt(wholeSecond / 1_000) + (leapSecond ? 1n : 0n), fraction: match[2] ?? '' };
}

function scaledValue(value: ReportingInstantParts, scale: number): bigint {
  const fraction = value.fraction.padEnd(scale, '0');
  return value.epochSecond * 10n ** BigInt(scale) + BigInt(fraction || '0');
}

function difference(left: string, right: string): { units: bigint; scale: number } {
  const leftValue = parseReportingInstant(left);
  const rightValue = parseReportingInstant(right);
  const scale = Math.max(3, leftValue.fraction.length, rightValue.fraction.length);
  return { units: scaledValue(leftValue, scale) - scaledValue(rightValue, scale), scale };
}

function durationUnits(durationMilliseconds: number, scale: number): bigint {
  if (!Number.isSafeInteger(durationMilliseconds) || durationMilliseconds < 0) {
    throw new TypeError('durationMilliseconds must be a non-negative safe integer');
  }
  return BigInt(durationMilliseconds) * 10n ** BigInt(scale - 3);
}

export function compareReportingInstants(left: string, right: string): number {
  const value = difference(left, right).units;
  return value < 0n ? -1 : value > 0n ? 1 : 0;
}

export function compareReportingInstantToOffset(value: string, base: string, offsetMilliseconds: number): number {
  const delta = difference(value, base);
  const offset = durationUnits(offsetMilliseconds, delta.scale);
  return delta.units < offset ? -1 : delta.units > offset ? 1 : 0;
}

export function reportingInstantHasDuration(start: string, end: string, durationMilliseconds: number): boolean {
  const delta = difference(end, start);
  return delta.units === durationUnits(durationMilliseconds, delta.scale);
}

export function reportingPeriodOrdinal(start: string, anchor: string, durationMilliseconds: number): bigint | null {
  const delta = difference(start, anchor);
  const duration = durationUnits(durationMilliseconds, delta.scale);
  if (delta.units < 0n || delta.units % duration !== 0n) return null;
  return delta.units / duration;
}

export function reportingDurationCeilOrdinal(
  anchor: string,
  effectiveFrom: string,
  durationMilliseconds: number
): bigint {
  const delta = difference(effectiveFrom, anchor);
  const duration = durationUnits(durationMilliseconds, delta.scale);
  if (delta.units <= 0n) return 0n;
  return (delta.units + duration - 1n) / duration;
}
