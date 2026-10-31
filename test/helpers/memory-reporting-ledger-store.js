/**
 * In-memory `ReportingLedgerStore`, shared by the ledger tests and the buyer
 * reconciler end-to-end suite.
 *
 * It is the store `memoryStorage().ledger` ships (`@adcp/sdk/storage`), so these
 * suites drive the real producer, the real `get_reporting_status` handler, the
 * real exact-revision delivery reader and the real `sync_reporting_status`
 * ingest against the same store a development seller runs.
 */
const { MemoryReportingLedgerStore } = require('../../dist/lib/storage/memory-ledger.js');

class MemoryLedgerStore extends MemoryReportingLedgerStore {}

module.exports = { MemoryLedgerStore };
