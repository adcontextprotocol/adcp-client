/**
 * Reliable Reporting protocol layer: the ledger store interface, the protocol handlers, the producer,
 * status ingest, row encoding and the health, coverage and lifecycle helpers.
 *
 * Storage implementations (PostgreSQL ledger store, row storage, managed delivery, notification activity,
 * the cloud providers and the BigQuery sink) live in `@adcp/reporting-storage`, which depends on this
 * package. Nothing here imports it. A store from any package works with these handlers as long as it
 * implements `ReportingLedgerStore`.
 *
 * The store, transaction, lease and row-read interfaces in `./types` are tagged `@experimental`: they
 * change together with `@adcp/reporting-storage`, which is pre-1.0. The protocol-facing handlers,
 * producer, status ingest, health, coverage and lifecycle helpers follow normal semver.
 *
 * Stability policy: https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 *
 * @packageDocumentation
 */
export * from './types';
export * from './health';
export * from './coverage';
export * from './lifecycle';
export * from './producer';
export * from './handler';
export * from './status-ingest';
export * from './consumer-status-identity';
export * from './row-encoding';
export * from './row-storage-errors';
export * from './receipts';
export * from './offering-validation';

// Building blocks a ledger store implementation shares with the protocol layer. They are exported so a
// store can live outside the SDK without importing internals.
export { compareReportingInstants } from './instant';
export { isFrozenCalendarRulesMismatch, reportingPeriodDate, reportingPeriodSchedule } from './schedule';
export {
  isReportingAdjustmentReceiptEvidence,
  isReportingReceiptEvidence,
  isReportingVerificationEvidence,
} from '../evidence';
export { isWellFormedUnicodeString } from '../../utils/well-formed-unicode';
