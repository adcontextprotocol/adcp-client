#!/bin/bash
# DX test: Can Claude build a seller agent with session-backed compliance testing
# from SKILL.md alone? Exercises registerTestController factory + enforceMapCap.
set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK_DIR=$(mktemp -d)
SKILL_FILE="$REPO_ROOT/skills/build-seller-agent/SKILL.md"

echo "=== Compliance-Path DX Test ==="
echo "Work dir: $WORK_DIR"
echo "Skill: $SKILL_FILE"

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

cp "$SKILL_FILE" ./SKILL.md

BUILD_PROMPT="You are building an AdCP seller agent. Read SKILL.md in the current directory and build a complete working seller agent in a single file called agent.ts.

Requirements:
- SSP with non-guaranteed display + video, auction pricing
- Implement ALL tools listed in the skill
- Use createAdcpServer and ctx.store for domain state
- **You MUST add compliance testing via registerTestController.** Do not skip the Compliance Testing section.
- **You MUST use the session-backed factory shape** { scenarios, createStore } — pretend session state is persisted to Postgres, so createStore loads it per request. You can fake the loadSession/saveSession implementations with in-memory maps for this exercise.
- **You MUST use enforceMapCap** on every session-scoped Map.set that accumulates state across requests.

After writing, compile with: npx tsc --noEmit

Fix any compilation errors. The agent must compile cleanly.

Do NOT read any files besides SKILL.md before writing code."

DEBRIEF_PROMPT="You just built an AdCP seller agent with session-backed compliance testing from SKILL.md alone. Give a short debrief (under 250 words):

1. Did the { scenarios, createStore } factory shape feel natural, or did you try the old bare-function shape first?
2. Was the relationship between CONTROLLER_SCENARIOS, scenarios:[], and the createStore method clear?
3. Did you understand when/why to use enforceMapCap without re-reading the skill?
4. What was confusing in the Compliance Testing section? Cite specific line numbers if possible.
5. Any imports you had to guess (path, symbol, type)?
6. If you could change ONE thing about the SKILL's compliance-testing guidance, what would it be?"

START_TIME=$(date +%s)

echo "--- Build phase ---"
claude --verbose --dangerously-skip-permissions -p "$BUILD_PROMPT" 2>&1 | tee "$WORK_DIR/build.log"

BUILD_TIME=$(date +%s)
echo ""
echo "--- Build completed in $((BUILD_TIME - START_TIME))s ---"

echo ""
echo "--- Debrief ---"
claude --print --dangerously-skip-permissions -p "$DEBRIEF_PROMPT" 2>&1 | tee "$WORK_DIR/debrief.log"

echo ""
echo "=== Results ==="
if [ -f agent.ts ]; then
  LINES=$(wc -l < agent.ts)
  echo "Lines of code: $LINES"

  echo ""
  echo "Compilation check:"
  if npx tsc --project tsconfig.json --noEmit 2>&1; then
    echo "OK: Compiles"
  else
    echo "FAIL: Does not compile"
  fi

  echo ""
  echo "API usage check:"
  grep -c "registerTestController" agent.ts | xargs echo "  registerTestController calls:"
  grep -c "createStore" agent.ts | xargs echo "  createStore references:"
  grep -c "enforceMapCap" agent.ts | xargs echo "  enforceMapCap calls:"
  grep -c "CONTROLLER_SCENARIOS" agent.ts | xargs echo "  CONTROLLER_SCENARIOS references:"
  grep -c "TestControllerError" agent.ts | xargs echo "  TestControllerError uses:"
else
  echo "FAIL: No agent.ts produced"
fi

echo ""
echo "Work dir: $WORK_DIR"
