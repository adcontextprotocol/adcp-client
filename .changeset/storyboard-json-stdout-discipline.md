---
'@adcp/client': patch
---

`adcp storyboard run --json` now guarantees clean JSON on stdout.

The CLI installs a stdout guard around `comply()` / `runStoryboard()` / `runStoryboardStep()` that forwards any stray `console.log` / `console.info` to stderr, and writes the final JSON payload via `process.stdout.write` and waits for drain before exiting. This closes the class of failure reported in adcp-client#588, where a single internal log line turns valid JSON into a parse error for `jq` and `python -c 'json.load(sys.stdin)'`. `--json` stdout is now a single JSON document; everything else goes to stderr.
