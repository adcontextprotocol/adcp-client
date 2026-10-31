/**
 * `npx adcp-reporting-storage migrate`: apply the reporting storage migrations (experimental, AdCP 3.3).
 *
 * The package's `bin/adcp-reporting-storage.js` calls {@link runReportingStorageCli}. It needs the `pg`
 * driver, which a PostgreSQL deployment already installs.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
import { MIGRATE_COMMAND, describeMigrations, migrate, migrationStatus } from './migrations';
import type { ReportingPgPool } from './postgres';

/** @internal */
export const REPORTING_STORAGE_CLI_USAGE = `Usage: ${MIGRATE_COMMAND} [--database-url URL] [--schema NAME] [--status | --dry-run]

Apply the reporting storage migrations (@adcp/reporting-storage) to a PostgreSQL database, in order.
Each migration commits on its own under the reporting schema lock. A stopped-worker upgrade needs
every reporting worker stopped first.

  --database-url URL  PostgreSQL URL. Defaults to $ADCP_DATABASE_URL, then $DATABASE_URL.
  --schema NAME       Schema to migrate (sets search_path). Defaults to the URL's search_path.
  --status            List applied and pending migrations.
  --dry-run           Print what would be applied.
  --help              Show this help.`;

/** @internal */
export interface ReportingStorageCliIo {
  out(line: string): void;
  err(line: string): void;
  env: Readonly<Record<string, string | undefined>>;
  /** Builds the pool; defaults to a one-connection pool from the pg driver. */
  createPool?(config: {
    connectionString: string;
    options?: string;
  }): Promise<ReportingPgPool & { end(): Promise<void> }>;
}

async function defaultPool(config: {
  connectionString: string;
  options?: string;
}): Promise<ReportingPgPool & { end(): Promise<void> }> {
  const specifier = 'pg';
  let pg: { Pool: new (config: unknown) => ReportingPgPool & { end(): Promise<void> } };
  try {
    const loaded = (await import(specifier)) as { default?: typeof pg } & typeof pg;
    pg = loaded.Pool ? loaded : loaded.default!;
  } catch {
    throw new Error('the pg driver is not installed. Install it: npm install pg');
  }
  return new pg.Pool({ ...config, max: 1 });
}

/**
 * Run the CLI with `argv` (without the node and script paths). Resolves to the process exit code.
 *
 * @internal
 */
export async function runReportingStorageCli(
  argv: readonly string[],
  io: ReportingStorageCliIo = {
    out: line => console.log(line),
    err: line => console.error(line),
    env: process.env,
  }
): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    io.out(REPORTING_STORAGE_CLI_USAGE);
    return command === undefined ? 2 : 0;
  }
  if (command !== 'migrate') {
    io.err(`Unknown command ${JSON.stringify(command)}.\n\n${REPORTING_STORAGE_CLI_USAGE}`);
    return 2;
  }
  let databaseUrl = io.env.ADCP_DATABASE_URL || io.env.DATABASE_URL;
  let schema: string | undefined;
  let status = false;
  let dryRun = false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    const value = (): string | undefined => {
      const inline = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : undefined;
      if (inline !== undefined) return inline;
      index += 1;
      return rest[index];
    };
    if (arg === '--help' || arg === '-h') {
      io.out(REPORTING_STORAGE_CLI_USAGE);
      return 0;
    } else if (arg === '--status') status = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--database-url' || arg.startsWith('--database-url=')) databaseUrl = value();
    else if (arg === '--schema' || arg.startsWith('--schema=')) schema = value();
    else {
      io.err(`Unknown option ${JSON.stringify(arg)}.\n\n${REPORTING_STORAGE_CLI_USAGE}`);
      return 2;
    }
  }
  if (status && dryRun) {
    io.err(`Pass --status or --dry-run, not both.\n\n${REPORTING_STORAGE_CLI_USAGE}`);
    return 2;
  }
  if (!databaseUrl) {
    io.err(`Pass --database-url or set DATABASE_URL.\n\n${REPORTING_STORAGE_CLI_USAGE}`);
    return 2;
  }
  if (schema !== undefined && !/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(schema)) {
    io.err('--schema must be a plain PostgreSQL identifier.');
    return 2;
  }
  let pool: (ReportingPgPool & { end(): Promise<void> }) | undefined;
  try {
    pool = await (io.createPool ?? defaultPool)({
      connectionString: databaseUrl,
      ...(schema !== undefined ? { options: `-c search_path=${schema}` } : {}),
    });
    if (status) {
      const statuses = await migrationStatus(pool);
      for (const line of describeMigrations(statuses)) io.out(line);
      const pending = statuses.filter(item => item.pending).length;
      io.out(pending > 0 ? `${pending} pending` : 'up to date');
      return 0;
    }
    const planned = await migrate(pool, { dryRun });
    for (const item of planned) {
      io.out(
        `${dryRun ? 'would apply' : 'applied'} ${item.version} ${item.name}${item.stoppedWorker ? ' (stopped-worker upgrade)' : ''}`
      );
    }
    if (planned.length === 0) io.out('up to date');
    return 0;
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await pool?.end().catch(() => undefined);
  }
}
