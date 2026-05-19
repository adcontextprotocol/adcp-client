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
    --help|-h)
      sed -n '2,28p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

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
  # Resolve BASE_BRANCH to origin/<branch> so the diff is never against a stale
  # local copy. A bare branch name like "main" is automatically normalized;
  # pass "origin/main" explicitly to skip the auto-fetch.
  if [[ "$BASE_BRANCH" != origin/* && "$BASE_BRANCH" != refs/remotes/* ]]; then
    echo "[codex-review] fetching origin/$BASE_BRANCH..." >&2
    if ! git fetch origin "$BASE_BRANCH"; then
      echo "[codex-review] warning: fetch failed — diff may include stale commits" >&2
    fi
    BASE_BRANCH="origin/$BASE_BRANCH"
  fi
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
  echo "No stdin and no --base — supply one (e.g. --base origin/main)." >&2
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
