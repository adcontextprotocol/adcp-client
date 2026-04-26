#!/usr/bin/env node

const { gradeRequestSigning } = require('../dist/lib/testing/storyboard/request-signing/index.js');
const { gradeSigner } = require('../dist/lib/testing/storyboard/signer-grader/index.js');

const USAGE_REQUEST_SIGNING = `Usage: adcp grade request-signing <agent-url> [options]

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
  --transport <mode>         \`raw\` (default) posts to per-operation AdCP
                             endpoints; \`mcp\` wraps each vector body in a
                             JSON-RPC tools/call envelope and posts to the
                             agent's MCP mount (see #612).
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

const USAGE_SIGNER = `Usage: adcp grade signer <agent-url> [options]

Grades an AdCP signer end-to-end: produces a sample signed request through
your signer, then verifies it against your agent's published JWKS via the
SDK's RFC 9421 verifier. Surfaces algorithm-mismatch / kid-mismatch /
DER-vs-P1363 / wrong-key failures as specific verifier error codes — the
same codes a real counterparty would reject with — rather than the generic
\`request_signature_invalid\` you'd see in the seller's monitoring after
pushing live traffic.

Pick exactly ONE signer source:
  --key-file <path>          Local JWK file (must include \`d\`). For local
                             dev / non-KMS testing.
  --signer-url <url>         HTTP signing oracle for KMS-backed signers.
                             POSTs JSON {payload_b64, kid, alg}; expects
                             {signature_b64} back. Lets you grade without
                             handing the grader your private key.

Required:
  --kid <id>                 Key identifier the signer asserts in
                             \`Signature-Input\`. Must match a JWK at the
                             agent's \`jwks_uri\`.
  --alg <alg>                Algorithm — \`ed25519\` or \`ecdsa-p256-sha256\`.
                             Must match \`ALLOWED_ALGS\` and the JWK \`alg\`.
  --jwks-url <url>           JWKS endpoint to verify against.

Options:
  --operation <name>         AdCP operation in the sample request body.
                             Default: \`create_media_buy\`.
  --covers-content-digest    Content-digest policy your verifier advertises
    <required|forbidden|either>
                             (\`request_signing.covers_content_digest\`).
                             Default: \`required\` — recommended posture for
                             spend-committing operations. A signer that
                             skips \`Content-Digest\` against \`required\`
                             surfaces here as step 6
                             \`request_signature_components_incomplete\`.
  --signer-auth <header>     Authorization header attached to --signer-url
                             POSTs (e.g. \`Bearer <secret>\`).
  --allow-http               Allow http:// signer / JWKS URLs + private-IP
                             targets (dev only).
  --timeout <ms>             Per-probe timeout (default 10000).
  --json                     Emit the report as JSON.
  -h, --help                 Show this help.

Exit code:
  0   signer produces valid AdCP signatures (verifier accepted)
  1   verifier rejected — see error_code / step in the report
  2   argument / configuration error

Examples:
  # Grade a KMS-backed signer via a signing oracle
  adcp grade signer https://addie.example.com \\
    --signer-url https://signer.internal/sign \\
    --signer-auth "Bearer \${SIGNER_TOKEN}" \\
    --kid addie-2026-04 \\
    --alg ed25519 \\
    --jwks-url https://addie.example.com/.well-known/jwks.json

  # Grade an in-process signer with a local JWK
  adcp grade signer https://agent.example.com \\
    --key-file ./signing-key.jwk \\
    --kid my-agent-2026 \\
    --alg ed25519 \\
    --jwks-url https://agent.example.com/.well-known/jwks.json
`;

async function handleGradeCommand(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(USAGE_REQUEST_SIGNING);
    process.stdout.write('\n');
    process.stdout.write(USAGE_SIGNER);
    return;
  }
  const subject = argv[0];
  if (subject === 'request-signing') {
    return await runRequestSigningGrader(argv.slice(1));
  }
  if (subject === 'signer') {
    return await runSignerGrader(argv.slice(1));
  }
  console.error(`Unknown grade subject: ${subject}\n`);
  process.stderr.write(USAGE_REQUEST_SIGNING);
  process.stderr.write('\n');
  process.stderr.write(USAGE_SIGNER);
  process.exit(2);
}

async function runRequestSigningGrader(args) {
  if (args.length === 0 || args[0].startsWith('-')) {
    console.error('ERROR: agent URL is required\n');
    process.stderr.write(USAGE_REQUEST_SIGNING);
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
      case '--transport': {
        const mode = args[++i];
        if (mode !== 'raw' && mode !== 'mcp') {
          console.error(`ERROR: --transport must be \"raw\" or \"mcp\", got \"${mode}\"\n`);
          process.exit(2);
        }
        options.transport = mode;
        break;
      }
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
        process.stdout.write(USAGE_REQUEST_SIGNING);
        return;
      default:
        console.error(`Unknown flag: ${a}\n`);
        process.stderr.write(USAGE_REQUEST_SIGNING);
        process.exit(2);
    }
  }

  try {
    const report = await gradeRequestSigning(agentUrl, options);
    if (emitJson) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else {
      printHumanReport(report, options);
    }
    process.exit(report.passed ? 0 : 1);
  } catch (err) {
    console.error(`grade-request-signing failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}

async function runSignerGrader(args) {
  if (args.length === 0) {
    console.error('ERROR: agent URL is required\n');
    process.stderr.write(USAGE_SIGNER);
    process.exit(2);
  }
  if (args[0] === '-h' || args[0] === '--help') {
    process.stdout.write(USAGE_SIGNER);
    return;
  }
  if (args[0].startsWith('-')) {
    console.error('ERROR: agent URL is required (must come before flags)\n');
    process.stderr.write(USAGE_SIGNER);
    process.exit(2);
  }
  const agentUrl = args[0];
  const options = { agentUrl };
  let emitJson = false;

  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case '--key-file':
        options.keyFilePath = args[++i];
        break;
      case '--signer-url':
        options.signerUrl = args[++i];
        break;
      case '--signer-auth':
        options.signerAuth = args[++i];
        break;
      case '--kid':
        options.kid = args[++i];
        break;
      case '--alg': {
        const alg = args[++i];
        if (alg !== 'ed25519' && alg !== 'ecdsa-p256-sha256') {
          console.error(`ERROR: --alg must be \"ed25519\" or \"ecdsa-p256-sha256\", got \"${alg}\"\n`);
          process.exit(2);
        }
        options.algorithm = alg;
        break;
      }
      case '--jwks-url':
        options.jwksUrl = args[++i];
        break;
      case '--operation':
        options.operation = args[++i];
        break;
      case '--covers-content-digest': {
        const policy = args[++i];
        if (policy !== 'required' && policy !== 'forbidden' && policy !== 'either') {
          console.error(
            `ERROR: --covers-content-digest must be \"required\", \"forbidden\", or \"either\", got \"${policy}\"\n`
          );
          process.exit(2);
        }
        options.coversContentDigest = policy;
        break;
      }
      case '--allow-http':
        options.allowPrivateIp = true;
        break;
      case '--timeout':
        options.timeoutMs = Number.parseInt(args[++i], 10);
        if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1) {
          console.error('ERROR: --timeout requires a positive integer (ms)\n');
          process.exit(2);
        }
        break;
      case '--json':
        emitJson = true;
        break;
      case '-h':
      case '--help':
        process.stdout.write(USAGE_SIGNER);
        return;
      default:
        console.error(`Unknown flag: ${a}\n`);
        process.stderr.write(USAGE_SIGNER);
        process.exit(2);
    }
  }

  if (!options.kid) errExit('--kid is required', USAGE_SIGNER);
  if (!options.algorithm) errExit('--alg is required', USAGE_SIGNER);
  if (!options.jwksUrl) errExit('--jwks-url is required', USAGE_SIGNER);
  if (!options.keyFilePath && !options.signerUrl) {
    errExit('Pass exactly one of --key-file or --signer-url', USAGE_SIGNER);
  }
  if (options.keyFilePath && options.signerUrl) {
    errExit('Pass exactly one of --key-file or --signer-url, not both', USAGE_SIGNER);
  }
  // Surface the in-process key-file path on stderr so CI logs make the
  // dev-tool nature of the run visible — operators reviewing the log can
  // confirm the file isn't checked in / shipped to prod.
  if (options.keyFilePath) {
    process.stderr.write(
      `[adcp grade signer] in-process key loaded from ${options.keyFilePath} — ` +
        `ensure this file is not checked in or shipped to production.\n`
    );
  }

  try {
    const report = await gradeSigner(options);
    if (emitJson) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else {
      printSignerReport(report);
    }
    process.exit(report.passed ? 0 : 1);
  } catch (err) {
    console.error(`grade-signer failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}

function errExit(message, usage) {
  console.error(`ERROR: ${message}\n`);
  process.stderr.write(usage);
  process.exit(2);
}

function printSignerReport(report) {
  console.log();
  console.log(`Agent:     ${report.agent_url}`);
  console.log(`JWKS:      ${report.jwks_uri}`);
  console.log(`kid:       ${report.kid}`);
  console.log(`algorithm: ${report.algorithm}`);
  console.log(`duration:  ${report.duration_ms}ms`);
  console.log();
  const status = report.step.status === 'pass' ? 'PASS' : 'FAIL';
  console.log(`Result: ${status}`);
  if (report.step.error_code) {
    console.log(`  error_code: ${report.step.error_code}`);
  }
  if (report.step.diagnostic) {
    console.log(`  diagnostic: ${report.step.diagnostic}`);
  }
  if (!report.passed) {
    console.log();
    console.log('Sample request the signer produced headers for:');
    console.log(`  ${report.sample.method} ${report.sample.url}`);
    const sigInput = headerCaseInsensitive(report.sample.headers, 'signature-input');
    if (sigInput) {
      console.log(`  Signature-Input: ${sigInput}`);
    }
    const signature = headerCaseInsensitive(report.sample.headers, 'signature');
    if (signature) {
      console.log(`  Signature: ${signature.length > 100 ? signature.slice(0, 80) + '...' : signature}`);
    }
  }
  console.log();
}

function headerCaseInsensitive(headers, name) {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
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

function printHumanReport(report, options = {}) {
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
  // Only hint when the operator didn't already ask for MCP — if they did and
  // everything still fails, it's a different problem (agent down, wrong URL).
  if (!report.passed && (!options || options.transport !== 'mcp')) {
    const hint = detectTransportMismatch(report);
    if (hint) {
      console.log();
      console.log(`💡 ${hint}`);
    }
  }
  console.log();
}

/**
 * Heuristic: if the grader ran in `raw` mode and every non-skipped vector
 * failed with a 404 / 405 / fetch-failed shape, the agent likely speaks MCP.
 * Raw mode POSTs to per-operation paths (`/mcp/adcp/create_media_buy`), which
 * an MCP agent — single endpoint at `/mcp` — will 404. Suggest the retry so
 * operators don't have to read the PR thread to learn about `--transport mcp`.
 */
function detectTransportMismatch(report) {
  if (report.passed_count > 0) return undefined; // something worked — not a transport mismatch
  const graded = [...report.positive, ...report.negative].filter(v => !v.skipped);
  if (graded.length < 5) return undefined; // not enough signal
  const mcpShaped = graded.filter(v => {
    if (v.http_status === 404 || v.http_status === 405) return true;
    const diag = String(v.diagnostic ?? '');
    return /fetch failed|ECONNREFUSED|Not found/i.test(diag);
  });
  if (mcpShaped.length / graded.length < 0.8) return undefined;
  return `Every graded vector failed with a 404/405 or fetch error — the agent likely speaks MCP (single /mcp endpoint). Retry with --transport mcp.`;
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
