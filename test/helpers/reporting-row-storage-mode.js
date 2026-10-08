/**
 * REPORTING_ROW_STORAGE=chunked reruns the PostgreSQL reporting suites with
 * revision rows stored as verified canonical JSONL chunks instead of inline in
 * ledger documents, and with the host change feed enabled. Every assertion in
 * those suites must hold in both modes.
 */
const CHUNKED = process.env.REPORTING_ROW_STORAGE === 'chunked';

function reportingLedgerMigrationForTest(ledger) {
  return CHUNKED
    ? `${ledger.REPORTING_LEDGER_MIGRATION};\n${ledger.REPORTING_ROW_STORAGE_MIGRATION};\n${ledger.REPORTING_LEDGER_CHANGES_MIGRATION}`
    : ledger.REPORTING_LEDGER_MIGRATION;
}

function newReportingLedgerStoreForTest(ledger, pool, options = {}) {
  return new ledger.PostgresReportingLedgerStore(
    pool,
    CHUNKED ? { rowStorage: true, changeFeed: true, ...options } : options
  );
}

function rowStorageServiceOptionsForTest() {
  return CHUNKED ? { rowStorage: true, changeFeed: true } : {};
}

module.exports = {
  CHUNKED_ROW_STORAGE: CHUNKED,
  newReportingLedgerStoreForTest,
  reportingLedgerMigrationForTest,
  rowStorageServiceOptionsForTest,
};
