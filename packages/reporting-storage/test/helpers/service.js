'use strict';
/**
 * The pre-split `@adcp/sdk/reporting/service` surface as one namespace: the Core service from `@adcp/sdk`
 * plus the production composition and the maintenance helpers from this package, and the reporting-subscription
 * building blocks that moved to `@adcp/sdk/reporting/advanced`.
 */
const storage = require('@adcp/reporting-storage');

module.exports = {
  ...require('@adcp/sdk/reporting/advanced'),
  ...require('@adcp/sdk/reporting/service'),
  ...require('@adcp/reporting-storage/service'),
  reportingLedgerMaintenance: storage.reportingLedgerMaintenance,
  ReportingMaintenancePartialFailureError: storage.ReportingMaintenancePartialFailureError,
};
