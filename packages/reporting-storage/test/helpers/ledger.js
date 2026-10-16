'use strict';
/**
 * The pre-split `@adcp/sdk/reporting/ledger` barrel as one namespace: the protocol layer from
 * `@adcp/sdk` plus the storage exports from this package. Tests keep reading `ledger.X`.
 */
module.exports = {
  ...require('@adcp/sdk/reporting/ledger'),
  ...require('@adcp/reporting-storage'),
  ...require('@adcp/reporting-storage/managed'),
  ...require('@adcp/reporting-storage/notifications'),
};
