/**
 * `@adcp/sdk/reporting/advanced` is the only public home of the low-level reporting-subscription
 * building blocks (experimental `media_buy.reporting_subscriptions`, AdCP 3.3): the engine and its
 * stores, the coverage function, the calendar, selection, the capability builder and the service's
 * subscription hooks. The service, consumer and ledger subpaths and the package root no longer
 * re-export them.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');

const pkg = require('../../package.json');

const LOW_LEVEL = [
  'createReportingSubscriptionEngineV1',
  'createInMemoryReportingSubscriptionEngineStoreV1',
  'createReportingSubscriptionEngineStateStoreV1',
  'DEFAULT_REPORTING_SUBSCRIPTION_ENGINE_COLLECTION',
  'reportingSubscriptionCoverageGrantedV1',
  'owedSubscriptionPeriodsV1',
  'expectedSubscriptionPeriods',
  'groupOwedSubscriptionPeriodsV1',
  'reportingSubscriptionVersionRecordsV1',
  'toExpectedReportingPeriodsV1',
  'createReportingPeriodCalendarV1',
  'parseReportingPeriodDurationV1',
  'assertReportingIanaTimezoneV1',
  'resolveReportingSubscriptionOfferingsV1',
  'reportingSubscriptionScopeIncludesV1',
  'isReportingSubscriptionCandidateV1',
  'effectiveReportingSubscriptionMatchV1',
  'compareReportingIdsByteOrderV1',
  'reportingConfigurationCapabilitiesV1',
  'withReportingSubscriptionCoverageV1',
];

describe('@adcp/sdk/reporting/advanced', () => {
  test('publishes runtime and declaration paths like the other reporting subpaths', () => {
    assert.deepEqual(pkg.exports['./reporting/advanced'], {
      import: {
        types: './dist/lib/reporting/advanced/index.d.mts',
        default: './dist/lib/reporting/advanced/index.mjs',
      },
      require: {
        types: './dist/lib/reporting/advanced/index.d.ts',
        default: './dist/lib/reporting/advanced/index.js',
      },
    });
    assert.deepEqual(pkg.typesVersions['*']['reporting/advanced'], ['dist/lib/reporting/advanced/index.d.ts']);
    const distRoot = path.join(__dirname, '..', '..', 'dist', 'lib', 'reporting', 'advanced');
    for (const file of ['index.js', 'index.mjs', 'index.d.ts', 'index.d.mts']) {
      assert.ok(fs.existsSync(path.join(distRoot, file)), `dist/lib/reporting/advanced/${file} must exist`);
    }
    const declarations = fs.readFileSync(path.join(distRoot, 'index.d.ts'), 'utf8');
    assert.match(declarations, /@experimental/);
  });

  test('exports every low-level building block', () => {
    const advanced = require('@adcp/sdk/reporting/advanced');
    for (const name of LOW_LEVEL) assert.notEqual(advanced[name], undefined, name);
  });

  test('the pre-rename names are deprecated aliases of the "owed" names', () => {
    const advanced = require('@adcp/sdk/reporting/advanced');
    assert.equal(advanced.expectedSubscriptionPeriods, advanced.owedSubscriptionPeriodsV1);
    assert.equal(advanced.groupExpectedSubscriptionPeriodsV1, advanced.groupOwedSubscriptionPeriodsV1);
    assert.equal(advanced.subscriptionExpectedReportingPeriodsV1, advanced.toExpectedReportingPeriodsV1);
  });

  test('the service, consumer and ledger subpaths and the package root do not re-export them', () => {
    const surfaces = {
      root: require('@adcp/sdk'),
      service: require('@adcp/sdk/reporting/service'),
      consumer: require('@adcp/sdk/reporting/consumer'),
      ledger: require('@adcp/sdk/reporting/ledger'),
    };
    for (const [surface, exports] of Object.entries(surfaces)) {
      for (const name of LOW_LEVEL) assert.equal(exports[name], undefined, `${surface} must not export ${name}`);
    }
  });

  test('the service declarations do not name the subscription hook types', () => {
    const declarations = fs.readFileSync(
      path.join(__dirname, '..', '..', 'dist', 'lib', 'reporting', 'service', 'index.d.ts'),
      'utf8'
    );
    for (const name of [
      'ReliableReportingSubscriptionsOptionsV1',
      'ReliableReportingSubscriptionBindingInputV1',
      'ReportingSubscriptionEngineV1',
    ]) {
      assert.doesNotMatch(declarations, new RegExp(`export (?:interface|type|\\{[^}]*\\b)${name}\\b`), name);
    }
  });
});
