'use strict';
/**
 * `adcp reporting`: reporting-subscription tools (experimental, AdCP 3.3).
 *
 *   adcp reporting explain   --agent <alias|url> --account <id> --period <date|instant> [...]
 *   adcp reporting explain   --app <module>[#export] --tenant <id> --principal <id> --account <id> --period <...>
 *   adcp reporting diff      <left.json> <right.json>
 *   adcp reporting reconcile --agent <alias|url> [--since <date>] [--include-not-owed]
 */
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const USAGE = `adcp reporting: reporting subscriptions (experimental, AdCP 3.3)

USAGE:
  adcp reporting explain --agent <alias|url> --account <id> --period <YYYY-MM-DD|instant> [options]
      Buyer side: explain from wire reads, as client.reporting.explain() does.
  adcp reporting explain --app <module>[#export] --tenant <id> --principal <id> --account <id> --period <...>
      Seller side: load your Reliable Reporting service and call service.explainCoverage().
  adcp reporting diff <left.json> <right.json>
      Compare a buyer trace with a seller trace (files from --json); names the first differing rule.
  adcp reporting reconcile --agent <alias|url> [--since <date>] [--include-not-owed] [--grace PT1H]
      Every owed period with its status, as client.reporting.reconcile() does.
  adcp reporting doctor --agent <alias|url>
      Check a seller's subscription wiring from the wire: offerings, subscriptions, get_principal,
      account timezones and grants, get_media_buys, and the conformance probe. Every failure names a fix.

OPTIONS:
  --subscription <id>   only this subscription
  --buy <id>            only this media buy
  --offering <id>       only this offering
  --auth <token>        bearer token for --agent
  --protocol mcp|a2a    skip protocol detection
  --json                print JSON (traces, or the report)
`;

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function readTraces(file) {
  const value = JSON.parse(readFileSync(file, 'utf8'));
  return Array.isArray(value) ? value : [value];
}

const traceKey = trace =>
  JSON.stringify([
    trace.subject.account_id,
    trace.subject.subscription_id,
    trace.subject.media_buy_id,
    trace.subject.offering_id,
    Date.parse(trace.subject.period.start),
    Date.parse(trace.subject.period.end),
  ]);

function printTraces(traces, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(traces, null, 2)}\n`);
    return;
  }
  if (traces.length === 0) {
    process.stdout.write('No periods match: check the account, the subscription and the period.\n');
    return;
  }
  for (const trace of traces) {
    const { subject } = trace;
    process.stdout.write(
      `${subject.period.start} → ${subject.period.end} (${subject.period.timezone})  ${subject.subscription_id} v${subject.subscription_version}  ${subject.media_buy_id}  ${subject.offering_id ?? '-'}\n` +
        `  ${trace.verdict.toUpperCase()}  ${trace.reason}\n  ${trace.explanation}\n  ${trace.inputs_digest}\n`
    );
  }
}

async function buyerClient(args, deps) {
  const agent = option(args, '--agent');
  if (!agent) throw new Error('--agent <alias|url> is required. See: adcp reporting --help');
  const json = args.includes('--json');
  const resolved = await deps.resolveAgent(agent, option(args, '--auth'), option(args, '--protocol'), json);
  const id = resolved.aliasId ?? 'reporting-agent';
  const config = {
    id,
    name: id,
    agent_uri: resolved.agentUrl,
    protocol: resolved.protocol,
    ...(resolved.authToken ? { auth_token: resolved.authToken, requiresAuth: true } : {}),
    ...(resolved.oauthTokens ? { oauth_tokens: resolved.oauthTokens } : {}),
    ...(resolved.oauthClient ? { oauth_client: resolved.oauthClient } : {}),
    ...(resolved.oauthClientCredentials ? { oauth_client_credentials: resolved.oauthClientCredentials } : {}),
    ...(resolved.savedHeaders ? { headers: resolved.savedHeaders } : {}),
  };
  return new deps.AdCPClient([config]).agent(id);
}

async function loadService(spec) {
  const [modulePath, exportName] = spec.split('#');
  const resolved = path.resolve(process.cwd(), modulePath);
  const loaded = await import(pathToFileURL(resolved).href);
  const candidates = exportName ? [loaded[exportName]] : [loaded.reporting, loaded.service, loaded.default];
  const service = candidates.find(item => item && typeof item.explainCoverage === 'function');
  if (!service) {
    throw new Error(
      `${spec} exports no Reliable Reporting service with explainCoverage. Export the service created with createReliableReportingService({ subscriptions }) as "reporting", or name it: --app ${modulePath}#myService`
    );
  }
  return service;
}

async function explain(args, deps) {
  const json = args.includes('--json');
  const account = option(args, '--account');
  const period = option(args, '--period');
  if (!account || !period) throw new Error('--account and --period are required. See: adcp reporting --help');
  const filters = {
    ...(option(args, '--subscription') ? { subscriptionId: option(args, '--subscription') } : {}),
    ...(option(args, '--buy') ? { mediaBuyId: option(args, '--buy') } : {}),
    ...(option(args, '--offering') ? { offeringId: option(args, '--offering') } : {}),
  };
  const app = option(args, '--app');
  if (app) {
    const tenantId = option(args, '--tenant');
    const principalId = option(args, '--principal');
    if (!tenantId || !principalId) throw new Error('--app needs --tenant and --principal.');
    const service = await loadService(app);
    printTraces(
      await service.explainCoverage({ principal: { tenantId, principalId }, accountId: account, period, ...filters }),
      json
    );
    return 0;
  }
  const client = await buyerClient(args, deps);
  printTraces(await client.reporting.explain({ accountId: account, period, ...filters }), json);
  return 0;
}

function diff(args) {
  const [leftFile, rightFile] = args.filter(arg => !arg.startsWith('--'));
  if (!leftFile || !rightFile) throw new Error('Usage: adcp reporting diff <left.json> <right.json>');
  const { diffCoverageTraces } = require('../dist/lib/reporting/advanced/index.js');
  const left = new Map(readTraces(leftFile).map(trace => [traceKey(trace), trace]));
  const right = new Map(readTraces(rightFile).map(trace => [traceKey(trace), trace]));
  let differences = 0;
  for (const [key, trace] of left) {
    const other = right.get(key);
    const label = `${trace.subject.period.start} ${trace.subject.media_buy_id} ${trace.subject.offering_id ?? '-'}`;
    if (!other) {
      differences += 1;
      process.stdout.write(`${label}: only in ${leftFile}\n`);
      continue;
    }
    const difference = diffCoverageTraces(trace, other);
    if (difference) {
      differences += 1;
      process.stdout.write(`${label}: ${difference.description}\n`);
    }
  }
  for (const [key, trace] of right) {
    if (left.has(key)) continue;
    differences += 1;
    process.stdout.write(
      `${trace.subject.period.start} ${trace.subject.media_buy_id} ${trace.subject.offering_id ?? '-'}: only in ${rightFile}\n`
    );
  }
  if (differences === 0) process.stdout.write(`The traces agree (${left.size}).\n`);
  return differences === 0 ? 0 : 1;
}

async function reconcile(args, deps) {
  const json = args.includes('--json');
  const client = await buyerClient(args, deps);
  const report = await client.reporting.reconcile({
    ...(option(args, '--since') ? { since: option(args, '--since') } : {}),
    ...(option(args, '--grace') ? { grace: option(args, '--grace') } : {}),
    ...(args.includes('--include-not-owed') ? { includeNotOwed: true } : {}),
  });
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.definitive ? 0 : 1;
  }
  const { summary } = report;
  process.stdout.write(
    `As of ${report.as_of}, since ${report.since}${report.definitive ? '' : ' (NOT definitive: some reads failed)'}\n` +
      `owed ${summary.owed}: delivered ${summary.delivered}, pending ${summary.pending}, late ${summary.late}, missing ${summary.missing_obligation}, withheld ${summary.withheld}; not owed ${summary.not_owed}\n`
  );
  for (const line of report.periods) {
    process.stdout.write(
      `${line.account_id}  ${line.subscription_id} v${line.subscription_version}  ${line.period.start}  ${line.status.padEnd(18)} ${line.responsible_party.padEnd(6)} ${line.message}\n`
    );
  }
  for (const account of report.accounts.filter(item => item.status !== 'reconciled')) {
    process.stdout.write(
      `${account.account_id}: ${account.status}${account.error ? ` (${account.error.task}: ${account.error.message})` : ''}\n`
    );
  }
  return report.definitive ? 0 : 1;
}

async function doctor(args, deps) {
  const json = args.includes('--json');
  const client = await buyerClient(args, deps);
  const { runReportingDoctor } = require('../dist/lib/testing/reporting/index.js');
  const report = await runReportingDoctor(client);
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.ok ? 0 : 1;
  }
  const mark = { pass: 'ok  ', warn: 'warn', fail: 'FAIL' };
  for (const check of report.checks) {
    process.stdout.write(`${mark[check.status]}  ${check.id}: ${check.message}\n`);
    if (check.fix) process.stdout.write(`      fix: ${check.fix}\n`);
  }
  process.stdout.write(report.ok ? 'No failures.\n' : 'Fix the failures above, then run the storyboard.\n');
  return report.ok ? 0 : 1;
}

async function handleReportingCommand(args, deps) {
  const command = args[0];
  if (!command || command === '--help' || command === '-h' || args.includes('--help')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const rest = args.slice(1);
  if (command === 'explain') return explain(rest, deps);
  if (command === 'diff') return diff(rest);
  if (command === 'reconcile') return reconcile(rest, deps);
  if (command === 'doctor') return doctor(rest, deps);
  if (deps.extra?.[command]) return deps.extra[command](rest, deps);
  process.stderr.write(`Unknown command: adcp reporting ${command}\n\n${USAGE}`);
  return 2;
}

/**
 * `adcp reference-seller reporting [--port 3000] [--cycle-seconds 60]`: serve the reference seller
 * (examples/reporting-subscriptions-seller) locally, with a seeded buy, running its cycle on a timer.
 * Any bearer token is the caller's principal id. Development only: state is in memory.
 */
async function handleReferenceSellerCommand(args) {
  if (args[0] !== 'reporting' || args.includes('--help')) {
    process.stdout.write(
      'Usage: adcp reference-seller reporting [--port 3000] [--cycle-seconds 60]\n' +
        'Serves the reporting-subscriptions reference seller over MCP. Any bearer token is the principal id.\n'
    );
    return args[0] === 'reporting' || args.includes('--help') ? 0 : 2;
  }
  process.env.NODE_ENV ??= 'development';
  const port = Number(option(args, '--port') ?? 3000);
  const cycleSeconds = Number(option(args, '--cycle-seconds') ?? 60);
  const { serve } = require('../dist/lib/index.js');
  const seller = await import(
    pathToFileURL(path.join(__dirname, '..', 'examples', 'reporting-subscriptions-seller', 'seller.mjs')).href
  );
  const { createServer, service } = seller.createReportingSubscriptionsSeller();
  serve(createServer, {
    port,
    authenticate: request => {
      const header = request.headers?.authorization ?? '';
      const token = /^Bearer\s+(.+)$/i.exec(header)?.[1];
      return { principal: token || 'buyer' };
    },
    onListening: url =>
      process.stdout.write(
        `Reporting reference seller on ${url ?? `http://127.0.0.1:${port}/mcp`} (account ${seller.REFERENCE_ACCOUNT_ID}).\n` +
          `Try: npx adcp reporting reconcile --agent http://127.0.0.1:${port}/mcp --auth agency-x\n`
      ),
  });
  const cycle = () =>
    service.runCycle({ deploymentWide: true }).catch(error => process.stderr.write(`cycle failed: ${error.message}\n`));
  setInterval(cycle, cycleSeconds * 1000).unref?.();
  await cycle();
  return new Promise(() => {});
}

module.exports = { handleReportingCommand, handleReferenceSellerCommand, readTraces, traceKey };
