#!/usr/bin/env bash
# Diagnose a single skill × storyboard pair from the matrix with extended
# timeout and full LLM transcript capture.
#
# When a pair times out in the matrix, you don't know if the LLM was
# 90% done writing server.ts or stuck in a confusion loop on the schema.
# This wrapper picks ONE pair, gives it 30 minutes, captures Claude's
# full stream-json transcript (every thinking event, every tool call,
# every partial message), and tees to the terminal so you can watch it
# live or read the transcript afterward.
#
# Usage:
#   ./scripts/manual-testing/diagnose-pair.sh <skill> <storyboard> [timeout_min]
#
# Example:
#   ./scripts/manual-testing/diagnose-pair.sh skills/build-seller-agent/SKILL.md sales_guaranteed 30
#
# Output:
#   .context/diagnose/<storyboard>-<timestamp>/
#     transcript.jsonl    — line-delimited stream-json events
#     workspace/          — Claude's scratch workspace (--keep)
#     run.log             — harness log

set -e

if [ "$#" -lt 2 ]; then
  echo "Usage: $0 <skill> <storyboard> [timeout_min]"
  echo "Example: $0 skills/build-seller-agent/SKILL.md sales_guaranteed 30"
  exit 2
fi

SKILL="$1"
STORYBOARD="$2"
TIMEOUT_MIN="${3:-30}"
TIMEOUT_MS=$((TIMEOUT_MIN * 60 * 1000))

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TS="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="$REPO_ROOT/.context/diagnose/${STORYBOARD}-${TS}"
mkdir -p "$OUT_DIR/workspace"

echo "[diagnose] skill:      $SKILL"
echo "[diagnose] storyboard: $STORYBOARD"
echo "[diagnose] timeout:    ${TIMEOUT_MIN}m (${TIMEOUT_MS}ms)"
echo "[diagnose] transcript: $OUT_DIR/transcript.jsonl"
echo "[diagnose] workspace:  $OUT_DIR/workspace"
echo

cd "$REPO_ROOT"

tsx scripts/manual-testing/agent-skill-storyboard.ts \
  --skill "$SKILL" \
  --storyboard "$STORYBOARD" \
  --timeout-ms "$TIMEOUT_MS" \
  --keep \
  --work-dir "$OUT_DIR/workspace" \
  --transcript "$OUT_DIR/transcript.jsonl" \
  2>&1 | tee "$OUT_DIR/run.log"

EXIT=$?
echo
echo "[diagnose] exit=$EXIT — see $OUT_DIR/"
exit $EXIT
