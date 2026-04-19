#!/usr/bin/env node

const { gradeRequestSigning } = require('../dist/lib/testing/storyboard/request-signing/index.js');

const USAGE = `Usage: adcp grade request-signing <agent-url> [options]

Runs the RFC 9421 conformance grader against an agent's request-signing
verifier. Returns a PASS/FAIL report with per-vector diagnostics.

Preconditions (owned by the operator):
  • Agent advertises \`request_signing.supported: true\` in get_adcp_capabilities.
  • Agent has pre-configured its verifier per
    compliance/cache/<version>/test-kits/signed-requests-runner.yaml:
      - accepts runner signing keyids (test-ed25519-2026, test-es256-2026)
      - has test-revoked-2026 in its revocation list
      - per-keyid replay cap ≥ --rate-abuse-cap (or matches contract default)
  • <agent-url> points at a SANDBOX endpoint — vector 016 fires a live
    create_media_buy-shaped request the agent will accept, and vector 020
    floods the replay cache with cap+1 signatures.

Options:
  --skip-rate-abuse          Skip vector 020 (fastest grading run)
  --rate-abuse-cap <N>       Override per-keyid cap the grader targets
  --skip <id[,id...]>        Skip specific vector ids (e.g. 007-…,018-…)
  --only <id[,id...]>        Run only the named vector ids
  --allow-live-side-effects  Opt in to vectors 016/020 against non-sandbox
                             endpoints (USE WITH CARE — creates real orders)
  --allow-http               Allow http:// URLs + private-IP targets (dev loops)
  --timeout <ms>             Per-probe timeout (default 10000)
  --json                     Emit the full GradeReport as JSON
  -h, --help                 Show this help

Exit code:
  0   all graded vectors passed (skipped vectors don't count as failures)
  1   at least one vector failed
  2   argument / configuration error

Examples:
  adcp grade request-signing https://agent.example.com/adcp
  adcp grade request-signing http://127.0.0.1:3000 --allow-http --skip-rate-abuse
  adcp grade request-signing https://sandbox.seller.com/adcp --json | jq
`;

async function handleGradeCommand(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(USAGE);
    return;
  }
  if (argv[0] !== 'request-signing') {
    console.error(`Unknown grade subject: ${argv[0]}\n`);
    process.stderr.write(USAGE);
    process.exit(2);
  }
  const args = argv.slice(1);
  if (args.length === 0 || args[0].startsWith('-')) {
    console.error('ERROR: agent URL is required\n');
    process.stderr.write(USAGE);
    process.exit(2);
  }

  const agentUrl = args[0];
  const options = {};
  let emitJson = false;

  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case '--skip-rate-abuse':
        options.skipRateAbuse = true;
        break;
      case '--rate-abuse-cap':
        options.rateAbuseCap = Number.parseInt(args[++i], 10);
        if (!Number.isFinite(options.rateAbuseCap) || options.rateAbuseCap < 1) {
          console.error(`ERROR: --rate-abuse-cap requires a positive integer\n`);
          process.exit(2);
        }
        break;
      case '--skip':
        options.skipVectors = parseVectorList(args[++i], '--skip');
        break;
      case '--only':
        options.onlyVectors = parseVectorList(args[++i], '--only');
        break;
      case '--allow-live-side-effects':
        options.allowLiveSideEffects = true;
        break;
      case '--allow-http':
        options.allowPrivateIp = true;
        break;
      case '--timeout':
        options.timeoutMs = Number.parseInt(args[++i], 10);
        if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1) {
          console.error(`ERROR: --timeout requires a positive integer (ms)\n`);
          process.exit(2);
        }
        break;
      case '--json':
        emitJson = true;
        break;
      case '-h':
      case '--help':
        process.stdout.write(USAGE);
        return;
      default:
        console.error(`Unknown flag: ${a}\n`);
        process.stderr.write(USAGE);
        process.exit(2);
    }
  }

  try {
    const report = await gradeRequestSigning(agentUrl, options);
    if (emitJson) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else {
      printHumanReport(report);
    }
    process.exit(report.passed ? 0 : 1);
  } catch (err) {
    console.error(`grade-request-signing failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}

function parseVectorList(raw, flagName) {
  if (!raw) {
    console.error(`ERROR: ${flagName} requires a comma-separated vector-id list\n`);
    process.exit(2);
  }
  const list = raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (list.length === 0) {
    console.error(`ERROR: ${flagName} list is empty\n`);
    process.exit(2);
  }
  return list;
}

function printHumanReport(report) {
  const { positive, negative } = report;
  const all = [...positive, ...negative];
  const rows = all.map(formatRow);
  const idWidth = Math.max(...rows.map(r => r.id.length), 10);
  const statusWidth = 8;

  console.log();
  console.log(`Agent: ${report.agent_url}`);
  console.log(`Harness: ${report.harness_mode}${report.contract_loaded ? ' (contract loaded)' : ' (no contract)'}`);
  if (report.live_endpoint_warning) {
    console.log(`⚠  Contract does not declare endpoint_scope: sandbox. Vectors 016/020 produce live side effects.`);
  }
  console.log();
  console.log(`${'vector'.padEnd(idWidth)}  ${'status'.padEnd(statusWidth)}  detail`);
  console.log('─'.repeat(idWidth + statusWidth + 20));
  for (const row of rows) {
    console.log(`${row.id.padEnd(idWidth)}  ${row.status.padEnd(statusWidth)}  ${row.detail}`);
  }
  console.log();
  console.log(
    `${report.passed_count} passed, ${report.failed_count} failed, ${report.skipped_count} skipped — total ${report.total_duration_ms}ms`
  );
  console.log(`Overall: ${report.passed ? 'PASS' : 'FAIL'}`);
  console.log();
}

function formatRow(r) {
  const id = `${r.kind === 'positive' ? 'pos' : 'neg'}/${r.vector_id}`;
  let status;
  if (r.skipped) status = 'SKIP';
  else if (r.passed) status = 'PASS';
  else status = 'FAIL';
  const detail = r.skipped
    ? (r.skip_reason ?? '')
    : r.passed
      ? `${r.http_status}${r.actual_error_code ? ` ${r.actual_error_code}` : ''}`
      : (r.diagnostic ?? 'see report');
  return { id, status, detail };
}

module.exports = { handleGradeCommand };

if (require.main === module) {
  handleGradeCommand(process.argv.slice(2)).catch(err => {
    console.error(err);
    process.exit(2);
  });
}
