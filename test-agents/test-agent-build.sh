#!/bin/bash
# Test script: Can Claude/Codex build a working agent from a SKILL.md?
# Usage: ./test-agent-build.sh [claude|codex] [seller|signals|si|governance]

set -e

TOOL="${1:-claude}"
AGENT_TYPE="${2:-signals}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK_DIR=$(mktemp -d)
SKILL_FILE="$REPO_ROOT/skills/build-${AGENT_TYPE}-agent/SKILL.md"

echo "=== Agent Build Test ==="
echo "Tool: $TOOL"
echo "Agent: $AGENT_TYPE"
echo "Work dir: $WORK_DIR"
echo "Skill: $SKILL_FILE"
echo ""

# Set up project
cd "$WORK_DIR"
git init -q > /dev/null 2>&1
npm init -y > /dev/null 2>&1
npm install "$REPO_ROOT" > /dev/null 2>&1
npm install -D typescript @types/node > /dev/null 2>&1

cat > tsconfig.json << 'TSEOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "skipLibCheck": true,
    "outDir": "dist"
  }
}
TSEOF

# Copy skill
cp "$SKILL_FILE" ./SKILL.md

BUILD_PROMPT="You are building an AdCP agent. Read SKILL.md in the current directory and build a complete working ${AGENT_TYPE} agent in a single file called agent.ts.

For a signals agent: build a marketplace agent with 4 audience segments, CPM pricing, DSP activation.
For a seller agent: build an SSP with non-guaranteed display + video, auction pricing.
For a si agent: build a toy sponsored-intelligence agent with keyword-based recommendations.
For a governance agent: build a campaign governance agent that approves plans under a budget threshold and maintains a property list.

Implement ALL tools listed in the skill. Use createAdcpServer as instructed. Use ctx.store for state.

After writing, compile with: npx tsc --noEmit

Fix any compilation errors. The agent must compile cleanly.

Do NOT read any files besides SKILL.md before writing code."

DEBRIEF_PROMPT="You just built an AdCP ${AGENT_TYPE} agent from SKILL.md. Give a short debrief (under 200 words):

1. How many compile iterations did you need? What errors did you hit?
2. What was confusing or ambiguous in the skill file?
3. What would have saved you the most time?
4. Any examples that were wrong or misleading?"

START_TIME=$(date +%s)

if [ "$TOOL" = "claude" ]; then
  echo "--- Build phase ---"
  claude --verbose --dangerously-skip-permissions -p "$BUILD_PROMPT" 2>&1 | tee "$WORK_DIR/build.log"

  BUILD_TIME=$(date +%s)
  BUILD_DURATION=$((BUILD_TIME - START_TIME))
  echo ""
  echo "--- Build completed in ${BUILD_DURATION}s ---"
  echo ""

  echo "--- Debrief ---"
  claude --print --dangerously-skip-permissions -p "$DEBRIEF_PROMPT" 2>&1 | tee "$WORK_DIR/debrief.log"
elif [ "$TOOL" = "codex" ]; then
  echo "Running Codex..."
  codex exec --full-auto "$BUILD_PROMPT" 2>&1 | tee "$WORK_DIR/build.log"
else
  echo "Unknown tool: $TOOL"
  exit 1
fi

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo ""
echo "=== Results ==="
echo "Duration: ${DURATION}s"

if [ -f agent.ts ]; then
  LINES=$(wc -l < agent.ts)
  echo "Lines of code: $LINES"

  echo ""
  echo "Compilation check:"
  if npx tsc --project tsconfig.json --noEmit 2>&1; then
    echo "✅ Compiles"

    # Try running storyboard
    echo ""
    echo "Starting agent for storyboard test..."
    npx tsx agent.ts &
    AGENT_PID=$!
    sleep 4

    case "$AGENT_TYPE" in
      seller) STORYBOARD="media_buy_seller" ;;
      signals) STORYBOARD="signal_marketplace" ;;
      si) STORYBOARD="si_baseline" ;;
      governance) STORYBOARD="governance_spend_authority" ;;
      *) STORYBOARD="signal_marketplace" ;;
    esac

    echo "Running storyboard: $STORYBOARD"
    STORYBOARD_BIN="$REPO_ROOT/bin/adcp.js"
    node "$STORYBOARD_BIN" storyboard run http://localhost:3001/mcp "$STORYBOARD" --json 2>/dev/null | grep -v '^\[AdCP\]' | python3 -c "
import json, sys
try:
    # strict=False tolerates raw control characters (newlines, tabs) in
    # JSON string values — agent responses sometimes carry multi-line
    # text fields whose control chars didn't get escaped upstream. The
    # real fix is upstream serialization, but lenient parsing gives us
    # usable storyboard output until then.
    data = json.loads(sys.stdin.read(), strict=False)
    s = data.get('summary') or {}
    passed = s.get('tracks_passed', 0)
    failed = s.get('tracks_failed', 0)
    partial = s.get('tracks_partial', 0)
    skipped = s.get('tracks_skipped', 0)
    print(f\"Storyboard overall: {data.get('overall_status', 'unknown')} \"
          f\"(tracks: {passed} pass / {failed} fail / {partial} partial / {skipped} skip)\")
    for track in data.get('tracks', []):
        print(f\"  track {track.get('track')}: {track.get('status')}\")
    for fail in data.get('failures', []):
        sb = fail.get('storyboard_id', '?')
        step = fail.get('step_id', '?')
        title = fail.get('step_title', '')
        print(f\"    FAIL {sb}/{step}: {title}\")
except Exception as e:
    print(f'Could not parse storyboard output: {e}')
" 2>&1 || echo "Storyboard failed to run"

    kill $AGENT_PID 2>/dev/null
    wait $AGENT_PID 2>/dev/null
  else
    echo "❌ Does not compile"
  fi
else
  echo "❌ No agent.ts produced"
fi

echo ""
echo "Work dir preserved at: $WORK_DIR"
echo "=== Done ==="
