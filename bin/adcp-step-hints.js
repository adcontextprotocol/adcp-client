/**
 * Runner-hint rendering helpers for the CLI (adcp-client#879).
 *
 * Extracted from bin/adcp.js so the single-purpose formatting logic is
 * unit-testable without spawning the CLI. Consumers: the human console
 * printer (`printStepHints`) and the JUnit XML failure-body composer
 * (`formatHintsForFailureBody`).
 *
 * The runner populates `StoryboardStepResult.hints[]` when it can trace a
 * seller rejection back to a prior-step `$context.*` write. Rendering
 * them in CI output collapses the "SDK bug vs seller bug" triage to a
 * single line. See adcp-client#870 for the detection logic.
 */

/**
 * Print each hint on its own line, prefixed with the hint icon and
 * indented to align with the step's `Error:` line. No-op when `hints`
 * is absent or empty.
 */
function printStepHints(hints) {
  if (!Array.isArray(hints) || hints.length === 0) return;
  for (const h of hints) {
    console.log(`   💡 Hint: ${h.message}`);
  }
}

/**
 * Format hints as plain-text lines suitable for appending to a JUnit
 * `<failure>` body. Mirrors `printStepHints` but returns an array of
 * strings so the caller can concatenate them with other failure detail
 * lines.
 */
function formatHintsForFailureBody(hints) {
  if (!Array.isArray(hints) || hints.length === 0) return [];
  return hints.map(h => `Hint (${h.kind}): ${h.message}`);
}

module.exports = { printStepHints, formatHintsForFailureBody };
