#!/usr/bin/env node

const {
  runConformance,
  DEFAULT_TOOLS_WITH_UPDATES,
  REFERENTIAL_STATELESS_TOOLS,
  UPDATE_TIER_TOOLS,
} = require('../dist/lib/conformance/index.js');

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
  --list-tools                Print every tool name + its tier and exit
  --turn-budget <int>         Iterations per tool (default: 50)
  --protocol <mcp|a2a>        Transport (default: mcp)
  --auth-token <token>        Bearer token. Also reads ADCP_AUTH_TOKEN env var.
  --fixture <name>=<ids>      Pre-seed an ID pool. Repeatable.
                              Example: --fixture creative_ids=cre_1,cre_2
                              IDs with commas are not expressible on the CLI —
                              drop to the runConformance() API if you need them.
  --auto-seed                 Before fuzzing, create a property list, a
                              content-standards config, and a media buy on
                              the agent; feed the returned IDs into fuzzing
                              so Tier-3 update_* tools exercise real state.
                              MUTATES the agent — point at a sandbox tenant.
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

const TIER_2 = new Set(REFERENTIAL_STATELESS_TOOLS);
const TIER_3 = new Set(UPDATE_TIER_TOOLS);

async function handleFuzzCommand(argv) {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(USAGE);
    return;
  }
  if (argv[0] === '--list-tools') {
    for (const t of DEFAULT_TOOLS_WITH_UPDATES) {
      let suffix = '';
      if (TIER_3.has(t)) suffix = '  (update — needs --auto-seed or --fixture)';
      else if (TIER_2.has(t)) suffix = '  (referential — fixture-eligible)';
      process.stdout.write(t + suffix + '\n');
    }
    return;
  }
  if (argv[0].startsWith('-')) {
    argError('agent URL is required');
  }

  const agentUrl = argv[0];
  const options = {};
  let format = 'human';
  const fixtures = {};

  // requireValue pulls the next argv token, erroring if it's missing or
  // (most likely user-input footgun) already another flag.
  const requireValue = (i, flag) => {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      argError(`${flag} requires a value`);
    }
    return next;
  };

  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--seed': {
        const raw = requireValue(i, '--seed');
        const v = Number.parseInt(raw, 10);
        if (!Number.isFinite(v) || v < 0)
          argError(`--seed requires a non-negative integer (got ${JSON.stringify(raw)})`);
        options.seed = v;
        i++;
        break;
      }
      case '--tools':
        options.tools = requireValue(i, '--tools')
          .split(',')
          .map(s => s.trim())
          .filter(Boolean);
        if (options.tools.length === 0) argError('--tools requires at least one tool name');
        i++;
        break;
      case '--turn-budget': {
        const raw = requireValue(i, '--turn-budget');
        const v = Number.parseInt(raw, 10);
        if (!Number.isFinite(v) || v < 1)
          argError(`--turn-budget requires a positive integer (got ${JSON.stringify(raw)})`);
        options.turnBudget = v;
        i++;
        break;
      }
      case '--protocol': {
        const p = requireValue(i, '--protocol');
        if (p !== 'mcp' && p !== 'a2a') argError(`--protocol must be "mcp" or "a2a" (got ${JSON.stringify(p)})`);
        options.protocol = p;
        i++;
        break;
      }
      case '--auth-token':
        options.authToken = requireValue(i, '--auth-token');
        i++;
        break;
      case '--fixture': {
        const spec = requireValue(i, '--fixture');
        const eq = spec.indexOf('=');
        if (eq < 0) argError(`--fixture takes name=id1,id2,... (got ${JSON.stringify(spec)})`);
        const name = spec.slice(0, eq);
        if (name.length === 0) argError('--fixture name is empty; expected name=id1,id2,...');
        if (!FIXTURE_KEYS.has(name)) {
          argError(`unknown fixture pool: ${name}. Known: ${[...FIXTURE_KEYS].join(', ')}`);
        }
        const values = spec
          .slice(eq + 1)
          .split(',')
          .map(s => s.trim())
          .filter(Boolean);
        if (values.length === 0) argError(`--fixture ${name}= has no IDs`);
        fixtures[name] = values;
        i++;
        break;
      }
      case '--auto-seed':
        options.autoSeed = true;
        break;
      case '--max-failures': {
        const raw = requireValue(i, '--max-failures');
        const v = Number.parseInt(raw, 10);
        if (!Number.isFinite(v) || v < 1)
          argError(`--max-failures requires a positive integer (got ${JSON.stringify(raw)})`);
        options.maxFailures = v;
        i++;
        break;
      }
      case '--max-payload-bytes': {
        const raw = requireValue(i, '--max-payload-bytes');
        const v = Number.parseInt(raw, 10);
        if (!Number.isFinite(v) || v < 256) argError(`--max-payload-bytes must be >= 256 (got ${JSON.stringify(raw)})`);
        options.maxFailurePayloadBytes = v;
        i++;
        break;
      }
      case '--format': {
        const f = requireValue(i, '--format');
        if (f !== 'human' && f !== 'json') argError(`--format must be "human" or "json" (got ${JSON.stringify(f)})`);
        format = f;
        i++;
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
  if (report.autoSeeded) {
    const pools = Object.entries(report.fixturesUsed ?? {})
      .filter(([, v]) => Array.isArray(v) && v.length > 0)
      .map(([k, v]) => `${k}=${v.length}`)
      .join(', ');
    out.push(`Auto-seeded: ${pools || 'no fixtures captured'}`);
    if (report.seedWarnings && report.seedWarnings.length > 0) {
      out.push('Seed warnings:');
      for (const w of report.seedWarnings) out.push(`  · [${w.seeder}] ${w.reason}`);
    }
  }
  out.push('');
  out.push('Per-tool:');
  const maxTool = Math.max(...Object.keys(report.perTool).map(s => s.length));
  const tier2Without = [];
  for (const [tool, s] of Object.entries(report.perTool)) {
    const name = tool.padEnd(maxTool);
    if (s.skipped) {
      out.push(`  ${name}  SKIPPED  ${s.skipReason}`);
    } else {
      const verdict = s.failed ? 'FAIL ' : 'OK   ';
      out.push(
        `  ${name}  ${verdict}  runs=${s.runs}  accepted=${s.accepted}  rejected=${s.rejected}  failed=${s.failed}`
      );
      if (TIER_2.has(tool) && s.accepted === 0 && s.runs > 0 && !hasFixtureFor(tool, report.fixturesUsed)) {
        tier2Without.push(tool);
      }
    }
  }

  if (report.failures.length > 0) {
    out.push('');
    out.push(`Failures (${report.failures.length}):`);
    for (const f of report.failures) {
      out.push('');
      out.push(`  [${f.tool}]  seed=${f.seed}  shrunk=${f.shrunk}`);
      out.push(`    reproduce: ${reproduceCommand(report, f)}`);
      for (const inv of f.invariantFailures) out.push(`    · ${inv}`);
      const inputStr = JSON.stringify(f.input);
      if (inputStr) out.push(`    input: ${truncate(inputStr, 400)}`);
    }
  }

  if (report.totalFailures === 0) {
    out.push('');
    out.push(`✓ Clean. Pin this seed in CI: --seed ${report.seed}`);
    if (tier2Without.length > 0) {
      out.push(
        `  Note: ${tier2Without.length} Tier-2 tool(s) rejected all runs (no fixtures): ${tier2Without.join(', ')}`
      );
      out.push(`  To exercise the accepted path, pass --fixture <pool>=<ids> (see \`adcp fuzz --help\`).`);
    }
  }

  out.push('');
  process.stdout.write(out.join('\n'));
}

/**
 * Build a full reproduce invocation. Echoes fixtures, protocol, and
 * turn-budget when they differ from defaults — running with just
 * `--seed N --tools T` wouldn't reproduce a fixture-driven failure.
 */
function reproduceCommand(report, failure) {
  const parts = ['adcp fuzz', quote(report.agentUrl), '--seed', String(failure.seed), '--tools', failure.tool];
  if (report.protocol && report.protocol !== 'mcp') parts.push('--protocol', report.protocol);
  if (report.turnBudget && report.turnBudget !== 50) parts.push('--turn-budget', String(report.turnBudget));
  // Prefer --auto-seed over listing seeded IDs when the run used autoSeed:
  // seeded IDs are agent-generated and may differ between runs, so echoing
  // them as --fixture would mislead the user. The user should re-seed.
  if (report.autoSeeded) {
    parts.push('--auto-seed');
  } else {
    for (const [name, values] of Object.entries(report.fixturesUsed ?? {})) {
      if (values && values.length > 0) parts.push('--fixture', `${name}=${values.join(',')}`);
    }
  }
  return parts.join(' ');
}

function quote(s) {
  return /[\s"'$`]/.test(s) ? JSON.stringify(s) : s;
}

function hasFixtureFor(tool, fixturesUsed) {
  // Rough heuristic: if the user supplied ANY fixture, assume they've
  // considered Tier-2 coverage. Fine-grained per-tool mapping isn't
  // worth the complexity at the CLI layer.
  return fixturesUsed && Object.values(fixturesUsed).some(v => Array.isArray(v) && v.length > 0);
}

function truncate(s, n) {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

module.exports = { handleFuzzCommand };
