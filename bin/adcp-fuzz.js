#!/usr/bin/env node

const { runConformance, DEFAULT_TOOLS } = require('../dist/lib/conformance/index.js');

const USAGE = `Usage: adcp fuzz <agent-url> [options]

Runs property-based conformance fuzzing against an agent's published JSON
schemas. Each tool is called with schema-valid inputs and the response is
checked under the two-path oracle: responses that validate the response
schema pass (accepted), and responses that return a well-formed AdCP error
envelope with an uppercase-snake reason code also pass (rejected — agents
SHOULD return REFERENCE_NOT_FOUND, not 500).

Options:
  --seed <int>                Reproducibility seed (default: random — printed on exit)
  --tools <a,b,c>             Comma-separated tool list (default: stateless + referential tier)
  --list-tools                Print the default tool list and exit
  --turn-budget <int>         Iterations per tool (default: 50)
  --protocol <mcp|a2a>        Transport (default: mcp)
  --auth-token <token>        Bearer token. Also reads ADCP_AUTH_TOKEN env var.
  --fixture <name>=<ids>      Pre-seed an ID pool. Repeatable.
                              Example: --fixture creative_ids=cre_1,cre_2
  --max-failures <int>        Cap failures collected (default: 20)
  --max-payload-bytes <int>   Cap serialized failure input/response size (default: 8192)
  --format <human|json>       Output format (default: human)
  -h, --help                  Show this help

Exit code:
  0   zero failures
  1   one or more failures
  2   argument / configuration error

Examples:
  adcp fuzz https://agent.example.com/mcp
  adcp fuzz https://agent.example.com/mcp --seed 42 --tools get_signals,get_products
  adcp fuzz https://agent.example.com/mcp --fixture creative_ids=cre_a,cre_b
  adcp fuzz https://agent.example.com/mcp --format json | jq
`;

const FIXTURE_KEYS = new Set([
  'creative_ids',
  'media_buy_ids',
  'list_ids',
  'task_ids',
  'plan_ids',
  'account_ids',
  'package_ids',
  'format_ids',
]);

async function handleFuzzCommand(argv) {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(USAGE);
    return;
  }
  if (argv[0] === '--list-tools') {
    for (const t of DEFAULT_TOOLS) process.stdout.write(t + '\n');
    return;
  }
  if (argv[0].startsWith('-')) {
    console.error('ERROR: agent URL is required\n');
    process.stderr.write(USAGE);
    process.exit(2);
  }

  const agentUrl = argv[0];
  const options = {};
  let format = 'human';
  const fixtures = {};

  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--seed':
        options.seed = Number.parseInt(argv[++i], 10);
        if (!Number.isFinite(options.seed)) argError('--seed requires an integer');
        break;
      case '--tools':
        options.tools = argv[++i]
          .split(',')
          .map(s => s.trim())
          .filter(Boolean);
        break;
      case '--turn-budget':
        options.turnBudget = Number.parseInt(argv[++i], 10);
        if (!Number.isFinite(options.turnBudget) || options.turnBudget < 1) {
          argError('--turn-budget requires a positive integer');
        }
        break;
      case '--protocol': {
        const p = argv[++i];
        if (p !== 'mcp' && p !== 'a2a') argError('--protocol must be "mcp" or "a2a"');
        options.protocol = p;
        break;
      }
      case '--auth-token':
        options.authToken = argv[++i];
        break;
      case '--fixture': {
        const spec = argv[++i];
        const eq = spec.indexOf('=');
        if (eq < 0) argError('--fixture takes name=id1,id2,...');
        const name = spec.slice(0, eq);
        const values = spec
          .slice(eq + 1)
          .split(',')
          .map(s => s.trim())
          .filter(Boolean);
        if (!FIXTURE_KEYS.has(name)) {
          argError(`unknown fixture pool: ${name}. Known: ${[...FIXTURE_KEYS].join(', ')}`);
        }
        fixtures[name] = values;
        break;
      }
      case '--max-failures':
        options.maxFailures = Number.parseInt(argv[++i], 10);
        if (!Number.isFinite(options.maxFailures) || options.maxFailures < 1) {
          argError('--max-failures requires a positive integer');
        }
        break;
      case '--max-payload-bytes':
        options.maxFailurePayloadBytes = Number.parseInt(argv[++i], 10);
        if (!Number.isFinite(options.maxFailurePayloadBytes) || options.maxFailurePayloadBytes < 256) {
          argError('--max-payload-bytes must be >= 256');
        }
        break;
      case '--format': {
        const f = argv[++i];
        if (f !== 'human' && f !== 'json') argError('--format must be "human" or "json"');
        format = f;
        break;
      }
      case '-h':
      case '--help':
        process.stdout.write(USAGE);
        return;
      default:
        argError(`unknown flag: ${a}`);
    }
  }

  if (Object.keys(fixtures).length > 0) options.fixtures = fixtures;
  if (!options.authToken && process.env.ADCP_AUTH_TOKEN) {
    options.authToken = process.env.ADCP_AUTH_TOKEN;
  }

  const report = await runConformance(agentUrl, options);

  if (format === 'json') {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    printHumanReport(report);
  }

  process.exit(report.totalFailures > 0 ? 1 : 0);
}

function argError(msg) {
  console.error(`ERROR: ${msg}\n`);
  process.stderr.write(USAGE);
  process.exit(2);
}

function printHumanReport(report) {
  const out = [];
  out.push('');
  out.push(`Conformance report  (schema ${report.schemaVersion}, seed ${report.seed})`);
  out.push(`Agent: ${report.agentUrl}`);
  out.push(
    `Runs: ${report.totalRuns}   Failures: ${report.totalFailures}${report.droppedFailures ? ` (+${report.droppedFailures} dropped)` : ''}   Duration: ${report.durationMs}ms`
  );
  out.push('');
  out.push('Per-tool:');
  const maxTool = Math.max(...Object.keys(report.perTool).map(s => s.length));
  for (const [tool, s] of Object.entries(report.perTool)) {
    const name = tool.padEnd(maxTool);
    if (s.skipped) {
      out.push(`  ${name}  SKIPPED  ${s.skipReason}`);
    } else {
      const verdict = s.failed ? 'FAIL ' : 'OK   ';
      out.push(
        `  ${name}  ${verdict}  runs=${s.runs}  accepted=${s.accepted}  rejected=${s.rejected}  failed=${s.failed}`
      );
    }
  }

  if (report.failures.length > 0) {
    out.push('');
    out.push(`Failures (${report.failures.length}):`);
    for (const f of report.failures) {
      out.push('');
      out.push(`  [${f.tool}]  seed=${f.seed}  shrunk=${f.shrunk}  reproduce: --seed ${f.seed} --tools ${f.tool}`);
      for (const inv of f.invariantFailures) out.push(`    · ${inv}`);
      const inputStr = JSON.stringify(f.input);
      if (inputStr) out.push(`    input: ${truncate(inputStr, 400)}`);
    }
  }

  out.push('');
  process.stdout.write(out.join('\n'));
}

function truncate(s, n) {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

module.exports = { handleFuzzCommand };
