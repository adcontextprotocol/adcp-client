#!/bin/bash
# Test script: Can Claude/Codex build a working agent from a SKILL.md?
# Usage: ./test-agent-build.sh [claude|codex] [seller|signals]

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

    STORYBOARD="signal_marketplace"
    if [ "$AGENT_TYPE" = "seller" ]; then
      STORYBOARD="media_buy_seller"
    fi

    echo "Running storyboard: $STORYBOARD"
    STORYBOARD_BIN="$REPO_ROOT/bin/adcp.js"
    node "$STORYBOARD_BIN" storyboard run http://localhost:3001/mcp "$STORYBOARD" --json 2>/dev/null | grep -v '^\[AdCP\]' | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    total = data['passed_count'] + data['failed_count']
    print(f\"Storyboard: {data['passed_count']}/{total} steps pass\")
    for phase in data['phases']:
        for step in phase['steps']:
            status = 'PASS' if step['passed'] else 'FAIL'
            print(f'  {step[\"title\"]}: {status}')
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
