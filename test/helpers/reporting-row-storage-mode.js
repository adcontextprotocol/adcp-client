/**
 * REPORTING_ROW_STORAGE=chunked reruns the PostgreSQL reporting suites with
 * revision rows stored as verified canonical JSONL chunks instead of inline in
 * ledger documents. Every assertion in those suites must hold in both modes.
 */
const CHUNKED = process.env.REPORTING_ROW_STORAGE === 'chunked';

function reportingLedgerMigrationForTest(ledger) {
  return CHUNKED
    ? `${ledger.REPORTING_LEDGER_MIGRATION};\n${ledger.REPORTING_ROW_STORAGE_MIGRATION}`
    : ledger.REPORTING_LEDGER_MIGRATION;
}

function newReportingLedgerStoreForTest(ledger, pool, options = {}) {
  return new ledger.PostgresReportingLedgerStore(pool, CHUNKED ? { rowStorage: true, ...options } : options);
}

function rowStorageServiceOptionsForTest() {
  return CHUNKED ? { rowStorage: true } : {};
}

module.exports = {
  CHUNKED_ROW_STORAGE: CHUNKED,
  newReportingLedgerStoreForTest,
  reportingLedgerMigrationForTest,
  rowStorageServiceOptionsForTest,
};
