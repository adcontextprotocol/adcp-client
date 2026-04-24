---
"@adcp/client": patch
---

Render StoryboardStepResult.hints[] in CLI output and JUnit XML

The storyboard runner already emits `context_value_rejected` hints when a
seller's error traces back to a prior-step `$context.*` write, but the hints
were silently dropped by all reporting surfaces. This patch wires them up:

- `adcp storyboard run` (single and multi-instance): prints `Hint: <message>`
  below the `Error:` line for each failing step with hints
- `adcp storyboard step`: same, for single-step interactive debugging
- JUnit XML (`--format junit`): appends hint messages to the `<failure>` body;
  when `step.error` is absent, uses the first hint as the `message=` attribute
  so CI systems that only read that attribute still surface the diagnostic

The `formatStoryboardResultsAsJUnit` formatter is extracted from `bin/adcp.js`
into `src/lib/testing/storyboard/junit.ts` (internal; not part of the public
`@adcp/client` API) so it can be unit-tested without bootstrapping the CLI.
Five snapshot tests are added in `test/lib/storyboard-junit-hints.test.js`.
