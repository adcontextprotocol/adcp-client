/**
 * `period_date` is AdCP's `YYYY-MM-DD` calendar date of a period start in the
 * period's `source_timezone`. These tests pin the local-date rule, the
 * daylight-saving edges and fail-closed behavior. How object keys render it is
 * pinned in `@adcp/reporting-storage` (`reporting-object-key-period-date.test.js`).
 */
const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { reportingPeriodDate } = require('../../dist/lib/reporting/ledger/schedule.js');

const utcDate = instant => new Date(instant).toISOString().slice(0, 10);

describe('reportingPeriodDate', () => {
  test('a Los Angeles period dates in Pacific time, not UTC', () => {
    // PDT is UTC-7: 07:00Z is local midnight.
    assert.equal(reportingPeriodDate('2026-10-02T07:00:00Z', 'America/Los_Angeles'), '2026-10-02');
    assert.equal(reportingPeriodDate('2026-10-02T06:59:59Z', 'America/Los_Angeles'), '2026-10-01');
    assert.equal(utcDate('2026-10-02T06:59:59Z'), '2026-10-02', 'the UTC rule would have said the 2nd');
    // An evening start dates to the same local day although UTC has rolled over.
    assert.equal(reportingPeriodDate('2026-10-02T23:30:00-07:00', 'America/Los_Angeles'), '2026-10-02');
    assert.equal(reportingPeriodDate('2026-10-03T06:30:00Z', 'America/Los_Angeles'), '2026-10-02');
  });

  test('a Tokyo period dates ahead of UTC across midnight UTC', () => {
    // JST is UTC+9: 15:00Z is local midnight of the next day.
    assert.equal(reportingPeriodDate('2026-10-01T15:00:00Z', 'Asia/Tokyo'), '2026-10-02');
    assert.equal(reportingPeriodDate('2026-10-01T14:59:59Z', 'Asia/Tokyo'), '2026-10-01');
    assert.equal(utcDate('2026-10-01T15:00:00Z'), '2026-10-01', 'the UTC rule would have said the 1st');
    assert.equal(reportingPeriodDate('2026-10-02T09:00:00+09:00', 'Asia/Tokyo'), '2026-10-02');
    assert.equal(reportingPeriodDate('2026-10-01T23:59:59Z', 'Asia/Tokyo'), '2026-10-02');
  });

  test('half-hour and 45-minute offsets', () => {
    assert.equal(reportingPeriodDate('2026-10-01T18:30:00Z', 'Asia/Kolkata'), '2026-10-02');
    assert.equal(reportingPeriodDate('2026-10-01T18:29:59Z', 'Asia/Kolkata'), '2026-10-01');
    assert.equal(reportingPeriodDate('2026-10-01T18:15:00Z', 'Asia/Kathmandu'), '2026-10-02');
    assert.equal(reportingPeriodDate('2026-10-01T18:14:59Z', 'Asia/Kathmandu'), '2026-10-01');
  });

  test('UTC and its aliases match the UTC date', () => {
    for (const zone of ['UTC', 'Etc/UTC']) {
      assert.equal(reportingPeriodDate('2026-10-01T23:59:59Z', zone), '2026-10-01');
      assert.equal(reportingPeriodDate('2026-10-02T00:00:00Z', zone), '2026-10-02');
    }
  });

  test('daylight-saving transitions keep the local date the period begins on', () => {
    // Spring forward, Los Angeles, 2026-03-08: 02:00 PST becomes 03:00 PDT at 10:00Z.
    assert.equal(reportingPeriodDate('2026-03-08T07:59:59Z', 'America/Los_Angeles'), '2026-03-07');
    assert.equal(reportingPeriodDate('2026-03-08T08:00:00Z', 'America/Los_Angeles'), '2026-03-08');
    assert.equal(reportingPeriodDate('2026-03-08T09:59:59Z', 'America/Los_Angeles'), '2026-03-08');
    assert.equal(reportingPeriodDate('2026-03-08T10:00:00Z', 'America/Los_Angeles'), '2026-03-08');
    assert.equal(reportingPeriodDate('2026-03-09T06:59:59Z', 'America/Los_Angeles'), '2026-03-08');
    assert.equal(reportingPeriodDate('2026-03-09T07:00:00Z', 'America/Los_Angeles'), '2026-03-09');
    // Fall back, Los Angeles, 2026-11-01: 02:00 PDT becomes 01:00 PST at 09:00Z (01:00 occurs twice).
    assert.equal(reportingPeriodDate('2026-11-01T06:59:59Z', 'America/Los_Angeles'), '2026-10-31');
    assert.equal(reportingPeriodDate('2026-11-01T07:00:00Z', 'America/Los_Angeles'), '2026-11-01');
    assert.equal(reportingPeriodDate('2026-11-01T08:30:00Z', 'America/Los_Angeles'), '2026-11-01');
    assert.equal(reportingPeriodDate('2026-11-01T09:30:00Z', 'America/Los_Angeles'), '2026-11-01');
    assert.equal(reportingPeriodDate('2026-11-02T07:59:59Z', 'America/Los_Angeles'), '2026-11-01');
    assert.equal(reportingPeriodDate('2026-11-02T08:00:00Z', 'America/Los_Angeles'), '2026-11-02');
    // Southern hemisphere, Sydney, 2026-10-04: 02:00 AEST becomes 03:00 AEDT at 16:00Z the day before.
    assert.equal(reportingPeriodDate('2026-10-03T13:59:59Z', 'Australia/Sydney'), '2026-10-03');
    assert.equal(reportingPeriodDate('2026-10-03T14:00:00Z', 'Australia/Sydney'), '2026-10-04');
    assert.equal(reportingPeriodDate('2026-10-04T12:59:59Z', 'Australia/Sydney'), '2026-10-04');
    assert.equal(reportingPeriodDate('2026-10-04T13:00:00Z', 'Australia/Sydney'), '2026-10-05');
    // London, 2026-03-29: 01:00 GMT becomes 02:00 BST at 01:00Z.
    assert.equal(reportingPeriodDate('2026-03-28T23:59:59Z', 'Europe/London'), '2026-03-28');
    assert.equal(reportingPeriodDate('2026-03-29T00:00:00Z', 'Europe/London'), '2026-03-29');
    assert.equal(reportingPeriodDate('2026-03-29T23:00:00Z', 'Europe/London'), '2026-03-30');
  });

  test('a year boundary and leap day follow the local calendar', () => {
    assert.equal(reportingPeriodDate('2026-12-31T15:00:00Z', 'Asia/Tokyo'), '2027-01-01');
    assert.equal(reportingPeriodDate('2027-01-01T07:59:59Z', 'America/Los_Angeles'), '2026-12-31');
    assert.equal(reportingPeriodDate('2028-02-29T08:00:00Z', 'America/Los_Angeles'), '2028-02-29');
    assert.equal(reportingPeriodDate('2028-02-29T07:59:59Z', 'America/Los_Angeles'), '2028-02-28');
  });

  test('accepts RFC 3339 fractions and offsets', () => {
    assert.equal(reportingPeriodDate('2026-10-02T07:00:00.000Z', 'America/Los_Angeles'), '2026-10-02');
    assert.equal(reportingPeriodDate('2026-10-02T06:59:59.999999Z', 'America/Los_Angeles'), '2026-10-01');
    assert.equal(reportingPeriodDate('2026-10-02T09:00:00+02:00', 'America/Los_Angeles'), '2026-10-02');
  });

  test('midnight daylight-saving transitions keep the date of the instant', () => {
    // Havana springs forward at local midnight (00:00 CST -> 01:00 CDT) on 2026-03-08.
    assert.equal(reportingPeriodDate('2026-03-08T04:59:59Z', 'America/Havana'), '2026-03-07');
    assert.equal(reportingPeriodDate('2026-03-08T05:00:00Z', 'America/Havana'), '2026-03-08');
    // ... and falls back at 01:00 CDT -> 00:00 CST on 2026-11-01, so local 00:30 occurs twice on one date.
    assert.equal(reportingPeriodDate('2026-11-01T04:30:00Z', 'America/Havana'), '2026-11-01');
    assert.equal(reportingPeriodDate('2026-11-01T05:30:00Z', 'America/Havana'), '2026-11-01');
    // Samoa skipped 2011-12-30 entirely when it crossed the date line.
    assert.equal(reportingPeriodDate('2011-12-30T09:59:59Z', 'Pacific/Apia'), '2011-12-29');
    assert.equal(reportingPeriodDate('2011-12-30T10:00:00Z', 'Pacific/Apia'), '2011-12-31');
    // Extremes: UTC+14 and UTC-12.
    assert.equal(reportingPeriodDate('2026-10-01T10:00:00Z', 'Pacific/Kiritimati'), '2026-10-02');
    assert.equal(reportingPeriodDate('2026-10-02T11:59:59Z', 'Etc/GMT+12'), '2026-10-01');
  });

  test('accepts the supported year range and refuses what cannot render as YYYY-MM-DD', () => {
    assert.equal(reportingPeriodDate('0001-01-01T00:00:00Z', 'Asia/Tokyo'), '0001-01-01');
    assert.equal(reportingPeriodDate('9999-12-31T14:59:59Z', 'Asia/Tokyo'), '9999-12-31');
    assert.throws(() => reportingPeriodDate('9999-12-31T15:00:00Z', 'Asia/Tokyo'), RangeError, 'year 10000');
    assert.throws(() => reportingPeriodDate('0001-01-01T00:00:00Z', 'America/Los_Angeles'), RangeError, 'year 0');
  });

  test('refuses calendar fields Date.parse would silently roll forward', () => {
    for (const start of [
      '2026-02-30T00:00:00Z',
      '2026-04-31T00:00:00Z',
      '2027-02-29T00:00:00Z',
      '2100-02-29T00:00:00Z',
      '2026-00-10T00:00:00Z',
      '2026-10-00T00:00:00Z',
      '2026-10-02T24:00:00Z',
    ]) {
      assert.throws(() => reportingPeriodDate(start, 'UTC'), { name: 'TypeError', message: /RFC 3339/ }, start);
    }
    assert.equal(reportingPeriodDate('2028-02-29T00:00:00Z', 'UTC'), '2028-02-29');
    assert.equal(reportingPeriodDate('2000-02-29T00:00:00Z', 'UTC'), '2000-02-29');
  });

  test('fails closed on a missing or non-IANA timezone and never falls back to UTC', () => {
    for (const zone of [undefined, null, '', 'x'.repeat(256), 42]) {
      assert.throws(
        () => reportingPeriodDate('2026-10-02T07:00:00Z', zone),
        { name: 'TypeError', message: /source_timezone/ },
        String(zone)
      );
    }
    for (const zone of ['+05:30', '-07:00', '+0530', '+05']) {
      assert.throws(
        () => reportingPeriodDate('2026-10-02T07:00:00Z', zone),
        { name: 'TypeError', message: /IANA/ },
        zone
      );
    }
    for (const zone of ['Mars/Olympus_Mons', 'not a zone', 'UTC ', 'America/Los_Angeles\n', 'Z', 'UTC+5']) {
      assert.throws(() => reportingPeriodDate('2026-10-02T07:00:00Z', zone), RangeError, JSON.stringify(zone));
    }
  });

  test('zone names the runtime resolves to one canonical zone give the same date', () => {
    // ICU canonicalizes case and legacy aliases; the date is the same as the canonical zone's.
    for (const zone of ['america/los_angeles', 'US/Pacific', 'PST8PDT']) {
      assert.equal(reportingPeriodDate('2026-10-02T06:59:59Z', zone), '2026-10-01', zone);
      assert.equal(reportingPeriodDate('2026-10-02T07:00:00Z', zone), '2026-10-02', zone);
    }
    assert.equal(reportingPeriodDate('2026-10-01T18:30:00Z', 'Asia/Calcutta'), '2026-10-02');
  });

  test('fails closed on an unusable period start', () => {
    for (const start of [
      undefined,
      null,
      '',
      'yesterday',
      '2026-10-02',
      '2026-10-02 07:00:00',
      '2026-13-01T00:00:00Z',
    ]) {
      assert.throws(() => reportingPeriodDate(start, 'America/Los_Angeles'), TypeError, String(start));
    }
  });
});
