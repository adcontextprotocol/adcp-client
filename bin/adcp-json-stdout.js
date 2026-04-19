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
  console.log = (...args) => console.error(...args);
  console.info = (...args) => console.error(...args);
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
