/**
 * Repros from the cross-SDK differential harness (adcontextprotocol/adcp#8679), minimized in
 * adcp-client#3572 and #3573. The engine side of #3577 is in reporting-subscription-engine.test.js.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { describe, test } = require('node:test');

const { owedSubscriptionPeriodsV1 } = require('@adcp/sdk/reporting/advanced');

const table = require(path.join(__dirname, '..', 'fixtures', 'reporting-subscriptions', 'canonical', 'vectors.json'));
const rows = periods =>
  periods.map(row => ({
    subscription_version: row.subscription_version,
    offering_id: row.offering_id,
    period_start: new Date(row.period_start).toISOString(),
    period_end: new Date(row.period_end).toISOString(),
    ...(row.stub ? { stub: true } : {}),
  }));

const profile = {
  id: 'adcp.delivery.v1',
  version: '1.0.0',
  schema_uri: 'https://seller.example/schemas/delivery.json',
  schema_sha256: 'a'.repeat(64),
  schema_dialect: 'https://json-schema.org/draft/2020-12/schema',
  schema_ref_policy: 'local_fragment_only',
  grain: 'daily',
  primary_keys: ['account_id', 'package_id'],
};

describe('differential-harness repros', () => {
  test('#3572: the billing cutover stub is owed when the incoming first boundary after authorized_at is after E', () => {
    const input = {
      subscription_id: 'billing-sub',
      versions: [
        {
          subscription_version: 1,
          accepted_at: '2027-05-25T00:00:00Z',
          configuration: {
            subscription_id: 'billing-sub',
            subscription_version: 1,
            active: true,
            scope: { all_authorized_accounts: true },
            selector: {
              feed_purpose: 'analytics',
              period_duration: 'P1M',
              required_finality: 'official',
              dimensions: ['package'],
            },
            reconciliation_mode: 'delivery_only',
          },
        },
        {
          subscription_version: 2,
          accepted_at: '2027-06-27T10:30:00Z',
          configuration: {
            subscription_id: 'billing-sub',
            subscription_version: 2,
            active: true,
            scope: { account_ids: ['acct_1'] },
            selector: {
              feed_purpose: 'billing',
              period_duration: 'P3M',
              required_finality: 'official',
              dimensions: ['package'],
            },
            reconciliation_mode: 'consumer_receipt',
            destination: { destination_id: 'billing-archive' },
          },
          destination_method: { pattern: 'file_transfer', transport: 's3' },
        },
      ],
      account: { account_id: 'acct_1', timezone: 'Etc/UTC', grants: [{ authorized_at: '2027-05-01T00:00:00Z' }] },
      buys: [
        {
          media_buy_id: 'mb_1',
          confirmed_at: '2027-06-17T00:00:00Z',
          start_time: '2027-06-19T00:00:00Z',
          end_time: '2027-07-20T00:00:00Z',
          packages: [
            {
              package_id: 'pkg_1',
              reporting_delivery_offering_ids: ['off_analytics_monthly', 'off_billing_quarterly'],
            },
          ],
        },
      ],
      offerings: [
        {
          offering_id: 'off_billing_quarterly',
          feed_purpose: 'billing',
          report_definition_id: 'rd_bq',
          report_definition_uri: 'https://seller.example/report-definitions/off_a_billing_p3m.json',
          report_definition_sha256: 'b'.repeat(64),
          reporting_profile: {
            ...profile,
            canonicalization_id: 'adcp_jcs_rows_v1',
            canonicalization_contract_version: '1.0',
            canonicalization_media_type: 'application/vnd.adcp.reporting-canonicalization+json',
            canonicalization_uri: 'https://seller.example/canonicalization/adcp_jcs_rows_v1.json',
            canonicalization_sha256: 'c'.repeat(64),
          },
          schedule: {
            period_duration: 'P3M',
            alignment: 'billing_cycle',
            delivery_sla: 'P1D',
            period_anchor_policy: 'fixed',
            period_anchor: '2025-01-15T00:00:00Z',
            period_timezone: 'UTC',
          },
          supported_finality: ['official'],
          reconciliation_mode: 'consumer_receipt',
          standard_dimensions: ['package'],
          method: {
            pattern: 'file_transfer',
            transport: 's3',
            orchestration: 'producer_managed',
            destination_modes: ['existing'],
            provider: { domain: 'seller.example' },
            format: 'jsonl',
          },
        },
        {
          offering_id: 'off_analytics_monthly',
          feed_purpose: 'analytics',
          report_definition_id: 'rd_am',
          report_definition_uri: 'https://seller.example/report-definitions/off_c_account_p3m.json',
          report_definition_sha256: 'b'.repeat(64),
          reporting_profile: profile,
          schedule: { period_duration: 'P1M', alignment: 'utc', delivery_sla: 'PT6H' },
          supported_finality: ['official'],
          reconciliation_mode: 'delivery_only',
          standard_dimensions: ['package'],
        },
      ],
      now: '2027-08-01T00:00:00Z',
    };
    assert.deepEqual(rows(owedSubscriptionPeriodsV1(input)), [
      {
        subscription_version: 1,
        offering_id: 'off_analytics_monthly',
        period_start: '2027-06-01T00:00:00.000Z',
        period_end: '2027-07-01T00:00:00.000Z',
      },
      {
        subscription_version: 2,
        offering_id: 'off_billing_quarterly',
        period_start: '2027-07-01T00:00:00.000Z',
        period_end: '2027-07-15T00:00:00.000Z',
        stub: true,
      },
    ]);
  });

  test('#3573: an account timezone no schedule reads is never refused', () => {
    const baseline = table.cases.find(item => item.id === 'baseline');
    const input = structuredClone(baseline.input);
    input.account.timezone = '+05:00';
    assert.deepEqual(rows(owedSubscriptionPeriodsV1(input)), rows(owedSubscriptionPeriodsV1(baseline.input)));
    // A schedule that reads it still refuses it.
    const local = table.cases.find(item => item.id === 'account-timezone');
    const refused = structuredClone(local.input);
    refused.account.timezone = '+05:00';
    assert.throws(
      () => owedSubscriptionPeriodsV1(refused),
      error => error.detail === 'invalid_timezone'
    );
  });
});
