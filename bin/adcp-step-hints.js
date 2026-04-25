/**
 * Human-console renderer for `StoryboardStepResult.hints[]` (adcp-client#879).
 *
 * Extracted from bin/adcp.js so the formatting logic is unit-testable
 * without spawning the CLI. The JUnit equivalent lives in
 * `src/lib/testing/storyboard/junit.ts` — it emits structured XML rather
 * than console lines, so the two surfaces don't share a helper.
 *
 * The runner populates `hints[]` when it can trace a seller rejection
 * back to a prior-step `$context.*` write (adcp-client#870). Surfacing
 * them on the CLI collapses "SDK bug vs seller bug" triage to one line.
 */

const HINT_LABEL = '💡 Hint: ';
// `💡` renders as a single visible glyph but is a surrogate pair (2 UTF-16
// code units). For continuation-line alignment we want N visible columns of
// padding to match the prefix's visible width. Hardcoded rather than
// computed via grapheme APIs because it's stable.
const HINT_LABEL_VISIBLE_WIDTH = 9; // "💡 Hint: " = 1 emoji + 8 ASCII chars
const FALLBACK_WIDTH = 100;
const MIN_BODY_WIDTH = 40;

/**
 * Resolve the wrap target. Prefer the live TTY width; fall back to the
 * `COLUMNS` env var (commonly set by `tput`-aware shells); otherwise 100
 * (a comfortable read width that doesn't waste space on wide terminals).
 */
function resolveWidth() {
  if (process.stdout.isTTY && typeof process.stdout.columns === 'number' && process.stdout.columns > 0) {
    return process.stdout.columns;
  }
  const env = Number.parseInt(process.env.COLUMNS ?? '', 10);
  if (Number.isFinite(env) && env > 0) return env;
  return FALLBACK_WIDTH;
}

/**
 * Word-wrap `text` at `bodyWidth` characters. Preserves whitespace runs
 * and tries to keep `\`code\`` segments on a single line when they fit.
 * Always honors `bodyWidth` even inside a fenced run — splitting a fence
 * is unfortunate but bounded; silent overflow is worse.
 *
 * Edge cases the algorithm handles explicitly:
 *  - Stray unmatched backtick → up-front parity check disables fence-
 *    aware glue entirely so the message can't fall into "openTick forever"
 *    and produce one runaway line (adcp-client review on #925).
 *  - Single token longer than `bodyWidth` (e.g. a 200-char URL) →
 *    hard-break the token into bodyWidth-sized chunks so the wrap
 *    invariant survives degenerate inputs.
 *
 * Returns an array of lines (no leading whitespace; caller adds indent).
 */
function wrap(text, bodyWidth) {
  if (bodyWidth <= 0) return [text];

  // Up-front fence-parity check. If the message has unbalanced backticks,
  // ignore them entirely for wrapping purposes — otherwise a stray ` puts
  // the algorithm into permanent glue mode and the line blows past width.
  const respectFences = (text.match(/`/g) ?? []).length % 2 === 0;

  const words = text.split(/(\s+)/).filter(s => s.length > 0);
  const lines = [];
  let line = '';
  let openTickInLine = false;
  const flipTickIf = tok => {
    if (!respectFences) return;
    if ((tok.match(/`/g) ?? []).length % 2 === 1) openTickInLine = !openTickInLine;
  };
  const flushLine = () => {
    if (line.length > 0) lines.push(line.trimEnd());
    line = '';
  };

  for (const tok of words) {
    const isWS = /^\s+$/.test(tok);
    if (isWS) {
      // Whitespace either rides the current line or — if it'd push past
      // the body width AND we're not mid-fence — forces a wrap.
      if (!openTickInLine && line.length + tok.length > bodyWidth) {
        flushLine();
        continue;
      }
      line += tok;
      continue;
    }
    // Hard-break oversized single tokens. A 200-char URL with no internal
    // whitespace would otherwise sit on one line and overflow regardless
    // of all other heuristics. Chop it at body-width boundaries.
    if (tok.length > bodyWidth) {
      flushLine();
      let rest = tok;
      while (rest.length > bodyWidth) {
        lines.push(rest.slice(0, bodyWidth));
        rest = rest.slice(bodyWidth);
      }
      line = rest;
      flipTickIf(tok);
      continue;
    }
    if (line.length === 0) {
      line = tok;
      flipTickIf(tok);
      continue;
    }
    if (openTickInLine && line.length + tok.length <= bodyWidth) {
      // Inside a fence and the token fits — glue.
      line += tok;
      flipTickIf(tok);
      continue;
    }
    // Either mid-fence-but-overflowing, or normal-mode-but-overflowing —
    // either way wrap. Splitting a fence is acceptable; silent overflow is
    // not (the operator's eye depends on the wrap invariant).
    if (line.length + tok.length > bodyWidth) {
      flushLine();
      line = tok;
      flipTickIf(tok);
      continue;
    }
    line += tok;
    flipTickIf(tok);
  }
  flushLine();
  return lines;
}

/**
 * Build the per-kind structured detail line(s) appended after the prose
 * `message` so renderers / operators / LLMs see the machine-readable
 * fields without having to regex-parse the message text. Each detail
 * is a single short line (`├─ <label>: <value>`) suitable for the
 * console; dropping into JSON-line / JUnit consumers stays trivial
 * because the same fields exist on the structured hint object.
 *
 * The function returns an array (zero or more lines). An unknown
 * `kind` returns `[]` so the renderer falls back to the prose-only
 * surface — issue #935's forward-contract for new hint kinds.
 */
function structuredDetailLines(hint) {
  if (!hint || typeof hint !== 'object') return [];
  switch (hint.kind) {
    case 'context_value_rejected':
      return [
        `key: $context.${hint.context_key}`,
        `from step: ${hint.source_step_id}${hint.source_task ? ` (${hint.source_task})` : ''}`,
        ...(Array.isArray(hint.accepted_values) && hint.accepted_values.length > 0
          ? [`seller accepted: ${formatList(hint.accepted_values)}`]
          : []),
      ];
    case 'shape_drift':
      return [
        `tool: ${hint.tool}`,
        `observed: ${hint.observed_variant}`,
        `expected: ${hint.expected_variant}`,
        ...(hint.instance_path ? [`at: ${hint.instance_path}`] : []),
      ];
    case 'missing_required_field':
      return [
        `tool: ${hint.tool}`,
        `at: ${hint.instance_path || '/'}`,
        `missing: ${formatList(hint.missing_fields ?? [])}`,
      ];
    case 'format_mismatch':
      return [`tool: ${hint.tool}`, `at: ${hint.instance_path || '/'}`, `keyword: ${hint.keyword}`];
    case 'monotonic_violation':
      return [
        `${hint.resource_type} ${hint.resource_id}: ${hint.from_status} → ${hint.to_status}`,
        `from step: ${hint.from_step_id}`,
        `legal next states: ${
          Array.isArray(hint.legal_next_states) && hint.legal_next_states.length > 0
            ? formatList(hint.legal_next_states)
            : '(none — terminal state)'
        }`,
      ];
    default:
      return [];
  }
}

function formatList(values) {
  return values.map(v => (typeof v === 'string' ? v : JSON.stringify(v))).join(', ');
}

/**
 * Print each hint on its own block, prefixed with the hint icon. `indent`
 * should match the caller's `Error:` indent so hints group visually —
 * 3 spaces for the full storyboard printer (which nests steps under
 * phases), empty for the single-step printer (`adcp storyboard step`)
 * that prints error/validation lines at column zero.
 *
 * Long messages are word-wrapped to the terminal width (or 100 cols when
 * stdout isn't a TTY) with continuation lines aligned under the message
 * text, so a wrapped hint reads as a paragraph rather than a runaway line.
 * After the prose, structured detail lines for the hint's `kind` (issue
 * #935) print one-per-line so the operator sees both surfaces:
 *
 *   💡 Hint: list_creatives returned a bare array at the top level...
 *            tool: list_creatives
 *            observed: bare_array
 *            expected: { creatives: [...] }
 */
function printStepHints(hints, indent = '   ') {
  if (!Array.isArray(hints) || hints.length === 0) return;
  const width = resolveWidth();
  // Body width = total - indent - "💡 Hint: " prefix; clamp so we never
  // produce a body of 1–2 chars on a freakishly narrow terminal.
  const bodyWidth = Math.max(MIN_BODY_WIDTH, width - indent.length - HINT_LABEL_VISIBLE_WIDTH);
  const continuationIndent = indent + ' '.repeat(HINT_LABEL_VISIBLE_WIDTH);
  for (const h of hints) {
    const message = typeof h?.message === 'string' ? h.message : '';
    const lines = wrap(message, bodyWidth);
    if (lines.length === 0 && structuredDetailLines(h).length === 0) continue;
    if (lines.length > 0) {
      console.log(`${indent}${HINT_LABEL}${lines[0]}`);
      for (let i = 1; i < lines.length; i++) {
        console.log(`${continuationIndent}${lines[i]}`);
      }
    }
    for (const detail of structuredDetailLines(h)) {
      // Wrap structured detail too — long accepted-values lists or schema
      // fragments would otherwise blow past the terminal width.
      const detailLines = wrap(detail, bodyWidth);
      for (const dl of detailLines) {
        console.log(`${continuationIndent}${dl}`);
      }
    }
  }
}

/**
 * Count the total hints across every phase × step in a `StoryboardResult`.
 * Used by the run-summary line so operators see at a glance whether the
 * runner emitted any diagnostics, without scrolling the per-step output.
 */
function countHintsInResult(result) {
  if (!result || !Array.isArray(result.phases)) return 0;
  let n = 0;
  for (const phase of result.phases) {
    for (const step of phase.steps ?? []) {
      n += Array.isArray(step.hints) ? step.hints.length : 0;
    }
  }
  return n;
}

module.exports = { printStepHints, countHintsInResult };
