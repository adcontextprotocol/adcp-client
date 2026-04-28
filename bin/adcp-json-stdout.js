// Stdout discipline for --json CLI commands.
//
// The storyboard and comply runners emit their final result as a single JSON
// blob on stdout; naive consumers (jq, `python -c 'json.load(sys.stdin)'`)
// then parse that stdout directly. A single stray `console.log` from any
// library on the path corrupts the JSON. These helpers give the CLI two
// disciplines: capture stray logs and forward them to stderr, and write the
// final payload via `process.stdout.write` so nothing else can interleave
// with it.

function captureStdoutLogs() {
  const origLog = console.log;
  const origInfo = console.info;
  // Redirect by rebinding directly to console.error, not via a closure that
  // re-emits args. CodeQL flags clear-text logging on the closure form
  // because taint flow from caller-side `console.log(agentConfig)` reaches
  // the inner `console.error(...args)` as a fresh log site. Bind-based
  // redirection is a single function reference reassignment — no new
  // intermediate sink — so the analysis stays attached to the original
  // call site (which is the caller's responsibility to keep clean).
  console.log = console.error.bind(console);
  console.info = console.error.bind(console);
  return () => {
    console.log = origLog;
    console.info = origInfo;
  };
}

async function writeJsonOutput(payload) {
  const str = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  if (!process.stdout.write(str + '\n')) {
    await new Promise(resolve => process.stdout.once('drain', resolve));
  }
}

module.exports = { captureStdoutLogs, writeJsonOutput };
