/**
 * Scheduler primitives shared by `createReliableReportingService` and by services composed with it
 * (for example `@adcp/reporting-storage/service`). They are exported so a composition can pace its own
 * background passes and report failures the same way the Core scheduler does.
 */
import type { ReportingLedgerStore } from '../ledger/types';
import { redactCredentialPatterns } from '../../utils/redact-credential-patterns';

/** Bound on the diagnostic, so no error message can flood the log sink. */
const MAX_SCHEDULER_MESSAGE_CHARS = 512;
/** Bound on what redaction is asked to scan, so it stays cheap on huge inputs. */
const MAX_SCHEDULER_SCAN_CHARS = 8_192;
const UNREPORTABLE_SCHEDULER_ERROR = '<unreportable error>';

/**
 * The error's own message only, credential-redacted, bounded, and total.
 *
 * Stacks and error objects can carry request payloads and upstream credentials
 * into a log sink the adopter did not choose, so only `message` is read. Every
 * step is guarded because the value is arbitrary: `String(Object.create(null))`
 * throws, a `Symbol.toPrimitive` or `message` getter can throw or run adopter
 * code, and a Proxy can trap the prototype walk `instanceof` performs. This
 * function runs while building the diagnostic, outside the catch that guards
 * the logger call, so a throw here escaped `reportSchedulerError`, rejected the
 * scheduler loop, and surfaced as an unhandled rejection — killing the
 * background loop, or the host, over an error object's shape.
 */
export function reportingSchedulerErrorMessage(error: unknown): string {
  try {
    const raw = rawMessage(error);
    // Redact before truncating, so no fragment of a credential can survive
    // being cut; scan a bounded prefix so a pathological message stays cheap.
    const redacted = redactCredentialPatterns(raw.slice(0, MAX_SCHEDULER_SCAN_CHARS));
    const text = typeof redacted === 'string' && redacted.length > 0 ? redacted : UNREPORTABLE_SCHEDULER_ERROR;
    return text.length > MAX_SCHEDULER_MESSAGE_CHARS ? `${text.slice(0, MAX_SCHEDULER_MESSAGE_CHARS)}…` : text;
  } catch {
    // The failure stays observable: the phase, the account, and the fact that
    // something threw are all still in the warning.
    return UNREPORTABLE_SCHEDULER_ERROR;
  }
}

/**
 * Never coerces. Only a primitive, or a `message` that is already a string, is
 * trusted; anything else is described rather than stringified.
 */
function rawMessage(error: unknown): string {
  switch (typeof error) {
    case 'string':
      return error;
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(error);
    case 'undefined':
      return 'undefined';
    case 'symbol':
      return error.description ?? 'symbol';
    default:
      break;
  }
  if (error === null) return 'null';
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message : 'non-Error scheduler failure';
}

const MAX_TIMER_DELAY_MILLISECONDS = 2_147_483_647;

export async function reportingSchedulerDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  let remaining = milliseconds;
  while (remaining > 0 && !signal.aborted) {
    const chunk = Math.min(remaining, MAX_TIMER_DELAY_MILLISECONDS);
    await abortableTimeout(chunk, signal);
    remaining -= chunk;
  }
}

function abortableTimeout(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Start each pass one tenant further along so no fixed order can starve. */
export function rotateReportingRoster<T>(values: readonly T[], by: number): T[] {
  if (values.length < 2) return [...values];
  const offset = ((by % values.length) + values.length) % values.length;
  return [...values.slice(offset), ...values.slice(0, offset)];
}

/**
 * Every account the ledger currently holds a configuration for. This is the
 * roster a deployment-wide worker is authorized over, so it is also the roster
 * the per-account budgets apply to.
 */
export async function reportingDeploymentWideAccountIds(store: ReportingLedgerStore): Promise<string[]> {
  const configurations = await store.listConfigurations();
  return [...new Set(configurations.map(value => value.account.account_id))].sort();
}

/** The parts of the scheduler options that failure reporting reads. */
export interface ReportingSchedulerReportingOptionsV1 {
  onError?: (error: unknown) => void | Promise<void>;
  logger?: { warn: (message: string) => void };
}

/** Where in the scheduler loop a failure happened. */
export interface ReportingSchedulerFailureSiteV1 {
  readonly phase: 'roster' | 'cycle' | 'maintenance';
  readonly accountId?: string | undefined;
}

export async function reportReportingSchedulerError(
  options: ReportingSchedulerReportingOptionsV1,
  signal: AbortSignal,
  error: unknown,
  site: ReportingSchedulerFailureSiteV1
): Promise<void> {
  if (signal.aborted) return;
  if (options.onError) {
    try {
      await options.onError(error);
    } catch (observerError) {
      // Error observers must not terminate the reporting lifecycle -- and must
      // not make the failure they were handed disappear with their own.
      warnReportingSchedulerFailure(options, site, error, observerError);
    }
    return;
  }
  // No observer is configured, so this is the only place the failure surfaces.
  warnReportingSchedulerFailure(options, site, error);
}

export function warnReportingSchedulerFailure(
  options: ReportingSchedulerReportingOptionsV1,
  site: ReportingSchedulerFailureSiteV1,
  error: unknown,
  observerError?: unknown
): void {
  const where =
    site.phase === 'roster'
      ? 'could not resolve its account roster, so this pass ran no tenants'
      : site.phase === 'maintenance'
        ? 'ledger maintenance failed; the scheduler continues'
        : site.accountId === undefined
          ? 'deployment-wide cycle failed; the scheduler continues'
          : `cycle failed for account ${site.accountId}; later tenants continue`;
  const observed =
    observerError === undefined
      ? ''
      : ` (the configured onError also threw: ${reportingSchedulerErrorMessage(observerError)})`;
  const message = `[adcp/reporting] scheduler ${where}: ${reportingSchedulerErrorMessage(error)}${observed}`;
  const logger = options.logger;
  try {
    // Called on its owner, not through an extracted reference: a pino, winston
    // or class-based logger reads `this` inside `warn`, and a bare `warn(...)`
    // threw `Cannot read properties of undefined` into the catch below —
    // losing exactly the diagnostic this path exists to emit.
    if (logger !== undefined) logger.warn(message);
    else defaultSchedulerWarn(message);
  } catch {
    // A logger that throws must not terminate the reporting lifecycle either.
  }
}

function defaultSchedulerWarn(message: string): void {
  console.warn(message);
}
