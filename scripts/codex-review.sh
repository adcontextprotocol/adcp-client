#!/usr/bin/env bash
# codex-review.sh — fire a persona-scoped codex review on the working tree.
#
# Usage:
#   scripts/codex-review.sh --persona <name> [--base <branch>]
#   scripts/codex-review.sh --all [--base <branch>]
#
# PR-specific context is supplied via stdin OR auto-built from
# `git diff --stat $BASE...HEAD` when `--base` is given.
#
# When `--base` is a local branch name (e.g. `main`), the script resolves
# it to `refs/remotes/origin/<branch>` after a fetch — comparing against
# the locally-checked-out branch is a footgun (stale local `main` produces
# fabricated diffs that include already-merged PRs). Pass `--base
# origin/main` explicitly to skip resolution; pass `--no-fetch` to skip
# the fetch entirely.
#
# Personas (each maps to a prompt file in scripts/codex-review-prompts/):
#   dx        — adopter ergonomics, JSDoc copy-paste-ability, error actionability
#   protocol  — atomicity, ordering, parity with sibling backends
#   code      — code quality, contract conformance, race conditions
#   security  — multi-tenant safety, fail-closed posture, error leakage
#   all       — runs `protocol`, `code`, `security` in parallel
#               (skips `dx` — the Claude DX-expert agent has codebase-specific
#               rubric knowledge that's hard to replicate here; if you want
#               codex's DX read as a second opinion, run `--persona dx`)
#
# The script reads PR-specific context from stdin and appends it to the
# persona scaffold before invoking `codex exec`. Output goes to
# /tmp/codex-review-<persona>.txt and is tail-printed on completion.
#
# When the codex backend is overloaded or unavailable, this script returns
# non-zero — the calling agent / human should fall back to Claude expert
# agents. The dual-stack design is documented at
# docs/development/REVIEW-STACKS.md.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROMPTS_DIR="$REPO_ROOT/scripts/codex-review-prompts"
OUT_DIR="${TMPDIR:-/tmp}"

PERSONA=""
RUN_ALL=0
BASE_BRANCH=""
NO_FETCH=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --persona)
      if [[ $# -lt 2 ]]; then echo "Missing value for --persona" >&2; exit 2; fi
      PERSONA="$2"
      shift 2
      ;;
    --all)
      RUN_ALL=1
      shift
      ;;
    --base)
      if [[ $# -lt 2 ]]; then echo "Missing value for --base" >&2; exit 2; fi
      BASE_BRANCH="$2"
      shift 2
      ;;
    --no-fetch)
      NO_FETCH=1
      shift
      ;;
    --help|-h)
      sed -n '2,36p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

# Resolve --base to the remote-tracking ref so the diff reflects shipped
# state, not whatever the user happens to have locally checked out. The
# only escape hatch is passing an already-qualified ref (e.g. `origin/main`
# or a SHA) — those bypass resolution and are used verbatim.
resolve_base_branch() {
  local raw="$1"
  if [[ -z "$raw" ]]; then
    echo ""
    return 0
  fi
  # If it's not a local branch (SHA, tag, or already-qualified ref like
  # `origin/main`), use it verbatim.
  if ! git show-ref --verify -q "refs/heads/$raw"; then
    echo "$raw"
    return 0
  fi
  # Plain local-branch name — fetch and resolve to origin/<branch>.
  if [[ "$NO_FETCH" -eq 0 ]]; then
    git fetch --quiet origin "$raw" 2>/dev/null || {
      echo "codex-review: warning: 'git fetch origin $raw' failed; using local '$raw'." >&2
      echo "$raw"
      return 0
    }
  fi
  local remote_ref="origin/$raw"
  if git rev-parse --verify -q "$remote_ref^{commit}" >/dev/null; then
    echo "$remote_ref"
  else
    echo "codex-review: warning: '$remote_ref' not found after fetch; falling back to local '$raw'." >&2
    echo "$raw"
  fi
}

if [[ -n "$BASE_BRANCH" ]]; then
  RESOLVED_BASE="$(resolve_base_branch "$BASE_BRANCH")"
  if [[ "$RESOLVED_BASE" != "$BASE_BRANCH" ]]; then
    echo "codex-review: --base $BASE_BRANCH → $RESOLVED_BASE" >&2
  fi
  BASE_BRANCH="$RESOLVED_BASE"
fi

if [[ "$RUN_ALL" -eq 0 && -z "$PERSONA" ]]; then
  echo "Usage: scripts/codex-review.sh --persona <dx|protocol|code|security> [--base <branch>]" >&2
  echo "       scripts/codex-review.sh --all [--base <branch>]" >&2
  exit 2
fi

if ! command -v codex >/dev/null 2>&1; then
  echo "codex CLI not found. Install via https://github.com/openai/codex or check \$PATH." >&2
  exit 3
fi

validate_persona() {
  local persona="$1"
  local prompt_file="$PROMPTS_DIR/$persona.md"
  if [[ ! -f "$prompt_file" ]]; then
    echo "Unknown persona: $persona (no prompt at $prompt_file)" >&2
    return 2
  fi
}

# Validate up-front so a typo doesn't background the other personas first.
if [[ "$RUN_ALL" -eq 1 ]]; then
  for persona in protocol code security; do
    validate_persona "$persona"
  done
else
  validate_persona "$PERSONA"
fi

# Gather PR context. Either piped via stdin, or auto-built from git diff
# against the base branch if --base is provided. Auto-built context names
# changed files so codex knows where to look without manual setup.
CONTEXT_FILE="$(mktemp "${TMPDIR:-/tmp}/codex-review-context.XXXXXX")"
trap 'rm -f "$CONTEXT_FILE"' EXIT

if [[ ! -t 0 ]]; then
  cat > "$CONTEXT_FILE"
elif [[ -n "$BASE_BRANCH" ]]; then
  {
    echo "## Changes on this branch vs \`$BASE_BRANCH\`"
    echo
    echo "### Files changed"
    git diff --name-only "$BASE_BRANCH"...HEAD | sed 's/^/- /'
    echo
    echo "### Summary stat"
    git diff --stat "$BASE_BRANCH"...HEAD | tail -20
    echo
    echo "### Commit log"
    git log --oneline "$BASE_BRANCH"..HEAD
  } > "$CONTEXT_FILE"
else
  echo "No stdin and no --base — supply one." >&2
  exit 2
fi

# Launch one persona in background; PID captured at the call site.
# Stdin to codex is the persona prompt + a separator + the PR context.
launch_persona() {
  local persona="$1"
  local prompt_file="$PROMPTS_DIR/$persona.md"
  local out_file="$OUT_DIR/codex-review-$persona.txt"
  echo "[$persona] codex exec → $out_file" >&2
  {
    cat "$prompt_file"
    printf '\n---\n\n'
    cat "$CONTEXT_FILE"
  } | codex exec -s read-only -C "$REPO_ROOT" - > "$out_file" 2>&1
}

if [[ "$RUN_ALL" -eq 1 ]]; then
  declare -a pids=()
  for persona in protocol code security; do
    launch_persona "$persona" &
    pids+=("$!")
  done
  status=0
  for p in "${pids[@]}"; do
    if ! wait "$p"; then
      status=1
    fi
  done
  echo
  echo "==================== Summaries ===================="
  for persona in protocol code security; do
    out="$OUT_DIR/codex-review-$persona.txt"
    echo
    echo "--- $persona ($out) ---"
    awk '/^codex$/{flag=1} flag' "$out" | tail -60
  done
  exit $status
fi

launch_persona "$PERSONA" &
pid="$!"
# Capturing wait's exit needs the `|| status=$?` short-circuit.
# `wait` inside `if ! …` clobbers $? to 0 (negated-test status), and bare
# `wait` under `set -e` exits before any `status=$?` can run. The `||`
# form runs only on failure, captures the real exit, and bypasses `set -e`.
status=0
wait "$pid" || status=$?
if [[ $status -ne 0 ]]; then
  echo "[$PERSONA] codex exec failed (exit $status). See $OUT_DIR/codex-review-$PERSONA.txt." >&2
  exit "$status"
fi
out="$OUT_DIR/codex-review-$PERSONA.txt"
awk '/^codex$/{flag=1} flag' "$out"
